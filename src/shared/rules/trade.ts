/**
 * Trade rules engine: what a market has for sale, price modifiers from trade codes, the price a
 * negotiation roll produces, and where a cargo is likely to sell well. Tables come from the
 * rules pack.
 */
import type { DigitRule, RangeDm, TradeGood, TradeRules, TrafficWorldDm } from '../rulepack';
import type { Uwp } from '../uwp';
import { rollDice, sum, type Rng } from '../util';

/** The trade-relevant facts about a world. */
export interface TradeWorld {
  codes: string[];
  zone?: '' | 'A' | 'R';
  uwp?: Uwp | null;
}

function zoneKey(zone: string | undefined): string | undefined {
  return zone === 'A' ? 'Amber' : zone === 'R' ? 'Red' : undefined;
}

/** The largest modifier among those that apply to this world (the rules use only the largest). */
export function bestDm(table: Record<string, number>, world: TradeWorld): { dm: number; from?: string } {
  let best: { dm: number; from?: string } | undefined;
  const keys = [...world.codes, zoneKey(world.zone)].filter((k): k is string => !!k);
  for (const key of keys) {
    const dm = table[key];
    if (dm === undefined) continue;
    if (!best || dm > best.dm) best = { dm, from: key };
  }
  return best ?? { dm: 0 };
}

/** Net modifier when buying a good on a world: its purchase DM less its sale DM. */
export function purchaseDm(good: TradeGood, world: TradeWorld): number {
  return bestDm(good.purchaseDm, world).dm - bestDm(good.saleDm, world).dm;
}

/** Net modifier when selling a good on a world: its sale DM less its purchase DM. */
export function saleDm(good: TradeGood, world: TradeWorld): number {
  return bestDm(good.saleDm, world).dm - bestDm(good.purchaseDm, world).dm;
}

/** Price percentage for a modified roll, from the pack's table (clamped at the ends). */
export function pricePercent(result: number, kind: 'purchase' | 'sale', rules: TradeRules): number {
  const table = rules.modifiedPrice;
  const lo = table[0];
  const hi = table[table.length - 1];
  const row = result <= lo.result ? lo : result >= hi.result ? hi : (table.find((r) => r.result === result) ?? lo);
  return row[kind];
}

export interface PriceRoll {
  dice: number[];
  /** Total modifier applied to the dice. */
  dm: number;
  parts: { label: string; dm: number }[];
  result: number;
  pct: number;
  /** Credits per ton. */
  price: number;
}

/** Works out a price from a negotiation roll. `dice` may be supplied (table rolls). */
export function negotiate(
  good: TradeGood,
  world: TradeWorld,
  kind: 'purchase' | 'sale',
  opts: { broker: number; opposing?: number; extra?: number; dice?: number[]; basePrice?: number },
  rules: TradeRules,
  rng: Rng = Math.random,
): PriceRoll {
  const dice = opts.dice ?? rollDice(rules.priceRoll.dice, rng);
  const parts: { label: string; dm: number }[] = [];
  parts.push({ label: 'Broker', dm: opts.broker });
  const own = bestDm(kind === 'purchase' ? good.purchaseDm : good.saleDm, world);
  const other = bestDm(kind === 'purchase' ? good.saleDm : good.purchaseDm, world);
  if (own.dm) parts.push({ label: `${kind === 'purchase' ? 'Purchase' : 'Sale'} DM (${own.from})`, dm: own.dm });
  if (other.dm) parts.push({ label: `${kind === 'purchase' ? 'Sale' : 'Purchase'} DM (${other.from})`, dm: -other.dm });
  const opposing = opts.opposing ?? rules.priceRoll.opposingBroker;
  if (opposing) parts.push({ label: kind === 'purchase' ? "Supplier's broker" : "Buyer's broker", dm: -opposing });
  if (opts.extra) parts.push({ label: 'Other', dm: opts.extra });
  const dm = parts.reduce((n, p) => n + p.dm, 0);
  const result = sum(dice) + dm;
  const pct = pricePercent(result, kind, rules);
  return { dice, dm, parts, result, pct, price: Math.round(((opts.basePrice ?? good.basePrice) * pct) / 100) };
}

/** Whether a market on this world would stock the good as a matter of course. */
export function stocks(good: TradeGood, world: TradeWorld): boolean {
  if (good.exotic) return false;
  if (good.availability.includes('*')) return true;
  return good.availability.some((code) => world.codes.includes(code));
}

export interface StockLot {
  good: number;
  name: string;
  tons: number;
  basePrice: number;
  illegal?: boolean;
}

/**
 * Generates what a supplier has for sale: every common good, the goods matching the world's trade
 * codes, and one random good per population digit. Illegal goods appear only on the black market.
 */
export function generateStock(world: TradeWorld, rules: TradeRules, opts: { blackMarket?: boolean } = {}, rng: Rng = Math.random): StockLot[] {
  const pop = world.uwp?.pop ?? 0;
  const q = rules.quantity;
  const popDm = pop <= q.lowPopMax ? q.lowPopDm : pop >= q.highPopMin ? q.highPopDm : 0;
  const tonsFor = (good: TradeGood) => Math.max(0, sum(rollDice(good.tons.dice, rng)) + popDm) * good.tons.mult;
  const lots = new Map<number, StockLot>();
  const add = (good: TradeGood) => {
    const tons = tonsFor(good);
    const existing = lots.get(good.code);
    if (existing) existing.tons += tons;
    else lots.set(good.code, { good: good.code, name: good.name, tons, basePrice: good.basePrice, illegal: good.illegal });
  };
  const legal = rules.goods.filter((g) => !g.illegal && !g.exotic);
  const illegal = rules.goods.filter((g) => g.illegal);
  if (opts.blackMarket) {
    // A black market deals in the illegal goods that match the world, plus random illegal lots.
    for (const g of illegal) if (stocks(g, world)) add(g);
    for (let i = 0; i < pop; i++) add(illegal[Math.floor(rng() * illegal.length)]);
  } else {
    for (const g of legal) if (stocks(g, world)) add(g);
    for (let i = 0; i < pop; i++) add(legal[Math.floor(rng() * legal.length)]);
  }
  return [...lots.values()].filter((l) => l.tons > 0).sort((a, b) => a.good - b.good);
}

/** A typical price roll, rounded down so estimates err on the cautious side. */
function averageRoll(rules: TradeRules): number {
  return Math.floor(rules.priceRoll.dice * 3.5);
}

/** The sale price a trader can expect on a world, at an average roll. */
export function expectedSale(good: TradeGood, world: TradeWorld, broker: number, rules: TradeRules): { pct: number; price: number; dm: number } {
  const dm = saleDm(good, world) + broker - rules.priceRoll.opposingBroker;
  const pct = pricePercent(averageRoll(rules) + dm, 'sale', rules);
  return { pct, price: Math.round((good.basePrice * pct) / 100), dm: saleDm(good, world) };
}

/** The purchase price a trader can expect on a world, at an average roll. */
export function expectedPurchase(good: TradeGood, world: TradeWorld, broker: number, rules: TradeRules): { pct: number; price: number; dm: number } {
  const dm = purchaseDm(good, world) + broker - rules.priceRoll.opposingBroker;
  const pct = pricePercent(averageRoll(rules) + dm, 'purchase', rules);
  return { pct, price: Math.round((good.basePrice * pct) / 100), dm: purchaseDm(good, world) };
}

// ───────────────────────────── passengers & freight ─────────────────────────────

function matches(rule: DigitRule, value: number): boolean {
  if (rule.any && !rule.any.includes(value)) return false;
  if (rule.min !== undefined && value < rule.min) return false;
  if (rule.max !== undefined && value > rule.max) return false;
  return true;
}

function rangeSum(table: RangeDm[] | undefined, value: number): number {
  let total = 0;
  for (const row of table ?? []) if (matches(row, value)) total += row.dm;
  return total;
}

/** Traffic modifier contributed by one world (applied for both origin and destination). */
export function trafficWorldDm(table: TrafficWorldDm, world: TradeWorld): number {
  const u = world.uwp;
  let dm = 0;
  if (u) {
    dm += rangeSum(table.pop, u.pop);
    dm += table.starport?.[u.starport] ?? 0;
    dm += rangeSum(table.tl, u.tl);
  }
  if (world.zone) dm += table.zone?.[world.zone] ?? 0;
  return dm;
}

function trafficDice(table: { max: number; dice: number }[], result: number): number {
  return (table.find((row) => result <= row.max) ?? table[table.length - 1]).dice;
}

export interface TrafficInput {
  origin: TradeWorld;
  destination: TradeWorld;
  parsecs: number;
  /** Effect of the Broker/Carouse/Streetwise check made to look for business. */
  effect?: number;
  /** Highest Steward skill aboard (passengers only). */
  steward?: number;
}

/** Passengers looking for passage, by class. */
export function passengersAvailable(input: TrafficInput, rules: TradeRules, rng: Rng = Math.random): Record<string, number> {
  const t = rules.passengerTraffic;
  const base = (input.effect ?? 0) + (input.steward ?? 0) + trafficWorldDm(t.worldDm, input.origin) + trafficWorldDm(t.worldDm, input.destination) + Math.max(0, input.parsecs - 1) * t.perExtraParsec;
  const out: Record<string, number> = {};
  for (const [cls, dm] of Object.entries(t.classDm)) {
    const dice = trafficDice(t.table, sum(rollDice(2, rng)) + base + dm);
    out[cls] = sum(rollDice(dice, rng));
  }
  return out;
}

export interface FreightLot {
  size: string;
  tons: number;
  pay: number;
}

/** Freight lots on offer for a destination. Each must be taken whole and pays on delivery. */
export function freightAvailable(input: TrafficInput, rules: TradeRules, rng: Rng = Math.random): FreightLot[] {
  const t = rules.freightTraffic;
  const rate = (rules.passage.find((p) => p.parsecs === Math.min(input.parsecs, rules.passage.length)) ?? rules.passage[0]).freight;
  const base = (input.effect ?? 0) + trafficWorldDm(t.worldDm, input.origin) + trafficWorldDm(t.worldDm, input.destination) + Math.max(0, input.parsecs - 1) * t.perExtraParsec;
  const out: FreightLot[] = [];
  for (const [size, spec] of Object.entries(t.lots)) {
    const lots = sum(rollDice(trafficDice(t.table, sum(rollDice(2, rng)) + base + spec.dm), rng));
    for (let i = 0; i < lots; i++) {
      const tons = sum(rollDice(spec.dice, rng)) * spec.mult;
      out.push({ size, tons, pay: tons * rate });
    }
  }
  return out.sort((a, b) => b.tons - a.tons);
}

/** Fare for one passenger of a class over a distance. */
export function passageFare(cls: 'high' | 'middle' | 'basic' | 'low', parsecs: number, rules: TradeRules): number {
  const row = rules.passage.find((p) => p.parsecs === Math.max(1, Math.min(parsecs, rules.passage.length))) ?? rules.passage[0];
  return row[cls];
}
