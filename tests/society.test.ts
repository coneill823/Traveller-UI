/**
 * The people of a world in depth, and the lesser settlements of its system. The rules are made up
 * for the tests (fixtures/societyRules.ts and the two beside it), so nothing depends on a private
 * pack.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formulaError } from '../src/shared/dicex';
import type { WorldRules } from '../src/shared/rulepack';
import { settleSystem, societyOf, type SocietyInput } from '../src/shared/rules/society';
import { generateSystem } from '../src/shared/rules/system';
import { detailSystem } from '../src/shared/rules/worlddetail';
import type { Body, Society, StarSystem } from '../src/shared/types';
import { seededRng } from '../src/shared/util';
import { testDetailRules } from './fixtures/detailRules';
import { testSocietyRules } from './fixtures/societyRules';
import { testSystemRules } from './fixtures/systemRules';
import { eventually, setTable, type Table } from './helpers';

const society = testSocietyRules();
const rules = { system: testSystemRules(), detail: testDetailRules(), society } as unknown as WorldRules;
const f = (name: string) => Number(society.f[name]);

const world = (over: Partial<SocietyInput> = {}): SocietyInput => ({ port: 'B', size: 6, atm: 3, hyd: 6, pop: 7, gov: 4, law: 5, tl: 9, codes: [], bases: 1, belts: 1, giants: 2, habitability: 7, resources: 6, ...over });
const many = (over: Partial<SocietyInput> = {}, count = 200): Society[] => Array.from({ length: count }, (_, i) => societyOf(rules, seededRng(i + 1), world(over))!);

describe('the rules for the people of a world', () => {
  it('hold formulas and conditions that can be read', () => {
    const problems: string[] = [];
    const check = (where: string, formula: string | number | undefined) => {
      const problem = formula === undefined ? undefined : formulaError(formula);
      if (problem) problems.push(`${where}: ${problem}`);
    };
    for (const [name, formula] of Object.entries(society.f)) check(name, formula);
    for (const [name, list] of Object.entries(society.dm)) for (const row of list) (check(name, row.when), check(name, row.times));
    for (const row of society.urbanisation) check('urbanisation', row.pct);
    for (const row of society.urbanLimits) (check('limit', row.when), check('limit', row.least), check('limit', row.most));
    for (const row of [...society.structureRules, ...society.uniformityRules]) (check('rule', row.when), check('rule', row.roll));
    for (const row of society.tech) (check(row.id, row.from), check(row.id, row.least), check(row.id, row.most), check(row.id, row.zeroWhen));
    for (const row of society.classes) (check(row.code, row.when), check(row.code, row.on));
    for (const row of society.tariffs) check('tariff', row.rate);
    for (const row of society.traffic) check('traffic', row.daily);
    for (const row of society.captiveLaw) check('captive law', row.f);
    expect(problems).toEqual([]);
  });

  it('give nothing for a world with nobody on it, or where they are not installed', () => {
    expect(societyOf(rules, seededRng(1), world({ pop: 0 }))).toBeUndefined();
    expect(societyOf({ system: rules.system } as WorldRules, seededRng(1), world())).toBeUndefined();
  });
});

describe('the people of a world', () => {
  it('are the same for the same dice', () => {
    expect(societyOf(rules, seededRng(9), world())).toEqual(societyOf(rules, seededRng(9), world()));
    expect(societyOf(rules, seededRng(9), world())).not.toEqual(societyOf(rules, seededRng(10), world()));
  });

  it('number what the profile says, gathered and housed in keeping with it', () => {
    for (const pop of [1, 3, 5, 7, 9, 10]) {
      for (const s of many({ pop }, 80)) {
        const p = s.people!;
        expect(p.total).toBeGreaterThanOrEqual(10 ** pop);
        expect(p.total).toBeLessThan(10 ** (pop + 1));
        expect(String(p.total)[0]).toBe(String(p.digit));
        expect(p.pcr).toBeGreaterThanOrEqual(0);
        expect(p.pcr).toBeLessThanOrEqual(4);
        expect(p.pcrName).toBe(society.concentration[p.pcr].name);
        expect(p.urban).toBeGreaterThanOrEqual(0);
        expect(p.urban).toBeLessThanOrEqual(100);
        expect(p.urbanPeople).toBeLessThanOrEqual(p.total);
        expect(p.cityPeople).toBeLessThanOrEqual(p.urbanPeople);
        if (p.pcr === 0) expect(p).toMatchObject({ cities: 0, cityPeople: 0 });
        else expect(p.cities).toBeGreaterThanOrEqual(1);
        // small populations cannot have more cities than their size allows
        if (pop < f('cities.smallBelow')) expect(p.cities).toBeLessThanOrEqual(pop);
        if (p.cities >= 1) {
          expect(p.largest!.length).toBe(Math.min(p.cities, f('cities.listed')));
          for (let i = 1; i < p.largest!.length; i++) expect(p.largest![i]).toBeLessThanOrEqual(p.largest![i - 1]);
          expect(p.largest!.reduce((n, c) => n + c, 0)).toBeLessThanOrEqual(p.cityPeople * 1.06);
          // every city has a hundredth of them at least
          for (const city of p.largest!) expect(city).toBeGreaterThanOrEqual(p.cityPeople * 0.0095);
        }
        if (pop >= f('concentration.leastFrom')) expect(p.pcr).toBeGreaterThanOrEqual(1);
      }
    }
    // the digit of a listing is kept
    expect(societyOf(rules, seededRng(3), world({ digit: 4 }))!.people!.digit).toBe(4);
    // limits that go with a condition: few town-dwellers before industry, many on crowded worlds
    for (const s of many({ tl: 2 }, 60)) expect(s.people!.urban).toBeLessThanOrEqual(25);
    for (const s of many({ pop: 9 }, 60)) expect(s.people!.urban).toBeGreaterThanOrEqual(40);
  });

  it('are governed in a way that hangs together', () => {
    for (const gov of [1, 4, 5, 8, 11, 13]) {
      for (const s of many({ gov }, 80)) {
        const g = s.government!;
        expect(g.code).toBe(gov);
        expect(['L', 'T']).toContain(g.centralisation);
        expect(['A', 'S', 'C', 'H']).toContain(g.authority);
        expect(g.profile).toMatch(/^[0-9A-F]-[LT][ASCH][eco]$/);
        const functions = g.structure!.map((x) => x.function);
        expect(new Set(functions).size).toBe(functions.length);
        // shared power means every function is described; a tight state under one body is described by that body alone
        if (g.authority === 'S') expect(functions).toEqual(['A', 'H', 'C']);
        else {
          const lead = g.structure!.find((x) => x.function === g.authority)!;
          expect(lead).toBeDefined();
          if (g.centralisation === 'T' && lead.code !== 'e') expect(functions).toEqual([g.authority]);
          else expect(functions).toHaveLength(3);
          if (gov === 1) expect(lead.code).toBe('e');
        }
        if (gov >= 8) for (const x of g.structure!) expect(['o', 'c']).toContain(x.code);
        for (const faction of g.factions ?? []) {
          expect(faction.government).not.toBe(7);
          expect(['w', 'm', 's']).toContain(faction.strength);
          expect(faction.relation).toBeGreaterThanOrEqual(0);
          expect(faction.relationName).toBe(society.relations[faction.relation!].name);
        }
        expect((g.factions ?? []).length).toBeLessThanOrEqual(f('factions.most'));
      }
    }
    expect(many({ gov: 4 }).some((s) => s.government!.factions)).toBe(true);
  });

  it('are described state by state where there is no one government', () => {
    for (const s of many({ gov: 7 }, 80)) {
      const g = s.government!;
      expect(g.code).toBe(7);
      expect(g.nations!.length).toBeGreaterThanOrEqual(2);
      expect(g.nations!).not.toContain(7);
      expect(g.host).toBe(g.nations![0]);
      // the rest is the state by the starport
      if (g.host !== 0) expect(g.profile!.startsWith(g.host!.toString(16).toUpperCase())).toBe(true);
    }
    // nobody governs, nobody judges
    for (const s of many({ gov: 0, law: 0 }, 40)) {
      expect(s.government!.centralisation).toBeUndefined();
      expect(s.law!.justice).toBeUndefined();
      expect(s.law!.parts).toHaveLength(3);
    }
  });

  it('live under law that follows the profile', () => {
    for (const law of [0, 3, 6, 9, 12]) {
      for (const s of many({ law }, 60)) {
        const l = s.law!;
        expect(['B', 'D', 'C']).toContain(l.justice);
        expect(['w', 'p', 'a']).toContain(l.uniformity);
        if (s.government!.centralisation === 'L') expect(l.uniformity).toBe('p');
        expect(l.parts.map((p) => p.id)).toEqual(['arms', 'trade', 'speech']);
        for (const part of l.parts) {
          expect(part.level).toBeGreaterThanOrEqual(Math.max(0, law - 1));
          expect(part.level).toBeLessThanOrEqual(Math.min(12, law + 3));
          const effects = society.lawEffects[part.id];
          expect(part.note).toBe(effects[Math.min(part.level, effects.length - 1)]);
        }
        expect(l.profile).toMatch(/^[0-9A-C]-[0-9A-C]{3}$/);
        if (l.justice === 'B') expect(l.economicCourts).toBeUndefined();
      }
    }
    const share = (list: Society[], test: (s: Society) => boolean) => list.filter(test).length / list.length;
    // the harsher the law, the less the accused is given the benefit of the doubt
    expect(share(many({ law: 1 }), (s) => !!s.law!.presumption)).toBeGreaterThan(share(many({ law: 11 }), (s) => !!s.law!.presumption) + 0.3);
    expect(share(many({ law: 11 }), (s) => !!s.law!.death)).toBeGreaterThan(share(many({ law: 1 }), (s) => !!s.law!.death));
  });

  it('have technology field by field, each within its bounds', () => {
    for (const tl of [3, 6, 9, 12]) {
      for (const s of many({ tl }, 80)) {
        const t = s.tech!;
        expect(t.high).toBe(tl);
        const part = Object.fromEntries(t.parts.map((p) => [p.id, p.level]));
        expect(part.low).toBeGreaterThanOrEqual(Math.floor(tl / 2));
        expect(part.low).toBeLessThanOrEqual(tl);
        expect(part.power).toBeGreaterThanOrEqual(tl - 3);
        expect(part.power).toBeLessThanOrEqual(tl + 1);
        expect(part.craft).toBeGreaterThanOrEqual(Math.max(0, part.power - 2));
        expect(part.craft).toBeLessThanOrEqual(part.power);
        expect(part.flight).toBeLessThanOrEqual(part.craft);
        expect(part.arms).toBeLessThanOrEqual(Math.max(part.power, part.craft));
        for (const p of t.parts) expect(p.level).toBeGreaterThanOrEqual(0);
        expect(t.parts.find((p) => p.id === 'power')!.note).toBe(society.techSteps.power[Math.min(part.power, 6)]);
        expect(t.parts.find((p) => p.id === 'low')!.note).toBeUndefined();
        expect(t.profile).toHaveLength(2 + t.parts.length);
      }
    }
    // no flying without air before the means to do without it
    for (const s of many({ atm: 0, tl: 4 }, 40)) expect(s.tech!.parts.find((p) => p.id === 'flight')!.level).toBe(0);
    // what it takes to stay alive follows the air and how liveable the world is
    expect(societyOf(rules, seededRng(1), world({ atm: 0 }))!.tech!.least).toBe(7);
    expect(societyOf(rules, seededRng(1), world({ atm: 3, habitability: 1 }))!.tech!.least).toBe(5);
    expect(societyOf(rules, seededRng(1), world({ atm: 3, habitability: undefined }))!.tech!.least).toBe(0);
  });

  it('have a culture, an economy and a port', () => {
    const rich = many({ port: 'A', pop: 9, tl: 12, codes: ['In', 'Ri'] });
    const poor = many({ port: 'E', pop: 3, tl: 4, codes: ['Po'], bases: 0 });
    for (const s of [...rich, ...poor]) {
      expect(s.culture!.map((c) => c.id)).toEqual(['openness', 'zeal', 'thrift']);
      for (const trait of s.culture!) {
        expect(trait.level).toBeGreaterThanOrEqual(1);
        expect(trait.leaning).toBe(trait.level <= 4 ? society.culture.find((c) => c.id === trait.id)!.low : trait.level >= 10 ? society.culture.find((c) => c.id === trait.id)!.high : undefined);
      }
      const e = s.economy!;
      expect(e.efficiency).not.toBe(0);
      expect(Math.abs(e.efficiency)).toBeLessThanOrEqual(4);
      expect(e.gwpPerHead).toBeGreaterThanOrEqual(0);
      expect(e.gwp / (e.gwpPerHead * s.people!.total || 1)).toBeCloseTo(e.gwpPerHead ? 1 : 0, 1);
      expect(e.wtn).toBeGreaterThanOrEqual(0);
      expect(e.inequality).toBeGreaterThanOrEqual(0);
      expect(e.inequality).toBeLessThanOrEqual(100);
      expect(Math.sign(e.ru)).toBe(Math.sign(e.efficiency));
      expect(society.tariffs.map((t) => t.name)).toContain(e.tariff);
      expect(s.port!.daily).toBeGreaterThanOrEqual(0);
    }
    const mean = (list: Society[], of: (s: Society) => number) => list.reduce((n, s) => n + of(s), 0) / list.length;
    expect(mean(rich, (s) => s.economy!.importance)).toBeGreaterThan(mean(poor, (s) => s.economy!.importance) + 3);
    expect(mean(rich, (s) => s.economy!.gwpPerHead)).toBeGreaterThan(mean(poor, (s) => s.economy!.gwpPerHead) * 3);
    expect(mean(rich, (s) => s.economy!.wtn)).toBeGreaterThan(mean(poor, (s) => s.economy!.wtn) + 4);
    // a port with no class for it never has a highport; a great one often does
    expect(poor.every((s) => s.port!.highport === false)).toBe(true);
    expect(rich.filter((s) => s.port!.highport).length).toBeGreaterThan(100);
    expect(rich.every((s) => s.port!.standing === 'Busy')).toBe(true);
    expect(poor.every((s) => s.port!.standing === 'Quiet')).toBe(true);
    // a closed people on a world with no port, an open one on a great port
    expect(mean(many({ port: 'X' }), (s) => s.culture![0].level)).toBeLessThan(mean(many({ port: 'A' }), (s) => s.culture![0].level) - 4);
  });
});

describe('the lesser settlements of a system', () => {
  const known = { stars: ['K0 V'], gasGiants: 2, belts: 1, worlds: 10, mainworld: { size: 6, atm: 3, hydro: 6 } };
  const settle = (seed: number, main: SocietyInput) => {
    const rng = seededRng(seed);
    const layout = generateSystem(rules.system!, rng, known);
    detailSystem(rules, rng, layout, known);
    settleSystem(rules, rng, layout, main);
    return layout;
  };
  const settlements = (seeds: number, main: SocietyInput) =>
    Array.from({ length: seeds }, (_, i) => settle(i + 1, main)).flatMap((layout) =>
      layout.worlds.flatMap((w) => [{ d: w.detail, w, moon: false }, ...w.moons.map((m) => ({ d: m.detail, w, moon: true }))]).filter((x) => x.d?.settlement).map((x) => ({ ...x, s: x.d!.settlement! })),
    );

  it('are smaller than the mainworld, and nowhere its technology cannot keep them alive', () => {
    const main = world({ pop: 8, tl: 9, gov: 4, law: 5, codes: ['In'] });
    const found = settlements(120, main);
    expect(found.length).toBeGreaterThan(40);
    for (const { s, d, w } of found) {
      expect(w.mainworld && !d!.moon).toBeFalsy();
      expect(s.pop).toBeGreaterThanOrEqual(1);
      expect(s.pop).toBeLessThanOrEqual(7);
      expect([0, 1, 6]).toContain(s.gov);
      expect(s.law).toBeGreaterThanOrEqual(0);
      expect(s.tl).toBeLessThanOrEqual(9);
      expect(['Z', 'P', 'Q']).toContain(s.port);
      expect(s.portName).toBe(society.spaceports.find((p) => p.code === s.port)!.name);
      expect(s.profile).toMatch(/^[ZPQ][0-9A-HS][0-9A-H][0-9A][1-7][016][0-9A-J]-[0-9A-G]$/);
      // air that takes TL7 to live in is only settled from a world that has it (as this one does)
      if ((d!.atm?.code ?? 0) <= 1) expect(s.tl).toBeGreaterThanOrEqual(7);
      for (const cls of s.classes ?? []) expect(society.classes.map((c) => c.code)).toContain(cls.code);
      if (s.pop <= 2) expect(s.classes!.map((c) => c.code)).toContain('Ou');
      if (s.classes?.some((c) => c.code === 'Ft')) expect(s.gov).toBe(6);
    }
    // an industrial mainworld digs its belts and moons
    expect(found.some(({ s }) => s.classes?.some((c) => c.code === 'Pi'))).toBe(true);
    expect(settlements(120, world({ pop: 8, tl: 9 })).some(({ s }) => s.classes?.some((c) => c.code === 'Pi'))).toBe(false);
    // a mainworld that cannot leave home settles nothing airless
    for (const { d } of settlements(120, world({ pop: 8, tl: 5 }))) expect(d!.atm?.code ?? 0).toBeGreaterThan(1);
  });

  it('are none where the mainworld has too few people to spare', () => {
    expect(settlements(60, world({ pop: 1 }))).toHaveLength(0);
    expect(settlements(60, world({ pop: 0 }))).toHaveLength(0);
  });
});

/** The survey run on a table, with the made-up rules served as a pack. */
describe('a detailed survey on the map, people and all', () => {
  let table: Table;
  let ann: Awaited<ReturnType<Table['join']>>;
  let packDir: string;
  let home: string;
  let empty: string;

  beforeAll(async () => {
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traveller-ui-society-'));
    fs.mkdirSync(path.join(packDir, 'test-people'));
    fs.writeFileSync(path.join(packDir, 'test-people', 'pack.json'), JSON.stringify({ id: 'test-people', name: 'Test people', version: '1' }));
    fs.writeFileSync(path.join(packDir, 'test-people', 'world.json'), JSON.stringify({ system: rules.system, detail: rules.detail, society }));
    table = await setTable({ rulepackDir: packDir });
    ann = await table.join('Ann');
    const sectorId = (await table.gm.act('sector.create', { name: 'Survey', x: 0, y: 0 })).id;
    home = (await table.gm.act('system.create', { sectorId, hex: '0101', name: 'Home', uwp: 'B637845-9', bases: 'N', pbg: '412', stars: 'K0 V' })).id;
    empty = (await table.gm.act('system.create', { sectorId, hex: '0102', name: 'Empty', uwp: 'X637000-0', pbg: '012', stars: 'K0 V' })).id;
    await eventually(() => expect(table.gm.all('body').some((b: Body) => b.systemId === empty && b.mainworld)).toBe(true));
  });
  afterAll(async () => {
    await table.close();
    fs.rmSync(packDir, { recursive: true, force: true });
  });

  it('records the people of the mainworld, kept from players until shared', async () => {
    await table.gm.act('reveal.preset', { ids: [home], preset: 'charted', audience: 'party' });
    await table.gm.act('system.detail', { id: home, seed: 5 });
    await eventually(() => expect(table.gm.get<StarSystem>(home)!.society).toBeDefined());
    const s = table.gm.get<StarSystem>(home)!.society!;
    // the digit of the listing and the figures of the profile are kept
    expect(s.people).toMatchObject({ digit: 4 });
    expect(s.people!.total).toBeGreaterThanOrEqual(4e8);
    expect(s.people!.total).toBeLessThan(5e8);
    expect(s.government!.code).toBe(4);
    expect(s.tech!.high).toBe(9);
    expect(s.law!.parts).toHaveLength(3);
    expect(s.economy!.importance).toBeGreaterThanOrEqual(1);
    // charting shows the survey, not the society
    await eventually(() => expect(ann.client.get<StarSystem>(home)!.survey).toBeDefined());
    expect(ann.client.get<StarSystem>(home)!.society).toBeUndefined();
    await table.gm.act('reveal.set', { ids: [home], facets: ['society'], audience: 'party', on: true });
    await eventually(() => expect(ann.client.get<StarSystem>(home)!.society).toEqual(s));
    // the same seed gives the same people; the plain chart forgets them
    await table.gm.act('system.detail', { id: home, seed: 5 });
    await eventually(() => expect(table.gm.get<StarSystem>(home)!.society).toEqual(s));
    await table.gm.act('system.rebuildBodies', { id: home });
    await eventually(() => expect(table.gm.get<StarSystem>(home)!.society).toBeUndefined());
  });

  it('settles other worlds of a crowded system, and none of an empty one', async () => {
    let settled: Body[] = [];
    for (let seed = 1; seed <= 12 && settled.length === 0; seed++) {
      await table.gm.act('system.detail', { id: home, seed });
      await eventually(() => expect(table.gm.get<StarSystem>(home)!.survey).toBeDefined());
      settled = table.gm.all('body').filter((b: Body) => b.systemId === home && b.data?.detail?.settlement);
    }
    expect(settled.length).toBeGreaterThan(0);
    for (const body of settled) {
      expect(body.mainworld).toBeFalsy();
      expect(body.data!.detail!.settlement!.pop).toBeLessThan(8);
    }
    await table.gm.act('system.detail', { id: empty, seed: 3 });
    await eventually(() => expect(table.gm.get<StarSystem>(empty)!.survey).toBeDefined());
    expect(table.gm.get<StarSystem>(empty)!.society).toBeUndefined();
    expect(table.gm.all('body').filter((b: Body) => b.systemId === empty && b.data?.detail?.settlement)).toHaveLength(0);
  });
});
