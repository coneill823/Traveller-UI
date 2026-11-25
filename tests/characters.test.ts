import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergePacks, type RulePack } from '../src/shared/rulepack';
import { applyDamage, attackDm, carryLimit, charDm, checkDm, parseDamage, rangeBand, rollWeaponDamage, skillLevel, splitSkill, traitValue, unskilledDm } from '../src/shared/rules/character';
import type { Character, CharacterWeapon, Roll } from '../src/shared/types';
import { eventually, HAS_CORE_RULES, RULEPACK_DIR, setTable, type Table } from './helpers';

function loadPack(): RulePack {
  let pack: RulePack = { packs: [] };
  const dir = path.join(RULEPACK_DIR, 'mgt2-core');
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.json') && file !== 'pack.json') pack = mergePacks(pack, { packs: [], [path.basename(file, '.json')]: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) } as RulePack);
  }
  return pack;
}

const sheet = (over: Partial<Character> = {}): Character => ({
  id: 'c1',
  type: 'character',
  rev: 1,
  createdAt: 0,
  updatedAt: 0,
  kind: 'pc',
  name: 'Jax',
  chars: { STR: { value: 7, max: 7 }, DEX: { value: 9, max: 9 }, END: { value: 8, max: 8 }, INT: { value: 12, max: 12 }, EDU: { value: 5, max: 5 }, SOC: { value: 2, max: 2 } },
  skills: { 'Pilot (spacecraft)': 2, 'Gun Combat (slug)': 1, 'Melee (blade)': 1, Admin: 0, 'Athletics (strength)': 1 },
  ...over,
});

describe('skills without a rules pack', () => {
  it('splits skill names and resolves specialities', () => {
    expect(splitSkill('Pilot (small craft)')).toEqual({ base: 'Pilot', speciality: 'small craft' });
    expect(splitSkill('Admin')).toEqual({ base: 'Admin' });
    const skills = { 'Pilot (spacecraft)': 2, Admin: 0 };
    expect(skillLevel(skills, 'Pilot (spacecraft)')).toBe(2);
    // Another speciality of a skill you have counts as level 0, not unskilled.
    expect(skillLevel(skills, 'Pilot (small craft)')).toBe(0);
    expect(skillLevel(skills, 'pilot')).toBe(2);
    expect(skillLevel(skills, 'Admin')).toBe(0);
    expect(skillLevel(skills, 'Medic')).toBeNull();
    expect(skillLevel(undefined, 'Medic')).toBeNull();
  });

  it('parses damage dice and trait values', () => {
    expect(parseDamage('3D-3')).toEqual({ dice: 3, mod: -3, destructive: false });
    expect(parseDamage('1D+2')).toEqual({ dice: 1, mod: 2, destructive: false });
    expect(parseDamage('2DD')).toEqual({ dice: 2, mod: 0, destructive: true });
    expect(parseDamage('')).toBeNull();
    expect(parseDamage('as grenade')).toBeNull();
    expect(traitValue(['AP 5', 'Auto 3', 'Scope'], 'Auto')).toBe(3);
    expect(traitValue(['Scope'], 'AP')).toBe(0);
  });
});

describe.skipIf(!HAS_CORE_RULES)('character rules from the core pack', () => {
  const pack = HAS_CORE_RULES ? loadPack() : ({ packs: [] } as RulePack);

  it('gives the characteristic modifiers', () => {
    expect([0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 18].map((n) => charDm(n, pack.tasks))).toEqual([-3, -2, -2, -1, -1, 0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it('builds check modifiers, including the unskilled penalty and Jack-of-all-Trades', () => {
    const c = sheet();
    expect(checkDm(c, { char: 'DEX', skill: 'Pilot (spacecraft)' }, pack)).toMatchObject({ dm: 3 });
    expect(checkDm(c, { char: 'INT', skill: 'Medic', extra: -1 }, pack)).toMatchObject({ dm: 2 - 3 - 1 });
    expect(checkDm(c, { char: 'SOC' }, pack).dm).toBe(-2);
    expect(unskilledDm({ 'Jack-of-All-Trades': 2 }, pack)).toBe(-1);
    expect(unskilledDm({ 'Jack-of-All-Trades': 3 }, pack)).toBe(0);
    expect(unskilledDm({ 'Jack-of-All-Trades': 5 }, pack)).toBe(0);
    expect(checkDm(sheet({ skills: { 'Jack-of-All-Trades': 1 } }), { char: 'EDU', skill: 'Medic' }, pack).dm).toBe(-1 - 2);
  });

  it('works out attack modifiers', () => {
    const c = sheet();
    const rifle: CharacterWeapon = { id: 'w1', name: 'Rifle', skill: 'Gun Combat (slug)', damage: '3D', range: 250 };
    expect(attackDm(c, rifle, {}, pack).dm).toBe(1 + 1);
    expect(attackDm(c, rifle, { band: 'long', mods: { aim: 2, cover: 1 } }, pack).dm).toBe(2 - 2 + 2 - 2);
    // Aiming is capped at +6; unknown modifiers are ignored.
    expect(attackDm(c, rifle, { mods: { aim: 9, nonsense: 1 } }, pack).dm).toBe(2 + 6);
    // Melee uses the better of STR and DEX unless told otherwise.
    const blade: CharacterWeapon = { id: 'w2', name: 'Blade', skill: 'Melee (blade)', damage: '2D', range: 'melee' };
    expect(attackDm(c, blade, {}, pack)).toMatchObject({ dm: 1 + 1, char: 'DEX' });
    expect(attackDm(c, blade, { char: 'STR' }, pack)).toMatchObject({ dm: 0 + 1, char: 'STR' });
    // Bulky weapons punish weak users: STR 7 has DM 0, one short of the +1 needed.
    const shotgun: CharacterWeapon = { id: 'w3', name: 'Shotgun', skill: 'Gun Combat (slug)', damage: '4D', range: 50, traits: ['Bulky'] };
    expect(attackDm(c, shotgun, {}, pack).dm).toBe(2 - 1);
    expect(attackDm(sheet({ chars: { ...c.chars, STR: { value: 9, max: 9 } } }), shotgun, {}, pack).dm).toBe(2);
  });

  it('classifies range bands', () => {
    const combat = pack.combat;
    expect(rangeBand(250, 50, combat)).toBe('short');
    expect(rangeBand(250, 90, combat)).toBe('normal');
    // Beyond 100 m is extreme without an aimed scope…
    expect(rangeBand(250, 200, combat)).toBe('extreme');
    expect(rangeBand(250, 200, combat, true)).toBe('normal');
    expect(rangeBand(250, 400, combat, true)).toBe('long');
    expect(rangeBand(250, 900, combat, true)).toBe('extreme');
    expect(rangeBand(250, 1200, combat, true)).toBe('out');
    expect(rangeBand(10, 2, combat)).toBe('short');
    expect(rangeBand('melee', 1, combat)).toBeNull();
  });

  it('rolls weapon damage with effect, strength, bursts and destructive weapons', () => {
    const c = sheet({ chars: { ...sheet().chars, STR: { value: 12, max: 12 } } });
    const fixed = (values: number[]) => {
      let i = 0;
      return () => (values[i++ % values.length] - 0.5) / 6;
    };
    const blade: CharacterWeapon = { id: 'w', name: 'Blade', skill: 'Melee (blade)', damage: '2D', range: 'melee' };
    expect(rollWeaponDamage(c, blade, { effect: 3 }, pack, fixed([4, 5]))).toMatchObject({ dice: [4, 5], mod: 3 + 2, total: 14 });
    const gauss: CharacterWeapon = { id: 'w', name: 'Gauss Rifle', skill: 'Gun Combat (slug)', damage: '4D', range: 600, traits: ['AP 5', 'Auto 3', 'Scope'] };
    expect(rollWeaponDamage(c, gauss, { effect: 1, burst: true }, pack, fixed([1, 2, 3, 4]))).toMatchObject({ total: 10 + 1 + 3, ap: 5 });
    const fusion: CharacterWeapon = { id: 'w', name: 'FGHP-14', skill: 'Heavy Weapons (portable)', damage: '2DD', range: 450, traits: ['Radiation'] };
    expect(rollWeaponDamage(c, fusion, { effect: 2 }, pack, fixed([6, 6]))).toMatchObject({ total: 140, notes: ['Destructive ×10', 'Radiation'] });
    expect(rollWeaponDamage(c, { ...blade, damage: '' }, { effect: 2 }, pack)).toBeNull();
    // Dice typed in from the table are used as given.
    expect(rollWeaponDamage(c, blade, { effect: 0, manual: [6, 6] }, pack)!.total).toBe(14);
  });

  it('applies damage to END first, then STR or DEX, with armour and status', () => {
    const c = sheet({ armour: [{ id: 'a', name: 'Cloth', protection: 5, worn: true }, { id: 'b', name: 'Spare', protection: 9, worn: false }, { id: 'r', name: 'Reflec', protection: 0, laserProtection: 10, worn: true }] });
    // 9 damage, 5 stopped by armour, 4 off END.
    expect(applyDamage(c, 9, {}, pack)).toMatchObject({ taken: 4, absorbed: 5, status: 'wounded', chars: { END: { value: 4 } } });
    // AP ignores armour; damage past END goes to the chosen characteristic.
    const hurt = applyDamage(c, 15, { ap: 5, prefer: 'STR' }, pack);
    expect(hurt.chars).toMatchObject({ END: { value: 0 }, STR: { value: 0 }, DEX: { value: 9 } });
    expect(hurt.status).toBe('unconscious');
    // …and spills into the last characteristic; all three at zero is death.
    expect(applyDamage(c, 40, { armour: false }, pack)).toMatchObject({ status: 'dead', chars: { END: { value: 0 }, STR: { value: 0 }, DEX: { value: 0 } } });
    // Lasers meet the reflec as well.
    expect(applyDamage(c, 12, { laser: true }, pack).taken).toBe(0);
    // A solid hit (Effect 6+) always does at least one point.
    expect(applyDamage(c, 3, { effect: 6 }, pack).taken).toBe(1);
    expect(applyDamage(c, 3, { effect: 5 }, pack).taken).toBe(0);
    // Stun only touches END and knocks the target out for the excess.
    expect(applyDamage(c, 20, { stun: true, armour: false }, pack)).toMatchObject({ status: 'unconscious', stunnedRounds: 12, chars: { END: { value: 0 }, STR: { value: 7 }, DEX: { value: 9 } } });
  });

  it('computes carrying capacity', () => {
    expect(carryLimit(sheet())).toBe(7 + 8 + 1);
  });
});

describe.skipIf(!HAS_CORE_RULES)('character sheets on the server', () => {
  let table: Table;
  let ann: Awaited<ReturnType<Table['join']>>;
  let bob: Awaited<ReturnType<Table['join']>>;
  let jax: string;

  beforeAll(async () => {
    table = await setTable();
    ann = await table.join('Ann');
    bob = await table.join('Bob');
  });
  afterAll(async () => {
    await table.close();
  });

  it('lets a player create and edit their own character, which the party can see', async () => {
    jax = (await ann.client.act('character.create', { name: 'Jax', species: 'Aslan', chars: { STR: 9, DEX: 9, END: 8, INT: 7, EDU: 6, SOC: 5 } })).id;
    await eventually(() => expect(bob.client.get<Character>(jax)).toMatchObject({ name: 'Jax', species: 'Aslan', ownerId: ann.id }));
    // Species traits and natural weapons arrive with the sheet.
    expect(ann.client.get<Character>(jax)!.weapons![0]).toMatchObject({ name: 'Dewclaw', damage: '1D+2' });
    await ann.client.act('entity.patch', {
      id: jax,
      ops: [
        { op: 'set', path: ['skills', 'Pilot (spacecraft)'], value: 2 },
        { op: 'set', path: ['secrets'], value: 'I am the missing heir.' },
        { op: 'push', path: ['weapons'], value: { id: 'w_rifle', name: 'Rifle', skill: 'Gun Combat (slug)', damage: '3D', range: 250, magazine: 5, ammo: 5 } },
        { op: 'push', path: ['armour'], value: { id: 'a_cloth', name: 'Cloth', protection: 5, worn: true } },
      ],
    });
    await eventually(() => expect(bob.client.get<Character>(jax)!.skills).toEqual({ 'Pilot (spacecraft)': 2 }));
    // Private notes stay with the owner and the GM.
    expect(ann.client.get<Character>(jax)!.secrets).toMatch(/heir/);
    expect(table.gm.get<Character>(jax)!.secrets).toMatch(/heir/);
    expect(bob.client.get<Character>(jax)!.secrets).toBeUndefined();
    await expect(bob.client.act('entity.patch', { id: jax, ops: [{ op: 'set', path: ['name'], value: 'Hacked' }] })).rejects.toThrow(/cannot edit/);
    await expect(ann.client.act('entity.patch', { id: jax, ops: [{ op: 'set', path: ['ownerId'], value: bob.id }] })).rejects.toThrow();
    await expect(ann.client.act('character.create', { kind: 'npc', name: 'Sneaky' })).rejects.toThrow(/only create their own/);
  });

  it('rolls checks from the sheet with a visible breakdown', async () => {
    const r = await ann.client.act('character.check', { id: jax, skill: 'Pilot (spacecraft)', target: 10, dm: -1 });
    // DEX 9 (+1), Pilot 2, situation -1.
    expect(r.dm).toBe(2);
    await eventually(() => expect(bob.client.get<Roll>(r.id)).toMatchObject({ actor: 'Jax', kind: 'check', target: 10, label: 'Pilot (spacecraft) · DEX' }));
    expect(bob.client.get<Roll>(r.id)!.breakdown).toEqual([{ label: 'DEX 9', dm: 1 }, { label: 'Pilot (spacecraft) 2', dm: 2 }, { label: 'Situation', dm: -1 }]);
    // Unskilled, with table dice and a bane.
    const u = await ann.client.act('character.check', { id: jax, skill: 'Medic', char: 'EDU', manual: [6, 5, 2], mode: 'bane' });
    expect(u).toMatchObject({ dm: -3, dice: [5, 2], total: 4, effect: -4 });
    await expect(ann.client.act('character.check', { id: jax, skill: 'Medic', manual: [6, 5] , mode: 'bane' })).rejects.toThrow(/Enter 3 dice/);
    await expect(bob.client.act('character.check', { id: jax, skill: 'Medic' })).rejects.toThrow(/not your character/);
  });

  it('attacks, spends ammunition and rolls damage', async () => {
    const a = await ann.client.act('character.attack', { id: jax, weaponId: 'w_rifle', band: 'short', mods: { aim: 1 }, manual: [5, 4] });
    // DEX +1, Gun Combat unskilled -3, short +1, aim +1 = 0.
    expect(a).toMatchObject({ dm: 0, total: 9, effect: 1, hit: true, damageDice: 3 });
    await eventually(() => expect(ann.client.get<Character>(jax)!.weapons!.find((w) => w.id === 'w_rifle')!.ammo).toBe(4));
    const d = await ann.client.act('character.weaponDamage', { id: jax, weaponId: 'w_rifle', effect: a.effect, manual: [3, 3, 3] });
    expect(d.total).toBe(10);
    await eventually(() => expect(bob.client.get<Roll>(d.id)).toMatchObject({ kind: 'damage', label: 'Damage: Rifle', total: 10 }));
    for (let i = 0; i < 4; i++) await ann.client.act('character.attack', { id: jax, weaponId: 'w_rifle' });
    await expect(ann.client.act('character.attack', { id: jax, weaponId: 'w_rifle' })).rejects.toThrow(/empty/);
    await ann.client.act('character.reload', { id: jax, weaponId: 'w_rifle' });
    await eventually(() => expect(ann.client.get<Character>(jax)!.weapons!.find((w) => w.id === 'w_rifle')!.ammo).toBe(5));
    await expect(ann.client.act('character.attack', { id: jax, weaponId: 'w_rifle', fire: 'burst' })).rejects.toThrow(/cannot fire bursts/);
    // Natural weapons add STR to damage: Dewclaw 1D+2, STR 9 (+1), effect 2.
    const claw = ann.client.get<Character>(jax)!.weapons![0];
    const cd = await ann.client.act('character.weaponDamage', { id: jax, weaponId: claw.id, effect: 2, manual: [4] });
    expect(cd.total).toBe(4 + 2 + 2 + 1);
  });

  it('takes damage through armour and heals', async () => {
    const hit = await ann.client.act('character.damage', { id: jax, amount: 10 });
    expect(hit).toMatchObject({ taken: 5, absorbed: 5, status: 'wounded' });
    await eventually(() => expect(bob.client.get<Character>(jax)!.chars!.END).toEqual({ value: 3, max: 8 }));
    const down = await table.gm.act('character.damage', { id: jax, amount: 20, prefer: 'DEX' });
    expect(down.status).toBe('unconscious');
    await eventually(() => expect(bob.client.get<Character>(jax)!.conditions).toContain('Unconscious'));
    await ann.client.act('character.heal', { id: jax, full: true });
    await eventually(() => expect(bob.client.get<Character>(jax)).toMatchObject({ chars: { END: { value: 8 }, DEX: { value: 9 }, STR: { value: 9 } }, conditions: [] }));
  });

  it('keeps NPCs hidden until the GM reveals them, stats last', async () => {
    const npc = (await table.gm.act('character.create', { kind: 'npc', name: 'Captain Vos', title: 'Pirate captain', chars: { STR: 10, DEX: 8, END: 9, INT: 9, EDU: 7, SOC: 6 } })).id;
    await eventually(() => expect(table.gm.get(npc)).toBeDefined());
    expect(ann.client.get(npc)).toBeUndefined();
    await table.gm.act('reveal.set', { ids: [npc], facets: ['exists'], audience: 'party', on: true });
    await eventually(() => expect(ann.client.get<Character>(npc)).toMatchObject({ kind: 'npc' }));
    expect(ann.client.get<Character>(npc)!.name).toBeUndefined();
    expect(ann.client.get<Character>(npc)!.chars).toBeUndefined();
    await table.gm.act('reveal.set', { ids: [npc], facets: ['name'], audience: 'party', on: true });
    await eventually(() => expect(ann.client.get<Character>(npc)).toMatchObject({ name: 'Captain Vos', title: 'Pirate captain' }));
    expect(ann.client.get<Character>(npc)!.chars).toBeUndefined();
    await expect(ann.client.act('character.check', { id: npc, char: 'STR' })).rejects.toThrow(/not your character/);
    // The GM rolls for NPCs, in secret if they like.
    const secret = await table.gm.act('character.check', { id: npc, char: 'INT', to: 'gm' });
    await eventually(() => expect(table.gm.get(secret.id)).toBeDefined());
    expect(ann.client.get(secret.id)).toBeUndefined();
  });
});
