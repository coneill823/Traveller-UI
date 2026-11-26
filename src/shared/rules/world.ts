/**
 * World rules engine: decoding world profiles, deriving trade codes and generating new worlds.
 * All tables and thresholds come from the rules pack; this file only knows how to apply them.
 */
import { SUB_H, SUB_W, formatHex, hexDistance, type GlobalHex } from '../hex';
import type { DiceFormula, DigitRule, RangeDm, TradeCodeDef, WorldRules } from '../rulepack';
import { ehexChar, formatPbg, formatUwp, parsePbg, parseUwp, type Uwp } from '../uwp';
import { rollListing } from './system';
import { rollDice, sum, type Rng } from '../util';

export function matchesDigit(rule: DigitRule | undefined, value: number): boolean {
  if (!rule) return true;
  if (value < 0) return false;
  if (rule.any && !rule.any.includes(value)) return false;
  if (rule.min !== undefined && value < rule.min) return false;
  if (rule.max !== undefined && value > rule.max) return false;
  return true;
}

function rangeDm(table: RangeDm[] | undefined, value: number): number {
  let total = 0;
  for (const row of table ?? []) if (matchesDigit(row, value)) total += row.dm;
  return total;
}

/** Trade codes a world qualifies for under the pack's definitions. */
export function tradeCodesFor(uwp: Uwp | null, rules: WorldRules | undefined): string[] {
  if (!uwp || !rules) return [];
  const out: string[] = [];
  for (const def of rules.tradeCodes) if (qualifies(def, uwp)) out.push(def.code);
  return out;
}

function qualifies(def: TradeCodeDef, u: Uwp): boolean {
  return (
    matchesDigit(def.size, u.size) &&
    matchesDigit(def.atm, u.atm) &&
    matchesDigit(def.hydro, u.hydro) &&
    matchesDigit(def.pop, u.pop) &&
    matchesDigit(def.gov, u.gov) &&
    matchesDigit(def.law, u.law) &&
    matchesDigit(def.tl, u.tl)
  );
}

/** Trade codes for a system: derived from the profile, plus any recognised codes in remarks. */
export function systemTradeCodes(uwpText: string | undefined, remarks: string | undefined, rules: WorldRules | undefined): string[] {
  const derived = tradeCodesFor(parseUwp(uwpText), rules);
  if (!rules) {
    return (remarks ?? '').split(/\s+/).filter((t) => /^[A-Z][a-z]$/.test(t));
  }
  const known = new Set(rules.tradeCodes.map((d) => d.code));
  const extra = (remarks ?? '').split(/\s+/).filter((t) => known.has(t) && !derived.includes(t));
  return [...derived, ...extra];
}

export interface DecodedRow {
  key: 'starport' | 'size' | 'atm' | 'hydro' | 'pop' | 'gov' | 'law' | 'tl';
  label: string;
  code: string;
  value: string;
  detail?: string;
}

/** Human-readable breakdown of a world profile. */
export function decodeUwp(uwpText: string | undefined, rules: WorldRules | undefined): DecodedRow[] {
  const u = parseUwp(uwpText);
  if (!u) return [];
  const rows: DecodedRow[] = [];
  const find = <T extends { code: number }>(table: T[] | undefined, code: number): T | undefined => {
    if (!table || code < 0) return undefined;
    // Tables may stop at a "9+" style final row; fall back to the highest row at or below the code.
    let best: T | undefined;
    for (const row of table) if (row.code <= code && (!best || row.code > best.code)) best = row;
    return table.find((r) => r.code === code) ?? best;
  };
  const d = (n: number) => (n < 0 ? '?' : ehexChar(n));

  const port = rules?.starport[u.starport];
  rows.push({
    key: 'starport',
    label: 'Starport',
    code: u.starport,
    value: port ? `Class ${u.starport} · ${port.quality}` : `Class ${u.starport}`,
    detail: port
      ? [
          port.fuel === 'None' ? 'No fuel' : `${port.fuel} fuel`,
          port.shipyard === 'none' ? null : `Shipyard: ${shipyardLabel(port.shipyard)}`,
          port.repair === 'none' ? 'No repairs' : port.repair === 'limited' ? 'Limited repairs' : 'Repair facilities',
          port.berthing ? `Berthing ${port.berthing.dice}D × Cr${port.berthing.mult.toLocaleString('en-GB')}` : 'No berthing fee',
        ]
          .filter(Boolean)
          .join(' · ')
      : undefined,
  });
  const size = find(rules?.size, u.size);
  rows.push({ key: 'size', label: 'Size', code: d(u.size), value: size ? size.diameter : '', detail: size ? `Gravity ${size.gravity}${size.example ? ` · e.g. ${size.example}` : ''}` : undefined });
  const atm = find(rules?.atmosphere, u.atm);
  rows.push({ key: 'atm', label: 'Atmosphere', code: d(u.atm), value: atm?.name ?? '', detail: atm ? [atm.pressure ? `Pressure ${atm.pressure}` : null, atm.gear ? `Needs ${atm.gear}` : null].filter(Boolean).join(' · ') || undefined : undefined });
  const hydro = find(rules?.hydrographics, u.hydro);
  rows.push({ key: 'hydro', label: 'Hydrographics', code: d(u.hydro), value: hydro?.name ?? '', detail: hydro?.range });
  const pop = find(rules?.population, u.pop);
  rows.push({ key: 'pop', label: 'Population', code: d(u.pop), value: pop?.name ?? '', detail: pop ? [pop.range, pop.note].filter(Boolean).join(' · ') : undefined });
  const gov = find(rules?.government, u.gov);
  rows.push({ key: 'gov', label: 'Government', code: d(u.gov), value: gov?.name ?? '', detail: gov ? [gov.note, gov.contraband?.length ? `Often restricts: ${gov.contraband.join(', ')}` : null].filter(Boolean).join(' ') : undefined });
  const law = find(rules?.law, u.law);
  rows.push({ key: 'law', label: 'Law level', code: d(u.law), value: law ? law.weapons : '', detail: law?.armour ? `Armour: ${law.armour}` : undefined });
  const tl = find(rules?.techLevel, u.tl);
  rows.push({ key: 'tl', label: 'Tech level', code: d(u.tl), value: tl?.name ?? `TL${u.tl}`, detail: tl?.note });
  return rows;
}

function shipyardLabel(kind: string): string {
  if (kind === 'all') return 'all ships';
  if (kind === 'spacecraft') return 'spacecraft';
  if (kind === 'smallcraft') return 'small craft';
  return 'none';
}

/** Where a ship can take on fuel in a system, judged from survey data alone. */
export interface FuelSources {
  refined: boolean;
  unrefined: boolean;
  gasGiant: boolean;
  water: boolean;
}

export function fuelSources(uwpText: string | undefined, pbgText: string | undefined, rules: WorldRules | undefined): FuelSources {
  const u = parseUwp(uwpText);
  const pbg = parsePbg(pbgText);
  const port = u && rules ? rules.starport[u.starport] : undefined;
  return {
    refined: port?.fuel === 'Refined',
    unrefined: port?.fuel === 'Refined' || port?.fuel === 'Unrefined',
    gasGiant: (pbg?.gasGiants ?? 0) > 0,
    water: !!u && u.hydro >= 1,
  };
}

// ───────────────────────────── generation ─────────────────────────────

function rollFormula(f: DiceFormula, values: Record<string, number>, rng: Rng, extraDm = 0): number {
  let n = sum(rollDice(f.dice, rng)) + (f.mod ?? 0) + extraDm;
  if (f.add) n += values[f.add] ?? 0;
  if (f.min !== undefined) n = Math.max(f.min, n);
  if (f.max !== undefined) n = Math.min(f.max, n);
  return n;
}

export interface GeneratedWorld {
  uwp: string;
  bases: string;
  pbg: string;
  zone: '' | 'A';
  /** Stellar data such as "K4 V" or "G2 V M5 V". */
  stars: string;
  temperature?: string;
  tradeCodes: string[];
  /** Total worlds in the system (mainworld, giants, belts and the rest), where the rules work it out. */
  worlds?: number;
}

/**
 * Picks the system's star(s). This is the app's own simple convention (most stars are small and
 * red, about one system in five is a binary), not a rulebook table.
 */
export function generateStars(rng: Rng): string {
  const pick = () => {
    const r = rng();
    const cls = r < 0.03 ? 'A' : r < 0.1 ? 'F' : r < 0.24 ? 'G' : r < 0.5 ? 'K' : 'M';
    return `${cls}${Math.floor(rng() * 10)} V`;
  };
  const stars = [pick()];
  if (rng() < 0.2) stars.push(rng() < 0.2 ? 'D' : `M${Math.floor(rng() * 10)} V`);
  return stars.join(' ');
}

export interface GenerateOptions {
  /** Mark worlds meeting every Amber condition in the pack as Amber zones. */
  autoAmber?: boolean;
}

/** Generates a mainworld following the pack's creation sequence. */
export function generateWorld(rules: WorldRules, rng: Rng, opts: GenerateOptions = {}): GeneratedWorld {
  const g = rules.generation;
  const v: Record<string, number> = {};

  v.size = rollFormula(g.rolls.size, v, rng);
  v.atm = v.size === 0 ? 0 : rollFormula(g.rolls.atm, v, rng);

  // Temperature feeds into hydrographics.
  const tempRoll = sum(rollDice(2, rng)) + rangeDm(g.temperatureAtmDm, v.atm);
  const temperature = rules.temperature.find((t) => tempRoll <= t.max) ?? rules.temperature[rules.temperature.length - 1];

  if (v.size <= g.hydro.zeroIfSizeAtMost) v.hydro = 0;
  else {
    const dm = rangeDm(g.hydro.atmDm, v.atm) + (temperature ? (g.hydro.temperatureDm[temperature.name] ?? 0) : 0);
    v.hydro = rollFormula(g.rolls.hydro, v, rng, dm);
  }

  v.pop = rollFormula(g.rolls.pop, v, rng);
  if (v.pop === 0) {
    v.gov = 0;
    v.law = 0;
  } else {
    v.gov = rollFormula(g.rolls.gov, v, rng);
    v.law = rollFormula(g.rolls.law, v, rng);
  }

  // Starport.
  const portRoll = sum(rollDice(2, rng)) + rangeDm(g.starportPopDm, v.pop);
  const starport = (g.starportTable.find((row) => portRoll <= row.max) ?? g.starportTable[g.starportTable.length - 1]).class;

  // Tech level.
  if (v.pop === 0) v.tl = 0;
  else {
    const dm =
      (g.techDm.starport[starport] ?? 0) +
      (g.techDm.size[String(v.size)] ?? 0) +
      (g.techDm.atm[String(v.atm)] ?? 0) +
      (g.techDm.hydro[String(v.hydro)] ?? 0) +
      (g.techDm.pop[String(v.pop)] ?? 0) +
      (g.techDm.gov[String(v.gov)] ?? 0);
    v.tl = Math.max(0, rollFormula(g.rolls.tl, v, rng, dm));
  }

  const uwp: Uwp = { starport, size: v.size, atm: v.atm, hydro: v.hydro, pop: v.pop, gov: v.gov, law: v.law, tl: v.tl };

  // Bases.
  let bases = '';
  const port = rules.starport[starport];
  for (const [code, target] of Object.entries(port?.bases ?? {})) {
    let dm = 0;
    if (code === 'H') dm = rangeDm(g.highportDm.tl, v.tl) + rangeDm(g.highportDm.pop, v.pop);
    if (code === 'C') dm = rangeDm(g.corsairDm.law, v.law);
    if (sum(rollDice(2, rng)) + dm >= target) bases += code;
  }

  // Population multiplier, belts and gas giants. With rules for whole systems in the pack, the
  // stars and the counts of giants, belts and other worlds come from those; otherwise they follow
  // this app's own simple convention (the core tables only say whether a gas giant is present).
  const popMultiplier = v.pop === 0 ? 0 : 1 + Math.floor(rng() * 9);
  let gasGiants: number;
  let belts: number;
  let stars: string;
  let worlds: number | undefined;
  if (rules.system) {
    const listing = rollListing(rules.system, rng, { size: v.size, atm: v.atm });
    gasGiants = Math.min(9, listing.gasGiants);
    belts = Math.min(9, listing.belts);
    stars = listing.stars;
    worlds = listing.worlds;
  } else {
    const gasGiantPresent = sum(rollDice(2, rng)) < g.gasGiantAbsentOn;
    gasGiants = gasGiantPresent ? Math.max(1, rollDice(1, rng)[0] - 2) : 0;
    belts = Math.max(0, rollDice(1, rng)[0] - 3);
    stars = generateStars(rng);
  }

  const amber =
    opts.autoAmber !== false &&
    matchesDigit(g.amber.atm, v.atm) &&
    matchesDigit(g.amber.gov, v.gov) &&
    matchesDigit(g.amber.law, v.law);

  return {
    uwp: formatUwp(uwp),
    bases,
    pbg: formatPbg({ popMultiplier, belts, gasGiants }),
    zone: amber ? 'A' : '',
    stars,
    temperature: temperature?.name,
    tradeCodes: tradeCodesFor(uwp, rules),
    worlds,
  };
}

/** True when a world meets any of the pack's Amber-zone warning signs (a hint for the GM). */
export function amberCandidate(uwpText: string | undefined, rules: WorldRules | undefined): boolean {
  const u = parseUwp(uwpText);
  if (!u || !rules) return false;
  const a = rules.generation.amber;
  return matchesDigit(a.atm, u.atm) || matchesDigit(a.gov, u.gov) || matchesDigit(a.law, u.law);
}

export interface GeneratedSystem extends GeneratedWorld {
  /** Hex within the subsector (0101–0810) or sector, as requested. */
  hex: string;
}

/**
 * Rolls world occurrence for every hex of an area and generates a mainworld where one exists.
 * `cols` x `rows` defaults to one subsector. Hex numbers start at `col0`+1, `row0`+1.
 */
export function generateArea(
  rules: WorldRules,
  rng: Rng,
  opts: GenerateOptions & { density?: string; col0?: number; row0?: number; cols?: number; rows?: number; skip?: Set<string> } = {},
): GeneratedSystem[] {
  const g = rules.generation;
  const dm = g.occurrence.density[opts.density ?? 'standard'] ?? 0;
  const out: GeneratedSystem[] = [];
  const col0 = opts.col0 ?? 0;
  const row0 = opts.row0 ?? 0;
  for (let c = 1; c <= (opts.cols ?? SUB_W); c++) {
    for (let r = 1; r <= (opts.rows ?? SUB_H); r++) {
      const hex = formatHex(col0 + c, row0 + r);
      const present = rollDice(1, rng)[0] + dm >= g.occurrence.target;
      if (!present || opts.skip?.has(hex)) continue;
      out.push({ hex, ...generateWorld(rules, rng, opts) });
    }
  }
  return out;
}

export interface RouteCandidate {
  a: number;
  b: number;
}

/**
 * Suggests trade routes: pairs of worlds within the pack's distance limit whose trade codes
 * match one of the pack's "first world / second world" pairings.
 */
export function suggestTradeRoutes(
  worlds: { pos: GlobalHex; codes: string[] }[],
  rules: WorldRules,
): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  const has = (codes: string[], list: string[]) => list.some((c) => codes.includes(c));
  for (let i = 0; i < worlds.length; i++) {
    for (let j = i + 1; j < worlds.length; j++) {
      if (hexDistance(worlds[i].pos, worlds[j].pos) > rules.tradeRoutes.maxDistance) continue;
      const match = rules.tradeRoutes.pairs.some(
        (p) =>
          (has(worlds[i].codes, p.from) && has(worlds[j].codes, p.to)) ||
          (has(worlds[j].codes, p.from) && has(worlds[i].codes, p.to)),
      );
      if (match) out.push({ a: i, b: j });
    }
  }
  return out;
}
