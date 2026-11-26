/** Shared helpers for the combat screen: who a combatant is to this viewer, turn order, and the replay. */
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { healthStatus } from '../../../shared/rules/character';
import type { Character, Combatant, CombatantSeen, Encounter, Id, TurnRecord, TurnResult, TurnStep } from '../../../shared/types';
import { onEvent } from '../../net';
import { getEntity, useApp, useIsGm, useMe } from '../../store';

export interface CombatantInfo {
  combatant: Combatant;
  name: string;
  kind: Character['kind'];
  portrait?: string;
  health: CombatantSeen['health'];
  /** The sheet, when this viewer is allowed to see it. */
  character?: Character;
  /** This viewer plays (or, as GM, runs) the combatant. */
  controlled: boolean;
  mine: boolean;
}

export function infoFor(c: Combatant, character: Character | undefined, me: { playerId: Id } | undefined, gm: boolean): CombatantInfo {
  const mine = !!character && character.kind === 'pc' && character.ownerId === me?.playerId;
  const sheetName = character?.name;
  return {
    combatant: c,
    name: c.label ?? c.seen?.name ?? sheetName ?? (character?.kind === 'creature' ? 'Creature' : 'Unknown'),
    kind: character?.kind ?? c.seen?.kind ?? 'npc',
    portrait: character?.portrait ?? c.seen?.portrait,
    health: character?.chars ? healthStatus(character) : (c.seen?.health ?? 'ok'),
    character: character?.chars ? character : undefined,
    controlled: gm || mine,
    mine,
  };
}

/** Everyone in the fight as this viewer sees them, keyed by combatant id. */
export function useCombatants(encounter: Encounter): Map<Id, CombatantInfo> {
  const ents = useApp((s) => s.ents);
  const me = useMe();
  const gm = useIsGm();
  return useMemo(() => {
    const map = new Map<Id, CombatantInfo>();
    for (const c of encounter.combatants) map.set(c.id, infoFor(c, ents[c.characterId] as Character | undefined, me, gm));
    return map;
  }, [encounter.combatants, ents, me, gm]);
}

/** Best initiative first; ties go to the higher DEX where it is known. Those out of the fight go last. */
export function orderOf(encounter: Encounter, infos: Map<Id, CombatantInfo>): Combatant[] {
  return encounter.combatants
    .map((c, index) => ({ c, index, dex: infos.get(c.id)?.character?.chars?.DEX?.value ?? 0 }))
    .sort((a, b) => Number(!!a.c.out) - Number(!!b.c.out) || (b.c.initiative ?? -99) - (a.c.initiative ?? -99) || b.dex - a.dex || a.index - b.index)
    .map((x) => x.c);
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  const last = words[words.length - 1];
  // "Raider 2" reads better as R2 than as RA.
  if (words.length > 1 && /^\d+$/.test(last)) return (words[0][0] + last).toUpperCase().slice(0, 3);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

export const HEALTH_LABEL: Record<CombatantSeen['health'], string> = { ok: 'Unhurt', wounded: 'Wounded', unconscious: 'Down', dead: 'Dead' };

/** Distance between two points on a map in metres, when the map has a grid to give it scale. */
export function metresOn(map: { width: number; height: number; squares?: number }, a: { x?: number; y?: number }, b: { x?: number; y?: number }, squareMetres: number): number | undefined {
  if (!map.squares) return undefined;
  const per = map.width / map.squares;
  return Math.round(Math.hypot((((a.x ?? 0.5) - (b.x ?? 0.5)) * map.width) / per, (((a.y ?? 0.5) - (b.y ?? 0.5)) * map.height) / per) * squareMetres * 10) / 10;
}

// ───────────────────────────── describing a step ─────────────────────────────

const VERBS: Record<string, string> = {
  move: 'moves',
  aim: 'aims',
  stance: 'changes stance',
  draw: 'draws or reloads',
  leadership: 'rallies the others',
  dodge: 'dodges',
  parry: 'parries',
  dive: 'dives for cover',
};

/** One step of a turn in words, as it reads after the actor's name. */
export function describeStep(step: TurnStep, result: TurnResult | undefined, nameOf: (id: Id | undefined) => string | undefined, metres?: (a: { x: number; y: number }, b: { x: number; y: number }) => number | undefined): string {
  const target = nameOf(step.targetId);
  const bits: string[] = [];
  if (step.action === 'attack') {
    bits.push(`attacks${target ? ` ${target}` : ''}${step.weapon ? ` with ${step.weapon}` : ''}`);
    if (step.roll) bits.push(`${step.roll.total} against ${step.roll.target ?? 8}: ${result?.hit === false ? 'miss' : 'hit'}`);
    if (result?.dealt !== undefined) bits.push(`${result.dealt} damage${result.taken !== undefined && result.taken !== result.dealt ? ` (${result.taken} after armour)` : ''}`);
    if (result?.status === 'unconscious') bits.push(`${target ?? 'the target'} goes down`);
    if (result?.status === 'dead') bits.push(`${target ?? 'the target'} is killed`);
  } else {
    const distance = result?.from && result.to ? metres?.(result.from, result.to) : undefined;
    bits.push((VERBS[step.action] ?? step.label.toLowerCase()) + (distance !== undefined ? ` ${distance} m` : '') + (target ? ` (${target})` : ''));
    if (step.roll) bits.push(`${step.roll.total} against ${step.roll.target ?? 8}: ${(result?.effect ?? step.roll.total - (step.roll.target ?? 8)) >= 0 ? 'success' : 'failure'}`);
  }
  if (step.note) bits.push(step.note);
  return bits.join(' — ');
}

// ───────────────────────────── replay ─────────────────────────────

interface ReplayState {
  encounterId?: Id;
  record?: TurnRecord;
  /** Index of the step being shown; -1 before the first. */
  index: number;
  queue: { encounterId: Id; record: TurnRecord }[];
  play: (encounterId: Id, record: TurnRecord) => void;
  stop: () => void;
}

const STEP_MS = 1700;
let timer: ReturnType<typeof setTimeout> | undefined;

function tick(): void {
  const s = useReplayStore.getState();
  if (!s.record) return;
  const next = s.index + 1;
  if (next >= s.record.steps.length) {
    const [head, ...rest] = s.queue;
    if (head) {
      useReplayStore.setState({ encounterId: head.encounterId, record: head.record, index: -1, queue: rest });
      timer = setTimeout(tick, 350);
    } else {
      useReplayStore.setState({ record: undefined, encounterId: undefined, index: -1 });
    }
    return;
  }
  useReplayStore.setState({ index: next });
  timer = setTimeout(tick, STEP_MS);
}

export const useReplayStore = create<ReplayState>((set, get) => ({
  index: -1,
  queue: [],
  play: (encounterId, record) => {
    if (record.steps.length === 0) return;
    if (get().record) {
      set({ queue: [...get().queue, { encounterId, record }] });
      return;
    }
    set({ encounterId, record, index: -1 });
    clearTimeout(timer);
    timer = setTimeout(tick, 250);
  },
  stop: () => {
    clearTimeout(timer);
    set({ record: undefined, encounterId: undefined, index: -1, queue: [] });
  },
}));

export interface ReplayView {
  record: TurnRecord;
  index: number;
  step?: TurnStep;
  result?: TurnResult;
}

/** The turn being replayed on this encounter, if any. */
export function useReplay(encounterId: Id): ReplayView | undefined {
  const s = useReplayStore();
  if (!s.record || s.encounterId !== encounterId) return undefined;
  const step = s.index >= 0 ? s.record.steps[s.index] : undefined;
  return { record: s.record, index: s.index, step, result: step ? s.record.results.find((r) => r.stepId === step.id) : undefined };
}

/** Plays each turn as it is published. */
export function useAutoReplay(encounterId: Id): void {
  useEffect(() => {
    const off = onEvent('encounter.turn', (d: { encounterId: Id; recordId: Id }) => {
      if (d.encounterId !== encounterId) return;
      // The entity update arrives just before the event; give the store a beat to settle.
      setTimeout(() => {
        const record = getEntity<Encounter>(encounterId)?.log.find((r) => r.id === d.recordId);
        if (record) useReplayStore.getState().play(encounterId, record);
      }, 30);
    });
    return () => {
      off();
      useReplayStore.getState().stop();
    };
  }, [encounterId]);
}

/** Where the acting token should be drawn at this point of a replay. */
export function replayPosition(view: ReplayView | undefined, c: Combatant): { x: number; y: number } {
  const here = { x: c.x ?? 0.5, y: c.y ?? 0.5 };
  if (!view || view.record.combatantId !== c.id) return here;
  const moves = view.record.steps.map((s, i) => ({ i, r: view.record.results.find((x) => x.stepId === s.id) })).filter((m) => m.r?.to);
  if (moves.length === 0) return here;
  const done = moves.filter((m) => m.i <= view.index);
  if (done.length > 0) return done[done.length - 1].r!.to!;
  return moves[0].r!.from ?? here;
}
