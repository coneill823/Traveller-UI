/**
 * Space combat: range bands, attack modifiers, and what a hit does to a ship: hull, armour and
 * the critical hits that knock systems out. Tables come from the rules pack.
 */
import type { CriticalEffect, SpaceRules } from '../rulepack';
import type { ShipSpec } from '../types';
import { rollDice, sum, type Rng } from '../util';

export interface ShipState {
  hull: number;
  hullMax: number;
  armour: number;
  fuel?: number;
  /** Critical hit severity by location. */
  crits: Record<string, number>;
}

export interface HitInput {
  /** Damage before armour, with the attack's Effect already added where it applies. */
  damage: number;
  /** Effect of the attack roll: 6 or more with damage getting through is a critical hit. */
  effect?: number;
  /** Where a critical lands, when the attacker chose (a called shot) or the GM says so. */
  location?: string;
  /** Applied to what gets through armour (some heavy weapons). */
  multiplier?: number;
  ignoreArmour?: boolean;
  /** Extra armour against this hit only (sand). */
  extraArmour?: number;
  noCritical?: boolean;
}

export interface CritOutcome {
  location: string;
  name: string;
  severity: number;
  text: string;
  /** Hull damage, armour and fuel lost to this critical. */
  extraDamage?: number;
  armourLost?: number;
  fuelLost?: number;
  /** From accumulated damage rather than a telling blow. */
  sustained?: boolean;
  /** The location was already as bad as it gets. */
  overflow?: boolean;
}

export interface HitOutcome extends ShipState {
  /** Hull lost to the hit itself, and what armour stopped. */
  taken: number;
  absorbed: number;
  /** Hull lost in all, including damage from critical hits. */
  hullLost: number;
  criticals: CritOutcome[];
  wrecked: boolean;
}

function d(n: number, rng: Rng): number {
  return n > 0 ? sum(rollDice(n, rng)) : 0;
}

export function critEffect(rules: SpaceRules, location: string, severity: number): CriticalEffect | undefined {
  return severity > 0 ? rules.criticals.effects[location]?.[Math.min(severity, rules.criticals.maxSeverity) - 1] : undefined;
}

export function locationName(rules: SpaceRules, location: string): string {
  return rules.criticals.locations.find((l) => l.id === location)?.name ?? location;
}

export function rollLocation(rules: SpaceRules, rng: Rng, applies: (location: string) => boolean = () => true): string {
  for (let i = 0; i < 30; i++) {
    const roll = d(2, rng);
    const loc = rules.criticals.locations.find((l) => l.roll === roll);
    if (loc && applies(loc.id)) return loc.id;
  }
  return 'hull';
}

/** Works out what a hit does. Nothing is changed: the caller applies the outcome. */
export function resolveHit(rules: SpaceRules, ship: ShipState, hit: HitInput, opts: { rng?: Rng; applies?: (location: string) => boolean } = {}): HitOutcome {
  const rng = opts.rng ?? Math.random;
  const applies = opts.applies ?? (() => true);
  const c = rules.criticals;
  const state: ShipState = { hull: ship.hull, hullMax: ship.hullMax, armour: ship.armour, fuel: ship.fuel, crits: { ...ship.crits } };
  const damage = Math.max(0, hit.damage);
  const armour = hit.ignoreArmour ? 0 : Math.max(0, state.armour + (hit.extraArmour ?? 0));
  const taken = Math.max(0, damage - armour) * (hit.multiplier ?? 1);
  const absorbed = damage - Math.max(0, damage - armour);
  const criticals: CritOutcome[] = [];
  const hullBefore = state.hull;
  const loseHull = (n: number) => {
    state.hull = Math.max(0, state.hull - n);
  };
  loseHull(taken);

  const crit = (location: string, severity: number, sustained = false): void => {
    const current = state.crits[location] ?? 0;
    const name = locationName(rules, location);
    if (current >= c.maxSeverity) {
      const extra = d(c.overflowDice, rng);
      loseHull(extra);
      criticals.push({ location, name, severity: c.maxSeverity, text: `Already wrecked: the ship takes ${extra} more damage.`, extraDamage: extra, overflow: true, ...(sustained ? { sustained } : {}) });
      return;
    }
    const next = Math.min(c.maxSeverity, Math.max(severity, current + 1));
    state.crits[location] = next;
    const effect = critEffect(rules, location, next);
    const outcome: CritOutcome = { location, name, severity: next, text: effect?.text ?? '', ...(sustained ? { sustained } : {}) };
    if (effect?.damageDice) {
      outcome.extraDamage = d(effect.damageDice, rng);
      loseHull(outcome.extraDamage);
    }
    const armourLoss = (effect?.armourLoss ?? 0) + (effect?.armourLossD3 ? Math.ceil(d(effect.armourLossD3, rng) / 2) : 0) + d(effect?.armourLossDice ?? 0, rng);
    if (armourLoss > 0) {
      outcome.armourLost = Math.min(state.armour, armourLoss);
      state.armour -= outcome.armourLost;
    }
    if (state.fuel !== undefined && (effect?.fuelLossPct || effect?.fuelLossDicePct)) {
      const pct = Math.min(100, (effect.fuelLossPct ?? 0) + d(effect.fuelLossDicePct ? 1 : 0, rng) * (effect.fuelLossDicePct ?? 0));
      outcome.fuelLost = Math.round(state.fuel * pct) / 100;
      state.fuel = Math.max(0, Math.round((state.fuel - outcome.fuelLost) * 100) / 100);
    }
    criticals.push(outcome);
    const bump = (effect?.hullSeverity ?? 0) + d(effect?.hullSeverityDice ?? 0, rng);
    if (bump > 0 && location !== 'hull') crit('hull', (state.crits.hull ?? 0) + bump);
  };

  if (!hit.noCritical && (hit.effect ?? 0) >= c.effectAtLeast && taken > 0) {
    crit(hit.location ?? rollLocation(rules, rng, applies), (hit.effect ?? 0) - c.severityOffset);
  }
  // Wear and tear: every tenth of the starting Hull lost knocks something loose.
  const threshold = (state.hullMax * c.sustainedPct) / 100;
  if (threshold > 0) {
    let done = Math.floor((state.hullMax - hullBefore) / threshold + 1e-9);
    for (let guard = 0; guard < 20 && Math.floor((state.hullMax - state.hull) / threshold + 1e-9) > done; guard++) {
      done += 1;
      crit(rollLocation(rules, rng, applies), 1, true);
    }
  }
  return { ...state, taken, absorbed, hullLost: hullBefore - state.hull, criticals, wrecked: state.hull <= 0 };
}

// ───────────────────────────── what damage means for performance ─────────────────────────────

function active(rules: SpaceRules, crits: Record<string, number> | undefined, repaired: string[] | undefined, location: string): CriticalEffect | undefined {
  if (!crits || repaired?.includes(location)) return undefined;
  return critEffect(rules, location, crits[location] ?? 0);
}

export function effectiveThrust(rules: SpaceRules, thrust: number, crits?: Record<string, number>, repaired?: string[]): number {
  const e = active(rules, crits, repaired, 'mDrive');
  if (e?.thrustZero) return 0;
  return Math.max(0, thrust - (e?.thrustLoss ?? 0));
}

/** Fraction of its Power the plant still gives. */
export function powerFactor(rules: SpaceRules, crits?: Record<string, number>, repaired?: string[]): number {
  return 1 - Math.min(100, active(rules, crits, repaired, 'powerPlant')?.powerLossPct ?? 0) / 100;
}

export function jumpAvailable(rules: SpaceRules, crits?: Record<string, number>, repaired?: string[]): boolean {
  return !active(rules, crits, repaired, 'jDrive')?.jumpDisabled;
}

export type ShipCondition = 'intact' | 'damaged' | 'crippled' | 'wrecked';

export function conditionOf(ship: { hull?: number; hullMax?: number }): ShipCondition {
  if (ship.hullMax === undefined || ship.hull === undefined || ship.hullMax <= 0) return 'intact';
  if (ship.hull <= 0) return 'wrecked';
  const f = ship.hull / ship.hullMax;
  return f >= 1 ? 'intact' : f >= 0.5 ? 'damaged' : 'crippled';
}

export const CONDITION_LABEL: Record<ShipCondition, string> = { intact: 'Intact', damaged: 'Damaged', crippled: 'Crippled', wrecked: 'Wrecked' };

// ───────────────────────────── ranges and attacks ─────────────────────────────

export function rangeIndex(rules: SpaceRules, id: string | undefined): number {
  return rules.ranges.findIndex((r) => r.id === id);
}

/** The band one step closer (dir -1) or further (dir +1), or the same band at either end. */
export function stepRange(rules: SpaceRules, id: string, dir: -1 | 1): string {
  const i = rangeIndex(rules, id);
  if (i === -1) return id;
  return rules.ranges[Math.max(0, Math.min(rules.ranges.length - 1, i + dir))].id;
}

/** Whether a weapon with this maximum range (a band name) can reach a target at `range`. */
export function inRange(rules: SpaceRules, weaponRange: string | undefined, range: string | undefined): boolean {
  if (!weaponRange || !range) return true;
  const max = rules.ranges.findIndex((r) => r.name.toLowerCase() === weaponRange.toLowerCase() || r.id === weaponRange);
  const at = rangeIndex(rules, range);
  return max === -1 || at === -1 || at <= max;
}

export interface AttackContext {
  range?: string;
  /** Ids of the weapons fired together. */
  weapons?: string[];
  targetTons?: number;
  lock?: boolean;
  pilotFiring?: boolean;
  calledShot?: boolean;
}

/** Modifiers to a gunnery roll that come from the situation rather than the gunner. */
export function attackDm(rules: SpaceRules, ctx: AttackContext): { dm: number; parts: { label: string; dm: number }[] } {
  const parts: { label: string; dm: number }[] = [];
  const band = rules.ranges.find((r) => r.id === ctx.range);
  if (band?.attackDm) parts.push({ label: `${band.name} range`, dm: band.attackDm });
  const weapon = (ctx.weapons ?? []).map((w) => ({ w, dm: rules.attack.weaponDm[w] ?? 0 })).sort((a, b) => b.dm - a.dm)[0];
  if (weapon?.dm) parts.push({ label: weapon.w === 'beam' ? 'Beam laser' : weapon.w === 'pulse' ? 'Pulse laser' : weapon.w, dm: weapon.dm });
  const size = Math.min(rules.attack.targetSizeMaxDm, Math.floor((ctx.targetTons ?? 0) / rules.attack.targetSizeTons));
  if (size > 0) parts.push({ label: 'Large target', dm: size });
  if (ctx.lock) parts.push({ label: 'Sensor lock', dm: rules.attack.sensorLockDm });
  if (ctx.pilotFiring) parts.push({ label: 'Fired from the helm', dm: rules.attack.pilotFiringDm });
  if (ctx.calledShot) parts.push({ label: 'Called shot', dm: rules.attack.calledShotDm });
  return { dm: parts.reduce((n, p) => n + p.dm, 0), parts };
}

/** Rounds before a salvo launched at this range arrives. */
export function missileFlight(rules: SpaceRules, range: string | undefined): number {
  return rules.missiles.flight.find((f) => f.range === range)?.rounds ?? 0;
}

/** Damage bonus for firing several identical weapons from one mount: +1 per damage die for each extra weapon. */
export function linkedBonus(rules: SpaceRules, damage: string, weapons: number): number {
  const dice = Number(/^(\d+)D/i.exec(damage)?.[1] ?? 0);
  return Math.max(0, weapons - 1) * dice * rules.attack.extraWeaponPerDie;
}

// ───────────────────────────── where a location is on the plan ─────────────────────────────

const QUARTERS = new Set(['stateroom', 'highStateroom', 'luxuryStateroom', 'lowBerth', 'cabinSpace', 'accelerationBench']);

/** Ids of the parts of a design that a critical hit location corresponds to ("cargo" for the hold). */
export function partsAt(spec: ShipSpec | undefined, location: string): string[] {
  if (!spec) return [];
  const of = (...kinds: string[]) => spec.parts.filter((p) => kinds.includes(p.kind)).map((p) => p.id);
  switch (location) {
    case 'sensors': {
      const sensors = of('sensors');
      return sensors.length ? sensors : of('bridge');
    }
    case 'powerPlant':
      return of('plant');
    case 'fuel':
      return of('fuel');
    case 'weapon':
      return of('mount');
    case 'armour':
      return of('armour');
    case 'mDrive':
      return of('mdrive');
    case 'jDrive':
      return of('jdrive');
    case 'cargo':
      return ['cargo'];
    case 'crew':
      return spec.parts.filter((p) => p.kind === 'fitting' && QUARTERS.has(p.key ?? '')).map((p) => p.id);
    case 'bridge':
      return of('bridge', 'computer');
    default:
      return [];
  }
}

/** Whether a ship has the thing a critical hit location refers to. */
export function locationApplies(ship: { jump?: number; cargo?: number; spec?: ShipSpec }, location: string): boolean {
  if (location === 'jDrive') return (ship.jump ?? 0) > 0;
  if (location === 'weapon') return ship.spec ? ship.spec.parts.some((p) => p.kind === 'mount') : true;
  if (location === 'cargo') return (ship.cargo ?? 1) > 0;
  return true;
}
