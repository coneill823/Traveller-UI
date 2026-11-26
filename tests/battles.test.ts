import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Battle, Ship } from '../src/shared/types';
import { eventually, HAS_CORE_RULES, setTable, type Table } from './helpers';

describe.skipIf(!HAS_CORE_RULES)('ship status and space battles on the server', () => {
  let table: Table;
  let ann: Awaited<ReturnType<Table['join']>>;
  let bob: Awaited<ReturnType<Table['join']>>;
  let jax: string;
  let mira: string;
  let scout: string;
  let cutter: string;
  let battle: string;

  const ship = (who: { client: Table['gm'] }, id = scout) => who.client.get<Ship>(id)!;
  const view = (who: { client: Table['gm'] }) => who.client.get<Battle>(battle)!;
  const gmView = () => table.gm.get<Battle>(battle)!;
  const entry = (b: Battle, name: string) => b.ships.find((s) => s.name === name)!;
  const act = (over: Record<string, unknown>) => ({ id: `a${Math.random().toString(36).slice(2, 8)}`, step: 'attack', action: 'fire', duty: 'gunner', label: 'Fire', ...over });

  beforeAll(async () => {
    table = await setTable();
    ann = await table.join('Ann');
    bob = await table.join('Bob');
    jax = (await ann.client.act('character.create', { name: 'Jax' })).id;
    mira = (await bob.client.act('character.create', { name: 'Mira' })).id;
    await ann.client.act('entity.patch', { id: jax, ops: [{ op: 'set', path: ['skills', 'Pilot (spacecraft)'], value: 2 }] });
    scout = (await table.gm.act('ship.fromStock', { stock: 'scout', name: 'Wayfarer', party: true })).id;
    cutter = (await table.gm.act('ship.fromStock', { stock: 'patrolCorvette', name: 'Customs cutter' })).id;
  });
  afterAll(async () => {
    await table.close();
  });

  it('builds ships from stock designs, visible to players only when they are the party’s', async () => {
    await eventually(() => expect(ship(ann)).toMatchObject({ name: 'Wayfarer', tons: 100, jump: 2, thrust: 2, hull: 40, hullMax: 40, armour: 4, party: true }));
    expect(ship(ann).spec?.parts.some((p) => p.kind === 'mount')).toBe(true);
    expect(ann.client.get(cutter)).toBeUndefined();
    expect(table.gm.get<Ship>(cutter)).toMatchObject({ tons: 400, hullMax: 160, armour: 4, thrust: 4 });
    await expect(ann.client.act('ship.fromStock', { stock: 'scout' })).rejects.toThrow(/Only the GM/);
  });

  it('puts the crew at their stations', async () => {
    const turret = ship(ann).spec!.parts.find((p) => p.kind === 'mount')!.id;
    await ann.client.act('ship.duty', { shipId: scout, characterId: jax, duty: 'pilot' });
    await bob.client.act('ship.duty', { shipId: scout, characterId: mira, duty: 'gunner', mount: turret });
    await eventually(() => expect(ship(bob).duties).toEqual({ [jax]: { duty: 'pilot' }, [mira]: { duty: 'gunner', mount: turret } }));
    await expect(bob.client.act('ship.duty', { shipId: scout, characterId: jax, duty: 'engineer' })).rejects.toThrow(/your own character/);
    await expect(ann.client.act('ship.duty', { shipId: scout, characterId: jax, duty: 'cook' })).rejects.toThrow(/no such duty/);
    // There is one pilot's seat: taking it moves the last pilot out.
    await bob.client.act('ship.duty', { shipId: scout, characterId: mira, duty: 'pilot' });
    await eventually(() => expect(ship(ann).duties).toEqual({ [mira]: { duty: 'pilot' } }));
    await ann.client.act('ship.duty', { shipId: scout, characterId: jax, duty: 'pilot' });
    await bob.client.act('ship.duty', { shipId: scout, characterId: mira, duty: 'gunner', mount: turret });
    await eventually(() => expect(Object.keys(ship(ann).duties ?? {})).toHaveLength(2));
  });

  it('lets the GM land a hit that shows on the ship for everyone', async () => {
    const events = bob.client.events.length;
    await expect(ann.client.act('ship.hit', { shipId: scout, damage: 10 })).rejects.toThrow(/Only the GM/);
    // Kept under a tenth of the hull, so no further random damage comes of it.
    const res = await table.gm.act('ship.hit', { shipId: scout, damage: 6, effect: 7, location: 'mDrive', attacker: 'Corsair', weapon: 'Pulse laser' });
    // 6 less 4 armour is 2 to the hull; Effect 7 is a Severity 2 critical on the drive.
    expect(res).toMatchObject({ taken: 2, absorbed: 4, hull: 38, wrecked: false });
    expect(res.criticals[0]).toMatchObject({ location: 'mDrive', severity: 2 });
    await eventually(() => {
      const s = ship(bob);
      expect(s.hull).toBe(38);
      expect(s.crits).toEqual({ mDrive: 2 });
      expect(s.alerts).toHaveLength(2);
      const [hit, crit] = s.alerts!;
      expect(hit).toMatchObject({ kind: 'hit', title: 'Hit: Pulse laser from Corsair' });
      expect(crit).toMatchObject({ kind: 'critical', location: 'mDrive', severity: 2 });
      expect(s.spec!.parts.find((p) => p.id === crit.partId)?.kind).toBe('mdrive');
    });
    expect(bob.client.events.slice(events).some((e) => e.ev === 'ship.alert' && e.d.shipId === scout)).toBe(true);
  });

  it('raises faults, patches them up and clears alerts', async () => {
    const res = await table.gm.act('ship.fault', { shipId: scout, location: 'powerPlant', severity: 1, text: 'A coolant line has split.' });
    await eventually(() => {
      const fault = ship(ann).alerts!.find((a) => a.id === res.alertId)!;
      expect(fault).toMatchObject({ kind: 'fault', location: 'powerPlant', severity: 1, title: 'Power plant fault, severity 1' });
      expect(fault.text).toMatch(/coolant line.*Power reduced by 10%/);
      expect(ship(ann).crits).toMatchObject({ powerPlant: 1, mDrive: 2 });
    });
    const hullBefore = ship(ann).hull;
    await table.gm.act('ship.repair', { shipId: scout, location: 'powerPlant', mode: 'patch' });
    await eventually(() => expect(ship(ann).repaired).toEqual(['powerPlant']));
    expect(ship(ann).hull).toBe(hullBefore);
    await ann.client.act('ship.clearAlerts', { shipId: scout });
    await eventually(() => expect(ship(bob).alerts!.every((a) => a.cleared)).toBe(true));
    await table.gm.act('ship.repair', { shipId: scout, mode: 'restore' });
    await eventually(() => expect(ship(ann)).toMatchObject({ hull: 40, armour: 4, crits: {}, repaired: [] }));
  });

  it('sets up a battle: the party ship, a ship with a record and one with only quick figures', async () => {
    battle = (await table.gm.act('battle.create', { name: 'Skirmish off Forge' })).id;
    await table.gm.act('battle.addShip', { id: battle, shipId: cutter, range: 'long' });
    await table.gm.act('battle.addShip', { id: battle, name: 'Pirate', quick: { tons: 100, thrust: 3, armour: 0 }, range: 'short' });
    await table.gm.act('battle.addShip', { id: battle, name: 'Lurker', quick: { tons: 50 }, range: 'distant', hidden: true });
    expect(ann.client.get(battle)).toBeUndefined();
    await table.gm.act('battle.update', { id: battle, open: true });
    await eventually(() => expect(view(ann).ships.map((s) => s.name)).toEqual(['Wayfarer', 'Customs cutter', 'Pirate']));
    expect(gmView().ships).toHaveLength(4);
    const seen = entry(view(ann), 'Customs cutter');
    expect(seen).toMatchObject({ side: 'enemy', range: 'long', seen: { name: 'Customs cutter', condition: 'intact' } });
    expect(seen.quick).toBeUndefined();
    expect(entry(view(ann), 'Pirate').quick).toBeUndefined();
    expect(entry(gmView(), 'Pirate').quick).toMatchObject({ hull: 40, hullMax: 40, thrust: 3 });
    for (const [name, initiative] of [['Wayfarer', 10], ['Customs cutter', 6], ['Pirate', 3], ['Lurker', 1]] as const) {
      await table.gm.act('battle.ship', { id: battle, battleShipId: entry(gmView(), name).id, patch: { initiative } });
    }
    await table.gm.act('battle.start', { id: battle });
    await eventually(() => expect(view(ann)).toMatchObject({ status: 'active', round: 1, step: 'manoeuvre', turn: entry(view(ann), 'Wayfarer').id }));
    await eventually(() => expect(bob.client.events.some((e) => e.ev === 'navigate' && e.d.path === `/ship/battle/${battle}`)).toBe(true));
    expect(gmView().flagship).toBe(entry(gmView(), 'Wayfarer').id);
  });

  it('pools the crew’s actions into the ship’s turn and changes the range', async () => {
    const mine = entry(view(ann), 'Wayfarer');
    const pirate = entry(view(ann), 'Pirate');
    const a = act({ id: 'close', step: 'manoeuvre', action: 'range', duty: 'pilot', label: 'Change range', characterId: jax, targetId: pirate.id, thrust: 2, closing: true });
    await ann.client.act('battle.plan', { id: battle, battleShipId: mine.id, op: 'add', action: a });
    // Bob queues his shot for the attack step ahead of time, and cannot touch Ann's action.
    const shot = act({ id: 'shot', characterId: mira, targetId: entry(view(bob), 'Customs cutter').id, weapon: 'Pulse laser', weapons: 2, roll: { total: 14 }, damage: 8 });
    await bob.client.act('battle.plan', { id: battle, battleShipId: mine.id, op: 'add', action: shot });
    await expect(bob.client.act('battle.plan', { id: battle, battleShipId: mine.id, op: 'remove', actionId: 'close' })).rejects.toThrow(/someone else/);
    await expect(bob.client.act('battle.plan', { id: battle, battleShipId: mine.id, op: 'add', action: act({ id: 'x', characterId: jax }) })).rejects.toThrow(/your own character/);
    await expect(ann.client.act('battle.plan', { id: battle, battleShipId: pirate.id, op: 'add', action: act({ id: 'y' }) })).rejects.toThrow(/not your ship/);
    await eventually(() => expect(view(ann).plans[mine.id].map((x) => x.id)).toEqual(['close', 'shot']));
    await ann.client.act('battle.publish', { id: battle, battleShipId: mine.id });
    await eventually(() => {
      const b = view(bob);
      // Short range takes 2 Thrust to leave: the pirate is now Close.
      expect(entry(b, 'Pirate').range).toBe('close');
      expect(b.log.at(-1)).toMatchObject({ round: 1, step: 'manoeuvre', shipId: mine.id });
      expect(b.log.at(-1)!.results[0]).toMatchObject({ actionId: 'close', range: { from: 'short', to: 'close' } });
      // Only the manoeuvre was resolved; the shot waits for the attack step.
      expect(b.plans[mine.id].map((x) => x.id)).toEqual(['shot']);
      expect(b.turn).toBe(entry(b, 'Customs cutter').id);
    });
    await expect(ann.client.act('battle.publish', { id: battle, battleShipId: mine.id })).rejects.toThrow(/not your ship's turn/);
    // The others manoeuvre (the GM publishes for them, with nothing queued), then the attack step begins.
    for (const name of ['Customs cutter', 'Pirate', 'Lurker']) await table.gm.act('battle.publish', { id: battle, battleShipId: entry(gmView(), name).id });
    await eventually(() => expect(view(ann)).toMatchObject({ step: 'attack', turn: mine.id }));
  });

  it('resolves fire: damage, critical hits, and missiles that take time to arrive', async () => {
    const mine = entry(view(ann), 'Wayfarer');
    const cutterEntry = entry(view(ann), 'Customs cutter');
    await bob.client.act('battle.publish', { id: battle, battleShipId: mine.id });
    await eventually(() => {
      const r = view(ann).log.at(-1)!.results[0];
      // 14 against 8 is Effect 6: 8 + 6 = 14 dealt, and a critical hit.
      expect(r).toMatchObject({ actionId: 'shot', hit: true, effect: 6, dealt: 14 });
      expect(r.criticals!.length).toBeGreaterThanOrEqual(1);
      expect(r.criticals![0].severity).toBe(1);
      // How much the cutter's armour stopped is not the players' to know.
      expect(r.taken).toBeUndefined();
      expect(entry(view(ann), 'Customs cutter').seen).toMatchObject({ condition: 'damaged' });
    });
    expect(gmView().log.at(-1)!.results[0]).toMatchObject({ taken: 10, absorbed: 4 });
    expect(table.gm.get<Ship>(cutter)!.hull).toBeLessThanOrEqual(150);
    // The cutter launches three missiles at Long range: they arrive next round.
    await table.gm.act('battle.plan', { id: battle, battleShipId: cutterEntry.id, op: 'add', action: act({ id: 'launch', targetId: mine.id, weapon: 'Missile rack', missiles: 3, roll: { total: 9 } }) });
    await table.gm.act('battle.publish', { id: battle, battleShipId: cutterEntry.id });
    await eventually(() => expect(view(ann).salvos).toEqual([expect.objectContaining({ fromId: cutterEntry.id, toId: mine.id, missiles: 3, launched: 1, impactRound: 2 })]));
    expect(ship(ann).hull).toBe(40);
    // The pirate, at Close range, hits the party ship: the crew see it on their board.
    const pirate = entry(gmView(), 'Pirate');
    await table.gm.act('battle.plan', { id: battle, battleShipId: pirate.id, op: 'add', action: act({ id: 'zap', targetId: mine.id, weapon: 'Beam laser', roll: { total: 10 }, damage: 5 }) });
    await table.gm.act('battle.publish', { id: battle, battleShipId: pirate.id });
    await eventually(() => {
      // 5 + Effect 2 = 7, less 4 armour.
      expect(ship(ann).hull).toBe(37);
      expect(ship(ann).alerts!.some((a) => a.title === 'Hit: Beam laser from Pirate' && !a.cleared)).toBe(true);
    });
    await table.gm.act('battle.publish', { id: battle, battleShipId: entry(gmView(), 'Lurker').id });
    await eventually(() => expect(view(ann).step).toBe('actions'));
  });

  it('handles the actions step: leadership, sensor locks, countermeasures, repairs, and the next round', async () => {
    const mine = entry(view(ann), 'Wayfarer');
    const salvo = view(ann).salvos[0];
    await table.gm.act('ship.fault', { shipId: scout, location: 'sensors', severity: 2 });
    const plan = (action: Record<string, unknown>, who = ann) => who.client.act('battle.plan', { id: battle, battleShipId: mine.id, op: 'add', action });
    await plan(act({ id: 'lead', step: 'actions', action: 'improveInitiative', duty: 'captain', label: 'Improve initiative', characterId: jax, roll: { total: 11 } }));
    await plan(act({ id: 'lock', step: 'actions', action: 'sensorLock', duty: 'sensors', label: 'Sensor lock', characterId: mira, targetId: entry(view(bob), 'Pirate').id, roll: { total: 9 } }), bob);
    await plan(act({ id: 'ew', step: 'actions', action: 'electronicWarfare', duty: 'sensors', label: 'Electronic warfare', characterId: mira, salvoId: salvo.id, roll: { total: 12, target: 10 } }), bob);
    await plan(act({ id: 'fix', step: 'actions', action: 'repair', duty: 'engineer', label: 'Repair system', characterId: jax, location: 'sensors', roll: { total: 8 } }));
    await ann.client.act('battle.publish', { id: battle, battleShipId: mine.id });
    await eventually(() => {
      const b = view(ann);
      const results = Object.fromEntries(b.log.at(-1)!.results.map((r) => [r.actionId, r]));
      expect(results.lead).toMatchObject({ effect: 3, initiativeDm: 3 });
      expect(results.lock).toMatchObject({ lock: true });
      // Effect 2 on a Difficult check knocks two missiles out of the salvo.
      expect(results.ew).toMatchObject({ missilesLeft: 1 });
      expect(results.fix).toMatchObject({ repaired: 'sensors' });
      expect(b.salvos[0].missiles).toBe(1);
      expect(entry(b, 'Wayfarer').locks).toEqual([entry(b, 'Pirate').id]);
      expect(ship(ann).repaired).toContain('sensors');
    });
    for (const name of ['Customs cutter', 'Pirate', 'Lurker']) await table.gm.act('battle.publish', { id: battle, battleShipId: entry(gmView(), name).id });
    await eventually(() => {
      const b = view(ann);
      expect(b).toMatchObject({ round: 2, step: 'manoeuvre' });
      // The captain's Leadership check counts for this round only.
      expect(entry(b, 'Wayfarer')).toMatchObject({ initiative: 10, initiativeDm: 3 });
      expect(b.ships.every((s) => !s.acted)).toBe(true);
    });
  });

  it('resolves a salvo when it arrives: the Effect multiplies the damage, up to the missiles left', async () => {
    const mine = entry(gmView(), 'Wayfarer');
    const cutterEntry = entry(gmView(), 'Customs cutter');
    const salvo = gmView().salvos[0];
    // Skip to the attack step of round 2.
    await table.gm.act('battle.next', { id: battle, step: true });
    await eventually(() => expect(gmView().step).toBe('attack'));
    await table.gm.act('battle.next', { id: battle });
    const hull = ship(ann).hull!;
    const armour = ship(ann).armour!;
    await table.gm.act('battle.plan', { id: battle, battleShipId: cutterEntry.id, op: 'add', action: act({ id: 'impact', targetId: mine.id, weapon: 'Missile rack', salvoId: salvo.id, roll: { total: 11 }, damage: 14 }) });
    await table.gm.act('battle.publish', { id: battle, battleShipId: cutterEntry.id });
    await eventually(() => {
      const r = gmView().log.at(-1)!.results[0];
      // One missile left, so the Effect of 3 counts as 1: (14 - armour) x 1.
      expect(r).toMatchObject({ hit: true, effect: 3, dealt: 14, taken: 14 - armour });
      expect(gmView().salvos[0].done).toBe(true);
      expect(ship(ann).hull).toBeLessThanOrEqual(hull - (14 - armour));
    });
    await table.gm.act('battle.end', { id: battle });
    await eventually(() => expect(view(ann)).toMatchObject({ status: 'ended' }));
  });
});
