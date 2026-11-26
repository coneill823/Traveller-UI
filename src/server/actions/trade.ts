/**
 * Trade actions: markets and their stock, quoted prices, buying and selling cargo, freight and
 * passengers. Players can trade wherever they can see a market's catalogue; what they can see is
 * up to the GM.
 */
import { hexDistance, parseHex, toGlobal } from '../../shared/hex';
import { knows, toggleAudience } from '../../shared/knowledge';
import type { TradeGood, TradeRules } from '../../shared/rulepack';
import { skillLevel, unskilledDm } from '../../shared/rules/character';
import { freightAvailable, generateStock, negotiate, passageFare, passengersAvailable, type TradeWorld } from '../../shared/rules/trade';
import { systemTradeCodes } from '../../shared/rules/world';
import type { Body, Campaign, Character, GameDate, Id, Item, Market, MarketLot, Sector, Ship, StarSystem } from '../../shared/types';
import { parseUwp } from '../../shared/uwp';
import { newId, rollDice, sum } from '../../shared/util';
import type { Tx } from '../state';
import { CAMPAIGN_ID, checkAudience, makeRoll } from './core';
import { adjustFunds, balanceOf, canManage, cargoUsed } from './inventory';
import { action, ActionError, check, requireGm, type ActionCtx } from './registry';

function tradeRules(ctx: ActionCtx): TradeRules {
  const rules = ctx.services.rules.pack.trade;
  if (!rules) throw new ActionError('No rules pack with trade tables is installed on the server');
  return rules;
}

function today(tx: Tx): GameDate {
  return tx.get<Campaign>(CAMPAIGN_ID)?.date ?? { day: 1, year: 1105 };
}

/** Days from one in-game date to another. */
function daysBetween(a: GameDate, b: GameDate): number {
  return (b.year - a.year) * 365 + (b.day - a.day);
}

/** The world a market trades on: its own body's profile if it has one, otherwise the system's mainworld. */
export function marketWorld(tx: Tx, market: Pick<Market, 'systemId' | 'bodyId'>, ctx: ActionCtx): TradeWorld {
  const system = tx.need('system', market.systemId);
  const body = market.bodyId ? tx.get<Body>(market.bodyId) : undefined;
  const uwpText = body && !body.mainworld && body.uwp ? body.uwp : system.uwp;
  return { codes: systemTradeCodes(uwpText, body && !body.mainworld && body.uwp ? undefined : system.remarks, ctx.services.rules.pack.world), zone: system.zone ?? '', uwp: parseUwp(uwpText) };
}

function systemWorld(system: StarSystem, ctx: ActionCtx): TradeWorld {
  return { codes: systemTradeCodes(system.uwp, system.remarks, ctx.services.rules.pack.world), zone: system.zone ?? '', uwp: parseUwp(system.uwp) };
}

function goodOf(rules: TradeRules, code: number): TradeGood {
  const good = rules.goods.find((g) => g.code === code);
  if (!good) throw new ActionError('That trade good is not in the rules pack');
  return good;
}

/** The market, if the caller can see what it sells. */
function openMarket(ctx: ActionCtx, id: unknown): Market {
  const market = ctx.tx.need('market', check.id(id, 'marketId'));
  if (ctx.me.role !== 'gm' && !(knows(market, 'exists', ctx.me) && knows(market, 'catalogue', ctx.me))) throw new ActionError('You do not have access to that market');
  return market;
}

/** Broker skill used in a negotiation: a named character's, a hired local broker's, or a given number. */
function brokerFor(ctx: ActionCtx, p: any, rules: TradeRules, illegal: boolean): { skill: number; label: string; actor?: Character; extra: number; fee: number } {
  if (p.localBroker) {
    // Local brokers know the market: a rolled skill, a bonus, and a cut of the proceeds.
    const skill = Math.floor(sum(rollDice(rules.localBroker.skillDice)) / rules.localBroker.skillDivisor);
    return { skill, label: `Local broker ${skill}`, extra: rules.localBroker.negotiationDm, fee: illegal ? rules.localBroker.illegalFee : rules.localBroker.fee };
  }
  if (p.characterId) {
    const c = ctx.tx.need('character', check.id(p.characterId, 'characterId'));
    if (ctx.me.role !== 'gm' && c.kind !== 'pc') throw new ActionError('Choose one of the travellers to negotiate');
    const name = illegal ? 'Streetwise' : 'Broker';
    const level = skillLevel(c.skills, name);
    return { skill: level ?? unskilledDm(c.skills, ctx.services.rules.pack), label: level === null ? `${name} (unskilled)` : `${name} ${level}`, actor: c, extra: 0, fee: 0 };
  }
  const skill = p.broker === undefined ? 0 : check.int(p.broker, 'broker', { min: -3, max: 15 });
  return { skill, label: `Broker ${skill}`, extra: 0, fee: 0 };
}

function manualDice(p: any, count: number): number[] | undefined {
  if (p.manual === undefined || p.manual === null) return undefined;
  const dice = check.arr(p.manual, 'manual', (v, n) => check.int(v, n, { min: 1, max: 6 }), 10);
  if (dice.length !== count) throw new ActionError(`Enter ${count} dice`);
  return dice;
}

// ── markets (GM) ──

action('market.create', (ctx, p) => {
  requireGm(ctx.me);
  const system = ctx.tx.need('system', check.id(p.systemId, 'systemId'));
  const body = p.bodyId ? ctx.tx.need('body', check.id(p.bodyId, 'bodyId')) : undefined;
  if (body && body.systemId !== system.id) throw new ActionError('That body is in another system');
  const venue = check.oneOf(p.venue ?? 'surface', 'venue', ['surface', 'orbit', 'station'] as const);
  const blackMarket = !!p.blackMarket;
  const draft = { systemId: system.id, bodyId: body?.id };
  let lots: MarketLot[] = [];
  if (p.generate !== false && ctx.services.rules.pack.trade) {
    lots = generateStock(marketWorld(ctx.tx, draft, ctx), tradeRules(ctx), { blackMarket }).map((l) => ({ id: newId('lot'), ...l }));
  }
  const market = ctx.tx.create('market', {
    ...draft,
    name: check.optStr(p.name, 'name', { max: 80 }) ?? `${body?.name ?? system.name ?? 'Local'} ${blackMarket ? 'black market' : venue === 'orbit' ? 'highport exchange' : venue === 'station' ? 'station exchange' : 'starport exchange'}`,
    venue,
    blackMarket: blackMarket || undefined,
    broker: p.broker === undefined ? (ctx.services.rules.pack.trade?.priceRoll.opposingBroker ?? 2) : check.int(p.broker, 'broker', { min: 0, max: 10 }),
    lots,
    demands: [],
    stocked: today(ctx.tx),
  });
  return { id: market.id, lots: lots.length };
});

action('market.restock', (ctx, p) => {
  requireGm(ctx.me);
  const market = ctx.tx.need('market', check.id(p.id, 'id'));
  const lots = generateStock(marketWorld(ctx.tx, market, ctx), tradeRules(ctx), { blackMarket: market.blackMarket }).map((l) => ({ id: newId('lot'), ...l }));
  ctx.tx.update<Market>(market.id, (m) => {
    m.lots = lots;
    m.stocked = today(ctx.tx);
  });
  return { lots: lots.length };
});

action('market.addLot', (ctx, p) => {
  requireGm(ctx.me);
  const market = ctx.tx.need('market', check.id(p.id, 'id'));
  const rules = ctx.services.rules.pack.trade;
  const good = p.good === undefined ? undefined : rules?.goods.find((g) => g.code === p.good);
  const lot: MarketLot = {
    id: newId('lot'),
    good: good?.code ?? 0,
    name: check.optStr(p.name, 'name', { max: 80 }) ?? good?.name ?? 'Goods',
    tons: check.num(p.tons, 'tons', { min: 0.1, max: 100000 }),
    basePrice: p.basePrice === undefined ? (good?.basePrice ?? 1000) : check.num(p.basePrice, 'basePrice', { min: 0, max: 1e10 }),
    illegal: good?.illegal || !!p.illegal || undefined,
  };
  ctx.tx.update<Market>(market.id, (m) => void m.lots.push(lot));
  return { id: lot.id };
});

action('market.demand', (ctx, p) => {
  requireGm(ctx.me);
  const market = ctx.tx.need('market', check.id(p.id, 'id'));
  if (p.remove) {
    ctx.tx.update<Market>(market.id, (m) => void (m.demands = m.demands.filter((d) => d.id !== p.remove)));
    return {};
  }
  if (p.demandId) {
    // Reveal or hide one demand.
    const audience = checkAudience(ctx.tx, p.audience);
    const on = check.bool(p.on, 'on');
    ctx.tx.update<Market>(market.id, (m) => {
      const d = m.demands.find((x) => x.id === p.demandId);
      if (!d) throw new ActionError('That entry no longer exists');
      d.known = toggleAudience(d.known, audience, on);
    });
    // Knowing a demand means knowing the market and where it is.
    if (on) {
      const sys = ctx.tx.get<StarSystem>(market.systemId);
      ctx.tx.update<Market>(market.id, (m) => {
        const known = { ...(m.known ?? {}) };
        known.exists = [...new Set([...(known.exists ?? []), audience])];
        m.known = known;
      });
      if (sys && !(sys.known?.exists?.includes(audience) ?? false)) {
        ctx.tx.update<StarSystem>(sys.id, (s) => {
          const known = { ...(s.known ?? {}) };
          known.exists = [...new Set([...(known.exists ?? []), audience])];
          known.name = [...new Set([...(known.name ?? []), audience])];
          s.known = known;
        });
        const sector = ctx.tx.get<Sector>(sys.sectorId);
        if (sector && !(sector.known?.exists?.includes(audience) ?? false)) {
          ctx.tx.update<Sector>(sector.id, (s) => {
            s.known = { ...(s.known ?? {}), exists: [...new Set([...(s.known?.exists ?? []), audience])] };
          });
        }
      }
    }
    return {};
  }
  const rules = ctx.services.rules.pack.trade;
  const good = p.good === undefined || p.good === null ? undefined : rules?.goods.find((g) => g.code === p.good);
  const demand = {
    id: newId('dem'),
    what: check.str(p.what ?? good?.name, 'what', { max: 120 }),
    good: good?.code,
    dm: p.dm === undefined ? undefined : check.int(p.dm, 'dm', { min: -10, max: 20 }),
    note: check.optStr(p.note, 'note', { max: 600 }),
    known: [],
  };
  ctx.tx.update<Market>(market.id, (m) => void m.demands.push(demand));
  return { id: demand.id };
});

// ── buying ──

action('trade.quote', (ctx, p) => {
  const rules = tradeRules(ctx);
  const market = openMarket(ctx, p.marketId);
  const lot = market.lots.find((l) => l.id === p.lotId);
  if (!lot) throw new ActionError('That lot is no longer on offer');
  const now = today(ctx.tx);
  if (lot.refused && daysBetween(lot.refused, now) < 28) throw new ActionError('You walked away from this deal. The supplier will not talk again for about a month.');
  if (lot.offer) throw new ActionError('A price has already been quoted for this lot');
  const good = rules.goods.find((g) => g.code === lot.good) ?? ({ code: 0, name: lot.name, availability: [], tons: { dice: 0, mult: 0 }, basePrice: lot.basePrice, purchaseDm: {}, saleDm: {} } as TradeGood);
  const broker = brokerFor(ctx, p, rules, !!lot.illegal);
  const extra = (p.dm === undefined ? 0 : check.int(p.dm, 'dm', { min: -20, max: 20 })) + broker.extra;
  const result = negotiate(good, marketWorld(ctx.tx, market, ctx), 'purchase', { broker: broker.skill, opposing: market.broker, extra, dice: manualDice(p, rules.priceRoll.dice), basePrice: lot.basePrice }, rules);
  result.parts[0].label = broker.label;
  const roll = makeRoll(ctx, {
    label: `Buying price: ${lot.name}`,
    dm: result.dm,
    fixedDice: result.dice,
    manual: p.manual ? result.dice : undefined,
    actor: broker.actor?.name ?? (p.localBroker ? 'Local broker' : undefined),
    kind: 'check',
    characterId: broker.actor?.id,
    breakdown: result.parts,
    detail: `${result.pct}% of base · Cr${result.price.toLocaleString('en-GB')} per ton`,
  });
  ctx.tx.update<Market>(market.id, (m) => {
    m.lots.find((l) => l.id === lot.id)!.offer = { pct: result.pct, price: result.price, by: broker.actor?.id, fee: broker.fee || undefined };
  });
  return { rollId: roll.id, pct: result.pct, price: result.price, fee: broker.fee };
});

action('trade.refuse', (ctx, p) => {
  const market = openMarket(ctx, p.marketId);
  ctx.tx.update<Market>(market.id, (m) => {
    const lot = m.lots.find((l) => l.id === p.lotId);
    if (!lot) throw new ActionError('That lot is no longer on offer');
    delete lot.offer;
    lot.refused = today(ctx.tx);
  });
});

action('trade.buy', (ctx, p) => {
  const market = openMarket(ctx, p.marketId);
  const lot = market.lots.find((l) => l.id === p.lotId);
  if (!lot) throw new ActionError('That lot is no longer on offer');
  if (!lot.offer) throw new ActionError('Get a price first');
  const tons = check.num(p.tons, 'tons', { min: 0.1, max: lot.tons });
  const ship = ctx.tx.need('ship', check.id(p.shipId, 'shipId'));
  if (!canManage(ctx.me, ship)) throw new ActionError('That is not your ship');
  const free = (ship.cargo ?? Infinity) - cargoUsed(ctx.tx, ship.id);
  if (tons > free + 1e-9) throw new ActionError(`Only ${Math.max(0, Math.round(free * 100) / 100)} tons of cargo space free aboard ${ship.name ?? 'the ship'}`);
  const payer = p.payerId ? ctx.tx.get<Character | Ship>(check.id(p.payerId, 'payerId')) : ship;
  if (!payer || (payer.type !== 'ship' && payer.type !== 'character')) throw new ActionError('Choose who pays');
  if (!canManage(ctx.me, payer)) throw new ActionError('Those are not your credits to spend');
  const cost = Math.round(lot.offer.price * tons);
  const fee = Math.round(cost * (lot.offer.fee ?? 0));
  if (balanceOf(payer) < cost + fee) throw new ActionError(`Not enough credits: this costs Cr${(cost + fee).toLocaleString('en-GB')} and ${payer.name ?? 'the payer'} has Cr${balanceOf(payer).toLocaleString('en-GB')}`);
  adjustFunds(ctx.tx, payer, -(cost + fee));
  const now = today(ctx.tx);
  const item = ctx.tx.create('item', {
    holderId: ship.id,
    name: lot.name,
    category: 'cargo',
    qty: 1,
    tons,
    good: lot.good || undefined,
    paid: lot.offer.price,
    value: lot.basePrice,
    origin: { systemId: market.systemId, day: now.day, year: now.year },
    illegal: lot.illegal,
  });
  ctx.tx.update<Market>(market.id, (m) => {
    const l = m.lots.find((x) => x.id === lot.id)!;
    l.tons = Math.round((l.tons - tons) * 100) / 100;
    if (l.tons <= 0) m.lots = m.lots.filter((x) => x.id !== lot.id);
  });
  return { itemId: item.id, cost, fee };
});

// ── selling ──

action('trade.sellQuote', (ctx, p) => {
  const rules = tradeRules(ctx);
  const market = openMarket(ctx, p.marketId);
  const item = ctx.tx.need('item', check.id(p.itemId, 'itemId'));
  if (item.category !== 'cargo' || item.freight) throw new ActionError('Only speculative cargo can be sold on the market');
  if (!canManage(ctx.me, ctx.tx.get(item.holderId))) throw new ActionError('That cargo is not yours to sell');
  if (item.saleOffer?.marketId === market.id) throw new ActionError('This buyer has already named a price');
  if (!!item.illegal !== !!market.blackMarket && item.illegal) throw new ActionError('Illegal goods can only be sold through a black market');
  const good = rules.goods.find((g) => g.code === item.good) ?? ({ code: 0, name: item.name, availability: [], tons: { dice: 0, mult: 0 }, basePrice: item.value ?? item.paid ?? 0, purchaseDm: {}, saleDm: {} } as TradeGood);
  const broker = brokerFor(ctx, p, rules, !!item.illegal);
  // A specific demand for this good at this market sweetens the deal.
  const demand = market.demands.filter((d) => d.good !== undefined && d.good === item.good && d.dm).reduce((best, d) => Math.max(best, d.dm ?? 0), 0);
  const extra = (p.dm === undefined ? 0 : check.int(p.dm, 'dm', { min: -20, max: 20 })) + broker.extra + demand;
  const result = negotiate(good, marketWorld(ctx.tx, market, ctx), 'sale', { broker: broker.skill, opposing: market.broker, extra, dice: manualDice(p, rules.priceRoll.dice), basePrice: item.value ?? good.basePrice }, rules);
  result.parts[0].label = broker.label;
  const roll = makeRoll(ctx, {
    label: `Selling price: ${item.name}`,
    dm: result.dm,
    fixedDice: result.dice,
    manual: p.manual ? result.dice : undefined,
    actor: broker.actor?.name ?? (p.localBroker ? 'Local broker' : undefined),
    kind: 'check',
    characterId: broker.actor?.id,
    breakdown: result.parts,
    detail: `${result.pct}% of base · Cr${result.price.toLocaleString('en-GB')} per ton`,
  });
  ctx.tx.update<Item>(item.id, (i) => void (i.saleOffer = { marketId: market.id, pct: result.pct, price: result.price, fee: broker.fee || undefined }));
  return { rollId: roll.id, pct: result.pct, price: result.price, fee: broker.fee };
});

action('trade.sell', (ctx, p) => {
  const item = ctx.tx.need('item', check.id(p.itemId, 'itemId'));
  const holder = ctx.tx.get(item.holderId);
  if (!canManage(ctx.me, holder)) throw new ActionError('That cargo is not yours to sell');
  if (!item.saleOffer) throw new ActionError('Get a price first');
  const market = openMarket(ctx, item.saleOffer.marketId);
  const lotTons = item.tons ?? 0;
  const tons = p.tons === undefined ? lotTons : check.num(p.tons, 'tons', { min: 0.1, max: lotTons });
  const gross = Math.round(item.saleOffer.price * tons);
  const fee = Math.round(gross * (item.saleOffer.fee ?? 0));
  const payee = p.payeeId ? ctx.tx.get<Character | Ship>(check.id(p.payeeId, 'payeeId')) : holder;
  if (!payee || (payee.type !== 'ship' && payee.type !== 'character')) throw new ActionError('Choose who receives the credits');
  adjustFunds(ctx.tx, payee as Character | Ship, gross - fee);
  const profit = gross - fee - Math.round((item.paid ?? 0) * tons);
  if (tons >= lotTons - 1e-9) ctx.tx.delete(item.id);
  else ctx.tx.update<Item>(item.id, (i) => void (i.tons = Math.round((lotTons - tons) * 100) / 100));
  void market;
  return { gross, fee, profit };
});

action('trade.keep', (ctx, p) => {
  const item = ctx.tx.need('item', check.id(p.itemId, 'itemId'));
  if (!canManage(ctx.me, ctx.tx.get(item.holderId))) throw new ActionError('That cargo is not yours');
  ctx.tx.update<Item>(item.id, (i) => void delete i.saleOffer);
});

// ── freight & passengers ──

function parsecsBetween(tx: Tx, a: StarSystem, b: StarSystem): number {
  const sa = tx.get<Sector>(a.sectorId);
  const sb = tx.get<Sector>(b.sectorId);
  const ha = parseHex(a.hex);
  const hb = parseHex(b.hex);
  if (!sa || !sb || !ha || !hb) return 1;
  return Math.max(1, hexDistance(toGlobal(sa.x, sa.y, ha.col, ha.row), toGlobal(sb.x, sb.y, hb.col, hb.row)));
}

/** Rolls what freight and passengers are looking for a ride from one system to another. */
action('trade.traffic', (ctx, p) => {
  const rules = tradeRules(ctx);
  const origin = ctx.tx.need('system', check.id(p.originId, 'originId'));
  const destination = ctx.tx.need('system', check.id(p.destinationId, 'destinationId'));
  if (ctx.me.role !== 'gm' && (!knows(origin, 'survey', ctx.me) || !knows(destination, 'exists', ctx.me))) throw new ActionError('You do not know enough about those systems');
  const parsecs = parsecsBetween(ctx.tx, origin, destination);
  const input = {
    origin: systemWorld(origin, ctx),
    destination: systemWorld(destination, ctx),
    parsecs,
    effect: p.effect === undefined ? 0 : check.int(p.effect, 'effect', { min: -12, max: 20 }),
    steward: p.steward === undefined ? 0 : check.int(p.steward, 'steward', { min: 0, max: 10 }),
  };
  const passengers = passengersAvailable(input, rules);
  const fares = Object.fromEntries(Object.keys(passengers).map((cls) => [cls, passageFare(cls as 'high', parsecs, rules)]));
  return { parsecs, passengers, fares, freight: freightAvailable({ ...input, steward: 0 }, rules) };
});

/** Takes on a freight lot, mail or a group of passengers: paid on delivery. */
action('trade.takeFreight', (ctx, p) => {
  const ship = ctx.tx.need('ship', check.id(p.shipId, 'shipId'));
  if (!canManage(ctx.me, ship)) throw new ActionError('That is not your ship');
  const destination = ctx.tx.need('system', check.id(p.destinationId, 'destinationId'));
  const kind = check.oneOf(p.kind ?? 'freight', 'kind', ['freight', 'mail', 'passengers'] as const);
  const tons = check.num(p.tons, 'tons', { min: 0, max: 100000 });
  const pay = check.int(p.pay, 'pay', { min: 0, max: 1e10 });
  const free = (ship.cargo ?? Infinity) - cargoUsed(ctx.tx, ship.id);
  if (tons > free + 1e-9) throw new ActionError(`Only ${Math.max(0, Math.round(free * 100) / 100)} tons of cargo space free`);
  const now = today(ctx.tx);
  const item = ctx.tx.create('item', {
    holderId: ship.id,
    name: check.optStr(p.name, 'name', { max: 120 }) ?? (kind === 'mail' ? 'Mail containers' : kind === 'passengers' ? 'Passengers' : `Freight for ${destination.name ?? 'delivery'}`),
    category: 'cargo',
    qty: 1,
    tons,
    origin: { systemId: ship.location?.systemId, day: now.day, year: now.year },
    freight: { destinationId: destination.id, pay, kind },
    note: check.optStr(p.note, 'note', { max: 600 }),
  });
  return { id: item.id };
});

action('trade.deliver', (ctx, p) => {
  const item = ctx.tx.need('item', check.id(p.itemId, 'itemId'));
  const holder = ctx.tx.get(item.holderId);
  if (!item.freight) throw new ActionError('That is not a delivery');
  if (!canManage(ctx.me, holder)) throw new ActionError('That is not your cargo');
  if (ctx.me.role !== 'gm' && holder?.type === 'ship' && item.freight.destinationId && (holder as Ship).location?.systemId !== item.freight.destinationId) {
    throw new ActionError('The ship is not at the destination yet');
  }
  const pay = p.pay === undefined ? item.freight.pay : check.int(p.pay, 'pay', { min: 0, max: 1e10 });
  if (holder && (holder.type === 'ship' || holder.type === 'character')) adjustFunds(ctx.tx, holder as Ship | Character, pay);
  ctx.tx.delete(item.id);
  return { pay };
});
