/**
 * The system rules of the world builder pack, where it is installed: that the engine can read
 * everything in it and that what it builds hangs together. The checks are about structure; none of
 * the pack's figures are repeated here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formulaError } from '../src/shared/dicex';
import type { DetailRules, RulePack, SystemRules } from '../src/shared/rulepack';
import { auToOrbit, generateSystem, orbitToAu, parseStar, type SystemLayout } from '../src/shared/rules/system';
import { generateWorld } from '../src/shared/rules/world';
import { detailSystem } from '../src/shared/rules/worlddetail';
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

  describe('each world in detail', () => {
    const detail = pack.world?.detail as DetailRules;

    it('has formulas and conditions the engine can read', () => {
      const problems: string[] = [];
      const check = (where: string, formula: string | number | undefined) => {
        const problem = formula === undefined ? undefined : formulaError(formula);
        if (problem) problems.push(`${where}: ${problem}`);
      };
      for (const [name, formula] of Object.entries(detail.f)) check(name, formula);
      for (const [name, list] of Object.entries(detail.dm)) for (const row of list) (check(name, row.when), check(name, row.times));
      for (const row of [...detail.albedo, ...detail.albedoAdd]) (check('albedo', row.when), check('albedo', row.roll));
      for (const row of detail.albedo) check('albedo', row.then);
      for (const row of detail.greenhouse) (check('greenhouse', row.when), check('greenhouse', row.f), check('greenhouse', row.R));
      for (const t of detail.gasMix) for (const row of t.dm) (check('gas mix', row.when), check('gas mix', row.times));
      for (const row of detail.unusual) (check('unusual', row.when), check('unusual', row.bar));
      for (const row of detail.moonOrbit) check('moon orbit', row.pd);
      for (const row of [...detail.tilt, ...detail.extremeTilt]) check('tilt', row.roll);
      for (const row of detail.tidalLock) check('tidal lock', row.days);
      for (const row of [...detail.subtypes.exotic, ...detail.subtypes.corrosive]) check('subtype', row.bar);
      for (const row of detail.beltComposition) (check('belt', row.m), check('belt', row.s), check('belt', row.c));
      for (const row of detail.atmospheres) check('taint', row.taintOn);
      expect(problems).toEqual([]);
    });

    it('has tables of the shape the engine expects', () => {
      // air: every code from none upward, and every result of the zone tables names one of them
      detail.atmospheres.forEach((a, i) => expect(a.code).toBe(i));
      const kinds = new Set(detail.atmospheres.map((a) => a.kind));
      for (const kind of ['none', 'trace', 'air', 'exotic', 'corrosive', 'insidious', 'unusual', 'gas']) expect(kinds).toContain(kind);
      for (const a of detail.atmospheres.filter((x) => x.kind === 'air' || x.kind === 'trace')) expect(a.span, a.name).toBeGreaterThan(0);
      const lengths = new Set(detail.zoneAtmospheres.map((b) => b.rows.length));
      expect(lengths.size).toBe(1);
      for (const band of detail.zoneAtmospheres) {
        for (const row of band.rows) {
          expect(detail.atmospheres[row.atm], `air ${row.atm}`).toBeDefined();
          // exotic air given outright has a subtype waiting for it, with and without an irritant as the dice may ask
          if (row.density) {
            const wants = row.irritant === 'maybe' ? [true, false] : [row.irritant === 'yes'];
            for (const irritant of wants) expect(detail.subtypes.exotic.find((s) => s.density === row.density && !!s.irritant === irritant && !s.attimes), `${row.density} ${irritant}`).toBeDefined();
          }
        }
      }
      for (const row of detail.furnace) if (row.atm !== undefined) expect(detail.atmospheres[row.atm]).toBeDefined();
      for (const row of detail.greenhouseCodes) expect(detail.atmospheres[row.atm]).toBeDefined();
      // taints: the stand-ins they name exist, and the worst sits at the end of each scale
      const codes = detail.taints.map((t) => t.code);
      for (const t of detail.taints) {
        if (t.otherwise) expect(codes).toContain(t.otherwise);
        if (t.coldAs) expect(codes).toContain(t.coldAs);
      }
      expect(new Set(detail.taints.filter((t) => t.oxygen).map((t) => t.oxygen))).toEqual(new Set(['low', 'high']));
      for (const list of [detail.severity, detail.persistence]) for (let i = 1; i < list.length; i++) expect(list[i].code).toBeGreaterThan(list[i - 1].code);
      // makeup: a density for every roll of two dice
      for (const made of detail.composition) expect(detail.density[made.id], made.id).toHaveLength(11);
      for (const column of Object.values(detail.density)) for (let i = 1; i < column.length; i++) expect(column[i]).toBeGreaterThan(column[i - 1]);
      for (const key of Object.values(detail.beltDensity)) expect(detail.density[key]).toBeDefined();
      // water: a band for each code, end to end
      expect(detail.hydroRanges).toHaveLength(11);
      for (let i = 1; i < detail.hydroRanges.length; i++) expect(detail.hydroRanges[i][0]).toBe(detail.hydroRanges[i - 1][1] + 1);
      // gas mixes: hottest first, with a last table for everything colder; liquids melt before they boil
      for (let i = 1; i < detail.gasMix.length - 1; i++) expect(detail.gasMix[i].above!).toBeLessThan(detail.gasMix[i - 1].above!);
      expect(detail.gasMix[detail.gasMix.length - 1].above).toBeUndefined();
      for (const liquid of detail.liquids) expect(liquid.boil, liquid.name).toBeGreaterThan(liquid.melt);
      // tides: the table ends in a full lock, with a lesser one before it
      expect(detail.tidalLock.filter((r) => r.lock)).toHaveLength(2);
      expect(detail.tidalLock[detail.tidalLock.length - 1].lock).toBeTruthy();
    });

    it('details whole systems without a figure out of place', () => {
      const problems: string[] = [];
      const seen = new Set<string>();
      for (let seed = 1; seed <= 600; seed++) {
        const known = seed % 3 === 0 ? { stars: ['G5 V'], gasGiants: 2, belts: 1, mainworld: { size: 7, atm: 6, hydro: 6, temperature: 'temperate' as const } } : undefined;
        const rng = seededRng(seed);
        const layout = generateSystem(rules, rng, known);
        detailSystem(pack.world!, rng, layout, known);
        for (const world of layout.worlds) {
          expect(world.detail, `seed ${seed} ${world.designation}`).toBeDefined();
          if (world.mainworld && known) expect(world.detail!.sah).toBe('766');
          for (const d of [world.detail!, ...world.moons.flatMap((m) => (m.detail ? [m.detail] : []))]) {
            const say = (text: string) => problems.push(`seed ${seed} ${world.designation}: ${text}`);
            if (d.belt) {
              if (d.belt.m + d.belt.s + d.belt.c + d.belt.other !== 100) say('belt shares');
              continue;
            }
            for (const [name, value] of Object.entries({ km: d.km, gravity: d.gravity, mass: d.mass, bar: d.atm?.bar, ppo: d.atm?.ppo, pct: d.hydro?.pct, day: d.day?.hours, tilt: d.day?.tilt, mean: d.temp?.mean, high: d.temp?.high, low: d.temp?.low, stress: d.seismic?.total, resources: d.resources, habitability: d.habitability }))
              if (value !== undefined && !Number.isFinite(value)) say(`${name} is ${value}`);
            if (d.temp && (d.temp.low! > d.temp.mean || d.temp.high! < d.temp.mean)) say('temperatures out of order');
            if (d.atm?.ppo !== undefined && d.atm.ppo > (d.atm.bar ?? 0)) say('more oxygen than air');
            if (d.hydro && (d.hydro.pct < 0 || d.hydro.pct > 100)) say('water share');
            if (d.day && (d.day.tilt < 0 || d.day.tilt > 180)) say('tilt');
            if (d.atm) seen.add(detail.atmospheres[d.atm.code].kind);
            if (d.life) seen.add('life');
            if (d.day?.lock) seen.add(`lock ${d.day.lock}`);
          }
        }
      }
      expect(problems).toEqual([]);
      for (const kind of ['none', 'trace', 'air', 'exotic', 'corrosive', 'insidious', 'unusual', 'gas', 'life', 'lock star', 'lock planet']) expect(seen, kind).toContain(kind);
    });
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
        // each world in detail, the mainworld as its profile has it
        expect(main[0].data?.detail?.sah).toBe(before.uwp!.slice(1, 4));
        for (const body of bodies.filter((b) => b.origin === 'survey' && b.kind !== 'star')) expect(body.data?.detail, body.name).toBeDefined();
        // the listing's count of worlds is kept
        if (before.ext?.worlds) expect(res.worlds).toBe(Number(before.ext.worlds));
      }
    });
  });
});
