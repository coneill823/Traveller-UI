import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergePacks, type RulePack } from '../src/shared/rulepack';
import WebSocket from 'ws';
import type { ServerMessage } from '../src/shared/protocol';
import type { Entity, EntityOf, EntityType } from '../src/shared/types';
import type { Config } from '../src/server/config';
import { startServer, type RunningServer } from '../src/server/index';

export const RULEPACK_DIR = path.resolve(__dirname, '..', 'rulepacks');
/** Rule tables are kept out of the public repository, so tests that need them skip when absent. */
export const HAS_CORE_RULES = fs.existsSync(path.join(RULEPACK_DIR, 'mgt2-core', 'world.json'));

/** The core rules pack read straight from disk, for tests of the rules engines. */
export function loadCorePack(): RulePack {
  let pack: RulePack = { packs: [] };
  const dir = path.join(RULEPACK_DIR, 'mgt2-core');
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.json') && file !== 'pack.json') pack = mergePacks(pack, { packs: [], [path.basename(file, '.json')]: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) } as RulePack);
  }
  return pack;
}

/** True when the named pack is installed beside the core one. */
export function hasPack(name: string): boolean {
  return fs.existsSync(path.join(RULEPACK_DIR, name, 'pack.json'));
}

/** Packs read straight from disk and layered in the order given. */
export function loadPacks(...names: string[]): RulePack {
  let pack: RulePack = { packs: [] };
  for (const name of names) {
    const dir = path.join(RULEPACK_DIR, name);
    for (const file of fs.readdirSync(dir).sort()) {
      if (file.endsWith('.json') && file !== 'pack.json') pack = mergePacks(pack, { packs: [], [path.basename(file, '.json')]: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) } as RulePack);
    }
  }
  return pack;
}

export function testConfig(overrides: Partial<Config> = {}, extraPacks: string[] = []): Config {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traveller-ui-test-'));
  // The server under test gets the core pack alone (plus any asked for), whatever else is installed, so expectations hold.
  const rulepackDir = path.join(dataDir, 'rulepacks');
  fs.mkdirSync(rulepackDir);
  for (const name of HAS_CORE_RULES ? ['mgt2-core', ...extraPacks] : []) fs.cpSync(path.join(RULEPACK_DIR, name), path.join(rulepackDir, name), { recursive: true });
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    rulepackDir,
    webDir: path.join(dataDir, 'no-web'),
    gmPassword: undefined,
    wiki: { branch: 'main', pollSeconds: 3600, atlasFolder: 'Atlas' },
    ...overrides,
  };
}

/** A minimal client: keeps the entity set the server has sent and lets tests call actions. */
export class TestClient {
  ents = new Map<string, Entity>();
  events: { ev: string; d: any }[] = [];
  me: any;
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private snapWaiters: (() => void)[] = [];
  closed = false;
  authError: string | undefined;

  static async connect(port: number, token: string, viewAs?: string): Promise<TestClient> {
    const c = new TestClient();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    c.ws.on('message', (data) => c.onMessage(JSON.parse(String(data)) as ServerMessage));
    c.ws.on('close', () => {
      c.closed = true;
      for (const w of c.snapWaiters) w();
    });
    await new Promise<void>((resolve, reject) => {
      c.ws.once('open', () => resolve());
      c.ws.once('error', reject);
    });
    const snap = c.nextSnapshot();
    c.ws.send(JSON.stringify({ t: 'hello', token, viewAs }));
    await snap;
    return c;
  }

  nextSnapshot(): Promise<void> {
    return new Promise((resolve) => this.snapWaiters.push(resolve));
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.me = msg.me;
        break;
      case 'snap':
        this.ents = new Map(msg.ents.map((e) => [e.id, e]));
        for (const w of this.snapWaiters.splice(0)) w();
        break;
      case 'patch':
        for (const e of msg.up) this.ents.set(e.id, e);
        for (const id of msg.del) this.ents.delete(id);
        break;
      case 'res': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!p) break;
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.err));
        break;
      }
      case 'ev':
        this.events.push({ ev: msg.ev, d: msg.d });
        break;
      case 'err':
        this.authError = msg.msg;
        break;
      default:
        break;
    }
  }

  act<T = any>(type: string, p: unknown = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ t: 'act', id, type, p }));
    });
  }

  all<T extends EntityType>(type: T): EntityOf<T>[] {
    return [...this.ents.values()].filter((e) => e.type === type) as EntityOf<T>[];
  }

  get<T extends Entity = Entity>(id: string): T | undefined {
    return this.ents.get(id) as T | undefined;
  }

  close(): void {
    this.ws.close();
  }
}

/** Waits until `check` stops throwing (server pushes arrive asynchronously). */
export async function eventually(check: () => void, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 15));
    }
  }
}

export async function post(port: number, url: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

export interface Table {
  running: RunningServer;
  port: number;
  gmToken: string;
  gm: TestClient;
  /** Adds a player and returns a connected client for them. */
  join(name: string): Promise<{ id: string; token: string; client: TestClient; code: string }>;
  close(): Promise<void>;
}

/** Boots a server on a temporary folder with a GM already set up and connected. */
export async function setTable(overrides: Partial<Config> = {}, serverOpts: Parameters<typeof startServer>[1] = {}, extraPacks: string[] = []): Promise<Table> {
  const config = testConfig(overrides, extraPacks);
  // Tests drive wiki syncs by hand so they are not racing a background watcher.
  const running = await startServer(config, { quiet: true, skipWikiStart: true, ...serverOpts });
  const port = running.port;
  const setup = await post(port, '/api/setup', { setupCode: running.services.auth.setupCode, campaignName: 'Test Campaign', gmName: 'Ref', password: 'correct horse' });
  if (setup.status !== 200) throw new Error(`setup failed: ${JSON.stringify(setup.json)}`);
  const gmToken = setup.json.token as string;
  const gm = await TestClient.connect(port, gmToken);
  const clients: TestClient[] = [gm];
  return {
    running,
    port,
    gmToken,
    gm,
    async join(name: string) {
      const created = await gm.act<{ id: string; code: string }>('player.create', { name });
      const login = await post(port, '/api/login/player', { code: created.code });
      const client = await TestClient.connect(port, login.json.token);
      clients.push(client);
      return { id: created.id, token: login.json.token, client, code: created.code };
    },
    async close() {
      for (const c of clients) c.close();
      await running.close();
      fs.rmSync(config.dataDir, { recursive: true, force: true });
    },
  };
}
