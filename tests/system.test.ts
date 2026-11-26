/**
 * Star systems in detail: the formula reader the rules packs use, and the procedure that builds
 * stars, orbits, worlds and moons from a pack's tables. The rules here are made up for the tests
 * (see fixtures/systemRules.ts), so nothing depends on a private pack.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, formulaError } from '../src/shared/dicex';
import { auToOrbit, generateSystem, habitableZone, likelyMainworld, orbitToAu, parseStar, rollListing, starsLabel, type KnownSystem, type SystemLayout } from '../src/shared/rules/system';
import type { Body, StarSystem } from '../src/shared/types';
import { seededRng } from '../src/shared/util';
import { splitStars } from '../src/server/actions/map';
import { testSystemRules } from './fixtures/systemRules';
import { eventually, setTable, type Table } from './helpers';

const rules = testSystemRules();
/** Every die shows a one. */
const low = () => 0;
/** Every die shows its highest face. */
const high = () => 0.999;

describe('formulas with dice', () => {
  it('rolls dice of any size', () => {
    expect(evaluate('2D-7', low)).toBe(-5);
    expect(evaluate('2D-7', high)).toBe(5);
    expect(evaluate('D3+D3', high)).toBe(6);
    expect(evaluate('d10/10', high)).toBe(1);
    expect(evaluate('3D6', high)).toBe(18);
    expect(evaluate('D', high)).toBe(6);
    expect(evaluate('5 x (1D+1)', low)).toBe(10);
    expect(evaluate('5 × (1D+1)', high)).toBe(35);
    expect(evaluate(7, high)).toBe(7);
  });

  it('rolls afresh each time it is asked', () => {
    const seen = new Set<number>();
    const rng = seededRng(5);
    for (let i = 0; i < 200; i++) seen.add(evaluate('2D', rng));
    expect([...seen].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('reads names, powers and functions', () => {
    expect(evaluate('BASE + (2D-7)/20', low, { BASE: 3 })).toBeCloseTo(2.75);
    expect(evaluate('DIA^2 x (T / 6000)^4', low, { DIA: 2, T: 12000 })).toBe(64);
    expect(evaluate('2^3^2', low)).toBe(512);
    expect(evaluate('-2^2', low)).toBe(-4);
    expect(evaluate('2 + 3 * 4 - 6 / 3', low)).toBe(12);
    expect(evaluate('max(1, N) + min(4, 9) + floor(2.7) + ceil(2.1) + round(2.5) + abs(0 - 3)', low, { N: 0 })).toBe(16);
    expect(evaluate('sqrt(L) + pow(2, 3) + ln(1)', low, { L: 16 })).toBe(12);
    expect(evaluate('age.small + 1', low, { 'age.small': 2 })).toBe(3);
  });

  it('answers a condition with 1 or 0', () => {
    expect(evaluate('worlds < 4 and stars > 1', low, { worlds: 3, stars: 2 })).toBe(1);
    expect(evaluate('worlds < 4 and stars > 1', low, { worlds: 3, stars: 1 })).toBe(0);
    expect(evaluate('worlds >= 6 or not bh', low, { worlds: 5, bh: 0 })).toBe(1);
    expect(evaluate('worlds >= 6 or not bh', low, { worlds: 5, bh: 1 })).toBe(0);
    expect(evaluate('type == 6', low, { type: 6 })).toBe(1);
    expect(evaluate('type != 6', low, { type: 6 })).toBe(0);
    expect(evaluate('2D + DM >= 9', high, { DM: -3 })).toBe(1);
    expect(evaluate('2D + DM >= 9', high, { DM: -4 })).toBe(0);
  });

  it('says what is wrong with a formula it cannot read', () => {
    expect(formulaError('2D + 1')).toBeUndefined();
    expect(formulaError(4)).toBeUndefined();
    expect(formulaError('2 +')).toMatch(/missing/);
    expect(formulaError('(2 + 3')).toMatch(/bracket/);
    expect(formulaError('2 $ 3')).toMatch(/Cannot read/);
    expect(formulaError('wobble(2)')).toMatch(/not a function/);
    expect(formulaError('2 3')).toMatch(/out of place/);
    expect(() => evaluate('N + 1', low)).toThrow(/needs a value for N/);
  });

  it('can read every formula and condition of the test rules', () => {
    const problems: string[] = [];
    const check = (where: string, formula: string | number | undefined) => {
      const problem = formula === undefined ? undefined : formulaError(formula);
      if (problem) problems.push(`${where}: ${problem}`);
    };
    for (const [name, formula] of Object.entries(rules.f)) check(name, formula);
    for (const [name, list] of Object.entries(rules.dm)) for (const row of list) (check(name, row.when), check(name, row.times));
    for (const row of rules.eccentricity) check('eccentricity', row.value);
    expect(problems).toEqual([]);
  });
});

describe('orbits and zones', () => {
  it('turns orbit numbers into distances and back', () => {
    expect(orbitToAu(rules, 0)).toBe(0);
    expect(orbitToAu(rules, 1)).toBeCloseTo(0.3);
    expect(orbitToAu(rules, 1.5)).toBeCloseTo(0.375);
    expect(orbitToAu(rules, 0.5)).toBeCloseTo(0.15);
    for (let orbit = 0.05; orbit < 21; orbit += 0.37) expect(auToOrbit(rules, orbitToAu(rules, orbit))).toBeCloseTo(orbit, 6);
  });

  it('says how far a world is from the middle of the habitable zone', () => {
    expect(habitableZone(rules, 3, 3)).toEqual({ deviation: 0, zone: 'Temperate' });
    expect(habitableZone(rules, 5, 3)).toEqual({ deviation: 2, zone: 'Frozen' });
    expect(habitableZone(rules, 1.5, 3)).toEqual({ deviation: -1.5, zone: 'Boiling' });
    expect(habitableZone(rules, 3.5, 3).zone).toBe('Cold');
    expect(habitableZone(rules, 2.5, 3).zone).toBe('Hot');
    // inside the first orbit distances count against the smaller of the two figures
    expect(habitableZone(rules, 0.8, 0.4)).toEqual({ deviation: 1, zone: 'Frozen' });
    expect(habitableZone(rules, 0.4, 0.4)).toEqual({ deviation: 0, zone: 'Temperate' });
  });

  it('reads the stars of a listing', () => {
    expect(parseStar('G2 V')).toEqual({ kind: 'star', spectral: 'G', subtype: 2, cls: 'V' });
    expect(parseStar('M5III')).toEqual({ kind: 'star', spectral: 'M', subtype: 5, cls: 'III' });
    expect(parseStar('K VI')).toEqual({ kind: 'star', spectral: 'K', subtype: undefined, cls: 'VI' });
    expect(parseStar('F7')).toMatchObject({ spectral: 'F', subtype: 7, cls: 'V' });
    expect(parseStar('D')).toEqual({ kind: 'D' });
    expect(parseStar('DA')).toEqual({ kind: 'D' });
    expect(parseStar('M2 D')).toEqual({ kind: 'D' });
    expect(parseStar('BD')).toEqual({ kind: 'BD' });
    expect(parseStar('L4')).toEqual({ kind: 'BD' });
    expect(parseStar('NS')).toEqual({ kind: 'NS' });
    expect(parseStar('PSR')).toEqual({ kind: 'PSR' });
    expect(parseStar('BH')).toEqual({ kind: 'BH' });
    expect(parseStar('a red sun')).toBeUndefined();
  });
});

const inRanges = (ranges: [number, number][], orbit: number) => ranges.some(([a, b]) => orbit >= a - 0.011 && orbit <= b + 0.011);
const kinds = (layout: SystemLayout) => ({
  gasGiant: layout.worlds.filter((w) => w.kind === 'gasGiant').length,
  belt: layout.worlds.filter((w) => w.kind === 'belt').length,
  terrestrial: layout.worlds.filter((w) => w.kind === 'terrestrial').length,
});

describe('a system from the dice alone', () => {
  const layouts = Array.from({ length: 400 }, (_, i) => generateSystem(rules, seededRng(i + 1)));
  const unusual = Array.from({ length: 200 }, (_, i) => generateSystem(rules, seededRng(i + 1000), undefined, { unusualPrimaries: true }));
  const all = [...layouts, ...unusual];

  it('is the same system for the same dice', () => {
    expect(generateSystem(rules, seededRng(42))).toEqual(generateSystem(rules, seededRng(42)));
    expect(generateSystem(rules, seededRng(42))).not.toEqual(generateSystem(rules, seededRng(43)));
  });

  it('names its stars and puts each companion after the star it circles', () => {
    for (const layout of all) {
      expect(layout.stars.length).toBeGreaterThan(0);
      expect(layout.stars[0].role).toBe('primary');
      const names = layout.stars.map((s) => s.designation);
      expect(new Set(names).size).toBe(names.length);
      expect(names[0]).toMatch(/^Aa?$/);
      layout.stars.forEach((star, i) => {
        expect(star.designation).toMatch(/^[A-D][ab]?$/);
        if (star.role === 'companion') {
          expect(star.parent).toBe(i - 1);
          expect(star.designation).toBe(`${layout.stars[i - 1].designation[0]}b`);
          expect(layout.stars[i - 1].designation).toMatch(/a$/);
        }
        if (i > 0) {
          expect(star.orbit).toBeGreaterThan(0);
          expect(star.au).toBeGreaterThan(0);
          expect(star.period).toBeGreaterThan(0);
          expect(star.ecc).toBeGreaterThanOrEqual(0);
          expect(star.ecc).toBeLessThan(1);
        }
      });
      // at most one star in each of the close, near and far places, further out each time
      const others = layout.stars.filter((s) => s.role !== 'primary' && s.role !== 'companion');
      expect(new Set(others.map((s) => s.role)).size).toBe(others.length);
      for (let i = 1; i < others.length; i++) expect(others[i].orbit!).toBeGreaterThan(others[i - 1].orbit!);
    }
  });

  it('gives every star figures that hang together', () => {
    for (const layout of all) {
      expect(layout.age).toBeGreaterThan(0);
      expect(layout.age).toBeLessThanOrEqual(Number(rules.f.universe));
      for (const star of layout.stars) {
        expect(star.mass).toBeGreaterThan(0);
        expect(star.diameter).toBeGreaterThan(0);
        expect(Number.isFinite(star.luminosity)).toBe(true);
        if (star.kind === 'star') {
          expect(star.label).toBe(`${star.spectral}${star.subtype} ${star.cls}`);
          // the made-up rule: light goes with the square of the size and the fourth power of the heat
          // (the figures shown are rounded, so only nearly)
          expect(star.luminosity / (star.diameter ** 2 * (star.temperature / 6000) ** 4)).toBeCloseTo(1, 1);
        } else expect(star.label).toBe(star.kind);
        // a lesser star never outweighs the one it answers to
        const above = star.role === 'companion' ? layout.stars[star.parent!] : star.role === 'primary' ? undefined : layout.stars[0];
        if (above && star.kind === 'star' && above.kind === 'star') expect(star.mass).toBeLessThanOrEqual(above.mass);
      }
    }
  });

  it('keeps every world on an orbit that is open to it, in order outward', () => {
    for (const layout of all) {
      for (const group of layout.groups) {
        expect(Number.isFinite(group.hzco)).toBe(true);
        for (const [from, to] of group.ranges) expect(to).toBeGreaterThan(from);
      }
      const regular = layout.worlds.filter((w) => !w.anomaly);
      regular.forEach((world, i) => {
        expect(inRanges(layout.groups[world.group].ranges, world.orbit), `${world.designation} at ${world.orbit}`).toBe(true);
        const before = regular[i - 1];
        if (before && before.group === world.group) expect(world.orbit).toBeGreaterThan(before.orbit);
      });
      for (const world of layout.worlds) {
        expect(world.orbit).toBeGreaterThan(0);
        expect(world.au).toBeGreaterThan(0);
        expect(world.period).toBeGreaterThan(0);
        expect(world.ecc).toBeGreaterThanOrEqual(0);
        expect(world.ecc).toBeLessThan(1);
        expect(world.zone).toMatch(/^(Frozen|Cold|Temperate|Hot|Boiling)$/);
        expect(world.around.startsWith(layout.groups[world.group].key[0])).toBe(true);
      }
    }
  });

  it('places as many worlds of each kind as it counted', () => {
    for (const layout of all) {
      if (layout.worlds.length === 0) {
        // nothing to place, or nowhere to place it: the referee is told which
        if (layout.gasGiants + layout.belts + layout.terrestrials > 0) expect(layout.notes.join(' ')).toMatch(/no stable orbit/);
        continue;
      }
      expect(kinds(layout)).toEqual({ gasGiant: layout.gasGiants, belt: layout.belts, terrestrial: layout.terrestrials });
      expect(layout.profile.startsWith(`${layout.gasGiants}-${layout.belts}-`)).toBe(true);
      expect(layout.worlds.some((w) => w.mainworld)).toBe(false);
      const names = layout.worlds.map((w) => w.designation);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('sizes worlds and moons sensibly', () => {
    for (const layout of all) {
      for (const world of layout.worlds) {
        if (world.kind === 'belt') {
          expect(world.size).toBe('0');
          expect(world.moons).toEqual([]);
          expect(world.designation).toMatch(/P[IVX]+$/);
          continue;
        }
        if (world.kind === 'gasGiant') {
          expect(world.giant).toBeDefined();
          expect(world.size).toMatch(/^G[SL][0-9A-Z]$/);
        } else {
          expect(world.giant).toBeUndefined();
          expect(world.sizeValue).toBeGreaterThanOrEqual(1);
          expect(world.sizeValue).toBeLessThanOrEqual(12);
        }
        for (const moon of world.moons) {
          expect(moon.sizeValue).toBeLessThanOrEqual(world.sizeValue);
          // a gas giant for a moon is always a smaller one than its planet
          if (moon.giant) expect(moon.giant.diameter).toBeLessThan(world.giant!.diameter);
        }
        expect(world.rings).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('can say which world would make the best mainworld', () => {
    for (const layout of all) {
      const pick = likelyMainworld(layout);
      const rocky = layout.worlds.filter((w) => w.kind === 'terrestrial');
      if (rocky.length) {
        expect(pick!.kind).toBe('terrestrial');
        for (const other of rocky) expect(Math.abs(pick!.hzDeviation)).toBeLessThanOrEqual(Math.abs(other.hzDeviation));
      } else if (layout.belts && layout.worlds.length) expect(pick!.kind).toBe('belt');
      else expect(pick).toBeUndefined();
    }
  });

  it('turns out all sorts of systems', () => {
    const count = (test: (layout: SystemLayout) => boolean) => all.filter(test).length;
    expect(count((l) => l.stars.length === 1)).toBeGreaterThan(50);
    expect(count((l) => l.stars.length > 1)).toBeGreaterThan(50);
    expect(count((l) => l.stars.some((s) => s.role === 'companion'))).toBeGreaterThan(10);
    expect(count((l) => l.gasGiants > 0)).toBeGreaterThan(100);
    expect(count((l) => l.gasGiants === 0)).toBeGreaterThan(20);
    expect(count((l) => l.belts > 0)).toBeGreaterThan(50);
    expect(count((l) => l.worlds.some((w) => w.moons.length > 0))).toBeGreaterThan(100);
    expect(count((l) => l.worlds.some((w) => w.rings > 0))).toBeGreaterThan(50);
    expect(count((l) => l.worlds.some((w) => w.anomaly))).toBeGreaterThan(5);
    expect(count((l) => l.groups.length > 1 && l.worlds.some((w) => w.group > 0))).toBeGreaterThan(10);
    expect(new Set(all.map((l) => l.stars[0].spectral)).size).toBeGreaterThan(3);
    // dead and failed stars lead a system only when the referee allows unusual primaries
    expect(layouts.every((l) => l.stars[0].kind === 'star')).toBe(true);
    expect(unusual.some((l) => l.stars[0].kind !== 'star')).toBe(true);
  });
});

describe('a system built around its listing', () => {
  const build = (known: KnownSystem, seeds = 80) => Array.from({ length: seeds }, (_, i) => generateSystem(rules, seededRng(i + 1), known));

  it('keeps the stars, the counts and the mainworld the listing gives', () => {
    for (const layout of build({ stars: ['G2 V', 'M5 V'], gasGiants: 2, belts: 1, worlds: 9, mainworld: { size: 6, atm: 6 } })) {
      expect(starsLabel(layout.stars)).toBe('G2 V M5 V');
      expect([layout.gasGiants, layout.belts, layout.terrestrials]).toEqual([2, 1, 6]);
      if (layout.worlds.length === 0) continue;
      expect(kinds(layout)).toEqual({ gasGiant: 2, belt: 1, terrestrial: 6 });
      const main = layout.worlds.filter((w) => w.mainworld);
      expect(main).toHaveLength(1);
      expect(main[0]).toMatchObject({ kind: 'terrestrial', size: '6', sizeValue: 6, group: 0 });
    }
  });

  it('finds a place for every star of a crowded listing', () => {
    for (const layout of build({ stars: ['F5 V', 'K2 V', 'M0 V', 'D', 'BD'], gasGiants: 1, belts: 0, mainworld: { size: 8, atm: 6 } }, 40)) {
      expect(layout.stars.map((s) => s.label).sort()).toEqual(['BD', 'D', 'F5 V', 'K2 V', 'M0 V']);
      expect(layout.stars[0].label).toBe('F5 V');
      expect(layout.gasGiants).toBe(1);
    }
  });

  it('puts a mainworld with air to breathe where its climate is found', () => {
    const zoneOf = (layout: SystemLayout) => layout.worlds.find((w) => w.mainworld)!.zone;
    for (const layout of build({ stars: ['K0 V'], gasGiants: 1, belts: 1, mainworld: { size: 7, atm: 6, temperature: 'temperate' } }, 40)) {
      expect(zoneOf(layout)).toBe('Temperate');
      expect(Math.abs(layout.worlds.find((w) => w.mainworld)!.hzDeviation)).toBeLessThan(0.1);
    }
    for (const layout of build({ stars: ['K0 V'], gasGiants: 1, belts: 1, mainworld: { size: 7, atm: 6, temperature: 'cold' } }, 40)) expect(zoneOf(layout)).toBe('Cold');
    for (const layout of build({ stars: ['K0 V'], gasGiants: 1, belts: 1, mainworld: { size: 7, atm: 6, temperature: 'hot' } }, 40)) expect(zoneOf(layout)).toBe('Hot');
    // with no climate given, air to breathe means a temperate world
    for (const layout of build({ stars: ['K0 V'], gasGiants: 0, belts: 0, mainworld: { size: 5, atm: 5 } }, 40)) expect(zoneOf(layout)).toBe('Temperate');
  });

  it('arranges the other stars so that a habitable mainworld keeps its orbit', () => {
    const made = build({ stars: ['G2 V', 'K5 V', 'M5 V'], gasGiants: 2, belts: 1, mainworld: { size: 6, atm: 6, temperature: 'temperate' } }, 120);
    const temperate = made.filter((l) => l.worlds.find((w) => w.mainworld)?.zone === 'Temperate').length;
    expect(temperate).toBeGreaterThan(110);
  });

  it('sends a frozen mainworld far out and a boiling one close in', () => {
    const deviations = (temperature: 'frozen' | 'boiling') => build({ stars: ['K0 V'], gasGiants: 2, belts: 1, worlds: 10, mainworld: { size: 4, atm: 1, temperature } }, 60).map((l) => l.worlds.find((w) => w.mainworld)!.hzDeviation);
    expect(deviations('frozen').filter((d) => d >= 1).length).toBeGreaterThan(50);
    expect(deviations('boiling').filter((d) => d <= -1).length).toBeGreaterThan(50);
  });

  it('makes the mainworld a belt when its size says so', () => {
    for (const layout of build({ stars: ['M2 V'], gasGiants: 1, belts: 0, mainworld: { size: 0, atm: 0 } }, 40)) {
      // a listing does not count a mainworld belt among the belts
      expect(layout.belts).toBe(1);
      const main = layout.worlds.filter((w) => w.mainworld);
      expect(main).toHaveLength(1);
      expect(main[0]).toMatchObject({ kind: 'belt', size: '0', moons: [] });
      expect(kinds(layout)).toMatchObject({ gasGiant: 1, belt: 1 });
    }
  });

  it('rolls what a new listing says of a system', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const listing = rollListing(rules, seededRng(seed), { size: 5, atm: 6 });
      const stars = splitStars(listing.stars);
      expect(stars.length).toBeGreaterThan(0);
      for (const star of stars) expect(parseStar(star), star).toBeDefined();
      expect(listing.worlds).toBeGreaterThanOrEqual(listing.gasGiants + listing.belts + 1);
      // and a survey built around the listing agrees with it
      const layout = generateSystem(rules, seededRng(seed + 5000), { stars, gasGiants: listing.gasGiants, belts: listing.belts, worlds: listing.worlds, mainworld: { size: 5, atm: 6 } });
      expect(layout.stars.map((s) => s.label).sort()).toEqual([...stars].sort());
      expect([layout.gasGiants, layout.belts]).toEqual([listing.gasGiants, listing.belts]);
      if (layout.worlds.length) expect(layout.worlds).toHaveLength(listing.worlds);
    }
    const belt = rollListing(rules, seededRng(9), { size: 0, atm: 0 });
    expect(belt.worlds).toBeGreaterThanOrEqual(belt.gasGiants + belt.belts + 1);
  });
});

/** The survey run on a table, with the made-up rules served as a pack. */
describe('a detailed survey on the map', () => {
  let table: Table;
  let ann: Awaited<ReturnType<Table['join']>>;
  let packDir: string;
  let sectorId: string;
  let home: string;
  let mainId: string;
  const bodies = (client = table.gm) => client.all('body').filter((b: Body) => b.systemId === home);
  const count = (list: Body[], kind: Body['kind']) => list.filter((b) => b.kind === kind && !b.parentId).length;

  beforeAll(async () => {
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traveller-ui-system-'));
    fs.mkdirSync(path.join(packDir, 'test-system'));
    fs.writeFileSync(path.join(packDir, 'test-system', 'pack.json'), JSON.stringify({ id: 'test-system', name: 'Test systems', version: '1' }));
    fs.writeFileSync(path.join(packDir, 'test-system', 'world.json'), JSON.stringify({ system: rules }));
    table = await setTable({ rulepackDir: packDir });
    ann = await table.join('Ann');
    sectorId = (await table.gm.act('sector.create', { name: 'Survey', x: 0, y: 0 })).id;
    home = (await table.gm.act('system.create', { sectorId, hex: '0101', name: 'Home', uwp: 'B766755-9', pbg: '312', stars: 'K0 V M5 V' })).id;
    await eventually(() => expect(bodies().find((b) => b.mainworld)).toBeDefined());
    mainId = bodies().find((b) => b.mainworld)!.id;
  });
  afterAll(async () => {
    await table.close();
    fs.rmSync(packDir, { recursive: true, force: true });
  });

  it('replaces the chart with the whole system, keeping the mainworld and what was added by hand', async () => {
    // the chart: two stars, the mainworld, two giants and a belt
    expect(bodies()).toHaveLength(6);
    const giant = bodies().find((b) => b.kind === 'gasGiant')!;
    const port = (await table.gm.act('body.create', { systemId: home, parentId: mainId, kind: 'poi', name: 'Downport' })).id;
    const depot = (await table.gm.act('body.create', { systemId: home, parentId: giant.id, kind: 'station', name: 'Fuel depot' })).id;
    await table.gm.act('reveal.preset', { ids: [home], preset: 'charted', audience: 'party' });
    await eventually(() => expect(bodies(ann.client)).toHaveLength(6));

    await expect(ann.client.act('system.detail', { id: home })).rejects.toThrow(/Only the GM/);
    const res = await table.gm.act('system.detail', { id: home, seed: 7 });
    expect(res).toMatchObject({ seed: 7, stars: 2 });
    expect(res.worlds).toBeGreaterThanOrEqual(4);
    await eventually(() => expect(table.gm.get<StarSystem>(home)!.survey).toBeDefined());

    const system = table.gm.get<StarSystem>(home)!;
    expect(system.survey!.age).toBeGreaterThan(0);
    expect(system.survey!.profile).toMatch(/^2-1-/);
    // the listing is left as it was
    expect(system).toMatchObject({ uwp: 'B766755-9', pbg: '312', stars: 'K0 V M5 V' });

    const now = bodies();
    const stars = now.filter((b) => b.kind === 'star');
    expect(stars.map((b) => b.subtype)).toEqual(['K0 V', 'M5 V']);
    expect(stars[0].data).toMatchObject({ designation: expect.stringMatching(/^Aa?$/), role: 'primary' });
    expect(stars[0].data!.solarMass).toBeGreaterThan(0);
    expect(stars[1].data!.au).toBeGreaterThan(0);
    expect(count(now, 'gasGiant')).toBe(2);
    expect(count(now, 'belt')).toBe(1);
    expect(count(now, 'planet') + count(now, 'gasGiant') + count(now, 'belt')).toBe(res.worlds);
    expect(now.filter((b) => b.kind === 'moon' && b.origin === 'survey')).toHaveLength(res.moons - now.reduce((n, b) => n + (b.data?.smallMoons ?? 0), 0));
    for (const body of now.filter((b) => b.origin === 'survey' && b.kind !== 'star' && !b.parentId)) {
      expect(body.data).toMatchObject({ designation: expect.any(String), orbitNo: expect.any(Number), au: expect.any(Number), zone: expect.any(String) });
      expect(body.name).toBeDefined();
    }
    // every moon hangs off a world of the survey
    for (const moon of now.filter((b) => b.kind === 'moon')) expect(now.find((b) => b.id === moon.parentId)).toBeDefined();

    // the mainworld is the same record, now with its place in the system
    const main = table.gm.get<Body>(mainId)!;
    expect(main).toMatchObject({ mainworld: true, name: 'Home', kind: 'planet' });
    expect(main.data).toMatchObject({ size: '7', zone: 'Temperate' });
    expect(now.filter((b) => b.mainworld)).toHaveLength(1);
    // what stood on it is still there; what stood on a body that is gone belongs to the system at large
    expect(table.gm.get<Body>(port)).toMatchObject({ parentId: mainId, name: 'Downport' });
    expect(table.gm.get<Body>(depot)).toMatchObject({ name: 'Fuel depot' });
    expect(table.gm.get<Body>(depot)!.parentId).toBeUndefined();
  });

  it('shows the players what the chart showed them, and the rest when it is shared', async () => {
    const shown = () => bodies(ann.client);
    // the stars, the mainworld, the giants and the belt were on the chart; the other worlds and moons were not
    await eventually(() => expect(shown().map((b) => b.kind).sort()).toEqual(['belt', 'gasGiant', 'gasGiant', 'planet', 'star', 'star']));
    expect(shown().find((b) => b.kind === 'planet')!.id).toBe(mainId);
    expect(shown().find((b) => b.kind === 'gasGiant')!.data!.au).toBeGreaterThan(0);
    expect(ann.client.get<StarSystem>(home)!.survey).toBeDefined();
    expect((ann.client.get<StarSystem>(home) as StarSystem & { gm?: unknown }).gm).toBeUndefined();

    // charting the system again does not give the rest away
    await table.gm.act('reveal.preset', { ids: [home], preset: 'charted', audience: 'party' });
    const hidden = bodies().filter((b) => b.origin === 'survey' && !b.known?.exists?.includes('party'));
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((b) => b.kind === 'planet' || b.kind === 'moon')).toBe(true);
    expect(shown()).toHaveLength(6);

    await table.gm.act('reveal.preset', { ids: hidden.map((b) => b.id), preset: 'charted', audience: 'party' });
    await eventually(() => expect(shown()).toHaveLength(bodies().filter((b) => b.origin === 'survey').length));
  });

  it('gives the same system for the same seed, and another for another', async () => {
    const picture = () =>
      bodies()
        .filter((b) => b.origin === 'survey')
        .map((b) => `${b.kind} ${b.data?.designation} ${b.data?.orbitNo ?? ''} ${b.data?.size ?? ''}`)
        .sort();
    const first = picture();
    await table.gm.act('system.detail', { id: home, seed: 7 });
    await eventually(() => expect(picture()).toEqual(first));
    expect(table.gm.get<Body>(mainId)).toMatchObject({ mainworld: true, name: 'Home' });
    await table.gm.act('system.detail', { id: home, seed: 8 });
    await eventually(() => expect(picture()).not.toEqual(first));
    expect(table.gm.get<Body>(mainId)).toMatchObject({ mainworld: true, name: 'Home' });
    // the players keep what they knew of the stars, giants and belts through each new survey
    await eventually(() => expect(bodies(ann.client).filter((b) => b.kind === 'star')).toHaveLength(2));
    expect(bodies(ann.client).filter((b) => b.kind === 'gasGiant')).toHaveLength(2);
  });

  it('goes back to the plain chart when asked', async () => {
    await table.gm.act('system.rebuildBodies', { id: home });
    await eventually(() => expect(table.gm.get<StarSystem>(home)!.survey).toBeUndefined());
    const survey = bodies().filter((b) => b.origin === 'survey');
    expect(survey).toHaveLength(6);
    expect(survey.every((b) => b.data === undefined)).toBe(true);
  });

  it('fills in the stars and the giants of a system that has no listing', async () => {
    const blank = (await table.gm.act('system.create', { sectorId, hex: '0202', name: 'Blank' })).id;
    let res = { worlds: 0 };
    // some systems have no worlds at all: take the first seed that gives some
    for (let seed = 1; seed < 20 && res.worlds === 0; seed++) res = await table.gm.act('system.detail', { id: blank, seed });
    expect(res.worlds).toBeGreaterThan(0);
    await eventually(() => expect(table.gm.get<StarSystem>(blank)!.survey).toBeDefined());
    const system = table.gm.get<StarSystem>(blank)!;
    expect(splitStars(system.stars).length).toBeGreaterThan(0);
    expect(system.pbg).toMatch(/^0\d\d$/);
    const made = table.gm.all('body').filter((b: Body) => b.systemId === blank);
    expect(made.filter((b) => b.kind === 'star')).toHaveLength(splitStars(system.stars).length);
    expect(made.filter((b) => b.kind !== 'star' && b.kind !== 'moon')).toHaveLength(res.worlds);
    // the likeliest world of the survey stands as the mainworld, under the system's name
    const main = made.filter((b) => b.mainworld);
    expect(main).toHaveLength(1);
    expect(main[0]).toMatchObject({ name: 'Blank', data: { designation: expect.any(String), zone: expect.any(String) } });
  });
});
