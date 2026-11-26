import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CombatRules, RulePack } from '../src/shared/rulepack';
import { AP_ALL, armourBonus, carryLimit, checkDm, parseDamage, rangeBand, rollWeaponDamage, traitValue, wornProtection } from '../src/shared/rules/character';
import { ammoFor, armourFromDef, availability, catalogueName, equipmentCategory, loadedWeapon, marketWorld, tableResult, variantFigures, variantSteps, weaponFromDef, withAmmo, type MarketWorld } from '../src/shared/rules/gear';
import type { Character, CharacterArmour, CharacterWeapon, Item, Roll } from '../src/shared/types';
import { testGearRules } from './fixtures/gearRules';
import { eventually, setTable, type Table } from './helpers';

const gear = testGearRules();
const pack: RulePack = { packs: [], gear };
const weapon = (id: string) => gear.weapons.find((w) => w.id === id)!;
const armourDef = (id: string) => gear.armour.find((a) => a.id === id)!;
const item = (id: string) => gear.equipment!.find((e) => e.id === id)!;
const worn = (id: string): CharacterArmour => ({ id, ...armourFromDef(armourDef(id)), worn: true });
const carriedWeapon = (id: string, over: Partial<CharacterWeapon> = {}): CharacterWeapon => ({ id, ...weaponFromDef(weapon(id), gear), ...over });

const sheet = (over: Partial<Character> = {}): Character => ({
  id: 'c1',
  type: 'character',
  rev: 1,
  createdAt: 0,
  updatedAt: 0,
  kind: 'pc',
  name: 'Jax',
  chars: { STR: { value: 7, max: 7 }, DEX: { value: 9, max: 9 }, END: { value: 8, max: 8 }, INT: { value: 8, max: 8 }, EDU: { value: 7, max: 7 }, SOC: { value: 7, max: 7 } },
  skills: { 'Gun Combat (slug)': 1, 'Athletics (strength)': 1 },
  ...over,
});

describe('finding an item for sale', () => {
  const world: MarketWorld = { name: 'Harbour', tl: 8, starport: 'A', population: 9, law: 4, tradeCodes: ['Ri', 'Po'] };
  const dm = (choice: Parameters<typeof availability>[2], at: MarketWorld | undefined = world) => availability(gear.availability, at, choice).dm;

  it('adds up what the world gives', () => {
    const found = availability(gear.availability, world, { tl: 8 });
    expect(found.parts.map((p) => [p.label, p.dm])).toEqual([
      ['Class A starport', 2],
      ['Ri', 1],
      ['Po', -1],
      ['Population 9', 1],
    ]);
    expect(found).toMatchObject({ dm: 3, priceMult: 1, skills: ['Broker', 'Streetwise'], target: 8 });
    expect(found.unavailable).toBeUndefined();
  });

  it('makes higher technology harder to find, every band that fits counting', () => {
    expect(dm({ tl: 7 })).toBe(3);
    expect(dm({ tl: 9 })).toBe(2);
    expect(dm({ tl: 12 })).toBe(0);
    expect(dm({ tl: 14 })).toBe(-3);
    // with no figure for the item, or none for the world, the comparison is left out
    expect(dm({})).toBe(3);
    expect(dm({ tl: 14 }, { tradeCodes: [] })).toBe(0);
  });

  it('applies the buyer’s and the referee’s choices', () => {
    expect(dm({ tl: 8, options: ['rare'] })).toBe(1);
    expect(availability(gear.availability, world, { tl: 8, options: ['double'] })).toMatchObject({ dm: 4, priceMult: 2 });
    // double and triple cannot both be offered: the larger stands
    expect(availability(gear.availability, world, { tl: 8, options: ['double', 'triple'] })).toMatchObject({ dm: 5, priceMult: 3 });
    expect(dm({ tl: 8, referee: -2 })).toBe(1);
    expect(dm({ tl: 8, variant: gear.variants![0] })).toBe(1);
  });

  it('prices and judges the black market by law level and how hot the goods are', () => {
    const hot = availability(gear.availability, world, { tl: 8, blackMarket: 'hot' });
    expect(hot).toMatchObject({ dm: 0, priceMult: 10, skills: ['Streetwise'] });
    expect(dm({ tl: 8, blackMarket: 'hot' }, { ...world, law: 8 })).toBe(-2);
    expect(availability(gear.availability, { ...world, law: 1 }, { tl: 8, blackMarket: 'mild', options: ['double'] })).toMatchObject({ dm: 8, priceMult: 4 });
    expect(tableResult(gear.availability!.blackMarket!.attention!.results, -5)?.name).toBe('Raid');
    expect(tableResult(gear.availability!.blackMarket!.attention!.results, 0)?.name).toBe('Questions');
    expect(tableResult(gear.availability!.blackMarket!.attention!.results, 7)?.name).toBe('A glance');
  });

  it('finds nothing where nobody lives, and copes without rules', () => {
    expect(availability(gear.availability, { ...world, population: 0 }, { tl: 5 }).unavailable).toMatch(/Nothing is for sale/);
    expect(availability(undefined, world, { tl: 5 })).toMatchObject({ dm: 0, priceMult: 1, parts: [] });
  });

  it('reads a world’s profile, leaving out what is not known', () => {
    expect(marketWorld({ name: 'Harbour', uwp: 'A788899-C', remarks: 'Ri Xx' }, undefined)).toEqual({ name: 'Harbour', tl: 12, starport: 'A', population: 8, law: 9, tradeCodes: ['Ri', 'Xx'] });
    expect(marketWorld({ uwp: 'B??????-?' }, undefined)).toMatchObject({ starport: 'B', tl: undefined, population: undefined, law: undefined });
    expect(marketWorld({ name: 'Uncharted' }, undefined)).toEqual({ name: 'Uncharted', tl: undefined, starport: undefined, population: undefined, law: undefined, tradeCodes: [] });
    expect(marketWorld(undefined, undefined)).toBeUndefined();
  });
});

describe('special versions of an item', () => {
  const [proto, retro] = gear.variants!;

  it('makes prototypes dearer and heavier, electronics far more so', () => {
    expect(variantFigures(item('lamp'), proto)).toEqual({ tl: 3, kg: 2, cost: 80, steps: 1 });
    expect(variantFigures(item('radio-tl6'), proto)).toEqual({ tl: 5, kg: 80, cost: 8000, steps: 1 });
    expect(variantFigures(item('lamp'), undefined)).toEqual({ tl: 4, kg: 1, cost: 20, steps: 0 });
    // no listed mass or price: nothing to multiply
    expect(variantFigures(item('winch'), proto)).toMatchObject({ tl: 4, kg: undefined, cost: undefined });
  });

  it('halves electronics for each tech level above the listing, within limits', () => {
    expect(variantSteps(item('lamp'), retro)).toBe(0);
    expect(variantSteps(item('radio-tl6'), retro)).toBe(2);
    expect(variantSteps(item('thinker'), retro)).toBe(6);
    expect(variantFigures(item('radio-tl6'), retro, 1)).toEqual({ tl: 7, kg: 4, cost: 200, steps: 1 });
    expect(variantFigures(item('radio-tl6'), retro, 5)).toEqual({ tl: 8, kg: 2, cost: 100, steps: 2 });
    // a computer keeps shrinking; under a quarter of a kilogram counts as nothing
    expect(variantFigures(item('thinker'), retro, 4)).toEqual({ tl: 12, kg: 0, cost: 63, steps: 4 });
    expect(variantFigures(item('lamp'), retro, 2)).toEqual({ tl: 4, kg: 1, cost: 20, steps: 0 });
  });
});

describe('the catalogue', () => {
  it('names entries, adding the tech level where a name is shared', () => {
    expect(catalogueName(weapon('longarm-tl7'), gear.weapons)).toBe('Longarm (TL7)');
    expect(catalogueName(weapon('slugger'), gear.weapons)).toBe('Slugger');
    expect(catalogueName(item('radio-tl9'), gear.equipment!)).toBe('Radio (TL9)');
  });

  it('files equipment as gear or consumables', () => {
    expect(equipmentCategory(item('lamp'))).toBe('gear');
    expect(equipmentCategory(item('tonic'))).toBe('consumable');
    expect(equipmentCategory(item('piercer'))).toBe('consumable');
    expect(equipmentCategory(item('spare-heart'))).toBe('gear');
  });

  it('carries a weapon and a suit onto a sheet with everything the rules need', () => {
    expect(weaponFromDef(weapon('longarm-tl9'), gear)).toMatchObject({ defId: 'longarm-tl9', name: 'Longarm (TL9)', damage: '3D+2', range: 400, magazine: 30, ammo: 30, tl: 9, ammoClass: 'rifle', traits: ['AP 4', 'Auto 3'] });
    expect(weaponFromDef(weapon('lash'), gear)).toMatchObject({ name: 'Lash', range: 'melee', ammo: undefined, ammoClass: undefined });
    expect(armourFromDef(armourDef('warframe'))).toMatchObject({ name: 'War Frame (TL13)', protection: 20, rad: 200, str: 4, dex: -2, slots: 12, powered: true, skill: { name: 'Vacc Suit', level: 2 } });
    expect(armourFromDef(armourDef('mirror'))).toMatchObject({ protection: 0, laserProtection: 9, versus: '+9 vs. lasers' });
  });
});

describe('special ammunition', () => {
  const ids = (w: { ammoClass?: string; tl?: number }) => ammoFor(gear, w).map((e) => e.id);

  it('offers what a weapon can load, by its class and tech level', () => {
    expect(ids({ ammoClass: 'pistol', tl: 6 })).toEqual(['piercer', 'thud']);
    expect(ids({ ammoClass: 'rifle', tl: 7 })).toEqual(['piercer', 'thud']);
    expect(ids({ ammoClass: 'rifle', tl: 9 })).toEqual(['piercer', 'sabot', 'thud', 'burster']);
    expect(ids({ ammoClass: 'heavy', tl: 8 })).toEqual(['piercer', 'burster', 'smoker', 'shaped']);
    expect(ids({ ammoClass: 'pistol', tl: 4 })).toEqual([]);
    // a weapon of unknown make may load anything of its class; one with no class takes none
    expect(ids({ ammoClass: 'pistol' })).toEqual(['piercer', 'thud']);
    expect(ids({ tl: 12 })).toEqual([]);
    // a weapon that does not say what it takes is looked up by the entry it came from
    expect(ammoFor(gear, { defId: 'longarm-tl9' }).map((e) => e.id)).toEqual(['piercer', 'sabot', 'thud', 'burster']);
    expect(ammoFor(gear, { defId: 'beamer' })).toEqual([]);
    expect(ammoFor(undefined, { ammoClass: 'pistol' })).toEqual([]);
  });

  it('adds armour piercing by the die and changes range and damage', () => {
    const longarm = carriedWeapon('longarm-tl7');
    expect(withAmmo(longarm, item('piercer').ammo)).toMatchObject({ damage: '3D', range: 300, traits: ['Auto 2', 'AP 5'] });
    expect(withAmmo(longarm, item('sabot').ammo)).toMatchObject({ damage: '3D-3', range: 330, traits: ['Auto 2', 'AP 11'] });
    expect(withAmmo(longarm, item('thud').ammo)).toMatchObject({ damage: '3D', range: 225, traits: ['Auto 2', 'Stun'] });
    expect(withAmmo(longarm, undefined)).toBe(longarm);
  });

  it('handles blast, fixed damage and the ceiling on dice', () => {
    const thumper = carriedWeapon('thumper');
    // a tenth die tips the weapon over into Destructive
    expect(withAmmo(thumper, item('burster').ammo)).toMatchObject({ damage: '1DD', traits: ['Bulky', 'Blast 8'] });
    expect(withAmmo(thumper, item('smoker').ammo)).toMatchObject({ damage: '', traits: ['Bulky', 'Blast 12'] });
    expect(withAmmo(thumper, item('shaped').ammo)).toMatchObject({ damage: '2DD', range: 50, traits: ['Bulky', 'AP 18', 'Blast 9', 'Fire'] });
    // a weapon with no blast of its own takes the round's
    expect(withAmmo(carriedWeapon('slugger'), item('burster').ammo)).toMatchObject({ damage: '4D-3', traits: ['Blast 3'] });
    // melee reach and odd dice are left alone
    expect(withAmmo(carriedWeapon('lash'), item('sabot').ammo)).toMatchObject({ damage: 'D3', range: 'melee' });
  });

  it('applies whatever is loaded, and ignores a load it does not know', () => {
    expect(loadedWeapon(carriedWeapon('slugger', { load: { id: 'piercer', name: 'Piercer Rounds' } }), gear).traits).toEqual(['AP 3']);
    expect(loadedWeapon(carriedWeapon('slugger', { load: { id: 'gone', name: 'Gone' } }), gear).traits).toBeUndefined();
    const plain = carriedWeapon('slugger');
    expect(loadedWeapon(plain, gear)).toBe(plain);
  });
});

describe('weapons and armour on the sheet', () => {
  it('reads the fuller forms of traits and damage', () => {
    expect(traitValue(['AP ∞'], 'AP')).toBe(AP_ALL);
    expect(traitValue(['Auto 4 (8)'], 'Auto')).toBe(4);
    expect(traitValue(['Blast 1,200'], 'Blast')).toBe(1200);
    expect(traitValue(['Very Bulky'], 'Bulky')).toBe(0);
    expect(parseDamage('D3')).toEqual({ dice: 1, mod: 0, destructive: false, half: true });
    expect(parseDamage('2D3+1')).toEqual({ dice: 2, mod: 1, destructive: false, half: true });
    expect(parseDamage('Special')).toBeNull();
  });

  it('rolls half dice, and reports a charge that ignores armour', () => {
    const lash = rollWeaponDamage(sheet(), carriedWeapon('lash'), { effect: 2, manual: [5] }, pack)!;
    expect(lash).toMatchObject({ dice: [3], total: 5 });
    const charge = rollWeaponDamage(sheet(), carriedWeapon('satchel'), { effect: 0, manual: [1, 1, 1, 1] }, pack)!;
    expect(charge).toMatchObject({ total: 4, ap: AP_ALL });
    expect(charge.notes).toEqual(['Ignores armour', 'Blast 1200 m']);
  });

  it('gives no range bands to something placed by hand', () => {
    const combat = { range: { shortFraction: 0.25, longMultiple: 2, extremeMultiple: 4, unscopedExtremeBeyond: 100, bands: [] } } as unknown as CombatRules;
    expect(rangeBand(0, 5, combat)).toBeNull();
    expect(rangeBand(20, 5, combat)).toBe('short');
    expect(rangeBand('melee', 1, combat)).toBeNull();
  });

  it('uses a suit’s own figure against lasers, better or worse', () => {
    expect(wornProtection(sheet({ armour: [worn('padding'), worn('mirror')] }))).toBe(2);
    expect(wornProtection(sheet({ armour: [worn('padding'), worn('mirror')] }), { laser: true })).toBe(11);
    expect(wornProtection(sheet({ armour: [worn('screen')] }))).toBe(11);
    expect(wornProtection(sheet({ armour: [worn('screen')] }), { laser: true })).toBe(0);
  });

  it('lets powered armour lend strength for checks and carrying', () => {
    const framed = sheet({ armour: [worn('warframe')], skills: { 'Vacc Suit': 2, 'Athletics (strength)': 1 } });
    expect(armourBonus(framed, 'STR')).toBe(4);
    expect(armourBonus(framed, 'DEX')).toBe(-2);
    expect(armourBonus(framed, 'END')).toBe(0);
    expect(checkDm(framed, { char: 'STR' }, pack)).toEqual({ dm: 1, parts: [{ label: 'STR 7+4 in armour', dm: 1 }] });
    expect(checkDm(framed, { char: 'DEX' }, pack)).toEqual({ dm: 0, parts: [{ label: 'DEX 9−2 in armour', dm: 0 }] });
    expect(carryLimit(sheet())).toBe(16);
    expect(carryLimit(framed)).toBe(20);
    // taken off, it does nothing
    const stowed = sheet({ armour: [{ ...worn('warframe'), worn: false }] });
    expect(checkDm(stowed, { char: 'STR' }, pack).dm).toBe(0);
  });

  it('penalises a suit worn without the skill for it', () => {
    const partsOf = (skills: Record<string, number>) => checkDm(sheet({ armour: [worn('warframe')], skills }), { char: 'INT' }, pack).parts.slice(1);
    expect(partsOf({})).toEqual([{ label: 'War Frame (TL13): no Vacc Suit', dm: -3 }]);
    expect(partsOf({ 'Vacc Suit': 0 })).toEqual([{ label: 'War Frame (TL13): Vacc Suit 0, needs 2', dm: -2 }]);
    expect(partsOf({ 'Vacc Suit': 1 })).toEqual([{ label: 'War Frame (TL13): Vacc Suit 1, needs 2', dm: -1 }]);
    expect(partsOf({ 'Vacc Suit': 3 })).toEqual([]);
    expect(checkDm(sheet({ armour: [worn('padding')] }), { char: 'INT' }, pack).parts).toHaveLength(1);
  });
});

/** The catalogue served to a table, with rules made up for the purpose so no private pack is needed. */
describe('buying from the catalogue', () => {
  let table: Table;
  let ann: Awaited<ReturnType<Table['join']>>;
  let bob: Awaited<ReturnType<Table['join']>>;
  let jax: string;
  let packDir: string;
  const credits = () => ann.client.get<Character>(jax)!.credits;

  beforeAll(async () => {
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traveller-ui-gear-'));
    fs.mkdirSync(path.join(packDir, 'test-gear'));
    fs.writeFileSync(path.join(packDir, 'test-gear', 'pack.json'), JSON.stringify({ id: 'test-gear', name: 'Test gear', version: '1' }));
    fs.writeFileSync(path.join(packDir, 'test-gear', 'gear.json'), JSON.stringify(gear));
    table = await setTable({ rulepackDir: packDir });
    ann = await table.join('Ann');
    bob = await table.join('Bob');
    jax = (await ann.client.act('character.create', { name: 'Jax', chars: { STR: 7, DEX: 9, END: 8, INT: 8, EDU: 7, SOC: 7 } })).id;
    await ann.client.act('entity.patch', { id: jax, ops: [{ op: 'set', path: ['credits'], value: 5000 }, { op: 'set', path: ['skills', 'Gun Combat (slug)'], value: 1 }] });
  });
  afterAll(async () => {
    await table.close();
    fs.rmSync(packDir, { recursive: true, force: true });
  });

  it('adds equipment with its figures and what it does', async () => {
    const lamp = await ann.client.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'lamp', qty: 2 });
    expect(lamp.paid).toBeUndefined();
    await eventually(() => expect(ann.client.get<Item>(lamp.id)).toMatchObject({ name: 'Lamp', category: 'gear', qty: 2, kg: 1, value: 20, tl: 4, defId: 'lamp', note: 'Lights a room.', carried: true }));
    const radio = (await ann.client.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'radio-tl9' })).id;
    const tonic = (await ann.client.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'tonic' })).id;
    const winch = (await ann.client.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'winch' })).id;
    await eventually(() => expect(ann.client.get<Item>(winch)).toBeDefined());
    expect(ann.client.get<Item>(radio)).toMatchObject({ name: 'Radio (TL9)', kg: 1, value: 250 });
    expect(ann.client.get<Item>(tonic)).toMatchObject({ category: 'consumable', value: 50 });
    expect(ann.client.get<Item>(tonic)!.kg).toBeUndefined();
    expect(ann.client.get<Item>(winch)!.note).toBe('Mass: x2 the rope. Price: Cr10 a metre.');
    expect(credits()).toBe(5000);
    await expect(ann.client.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'nope' })).rejects.toThrow(/not in the catalogue/);
  });

  it('takes the price from the buyer, at whatever multiple is being asked', async () => {
    const bought = await ann.client.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'lamp', qty: 3, pay: true });
    expect(bought.paid).toBe(60);
    await eventually(() => expect(credits()).toBe(4940));
    const dear = await ann.client.act('item.create', { holderId: jax, defKind: 'weapon', defId: 'slugger', pay: true, priceMult: 3, equip: true });
    expect(dear.paid).toBe(900);
    await eventually(() => expect(credits()).toBe(4040));
    // what it is worth stays the list price
    expect(ann.client.get<Item>(dear.id)).toMatchObject({ name: 'Slugger', value: 300 });
    expect(ann.client.get<Character>(jax)!.weapons!.find((w) => w.defId === 'slugger')).toMatchObject({ ammoClass: 'pistol', tl: 6, ammo: 10 });
    await expect(ann.client.act('item.create', { holderId: jax, defKind: 'armour', defId: 'hardsuit', pay: true })).rejects.toThrow(/Not enough credits: Cr4,040 available, Cr11,000 needed/);
    await expect(ann.client.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'winch', pay: true })).rejects.toThrow(/no listed price/);
    expect(credits()).toBe(4040);
    // nobody shops with another traveller's credits
    await expect(bob.client.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'lamp', pay: true })).rejects.toThrow(/cannot add things there/);
    // a store has no purse; the referee may run a traveller into debt
    const cache = (await table.gm.act('stash.create', { name: 'Cache' })).id;
    await expect(table.gm.act('item.create', { holderId: cache, defKind: 'equipment', defId: 'lamp', pay: true })).rejects.toThrow(/no credits of its own/);
    const gift = await table.gm.act('item.create', { holderId: jax, defKind: 'armour', defId: 'hardsuit', pay: true, equip: true });
    expect(gift.paid).toBe(11000);
    await eventually(() => expect(credits()).toBe(-6960));
    expect(ann.client.get<Character>(jax)!.armour!.find((a) => a.defId === 'hardsuit')).toMatchObject({ name: 'Hard Suit (TL9)', protection: 9, rad: 60, skill: { name: 'Vacc Suit', level: 1 }, worn: true });
  });

  it('sells prototypes and old models at their own figures', async () => {
    const proto = await table.gm.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'radio-tl6', variant: 'proto', pay: true });
    expect(proto.paid).toBe(8000);
    await eventually(() => expect(ann.client.get<Item>(proto.id)).toMatchObject({ name: 'Radio (TL6), prototype', tl: 5, kg: 80, value: 8000 }));
    const old = (await table.gm.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'radio-tl6', variant: 'retro', steps: 2 })).id;
    await eventually(() => expect(ann.client.get<Item>(old)).toMatchObject({ name: 'Radio (TL6), old model (TL8)', tl: 8, kg: 2, value: 100 }));
    await expect(table.gm.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'lamp', variant: 'retro' })).rejects.toThrow(/does not come as old model/);
    await expect(table.gm.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'lamp', variant: 'shiny' })).rejects.toThrow(/no such version/);
  });

  it('notes an augment among a traveller’s traits when it is fitted', async () => {
    const heart = (await table.gm.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'spare-heart', equip: true })).id;
    await eventually(() => expect(ann.client.get<Character>(jax)!.traits).toContain('Spare Heart: END +1.'));
    // it is part of them, not something carried
    expect(ann.client.get<Item>(heart)).toMatchObject({ category: 'gear', value: 90000 });
    expect(ann.client.get<Item>(heart)!.carried).toBeUndefined();
    await table.gm.act('item.create', { holderId: jax, defKind: 'equipment', defId: 'spare-heart', equip: true });
    expect(ann.client.get<Character>(jax)!.traits!.filter((t) => t.startsWith('Spare Heart'))).toHaveLength(1);
  });

  it('fights with the ammunition that is loaded', async () => {
    const slugger = ann.client.get<Character>(jax)!.weapons!.find((w) => w.defId === 'slugger')!;
    const plain = await ann.client.act('character.weaponDamage', { id: jax, weaponId: slugger.id, effect: 0, manual: [4, 4, 4] });
    expect(plain).toMatchObject({ total: 9, ap: 0 });
    await ann.client.act('entity.patch', { id: jax, ops: [{ op: 'set', path: ['weapons', slugger.id, 'load'], value: { id: 'piercer', name: 'Piercer Rounds' } }] });
    const loaded = await ann.client.act('character.weaponDamage', { id: jax, weaponId: slugger.id, effect: 0, manual: [4, 4, 4] });
    expect(loaded).toMatchObject({ total: 9, ap: 3 });
    await eventually(() => expect(ann.client.get<Roll>(loaded.id)).toMatchObject({ label: 'Damage: Slugger [Piercer Rounds]' }));
    const attack = await ann.client.act('character.attack', { id: jax, weaponId: slugger.id, manual: [4, 4] });
    await eventually(() => expect(ann.client.get<Roll>(attack.id)).toMatchObject({ label: 'Attack: Slugger [Piercer Rounds]' }));
    // the hard suit is worn without the skill for it: every check suffers
    expect(ann.client.get<Roll>(attack.id)!.breakdown!.map((p) => p.label)).toContain('Hard Suit (TL9): no Vacc Suit');
  });
});
