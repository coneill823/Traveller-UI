/**
 * The authoritative in-memory campaign state.
 *
 * All writes happen inside `transact`, which collects what changed so the hub can send each
 * viewer exactly the updates they are allowed to see, and rolls everything back if the action
 * throws part-way through.
 */
import { applyPatch, type PatchOp } from '../shared/patch';
import type { Entity, EntityOf, EntityType, Id } from '../shared/types';
import { deepClone, newId } from '../shared/util';
import type { Persistence } from './db';

/** Fields that are looked up often enough to keep an index for. */
const INDEXED: Partial<Record<EntityType, string[]>> = {
  system: ['sectorId'],
  body: ['systemId', 'parentId'],
  route: ['a', 'b'],
  wikiPage: ['entityId', 'path'],
};

export interface Change {
  changed: Set<Id>;
  deleted: Map<Id, Entity>;
}

export type ChangeListener = (change: Change) => void;

export class State {
  private ents = new Map<Id, Entity>();
  private byType = new Map<string, Set<Id>>();
  private indexes = new Map<string, Map<string, Set<Id>>>();
  private listeners: ChangeListener[] = [];
  private active: Tx | null = null;

  constructor(private persistence: Persistence | null) {
    if (persistence) for (const e of persistence.loadEntities()) this.insert(e);
  }

  // ── reads ──

  get<T extends Entity = Entity>(id: Id | undefined | null): T | undefined {
    return id ? (this.ents.get(id) as T | undefined) : undefined;
  }

  all<T extends EntityType>(type: T): EntityOf<T>[] {
    const ids = this.byType.get(type);
    if (!ids) return [];
    const out: EntityOf<T>[] = [];
    for (const id of ids) out.push(this.ents.get(id) as EntityOf<T>);
    return out;
  }

  /** Entities of `type` whose indexed `field` equals `value`. */
  where<T extends EntityType>(type: T, field: string, value: string | undefined): EntityOf<T>[] {
    if (value === undefined) return [];
    if (!INDEXED[type]?.includes(field)) {
      return this.all(type).filter((e) => (e as unknown as Record<string, unknown>)[field] === value);
    }
    const ids = this.indexes.get(`${type}.${field}`)?.get(value);
    if (!ids) return [];
    const out: EntityOf<T>[] = [];
    for (const id of ids) out.push(this.ents.get(id) as EntityOf<T>);
    return out;
  }

  count(): number {
    return this.ents.size;
  }

  everything(): Entity[] {
    return [...this.ents.values()];
  }

  onChange(listener: ChangeListener): void {
    this.listeners.push(listener);
  }

  // ── writes ──

  /** Runs `fn` atomically. Nested calls join the outer transaction. */
  transact<T>(fn: (tx: Tx) => T): T {
    if (this.active) return fn(this.active);
    const tx = new Tx(this);
    this.active = tx;
    let result: T;
    try {
      result = fn(tx);
    } catch (err) {
      tx.rollback();
      this.active = null;
      throw err;
    }
    this.active = null;
    const change = tx.finish();
    if (change.changed.size || change.deleted.size) {
      const upserts: Entity[] = [];
      for (const id of change.changed) {
        const e = this.ents.get(id);
        if (e) upserts.push(e);
      }
      this.persistence?.saveEntities(upserts, [...change.deleted.keys()]);
      for (const listener of this.listeners) listener(change);
    }
    return result;
  }

  /** Internal: used by Tx. */
  insert(e: Entity): void {
    this.ents.set(e.id, e);
    let ids = this.byType.get(e.type);
    if (!ids) this.byType.set(e.type, (ids = new Set()));
    ids.add(e.id);
    for (const field of INDEXED[e.type] ?? []) {
      const value = (e as unknown as Record<string, unknown>)[field];
      if (typeof value !== 'string') continue;
      const key = `${e.type}.${field}`;
      let index = this.indexes.get(key);
      if (!index) this.indexes.set(key, (index = new Map()));
      let set = index.get(value);
      if (!set) index.set(value, (set = new Set()));
      set.add(e.id);
    }
  }

  /** Internal: used by Tx. */
  remove(id: Id): Entity | undefined {
    const e = this.ents.get(id);
    if (!e) return undefined;
    this.ents.delete(id);
    this.byType.get(e.type)?.delete(id);
    for (const field of INDEXED[e.type] ?? []) {
      const value = (e as unknown as Record<string, unknown>)[field];
      if (typeof value === 'string') this.indexes.get(`${e.type}.${field}`)?.get(value)?.delete(id);
    }
    return e;
  }
}

/** A unit of work. Entities are treated as immutable: every write stores a fresh object. */
export class Tx {
  private before = new Map<Id, Entity | undefined>();
  private changed = new Set<Id>();
  private deleted = new Map<Id, Entity>();

  constructor(readonly state: State) {}

  get<T extends Entity = Entity>(id: Id | undefined | null): T | undefined {
    return this.state.get<T>(id);
  }

  /** Like `get` but throws when missing or of the wrong type. */
  need<T extends EntityType>(type: T, id: Id | undefined | null): EntityOf<T> {
    const e = this.state.get(id);
    if (!e || e.type !== type) throw new ActionError(`No ${type} with id "${id ?? ''}"`);
    return e as EntityOf<T>;
  }

  all<T extends EntityType>(type: T): EntityOf<T>[] {
    return this.state.all(type);
  }

  where<T extends EntityType>(type: T, field: string, value: string | undefined): EntityOf<T>[] {
    return this.state.where(type, field, value);
  }

  private remember(id: Id): void {
    if (!this.before.has(id)) this.before.set(id, this.state.get(id));
  }

  /** Creates an entity. `data` supplies everything except the bookkeeping fields. */
  create<T extends EntityType>(type: T, data: Omit<EntityOf<T>, 'id' | 'type' | 'rev' | 'createdAt' | 'updatedAt'> & { id?: Id }): EntityOf<T> {
    const now = Date.now();
    const id = data.id ?? newId(type);
    if (this.state.get(id)) throw new ActionError(`Entity "${id}" already exists`);
    const entity = { ...deepClone(data), id, type, rev: 1, createdAt: now, updatedAt: now } as unknown as EntityOf<T>;
    this.remember(id);
    this.state.insert(entity);
    this.changed.add(id);
    this.deleted.delete(id);
    return entity;
  }

  /** Replaces an entity with an edited copy produced by `edit`. */
  update<T extends Entity>(id: Id, edit: (draft: T) => void): T {
    const current = this.state.get<T>(id);
    if (!current) throw new ActionError(`Entity "${id}" not found`);
    const draft = deepClone(current);
    edit(draft);
    draft.id = current.id;
    draft.type = current.type;
    draft.createdAt = current.createdAt;
    draft.rev = current.rev + 1;
    draft.updatedAt = Date.now();
    this.remember(id);
    this.state.remove(id);
    this.state.insert(draft);
    this.changed.add(id);
    return draft;
  }

  patch<T extends Entity>(id: Id, ops: PatchOp[]): T {
    return this.update<T>(id, (draft) => {
      applyPatch(draft, ops);
    });
  }

  delete(id: Id): void {
    const current = this.state.get(id);
    if (!current) return;
    this.remember(id);
    this.state.remove(id);
    this.changed.delete(id);
    // Only report a deletion for entities that existed before this transaction began.
    if (this.before.get(id) !== undefined) this.deleted.set(id, this.before.get(id)!);
  }

  rollback(): void {
    for (const [id, previous] of this.before) {
      this.state.remove(id);
      if (previous) this.state.insert(previous);
    }
    this.before.clear();
    this.changed.clear();
    this.deleted.clear();
  }

  finish(): Change {
    return { changed: this.changed, deleted: this.deleted };
  }
}

/** An error whose message is safe and useful to show to the person who triggered the action. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}
