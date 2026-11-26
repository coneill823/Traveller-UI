/**
 * Packs that add to the character rules: the order packs are layered in, optional characteristics
 * on a sheet, and quick-creation packages. Every rule here is made up for the test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packOrder, type CharacterPackage, type PackageRules } from '../src/shared/rulepack';
import { applyPackage, needsChoice } from '../src/shared/rules/packages';
import type { Character } from '../src/shared/types';
import { hasPack, HAS_CORE_RULES, loadPacks, setTable, type Table } from './helpers';

const sheet = (over: Partial<Character> = {}): Character => ({
  id: 'c1', type: 'character', rev: 1, createdAt: 0, updatedAt: 0, kind: 'pc', name: 'Odo',
  chars: { STR: { value: 7, max: 7 }, DEX: { value: 5, max: 9 }, END: { value: 8, max: 8 }, INT: { value: 12, max: 12 }, EDU: { value: 2, max: 2 }, SOC: { value: 14, max: 14 } },
  skills: { Sailing: 1, 'Ropework (splices)': 3 },
  credits: 40,
  ...over,
});

// made up for the test
const limits: PackageRules = { skillCap: 3, charMin: 1, charMax: 15, backgroundAge: 16, careerYears: '2D + 10', termYears: 5 };
const islander: CharacterPackage = { id: 'islander', kind: 'background', name: 'Islander', mods: { STR: 1, EDU: -3, SOC: 2, WIT: 4 }, skills: { Sailing: 1, Fishing: 0, 'Ropework (any)': 1 }, credits: 15, benefits: ['A boat hook', 'An uncle in every port'] };
const pilot: CharacterPackage = { id: 'harbour-pilot', kind: 'career', name: 'Harbour pilot', mods: { DEX: -2 }, skills: { Sailing: 2, 'Ropework (splices)': 1, 'Charts or Tides': 2 }, rank: 'Branch pilot', credits: 300 };

describe('the order packs are layered in', () => {
  const ids = (list: { id: string }[]) => list.map((p) => p.id);

  it('keeps the given order when nothing asks otherwise', () => {
    expect(ids(packOrder([{ id: 'b' }, { id: 'a' }, { id: 'c' }]))).toEqual(['b', 'a', 'c']);
    expect(packOrder([])).toEqual([]);
  });

  it('moves a pack after those it layers over, and no further', () => {
    expect(ids(packOrder([{ id: 'additions', after: ['base'] }, { id: 'base' }, { id: 'more' }]))).toEqual(['base', 'additions', 'more']);
    expect(ids(packOrder([{ id: 'a', after: ['c'] }, { id: 'b', after: ['a'] }, { id: 'c' }, { id: 'd' }]))).toEqual(['c', 'a', 'b', 'd']);
    // already after it: untouched
    expect(ids(packOrder([{ id: 'base' }, { id: 'x' }, { id: 'additions', after: ['base'] }]))).toEqual(['base', 'x', 'additions']);
  });

  it('ignores packs that are not installed, a pack naming itself, and circles', () => {
    expect(ids(packOrder([{ id: 'a', after: ['missing', 'a'] }, { id: 'b' }]))).toEqual(['a', 'b']);
    expect(ids(packOrder([{ id: 'a', after: ['b'] }, { id: 'b', after: ['a'] }, { id: 'c' }]))).toEqual(['c', 'a', 'b']);
  });
});

describe('taking a quick-creation package', () => {
  it('knows which skills are named loosely', () => {
    expect(['Science (any)', 'Electronics (comms or computers)', 'Blade or Staff', 'Science (another)', 'Profession (any suitable)'].map(needsChoice)).toEqual([true, true, true, true, true]);
    expect(['Sailing', 'Ropework (splices)', 'Many-handed', 'Oratory'].map(needsChoice)).toEqual([false, false, false, false]);
  });

  it('changes characteristics within the limits, keeping hurts and leaving absent ones alone', () => {
    const out = applyPackage(sheet(), islander, limits);
    expect(out.chars.STR).toEqual({ value: 8, max: 8 });
    expect(out.chars.EDU).toEqual({ value: 1, max: 1 }); // 2 - 3, held at the least
    expect(out.chars.SOC).toEqual({ value: 15, max: 15 }); // 14 + 2, held at the most
    expect(out.chars.WIT).toBeUndefined();
    // four points hurt before, four after
    expect(applyPackage(sheet(), pilot, limits).chars.DEX).toEqual({ value: 3, max: 7 });
    // with no limits in the pack none are applied
    expect(applyPackage(sheet(), islander, undefined).chars.EDU).toEqual({ value: 0, max: -1 });
  });

  it('stacks skills up to the cap, and never lowers what is already there', () => {
    const out = applyPackage(sheet(), islander, limits, { 'Ropework (any)': ' Ropework (knots) ' });
    expect(out.skills).toEqual({ Sailing: 2, 'Ropework (splices)': 3, Fishing: 0, 'Ropework (knots)': 1 });
    const second = applyPackage(sheet({ skills: out.skills }), pilot, limits);
    expect(second.skills.Sailing).toBe(3); // 2 + 2, capped
    expect(second.skills['Ropework (splices)']).toBe(3);
    expect(second.skills['Charts or Tides']).toBe(2); // left as written, to settle on the sheet
    expect(applyPackage(sheet({ skills: { Sailing: 5 } }), pilot, limits).skills.Sailing).toBe(5);
    expect(applyPackage(sheet({ skills: { Sailing: 5 } }), pilot, undefined).skills.Sailing).toBe(7);
    // the sheet given is not touched
    const before = sheet();
    applyPackage(before, pilot, limits);
    expect(before.skills).toEqual({ Sailing: 1, 'Ropework (splices)': 3 });
    expect(before.chars!.DEX).toEqual({ value: 5, max: 9 });
  });

  it('adds money, age, a career and a note of the rest', () => {
    const young = applyPackage(sheet({ age: 12 }), islander, limits);
    expect(young).toMatchObject({ credits: 55, age: 16, note: 'From the Islander background: A boat hook; An uncle in every port.' });
    expect(young.career).toBeUndefined();
    expect(applyPackage(sheet({ age: 30 }), islander, limits).age).toBeUndefined();
    expect(applyPackage(sheet(), islander, undefined).age).toBeUndefined();
    // 2D + 10 with every die a 6 is 22 years: four terms of five, rounded
    const old = applyPackage(sheet({ age: 16 }), pilot, limits, {}, () => 0.999);
    expect(old).toMatchObject({ credits: 340, age: 38, career: { name: 'Harbour pilot', terms: 4, rank: 'Branch pilot' } });
    expect(old.note).toBeUndefined();
    // no age on the sheet: none is invented; no years in the pack: one term
    expect(applyPackage(sheet(), pilot, limits).age).toBeUndefined();
    expect(applyPackage(sheet({ age: 16 }), pilot, undefined)).toMatchObject({ career: { name: 'Harbour pilot', terms: 1 } });
    expect(applyPackage(sheet({ age: 16 }), pilot, undefined).age).toBeUndefined();
  });
});

describe('a table whose packs add characteristics and packages', () => {
  let table: Table;
  let ann: Awaited<ReturnType<Table['join']>>;
  let packDir: string;
  const character = (id: string) => table.gm.get<Character>(id)!;

  beforeAll(async () => {
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traveller-ui-packages-'));
    const write = (folder: string, meta: object, characters: object) => {
      fs.mkdirSync(path.join(packDir, folder));
      fs.writeFileSync(path.join(packDir, folder, 'pack.json'), JSON.stringify(meta));
      fs.writeFileSync(path.join(packDir, folder, 'characters.json'), JSON.stringify(characters));
    };
    // by name the additions come first; they ask to be layered over the base
    write('a-additions', { id: 'additions', name: 'Additions', after: ['base'] }, {
      characteristics: [{ id: 'GRT', name: 'Grit', physical: false, optional: true, start: 'END' }],
      careers: ['Deckhand', 'Harbour pilot', 'Wrecker'],
      packages: [islander, pilot],
      packageRules: limits,
    });
    write('b-base', { id: 'base', name: 'Base' }, {
      characteristics: ['STR', 'DEX', 'END', 'INT', 'EDU', 'SOC'].map((id) => ({ id, name: id, physical: ['STR', 'DEX', 'END'].includes(id) })),
      maxUnaugmented: 15,
      skills: [{ name: 'Sailing', char: 'DEX' }, { name: 'Ropework', char: 'DEX', specialities: ['Knots', 'Splices'] }],
      species: [],
      careers: ['Deckhand', 'Harbour pilot'],
      encumbrance: { note: '', overloadDm: -2, overloadMultiple: 2, wornArmourFraction: 0.25 },
      damageOrder: { first: 'END', then: ['STR', 'DEX'] },
    });
    table = await setTable({ rulepackDir: packDir });
    ann = await table.join('Ann');
  });
  afterAll(async () => {
    await table.close();
    fs.rmSync(packDir, { recursive: true, force: true });
  });

  it('layers the additions over the base whatever their folders are called', () => {
    const pack = table.running.services.rules.pack;
    expect(pack.packs.map((p) => p.id)).toEqual(['base', 'additions']);
    expect(pack.characters!.characteristics.map((c) => c.id)).toEqual(['STR', 'DEX', 'END', 'INT', 'EDU', 'SOC', 'GRT']);
    expect(pack.characters!.careers).toEqual(['Deckhand', 'Harbour pilot', 'Wrecker']);
  });

  it('rolls checks on a characteristic the pack adds, and on no others', async () => {
    const { id } = await ann.client.act<{ id: string }>('character.create', { name: 'Odo', chars: { END: 9 } });
    await ann.client.act('entity.patch', { id, ops: [{ op: 'set', path: ['chars', 'GRT'], value: { value: 12, max: 12 } }] });
    const roll = await ann.client.act<{ dice: number[]; total: number; dm: number }>('character.check', { id, char: 'GRT', manual: [3, 4] });
    expect(roll.dice).toEqual([3, 4]);
    expect(roll.total).toBe(7 + roll.dm);
    await expect(ann.client.act('character.check', { id, char: 'ZEAL' })).rejects.toThrow();
  });

  it('puts a package on the sheet for its owner, and for nobody else', async () => {
    const { id } = await ann.client.act<{ id: string }>('character.create', { name: 'Pim', chars: { STR: 7, EDU: 2, SOC: 14 } });
    await ann.client.act('entity.patch', { id, ops: [{ op: 'set', path: ['age'], value: 12 }] });
    const took = await ann.client.act<{ name: string; age?: number }>('character.applyPackage', { id, packageId: 'islander', choices: { 'Ropework (any)': 'Ropework (knots)', Sailing: 'Swimming' } });
    expect(took).toMatchObject({ name: 'Islander', age: 16 });
    let pim = character(id);
    expect(pim.chars).toMatchObject({ STR: { value: 8, max: 8 }, EDU: { value: 1, max: 1 }, SOC: { value: 15, max: 15 } });
    // only loosely named skills listed by the package take a choice
    expect(pim.skills).toEqual({ Sailing: 1, Fishing: 0, 'Ropework (knots)': 1 });
    expect(pim).toMatchObject({ credits: 15, age: 16, careers: [], secrets: 'From the Islander background: A boat hook; An uncle in every port.' });

    await ann.client.act('character.applyPackage', { id, packageId: 'harbour-pilot' });
    pim = character(id);
    expect(pim.careers).toHaveLength(1);
    expect(pim.careers![0]).toMatchObject({ name: 'Harbour pilot', rank: 'Branch pilot' });
    expect(pim.age).toBeGreaterThanOrEqual(16 + 12);
    expect(pim.age).toBeLessThanOrEqual(16 + 22);
    expect(pim.credits).toBe(315);
    expect(pim.skills).toMatchObject({ Sailing: 3, 'Charts or Tides': 2 });

    await expect(ann.client.act('character.applyPackage', { id, packageId: 'stowaway' })).rejects.toThrow(/not in the installed rules/);
    const bea = await table.join('Bea');
    await expect(bea.client.act('character.applyPackage', { id, packageId: 'islander' })).rejects.toThrow(/not your character/);
    // the referee may
    await table.gm.act('character.applyPackage', { id, packageId: 'islander' });
    expect(character(id).chars!.STR).toEqual({ value: 9, max: 9 });
  });
});

/** The packages and characteristics of the installed packs, wherever any carry some. */
describe.skipIf(!HAS_CORE_RULES || !hasPack('mgt2-companion'))('the packages of the installed packs', () => {
  const rules = HAS_CORE_RULES && hasPack('mgt2-companion') ? loadPacks('mgt2-core', 'mgt2-companion').characters! : undefined;

  it('change only characteristics the rules list, and give skills the rules know', () => {
    const chars = new Set(rules!.characteristics.map((c) => c.id));
    const skills = new Set(rules!.skills.map((s) => s.name));
    expect(rules!.packages!.length).toBeGreaterThan(0);
    expect(new Set(rules!.packages!.map((p) => p.id)).size).toBe(rules!.packages!.length);
    for (const pkg of rules!.packages!) {
      expect(['background', 'career'], pkg.id).toContain(pkg.kind);
      for (const key of Object.keys(pkg.mods ?? {})) expect(chars.has(key), `${pkg.id}: ${key}`).toBe(true);
      expect(Object.keys(pkg.skills).length, pkg.id).toBeGreaterThan(0);
      for (const [skill, level] of Object.entries(pkg.skills)) {
        expect(skills.has(skill.replace(/\s*\(.*\)$/, '')), `${pkg.id}: ${skill}`).toBe(true);
        expect(Number.isInteger(level) && level >= 0, `${pkg.id}: ${skill}`).toBe(true);
      }
    }
  });

  it('keep the usual characteristics first and add the others as optional', () => {
    const list = rules!.characteristics;
    expect(list.slice(0, 6).map((c) => c.id)).toEqual(['STR', 'DEX', 'END', 'INT', 'EDU', 'SOC']);
    for (const extra of list.slice(6)) expect(extra.optional, extra.id).toBe(true);
    for (const c of list) if (typeof c.start === 'string') expect(list.some((x) => x.id === c.start), c.id).toBe(true);
  });
});
