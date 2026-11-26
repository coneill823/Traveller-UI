import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergePacks, type RulePack } from '../src/shared/rulepack';
import { bestDm, expectedSale, freightAvailable, generateStock, negotiate, passageFare, passengersAvailable, pricePercent, purchaseDm, saleDm, type TradeWorld } from '../src/shared/rules/trade';
import type { Character, Item, Market, Ship } from '../src/shared/types';
import { parseUwp } from '../src/shared/uwp';
import { seededRng } from '../src/shared/util';
import { eventually, HAS_CORE_RULES, RULEPACK_DIR, setTable, type Table } from './helpers';

function loadPack(): RulePack {
  let pack: RulePack = { packs: [] };
  const dir = path.join(RULEPACK_DIR, 'mgt2-core');
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.json') && file !== 'pack.json') pack = mergePacks(pack, { packs: [], [path.basename(file, '.json')]: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) } as RulePack);
  }
  return pack;
}

describe.skipIf(!HAS_CORE_RULES)('trade rules from the core pack', () => {
  const pack = HAS_CORE_RULES ? loadPack() : ({ packs: [] } as RulePack);
  const rules = pack.trade!;
  const good = (code: number) => rules.goods.find((g) => g.code === code)!;
  const world = (uwp: string, codes: string[], zone: '' | 'A' | 'R' = ''): TradeWorld => ({ codes, zone, uwp: parseUwp(uwp) });
  const industrial = world('A7879A9-C', ['In', 'Hi', 'Ht']);
  const farm = world('C566675-7', ['Ag', 'Ni', 'Ri']);

  it('has the whole goods table and price table', () => {
    expect(rules.goods).toHaveLength(36);
    expect(rules.goods.filter((g) => g.availability.includes('*')).map((g) => g.code)).toEqual([11, 12, 13, 14, 15, 16]);
    expect(rules.goods.filter((g) => g.illegal).map((g) => g.code)).toEqual([61, 62, 63, 64, 65]);
    expect(pricePercent(8, 'purchase', rules)).toBe(100);
    expect(pricePercent(8, 'sale', rules)).toBe(80);
    expect(pricePercent(-9, 'purchase', rules)).toBe(300);
    expect(pricePercent(40, 'sale', rules)).toBe(400);
    expect(pricePercent(11, 'sale', rules)).toBe(100);
  });

  it('uses only the largest modifier from each column', () => {
    // Common Electronics: purchase Industrial +2, High Tech +3 → +3 on an industrial high-tech world.
    expect(bestDm(good(11).purchaseDm, industrial)).toEqual({ dm: 3, from: 'Ht' });
    expect(purchaseDm(good(11), industrial)).toBe(3);
    // Selling the same goods to a non-industrial rich farm world: Non-Industrial +2, less the Rich +1 purchase DM.
    expect(saleDm(good(11), farm)).toBe(2 - 1);
    // Travel zones count like trade codes: Advanced Weapons sell at +4 in a red zone.
    expect(saleDm(good(24), world('E555555-5', [], 'R'))).toBe(4);
    expect(saleDm(good(24), world('E555555-5', [], 'A'))).toBe(2);
  });

  it('turns a negotiation roll into a price', () => {
    // 3D of 10, Broker 2, Purchase DM +3, supplier's Broker 2 → 13 → 75% of Cr20,000.
    const buy = negotiate(good(11), industrial, 'purchase', { broker: 2, dice: [4, 3, 3] }, rules);
    expect(buy).toMatchObject({ result: 13, pct: 75, price: 15000 });
    expect(buy.parts.map((p) => p.dm)).toEqual([2, 3, -2]);
    // Selling at the farm: 10 + 2 + (2 - 1) - 2 = 11 → 100%.
    const sell = negotiate(good(11), farm, 'sale', { broker: 2, dice: [4, 3, 3] }, rules);
    expect(sell).toMatchObject({ result: 11, pct: 100, price: 20000 });
    expect(expectedSale(good(11), farm, 2, rules).pct).toBe(100);
  });

  it('stocks a market from trade codes and population', () => {
    const stock = generateStock(industrial, rules, {}, seededRng(5));
    const codes = stock.map((l) => l.good);
    // All six common goods, plus everything Industrial, High Tech and High Population worlds make.
    for (const code of [11, 12, 13, 14, 15, 16, 21, 22, 23, 24, 25, 32, 35, 36, 43, 46, 56]) expect(codes).toContain(code);
    expect(stock.every((l) => !rules.goods.find((g) => g.code === l.good)!.illegal)).toBe(true);
    expect(stock.every((l) => l.tons > 0)).toBe(true);
    // Tiny colonies have little or nothing; the black market sells only illegal goods.
    const outpost = generateStock(world('E200200-7', ['Lo', 'Va']), rules, {}, seededRng(5));
    expect(outpost.reduce((n, l) => n + l.tons, 0)).toBeLessThan(stock.reduce((n, l) => n + l.tons, 0) / 3);
    const black = generateStock(industrial, rules, { blackMarket: true }, seededRng(5));
    expect(black.length).toBeGreaterThan(0);
    expect(black.every((l) => l.illegal)).toBe(true);
  });

  it('finds passengers and freight, and prices them by distance', () => {
    const input = { origin: industrial, destination: farm, parsecs: 2, effect: 2, steward: 1 };
    const passengers = passengersAvailable(input, rules, seededRng(3));
    expect(Object.keys(passengers).sort()).toEqual(['basic', 'high', 'low', 'middle']);
    const freight = freightAvailable(input, rules, seededRng(3));
    expect(freight.length).toBeGreaterThan(0);
    for (const lot of freight) expect(lot.pay).toBe(lot.tons * 1600);
    expect(passageFare('high', 1, rules)).toBe(9000);
    expect(passageFare('low', 3, rules)).toBe(2200);
    expect(passageFare('middle', 9, rules)).toBe(130000);
    // A red zone backwater offers far less.
    const dead = { origin: world('X200000-0', ['Ba'], 'R'), destination: world('X200000-0', ['Ba'], 'R'), parsecs: 6 };
    expect(freightAvailable(dead, rules, seededRng(3))).toHaveLength(0);
  });
});

describe.skipIf(!HAS_CORE_RULES)('trading on the server', () => {
  let table: Table;
  let ann: Awaited<ReturnType<Table['join']>>;
  let bob: Awaited<ReturnType<Table['join']>>;
  let ship: string;
  let home: string;
  let away: string;
  let market: string;
  let jax: string;

  beforeAll(async () => {
    table = await setTable();
    ann = await table.join('Ann');
    bob = await table.join('Bob');
    const sectorId = (await table.gm.act('sector.create', { name: 'Kestrel Reach', x: 0, y: 0 })).id;
    home = (await table.gm.act('system.create', { sectorId, hex: '0101', name: 'Forge', uwp: 'A7879A9-C' })).id;
    away = (await table.gm.act('system.create', { sectorId, hex: '0102', name: 'Meadow', uwp: 'C566675-7' })).id;
    ship = (await table.gm.act('ship.create', { name: 'Borrowed Time', className: 'Far Trader', tons: 200, jump: 2, cargo: 60, fuelCapacity: 41, funds: 500000 })).id;
    await table.gm.act('party.moveTo', { systemId: home });
    jax = (await ann.client.act('character.create', { name: 'Jax' })).id;
    await ann.client.act('entity.patch', { id: jax, ops: [{ op: 'set', path: ['skills', 'Broker'], value: 2 }, { op: 'set', path: ['credits'], value: 3000 }] });
  });
  afterAll(async () => {
    await table.close();
  });

  it('gives the crew their ship and keeps personal kit per character', async () => {
    await eventually(() => expect(ann.client.get<Ship>(ship)).toMatchObject({ name: 'Borrowed Time', cargo: 60, funds: 500000, location: { systemId: home } }));
    const rifle = (await ann.client.act('item.create', { holderId: jax, defKind: 'weapon', defId: 'rifle-tl5', equip: true })).id;
    await eventually(() => expect(bob.client.get<Item>(rifle)).toMatchObject({ name: 'Rifle', kg: 3, value: 200, holderId: jax }));
    expect(ann.client.get<Character>(jax)!.weapons!.some((w) => w.name === 'Rifle' && w.damage === '3D')).toBe(true);
    const rope = (await ann.client.act('item.create', { holderId: jax, name: 'Rope', qty: 3, kg: 2, value: 20 })).id;
    // Bob cannot tamper with Ann's kit, but Ann can hand things over and stock the ship's locker.
    await expect(bob.client.act('item.update', { id: rope, ops: [{ op: 'set', path: ['qty'], value: 99 }] })).rejects.toThrow(/not yours/);
    await expect(bob.client.act('item.move', { id: rope, to: ship })).rejects.toThrow(/not yours/);
    const moved = (await ann.client.act('item.move', { id: rope, to: ship, qty: 2 })).id;
    await eventually(() => expect(bob.client.get<Item>(moved)).toMatchObject({ holderId: ship, qty: 2 }));
    expect(ann.client.get<Item>(rope)!.qty).toBe(1);
    // Moving the last one stacks with what is already there.
    await ann.client.act('item.move', { id: rope, to: ship });
    await eventually(() => expect(bob.client.get<Item>(moved)!.qty).toBe(3));
    expect(ann.client.get(rope)).toBeUndefined();
    await ann.client.act('funds.transfer', { from: jax, to: ship, amount: 1000 });
    await eventually(() => expect(bob.client.get<Ship>(ship)!.funds).toBe(501000));
    await expect(ann.client.act('funds.transfer', { from: jax, to: ship, amount: 999999 })).rejects.toThrow(/Not enough credits/);
    await expect(bob.client.act('funds.transfer', { from: jax, to: ship, amount: 1 })).rejects.toThrow(/not your credits/);
  });

  it('hides GM stashes and their contents until revealed', async () => {
    const cache = (await table.gm.act('stash.create', { name: 'Smuggler cache' })).id;
    const loot = (await table.gm.act('item.create', { holderId: cache, name: 'Unmarked crate', qty: 4 })).id;
    await eventually(() => expect(table.gm.get(loot)).toBeDefined());
    expect(ann.client.get(cache)).toBeUndefined();
    expect(ann.client.get(loot)).toBeUndefined();
    await table.gm.act('reveal.set', { ids: [cache], facets: ['exists'], audience: 'party', on: true });
    await eventually(() => expect(ann.client.get<Item>(loot)).toMatchObject({ name: 'Unmarked crate' }));
    await ann.client.act('item.move', { id: loot, to: ship, qty: 1 });
    await table.gm.act('reveal.set', { ids: [cache], facets: ['exists'], audience: 'party', on: false });
    await eventually(() => expect(ann.client.get(loot)).toBeUndefined());
  });

  it('keeps a market secret until the GM shares it, then lets the crew buy', async () => {
    const made = await table.gm.act('market.create', { systemId: home });
    market = made.id;
    expect(made.lots).toBeGreaterThan(10);
    await eventually(() => expect(table.gm.get<Market>(market)!.lots.length).toBe(made.lots));
    expect(ann.client.get(market)).toBeUndefined();
    await expect(ann.client.act('trade.quote', { marketId: market, lotId: 'x' })).rejects.toThrow(/do not have access/);

    await table.gm.act('reveal.set', { ids: [market], facets: ['exists'], audience: 'party', on: true });
    await eventually(() => expect(ann.client.get<Market>(market)).toMatchObject({ venue: 'surface', lots: [] }));
    await table.gm.act('reveal.set', { ids: [market], facets: ['catalogue'], audience: 'party', on: true });
    await eventually(() => expect(ann.client.get<Market>(market)!.lots.length).toBe(made.lots));

    const lot = ann.client.get<Market>(market)!.lots.find((l) => l.good === 11)!;
    await expect(ann.client.act('trade.buy', { marketId: market, lotId: lot.id, tons: 5, shipId: ship })).rejects.toThrow(/Get a price first/);
    // Jax (Broker 2) rolls 4,3,3 at the table: 10 + 2 + 3 - 2 = 13 → 75%.
    const quote = await ann.client.act('trade.quote', { marketId: market, lotId: lot.id, characterId: jax, manual: [4, 3, 3] });
    expect(quote).toMatchObject({ pct: 75, price: 15000 });
    await eventually(() => expect(bob.client.get<Market>(market)!.lots.find((l) => l.id === lot.id)!.offer).toMatchObject({ price: 15000 }));
    await expect(ann.client.act('trade.quote', { marketId: market, lotId: lot.id, characterId: jax })).rejects.toThrow(/already been quoted/);
    await expect(ann.client.act('trade.buy', { marketId: market, lotId: lot.id, tons: 100, shipId: ship })).rejects.toThrow();
    const tons = Math.min(lot.tons, 20);
    const bought = await bob.client.act('trade.buy', { marketId: market, lotId: lot.id, tons, shipId: ship });
    expect(bought.cost).toBe(15000 * tons);
    await eventually(() => expect(ann.client.get<Ship>(ship)!.funds).toBe(501000 - 15000 * tons));
    expect(ann.client.get<Item>(bought.itemId)).toMatchObject({ category: 'cargo', tons, good: 11, paid: 15000, holderId: ship, origin: { systemId: home } });
    const left = ann.client.get<Market>(market)!.lots.find((l) => l.id === lot.id);
    expect(left?.tons ?? 0).toBe(Math.round((lot.tons - tons) * 100) / 100);
  });

  it('refuses to overfill the hold or overspend, and remembers a refused deal', async () => {
    const m = ann.client.get<Market>(market)!;
    const big = m.lots.find((l) => l.good === 14 || l.good === 15)!;
    await ann.client.act('trade.quote', { marketId: market, lotId: big.id, broker: 0, manual: [3, 3, 3] });
    if (big.tons > 40) await expect(ann.client.act('trade.buy', { marketId: market, lotId: big.id, tons: big.tons, shipId: ship })).rejects.toThrow(/cargo space/);
    await ann.client.act('trade.refuse', { marketId: market, lotId: big.id });
    await expect(ann.client.act('trade.quote', { marketId: market, lotId: big.id, broker: 0 })).rejects.toThrow(/walked away/);
    // A month later the supplier will talk again.
    await table.gm.act('entity.patch', { id: 'campaign', ops: [{ op: 'set', path: ['date'], value: { day: 40, year: 1105 } }] });
    await expect(ann.client.act('trade.quote', { marketId: market, lotId: big.id, broker: 0 })).resolves.toBeDefined();
    const pricey = m.lots.find((l) => l.good === 46 || l.good === 25);
    if (pricey) {
      await ann.client.act('trade.quote', { marketId: market, lotId: pricey.id, broker: 0, manual: [1, 1, 1] });
      await expect(ann.client.act('trade.buy', { marketId: market, lotId: pricey.id, tons: Math.min(pricey.tons, 5), shipId: ship, payerId: jax })).rejects.toThrow(/Not enough credits/);
    }
  });

  it('shares intelligence about a distant market one demand at a time', async () => {
    const far = (await table.gm.act('market.create', { systemId: away, generate: false, name: 'Meadow co-op' })).id;
    const d = (await table.gm.act('market.demand', { id: far, what: 'Aluminium plating for the new dome', good: 11, dm: 3, note: 'Paying well until the dome is sealed.' })).id;
    await eventually(() => expect(table.gm.get<Market>(far)!.demands).toHaveLength(1));
    expect(ann.client.get(far)).toBeUndefined();
    expect(ann.client.get(away)).toBeUndefined();
    // Only Bob overhears it.
    await table.gm.act('market.demand', { id: far, demandId: d, audience: bob.id, on: true });
    await eventually(() => expect(bob.client.get<Market>(far)!.demands[0]).toMatchObject({ what: 'Aluminium plating for the new dome', dm: 3 }));
    // He learns the system exists and its name, but not its survey data or the market's stock.
    expect(bob.client.get(away)).toMatchObject({ name: 'Meadow' });
    expect((bob.client.get(away) as any).uwp).toBeUndefined();
    expect(bob.client.get<Market>(far)!.lots).toEqual([]);
    expect(ann.client.get(far)).toBeUndefined();
  });

  it('sells cargo at the destination, with the demand bonus, and pays for freight on delivery', async () => {
    const far = table.gm.all('market').find((m) => m.systemId === away)!.id;
    await table.gm.act('reveal.set', { ids: [far], facets: ['exists', 'catalogue'], audience: 'party', on: true });
    const cargo = ann.client.all('item').find((i) => i.category === 'cargo' && i.good === 11)!;
    const freight = (await ann.client.act('trade.takeFreight', { shipId: ship, destinationId: away, tons: 10, pay: 16000 })).id;
    await expect(ann.client.act('trade.deliver', { itemId: freight })).rejects.toThrow(/not at the destination/);
    await table.gm.act('party.moveTo', { systemId: away });
    await eventually(() => expect(ann.client.get<Ship>(ship)!.location!.systemId).toBe(away));
    const before = ann.client.get<Ship>(ship)!.funds!;
    expect(await ann.client.act('trade.deliver', { itemId: freight })).toEqual({ pay: 16000 });
    // Sale: 10 + Broker 2 + (Ni +2 - Ri +1) - 2 + demand 3 = 14 → 115% of Cr20,000.
    const quote = await ann.client.act('trade.sellQuote', { marketId: far, itemId: cargo.id, characterId: jax, manual: [4, 3, 3] });
    expect(quote).toMatchObject({ pct: 115, price: 23000 });
    const sold = await ann.client.act('trade.sell', { itemId: cargo.id });
    expect(sold).toMatchObject({ gross: 23000 * cargo.tons!, profit: (23000 - 15000) * cargo.tons! });
    await eventually(() => expect(ann.client.get<Ship>(ship)!.funds).toBe(before + 16000 + 23000 * cargo.tons!));
    expect(ann.client.get(cargo.id)).toBeUndefined();
  });

  it('rolls passengers and freight for a route', async () => {
    const t = await ann.client.act('trade.traffic', { originId: away, destinationId: home, effect: 1 });
    expect(t.parsecs).toBe(1);
    expect(Object.keys(t.passengers).sort()).toEqual(['basic', 'high', 'low', 'middle']);
    expect(t.fares).toMatchObject({ high: 9000, low: 700 });
    expect(Array.isArray(t.freight)).toBe(true);
  });
});
