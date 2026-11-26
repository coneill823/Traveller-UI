import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Character, Encounter } from '../src/shared/types';
import { eventually, HAS_CORE_RULES, setTable, type Table } from './helpers';

describe('encounters on the server', () => {
  let table: Table;
  let ann: Awaited<ReturnType<Table['join']>>;
  let bob: Awaited<ReturnType<Table['join']>>;
  let jax: string;
  let mira: string;
  let enc: string;

  const view = (who: { client: Table['gm'] }) => who.client.get<Encounter>(enc)!;
  const gmView = () => table.gm.get<Encounter>(enc)!;
  const combatant = (e: Encounter, characterId: string) => e.combatants.find((c) => c.characterId === characterId)!;
  const step = (over: Record<string, unknown>) => ({ id: `s${Math.random().toString(36).slice(2, 8)}`, action: 'attack', type: 'significant', label: 'Attack', ...over });

  beforeAll(async () => {
    table = await setTable();
    ann = await table.join('Ann');
    bob = await table.join('Bob');
    jax = (await ann.client.act('character.create', { name: 'Jax', chars: { DEX: 9, END: 8, STR: 7 } })).id;
    mira = (await bob.client.act('character.create', { name: 'Mira', chars: { DEX: 6, INT: 11, END: 6 } })).id;
    enc = (await table.gm.act('encounter.create', { name: 'Ambush at the docks' })).id;
  });
  afterAll(async () => {
    await table.close();
  });

  it('starts with the party on the field and stays hidden while it is set up', async () => {
    await eventually(() => expect(gmView().combatants.map((c) => c.characterId).sort()).toEqual([jax, mira].sort()));
    expect(gmView()).toMatchObject({ status: 'setup', round: 0 });
    expect(gmView().combatants.every((c) => c.side === 'party' && c.y! > 0.5)).toBe(true);
    expect(ann.client.get(enc)).toBeUndefined();
    await table.gm.act('encounter.update', { id: enc, open: true });
    await eventually(() => expect(view(ann)).toMatchObject({ name: 'Ambush at the docks', status: 'setup' }));
    await expect(ann.client.act('encounter.update', { id: enc, name: 'Mine' })).rejects.toThrow(/Only the GM/);
  });

  it('adds NPCs on the spot, shows players only what they can see, and keeps ambushers hidden', async () => {
    const raiders = await table.gm.act('encounter.addNpc', { id: enc, name: 'Raider', copies: 2, chars: { END: 6, STR: 6, DEX: 6 }, armour: 4, skills: { 'Gun Combat (slug)': 1 }, weapons: [{ name: 'Pistol', damage: '3D-3', range: 10, skill: 'Gun Combat (slug)' }] });
    expect(raiders.combatantIds).toHaveLength(2);
    const sniper = await table.gm.act('encounter.addNpc', { id: enc, name: 'Sniper', hidden: true });
    await eventually(() => expect(view(ann).combatants).toHaveLength(4));
    expect(gmView().combatants).toHaveLength(5);
    const seen = view(ann).combatants.find((c) => c.id === raiders.combatantIds[0])!;
    expect(seen).toMatchObject({ side: 'enemy', label: 'Raider 1', seen: { name: 'Raider 1', kind: 'npc', health: 'ok' } });
    expect(seen.y).toBeLessThan(0.5);
    // The stat block itself is not sent to players.
    expect(ann.client.get(seen.characterId)).toBeUndefined();
    expect(table.gm.get<Character>(seen.characterId)).toMatchObject({ name: 'Raider 1', armour: [{ protection: 4, worn: true }] });
    expect(view(ann).combatants.some((c) => c.id === sniper.combatantIds[0])).toBe(false);
    // Each copy has its own sheet, so its own wounds.
    const sheets = raiders.characterIds as string[];
    expect(new Set(sheets).size).toBe(2);
    await expect(ann.client.act('encounter.addNpc', { id: enc, name: 'Friend' })).rejects.toThrow(/Only the GM/);
  });

  it('lets players place their own tokens but not each other’s', async () => {
    const mine = combatant(view(ann), jax);
    await ann.client.act('encounter.move', { id: enc, combatantId: mine.id, x: 0.4, y: 0.7 });
    await eventually(() => expect(combatant(view(bob), jax)).toMatchObject({ x: 0.4, y: 0.7 }));
    await expect(bob.client.act('encounter.move', { id: enc, combatantId: mine.id, x: 0.1, y: 0.1 })).rejects.toThrow(/your own token/);
    const raider = view(ann).combatants.find((c) => c.side === 'enemy')!;
    await expect(ann.client.act('encounter.move', { id: enc, combatantId: raider.id, x: 0.1, y: 0.1 })).rejects.toThrow(/your own token/);
    await table.gm.act('encounter.move', { id: enc, combatantId: raider.id, x: 0.45, y: 0.3 });
    await expect(ann.client.act('encounter.move', { id: enc, combatantId: mine.id, x: 1.4, y: 0.7 })).rejects.toThrow();
  });

  it('rolls initiative and runs the round in order', async () => {
    // Players can type in what they rolled at the table; the GM fixes the rest for this test.
    await ann.client.act('encounter.combatant', { id: enc, combatantId: combatant(view(ann), jax).id, patch: { initiative: 4 } });
    await expect(ann.client.act('encounter.combatant', { id: enc, combatantId: combatant(view(ann), mira).id, patch: { initiative: 9 } })).rejects.toThrow(/not your character/);
    await expect(ann.client.act('encounter.combatant', { id: enc, combatantId: combatant(view(ann), jax).id, patch: { hidden: true } })).rejects.toThrow(/Only the GM/);
    const e = gmView();
    const [r1, r2] = e.combatants.filter((c) => c.label?.startsWith('Raider'));
    const sniper = e.combatants.find((c) => c.label === 'Sniper')!;
    await table.gm.act('encounter.combatant', { id: enc, combatantId: combatant(e, mira).id, patch: { initiative: 1 } });
    await table.gm.act('encounter.combatant', { id: enc, combatantId: r1.id, patch: { initiative: 2 } });
    await table.gm.act('encounter.combatant', { id: enc, combatantId: r2.id, patch: { initiative: -1 } });
    await table.gm.act('encounter.combatant', { id: enc, combatantId: sniper.id, patch: { initiative: 6 } });
    await table.gm.act('encounter.start', { id: enc });
    await eventually(() => expect(gmView()).toMatchObject({ status: 'active', round: 1, turn: sniper.id }));
    // Starting the fight brings every player's screen to it; the GM stays where they are.
    await eventually(() => expect(ann.client.events.some((e) => e.ev === 'navigate' && e.d.path === `/combat/${enc}` && /Combat has begun/.test(e.d.note))).toBe(true));
    expect(table.gm.events.some((e) => e.ev === 'navigate')).toBe(false);
    // The sniper is hidden: players are not told whose turn it is.
    await eventually(() => expect(view(ann).status).toBe('active'));
    expect(view(ann).turn).toBeUndefined();
    await expect(ann.client.act('encounter.publish', { id: enc, combatantId: combatant(view(ann), jax).id, steps: [] })).rejects.toThrow(/not your turn/);
    await table.gm.act('encounter.next', { id: enc });
    await eventually(() => expect(view(ann).turn).toBe(combatant(view(ann), jax).id));
  });

  it.skipIf(!HAS_CORE_RULES)('publishes a turn: moves the token, applies damage through armour and passes play on', async () => {
    const me = combatant(view(ann), jax);
    const raider = view(ann).combatants.find((c) => c.label === 'Raider 1')!;
    const events = bob.client.events.length;
    const res = await ann.client.act('encounter.publish', {
      id: enc,
      combatantId: me.id,
      steps: [
        { id: 'a', action: 'move', type: 'minor', label: 'Move', to: { x: 0.5, y: 0.5 }, done: true },
        step({ id: 'b', targetId: raider.id, weapon: 'Autopistol', roll: { total: 10 }, damage: 16, done: true }),
      ],
    });
    expect(res.recordId).toBeTruthy();
    await eventually(() => {
      const e = view(bob);
      expect(e.log).toHaveLength(1);
      const record = e.log[0];
      expect(record).toMatchObject({ round: 1, combatantId: me.id, by: ann.id });
      // 10 against 8 is Effect 2, added to the 16 rolled: 18 dealt.
      expect(record.results[0]).toMatchObject({ stepId: 'a', from: { x: 0.4, y: 0.7 }, to: { x: 0.5, y: 0.5 } });
      expect(record.results[1]).toMatchObject({ stepId: 'b', targetId: raider.id, hit: true, effect: 2, dealt: 18, status: 'unconscious' });
      // Players are not told how much the raider's armour stopped.
      expect(record.results[1].absorbed).toBeUndefined();
      expect(record.results[1].taken).toBeUndefined();
      expect(combatant(e, jax)).toMatchObject({ x: 0.5, y: 0.5, acted: true });
      expect(e.combatants.find((c) => c.id === raider.id)).toMatchObject({ out: true, seen: { health: 'unconscious' } });
    });
    const gmRecord = gmView().log[0];
    expect(gmRecord.results[1]).toMatchObject({ dealt: 18, absorbed: 4, taken: 14 });
    expect(table.gm.get<Character>(raider.characterId)!.chars).toMatchObject({ END: { value: 0, max: 6 }, STR: { value: 0 }, DEX: { value: 4 } });
    expect(bob.client.events.slice(events).some((ev) => ev.ev === 'encounter.turn' && ev.d.recordId === res.recordId)).toBe(true);
    // Raider 1 is down, so play passes over them to Mira.
    expect(view(bob).turn).toBe(combatant(view(bob), mira).id);
  });

  it.skipIf(!HAS_CORE_RULES)('logs reactions, hides what hidden combatants do and starts the next round', async () => {
    const mine = combatant(view(bob), mira);
    await ann.client.act('encounter.react', { id: enc, combatantId: combatant(view(ann), jax).id, action: 'dodge' });
    await eventually(() => expect(combatant(view(bob), jax).reactions).toBe(1));
    expect(view(bob).log.at(-1)).toMatchObject({ reaction: true, steps: [{ label: 'Dodge', type: 'reaction' }] });
    // Mira misses: no damage is applied.
    const raider2 = view(bob).combatants.find((c) => c.label === 'Raider 2')!;
    await bob.client.act('encounter.publish', { id: enc, combatantId: mine.id, steps: [step({ id: 'm', targetId: raider2.id, roll: { total: 6 }, damage: 12 })] });
    await eventually(() => expect(view(ann).log.at(-1)!.results[0]).toMatchObject({ hit: false, effect: -2 }));
    expect(view(ann).log.at(-1)!.results[0].dealt).toBeUndefined();
    expect(table.gm.get<Character>(raider2.characterId)!.chars!.END!.value).toBe(6);
    // Raider 2 (run by the GM) shoots Jax; then the round turns over.
    await eventually(() => expect(gmView().turn).toBe(raider2.id));
    await table.gm.act('encounter.publish', { id: enc, combatantId: raider2.id, steps: [step({ id: 'r', targetId: combatant(gmView(), jax).id, roll: { total: 9 }, damage: 5 })] });
    await eventually(() => {
      expect(view(ann).round).toBe(2);
      expect(ann.client.get<Character>(jax)!.chars!.END).toMatchObject({ value: 2, max: 8 });
    });
    expect(view(ann).combatants.every((c) => !c.acted)).toBe(true);
    // The sniper acts unseen: the GM has the record, the players do not.
    const sniper = gmView().combatants.find((c) => c.label === 'Sniper')!;
    expect(gmView().turn).toBe(sniper.id);
    const before = view(ann).log.length;
    await table.gm.act('encounter.publish', { id: enc, combatantId: sniper.id, steps: [step({ id: 'x', action: 'aim', type: 'minor', label: 'Aim' })] });
    await eventually(() => expect(gmView().log.at(-1)!.combatantId).toBe(sniper.id));
    expect(view(ann).log).toHaveLength(before);
    // Revealing the sniper shows them, and what they did, from then on.
    await table.gm.act('encounter.combatant', { id: enc, combatantId: sniper.id, patch: { hidden: false } });
    await eventually(() => expect(view(ann).combatants.some((c) => c.id === sniper.id)).toBe(true));
    expect(view(ann).log.length).toBe(before + 1);
  });

  it('ends, and a deleted character leaves the field', async () => {
    const raider2 = gmView().combatants.find((c) => c.label === 'Raider 2')!;
    await table.gm.act('entity.delete', { id: raider2.characterId });
    await eventually(() => expect(gmView().combatants.some((c) => c.id === raider2.id)).toBe(false));
    await table.gm.act('encounter.end', { id: enc });
    await eventually(() => expect(view(ann)).toMatchObject({ status: 'ended' }));
    expect(view(ann).turn).toBeUndefined();
    await expect(table.gm.act('encounter.update', { id: enc, map: { url: 'https://example.com/map.png', width: 100, height: 100 } })).rejects.toThrow(/uploaded to this server/);
    await table.gm.act('encounter.update', { id: enc, map: { url: '/uploads/abc.png', width: 1200, height: 800, squares: 24, showGrid: true } });
    await eventually(() => expect(view(ann).map).toEqual({ url: '/uploads/abc.png', width: 1200, height: 800, squares: 24, showGrid: true }));
  });
});
