/**
 * The sync hub: one WebSocket per browser tab. After every change it works out, per connection,
 * how that viewer's redacted picture of the campaign changed and sends only that difference.
 */
import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { PARTY_VIEWER_ID, redact, type Viewer } from '../shared/knowledge';
import { APP_VERSION, type ClientMessage, type Me, type ServerMessage } from '../shared/protocol';
import type { Entity, Id, Player } from '../shared/types';
import { hashString } from '../shared/util';
import { runAction, type Emitter, type Services } from './actions/registry';
import { ActionError, type Change, type State } from './state';

interface Conn {
  ws: WebSocket;
  /** Real identity, set after a valid hello. */
  me?: Viewer;
  /** Identity used for redaction; differs from `me` while the GM previews a player's view. */
  viewer?: Viewer;
  viewAs?: Id;
  /** Signature of the last copy of each entity sent on this connection. */
  sent: Map<Id, string>;
  alive: boolean;
}

function signature(json: string): string {
  return `${json.length}:${hashString(json)}`;
}

export class Hub implements Emitter {
  private conns = new Set<Conn>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: { threshold: 2048 } });
  private services!: Services;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private state: State) {
    state.onChange((change) => this.flush(change));
  }

  start(server: http.Server, services: Services): void {
    this.services = services;
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
    this.heartbeat = setInterval(() => {
      for (const conn of this.conns) {
        if (!conn.alive) {
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        try {
          conn.ws.ping();
        } catch {
          /* socket already closing */
        }
      }
    }, 30_000);
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const conn of this.conns) conn.ws.close();
    this.wss.close();
  }

  private accept(ws: WebSocket): void {
    const conn: Conn = { ws, sent: new Map(), alive: true };
    this.conns.add(conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data) => {
      conn.alive = true;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        this.send(conn, { t: 'err', code: 'bad-message', msg: 'Malformed message' });
        return;
      }
      void this.onMessage(conn, msg);
    });
    ws.on('close', () => {
      this.conns.delete(conn);
      if (conn.me) this.broadcastPresence();
    });
    ws.on('error', () => ws.close());
  }

  private send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    conn.ws.send(JSON.stringify(msg));
  }

  private async onMessage(conn: Conn, msg: ClientMessage): Promise<void> {
    if (msg.t === 'ping') {
      this.send(conn, { t: 'pong' });
      return;
    }
    if (msg.t === 'hello') {
      const playerId = this.services.auth.resolve(msg.token);
      const player = this.state.get<Player>(playerId);
      if (!playerId || !player || player.type !== 'player') {
        this.send(conn, { t: 'err', code: 'auth', msg: 'Your session has expired. Please sign in again.' });
        conn.ws.close();
        return;
      }
      conn.me = { role: player.role, playerId };
      this.setViewAs(conn, msg.viewAs);
      this.broadcastPresence();
      return;
    }
    if (!conn.me) {
      this.send(conn, { t: 'err', code: 'auth', msg: 'Say hello first' });
      return;
    }
    if (msg.t === 'act') {
      // Switching the preview identity is a per-connection concern, so it is handled here.
      if (msg.type === 'view.as') {
        if (conn.me.role !== 'gm') {
          this.send(conn, { t: 'res', id: msg.id, ok: false, err: 'Only the GM can preview other views' });
          return;
        }
        this.setViewAs(conn, (msg.p as { playerId?: Id } | undefined)?.playerId);
        this.send(conn, { t: 'res', id: msg.id, ok: true });
        return;
      }
      try {
        const data = await runAction(this.services, conn.me, msg.type, msg.p);
        this.send(conn, { t: 'res', id: msg.id, ok: true, data });
      } catch (err) {
        if (!(err instanceof ActionError)) console.error(`[action ${msg.type}]`, err);
        const text = err instanceof ActionError ? err.message : 'Something went wrong on the server';
        this.send(conn, { t: 'res', id: msg.id, ok: false, err: text });
      }
    }
  }

  private setViewAs(conn: Conn, viewAs: Id | undefined): void {
    const me = conn.me!;
    let viewer: Viewer = me;
    conn.viewAs = undefined;
    if (me.role === 'gm' && viewAs) {
      const target = viewAs === PARTY_VIEWER_ID ? undefined : this.state.get<Player>(viewAs);
      if (viewAs === PARTY_VIEWER_ID || (target && target.type === 'player' && target.role === 'player')) {
        viewer = { role: 'player', playerId: viewAs };
        conn.viewAs = viewAs;
      }
    }
    conn.viewer = viewer;
    const meMsg: Me = { playerId: me.playerId, role: me.role, viewAs: conn.viewAs };
    this.send(conn, { t: 'welcome', me: meMsg, serverTime: Date.now(), version: APP_VERSION });
    this.snapshot(conn);
  }

  private view(entity: Entity, viewer: Viewer): Entity | null {
    return redact(entity, viewer, (id) => this.state.get(id));
  }

  private snapshot(conn: Conn): void {
    const viewer = conn.viewer!;
    conn.sent.clear();
    const ents: Entity[] = [];
    for (const entity of this.state.everything()) {
      const v = this.view(entity, viewer);
      if (!v) continue;
      ents.push(v);
      conn.sent.set(entity.id, viewer.role === 'gm' ? `r${entity.rev}` : signature(JSON.stringify(v)));
    }
    this.send(conn, { t: 'snap', ents });
  }

  /** Entities whose visibility depends on `entity`, so their views must be re-checked with it. */
  private dependents(entity: Entity): Id[] {
    if (entity.type === 'system') {
      return [
        ...this.state.where('body', 'systemId', entity.id).map((b) => b.id),
        ...this.state.where('route', 'a', entity.id).map((r) => r.id),
        ...this.state.where('route', 'b', entity.id).map((r) => r.id),
      ];
    }
    return [];
  }

  private flush(change: Change): void {
    if (this.conns.size === 0) return;
    const ids = new Set<Id>(change.changed);
    for (const id of change.changed) {
      const e = this.state.get(id);
      if (e) for (const dep of this.dependents(e)) ids.add(dep);
    }
    const deleted = [...change.deleted.keys()];

    for (const conn of this.conns) {
      const viewer = conn.viewer;
      if (!viewer) continue;
      const up: Entity[] = [];
      const del: Id[] = [];
      for (const id of deleted) {
        if (conn.sent.delete(id)) del.push(id);
      }
      for (const id of ids) {
        const entity = this.state.get(id);
        if (!entity) continue;
        const v = this.view(entity, viewer);
        if (!v) {
          if (conn.sent.delete(id)) del.push(id);
          continue;
        }
        const sig = viewer.role === 'gm' ? `r${entity.rev}` : signature(JSON.stringify(v));
        if (conn.sent.get(id) === sig) continue;
        conn.sent.set(id, sig);
        up.push(v);
      }
      if (up.length || del.length) this.send(conn, { t: 'patch', up, del });
    }
  }

  /** Sends an ephemeral event. `to` filters by the viewer identity used for redaction. */
  emit(ev: string, d: unknown, to?: (v: Viewer) => boolean): void {
    for (const conn of this.conns) {
      if (!conn.viewer) continue;
      if (to && !to(conn.viewer)) continue;
      this.send(conn, { t: 'ev', ev, d });
    }
  }

  onlinePlayers(): Id[] {
    const ids = new Set<Id>();
    for (const conn of this.conns) if (conn.me) ids.add(conn.me.playerId);
    return [...ids];
  }

  private broadcastPresence(): void {
    this.emit('presence', { online: this.onlinePlayers() });
  }

  /** Drops every connection belonging to a player (after removal or an invite reset). */
  disconnectPlayer(playerId: Id): void {
    for (const conn of this.conns) {
      if (conn.me?.playerId !== playerId) continue;
      this.send(conn, { t: 'err', code: 'auth', msg: 'You have been signed out by the GM.' });
      conn.ws.close();
    }
  }
}
