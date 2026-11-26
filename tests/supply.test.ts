import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RulePack } from '../src/shared/rulepack';
import { AP_ALL, hasTrait, parseDamage, traitValue } from '../src/shared/rules/character';
import { ammoFor, availability, loadedWeapon, marketWorld, variantFigures, weaponFromDef, withAmmo } from '../src/shared/rules/gear';
import type { Character, Item } from '../src/shared/types';
import { eventually, HAS_CORE_RULES, hasPack, loadPacks, setTable, type Table } from './helpers';

const HAS_PACK = HAS_CORE_RULES && hasPack('mgt2-supply');

/** The equipment catalogue layered over the core pack. Skipped where that pack is not installed. */
describe.skipIf(!HAS_PACK)('equipment with the supply catalogue pack', () => {
  const pack = HAS_PACK ? loadPacks('mgt2-core', 'mgt2-supply') : ({ packs: [] } as RulePack);
  const core = HAS_PACK ? loadPacks('mgt2-core') : ({ packs: [] } as RulePack);
  const gear = pack.gear!;
  const weapon = (id: string) => gear.weapons.find((w) => w.id === id)!;

  it('lists the catalogue', () => {
    expect(gear.weapons.length).toBeGreaterThan(250);
    expect(gear.armour.length).toBeGreaterThan(90);
    expect(gear.equipment!.length).toBeGreaterThan(650);
    for (const list of [gear.weapons, gear.armour, gear.equipment!]) expect(new Set(list.map((d) => d.id)).size).toBe(list.length);
    const groups = new Set(gear.equipment!.map((e) => e.group));
    for (const g of ['Augments', 'Communications', 'Computers and software', 'Electronics', 'Medical supplies', 'Survival gear', 'Tools', 'Weapon accessories', 'Specialised ammunition', 'Armour modifications']) expect(groups).toContain(g);
  });

  it('replaces the core book’s entries rather than standing beside them', () => {
    // every weapon and suit of the core pack is still there under its id, now from the fuller listing
    for (const w of core.gear!.weapons) expect(gear.weapons.filter((x) => x.id === w.id), w.id).toHaveLength(1);
    for (const a of core.gear!.armour) expect(gear.armour.find((x) => x.id === a.id)?.source, a.id).toBeTruthy();
    const names = gear.weapons.filter((w) => w.name === 'Autopistol');
    expect(names).toHaveLength(1);
    const suit = gear.armour.find((a) => a.id === 'vacc-suit-tl8')!;
    expect(suit.name).toBe('Vacc Suit, Basic');
    expect(suit.skill?.name).toBe('Vacc Suit');
  });

  it('gives every weapon figures the engine can use', () => {
    const defined = new Set(gear.weaponTraits.map((t) => t.id.toLowerCase()));
    for (const w of gear.weapons) {
      if (w.damage && w.damage !== 'Special') expect(parseDamage(w.damage), `${w.name}: ${w.damage}`).not.toBeNull();
      expect(w.range === 'melee' || typeof w.range === 'number', w.name).toBe(true);
      expect(w.skill, w.name).toBeTruthy();
      for (const t of w.traits ?? []) {
        const name = t.replace(/\s*(∞|[\d,]+)?(\s*\(.*\))?$/, '').toLowerCase();
        expect(defined.has(name), `${w.name}: ${t}`).toBe(true);
      }
    }
    // heavy weapons are listed by the ton and the kilometre, and come out in kilograms and metres
    const gun = weapon('siege-gun-tl7');
    expect(gun.kg).toBeGreaterThan(100_000);
    expect(gun.range).toBeGreaterThan(10_000);
    expect(parseDamage(gun.damage)?.destructive).toBe(true);
    expect(gun.note).toMatch(/Minimum range \d+ km/);
    // a charge placed by hand has no range, and one of them ignores armour altogether
    const charge = weapon('neutrino-detonator-tl17');
    expect(charge.range).toBe(0);
    expect(traitValue(charge.traits, 'AP')).toBe(AP_ALL);
  });

  it('describes armour beyond its protection', () => {
    const byName = (name: string) => gear.armour.find((a) => a.name === name)!;
    const dress = byName('Battle Dress, Advanced');
    expect(dress).toMatchObject({ powered: true, group: 'Battle dress' });
    expect(dress.str).toBeGreaterThan(0);
    expect(dress.dex).toBeGreaterThan(0);
    expect(dress.slots).toBeGreaterThan(0);
    expect(dress.skill?.name).toBe('Vacc Suit');
    // protection that differs against lasers, for better and for worse
    expect(byName('Ceramic Carapace').laserProtection).toBeGreaterThan(byName('Ceramic Carapace').protection);
    expect(byName('Personal Energy Shield').laserProtection).toBeLessThan(byName('Personal Energy Shield').protection);
    expect(byName('Reflec').protection).toBe(0);
    expect(byName('Reflec').versus).toMatch(/lasers/);
    const plate = byName('Powered Plate, Basic');
    expect(plate.powered).toBe(true);
    expect(plate.str).toBeGreaterThan(0);
    expect(plate.dex).toBeLessThan(0);
    for (const a of gear.armour) expect(a.cost, a.name).toBeGreaterThan(0);
  });

  it('prices or explains every other item', () => {
    for (const e of gear.equipment!) {
      expect(e.cost !== undefined || !!e.costNote, e.name).toBe(true);
      expect(e.name.trim(), e.id).toBe(e.name);
    }
    const find = (name: string, tl?: number) => gear.equipment!.find((e) => e.name === name && (tl === undefined || e.tl === tl))!;
    expect(find('Medikit, Basic').group).toBe('Medical supplies');
    expect(find('Medikit, Basic').cost).toBeGreaterThan(0);
    expect(find('Radio Transceiver, Regional (500km)', 7).electronic).toBe(true);
    expect(find('Subdermal Armour +3').kind).toBe('augment');
    expect(find('Intrusion/2')).toMatchObject({ kind: 'software', bandwidth: 2 });
    expect(find('Heavy Plating').kind).toBe('modification');
    expect(find('Heavy Plating').slots).toBeGreaterThan(0);
    expect(find('Anagathics').kind).toBe('consumable');
    // computers halve in price and mass for each tech level above their own
    const computer = find('Portable Computer/2');
    expect(computer.electronic).toBe('computer');
    const retro = gear.variants!.find((v) => v.perTl)!;
    expect(variantFigures(computer, retro, 3)).toMatchObject({ tl: computer.tl! + 3, cost: Math.round(computer.cost! / 8), steps: 3 });
  });

  it('loads special ammunition into the weapons that take it', () => {
    const pistol = { id: 'w1', ...weaponFromDef(weapon('autopistol-tl5'), gear) };
    const loads = ammoFor(gear, pistol).map((e) => e.name);
    expect(loads).toContain('Armour Piercing Rounds');
    expect(loads).toContain('Baton Rounds');
    expect(loads).not.toContain('Fuel-air Rounds');
    // guided rounds are for rifles only from a later tech level
    expect(loads).not.toContain('Guided Rounds');
    expect(ammoFor(gear, { ammoClass: 'rifle', tl: 12 }).map((e) => e.name)).toContain('Guided Rounds');
    // armour piercing rounds give a point for each damage die
    const ap = gear.equipment!.find((e) => e.name === 'Armour Piercing Rounds')!;
    const dice = parseDamage(pistol.damage)!.dice;
    expect(withAmmo(pistol, ap.ammo)).toMatchObject({ damage: pistol.damage, traits: [`AP ${dice}`] });
    expect(loadedWeapon({ ...pistol, load: { id: ap.id, name: ap.name } }, gear).traits).toEqual([`AP ${dice}`]);
    // energy weapons take none of it
    expect(ammoFor(gear, weaponFromDef(weapon('laser-rifle-tl9'), gear))).toEqual([]);
    expect(hasTrait(withAmmo(weaponFromDef(weapon('rocket-launcher-tl6'), gear), gear.equipment!.find((e) => e.name === 'Incendiary Rounds')!.ammo).traits, 'Fire')).toBe(true);
  });

  it('works out how hard a thing is to find', () => {
    const world = marketWorld({ name: 'Regina', uwp: 'A788899-C' }, pack.world);
    const here = availability(gear.availability, world, { tl: 12 });
    expect(here.parts.map((p) => p.label)).toContain('Class A starport');
    expect(here.skills).toEqual(['Broker', 'Streetwise']);
    // two tech levels above the world, and bought on the black market at law level 9
    const above = availability(gear.availability, world, { tl: 14 });
    expect(above.dm).toBe(here.dm - 1);
    const shady = availability(gear.availability, world, { tl: 12, blackMarket: '4' });
    const category = gear.availability!.blackMarket!.categories.find((c) => c.id === '4')!;
    expect(shady.skills).toEqual(['Streetwise']);
    expect(shady.priceMult).toBe(category.priceMult);
    expect(shady.dm).toBeLessThan(here.dm);
  });

  describe('at the table', () => {
    let table: Table;
    let ann: Awaited<ReturnType<Table['join']>>;
    let jax: string;

    beforeAll(async () => {
      table = await setTable({}, {}, ['mgt2-supply']);
      ann = await table.join('Ann');
      jax = (await ann.client.act('character.create', { name: 'Jax', chars: { STR: 7, DEX: 9, END: 8, INT: 8, EDU: 7, SOC: 7 } })).id;
      await ann.client.act('entity.patch', { id: jax, ops: [{ op: 'set', path: ['credits'], value: 20000 }] });
    });
    afterAll(async () => {
      await table.close();
    });

    it('sells from the catalogue', async () => {
      const kitDef = gear.equipment!.find((e) => e.id === 'medikit-basic-tl8')!;
      const suitDef = gear.armour.find((a) => a.id === 'vacc-suit-tl10')!;
      const kit = await ann.client.act('item.create', { holderId: jax, defKind: 'equipment', defId: kitDef.id, pay: true });
      expect(kit.paid).toBe(kitDef.cost);
      await eventually(() => expect(ann.client.get<Item>(kit.id)).toMatchObject({ name: 'Medikit, Basic', kg: kitDef.kg, value: kitDef.cost, category: 'gear' }));
      const suit = await ann.client.act('item.create', { holderId: jax, defKind: 'armour', defId: suitDef.id, pay: true, equip: true });
      expect(suit.paid).toBe(suitDef.cost);
      await eventually(() => expect(ann.client.get<Character>(jax)!.credits).toBe(20000 - kitDef.cost! - suitDef.cost));
      expect(ann.client.get<Character>(jax)!.armour![0]).toMatchObject({ name: 'Vacc Suit, Improved (TL10)', protection: suitDef.protection, skill: suitDef.skill });
    });
  });
});
