/**
 * Client state. `ents` mirrors exactly what the server has sent this viewer (already redacted);
 * the client never holds more than it is allowed to see.
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
  const ents = { ...state.ents };
  const touched = new Set<EntityType>();
  for (const id of del) {
    const old = ents[id];
    if (old) {
      touched.add(old.type);
      delete ents[id];
    }
  }
  for (const e of up) {
    ents[e.id] = e;
    touched.add(e.type);
  }
  if (touched.size === 0) return;
  const byType = { ...state.byType };
  // Rebuild only the lists of the types that changed.
  for (const type of touched) byType[type] = [];
  for (const e of Object.values(ents)) if (touched.has(e.type)) byType[e.type]!.push(e);
  set({ ents, byType });
}

// ── hooks ──

const EMPTY: Entity[] = [];

export function useType<T extends EntityType>(type: T): EntityOf<T>[] {
  return useApp((s) => (s.byType[type] ?? EMPTY) as EntityOf<T>[]);
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
