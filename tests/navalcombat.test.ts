import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RulePack } from '../src/shared/rulepack';
import { ammoOf, attackDm, missileFlight, resolveHit, salvoArriving, shrugsOff, weaponProfile } from '../src/shared/rules/space';
import type { Battle, Ship } from '../src/shared/types';
import { eventually, HAS_CORE_RULES, hasPack, loadPacks, setTable, type Table } from './helpers';

const HAS_PACK = HAS_CORE_RULES && hasPack('mgt2-highguard');

/** Heavier weapons and bigger ships in a fight. Skipped where the naval pack is not installed. */
describe.skipIf(!HAS_PACK)('space combat with the High Guard pack', () => {
  const pack = HAS_PACK ? loadPacks('mgt2-core', 'mgt2-highguard') : ({ packs: [] } as RulePack);
  const rules = pack.space!;
  const profile = (name: string) => weaponProfile(pack.ships, rules, name);
  const dmOf = (ctx: Parameters<typeof attackDm>[1]) => attackDm(rules, ctx).dm;

  describe('what a weapon brings to the fight', () => {
    it('reads attack DMs, damage multiples and armour piercing from the weapon itself', () => {
      expect(profile('Beam laser')).toMatchObject({ attackDm: 4, multiple: undefined, ap: 0, mount: '' });
      expect(profile('particle')).toMatchObject({ name: 'Particle barbette', multiple: 3, mount: 'barbette' });
      // a turret particle beam is not the barbette: no multiple
      expect(profile('Particle beam').multiple).toBeUndefined();
      expect(profile('Railgun')).toMatchObject({ ap: 4 });
      expect(profile('Small meson gun bay')).toMatchObject({ ap: Infinity, multiple: 10, mount: 'smallBay' });
      expect(profile('Ion cannon')).toMatchObject({ ion: true });
      expect(profile('Torpedo').ammo).toBe('torpedo');
      expect(profile('Small missile bay')).toMatchObject({ ammo: 'missile', multiple: undefined });
      expect(profile('Meson').multiple).toBe(1000);
    });

    it('still reads the core tables for a weapon it has no entry for', () => {
      expect(weaponProfile(undefined, rules, 'Pulse laser').attackDm).toBe(0);
      expect(weaponProfile(undefined, rules, 'pulse').attackDm).toBe(2);
      expect(weaponProfile(undefined, rules, 'Particle barbette').multiple).toBe(3);
    });

    it('makes heavy mounts clumsy against small targets', () => {
      const bay = profile('Small particle beam bay');
      expect(dmOf({ range: 'medium', profile: bay, targetTons: 400 })).toBe(-2);
      expect(dmOf({ range: 'medium', profile: bay, targetTons: 50 })).toBe(-4);
      expect(dmOf({ range: 'medium', profile: bay, targetTons: 3000 })).toBe(3);
      // missile bays are not affected
      expect(dmOf({ range: 'medium', profile: profile('Small missile bay'), targetTons: 400 })).toBe(0);
      const spinal = profile('Meson');
      expect(dmOf({ range: 'medium', profile: spinal, targetTons: 4000, attackerTons: 200_000 })).toBe(-8 + 4);
      expect(dmOf({ range: 'close', profile: spinal, targetTons: 60_000, attackerTons: 200_000 })).toBe(6 - 6);
      expect(dmOf({ range: 'close', profile: spinal, targetTons: 60_000, attackerTons: 9000 })).toBe(6 - 2);
    });

    it('counts the build quality of the mount', () => {
      const mods = pack.ships!.customising!.mods;
      const accurate = mods.find((m) => m.id === 'accurate')!;
      expect(dmOf({ range: 'medium', profile: profile('Pulse laser'), mods: [accurate] })).toBe(3);
    });
  });

  describe('what a hit does', () => {
    const target = { hull: 100, hullMax: 1000, armour: 8, crits: {} };

    it('lets armour-piercing weapons through', () => {
      expect(resolveHit(rules, target, { damage: 10, ap: 4 })).toMatchObject({ taken: 6, absorbed: 4 });
      expect(resolveHit(rules, target, { damage: 10, ap: 20 })).toMatchObject({ taken: 10, absorbed: 0 });
    });

    it('knocks out power, not hull, with an ion weapon', () => {
      expect(resolveHit(rules, target, { damage: 30, effect: 7, ion: true })).toMatchObject({ taken: 0, hullLost: 0, powerLost: 30, criticals: [] });
    });

    it('spares big ships critical hits from light weapons', () => {
      expect(shrugsOff(rules, 2000, '')).toBe(false);
      expect(shrugsOff(rules, 2001, '')).toBe(true);
      expect(shrugsOff(rules, 2001, 'smallBay')).toBe(false);
      expect(shrugsOff(rules, 50_000, 'smallBay')).toBe(true);
      expect(shrugsOff(rules, 50_000, 'mediumBay')).toBe(false);
      expect(shrugsOff(rules, 500_000, 'mediumBay')).toBe(true);
      expect(shrugsOff(rules, 500_000, 'largeBay')).toBe(false);
      expect(shrugsOff(rules, 500_000, 'spinal')).toBe(false);
    });
  });

  describe('missiles and torpedoes', () => {
    it('times a flight by the drive of the missile', () => {
      expect(missileFlight(rules, 'veryLong')).toBe(4);
      expect(missileFlight(rules, 'veryLong', 15)).toBe(2);
      expect(missileFlight(rules, 'distant', 6)).toBe(21);
      expect(missileFlight(rules, 'long', 12)).toBe(0);
    });

    it('thins a salvo out on a long flight, unless it is built to last', () => {
      const standard = ammoOf(rules, 'missile', undefined)!;
      expect(standard.id).toBe('missileStandard');
      expect(salvoArriving(rules, 12, 4, standard)).toBe(12);
      expect(salvoArriving(rules, 12, 10, standard)).toBe(3);
      expect(salvoArriving(rules, 12, 10, ammoOf(rules, 'missile', 'missileLongRange'))).toBe(12);
      expect(salvoArriving(rules, 6, 10, ammoOf(rules, 'torpedo', undefined))).toBe(6);
      expect(salvoArriving(rules, 1, 21, standard)).toBe(1);
    });
  });

  describe('in a battle on the server', () => {
    let table: Table;
    let escort: string;
    let battle: string;
    const view = () => table.gm.get<Battle>(battle)!;
    const entry = (name: string) => view().ships.find((s) => s.name === name)!;
    const act = (over: Record<string, unknown>) => ({ id: `a${Math.random().toString(36).slice(2, 8)}`, step: 'attack', action: 'fire', duty: 'gunner', label: 'Fire', ...over });
    const publish = (name: string) => table.gm.act('battle.publish', { id: battle, battleShipId: entry(name).id });
    const plan = (name: string, action: Record<string, unknown>) => table.gm.act('battle.plan', { id: battle, battleShipId: entry(name).id, op: 'add', action });
    const result = (actionId: string) => view().log.flatMap((r) => r.results).find((r) => r.actionId === actionId)!;

    beforeAll(async () => {
      table = await setTable({}, {}, ['mgt2-highguard']);
      escort = (await table.gm.act('ship.fromStock', { stock: 'closeEscort', name: 'Vigilant', party: true })).id;
      battle = (await table.gm.act('battle.create', { name: 'Fleet action' })).id;
      await table.gm.act('battle.addShip', { id: battle, name: 'Raider', quick: { tons: 400, armour: 2, hull: 160, hullMax: 160 }, range: 'long' });
      await table.gm.act('battle.addShip', { id: battle, name: 'Cruiser', quick: { tons: 5000, armour: 0, hull: 2000, hullMax: 2000 }, range: 'medium' });
      await table.gm.act('battle.addShip', { id: battle, name: 'Picket', quick: { tons: 200 }, range: 'distant' });
      const order = [['Vigilant', 10], ['Raider', 6], ['Cruiser', 4], ['Picket', 2]] as const;
      for (const [name, initiative] of order) await table.gm.act('battle.ship', { id: battle, battleShipId: entry(name).id, patch: { initiative } });
      await table.gm.act('battle.start', { id: battle });
      for (const [name] of order) await publish(name);
      await eventually(() => expect(view()).toMatchObject({ step: 'attack', turn: entry('Vigilant').id }));
    });
    afterAll(async () => {
      await table.close();
    });

    it('builds the escort with its barbettes', () => {
      const ship = table.gm.get<Ship>(escort)!;
      expect(ship).toMatchObject({ tons: 400, hullMax: 160, armour: 3 });
      expect(ship.spec!.parts.filter((p) => p.kind === 'mount').map((p) => p.key)).toEqual(expect.arrayContaining(['barbette', 'turret3']));
    });

    it('resolves an ion hit, a barbette on a big ship, a meson bay and a launch', async () => {
      await plan('Vigilant', act({ id: 'ion', targetId: entry('Raider').id, weapon: 'Ion cannon', roll: { total: 10 }, damage: 20 }));
      await plan('Vigilant', act({ id: 'barbette', targetId: entry('Cruiser').id, weapon: 'Particle barbette', roll: { total: 15 }, damage: 10 }));
      await plan('Vigilant', act({ id: 'meson', targetId: entry('Raider').id, weapon: 'Small meson gun bay', roll: { total: 9 }, damage: 12 }));
      await plan('Vigilant', act({ id: 'torps', targetId: entry('Raider').id, weapon: 'Torpedo', missiles: 3, roll: { total: 8 } }));
      await plan('Vigilant', act({ id: 'far', targetId: entry('Picket').id, weapon: 'Missile rack', missiles: 12, roll: { total: 8 } }));
      await plan('Vigilant', act({ id: 'farther', targetId: entry('Picket').id, weapon: 'Missile rack', ammo: 'missileLongRange', missiles: 12, roll: { total: 8 } }));
      await publish('Vigilant');
      await eventually(() => expect(view().log.at(-1)!.results).toHaveLength(6));
      // Ion: 20 + Effect 2 Power gone, the hull untouched.
      expect(result('ion')).toMatchObject({ hit: true, powerLost: 22, powerRounds: 1, taken: 0 });
      // Barbette: 10 + 7 = 17, tripled past no armour; Effect 7 would be a critical on a smaller ship.
      expect(result('barbette')).toMatchObject({ dealt: 17, taken: 51, shruggedOff: true });
      expect(result('barbette').criticals).toBeUndefined();
      expect(entry('Cruiser').quick).toMatchObject({ hull: 1949 });
      // Meson bay: 12 + 1 ignores the Raider's armour, ten times over.
      expect(result('meson')).toMatchObject({ dealt: 13, taken: 130, absorbed: 0 });
      expect(entry('Raider').quick!.hull).toBeLessThanOrEqual(30);
      // Torpedoes take a round to cross Long range; missiles thin out over ten rounds to Distant, long-range ones do not.
      const [torps, far, farther] = view().salvos;
      expect(torps).toMatchObject({ missiles: 3, torpedoes: true, ammo: 'torpedoStandard', impactRound: 2 });
      expect(far).toMatchObject({ missiles: 3, ammo: 'missileStandard', impactRound: 11 });
      expect(farther).toMatchObject({ missiles: 12, ammo: 'missileLongRange', impactRound: 8 });
    });

    it('stops torpedoes with point defence at half effect, and with a battery by the number rolled', async () => {
      const salvoId = view().salvos[0].id;
      await plan('Raider', act({ id: 'pd', step: 'reaction', action: 'pointDefence', label: 'Point defence', salvoId, roll: { total: 12 } }));
      await plan('Raider', act({ id: 'battery', step: 'reaction', action: 'pdBattery', duty: 'any', label: 'Point defence battery', salvoId, missiles: 1 }));
      await publish('Raider');
      await eventually(() => expect(view().log.at(-1)!.results).toHaveLength(2));
      // Effect 4 stops two torpedoes, not four; the battery takes the last.
      expect(result('pd')).toMatchObject({ missilesLeft: 1 });
      expect(result('battery')).toMatchObject({ missilesLeft: 0 });
      expect(view().salvos[0]).toMatchObject({ missiles: 0, done: true });
    });
  });
});
