import http from 'node:http';
import os from 'node:os';
import { createApp } from './http';
import { CAMPAIGN_ID, createCampaign, createPlayer } from './actions/core';
import './actions/map';
import './actions/characters';
import './actions/objectives';
import './actions/wiki';
import type { Services } from './actions/registry';
import { Auth, prettyCode } from './auth';
import { loadConfig, type Config } from './config';
import { openPersistence } from './db';
import { Hub } from './hub';
import { RulesService } from './rules';
import { State } from './state';
import type { WikiBackend } from './wiki/backend';
import { WikiService } from './wiki/sync';

export interface RunningServer {
  server: http.Server;
  services: Services;
  hub: Hub;
  port: number;
  close(): Promise<void>;
}

/** Starts the whole server. Exported so tests can run it in-process on a temporary data folder. */
export async function startServer(config: Config, opts: { quiet?: boolean; wikiBackend?: WikiBackend; skipWikiStart?: boolean } = {}): Promise<RunningServer> {
  const persistence = openPersistence(config.dataDir);
  const state = new State(persistence);
  const auth = new Auth(persistence, config.gmPassword);
  const rules = new RulesService(config.rulepackDir);
  const hub = new Hub(state);
  const wiki = new WikiService(state, config.wiki, rules, opts.wikiBackend);
  // Only the GM hears about wiki sync status.
  wiki.onStatus = (status) => hub.emit('wiki.status', status, (v) => v.role === 'gm');
  const services: Services = { state, auth, config, rules, events: hub, extra: { hub, wiki } };

  // With a passphrase supplied through the environment the server is ready to use straight away.
  if (!auth.hasGm() && config.gmPassword) {
    const gm = state.transact((tx) => {
      if (!tx.get(CAMPAIGN_ID)) createCampaign(tx, 'Traveller Campaign');
      return tx.all('player').find((p) => p.role === 'gm') ?? createPlayer(tx, 'Referee', 'gm');
    });
    auth.claimGm(gm.id, undefined);
  }

  const app = createApp(services);
  const server = http.createServer(app);
  hub.start(server, services);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;

  if (!opts.quiet) {
    console.log(`\n  Traveller UI is running (${persistence.kind} storage, ${state.count()} records)`);
    console.log(`    On this computer:  http://localhost:${port}`);
    for (const ip of lanAddresses()) console.log(`    On your network:   http://${ip}:${port}`);
    const ws = wiki.status();
    console.log(ws.configured ? `    Wiki:              ${ws.label}${ws.canWrite ? '' : ' (read-only: no WIKI_TOKEN)'}` : '    Wiki:              not configured (set WIKI_DIR or WIKI_REPO)');
    if (!auth.hasGm()) {
      console.log(`\n  First run: open the address above and claim the GM seat with this setup code:`);
      console.log(`\n      ${prettyCode(auth.setupCode)}\n`);
    }
  }

  if (!opts.skipWikiStart) wiki.start();

  return {
    server,
    services,
    hub,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        wiki.stop();
        hub.stop();
        server.close(() => {
          persistence.close();
          resolve();
        });
        server.closeAllConnections?.();
      }),
  };
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) if (net.family === 'IPv4' && !net.internal) out.push(net.address);
  }
  return out;
}

// Start when run directly (not when imported by tests).
if (!process.env.VITEST) {
  startServer(loadConfig())
    .then((running) => {
      const shutdown = () => {
        void running.close().then(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('Failed to start:', err);
      process.exit(1);
    });
}
