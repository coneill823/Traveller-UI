/** Helpers shared by the ship status board and the battle screen. */
import { useMemo } from 'react';
import type { ShipRules, SpaceRules } from '../../../shared/rulepack';
import { evaluateDesign, type DesignReport } from '../../../shared/rules/ship';
import { conditionOf, critEffect, effectiveThrust, jumpAvailable, partsAt, powerFactor, type ShipCondition } from '../../../shared/rules/space';
import type { Character, Id, Ship } from '../../../shared/types';
import { useApp, useMe, useRules } from '../../store';

export function useShipReport(ship: Ship | undefined): DesignReport | undefined {
  const rules = useRules().ships;
  return useMemo(() => (ship?.spec && rules ? evaluateDesign(rules, ship.spec) : undefined), [ship?.spec, rules]);
}

export interface ShipStatus {
  hull: number;
  hullMax: number;
  armour: number;
  thrust: number;
  thrustNow: number;
  jump: number;
  jumpOk: boolean;
  powerPct: number;
  condition: ShipCondition;
  /** Locations with a critical hit, worst first. */
  damaged: { location: string; name: string; severity: number; text: string; patched: boolean }[];
}

export function shipStatus(ship: Ship, rules: SpaceRules | undefined, shipRules: ShipRules | undefined): ShipStatus {
  const hullMax = ship.hullMax ?? Math.max(1, Math.floor((ship.tons ?? 100) / (shipRules?.hull.tonsPerHullPoint ?? 2.5)));
  const hull = ship.hull ?? hullMax;
  const crits = ship.crits ?? {};
  const damaged = rules
    ? rules.criticals.locations
        .filter((l) => (crits[l.id] ?? 0) > 0)
        .map((l) => ({ location: l.id, name: l.name, severity: crits[l.id], text: critEffect(rules, l.id, crits[l.id])?.text ?? '', patched: ship.repaired?.includes(l.id) ?? false }))
        .sort((a, b) => b.severity - a.severity)
    : [];
  return {
    hull,
    hullMax,
    armour: ship.armour ?? 0,
    thrust: ship.thrust ?? 0,
    thrustNow: rules ? effectiveThrust(rules, ship.thrust ?? 0, crits, ship.repaired) : (ship.thrust ?? 0),
    jump: ship.jump ?? 0,
    jumpOk: rules ? jumpAvailable(rules, crits, ship.repaired) : true,
    powerPct: Math.round((rules ? powerFactor(rules, crits, ship.repaired) : 1) * 100),
    condition: conditionOf({ hull, hullMax }),
    damaged,
  };
}

/** Parts of the hull plan to flash: everything an unacknowledged alert points at. */
export function alertParts(ship: Ship): { parts: Set<string>; struck: boolean } {
  const parts = new Set<string>();
  let struck = false;
  for (const a of ship.alerts ?? []) {
    if (a.cleared || a.kind === 'repair') continue;
    if (a.partId) parts.add(a.partId);
    if (a.location) for (const id of partsAt(ship.spec, a.location)) parts.add(id);
    if (!a.partId && (!a.location || a.location === 'hull' || a.location === 'armour')) struck = true;
  }
  return { parts, struck };
}

export interface Station {
  characterId: Id;
  character?: Character;
  name: string;
  duty: string;
  mount?: string;
  mine: boolean;
}

/** Who is at which station aboard, as far as this viewer can see. */
export function useStations(ship: Ship | undefined): Station[] {
  const ents = useApp((s) => s.ents);
  const me = useMe();
  return useMemo(() => {
    const out: Station[] = [];
    for (const [characterId, d] of Object.entries(ship?.duties ?? {})) {
      const character = ents[characterId] as Character | undefined;
      out.push({ characterId, character, name: character?.name ?? 'Crew member', duty: d.duty, mount: d.mount, mine: !!character && character.kind === 'pc' && character.ownerId === me?.playerId });
    }
    return out;
  }, [ship?.duties, ents, me]);
}

/** Weapon mounts of a design with what they carry, for gunners to pick from. */
export function mountsOf(ship: Ship | undefined, shipRules: ShipRules | undefined): { id: string; label: string; weapons: { id: string; name: string; damage: string; range: string }[] }[] {
  if (!ship?.spec || !shipRules) return [];
  const out: { id: string; label: string; weapons: { id: string; name: string; damage: string; range: string }[] }[] = [];
  let n = 0;
  for (const part of ship.spec.parts) {
    if (part.kind !== 'mount') continue;
    const def = shipRules.mounts.find((m) => m.id === part.key);
    const weapons = (part.weapons ?? []).map((id) => shipRules.weapons.find((w) => w.id === id)).filter((w) => w !== undefined);
    for (let i = 0; i < (part.qty ?? 1); i++) {
      n += 1;
      out.push({ id: (part.qty ?? 1) > 1 ? `${part.id}#${i + 1}` : part.id, label: `${def?.name ?? 'Mount'} ${n}${weapons.length ? ` (${weapons.map((w) => w.name).join(', ')})` : ' (empty)'}`, weapons: weapons.map((w) => ({ id: w.id, name: w.name, damage: w.damage, range: w.range })) });
    }
  }
  return out;
}
