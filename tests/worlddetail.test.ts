/**
 * Worlds in detail: makeup, moons and rings, air, water, days, climate, geology, life and worth.
 * The rules are made up for the tests (fixtures/systemRules.ts and fixtures/detailRules.ts), so
 * nothing depends on a private pack.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formulaError } from '../src/shared/dicex';
import type { WorldRules } from '../src/shared/rulepack';
import { generateSystem, likelyMainworld, type KnownSystem, type SystemLayout, type WorldInfo } from '../src/shared/rules/system';
import { detailSystem } from '../src/shared/rules/worlddetail';
import type { Body, BodyDetail, StarSystem } from '../src/shared/types';
import { seededRng } from '../src/shared/util';
import { testDetailRules } from './fixtures/detailRules';
import { testSystemRules } from './fixtures/systemRules';
import { eventually, setTable, type Table } from './helpers';

const detail = testDetailRules();
const rules = { system: testSystemRules(), detail } as unknown as WorldRules;
const f = (name: string) => Number(detail.f[name]);

function survey(seed: number, known?: KnownSystem): SystemLayout {
  const rng = seededRng(seed);
  const layout = generateSystem(rules.system!, rng, known);
  detailSystem(rules, rng, layout, known);
  return layout;
}
/** Every detailed body of a system: worlds, and the moons large enough to be listed. */
function bodies(layout: SystemLayout): { d: BodyDetail; world: WorldInfo; moon: boolean; size: number }[] {
  const out: { d: BodyDetail; world: WorldInfo; moon: boolean; size: number }[] = [];
  for (const world of layout.worlds) {
    if (world.detail) out.push({ d: world.detail, world, moon: false, size: world.sizeValue });
    for (const moon of world.moons) if (moon.detail) out.push({ d: moon.detail, world, moon: true, size: moon.sizeValue });
  }
  return out;
}

describe('the rules for detailing worlds', () => {
  it('hold formulas and conditions that can be read', () => {
    const problems: string[] = [];
    const check = (where: string, formula: string | number | undefined) => {
      const problem = formula === undefined ? undefined : formulaError(formula);
      if (problem) problems.push(`${where}: ${problem}`);
    };
    for (const [name, formula] of Object.entries(detail.f)) check(name, formula);
    for (const [name, list] of Object.entries(detail.dm)) for (const row of list) (check(name, row.when), check(name, row.times));
    for (const row of [...detail.albedo, ...detail.albedoAdd]) (check('albedo', row.when), check('albedo', row.roll));
    for (const row of detail.greenhouse) (check('greenhouse', row.when), check('greenhouse', row.f), check('greenhouse', row.R));
    expect(problems).toEqual([]);
  });

  it('are not needed: a survey without them is left as it was', () => {
    const rng = seededRng(4);
    const layout = generateSystem(rules.system!, rng);
    detailSystem({ system: rules.system } as WorldRules, rng, layout);
    expect(layout.worlds.every((w) => w.detail === undefined)).toBe(true);
  });
});

describe('worlds in detail', () => {
  const layouts = Array.from({ length: 300 }, (_, i) => survey(i + 1));
  const all = layouts.flatMap((layout) => bodies(layout).map((b) => ({ ...b, layout })));
  const rocky = all.filter((b) => !b.d.belt && !(b.moon ? false : b.world.giant) && b.d.atm);
  const air = (code: number) => detail.atmospheres.find((a) => a.code === code)!;

  it('is the same for the same dice', () => {
    expect(survey(21)).toEqual(survey(21));
    expect(survey(21)).not.toEqual(survey(22));
  });

  it('gives every world a size and, if it is rock, a makeup', () => {
    for (const layout of layouts) for (const world of layout.worlds) expect(world.detail, world.designation).toBeDefined();
    for (const { d, world, moon } of all) {
      if (d.belt) continue;
      expect(d.km).toBeGreaterThan(0);
      expect(d.mass).toBeGreaterThan(0);
      if (!moon && world.giant) {
        expect(d.km).toBe(world.giant.diameter * 12000);
        expect(d.composition).toBeUndefined();
        continue;
      }
      if (!d.composition) continue; // a moon that is a small gas giant
      expect(detail.composition.map((c) => c.name)).toContain(d.composition);
      expect(d.density).toBeGreaterThan(0);
      // the made-up rules: gravity goes with density and width, mass with density and volume
      expect(d.gravity).toBeCloseTo((d.density! * d.km!) / 12000, 1);
      expect(d.mass! / (d.density! * (d.km! / 12000) ** 3)).toBeCloseTo(1, 1);
      expect(d.sah).toMatch(/^[0-9A-HS][0-9A-H][0-9A]$/);
    }
  });

  it('sets moons in order outward, each with its month', () => {
    let seen = 0;
    for (const layout of layouts) {
      for (const world of layout.worlds) {
        const listed = world.moons.filter((m) => m.size !== 'S');
        let last = 0;
        for (const moon of listed) {
          const place = moon.detail?.moon;
          expect(place, `${world.designation}`).toBeDefined();
          expect(place!.pd).toBeGreaterThanOrEqual(f('moon.least'));
          expect(place!.pd).toBeGreaterThan(last);
          expect(place!.km).toBe(Math.round(place!.pd * world.detail!.km!));
          expect(place!.hours).toBeGreaterThan(0);
          last = place!.pd;
          seen++;
        }
        for (const ring of world.detail?.ringSpans ?? []) {
          expect(ring.span).toBeGreaterThan(0);
          expect(ring.centre - ring.span / 2).toBeGreaterThanOrEqual(f('ring.floor') - 0.011);
        }
        expect(world.detail?.ringSpans?.length ?? 0).toBe(world.rings);
      }
    }
    expect(seen).toBeGreaterThan(200);
  });

  it('gives rocky worlds air that fits the tables', () => {
    for (const { d, size } of rocky) {
      const a = d.atm!;
      const def = air(a.code);
      expect(def, `air ${a.code}`).toBeDefined();
      expect(a.name).toBe(def.name);
      if (size < f('atmosphere.fromSize')) expect(a.code).toBe(0);
      if (def.kind === 'air' || def.kind === 'trace') {
        expect(a.bar).toBeGreaterThanOrEqual(def.min!);
        expect(a.bar).toBeLessThanOrEqual(def.min! + def.span! + 0.001);
      }
      if (def.kind === 'air') {
        expect(a.ppo).toBeGreaterThan(0);
        expect(a.ppo!).toBeLessThanOrEqual(a.bar!);
        expect(a.scale).toBeGreaterThan(0);
        // air fit to breathe has oxygen within bounds; tainted air always says what is wrong with it
        if (def.breathable && !def.tainted) expect(a.ppo! >= f('oxygen.low') - 0.001 && a.ppo! <= f('oxygen.high') + 0.001, `ppo ${a.ppo}`).toBe(true);
        if (def.tainted) expect(a.taints!.length).toBeGreaterThan(0);
        expect(a.oxygen).toBe(a.ppo! < f('oxygen.low') ? 'low' : a.ppo! > f('oxygen.high') ? 'high' : undefined);
      }
      if (def.kind === 'exotic' || def.kind === 'corrosive' || def.kind === 'insidious') {
        const list = def.kind === 'exotic' ? detail.subtypes.exotic : detail.subtypes.corrosive;
        const sub = list.find((s) => s.code === a.sub)!;
        expect(sub, `${def.kind} subtype ${a.sub}`).toBeDefined();
        expect(a.subName).toBe(sub.name);
        expect(a.bar).toBeGreaterThan(0);
        if (sub.irritant || sub.attimes) expect(a.taints!.length).toBeGreaterThan(0);
        if (def.kind === 'insidious') {
          expect(a.hazard).toMatch(/^[VHF]{1,2}$/);
          expect(a.hazardName).toBeTruthy();
        } else expect(a.hazard).toBeUndefined();
        expect(a.gases!.length).toBeGreaterThan(0);
        expect(a.gases!.reduce((n, g) => n + g.pct, 0)).toBeLessThanOrEqual(101);
        for (const g of a.gases!) expect(g.gas.endsWith('*')).toBe(false);
      }
      if (def.kind === 'unusual') expect(a.subName).toBeTruthy();
      for (const taint of a.taints ?? []) {
        expect(detail.taints.map((t) => t.code)).toContain(taint.code);
        expect(taint.severity).toBeGreaterThanOrEqual(1);
        expect(taint.persistence).toBeGreaterThanOrEqual(1);
        // too much or too little oxygen is only a taint of air that could otherwise be breathed
        if (taint.code === 'L' || taint.code === 'H') expect(def.breathable).toBe(true);
      }
      expect((a.taints ?? []).length).toBeLessThanOrEqual(3);
    }
  });

  it('takes the air of worlds outside the habitable zone from the table for their distance', () => {
    const hot = new Set<number>();
    const cold = new Set<number>();
    for (const { d, world, size } of rocky) {
      if (size < f('atmosphere.fromSize')) continue;
      if (world.hzDeviation < -1.005) hot.add(d.atm!.code);
      if (world.hzDeviation > 1.005) cold.add(d.atm!.code);
    }
    const codes = (band: number) => new Set(detail.zoneAtmospheres[band].rows.map((r) => r.atm).concat(detail.furnace.flatMap((r) => (r.atm === undefined ? [] : [r.atm]))));
    for (const code of hot) expect([...codes(0)]).toContain(code);
    for (const code of cold) expect([...codes(1)]).toContain(code);
    expect(hot.size).toBeGreaterThan(2);
    expect(cold.size).toBeGreaterThan(2);
  });

  it('gives them water in keeping with their code', () => {
    for (const { d, size } of rocky) {
      const h = d.hydro!;
      const [lo, hi] = detail.hydroRanges[h.code];
      if (size < f('hydro.fromSize')) expect(h).toMatchObject({ code: 0, pct: 0 });
      else if (h.code === 0) expect(h.pct).toBeLessThanOrEqual(hi);
      else expect(h.pct >= lo && h.pct <= hi, `code ${h.code}: ${h.pct}%`).toBe(true);
      if (h.liquid) expect(detail.liquids.map((l) => l.name)).toContain(h.liquid);
    }
  });

  it('gives them days, with a backward turn counted as negative', () => {
    for (const { d, world } of all) {
      if (d.belt) continue;
      const day = d.day!;
      expect(day.tilt).toBeGreaterThanOrEqual(0);
      expect(day.tilt).toBeLessThanOrEqual(180);
      expect(Math.abs(day.hours)).toBeGreaterThan(0);
      expect(day.hours < 0).toBe(day.tilt > 90);
      if (day.lock === 'star') {
        // one face to its sun: the day is the year, and noon never comes round
        expect(Math.abs(day.hours)).toBeCloseTo(world.period * 8766, 0);
        expect(day.solar).toBeUndefined();
      } else if (day.solar !== undefined) expect(day.solar).toBeGreaterThan(0);
      if (day.lock === 'planet') expect(Math.abs(day.hours)).toBeCloseTo(d.moon!.hours, 0);
    }
  });

  it('works out a climate that hangs together', () => {
    for (const { d } of all) {
      if (d.belt) continue;
      const t = d.temp!;
      expect(t.mean).toBeGreaterThan(0);
      expect(t.low!).toBeLessThanOrEqual(t.mean);
      expect(t.high!).toBeGreaterThanOrEqual(t.mean);
      expect(t.albedo).toBeGreaterThanOrEqual(f('albedo.least'));
      expect(t.albedo).toBeLessThanOrEqual(f('albedo.most'));
      expect(t.greenhouse).toBeGreaterThanOrEqual(0);
      if (d.atm?.code === 0) expect(t.greenhouse).toBe(0);
    }
  });

  it('judges the ground, the life and the worth of each', () => {
    for (const { d, layout } of rocky) {
      const s = d.seismic!;
      expect(s.total).toBe(s.residual + s.tidal + s.heating);
      expect(s.activity).toBe(s.total <= 0 ? 'Still' : s.total <= 30 ? 'Stirring' : 'Shaking');
      expect(s.heating).toBeLessThanOrEqual(f('seismic.heatingMost'));
      if (s.plates !== undefined) expect(s.plates).toBeGreaterThan(1);
      if (d.life) {
        expect(layout.age).toBeGreaterThan(f('life.minimumAge'));
        expect(d.life.biomass).toBeGreaterThanOrEqual(1);
        expect(d.life.complexity).toBeGreaterThanOrEqual(1);
        expect(d.life.diversity).toBeGreaterThanOrEqual(1);
        expect(d.life.compatibility).toBeGreaterThanOrEqual(0);
        if (d.life.sophonts) expect(d.life.complexity).toBeGreaterThanOrEqual(f('sophonts.from'));
      }
      expect(d.resources).toBeGreaterThanOrEqual(1);
      expect(d.resources).toBeLessThanOrEqual(10);
      expect(d.habitability).toBeGreaterThanOrEqual(0);
      expect(d.habitability).toBeLessThanOrEqual(9);
    }
  });

  it('describes belts by what they hold', () => {
    const belts = all.filter((b) => b.d.belt);
    expect(belts.length).toBeGreaterThan(50);
    for (const { d } of belts) {
      const b = d.belt!;
      expect(b.m + b.s + b.c + b.other).toBe(100);
      expect(b.span).toBeGreaterThan(0);
      expect(b.bulk).toBeGreaterThanOrEqual(1);
      expect(b.resources).toBeGreaterThanOrEqual(f('belt.resources.least'));
      expect(b.resources).toBeLessThanOrEqual(f('belt.resources.most'));
      expect(b.size1).toBeGreaterThanOrEqual(0);
      expect(b.sizeS).toBeGreaterThanOrEqual(0);
      expect(d.resources).toBe(b.resources);
    }
  });

  it('turns out every sort of world', () => {
    const count = (test: (d: BodyDetail) => boolean) => all.filter((b) => test(b.d)).length;
    for (const kind of ['none', 'trace', 'air', 'exotic', 'corrosive', 'insidious']) expect(count((d) => !!d.atm && air(d.atm.code).kind === kind), kind).toBeGreaterThan(5);
    expect(count((d) => d.day?.lock === 'star')).toBeGreaterThan(5);
    expect(count((d) => d.day?.lock === 'planet')).toBeGreaterThan(20);
    expect(count((d) => !!d.day && !d.day.lock)).toBeGreaterThan(100);
    expect(count((d) => !!d.life)).toBeGreaterThan(10);
    expect(count((d) => !!d.atm?.taints?.length)).toBeGreaterThan(10);
    expect(count((d) => !!d.atm?.runaway)).toBeGreaterThan(0);
    expect(count((d) => !!d.hydro?.liquid)).toBeGreaterThan(0);
    expect(count((d) => !!d.ringSpans?.length)).toBeGreaterThan(5);
    expect(count((d) => (d.seismic?.plates ?? 0) > 1)).toBeGreaterThan(5);
    expect(count((d) => (d.tide ?? 0) > 0)).toBeGreaterThan(100);
  });
});

describe('a listed mainworld in detail', () => {
  const known: KnownSystem = { stars: ['K0 V'], gasGiants: 1, belts: 1, mainworld: { size: 6, atm: 3, hydro: 7, temperature: 'temperate' } };

  it('keeps the size, air and water its listing gives', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const main = survey(seed, known).worlds.find((w) => w.mainworld)!;
      const d = main.detail!;
      expect(d.sah).toBe('637');
      expect(d.atm).toMatchObject({ code: 3, name: 'Fair' });
      expect(d.atm!.runaway).toBeUndefined();
      expect(d.hydro!.code).toBe(7);
      expect(d.hydro!.pct).toBeGreaterThanOrEqual(65);
      expect(d.hydro!.pct).toBeLessThanOrEqual(74);
      expect(d.km).toBeGreaterThanOrEqual(6 * 1500 - 700);
      expect(d.km).toBeLessThan(7 * 1500 - 700);
      // somewhere to live: the air is fit to breathe, and the place is always looked over for life
      expect(d.habitability).toBeGreaterThan(0);
    }
  });

  it('is a belt in detail when its size says so, the poorer for industry', () => {
    const plain: KnownSystem = { stars: ['K0 V'], gasGiants: 1, belts: 0, mainworld: { size: 0, atm: 0, hydro: 0 } };
    const worked: KnownSystem = { ...plain, mainworld: { ...plain.mainworld!, tl: 9, industrial: true } };
    let poorer = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const a = survey(seed, plain).worlds.find((w) => w.mainworld)!.detail!;
      const b = survey(seed, worked).worlds.find((w) => w.mainworld)!.detail!;
      expect(a.belt).toBeDefined();
      expect(a.atm).toBeUndefined();
      expect(b.belt!.resources).toBeLessThanOrEqual(a.belt!.resources);
      if (b.belt!.resources < a.belt!.resources) poorer++;
    }
    expect(poorer).toBeGreaterThan(20);
  });

  it('is chosen, where none is listed, as the world easiest to live on', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const layout = survey(seed);
      const pick = likelyMainworld(layout);
      const rocks = layout.worlds.filter((w) => w.kind === 'terrestrial');
      if (!rocks.length) continue;
      expect(pick!.kind).toBe('terrestrial');
      for (const other of rocks) expect(pick!.detail!.habitability!).toBeGreaterThanOrEqual(other.detail!.habitability!);
    }
  });
});

/** The survey run on a table, with the made-up rules served as a pack. */
describe('a detailed survey on the map, world by world', () => {
  let table: Table;
  let ann: Awaited<ReturnType<Table['join']>>;
  let packDir: string;
  let home: string;

  beforeAll(async () => {
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traveller-ui-detail-'));
    fs.mkdirSync(path.join(packDir, 'test-worlds'));
    fs.writeFileSync(path.join(packDir, 'test-worlds', 'pack.json'), JSON.stringify({ id: 'test-worlds', name: 'Test worlds', version: '1' }));
    fs.writeFileSync(path.join(packDir, 'test-worlds', 'world.json'), JSON.stringify({ system: rules.system, detail }));
    table = await setTable({ rulepackDir: packDir });
    ann = await table.join('Ann');
    const sectorId = (await table.gm.act('sector.create', { name: 'Survey', x: 0, y: 0 })).id;
    home = (await table.gm.act('system.create', { sectorId, hex: '0101', name: 'Home', uwp: 'B637755-9', pbg: '312', stars: 'K0 V' })).id;
    await eventually(() => expect(table.gm.all('body').some((b: Body) => b.systemId === home && b.mainworld)).toBe(true));
  });
  afterAll(async () => {
    await table.close();
    fs.rmSync(packDir, { recursive: true, force: true });
  });

  it('records each world and moon in detail', async () => {
    await table.gm.act('reveal.preset', { ids: [home], preset: 'charted', audience: 'party' });
    await table.gm.act('system.detail', { id: home, seed: 5 });
    await eventually(() => expect(table.gm.get<StarSystem>(home)!.survey).toBeDefined());
    const all = table.gm.all('body').filter((b: Body) => b.systemId === home);
    const main = all.find((b) => b.mainworld)!;
    expect(main.data!.detail).toMatchObject({ sah: '637', atm: { code: 3 }, hydro: { code: 7 } });
    expect(main.data!.detail!.temp!.mean).toBeGreaterThan(0);
    for (const body of all.filter((b) => b.origin === 'survey' && b.kind !== 'star')) expect(body.data!.detail, body.name).toBeDefined();
    for (const belt of all.filter((b) => b.kind === 'belt')) expect(belt.data!.detail!.belt).toBeDefined();
    for (const moon of all.filter((b) => b.kind === 'moon')) expect(moon.data!.detail!.moon!.pd).toBeGreaterThan(0);
    // the players are shown the detail of what they may see, with the rest of the survey figures
    await eventually(() => expect(ann.client.get<Body>(main.id)!.data!.detail!.sah).toBe('637'));
    // and the same seed gives the same worlds
    const before = JSON.stringify(all.map((b) => b.data).sort());
    await table.gm.act('system.detail', { id: home, seed: 5 });
    await eventually(() => expect(JSON.stringify(table.gm.all('body').filter((b: Body) => b.systemId === home).map((b) => b.data).sort())).toBe(before));
  });
});
