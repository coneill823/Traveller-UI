/**
 * Persistence. The campaign is small enough to live in memory; this layer only makes it durable.
 * SQLite (built into Node) is used when available, with a plain JSON file as a fallback so the
 * server still runs on Node builds without it.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Entity, Id } from '../shared/types';

export interface Persistence {
  readonly kind: 'sqlite' | 'json';
  loadEntities(): Entity[];
  saveEntities(upserts: Entity[], deletes: Id[]): void;
  loadKv(): Map<string, string>;
  setKv(key: string, value: string): void;
  deleteKv(key: string): void;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (file: string) => SqliteDb;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): any[]; get(...args: unknown[]): any };
  close(): void;
}

function loadSqlite(): SqliteModule | undefined {
  // node:sqlite prints an ExperimentalWarning on first use; it is expected, so keep the console clean.
  const original = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : (warning as Error)?.message;
    if (text && /SQLite is an experimental feature/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:sqlite') as
      | SqliteModule
      | undefined;
  } catch {
    return undefined;
  }
}

class SqlitePersistence implements Persistence {
  readonly kind = 'sqlite' as const;
  private db: SqliteDb;
  private upsert;
  private remove;
  private kvSet;
  private kvDel;

  constructor(mod: SqliteModule, file: string) {
    this.db = new mod.DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.upsert = this.db.prepare(
      'INSERT INTO entities (id, type, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, data = excluded.data, updated_at = excluded.updated_at',
    );
    this.remove = this.db.prepare('DELETE FROM entities WHERE id = ?');
    this.kvSet = this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.kvDel = this.db.prepare('DELETE FROM kv WHERE key = ?');
  }

  loadEntities(): Entity[] {
    const rows = this.db.prepare('SELECT data FROM entities').all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Entity);
  }

  saveEntities(upserts: Entity[], deletes: Id[]): void {
    if (upserts.length === 0 && deletes.length === 0) return;
    this.db.exec('BEGIN');
    try {
      for (const e of upserts) this.upsert.run(e.id, e.type, JSON.stringify(e), e.updatedAt);
      for (const id of deletes) this.remove.run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  loadKv(): Map<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM kv').all() as { key: string; value: string }[];
    return new Map(rows.map((r) => [r.key, r.value]));
  }

  setKv(key: string, value: string): void {
    this.kvSet.run(key, value);
  }

  deleteKv(key: string): void {
    this.kvDel.run(key);
  }

  close(): void {
    this.db.close();
  }
}

class JsonPersistence implements Persistence {
  readonly kind = 'json' as const;
  private entities = new Map<Id, Entity>();
  private kv = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private file: string) {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { entities?: Entity[]; kv?: Record<string, string> };
      for (const e of raw.entities ?? []) this.entities.set(e.id, e);
      for (const [k, v] of Object.entries(raw.kv ?? {})) this.kv.set(k, v);
    }
  }

  loadEntities(): Entity[] {
    return [...this.entities.values()];
  }

  saveEntities(upserts: Entity[], deletes: Id[]): void {
    for (const e of upserts) this.entities.set(e.id, e);
    for (const id of deletes) this.entities.delete(id);
    this.schedule();
  }

  loadKv(): Map<string, string> {
    return new Map(this.kv);
  }

  setKv(key: string, value: string): void {
    this.kv.set(key, value);
    this.schedule();
  }

  deleteKv(key: string): void {
    this.kv.delete(key);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 500);
  }

  private flush(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entities: [...this.entities.values()], kv: Object.fromEntries(this.kv) }));
    fs.renameSync(tmp, this.file);
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.flush();
  }
}

export function openPersistence(dataDir: string, forceJson = false): Persistence {
  fs.mkdirSync(dataDir, { recursive: true });
  if (dataDir === ':memory:') throw new Error('Use a real directory for the data folder');
  const sqlite = forceJson ? undefined : loadSqlite();
  if (sqlite) return new SqlitePersistence(sqlite, path.join(dataDir, 'campaign.db'));
  console.warn('[db] node:sqlite is not available in this Node build; storing the campaign in campaign.json instead.');
  return new JsonPersistence(path.join(dataDir, 'campaign.json'));
}
