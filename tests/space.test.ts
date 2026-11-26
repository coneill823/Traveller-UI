import { describe, expect, it } from 'vitest';
import type { RulePack } from '../src/shared/rulepack';
import { specFromStock } from '../src/shared/rules/ship';
import { attackDm, conditionOf, effectiveThrust, inRange, jumpAvailable, linkedBonus, missileFlight, partsAt, powerFactor, resolveHit, rollLocation, stepRange, type ShipState } from '../src/shared/rules/space';
import { seededRng } from '../src/shared/util';
import { HAS_CORE_RULES, loadCorePack } from './helpers';

describe.skipIf(!HAS_CORE_RULES)('space combat rules from the core pack', () => {
  const pack = HAS_CORE_RULES ? loadCorePack() : ({ packs: [] } as RulePack);
  const rules = pack.space!;
  const trader = (): ShipState => ({ hull: 80, hullMax: 80, armour: 2, fuel: 41, crits: {} });
  /** Dice that always come up the same face. */
  const always = (face: number) => () => (face - 0.5) / 6;

  it('takes armour off a hit and the rest off the hull', () => {
    const out = resolveHit(rules, trader(), { damage: 7, effect: 2 }, { rng: always(3) });
    expect(out).toMatchObject({ taken: 5, absorbed: 2, hull: 75, hullLost: 5, wrecked: false });
    expect(out.criticals).toEqual([]);
    // Armour can stop a hit outright; nothing then gets through to cause a critical.
    const bounced = resolveHit(rules, trader(), { damage: 2, effect: 7 }, { rng: always(3) });
    expect(bounced).toMatchObject({ taken: 0, absorbed: 2, hull: 80 });
    expect(bounced.criticals).toEqual([]);
    // A particle barbette's damage is tripled once armour has been taken off.
    expect(resolveHit(rules, trader(), { damage: 10, multiplier: 3, noCritical: true }, { rng: always(1) }).taken).toBe(24);
  });

  it('scores a critical on Effect 6 or more, at Severity Effect minus 5', () => {
    // 2D of 4 + 4 = 8: the manoeuvre drive.
    const out = resolveHit(rules, trader(), { damage: 5, effect: 7 }, { rng: always(4) });
    expect(out.criticals).toHaveLength(1);
    expect(out.criticals[0]).toMatchObject({ location: 'mDrive', name: 'Manoeuvre drive', severity: 2 });
    expect(out.crits).toEqual({ mDrive: 2 });
    expect(effectiveThrust(rules, 2, out.crits)).toBe(1);
    expect(effectiveThrust(rules, 2, { mDrive: 5 })).toBe(0);
    expect(effectiveThrust(rules, 2, { mDrive: 5 }, ['mDrive'])).toBe(2);
    // A called shot picks its location.
    const called = resolveHit(rules, trader(), { damage: 5, effect: 6, location: 'jDrive' }, { rng: always(4) });
    expect(called.criticals[0]).toMatchObject({ location: 'jDrive', severity: 1 });
    expect(jumpAvailable(rules, called.crits)).toBe(true);
    expect(jumpAvailable(rules, { jDrive: 2 })).toBe(false);
  });

  it('makes a second critical on the same location worse', () => {
    const hurt = { ...trader(), crits: { sensors: 3 } };
    const out = resolveHit(rules, hurt, { damage: 5, effect: 6, location: 'sensors' }, { rng: always(4) });
    expect(out.crits.sensors).toBe(4);
    // Past Severity 6 the location cannot get worse: the hull takes 6D instead.
    const wrecked = resolveHit(rules, { ...trader(), crits: { sensors: 6 } }, { damage: 5, effect: 6, location: 'sensors' }, { rng: always(2) });
    expect(wrecked.crits.sensors).toBe(6);
    expect(wrecked.criticals[0]).toMatchObject({ overflow: true, extraDamage: 12 });
    expect(wrecked.hull).toBe(80 - 3 - 12);
  });

  it('applies what critical hits do to hull, armour, fuel and power', () => {
    // Hull, Severity 2: 2D more damage, past the armour.
    const hull = resolveHit(rules, trader(), { damage: 3, effect: 7, location: 'hull' }, { rng: always(5) });
    expect(hull.criticals[0]).toMatchObject({ location: 'hull', severity: 2, extraDamage: 10 });
    expect(hull.hull).toBe(80 - 1 - 10);
    // Armour, Severity 3: 1D off the armour, but it cannot go below zero.
    const armour = resolveHit(rules, trader(), { damage: 3, effect: 8, location: 'armour' }, { rng: always(5) });
    expect(armour).toMatchObject({ armour: 0 });
    expect(armour.criticals[0].armourLost).toBe(2);
    // Fuel, Severity 4: the tank is gone.
    const fuel = resolveHit(rules, trader(), { damage: 3, effect: 9, location: 'fuel' }, { rng: always(5) });
    expect(fuel.fuel).toBe(0);
    expect(fuel.criticals[0].fuelLost).toBe(41);
    // Power plant, Severity 5: no power, and the hull location gets worse by one.
    const plant = resolveHit(rules, trader(), { damage: 3, effect: 10, location: 'powerPlant' }, { rng: always(1) });
    expect(plant.crits).toMatchObject({ powerPlant: 5, hull: 1 });
    expect(plant.criticals.map((c) => c.location)).toEqual(['powerPlant', 'hull']);
    expect(powerFactor(rules, plant.crits)).toBe(0);
    expect(powerFactor(rules, { powerPlant: 2 })).toBe(0.8);
  });

  it('adds a Severity 1 critical for every tenth of the hull lost', () => {
    // 80 Hull: every 8 points. 20 through armour crosses two thresholds.
    const out = resolveHit(rules, trader(), { damage: 22, effect: 0 }, { rng: seededRng(7) });
    expect(out.taken).toBe(20);
    const sustained = out.criticals.filter((c) => c.sustained);
    expect(sustained.length).toBeGreaterThanOrEqual(2);
    expect(sustained.every((c) => c.severity >= 1)).toBe(true);
    // Damage already taken counts: 5 lost before, 4 more crosses the first threshold.
    const second = resolveHit(rules, { ...trader(), hull: 75 }, { damage: 6, effect: 0 }, { rng: seededRng(3) });
    expect(second.criticals.filter((c) => c.sustained)).toHaveLength(second.hullLost >= 11 ? 2 : 1);
    const wrecked = resolveHit(rules, { ...trader(), hull: 4 }, { damage: 40, effect: 0 }, { rng: seededRng(1) });
    expect(wrecked).toMatchObject({ hull: 0, wrecked: true });
    expect(conditionOf(wrecked)).toBe('wrecked');
    expect(conditionOf({ hull: 80, hullMax: 80 })).toBe('intact');
    expect(conditionOf({ hull: 41, hullMax: 80 })).toBe('damaged');
    expect(conditionOf({ hull: 30, hullMax: 80 })).toBe('crippled');
  });

  it('rerolls locations a ship does not have', () => {
    for (let seed = 1; seed < 40; seed++) expect(rollLocation(rules, seededRng(seed), (l) => l !== 'jDrive' && l !== 'weapon')).not.toMatch(/jDrive|weapon/);
    // 2D of 1 + 1 = 2 is always Sensors.
    expect(rollLocation(rules, always(1))).toBe('sensors');
    expect(rollLocation(rules, always(6))).toBe('bridge');
  });

  it('works out gunnery modifiers and ranges', () => {
    expect(attackDm(rules, { range: 'short', weapons: ['beam'] })).toMatchObject({ dm: 5 });
    expect(attackDm(rules, { range: 'long', weapons: ['pulse', 'pulse'], targetTons: 2400, lock: true }).dm).toBe(-2 + 2 + 2 + 2);
    expect(attackDm(rules, { range: 'distant', weapons: ['missile'], targetTons: 90000 }).dm).toBe(-6 + 6);
    expect(attackDm(rules, { range: 'medium', pilotFiring: true, calledShot: true }).dm).toBe(-4);
    expect(inRange(rules, 'Medium', 'long')).toBe(false);
    expect(inRange(rules, 'Long', 'long')).toBe(true);
    expect(inRange(rules, 'Special', 'distant')).toBe(true);
    expect(stepRange(rules, 'medium', -1)).toBe('short');
    expect(stepRange(rules, 'distant', 1)).toBe('distant');
    expect(missileFlight(rules, 'medium')).toBe(0);
    expect(missileFlight(rules, 'veryLong')).toBe(4);
    // Three pulse lasers fired together: 2D, +1 per die for each of the two extra.
    expect(linkedBonus(rules, '2D', 3)).toBe(4);
    expect(linkedBonus(rules, '4D', 1)).toBe(0);
  });

  it('finds the parts of a design that a location refers to', () => {
    const spec = specFromStock(pack.ships!.designs.find((d) => d.id === 'farTrader')!);
    const kindsAt = (loc: string) => partsAt(spec, loc).map((id) => spec.parts.find((p) => p.id === id)?.kind ?? id);
    expect(kindsAt('mDrive')).toEqual(['mdrive']);
    expect(kindsAt('powerPlant')).toEqual(['plant']);
    expect(kindsAt('bridge')).toEqual(['bridge', 'computer']);
    expect(kindsAt('cargo')).toEqual(['cargo']);
    expect(kindsAt('crew')).toEqual(['fitting', 'fitting']);
    expect(kindsAt('weapon')).toEqual([]);
    expect(kindsAt('hull')).toEqual([]);
  });
});
