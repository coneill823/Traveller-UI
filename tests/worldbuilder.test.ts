/**
 * The system rules of the world builder pack, where it is installed: that the engine can read
 * everything in it and that what it builds hangs together. The checks are about structure; none of
 * the pack's figures are repeated here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formulaError } from '../src/shared/dicex';
import type { RulePack, SystemRules } from '../src/shared/rulepack';
import { auToOrbit, generateSystem, orbitToAu, parseStar, type SystemLayout } from '../src/shared/rules/system';
import { generateWorld } from '../src/shared/rules/world';
import type { Body, StarSystem } from '../src/shared/types';
import { seededRng } from '../src/shared/util';
import { splitStars } from '../src/server/actions/map';
import { eventually, HAS_CORE_RULES, hasPack, loadPacks, setTable, type Table } from './helpers';

const HAS_PACK = HAS_CORE_RULES && hasPack('mgt2-worldbuilder');

describe.skipIf(!HAS_PACK)('star systems with the world builder pack', () => {
  const pack = HAS_PACK ? loadPacks('mgt2-core', 'mgt2-worldbuilder') : ({ packs: [] } as RulePack);
  const rules = (pack.world?.system ?? {}) as SystemRules;
  const SPECTRAL = 'OBAFGKM';

  it('adds to the core world rules without replacing them', () => {
    const core = loadPacks('mgt2-core').world!;
    expect(pack.world!.generation).toEqual(core.generation);
    expect(pack.world!.tradeCodes).toEqual(core.tradeCodes);
    expect(pack.world!.system).toBeDefined();
  });

  it('holds formulas and conditions the engine can read', () => {
    const problems: string[] = [];
    const check = (where: string, formula: string | number | undefined) => {
      const problem = formula === undefined ? undefined : formulaError(formula);
      if (problem) problems.push(`${where}: ${problem}`);
    };
    for (const [name, formula] of Object.entries(rules.f)) check(name, formula);
    for (const [name, list] of Object.entries(rules.dm)) for (const row of list) (check(name, row.when), check(name, row.times));
    for (const row of rules.eccentricity) check('eccentricity', row.value);
    for (const row of rules.sizes.terrestrial) check('terrestrial size', row.roll);
    for (const row of rules.sizes.gasGiant) (check('giant diameter', row.diameter), check('giant mass', row.mass), check('heavy giant', row.heavy));
    for (const row of rules.sizes.moonCount) check('moons', row.roll);
    for (const row of [...rules.sizes.moon, ...rules.sizes.giantMoon]) check('moon size', row.roll);
    expect(problems).toEqual([]);
  });

  it('holds tables of the shape the engine expects', () => {
    // orbit numbers run outward
    for (let i = 1; i < rules.orbits.length; i++) expect(rules.orbits[i]).toBeGreaterThan(rules.orbits[i - 1]);
    for (let orbit = 0.1; orbit < rules.orbits.length - 1; orbit += 0.43) expect(auToOrbit(rules, orbitToAu(rules, orbit))).toBeCloseTo(orbit, 6);
    // every column answers a roll of two dice
    const t = rules.starTables;
    for (const column of [...Object.values(t.types), t.subtype.numeric, t.subtype.mPrimary, ...Object.values(rules.nonPrimary)]) expect(column).toHaveLength(11);
    for (const list of Object.values(rules.knownPlaces)) expect(list).toHaveLength(6);
    // star tables: a figure for each class at each type listed, hotter types first
    for (const table of [t.mass, t.diameter, t.mao]) {
      expect(table.length).toBeGreaterThan(SPECTRAL.length);
      for (const row of table) {
        expect(row.type).toMatch(/^[OBAFGKM]\d$/);
        expect(row.v).toHaveLength(rules.classes.length);
      }
      // a dwarf of every type is listed
      const dwarf = rules.classes.indexOf('V');
      for (const letter of SPECTRAL) expect(table.find((r) => r.type === `${letter}0`)!.v[dwarf], `${letter}0`).toBeGreaterThan(0);
    }
    for (let i = 1; i < t.temperature.length; i++) expect(t.temperature[i].k).toBeLessThan(t.temperature[i - 1].k);
    for (let i = 1; i < t.whiteDwarfCooling.length; i++) {
      expect(t.whiteDwarfCooling[i].gyr).toBeGreaterThan(t.whiteDwarfCooling[i - 1].gyr);
      expect(t.whiteDwarfCooling[i].k).toBeLessThan(t.whiteDwarfCooling[i - 1].k);
    }
    // rows chosen by a roll end with a catch-all
    for (const rows of [rules.eccentricity, rules.anomalies, rules.sizes.gasGiant, ...Object.values(rules.quantities)]) {
      for (let i = 1; i < rows.length; i++) expect(rows[i].max).toBeGreaterThan(rows[i - 1].max);
      expect(rows[rows.length - 1].max).toBeGreaterThanOrEqual(12);
    }
    // climates run from the coldest to the hottest, with a row for the middle of the zone
    for (let i = 1; i < rules.zones.length; i++) {
      expect(rules.zones[i].raw).toBeGreaterThan(rules.zones[i - 1].raw);
      expect(rules.zones[i].deviation).toBeLessThan(rules.zones[i - 1].deviation);
    }
    expect(rules.zones.some((z) => z.deviation === 0)).toBe(true);
    // every moon count applies to worlds of some size, and both kinds of world are covered
    expect(rules.sizes.moonCount.some((r) => r.sizes?.length)).toBe(true);
    for (const giant of rules.sizes.gasGiant) expect(rules.sizes.moonCount.find((r) => r.code === giant.code), giant.code).toBeDefined();
  });

  const inRanges = (ranges: [number, number][], orbit: number) => ranges.some(([a, b]) => orbit >= a - 0.011 && orbit <= b + 0.011);
  const problemsOf = (layout: SystemLayout, seed: number): string[] => {
    const out: string[] = [];
    const say = (text: string) => out.push(`seed ${seed}: ${text}`);
    if (!(layout.age > 0)) say(`age ${layout.age}`);
    if (layout.stars[0].role !== 'primary') say('no primary');
    for (const star of layout.stars) {
      if (!(star.mass > 0) || !(star.diameter > 0) || !Number.isFinite(star.luminosity)) say(`figures of ${star.label}`);
      const above = star.role === 'companion' ? layout.stars[star.parent!] : star.role === 'primary' ? undefined : layout.stars[0];
      if (above && star.kind === 'star' && above.kind === 'star' && star.mass > above.mass) say(`${star.label} outweighs ${above.label}`);
      if (star.role !== 'primary' && !(star.orbit! > 0 && star.period! > 0)) say(`orbit of ${star.label}`);
    }
    const regular = layout.worlds.filter((w) => !w.anomaly);
    regular.forEach((world, i) => {
      if (!inRanges(layout.groups[world.group].ranges, world.orbit)) say(`${world.designation} at ${world.orbit} is on no stable orbit`);
      const before = regular[i - 1];
      if (before && before.group === world.group && world.orbit <= before.orbit) say(`${world.designation} is not beyond ${before.designation}`);
    });
    for (const world of layout.worlds) {
      if (!(world.orbit > 0 && world.au > 0 && world.period > 0)) say(`orbit of ${world.designation}`);
      if (world.ecc < 0 || world.ecc >= 1) say(`eccentricity of ${world.designation}`);
      for (const moon of world.moons) if (moon.sizeValue > world.sizeValue) say(`a moon of ${world.designation} is larger than it`);
    }
    if (layout.worlds.length) {
      const count = (kind: string) => layout.worlds.filter((w) => w.kind === kind).length;
      if (count('gasGiant') !== layout.gasGiants || count('belt') !== layout.belts || count('terrestrial') !== layout.terrestrials) say('counts do not match the worlds placed');
    }
    return out;
  };

  it('builds systems that hang together, whatever the dice', () => {
    const problems: string[] = [];
    const primaries = new Set<string>();
    let several = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const layout = generateSystem(rules, seededRng(seed), undefined, { unusualPrimaries: seed % 3 === 0 });
      problems.push(...problemsOf(layout, seed));
      primaries.add(layout.stars[0].kind === 'star' ? layout.stars[0].spectral! : layout.stars[0].kind);
      if (layout.stars.length > 1) several++;
    }
    expect(problems).toEqual([]);
    expect(primaries.size).toBeGreaterThan(4);
    expect(several).toBeGreaterThan(300);
    expect(several).toBeLessThan(1200);
  });

  it('builds a system around what a listing says of it', () => {
    const problems: string[] = [];
    let temperate = 0;
    const seeds = 300;
    for (let seed = 1; seed <= seeds; seed++) {
      const known = { stars: ['G2 V', 'M4 V'], gasGiants: 3, belts: 1, worlds: 11, mainworld: { size: 8, atm: 6, temperature: 'temperate' as const } };
      const layout = generateSystem(rules, seededRng(seed), known);
      problems.push(...problemsOf(layout, seed));
      expect(layout.stars.map((s) => s.label)).toEqual(['G2 V', 'M4 V']);
      expect([layout.gasGiants, layout.belts, layout.terrestrials]).toEqual([3, 1, 7]);
      const main = layout.worlds.filter((w) => w.mainworld);
      expect(main).toHaveLength(1);
      expect(main[0]).toMatchObject({ kind: 'terrestrial', sizeValue: 8 });
      if (Math.abs(main[0].hzDeviation) <= 0.2) temperate++;
    }
    expect(problems).toEqual([]);
    // nearly always: the other star is arranged again when it would crowd the mainworld out
    expect(temperate).toBeGreaterThan(seeds * 0.95);
  });

  it('gives new worlds on the map stars and counts from the same tables', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const world = generateWorld(pack.world!, seededRng(seed));
      const stars = splitStars(world.stars);
      expect(stars.length).toBeGreaterThan(0);
      for (const star of stars) expect(parseStar(star), star).toBeDefined();
      // a mainworld needs a living star to circle
      expect(parseStar(stars[0])!.kind).toBe('star');
      const giants = Number(world.pbg[2]);
      const belts = Number(world.pbg[1]);
      expect(world.worlds).toBeGreaterThanOrEqual(Math.min(9, giants) + Math.min(9, belts) + 1);
    }
  });

  describe('on a table', () => {
    let table: Table;
    let sectorId: string;

    beforeAll(async () => {
      table = await setTable({}, {}, ['mgt2-worldbuilder']);
      sectorId = (await table.gm.act('sector.create', { name: 'Deep Survey', x: 0, y: 0 })).id;
    });
    afterAll(async () => {
      await table.close();
    });

    it('surveys the systems of a generated subsector', async () => {
      const made = await table.gm.act('map.generate', { sectorId, subsector: 'A', seed: 11 });
      expect(made.systemIds.length).toBeGreaterThan(5);
      await eventually(() => expect(table.gm.all('system')).toHaveLength(made.systemIds.length));
      for (const id of made.systemIds.slice(0, 12) as string[]) {
        const before = table.gm.get<StarSystem>(id)!;
        const mainId = table.gm.all('body').find((b: Body) => b.systemId === id && b.mainworld)!.id;
        const res = await table.gm.act('system.detail', { id, seed: 3 });
        await eventually(() => expect(table.gm.get<StarSystem>(id)!.survey).toBeDefined());
        const system = table.gm.get<StarSystem>(id)!;
        // the listing stands; the survey fills in around it
        expect(system).toMatchObject({ uwp: before.uwp, pbg: before.pbg, stars: before.stars });
        const bodies = table.gm.all('body').filter((b: Body) => b.systemId === id);
        expect(bodies.filter((b) => b.kind === 'star').map((b) => b.subtype).sort()).toEqual(splitStars(before.stars).sort());
        expect(bodies.filter((b) => b.kind !== 'star' && !b.parentId)).toHaveLength(res.worlds);
        expect(bodies.filter((b) => b.kind === 'gasGiant' && !b.parentId)).toHaveLength(Number(before.pbg![2]));
        const main = bodies.filter((b) => b.mainworld);
        expect(main).toHaveLength(1);
        expect(main[0].id).toBe(mainId);
        expect(main[0].data?.orbitNo).toBeGreaterThan(0);
        // the listing's count of worlds is kept
        if (before.ext?.worlds) expect(res.worlds).toBe(Number(before.ext.worlds));
      }
    });
  });
});
