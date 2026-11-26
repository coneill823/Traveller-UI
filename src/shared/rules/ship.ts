/**
 * Spacecraft design. Turns a hull and a list of parts into tonnage, cost, power and crew figures,
 * and reports what is missing, what does not fit and what a given shipyard cannot build.
 * Every number comes from the rules pack; this file only knows how the pieces relate.
 */
import type { FittingDef, ModDef, PartOptionDef, ShipRules, ShipyardDef, StockDesign, WorldRules } from '../rulepack';
import type { DesignPart, PartKind, ShipSpec } from '../types';
import { stableStringify } from '../util';

export type IssueLevel = 'error' | 'warn' | 'info';

export interface DesignIssue {
  level: IssueLevel;
  code: string;
  text: string;
  /** The part at fault, when there is one. */
  partId?: string;
  /** The kind of part that would fix it, when something is missing. */
  kind?: PartKind;
}

export interface PartLine {
  /** `hull` for the hull itself, otherwise the part's id. */
  partId: string;
  kind: PartKind | 'hull';
  group: string;
  label: string;
  detail: string;
  qty: number;
  tons: number;
  cost: number;
  /** Power drawn, and power generated. */
  power: number;
  output: number;
  tl: number;
  hardpoints: number;
  /** False when the part's catalogue entry is not in the loaded rules. */
  known: boolean;
}

export interface CrewLine {
  role: string;
  name: string;
  count: number;
  salary: number;
}

export interface DesignReport {
  lines: PartLine[];
  hullTons: number;
  hullPoints: number;
  armour: number;
  streamlined: 'full' | 'partial' | 'none';
  smallCraft: boolean;
  tonsUsed: number;
  /** Tonnage left over, which is the cargo space. Negative when the design is over tonnage. */
  cargo: number;
  cost: number;
  discountPct: number;
  purchase: number;
  /** Credits per month. */
  maintenance: number;
  buildDays: number;
  /** `aux` is power from solar collectors and `stored` what batteries hold; neither counts towards `output`. */
  power: { output: number; basic: number; mdrive: number; jdrive: number; other: number; aux: number; stored: number };
  thrust: number;
  jump: number;
  /** A reaction drive, if fitted: its Thrust, the fuel it burns and how long the tanks feed it. */
  reaction: { thrust: number; fuelPerHour: number; hours: number };
  fuel: { tons: number; perParsec: number; perPeriod: number; parsecs: number; weeks: number };
  hardpoints: { total: number; used: number; firm: boolean };
  computer: { name: string; processing: number; jumpProcessing: number } | null;
  sensors: { name: string; dm: number };
  quarters: { staterooms: number; high: number; berths: number; lowBerths: number; seats: number };
  crew: CrewLine[];
  crewCount: number;
  payroll: number;
  crewing: 'commercial' | 'military';
  /** Troops and prisoners that barracks and brigs can hold, beyond the stateroom count. */
  troops: number;
  /** Lowest tech level at which every part can be made. */
  tl: number;
  issues: DesignIssue[];
  /** Kinds of part the design cannot do without and does not yet have. */
  missing: PartKind[];
  stock?: StockDesign;
}

export const PART_GROUPS: { id: string; label: string }[] = [
  { id: 'hull', label: 'Hull and armour' },
  { id: 'drives', label: 'Drives' },
  { id: 'power', label: 'Power plant' },
  { id: 'fuel', label: 'Fuel' },
  { id: 'command', label: 'Bridge and electronics' },
  { id: 'weapons', label: 'Weapons' },
  { id: 'screens', label: 'Screens and point defence' },
  { id: 'quarters', label: 'Accommodation' },
  { id: 'craft', label: 'Craft and vehicles' },
  { id: 'drones', label: 'Drones' },
  { id: 'cargo', label: 'Cargo handling' },
  { id: 'systems', label: 'Systems' },
  { id: 'software', label: 'Software' },
  { id: 'custom', label: 'Other' },
];

const KIND_GROUP: Record<PartKind, string> = {
  armour: 'hull',
  mdrive: 'drives',
  rdrive: 'drives',
  jdrive: 'drives',
  plant: 'power',
  fuel: 'fuel',
  bridge: 'command',
  computer: 'command',
  sensors: 'command',
  software: 'software',
  mount: 'weapons',
  fitting: 'systems',
  craft: 'craft',
  custom: 'custom',
};

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Rounds up, forgiving the float error that turns 22 into 22.000000000000004. */
function ceilSafe(n: number): number {
  return Math.ceil(r3(n));
}

function count(n: unknown, min = 1): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.max(min, v) : min;
}

function amount(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function formatTons(n: number): string {
  const v = r3(n);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

/** Credits as the shipyards quote them: MCr for large sums. */
export function formatMCr(cr: number): string {
  if (Math.abs(cr) >= 1_000_000) return `MCr${r3(cr / 1_000_000)}`;
  return `Cr${Math.round(cr).toLocaleString('en-US')}`;
}

export function isSmallCraft(rules: ShipRules, tons: number): boolean {
  return tons < rules.hull.smallCraftBelow;
}

export function hardpointsFor(rules: ShipRules, tons: number): { total: number; firm: boolean } {
  if (!isSmallCraft(rules, tons)) return { total: Math.floor(tons / rules.hardpoints.perTons), firm: false };
  const row = rules.hardpoints.firmpoints.find((f) => tons <= f.maxHull);
  return { total: row?.points ?? 0, firm: true };
}

/** What the rest of the design tells a fitting about itself. */
interface FittingContext {
  hullTons: number;
  /** Hull cost with its configuration but before specialised hull types. */
  baseHullCost: number;
  plantTons: number;
  plantCost: number;
  builtIn: boolean;
}

interface FittingFigures {
  tons: number;
  cost: number;
  power: number;
  output: number;
  stored: number;
  qty: number;
  detail: string;
}

/** Size and cost of a fitting line. */
function fittingFigures(def: FittingDef, part: DesignPart, ctx: FittingContext): FittingFigures {
  const { hullTons, builtIn } = ctx;
  const none = { output: 0, stored: 0 };
  if (def.size === 'unit') {
    const qty = count(part.qty);
    const each = def.unitLabel ? ` (per ${def.unitLabel})` : '';
    const output = qty * (def.unitOutput ?? 0);
    return {
      ...none,
      qty,
      tons: qty * (def.unitTons ?? 0),
      cost: builtIn ? 0 : qty * (def.unitCost ?? 0),
      power: qty * (def.unitPower ?? 0),
      output,
      detail: builtIn ? 'Built into the hull' : [qty > 1 || def.unitLabel ? `x${qty}${each}` : '', output ? `Power ${formatTons(output)}` : ''].filter(Boolean).join(', '),
    };
  }
  if (def.size === 'docking') {
    const qty = count(part.qty);
    const craft = Math.max(0, amount(part.rating));
    const each = ceilSafe(craft * (1 + (def.dockingPct ?? 0) / 100));
    return { ...none, qty, tons: each * qty, cost: each * qty * (def.costPerTon ?? 0), power: 0, detail: `for ${qty > 1 ? `${qty} craft of ` : 'a craft of '}${formatTons(craft)} tons` };
  }
  if (def.size === 'capacity') {
    const qty = count(part.qty);
    const served = Math.max(0, amount(part.rating));
    const raw = served * (def.capacityMult ?? 1);
    const each = Math.max(served > 0 ? (def.minTons ?? 0) : 0, def.capacityRound ? ceilSafe(raw) : raw);
    const sharePct = hullTons > 0 ? (served * qty * 100) / hullTons : 0;
    const hullShare = def.hullCostPerCapacityPct ? (ctx.baseHullCost * def.hullCostPerCapacityPct * (def.fullPercent ? Math.floor(r3(sharePct)) : sharePct)) / 100 : 0;
    return {
      ...none,
      qty,
      tons: each * qty,
      cost: each * qty * (def.costPerTon ?? 0) + served * qty * (def.costPerCapacity ?? 0) + hullShare,
      power: each * qty * (def.powerPerTon ?? 0),
      detail: `${qty > 1 ? `x${qty}, each ` : ''}for ${formatTons(served)} ${def.capacityLabel ?? 'tons'}`,
    };
  }
  if (def.size === 'plant') {
    const pct = def.plantPct ?? 0;
    return { ...none, qty: 1, tons: (ctx.plantTons * pct) / 100, cost: (ctx.plantCost * pct) / 100, power: 0, detail: `${pct}% of the power plant` };
  }
  if (def.size === 'hull') {
    const tons = def.hullPct || def.plusTons ? Math.max(def.minTons ?? 0, (hullTons * (def.hullPct ?? 0)) / 100 + (def.plusTons ?? 0)) : 0;
    return {
      ...none,
      qty: 1,
      tons,
      cost: tons * (def.costPerTon ?? 0) + hullTons * (def.costPerHullTon ?? 0) + ctx.baseHullCost * (def.hullCostAdd ?? 0),
      power: hullTons * (def.powerPerHullTon ?? 0) + tons * (def.powerPerTon ?? 0),
      detail: def.hullPct ? `${def.hullPct}% of the hull${def.plusTons ? ` plus ${formatTons(def.plusTons)} tons` : ''}` : '',
    };
  }
  const tons = Math.max(0, amount(part.tons));
  const steps = def.stepTons ? ceilSafe(tons / def.stepTons) : 0;
  const output = tons * (def.outputPerTon ?? 0);
  const stored = tons * (def.storePerTon ?? 0);
  return {
    qty: 1,
    tons,
    cost: tons * (def.costPerTon ?? 0) + steps * (def.costPerStep ?? 0),
    power: tons * (def.powerPerTon ?? 0) + steps * (def.powerPerStep ?? 0),
    output,
    stored,
    detail: [
      def.perTonValue ? `${formatTons(tons * def.perTonValue)} ${def.perTonLabel?.replace(/^\d+\s*/, '') ?? ''}`.trim() : '',
      output ? `Power ${formatTons(output)}` : '',
      stored ? `holds ${formatTons(stored)} Power` : '',
    ]
      .filter(Boolean)
      .join(', '),
  };
}

type Fail = (code: string, text: string, level?: IssueLevel) => void;

/** The options chosen for a part, checked against what they can be fitted to. */
function optionsOf(defs: PartOptionDef[] | undefined, ids: string[] | undefined, key: string | undefined, hullTons: number, fail: Fail): PartOptionDef[] {
  if (!ids?.length) return [];
  const out: PartOptionDef[] = [];
  for (const id of ids) {
    const def = defs?.find((o) => o.id === id);
    if (!def) {
      fail('unknown-option', `Option "${id}" is not in the loaded rules.`, 'warn');
      continue;
    }
    if (def.appliesTo && key !== undefined && !def.appliesTo.includes(key)) fail('option-fit', `${def.name} cannot be fitted to this.`);
    if (def.overTons !== undefined && hullTons <= def.overTons) fail('option-hull', `${def.name} is only for hulls over ${def.overTons.toLocaleString('en-US')} tons.`);
    if (def.maxTons !== undefined && hullTons > def.maxTons) fail('option-hull', `${def.name} is only for hulls up to ${def.maxTons.toLocaleString('en-US')} tons.`);
    out.push(def);
  }
  for (const def of out) {
    const clash = out.find((o) => o !== def && def.excludes?.includes(o.id));
    if (clash) fail('option-clash', `${def.name} cannot be combined with ${clash.name.toLowerCase()}.`);
  }
  return out;
}

const product = (options: PartOptionDef[], pick: (o: PartOptionDef) => number | undefined): number => options.reduce((n, o) => n * (pick(o) ?? 1), 1);
const sum = (options: PartOptionDef[], pick: (o: PartOptionDef) => number | undefined): number => options.reduce((n, o) => n + (pick(o) ?? 0), 0);

/** How a prototype or advanced component differs from the standard article. */
interface Custom {
  tonsMult: number;
  costMult: number;
  powerMult: number;
  outputMult: number;
  fuelMult: number;
  tlShift: number;
  text: string;
  mods: ModDef[];
}

const STANDARD: Custom = { tonsMult: 1, costMult: 1, powerMult: 1, outputMult: 1, fuelMult: 1, tlShift: 0, text: '', mods: [] };

function customOf(rules: ShipRules, part: DesignPart, tag: string, fail: Fail, turret = false): Custom {
  if (!part.grade && !part.mods?.length) return STANDARD;
  const table = rules.customising;
  if (!table) {
    fail('custom-unknown', 'Prototype and advanced components are not in the loaded rules.', 'warn');
    return STANDARD;
  }
  const grade = table.grades.find((g) => g.id === part.grade);
  const mods = (part.mods ?? []).map((id) => table.mods.find((m) => m.id === id && m.kinds.includes(tag))).filter((m) => m !== undefined);
  if (mods.length < (part.mods?.length ?? 0)) fail('custom-unknown', 'One of the modifications chosen does not apply to this kind of component.', 'warn');
  if (!grade) {
    fail('custom-grade', part.grade ? `Grade "${part.grade}" is not in the loaded rules.` : 'Advantages and disadvantages come with a prototype, budget or advanced component.', part.grade ? 'warn' : 'error');
    return STANDARD;
  }
  const advantages = (grade.advantages ?? 0) > 0;
  const allowed = grade.advantages ?? grade.disadvantages ?? 0;
  const word = advantages ? 'advantage' : 'disadvantage';
  const used = mods.reduce((n, m) => n + (m.slots ?? 1), 0);
  if (mods.some((m) => m.advantage !== advantages)) fail('custom-kind', `${grade.name} components take ${word}s only.`);
  else if (used > allowed) fail('custom-slots', `${grade.name} allows ${plural(allowed, word)}; those chosen come to ${used}.`);
  else if (used < allowed) fail('custom-slots', `${grade.name}: ${plural(allowed - used, `more ${word}`)} to choose.`, 'info');
  const tally = new Map<ModDef, number>();
  for (const m of mods) tally.set(m, (tally.get(m) ?? 0) + 1);
  for (const [m, n] of tally) {
    if (m.once && n > 1) fail('custom-once', `${m.name} can only be taken once.`);
    if (m.notTurrets && turret) fail('custom-turret', `${m.name} does not apply to turret weapons.`);
  }
  const pct = (pick: (m: ModDef) => number | undefined) => mods.reduce((n, m) => n + (pick(m) ?? 0), 0);
  const names = [...tally].map(([m, n]) => (n > 1 ? `${m.name.toLowerCase()} x${n}` : m.name.toLowerCase()));
  return {
    tonsMult: 1 + ((grade.tonsPct ?? 0) + pct((m) => m.tonsPct)) / 100,
    costMult: grade.costMult,
    powerMult: 1 + pct((m) => m.powerPct) / 100,
    outputMult: 1 + pct((m) => m.outputPct) / 100,
    fuelMult: 1 + pct((m) => m.fuelPct) / 100,
    tlShift: grade.tlShift,
    text: names.length ? `${grade.name}: ${names.join(', ')}` : grade.name,
    mods,
  };
}

function hullPointsPerTon(rules: ShipRules, tons: number): number {
  const band = [...(rules.hull.pointBands ?? [])].sort((a, b) => b.fromTons - a.fromTons).find((b) => tons >= b.fromTons);
  return 1 / (band?.tonsPerPoint ?? rules.hull.tonsPerHullPoint);
}

/** Hull points for a hull of this size, before its configuration and build quality are counted. */
export function basicHullPoints(rules: ShipRules, tons: number): number {
  return Math.floor(r3(hullPointsPerTon(rules, tons) * tons));
}

/** Rounds to the nearest whole number, halves going down: the way the yards count hands. */
function hands(n: number): number {
  return Math.max(0, Math.ceil(r3(n) - 0.5));
}

function withoutIds(spec: ShipSpec): string {
  const parts = spec.parts.map(({ id: _id, ...rest }) => stableStringify(dropEmpty(rest))).sort();
  return stableStringify({ tons: spec.hull.tons, config: spec.hull.config, options: [...(spec.hull.options ?? [])].sort(), parts });
}

function dropEmpty(part: Omit<DesignPart, 'id'>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(part)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (k === 'qty' && v === 1) continue;
    out[k] = v;
  }
  return out;
}

/** The stock design this spec still matches part for part, if any. */
export function matchingStock(rules: ShipRules, spec: ShipSpec): StockDesign | undefined {
  if (!spec.stock) return undefined;
  const stock = rules.designs.find((d) => d.id === spec.stock);
  if (!stock) return undefined;
  return withoutIds(spec) === withoutIds(specFromStock(stock)) ? stock : undefined;
}

let partCounter = 0;

export function newPartId(): string {
  partCounter += 1;
  return `p${Date.now().toString(36)}${partCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function specFromStock(design: StockDesign): ShipSpec {
  return {
    tl: design.tl,
    hull: { tons: design.hull.tons, config: design.hull.config, ...(design.hull.options?.length ? { options: [...design.hull.options] } : {}) },
    parts: design.parts.map((p, i) => ({ ...p, id: `s${i + 1}` })),
    ...(design.outline ? { outline: { kind: 'builtin' as const, key: design.outline } } : {}),
    stock: design.id,
    ...(design.crewing ? { crewing: design.crewing } : {}),
  };
}

export function evaluateDesign(rules: ShipRules, spec: ShipSpec): DesignReport {
  const issues: DesignIssue[] = [];
  const lines: PartLine[] = [];
  const hullTons = Math.max(0, amount(spec.hull.tons));
  const cfg = rules.hull.configurations.find((c) => c.id === spec.hull.config) ?? rules.hull.configurations[0];
  const hullFail: Fail = (code, text, level = 'error') => issues.push({ level, code, text });
  const hullOptions = optionsOf(rules.hull.options, spec.hull.options, undefined, hullTons, hullFail);
  if (cfg.noOptions && hullOptions.length) hullFail('hull-plain', `A ${cfg.name.toLowerCase()} hull cannot be built as a ${hullOptions[0].name.toLowerCase()}.`);
  const baseHullCost = hullTons * (cfg.costPerTon ?? rules.hull.costPerTon) * cfg.costMult;
  const hullCost = baseHullCost * (1 + sum(hullOptions, (o) => o.costAdd));
  const hullPoints = Math.floor(r3(hullPointsPerTon(rules, hullTons) * hullTons * cfg.hullMult * product(hullOptions, (o) => o.hullMult)));
  const smallCraft = isSmallCraft(rules, hullTons);
  const solid = cfg.usablePct !== undefined ? (hullTons * (100 - cfg.usablePct)) / 100 : 0;
  // What is built into the hull (armour, bridge, hull-wide fittings) is sized by the space that can be used; drives push all of it.
  const fitTons = hullTons - solid;

  lines.push({
    partId: 'hull',
    kind: 'hull',
    group: 'hull',
    label: `${formatTons(hullTons)}-ton hull`,
    detail: [cfg.name, ...hullOptions.map((o) => o.name), solid > 0 ? `${cfg.usablePct}% usable` : ''].filter(Boolean).join(', '),
    qty: 1,
    tons: solid,
    cost: hullCost,
    power: 0,
    output: 0,
    tl: Math.max(0, ...hullOptions.map((o) => o.tl ?? 0)),
    hardpoints: 0,
    known: true,
  });
  if (hullTons < rules.hull.minTons) issues.push({ level: 'error', code: 'hull-small', text: `A hull must be at least ${rules.hull.minTons} tons.` });
  if (hullTons > rules.hull.maxTons) issues.push({ level: 'error', code: 'hull-large', text: `Hulls over ${rules.hull.maxTons.toLocaleString('en-US')} tons are beyond these construction rules.` });

  const seen: Partial<Record<PartKind, number>> = {};
  const fittingsSeen = new Map<string, number>();
  const fittingParts: { partId: string; def: FittingDef }[] = [];
  const plantSized: { line: PartLine; def: FittingDef; part: DesignPart; custom: Custom }[] = [];
  const fuelNotes = new Map<string, string>();
  let thrust = 0;
  let jump = 0;
  let mdrivePower = 0;
  let jdrivePower = 0;
  let jumpFuelMult = 1;
  const reaction = { thrust: 0, fuelPerHour: 0, hours: 0 };
  let driveTons = 0;
  let plantTons = 0;
  let plantCost = 0;
  let plantStandardTons = 0;
  let plantOwnFuel = 0;
  let jumpOutput = 0;
  let fuelTons = 0;
  let armour = cfg.armourBonus ?? 0;
  let gunnersCommercial = 0;
  let gunnersMilitary = 0;
  let firmpointTurrets = 0;
  let craftCrew = 0;
  let aux = 0;
  let stored = 0;
  let troops = 0;
  const computers: { partId: string; name: string; processing: number; jumpProcessing: number; core: boolean }[] = [];
  let sensors: DesignReport['sensors'] = (() => {
    const basic = rules.sensors.find((s) => s.included);
    return { name: basic?.name ?? 'None', dm: basic?.dm ?? 0 };
  })();
  const quarters = { staterooms: 0, high: 0, berths: 0, lowBerths: 0, seats: 0 };
  const software: { partId: string; family: string; level: number; bandwidth: number; name: string }[] = [];
  let hasRepairDrones = false;
  let bridgeSeats = 0;

  for (const part of spec.parts) {
    const line: PartLine = { partId: part.id, kind: part.kind, group: KIND_GROUP[part.kind] ?? 'custom', label: part.name ?? part.key ?? part.kind, detail: '', qty: 1, tons: 0, cost: 0, power: 0, output: 0, tl: 0, hardpoints: 0, known: true };
    const fail: Fail = (code, text, level = 'error') => issues.push({ level, code, text, partId: part.id });
    const nth = (seen[part.kind] = (seen[part.kind] ?? 0) + 1);
    const unknown = (what: string) => {
      line.known = false;
      line.label = `${what} "${part.key ?? '?'}"`;
      fail('unknown-part', `${line.label} is not in the loaded rules.`, 'warn');
    };

    switch (part.kind) {
      case 'armour': {
        const def = rules.armour.find((a) => a.id === part.key);
        if (!def) {
          unknown('Armour');
          break;
        }
        const rating = count(part.rating, 0);
        const sizeMult = rules.hull.armourSizeMult?.find((r) => hullTons <= r.maxHull)?.mult ?? 1;
        line.label = `${def.name} armour`;
        line.detail = `Protection +${rating}`;
        line.tons = (fitTons * def.tonsPct * rating * (cfg.armourMult ?? 1) * sizeMult) / 100;
        line.cost = def.costPerTon !== undefined ? line.tons * def.costPerTon : (hullCost * def.costPct * rating) / 100;
        line.tl = def.tl;
        armour += rating;
        if (cfg.noArmour) fail('armour-config', `A ${cfg.name.toLowerCase()} hull cannot be given extra armour.`);
        const cap = Math.min(def.maxByTl ? spec.tl + (def.maxTlPlus ?? 0) : Infinity, def.max ?? Infinity) * product(hullOptions, (o) => o.armourMaxMult);
        if (rating > cap) fail('armour-max', `${def.name} is limited to Protection +${cap} at TL${spec.tl}.`);
        if (nth > 1) fail('armour-dup', 'Only one type of armour can be fitted.');
        break;
      }
      case 'mdrive':
      case 'rdrive':
      case 'jdrive': {
        const isJump = part.kind === 'jdrive';
        const def = isJump ? rules.jdrive : part.kind === 'rdrive' ? rules.rdrive : rules.mdrive;
        line.label = isJump ? 'Jump drive' : part.kind === 'rdrive' ? 'Reaction drive' : 'Manoeuvre drive';
        if (!def) {
          line.known = false;
          fail('unknown-part', `${line.label}s are not in the loaded rules.`, 'warn');
          break;
        }
        const rating = count(part.rating, def.zero ? 0 : 1);
        const zero = rating === 0 ? def.zero : undefined;
        const top = def.tl.length;
        // A drive can be sized for a different tonnage than the bare hull: a ship that carries drop tanks, say.
        const basis = amount(part.tons) > 0 ? amount(part.tons) : hullTons;
        const baseTons = Math.max(def.minTons ?? 0, (basis * (zero ? zero.tonsPct : def.tonsPct * rating)) / 100 + (def.plusTons ?? 0));
        const options = optionsOf(def.options, part.options, undefined, hullTons, fail);
        const custom = customOf(rules, part, part.kind, fail);
        line.tons = baseTons * custom.tonsMult * product(options, (o) => o.tonsMult);
        line.cost = baseTons * def.costPerTon * custom.costMult * product(options, (o) => o.costMult);
        line.tl = Math.max((zero ? zero.tl : (def.tl[Math.min(rating, top) - 1] ?? 0)) + custom.tlShift, ...options.map((o) => o.tl ?? 0));
        if (rating > top) fail('drive-rating', `${line.label}s only go up to ${isJump ? 'Jump-' : 'Thrust '}${top}.`);
        const delivered = Math.floor((basis === hullTons || hullTons <= 0 ? rating : Math.floor(r3((basis * rating) / hullTons))) * product(options, (o) => o.ratingMult) + 1e-9);
        line.detail = [
          isJump ? `Jump-${rating}` : `Thrust ${rating}`,
          delivered !== rating ? `${isJump ? 'Jump-' : 'Thrust '}${delivered} on this hull` : '',
          basis !== hullTons ? `sized for ${formatTons(basis)} tons` : '',
          ...options.map((o) => o.name),
          custom.text,
        ]
          .filter(Boolean)
          .join(', ');
        // A second drive of a kind is a backup: the ship runs on the better one.
        if (nth > 1) fail('drive-backup', `A second ${line.label.toLowerCase()} is a backup: the ship runs on the more powerful one.`, 'info');
        driveTons += line.tons;
        const powerMult = custom.powerMult * product(options, (o) => o.powerMult);
        if (isJump) {
          if (nth === 1 || delivered > jump) {
            jump = delivered;
            jdrivePower = ((hullTons * def.powerPct * delivered) / 100) * powerMult;
            jumpFuelMult = custom.fuelMult;
          }
        } else if (part.kind === 'rdrive') {
          if (nth === 1 || delivered > reaction.thrust) {
            reaction.thrust = delivered;
            reaction.fuelPerHour = (zero ? (zero.fuelTonsPerHour ?? 0) : (hullTons * (def.fuelPctPerHour ?? 0) * delivered) / 100) * custom.fuelMult;
          }
        } else if (nth === 1 || delivered > thrust) {
          thrust = delivered;
          mdrivePower = ((hullTons * def.powerPct * (zero ? (zero.powerMult ?? 0) : delivered)) / 100) * powerMult;
        }
        if (def.minHull && hullTons < def.minHull) fail('jump-small', `Hulls under ${def.minHull} tons cannot carry a jump drive.`);
        break;
      }
      case 'plant': {
        const def = rules.plants.find((p) => p.id === part.key);
        if (!def) {
          unknown('Power plant');
          break;
        }
        const base = Math.max(0, amount(part.tons));
        const custom = customOf(rules, part, 'plant', fail);
        const output = base * def.powerPerTon * custom.outputMult;
        line.tons = base * custom.tonsMult;
        line.output = custom.outputMult > 1 ? ceilSafe(output) : output;
        line.cost = base * def.costPerTon * custom.costMult;
        line.tl = def.tl + custom.tlShift;
        line.label = 'Power plant';
        line.detail = [`${def.name}, Power ${formatTons(line.output)}`, custom.text].filter(Boolean).join(', ');
        plantTons += line.tons;
        plantCost += line.cost;
        if (def.fuelTonsPerTon) plantOwnFuel += (line.tons * def.fuelTonsPerTon * rules.fuel.plantWeeks) / (def.fuelWeeks ?? rules.fuel.plantWeeks);
        else plantStandardTons += line.tons;
        if (!def.noJump) jumpOutput += line.output;
        if (base <= 0) fail('plant-size', 'Give the power plant a size.');
        break;
      }
      case 'fuel': {
        const capacity = Math.max(0, amount(part.tons));
        const options = optionsOf(rules.fuel.options, part.options, undefined, hullTons, fail);
        line.tons = capacity * product(options, (o) => o.tonsMult);
        line.cost = capacity * sum(options, (o) => o.costPerTon);
        line.tl = Math.max(0, ...options.map((o) => o.tl ?? 0));
        line.label = 'Fuel tanks';
        if (options.length) fuelNotes.set(part.id, `${formatTons(capacity)} tons in ${options.map((o) => o.name.toLowerCase()).join(', ')}`);
        fuelTons += capacity;
        break;
      }
      case 'bridge': {
        const def = rules.bridge.types.find((b) => b.id === (part.key ?? 'bridge'));
        if (!def) {
          unknown('Bridge');
          break;
        }
        const options = optionsOf(rules.bridge.options, part.options, def.id, hullTons, fail);
        const copies = count(part.qty);
        line.qty = copies;
        line.label = copies > 1 ? `${def.name} x${copies}` : def.name;
        if (def.tons !== undefined) {
          line.tons = def.tons * copies;
          line.cost = (def.cost ?? 0) * copies;
          if (def.maxHull !== undefined && hullTons > def.maxHull) fail('cockpit-size', `A ${def.name.toLowerCase()} only suits hulls of ${def.maxHull} tons or less.`);
        } else {
          const sizes = rules.bridge.sizes;
          const found = sizes.findIndex((s) => fitTons <= s.maxHull);
          const index = found < 0 ? sizes.length - 1 : found;
          let tons = sizes[Math.max(0, Math.min(sizes.length - 1, index + sum(options, (o) => o.sizeStep)))].tons;
          const extra = rules.bridge.extra;
          if (extra && fitTons > extra.aboveTons) tons += Math.floor(r3((fitTons - extra.aboveTons) / extra.perTons)) * extra.tons;
          tons = tons * product(options, (o) => o.tonsMult) + sum(options, (o) => o.tonsAdd);
          for (const o of options) tons = Math.max(tons, o.minTonsByHull?.find((row) => fitTons <= row.maxHull)?.tons ?? 0);
          line.tons = tons * copies;
          line.cost = (ceilSafe(fitTons / 100) * rules.bridge.costPer100Tons * product(options, (o) => o.costMult) * (1 + sum(options, (o) => o.costAdd)) + sum(options, (o) => o.costFlat)) * copies;
          line.detail = options.map((o) => o.name).join(', ');
          line.tl = Math.max(0, ...options.map((o) => o.tl ?? 0));
        }
        bridgeSeats += def.seats ?? 0;
        if (nth > 1) fail('bridge-backup', 'A second bridge is a backup, in case the first is lost.', 'info');
        break;
      }
      case 'computer': {
        const def = rules.computers.find((c) => c.id === part.key);
        if (!def) {
          unknown('Computer');
          break;
        }
        const options = optionsOf(rules.computerOptions, part.options, def.id, hullTons, fail);
        line.label = def.name + options.map((o) => o.suffix ?? '').join('');
        line.detail = options.map((o) => o.name).join(', ');
        line.cost = def.cost * (1 + sum(options, (o) => o.costAdd));
        line.tl = Math.max(def.tl, ...options.map((o) => o.tl ?? 0));
        computers.push({ partId: part.id, name: line.label, processing: def.processing, jumpProcessing: def.core ? Infinity : def.processing + sum(options, (o) => o.jumpBonus), core: !!def.core });
        if (nth === 2) fail('computer-dup', 'A second computer is a backup: software runs on the more powerful one.', 'info');
        if (nth > 2) fail('computer-max', 'A ship carries two computers at most: a primary and a backup.');
        break;
      }
      case 'sensors': {
        const def = rules.sensors.find((s) => s.id === part.key);
        if (!def) {
          unknown('Sensors');
          break;
        }
        const options = optionsOf(rules.sensorOptions, part.options, def.id, hullTons, fail);
        const suites = count(part.qty);
        line.qty = suites;
        line.label = `${def.name} sensors${suites > 1 ? ` x${suites}` : ''}`;
        line.detail = [`DM${def.dm >= 0 ? '+' : ''}${def.dm}${def.suite ? ` · ${def.suite}` : ''}`, ...options.map((o) => o.name)].join(', ');
        line.tons = def.tons * product(options, (o) => o.tonsMult) * suites;
        line.cost = def.cost * product(options, (o) => o.costMult) * suites;
        line.power = def.power * product(options, (o) => o.powerMult) * suites;
        line.tl = Math.max(def.tl, ...options.map((o) => o.tl ?? 0));
        if (def.dm >= sensors.dm) sensors = { name: def.name, dm: def.dm };
        if (nth > 1) fail('sensors-dup', 'A second sensor suite is a spare: the ship uses the better one.', 'info');
        break;
      }
      case 'software': {
        const def = rules.software.find((s) => s.id === part.key);
        if (!def) {
          unknown('Software');
          break;
        }
        line.label = def.name;
        line.detail = def.bandwidth ? `Bandwidth ${def.bandwidth}` : 'Included';
        line.cost = def.cost;
        line.tl = def.tl;
        software.push({ partId: part.id, family: def.family, level: def.level, bandwidth: def.bandwidth, name: def.name });
        break;
      }
      case 'mount': {
        const def = rules.mounts.find((m) => m.id === part.key);
        if (!def) {
          unknown('Weapon mount');
          break;
        }
        const qty = count(part.qty);
        const fitted = (part.weapons ?? []).map((id) => rules.weapons.find((w) => w.id === id));
        const weapons = fitted.filter((w) => w !== undefined);
        if (weapons.length < fitted.length) fail('unknown-weapon', 'A weapon on this mount is not in the loaded rules.', 'warn');
        const options = optionsOf(rules.mountOptions, part.options, def.id, hullTons, fail);
        // Turrets and fixed mounts carry weapons priced on their own; a barbette or bay is its weapon.
        const turret = !def.accepts;
        const custom = customOf(rules, part, 'weapon', fail, turret);
        const slots = smallCraft && def.smallCraftSlots !== undefined ? def.smallCraftSlots : def.slots;
        const names = new Map<string, number>();
        for (const w of weapons) names.set(w.name, (names.get(w.name) ?? 0) + 1);
        const firmPct = smallCraft ? rules.hardpoints.firmpointPowerPct : undefined;
        const powerOf = (watts: number) => (firmPct ? Math.ceil(r3((watts * custom.powerMult * firmPct) / 100)) : watts * custom.powerMult);
        const weaponList = weapons.length ? [...names].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(', ') : def.accepts ? 'No weapon fitted' : 'Empty';
        line.qty = qty;
        line.label = qty > 1 ? `${def.name}s x${qty}` : def.name;
        if (def.variable) {
          const weapon = weapons[0];
          const multiple = count(part.rating);
          const each = (weapon?.spinal ? weapon.spinal.baseTons * multiple : 0) * product(options, (o) => o.tonsMult) * custom.tonsMult;
          const dice = /^(\d+)D$/.exec(weapon?.damage ?? '');
          line.tons = qty * each;
          line.cost = qty * (weapon ? weapon.cost * multiple : 0) * product(options, (o) => o.costMult) * custom.costMult;
          line.power = qty * (weapon ? weapon.power * multiple * custom.powerMult : 0);
          line.hardpoints = qty * Math.ceil(r3(each / 100));
          line.detail = [weapon ? `${weapon.name}, ${multiple}x base size${dice ? `, ${Number(dice[1]) * multiple}D` : ''}` : 'No weapon chosen', ...options.map((o) => o.name), custom.text].filter(Boolean).join(', ');
          gunnersCommercial += qty * Math.ceil(r3(each / 100));
          gunnersMilitary += qty * Math.ceil(r3(each / 100));
          if (weapon?.spinal && each > weapon.spinal.maxTons) fail('spinal-max', `A ${weapon.name.toLowerCase()} spinal mount can be built up to ${weapon.spinal.maxTons.toLocaleString('en-US')} tons.`);
          if (each > hullTons / 2) fail('spinal-hull', 'A spinal mount cannot take up more than half the ship.');
        } else {
          const extra = smallCraft ? weapons.reduce((n, w) => n + (w.firmpointTons ?? 0), 0) : 0;
          const weaponCost = weapons.reduce((n, w) => n + w.cost, 0);
          line.detail = [weaponList, ...options.map((o) => o.name), custom.text].filter(Boolean).join(', ');
          line.tons = qty * ((def.tons + sum(options, (o) => o.tonsAdd)) * (turret ? 1 : custom.tonsMult) + extra);
          line.cost = qty * ((turret ? def.cost + weaponCost * custom.costMult : (def.cost + weaponCost) * custom.costMult) + sum(options, (o) => o.costFlat));
          line.power = qty * (def.power + weapons.reduce((n, w) => n + powerOf(w.power), 0));
          line.hardpoints = qty * (smallCraft ? (def.firmpoints ?? 1) : (def.hardpoints ?? 1));
          gunnersCommercial += qty * (def.gunner ? 1 : (def.gunnersMilitary ?? 0));
          gunnersMilitary += qty * (def.gunnersMilitary ?? (def.gunner ? 2 : 0));
        }
        line.tl = Math.max(def.tl, ...weapons.map((w) => w.tl + custom.tlShift + sum(options, (o) => o.tlAdd)), ...options.map((o) => o.tl ?? 0));
        if (smallCraft && def.gunner && !def.accepts) firmpointTurrets += qty;
        if (weapons.length > slots) fail('mount-slots', `${def.name === 'Fixed mount' && smallCraft ? 'A small craft fixed mount' : `A ${def.name.toLowerCase()}`} holds ${plural(slots, 'weapon')}.`);
        for (const w of weapons) {
          if ((w.mount ?? '') !== (def.accepts ?? '')) fail('mount-weapon', w.mount ? `A ${w.name.toLowerCase()} needs its own ${w.mount} mount.` : `A ${def.name.toLowerCase()} cannot carry a ${w.name.toLowerCase()}.`);
        }
        if (smallCraft && !def.firmpoint) fail('mount-firmpoint', 'A small craft firmpoint takes only a fixed mount or a single turret.');
        if (def.overTons !== undefined && hullTons <= def.overTons) fail('mount-hull', `A ${def.name.toLowerCase()} needs a hull of more than ${def.overTons.toLocaleString('en-US')} tons.`);
        break;
      }
      case 'fitting': {
        const def = rules.fittings.find((f) => f.id === part.key);
        if (!def) {
          unknown('Fitting');
          break;
        }
        const builtIn = !!def.builtInWhen && (cfg as unknown as Record<string, unknown>)[def.builtInWhen] === true;
        const custom = def.custom || part.grade || part.mods?.length ? customOf(def.custom ? rules : { ...rules, customising: undefined }, part, def.custom ?? '', fail) : STANDARD;
        const f = fittingFigures(def, part, { hullTons: fitTons, baseHullCost, plantTons, plantCost, builtIn });
        line.group = def.group;
        line.label = def.name;
        line.detail = [part.name?.trim(), f.detail, custom.text].filter(Boolean).join(', ');
        line.qty = f.qty;
        line.tons = f.tons * custom.tonsMult;
        line.cost = f.cost * custom.costMult;
        line.power = f.power * custom.powerMult;
        line.tl = (def.tl ?? 0) + custom.tlShift;
        line.hardpoints = f.qty * (def.hardpoints ?? 0);
        aux += f.output;
        stored += f.stored;
        armour += def.armourBonus ?? 0;
        troops += (def.troops ?? 0) * f.qty;
        gunnersCommercial += f.qty * (def.gunners ?? 0);
        gunnersMilitary += f.qty * (def.gunnersMilitary ?? def.gunners ?? 0);
        fittingParts.push({ partId: part.id, def });
        if (def.size === 'plant') plantSized.push({ line, def, part, custom });
        const n = (fittingsSeen.get(def.id) ?? 0) + 1;
        fittingsSeen.set(def.id, n);
        if (def.single && n > 1) fail('fitting-dup', `Only one set of ${def.name.toLowerCase()} can be fitted.`);
        if (def.needsAtmosphere && cfg.streamlined === 'none') fail('fitting-atmosphere', `${def.name} are no use on a hull that cannot enter atmosphere.`);
        if (def.size === 'tons' && def.minTons && f.tons < def.minTons) fail('fitting-min', `A ${def.name.toLowerCase()} needs at least ${formatTons(def.minTons)} tons.`, 'warn');
        if (def.maxHullPct && f.tons > (hullTons * def.maxHullPct) / 100 + 1e-9) fail('fitting-max', `${def.name}s can take up at most ${def.maxHullPct}% of the hull (${formatTons((hullTons * def.maxHullPct) / 100)} tons).`);
        if (def.maxQtyHullPct && f.qty > (hullTons * def.maxQtyHullPct) / 100 + 1e-9) fail('fitting-max', `${def.name} can cover at most ${def.maxQtyHullPct}% of the hull (${Math.floor((hullTons * def.maxQtyHullPct) / 100)} units).`);
        if (def.maxCapacityHullPct && amount(part.rating) * f.qty > (hullTons * def.maxCapacityHullPct) / 100 + 1e-9) fail('fitting-max', `${def.name} can cover at most ${def.maxCapacityHullPct}% of the hull (${formatTons((hullTons * def.maxCapacityHullPct) / 100)} tons).`);
        if (def.overTons !== undefined && hullTons <= def.overTons) fail('fitting-hull', `${def.name} is only for hulls over ${def.overTons.toLocaleString('en-US')} tons.`);
        if (def.maxHull !== undefined && hullTons > def.maxHull) fail('fitting-hull', `${def.name} is only for hulls up to ${def.maxHull.toLocaleString('en-US')} tons.`);
        if (def.berths) {
          quarters.berths += def.berths * f.qty;
          if (def.passage === 'high') quarters.high += f.qty;
          else quarters.staterooms += f.qty;
        }
        quarters.lowBerths += (def.lowBerths ?? 0) * f.qty;
        quarters.seats += (def.seats ?? 0) * f.qty;
        if (def.id === 'repairDrones') hasRepairDrones = true;
        break;
      }
      case 'craft':
      case 'custom': {
        const qty = count(part.qty);
        line.qty = qty;
        line.label = (part.name?.trim() || (part.kind === 'craft' ? 'Carried craft' : 'Custom fitting')) + (qty > 1 ? ` x${qty}` : '');
        line.tons = part.kind === 'craft' ? 0 : amount(part.tons) * qty;
        line.cost = Math.max(0, amount(part.cost)) * qty;
        line.power = Math.max(0, amount(part.power)) * qty;
        // A carried craft's `rating` is the crew it needs from the mother ship.
        if (part.kind === 'craft') craftCrew += count(part.rating, 0) * qty;
        break;
      }
    }
    if (line.tl > spec.tl) fail('tl', `${line.label} needs TL${line.tl}; this design is TL${spec.tl}.`);
    lines.push(line);
  }

  // ── fittings sized from the power plant, now that the whole plant is known ──
  for (const { line, def, part, custom } of plantSized) {
    const f = fittingFigures(def, part, { hullTons: fitTons, baseHullCost, plantTons, plantCost, builtIn: false });
    line.tons = f.tons * custom.tonsMult;
    line.cost = f.cost * custom.costMult;
    line.detail = [part.name?.trim(), f.detail, custom.text].filter(Boolean).join(', ');
  }
  for (const { partId, def } of fittingParts) {
    const clash = fittingParts.find((other) => other.def !== def && def.excludes?.includes(other.def.id));
    if (clash) issues.push({ level: 'error', code: 'fitting-clash', partId, text: `${def.name} cannot be combined with ${clash.def.name.toLowerCase()}.` });
  }

  // ── fuel ──
  const perParsec = ((hullTons * (rules.jdrive.fuelPct ?? 0)) / 100) * jumpFuelMult;
  const perPeriod = (plantStandardTons > 0 ? Math.max(rules.fuel.plantMinTons, ceilSafe((plantStandardTons * rules.fuel.plantPct) / 100)) : 0) + ceilSafe(plantOwnFuel);
  const parsecs = jump > 0 && perParsec > 0 ? Math.max(0, Math.min(jump, Math.floor(r3((fuelTons - perPeriod) / perParsec)))) : 0;
  const periods = perPeriod > 0 ? Math.max(0, Math.floor(r3((fuelTons - parsecs * perParsec) / perPeriod))) : 0;
  const weeks = periods * rules.fuel.plantWeeks;
  if (reaction.fuelPerHour > 0) reaction.hours = Math.max(0, Math.floor(r3(((fuelTons - parsecs * perParsec - Math.min(periods, 1) * perPeriod) / reaction.fuelPerHour) * 10)) / 10);
  for (const line of lines) {
    if (line.kind !== 'fuel') continue;
    line.detail = [jump > 0 ? `J-${parsecs}` : '', `${weeks} weeks of operation`, reaction.fuelPerHour > 0 ? `${reaction.hours} hours of reaction thrust` : '', fuelNotes.get(line.partId) ?? ''].filter(Boolean).join(', ');
  }

  // ── what every ship needs ──
  const missing: PartKind[] = [];
  const need = (kind: PartKind, level: IssueLevel, text: string) => {
    if (seen[kind]) return;
    missing.push(kind);
    issues.push({ level, code: `missing-${kind}`, text, kind });
  };
  need('plant', 'error', 'No power plant: nothing aboard will run.');
  need('bridge', 'error', smallCraft && hullTons <= 50 ? 'No bridge or cockpit.' : 'No bridge.');
  need('computer', 'error', 'No computer: every ship needs one.');
  if (!seen.rdrive) need('mdrive', 'warn', 'No manoeuvre drive: the ship cannot move under its own power.');
  if (seen.plant) {
    if (!seen.fuel) {
      if (perPeriod > 0 || jump > 0 || reaction.fuelPerHour > 0) {
        missing.push('fuel');
        issues.push({ level: 'error', code: 'missing-fuel', kind: 'fuel', text: `No fuel tanks: the power plant needs ${formatTons(perPeriod)} tons for every ${rules.fuel.plantWeeks} weeks.` });
      }
    } else if (periods === 0 && perPeriod > 0) {
      issues.push({ level: 'error', code: 'fuel-plant', kind: 'fuel', text: `Not enough fuel to run the power plant for ${rules.fuel.plantWeeks} weeks (${formatTons(perPeriod)} tons needed).` });
    }
  }
  if (jump > 0 && seen.fuel && parsecs < jump) {
    issues.push({
      level: 'warn',
      code: 'fuel-jump',
      kind: 'fuel',
      text: parsecs === 0 ? `No fuel for a jump: each parsec takes ${formatTons(perParsec)} tons.` : `Fuel for jump-${parsecs} only; a full jump-${jump} takes ${formatTons(perParsec * jump)} tons.`,
    });
  }
  if (reaction.fuelPerHour > 0 && seen.fuel && reaction.hours < 1) {
    issues.push({ level: 'warn', code: 'fuel-reaction', kind: 'fuel', text: `The reaction drive burns ${formatTons(reaction.fuelPerHour)} tons an hour at full thrust; the tanks give it ${reaction.hours} hours.` });
  }

  // ── power ──
  const output = lines.reduce((n, l) => n + l.output, 0);
  const power = {
    output,
    basic: ((hullTons * rules.power.basicPct) / 100) * product(hullOptions, (o) => o.basicPowerMult),
    mdrive: mdrivePower,
    jdrive: jdrivePower,
    other: lines.reduce((n, l) => n + l.power, 0),
    aux,
    stored,
  };
  if (seen.plant) {
    if (output < power.basic) {
      issues.push({ level: 'error', code: 'power-basic', kind: 'plant', text: `The power plant gives ${formatTons(output)} Power; basic ship systems alone need ${formatTons(power.basic)}.` });
    } else if (output < power.basic + power.mdrive) {
      issues.push({ level: 'warn', code: 'power-thrust', kind: 'plant', text: `Not enough Power to run basic systems and the manoeuvre drive together (${formatTons(power.basic + power.mdrive)} needed, ${formatTons(output)} available).` });
    } else if (jump > 0 && output < power.basic + power.jdrive) {
      issues.push({ level: 'warn', code: 'power-jump', kind: 'plant', text: `Not enough Power to jump without shutting down basic systems (${formatTons(power.basic + power.jdrive)} needed, ${formatTons(output)} available).` });
    } else if (output < power.basic + power.mdrive + power.other) {
      issues.push({ level: 'info', code: 'power-all', kind: 'plant', text: `Sensors, weapons and other systems cannot all run under full thrust (${formatTons(power.basic + power.mdrive + power.other)} Power needed, ${formatTons(output)} available).` });
    }
    if (jump > 0 && jumpOutput < power.jdrive && output >= power.jdrive) {
      issues.push({ level: 'error', code: 'plant-jump', kind: 'plant', text: 'Only a fusion or antimatter plant can deliver the burst of Power a jump drive needs.' });
    }
  }

  // ── hardpoints ──
  const hp = hardpointsFor(rules, hullTons);
  const used = lines.reduce((n, l) => n + l.hardpoints, 0);
  if (used > hp.total) {
    issues.push({ level: 'error', code: 'hardpoints', kind: 'mount', text: `Weapons take ${plural(used, hp.firm ? 'firmpoint' : 'hardpoint')} but the hull has ${hp.total}.` });
  }
  const turretLimit = rules.hardpoints.firmpointTurrets;
  if (smallCraft && turretLimit !== undefined && firmpointTurrets > turretLimit) {
    issues.push({ level: 'error', code: 'firmpoint-turrets', kind: 'mount', text: `Only ${plural(turretLimit, 'firmpoint')} on a small craft can carry a turret.` });
  }

  // ── software against the computer ──
  const computer = computers.length ? computers.reduce((best, c) => (c.processing > best.processing ? c : best)) : null;
  if (computers.length === 2 && computers[0].processing === computers[1].processing) {
    issues.push({ level: 'warn', code: 'computer-backup', partId: computers[1].partId, text: 'A backup computer is a lesser model than the primary.' });
  }
  const best = new Map<string, number>();
  for (const s of software) {
    const capacity = computer ? (s.family === 'jump' ? computer.jumpProcessing : computer.processing) : 0;
    if (computer && s.bandwidth > capacity) issues.push({ level: 'error', code: 'software-bandwidth', partId: s.partId, text: `${s.name} needs Processing ${s.bandwidth}; ${computer.name} offers ${capacity}.` });
    if (best.has(s.family)) issues.push({ level: 'info', code: 'software-dup', partId: s.partId, text: `${s.name} duplicates another program of the same kind; only the better one matters.` });
    best.set(s.family, Math.max(best.get(s.family) ?? 0, s.level));
    if (computer?.core && s.family === 'jump') {
      const line = lines.find((l) => l.partId === s.partId);
      if (line) {
        line.cost = 0;
        line.detail = 'Included with the computer core';
      }
    }
  }
  if (jump > 0 && (best.get('jump') ?? 0) < jump && !computer?.core) {
    const have = best.get('jump') ?? 0;
    missing.push('software');
    issues.push({ level: 'warn', code: 'software-jump', kind: 'software', text: have ? `Jump Control/${have} limits the ship to jump-${have}; the drive can do jump-${jump}.` : `No Jump Control software: the jump drive cannot be used.` });
  }
  if (best.has('autoRepair') && !hasRepairDrones) issues.push({ level: 'warn', code: 'software-drones', kind: 'fitting', text: 'Auto-Repair software needs repair drones aboard.' });

  // ── tonnage ──
  const tonsUsed = r3(lines.reduce((n, l) => n + l.tons, 0));
  const cargo = r3(hullTons - tonsUsed);
  if (cargo < 0) issues.push({ level: 'error', code: 'tonnage', text: `Over tonnage by ${formatTons(-cargo)} tons: the hull holds ${formatTons(hullTons)}.` });

  // ── crew ──
  const roleOf = (role: string) => rules.crew.roles.find((r) => r.id === role);
  const crew: CrewLine[] = [];
  const add = (role: string, n: number) => {
    const def = roleOf(role);
    if (n > 0 && def) crew.push({ role, name: def.name, count: n, salary: def.salary });
  };
  const headcount = () => crew.reduce((n, c) => n + c.count, 0);
  const establishment = rules.crew.establishment;
  const crewing = establishment && spec.crewing === 'military' ? 'military' : 'commercial';
  if (smallCraft) {
    add('pilot', 1);
  } else if (!establishment) {
    add('pilot', 1);
    add('astrogator', jump > 0 ? 1 : 0);
    add('engineer', Math.max(1, Math.ceil(r3((driveTons + plantTons) / rules.crew.engineerPerTons))));
    add('gunner', gunnersCommercial);
    const base = headcount();
    const spare = quarters.berths - base;
    if (quarters.lowBerths > 0 || quarters.high > 0 || spare >= 3) {
      const middle = Math.max(0, spare - quarters.high - 2);
      add('medic', Math.max(1, Math.ceil((base + Math.max(0, spare) + quarters.lowBerths) / rules.crew.medicPerPeople)));
      add('steward', Math.max(1, Math.ceil(r3(quarters.high / rules.crew.stewardPerHigh + middle / rules.crew.stewardPerMiddle))));
    }
  } else {
    const military = crewing === 'military';
    const cut = [...establishment.reductions].sort((a, b) => b.fromTons - a.fromTons).find((r) => hullTons >= r.fromTons)?.mult ?? 1;
    const cutFor = (role: string) => (establishment.reducedRoles.includes(role) ? cut : 1);
    add('captain', military || hullTons >= establishment.captainFromTons ? 1 : 0);
    add('pilot', establishment.pilots[crewing] + craftCrew);
    add('astrogator', jump > 0 ? 1 : 0);
    add('engineer', Math.max(1, Math.ceil(r3(((driveTons + plantTons) / rules.crew.engineerPerTons) * cutFor('engineer')))));
    add('maintenance', hands((hullTons / establishment.maintenancePerTons[crewing]) * cutFor('maintenance')));
    add('gunner', Math.ceil(r3((military ? gunnersMilitary : gunnersCommercial) * cutFor('gunner'))));
    add('administrator', hands((hullTons / establishment.adminPerTons[crewing]) * cutFor('administrator')));
    add('sensorOperator', Math.floor(r3(Math.floor(hullTons / establishment.sensors.perTons) * establishment.sensors[crewing] * cutFor('sensorOperator'))));
    const working = headcount();
    const spare = quarters.berths - working;
    const passengers = quarters.lowBerths > 0 || quarters.high > 0 || spare >= 3;
    if (passengers) {
      const middle = Math.max(0, spare - quarters.high - 2);
      add('steward', Math.max(1, Math.ceil(r3(quarters.high / rules.crew.stewardPerHigh + middle / rules.crew.stewardPerMiddle))));
    }
    if (military || passengers) add('medic', Math.max(1, Math.ceil((headcount() + Math.max(0, spare) + quarters.lowBerths + troops) / rules.crew.medicPerPeople)));
    add('officer', Math.floor(headcount() / establishment.officerPerCrew[crewing]));
  }
  const crewCount = headcount();
  const payroll = crew.reduce((n, c) => n + c.count * c.salary, 0);
  if (!smallCraft && crewCount > quarters.berths) {
    const doubled = crewCount <= quarters.berths * 2;
    issues.push({
      level: doubled && quarters.berths > 0 ? 'info' : 'warn',
      code: 'quarters',
      kind: 'fitting',
      text: quarters.berths === 0 ? `No staterooms for a crew of ${crewCount}.` : `A full crew is ${crewCount} but there are ${plural(quarters.berths, 'stateroom')}: ${doubled ? 'some will share' : 'there is not room for them all'}.`,
    });
  }
  if (smallCraft && bridgeSeats === 0 && !seen.bridge) {
    // already reported as a missing bridge
  }

  // ── cost ──
  const cost = Math.round(lines.reduce((n, l) => n + l.cost, 0));
  const stock = matchingStock(rules, spec);
  const discountPct = stock && !stock.noDiscount ? rules.costs.standardDiscountPct : 0;
  const purchase = Math.round(cost * (1 - discountPct / 100));
  const carried = lines.filter((l) => l.kind === 'craft').reduce((n, l) => n + l.cost, 0) * (1 - discountPct / 100);
  const maintenance = Math.round((purchase - carried) / rules.costs.maintenanceDivisor);
  const pace = [...(rules.costs.buildTimeByTl ?? [])].sort((a, b) => b.tl - a.tl).find((row) => spec.tl >= row.tl)?.pct ?? 100;
  const buildDays = Math.ceil(r3(((purchase / 1_000_000) * rules.hull.buildDaysPerMCr * pace) / 100));

  for (const line of lines) {
    line.tons = r3(line.tons);
    line.cost = Math.round(line.cost);
    line.power = r3(line.power);
    line.output = r3(line.output);
  }
  const order: Record<IssueLevel, number> = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);

  return {
    lines,
    hullTons,
    hullPoints,
    armour,
    streamlined: cfg.streamlined,
    smallCraft,
    tonsUsed,
    cargo,
    cost,
    discountPct,
    purchase,
    maintenance,
    buildDays,
    power: { output: r3(power.output), basic: r3(power.basic), mdrive: r3(power.mdrive), jdrive: r3(power.jdrive), other: r3(power.other), aux: r3(aux), stored: r3(stored) },
    thrust,
    jump,
    reaction: { thrust: reaction.thrust, fuelPerHour: r3(reaction.fuelPerHour), hours: reaction.hours },
    fuel: { tons: r3(fuelTons), perParsec: r3(perParsec), perPeriod, parsecs, weeks },
    hardpoints: { total: hp.total, used, firm: hp.firm },
    computer: computer ? { name: computer.name, processing: computer.processing, jumpProcessing: computer.jumpProcessing } : null,
    sensors,
    quarters,
    crew,
    crewCount,
    payroll,
    crewing,
    troops,
    tl: Math.max(0, ...lines.map((l) => l.tl)),
    issues,
    missing,
    stock,
  };
}

/** True when nothing stops the design being built as drawn. */
export function isBuildable(report: DesignReport): boolean {
  return !report.issues.some((i) => i.level === 'error');
}

// ───────────────────────────── shipyards ─────────────────────────────

export interface Yard {
  /** Starport class letter. */
  starport?: string;
  tl?: number;
  def?: ShipyardDef;
}

/** What the starport of a world can build. `uwp` is the world profile, e.g. "A788899-C". */
export function yardAt(rules: ShipRules, world: WorldRules | undefined, uwp: string | undefined): Yard {
  if (!uwp) return {};
  const starport = uwp[0]?.toUpperCase();
  const tlChar = uwp.replace(/[^0-9A-Za-z]/g, '')[7];
  const tl = tlChar ? parseInt(tlChar, 36) : undefined;
  const kind = world?.starport?.[starport]?.shipyard ?? 'none';
  return { starport, tl: Number.isFinite(tl) ? tl : undefined, def: rules.shipyards[kind] };
}

export function canBuildAnything(yard: Yard): boolean {
  return !!yard.def && (yard.def.smallCraft || yard.def.ships);
}

/** Reasons a yard cannot build the design as drawn. */
export function yardIssues(report: DesignReport, yard: Yard): DesignIssue[] {
  const out: DesignIssue[] = [];
  if (!canBuildAnything(yard)) {
    out.push({ level: 'error', code: 'yard-none', text: yard.starport ? `A class ${yard.starport} starport has no shipyard.` : 'There is no shipyard here.' });
    return out;
  }
  const def = yard.def!;
  if (report.smallCraft && !def.smallCraft) out.push({ level: 'error', code: 'yard-class', text: 'This yard does not build small craft.' });
  if (!report.smallCraft && !def.ships) out.push({ level: 'error', code: 'yard-class', text: `A class ${yard.starport} starport builds small craft only (under 100 tons).` });
  if (report.jump > 0 && !def.jump) out.push({ level: 'error', code: 'yard-jump', kind: 'jdrive', text: `A class ${yard.starport} starport cannot build jump-capable ships.` });
  if (yard.tl !== undefined) {
    for (const line of report.lines) {
      if (line.tl > yard.tl) out.push({ level: 'error', code: 'yard-tl', partId: line.partId, text: `${line.label} needs a TL${line.tl} shipyard; this world is TL${yard.tl}.` });
    }
  }
  return out;
}

// ───────────────────────────── the parts catalogue ─────────────────────────────

export interface CatalogueEntry {
  kind: PartKind;
  key?: string;
  name: string;
  group: string;
  tl: number;
  note?: string;
  /** Short figures for the palette, worked out for the current hull where they depend on it. */
  figures: string;
}

function figures(tons: number | undefined, cost: number | undefined, power?: number): string {
  const bits: string[] = [];
  if (tons !== undefined) bits.push(`${formatTons(tons)} t`);
  if (cost !== undefined) bits.push(formatMCr(cost));
  if (power) bits.push(`${formatTons(power)} Power`);
  return bits.join(' · ');
}

/** Everything that can be added to a design, with indicative size and price for this hull. */
export function catalogue(rules: ShipRules, spec: ShipSpec): CatalogueEntry[] {
  const hullTons = Math.max(0, amount(spec.hull.tons));
  const cfg = rules.hull.configurations.find((c) => c.id === spec.hull.config) ?? rules.hull.configurations[0];
  const hullCost = hullTons * (cfg.costPerTon ?? rules.hull.costPerTon) * cfg.costMult;
  const armourMult = (cfg.armourMult ?? 1) * (rules.hull.armourSizeMult?.find((r) => hullTons <= r.maxHull)?.mult ?? 1);
  const out: CatalogueEntry[] = [];
  for (const a of rules.armour) {
    const tons = (hullTons * a.tonsPct * armourMult) / 100;
    out.push({ kind: 'armour', key: a.id, name: `${a.name} armour`, group: 'hull', tl: a.tl, figures: `${figures(tons, a.costPerTon !== undefined ? tons * a.costPerTon : (hullCost * a.costPct) / 100)} per point` });
  }
  const m = rules.mdrive;
  out.push({ kind: 'mdrive', name: 'Manoeuvre drive', group: 'drives', tl: m.zero?.tl ?? m.tl[0] ?? 0, figures: `${figures((hullTons * m.tonsPct) / 100, ((hullTons * m.tonsPct) / 100) * m.costPerTon)} per Thrust`, note: m.note ?? 'Gravitic thrusters. Each point of Thrust is 1G of acceleration.' });
  const rd = rules.rdrive;
  if (rd) out.push({ kind: 'rdrive', name: 'Reaction drive', group: 'drives', tl: rd.zero?.tl ?? rd.tl[0] ?? 0, figures: `${figures((hullTons * rd.tonsPct) / 100, ((hullTons * rd.tonsPct) / 100) * rd.costPerTon)} per Thrust`, note: rd.note ?? 'Rockets: no Power needed, but they burn fuel by the hour.' });
  const jd = rules.jdrive;
  const j1 = Math.max(jd.minTons ?? 0, (hullTons * jd.tonsPct) / 100 + (jd.plusTons ?? 0));
  out.push({ kind: 'jdrive', name: 'Jump drive', group: 'drives', tl: jd.tl[0] ?? 0, figures: `${figures(j1, j1 * jd.costPerTon)} for Jump-1`, note: 'Faster-than-light travel: one parsec per point, a week in jump space.' });
  for (const p of rules.plants) out.push({ kind: 'plant', key: p.id, name: p.name, group: 'power', tl: p.tl, note: p.note, figures: `${p.powerPerTon} Power and ${formatMCr(p.costPerTon)} per ton` });
  out.push({ kind: 'fuel', name: 'Fuel tanks', group: 'fuel', tl: 0, figures: 'No cost', note: 'Tankage for the jump drive and the power plant.' });
  for (const b of rules.bridge.types) {
    const fixed = b.tons !== undefined;
    const row = rules.bridge.sizes.find((s) => hullTons <= s.maxHull) ?? rules.bridge.sizes[rules.bridge.sizes.length - 1];
    out.push({ kind: 'bridge', key: b.id, name: b.name, group: 'command', tl: 0, note: b.note, figures: fixed ? figures(b.tons, b.cost) : figures(row?.tons, ceilSafe(hullTons / 100) * rules.bridge.costPer100Tons) });
  }
  for (const c of rules.computers) out.push({ kind: 'computer', key: c.id, name: c.name, group: 'command', tl: c.tl, figures: `Processing ${c.processing} · ${formatMCr(c.cost)}` });
  for (const s of rules.sensors) {
    if (s.included) continue;
    out.push({ kind: 'sensors', key: s.id, name: `${s.name} sensors`, group: 'command', tl: s.tl, figures: `DM${s.dm >= 0 ? '+' : ''}${s.dm} · ${figures(s.tons, s.cost, s.power)}`, note: s.suite });
  }
  for (const mount of rules.mounts) {
    out.push({ kind: 'mount', key: mount.id, name: mount.name, group: 'weapons', tl: mount.tl, note: mount.note, figures: mount.variable ? 'Sized by its weapon' : figures(mount.tons, mount.cost || undefined, mount.power) || 'Priced with its weapon' });
  }
  for (const f of rules.fittings) {
    let fig = '';
    if (f.size === 'unit') fig = figures(f.unitTons, f.unitCost, f.unitPower) + (f.unitLabel ? ` per ${f.unitLabel}` : '');
    else if (f.size === 'tons') fig = [f.costPerStep ? `${formatMCr(f.costPerStep)} per ${f.stepTons} tons` : f.costPerTon ? `${formatMCr(f.costPerTon)} per ton` : 'No cost', f.outputPerTon ? `${f.outputPerTon} Power per ton` : '', f.storePerTon ? `holds ${f.storePerTon} Power per ton` : ''].filter(Boolean).join(' · ');
    else if (f.size === 'hull') {
      const tons = f.hullPct || f.plusTons ? Math.max(f.minTons ?? 0, (hullTons * (f.hullPct ?? 0)) / 100 + (f.plusTons ?? 0)) : 0;
      fig = figures(tons, tons * (f.costPerTon ?? 0) + hullTons * (f.costPerHullTon ?? 0) + hullCost * (f.hullCostAdd ?? 0), hullTons * (f.powerPerHullTon ?? 0) + tons * (f.powerPerTon ?? 0));
    } else if (f.size === 'capacity') {
      const per = f.capacityLabel ?? 'tons';
      fig = [f.capacityMult ? `${formatTons(f.capacityMult)} t per ton of ${per.replace(/^tons? of /, '')}` : 'No tonnage', f.costPerTon ? `${formatMCr(f.costPerTon)} per ton` : '', f.costPerCapacity ? `${formatMCr(f.costPerCapacity)} per ton served` : ''].filter(Boolean).join(' · ');
    } else if (f.size === 'plant') fig = `${f.plantPct ?? 0}% of the power plant, in tons and price`;
    else fig = `Craft tonnage +${f.dockingPct ?? 0}% · ${formatMCr(f.costPerTon ?? 0)} per ton`;
    out.push({ kind: 'fitting', key: f.id, name: f.name, group: f.group, tl: f.tl ?? 0, note: f.note, figures: fig });
  }
  for (const s of rules.software) {
    if (s.included) continue;
    out.push({ kind: 'software', key: s.id, name: s.name, group: 'software', tl: s.tl, note: s.effect, figures: `Bandwidth ${s.bandwidth} · ${formatMCr(s.cost)}` });
  }
  out.push({ kind: 'craft', name: 'Carried craft or vehicle', group: 'craft', tl: 0, figures: 'Name and price', note: 'A boat or vehicle bought with the ship. It needs docking space.' });
  out.push({ kind: 'custom', name: 'Custom fitting', group: 'custom', tl: 0, figures: 'Name, tons, price', note: 'Anything not in the catalogue: house rules or parts from other books.' });
  return out;
}

export interface EntryState {
  /** Why it cannot be added, if it cannot. */
  blocked?: string;
  /** The part it would replace (choosing a different bridge, computer, sensor suite...). */
  replaces?: string;
  /** The design needs one of these. */
  needed?: boolean;
}

/** Whether a catalogue entry can go into the design as it stands, and whether the design is crying out for it. */
export function entryState(rules: ShipRules, spec: ShipSpec, report: DesignReport, entry: CatalogueEntry, yardTl?: number): EntryState {
  const state: EntryState = {};
  if (report.missing.includes(entry.kind)) state.needed = true;
  const cfg = rules.hull.configurations.find((c) => c.id === spec.hull.config) ?? rules.hull.configurations[0];
  const existing = (kind: PartKind) => spec.parts.find((p) => p.kind === kind);
  const limit = Math.min(spec.tl, yardTl ?? Infinity);
  if (entry.tl > limit) {
    state.blocked = entry.tl > spec.tl ? `Needs TL${entry.tl}` : `Needs a TL${entry.tl} shipyard`;
    return state;
  }
  switch (entry.kind) {
    case 'armour':
      if (cfg.noArmour) state.blocked = `Not on a ${cfg.name.toLowerCase()} hull`;
      else if (existing('armour')?.key === entry.key) state.blocked = 'Already fitted';
      else state.replaces = existing('armour')?.id;
      break;
    case 'mdrive':
    case 'rdrive':
      if (existing(entry.kind)) state.blocked = 'Already fitted';
      break;
    case 'jdrive':
      if (rules.jdrive.minHull && report.hullTons < rules.jdrive.minHull) state.blocked = `Hulls under ${rules.jdrive.minHull} tons cannot jump`;
      else if (existing('jdrive')) state.blocked = 'Already fitted';
      break;
    case 'bridge': {
      const def = rules.bridge.types.find((b) => b.id === entry.key);
      if (def?.maxHull !== undefined && report.hullTons > def.maxHull) state.blocked = `Hulls of ${def.maxHull} tons or less only`;
      else if (existing('bridge')?.key === entry.key) state.blocked = 'Already fitted';
      else state.replaces = existing('bridge')?.id;
      break;
    }
    case 'computer':
    case 'sensors':
      if (existing(entry.kind)?.key === entry.key) state.blocked = 'Already fitted';
      else state.replaces = existing(entry.kind)?.id;
      break;
    case 'mount': {
      const def = rules.mounts.find((m) => m.id === entry.key);
      const wants = def?.variable ? 1 : report.smallCraft ? (def?.firmpoints ?? 1) : (def?.hardpoints ?? 1);
      const word = report.hardpoints.firm ? 'firmpoints' : 'hardpoints';
      if (report.smallCraft && def && !def.firmpoint) state.blocked = 'Not on a small craft firmpoint';
      else if (def?.overTons !== undefined && report.hullTons <= def.overTons) state.blocked = `Hulls over ${def.overTons.toLocaleString('en-US')} tons only`;
      else if (report.hardpoints.total === 0) state.blocked = 'This hull has no hardpoints';
      else if (report.hardpoints.used >= report.hardpoints.total) state.blocked = `All ${word} are in use`;
      else if (report.hardpoints.used + wants > report.hardpoints.total) state.blocked = `Needs ${wants} free ${word}`;
      break;
    }
    case 'fitting': {
      const def = rules.fittings.find((f) => f.id === entry.key);
      if (!def) break;
      const fitted = spec.parts.filter((p) => p.kind === 'fitting').map((p) => rules.fittings.find((f) => f.id === p.key)).filter((f) => f !== undefined);
      const clash = fitted.find((other) => def.excludes?.includes(other.id) || other.excludes?.includes(def.id));
      if (def.builtInWhen && (cfg as unknown as Record<string, unknown>)[def.builtInWhen] === true) state.blocked = 'Built into this hull';
      else if (def.needsAtmosphere && cfg.streamlined === 'none') state.blocked = 'No use on this hull';
      else if (def.overTons !== undefined && report.hullTons <= def.overTons) state.blocked = `Hulls over ${def.overTons.toLocaleString('en-US')} tons only`;
      else if (def.maxHull !== undefined && report.hullTons > def.maxHull) state.blocked = `Hulls up to ${def.maxHull.toLocaleString('en-US')} tons only`;
      else if (def.single && spec.parts.some((p) => p.kind === 'fitting' && p.key === def.id)) state.blocked = 'Already fitted';
      else if (clash) state.blocked = `Not with ${clash.name.toLowerCase()}`;
      else if (def.hardpoints && report.hardpoints.used + def.hardpoints > report.hardpoints.total) state.blocked = `Needs ${plural(def.hardpoints, 'free hardpoint')}`;
      break;
    }
    case 'software': {
      const def = rules.software.find((s) => s.id === entry.key);
      if (!def) break;
      const same = spec.parts.filter((p) => p.kind === 'software').map((p) => ({ part: p, def: rules.software.find((s) => s.id === p.key) })).find((x) => x.def?.family === def.family);
      const capacity = report.computer ? (def.family === 'jump' ? report.computer.jumpProcessing : report.computer.processing) : undefined;
      if (same?.def && same.def.level === def.level) state.blocked = 'Already installed';
      else if (capacity !== undefined && def.bandwidth > capacity) state.blocked = `Needs Processing ${def.bandwidth}`;
      else state.replaces = same?.part.id;
      break;
    }
    default:
      break;
  }
  return state;
}

/** Tons of power plant of this type that would run basic systems, the drives and everything fitted. */
export function plantTonsFor(rules: ShipRules, report: DesignReport, plantKey: string, everything = true): number {
  const def = rules.plants.find((p) => p.id === plantKey);
  if (!def) return 1;
  const need = report.power.basic + Math.max(report.power.mdrive + (everything ? report.power.other : 0), report.power.jdrive) + (everything ? 0 : 0);
  return Math.max(1, ceilSafe(need / def.powerPerTon));
}

/** Tons of fuel for one full jump and `weeks` of power plant operation. */
export function fuelTonsFor(rules: ShipRules, report: DesignReport, weeks = rules.fuel.plantWeeks, parsecs = report.jump): number {
  const periods = Math.max(1, Math.ceil(weeks / rules.fuel.plantWeeks));
  return r3(report.fuel.perParsec * parsecs + Math.max(report.fuel.perPeriod, rules.fuel.plantMinTons) * periods);
}

/** A new part for a catalogue entry, sized sensibly for the design as it stands. */
export function defaultPart(rules: ShipRules, _spec: ShipSpec, report: DesignReport, entry: { kind: PartKind; key?: string }): DesignPart {
  const part: DesignPart = { id: newPartId(), kind: entry.kind, ...(entry.key ? { key: entry.key } : {}) };
  switch (entry.kind) {
    case 'armour':
    case 'mdrive':
    case 'rdrive':
    case 'jdrive':
      part.rating = 1;
      break;
    case 'plant': {
      const have = report.power.output;
      const need = report.power.basic + Math.max(report.power.mdrive + report.power.other, report.power.jdrive);
      const def = rules.plants.find((p) => p.id === entry.key);
      part.tons = def ? Math.max(1, ceilSafe(Math.max(0, need - have) / def.powerPerTon)) : 1;
      break;
    }
    case 'fuel':
      part.tons = Math.max(1, fuelTonsFor(rules, report) - report.fuel.tons);
      break;
    case 'mount': {
      part.weapons = [];
      const def = rules.mounts.find((m) => m.id === entry.key);
      if (def?.variable) {
        part.rating = 1;
        const weapon = rules.weapons.find((w) => w.mount === def.accepts && w.spinal && w.tl <= _spec.tl) ?? rules.weapons.find((w) => w.mount === def.accepts && w.spinal);
        if (weapon) part.weapons = [weapon.id];
      }
      break;
    }
    case 'fitting': {
      const def = rules.fittings.find((f) => f.id === entry.key);
      if (def?.size === 'unit') part.qty = 1;
      else if (def?.size === 'tons') part.tons = def.minTons ?? (def.stepTons ? def.stepTons : 1);
      else if (def?.size === 'docking') part.rating = 4;
      else if (def?.size === 'capacity') part.rating = def.minTons ?? 10;
      break;
    }
    case 'craft':
      part.name = 'Carried craft';
      part.cost = 0;
      break;
    case 'custom':
      part.name = 'Custom fitting';
      part.tons = 1;
      part.cost = 0;
      break;
    default:
      break;
  }
  return part;
}

/** Where a kind of part sits by default along the hull, bow (low) to stern (high). */
export function rankOf(line: Pick<PartLine, 'kind' | 'group'>): number {
  switch (line.kind) {
    case 'armour':
      return -1;
    case 'bridge':
      return 0;
    case 'sensors':
    case 'computer':
    case 'software':
      return 1;
    case 'mount':
      return 2;
    case 'fuel':
      return 7;
    case 'plant':
      return 8;
    case 'jdrive':
      return 9;
    case 'mdrive':
    case 'rdrive':
      return 10;
    default:
      break;
  }
  switch (line.group) {
    case 'weapons':
    case 'screens':
      return 2;
    case 'quarters':
      return 3;
    case 'systems':
    case 'drones':
      return 4;
    case 'craft':
    case 'cargo':
      return 5;
    case 'fuel':
      return 7;
    case 'power':
      return 8;
    case 'hull':
      return -1;
    case 'command':
      return 1;
    default:
      return 6;
  }
}

/** The rank at which the cargo hold sits when nobody has moved it. */
export const CARGO_RANK = 6;

/** Puts the parts in the conventional order: command forward, quarters and systems amidships, engineering aft. */
export function arrangeParts(rules: ShipRules, spec: ShipSpec): ShipSpec {
  const lines = new Map(evaluateDesign(rules, spec).lines.map((l) => [l.partId, l]));
  const parts = spec.parts
    .map((part, index) => ({ part, index, rank: rankOf(lines.get(part.id) ?? { kind: part.kind, group: 'custom' }) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.part);
  const { cargoAt: _cargoAt, ...rest } = spec;
  return { ...rest, parts };
}

/** A bare hull with nothing in it. */
export function blankSpec(rules: ShipRules, tons = 200, tl = 12): ShipSpec {
  return { tl, hull: { tons, config: rules.hull.configurations[0]?.id ?? 'standard' }, parts: [] };
}

/** The figures a finished ship carries on its record card. */
export function shipFigures(report: DesignReport): { tons: number; jump: number; thrust: number; cargo: number; fuelCapacity: number; staterooms: number; lowBerths: number; hullMax: number; armour: number; maintenance: number } {
  return {
    tons: report.hullTons,
    jump: report.jump,
    thrust: report.thrust > 0 ? report.thrust : report.reaction.thrust,
    cargo: Math.max(0, report.cargo),
    fuelCapacity: report.fuel.tons,
    staterooms: report.quarters.staterooms + report.quarters.high,
    lowBerths: report.quarters.lowBerths,
    hullMax: report.hullPoints,
    armour: report.armour,
    maintenance: report.maintenance,
  };
}
