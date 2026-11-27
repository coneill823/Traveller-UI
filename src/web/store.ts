/**
 * Client state. `ents` mirrors exactly what the server has sent this viewer (already redacted);
 * the client never holds more than it is allowed to see.
 *
 * A big map means tens of thousands of records, so an update must cost in proportion to what
 * changed, not to everything held. `ents` is therefore changed in place and keeps its identity:
 * components read one entry (`useEntity`), a type's list (`useType`) or a type's lookup
 * (`useById`), each of which is replaced only when something in it changes.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import type { Me, StatusResponse } from '../shared/protocol';
import { EMPTY_PACK, type RulePack } from '../shared/rulepack';
import type { Campaign, Entity, EntityOf, EntityType, Id, Player } from '../shared/types';

export interface Toast {
  id: number;
  kind: 'info' | 'ok' | 'error';
  text: string;
}

export type Phase = 'loading' | 'setup' | 'login' | 'connecting' | 'ready';

interface AppState {
  phase: Phase;
  status?: StatusResponse;
  token?: string;
  me?: Me;
  connected: boolean;
  ents: Record<Id, Entity>;
  /** Entity lists per type; a list keeps its identity until an entity of that type changes. */
  byType: Partial<Record<EntityType, Entity[]>>;
  online: Id[];
  rules: RulePack;
  toasts: Toast[];
  diceOpen: boolean;
}

export const useApp = create<AppState>(() => ({
  phase: 'loading',
  connected: false,
  ents: {},
  byType: {},
  online: [],
  rules: EMPTY_PACK,
  toasts: [],
  diceOpen: false,
}));

const set = useApp.setState;
const get = useApp.getState;

// ── entity updates from the server ──

export function applySnapshot(list: Entity[]): void {
  const ents: Record<Id, Entity> = {};
  const byType: Partial<Record<EntityType, Entity[]>> = {};
  for (const e of list) {
    ents[e.id] = e;
    (byType[e.type] ??= []).push(e);
  }
  set({ ents, byType });
}

export function applyPatch(up: Entity[], del: Id[]): void {
  const state = get();
  const ents = state.ents;
  const gone = new Map<EntityType, Set<Id>>();
  const fresh = new Map<EntityType, Map<Id, Entity>>();
  const drop = (old: Entity): void => {
    let ids = gone.get(old.type);
    if (!ids) gone.set(old.type, (ids = new Set()));
    ids.add(old.id);
  };
  for (const id of del) {
    const old = ents[id];
    if (!old) continue;
    drop(old);
    delete ents[id];
  }
  for (const e of up) {
    const old = ents[e.id];
    if (old && old.type !== e.type) drop(old);
    ents[e.id] = e;
    let list = fresh.get(e.type);
    if (!list) fresh.set(e.type, (list = new Map()));
    list.set(e.id, e);
  }
  if (gone.size === 0 && fresh.size === 0) return;
  const byType = { ...state.byType };
  // Only the lists of the types that changed are rebuilt, each from its own old list: entries keep their places and new ones go on the end.
  for (const type of new Set([...gone.keys(), ...fresh.keys()])) {
    const removed = gone.get(type);
    const added = new Map(fresh.get(type) ?? []);
    const next: Entity[] = [];
    for (const e of state.byType[type] ?? []) {
      const newer = added.get(e.id);
      if (newer) {
        next.push(newer);
        added.delete(e.id);
      } else if (!removed?.has(e.id)) next.push(e);
    }
    for (const e of added.values()) next.push(e);
    byType[type] = next;
  }
  set({ ents, byType });
}

// ── hooks ──

const EMPTY: Entity[] = [];

export function useType<T extends EntityType>(type: T): EntityOf<T>[] {
  return useApp((s) => (s.byType[type] ?? EMPTY) as EntityOf<T>[]);
}

/** Every entity of a type by id. The lookup is replaced only when something of that type changes. */
export function useById<T extends EntityType>(type: T): Map<Id, EntityOf<T>> {
  const list = useType(type);
  return useMemo(() => new Map(list.map((e) => [e.id, e])), [list]);
}

export function useEntity<T extends Entity = Entity>(id: Id | undefined | null): T | undefined {
  return useApp((s) => (id ? (s.ents[id] as T | undefined) : undefined));
}

export function useCampaign(): Campaign | undefined {
  return useApp((s) => s.ents.campaign as Campaign | undefined);
}

export function useMe(): Me | undefined {
  return useApp((s) => s.me);
}

/** True for the GM working with full data (creator mode). False for players and for the GM's player preview. */
export function useIsGm(): boolean {
  return useApp((s) => s.me?.role === 'gm' && !s.me.viewAs);
}

/** The real players (not the GM), sorted by name. */
export function usePlayers(): Player[] {
  const players = useType('player');
  return useMemo(() => players.filter((p) => p.role === 'player').sort((a, b) => a.name.localeCompare(b.name)), [players]);
}

export function useRules(): RulePack {
  return useApp((s) => s.rules);
}

export function getEntity<T extends Entity = Entity>(id: Id | undefined | null): T | undefined {
  return id ? (get().ents[id] as T | undefined) : undefined;
}

// ── toasts ──

let toastSeq = 1;

export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = toastSeq++;
  set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3500);
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
