/** HTTP endpoints: sign-in, first-run setup, rules data, uploads, backups and the web app itself. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Viewer } from '../shared/knowledge';
import { APP_VERSION, type StatusResponse } from '../shared/protocol';
import type { Campaign, Entity, Player } from '../shared/types';
import { CAMPAIGN_ID, createCampaign, createPlayer } from './actions/core';
import type { Services } from './actions/registry';
import { normaliseCode } from './auth';

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return undefined;
}

export function createApp(services: Services) {
  const { state, auth, config, rules } = services;
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/api', express.json({ limit: '4mb' }));

  const uploadsDir = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  /** Resolves the signed-in viewer or answers 401. */
  function viewerOf(req: Request, res: Response): Viewer | undefined {
    const playerId = auth.resolve(bearer(req));
    const player = state.get<Player>(playerId);
    if (!playerId || !player || player.type !== 'player') {
      res.status(401).json({ error: 'Please sign in again.' });
      return undefined;
    }
    return { role: player.role, playerId };
  }

  function throttle(req: Request, res: Response): boolean {
    const address = req.ip ?? 'unknown';
    if (auth.allowAttempt(address)) return true;
    res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
    return false;
  }

  app.get('/api/status', (_req, res) => {
    const campaign = state.get<Campaign>(CAMPAIGN_ID);
    const body: StatusResponse = {
      needsSetup: !auth.hasGm(),
      campaignName: campaign?.name,
      version: APP_VERSION,
      rulesPacks: rules.packNames(),
    };
    res.json(body);
  });

  app.post('/api/setup', (req, res) => {
    if (auth.hasGm()) {
      res.status(409).json({ error: 'This server has already been set up.' });
      return;
    }
    if (!throttle(req, res)) return;
    const { setupCode, campaignName, gmName, password } = req.body ?? {};
    if (typeof setupCode !== 'string' || normaliseCode(setupCode) !== auth.setupCode) {
      auth.recordFailure(req.ip ?? 'unknown');
      res.status(403).json({ error: 'That setup code is not right. It is printed in the server console.' });
      return;
    }
    if (typeof password !== 'string' || password.length < 6) {
      res.status(400).json({ error: 'Choose a GM passphrase of at least 6 characters.' });
      return;
    }
    const name = typeof campaignName === 'string' && campaignName.trim() ? campaignName.trim().slice(0, 80) : 'Traveller Campaign';
    const gm = state.transact((tx) => {
      if (!tx.get(CAMPAIGN_ID)) createCampaign(tx, name);
      return createPlayer(tx, typeof gmName === 'string' && gmName.trim() ? gmName.trim().slice(0, 40) : 'Referee', 'gm');
    });
    auth.claimGm(gm.id, password);
    res.json({ token: auth.createSession(gm.id) });
  });

  app.post('/api/login/gm', (req, res) => {
    if (!throttle(req, res)) return;
    const gmId = auth.gmPlayerId;
    const { password } = req.body ?? {};
    if (!gmId || typeof password !== 'string' || !auth.checkGmPassword(password)) {
      auth.recordFailure(req.ip ?? 'unknown');
      res.status(403).json({ error: 'That passphrase is not right.' });
      return;
    }
    res.json({ token: auth.createSession(gmId) });
  });

  app.post('/api/login/player', (req, res) => {
    if (!throttle(req, res)) return;
    const { code } = req.body ?? {};
    const playerId = typeof code === 'string' ? auth.playerForCode(code) : undefined;
    if (!playerId || !state.get(playerId)) {
      auth.recordFailure(req.ip ?? 'unknown');
      res.status(403).json({ error: 'That invite code is not recognised. Ask your GM for a fresh one.' });
      return;
    }
    res.json({ token: auth.createSession(playerId) });
  });

  app.post('/api/logout', (req, res) => {
    const token = bearer(req);
    if (token) auth.revoke(token);
    res.json({ ok: true });
  });

  app.get('/api/rules', (req, res) => {
    if (!viewerOf(req, res)) return;
    res.type('application/json').send(rules.json());
  });

  // Image uploads (battlemaps, portraits). The file is the raw request body.
  app.post('/api/upload', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
    const viewer = viewerOf(req, res);
    if (!viewer) return;
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_TYPES[mime];
    if (!ext) {
      res.status(415).json({ error: 'Only PNG, JPEG, WebP and GIF images can be uploaded.' });
      return;
    }
    const data = req.body as Buffer;
    if (!Buffer.isBuffer(data) || data.length === 0) {
      res.status(400).json({ error: 'The upload was empty.' });
      return;
    }
    const file = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir, file), data);
    const rawName = typeof req.query.name === 'string' ? req.query.name : file;
    const asset = state.transact((tx) =>
      tx.create('asset', { name: rawName.slice(0, 120), mime, size: data.length, url: `/uploads/${file}`, uploadedBy: viewer.playerId }),
    );
    res.json({ id: asset.id, url: asset.url });
  });

  app.use(
    '/uploads',
    express.static(uploadsDir, {
      fallthrough: false,
      immutable: true,
      maxAge: '365d',
      setHeaders: (res) => res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"),
    }),
  );

  // Full backup of the campaign (GM only). Restoring replaces every entity.
  app.get('/api/backup', (req, res) => {
    const viewer = viewerOf(req, res);
    if (!viewer) return;
    if (viewer.role !== 'gm') {
      res.status(403).json({ error: 'Only the GM can download a backup.' });
      return;
    }
    res.setHeader('Content-Disposition', `attachment; filename="traveller-campaign-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ app: 'traveller-ui', version: APP_VERSION, exportedAt: new Date().toISOString(), entities: state.everything() });
  });

  app.post('/api/restore', express.json({ limit: '200mb' }), (req, res) => {
    const viewer = viewerOf(req, res);
    if (!viewer) return;
    if (viewer.role !== 'gm') {
      res.status(403).json({ error: 'Only the GM can restore a backup.' });
      return;
    }
    const incoming = (req.body as { entities?: Entity[] } | undefined)?.entities;
    if (!Array.isArray(incoming) || !incoming.every((e) => e && typeof e.id === 'string' && typeof e.type === 'string')) {
      res.status(400).json({ error: 'That file is not a campaign backup.' });
      return;
    }
    state.transact((tx) => {
      // Player accounts stay as they are so nobody is locked out; everything else is replaced.
      const keep = new Set(tx.all('player').map((p) => p.id));
      for (const e of tx.state.everything()) if (!keep.has(e.id)) tx.delete(e.id);
      for (const e of incoming) {
        if (e.type === 'player') continue;
        const { id, type, rev: _rev, createdAt: _c, updatedAt: _u, ...data } = e as Entity & Record<string, unknown>;
        tx.create(type as Entity['type'], { ...(data as object), id } as never);
      }
      if (!tx.get(CAMPAIGN_ID)) createCampaign(tx, 'Traveller Campaign');
    });
    res.json({ ok: true, entities: state.count() });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // The built web app, with client-side routing falling back to index.html.
  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    app.use(express.static(config.webDir, { index: false }));
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(config.webDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .type('text/plain')
        .send('Traveller UI server is running, but the web app has not been built yet.\nRun "npm run build" (or use "npm run dev" and open http://localhost:5173).');
    });
  }

  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'That file is too large.' });
      return;
    }
    if (err.status && err.status < 500) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[http]', err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}
