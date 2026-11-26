/**
 * Spacecraft design. Turns a hull and a list of parts into tonnage, cost, power and crew figures,
 * and reports what is missing, what does not fit and what a given shipyard cannot build.
 * Every number comes from the rules pack; this file only knows how the pieces relate.
 */
import type { FittingDef, ShipRules, ShipyardDef, StockDesign, WorldRules } from '../rulepack';
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
  power: { output: number; basic: number; mdrive: number; jdrive: number; other: number };
  thrust: number;
  jump: number;
  fuel: { tons: number; perParsec: number; perPeriod: number; parsecs: number; weeks: number };
  hardpoints: { total: number; used: number; firm: boolean };
  computer: { name: string; processing: number; jumpProcessing: number } | null;
  sensors: { name: string; dm: number };
  quarters: { staterooms: number; high: number; berths: number; lowBerths: number; seats: number };
  crew: CrewLine[];
  crewCount: number;
  payroll: number;
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

/** Size and cost of a fitting line. */
function fittingFigures(def: FittingDef, part: DesignPart, hullTons: number, builtIn: boolean): { tons: number; cost: number; power: number; qty: number; detail: string } {
  if (def.size === 'unit') {
    const qty = count(part.qty);
    const each = def.unitLabel ? ` (per ${def.unitLabel})` : '';
    return {
      qty,
      tons: qty * (def.unitTons ?? 0),
      cost: builtIn ? 0 : qty * (def.unitCost ?? 0),
      power: qty * (def.unitPower ?? 0),
      detail: builtIn ? 'Built into the hull' : qty > 1 || def.unitLabel ? `x${qty}${each}` : '',
    };
  }
  if (def.size === 'docking') {
    const qty = count(part.qty);
    const craft = Math.max(0, amount(part.rating));
    const each = ceilSafe(craft * (1 + (def.dockingPct ?? 0) / 100));
    return { qty, tons: each * qty, cost: each * qty * (def.costPerTon ?? 0), power: 0, detail: `for ${qty > 1 ? `${qty} craft of ` : 'a craft of '}${formatTons(craft)} tons` };
  }
  if (def.size === 'hull') {
    const tons = def.hullPct ? Math.max(def.minTons ?? 0, (hullTons * def.hullPct) / 100) : 0;
    return {
      qty: 1,
      tons,
      cost: tons * (def.costPerTon ?? 0) + hullTons * (def.costPerHullTon ?? 0),
      power: hullTons * (def.powerPerHullTon ?? 0),
      detail: def.hullPct ? `${def.hullPct}% of the hull` : '',
    };
  }
  const tons = Math.max(0, amount(part.tons));
  const steps = def.stepTons ? ceilSafe(tons / def.stepTons) : 0;
  return {
    qty: 1,
    tons,
    cost: tons * (def.costPerTon ?? 0) + steps * (def.costPerStep ?? 0),
    power: tons * (def.powerPerTon ?? 0) + steps * (def.powerPerStep ?? 0),
    detail: def.perTonValue ? `${formatTons(tons * def.perTonValue)} ${def.perTonLabel?.replace(/^\d+\s*/, '') ?? ''}`.trim() : '',
  };
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
  };
}

export function evaluateDesign(rules: ShipRules, spec: ShipSpec): DesignReport {
  const issues: DesignIssue[] = [];
  const lines: PartLine[] = [];
  const hullTons = Math.max(0, amount(spec.hull.tons));
  const cfg = rules.hull.configurations.find((c) => c.id === spec.hull.config) ?? rules.hull.configurations[0];
  const hullOptions = (spec.hull.options ?? []).map((id) => rules.hull.options.find((o) => o.id === id)).filter((o) => o !== undefined);
  const hullCost = hullTons * rules.hull.costPerTon * cfg.costMult * (1 + hullOptions.reduce((n, o) => n + (o.costAdd ?? 0), 0));
  const hullPoints = Math.floor(Math.floor(hullTons / rules.hull.tonsPerHullPoint + 1e-9) * cfg.hullMult * hullOptions.reduce((n, o) => n * (o.hullMult ?? 1), 1) + 1e-9);
  const smallCraft = isSmallCraft(rules, hullTons);

  lines.push({
    partId: 'hull',
    kind: 'hull',
    group: 'hull',
    label: `${formatTons(hullTons)}-ton hull`,
    detail: [cfg.name, ...hullOptions.map((o) => o.name)].join(', '),
    qty: 1,
    tons: 0,
    cost: hullCost,
    power: 0,
    output: 0,
    tl: 0,
    hardpoints: 0,
    known: true,
  });
  if (hullTons < rules.hull.minTons) issues.push({ level: 'error', code: 'hull-small', text: `A hull must be at least ${rules.hull.minTons} tons.` });
  if (hullTons > rules.hull.maxTons) issues.push({ level: 'error', code: 'hull-large', text: `Hulls over ${rules.hull.maxTons.toLocaleString('en-US')} tons are beyond these construction rules.` });

  const seen: Partial<Record<PartKind, number>> = {};
  const fittingsSeen = new Map<string, number>();
  let thrust = 0;
  let jump = 0;
  let driveTons = 0;
  let plantTons = 0;
  let fuelTons = 0;
  let armour = 0;
  let gunners = 0;
  let computer: DesignReport['computer'] = null;
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
    const fail = (code: string, text: string, level: IssueLevel = 'error') => issues.push({ level, code, text, partId: part.id });
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
        line.label = `${def.name} armour`;
        line.detail = `Protection +${rating}`;
        line.tons = (hullTons * def.tonsPct * rating) / 100;
        line.cost = (hullCost * def.costPct * rating) / 100;
        line.tl = def.tl;
        armour += rating;
        if (cfg.noArmour) fail('armour-config', `A ${cfg.name.toLowerCase()} hull cannot be given extra armour.`);
        const cap = Math.min(def.maxByTl ? spec.tl : Infinity, def.max ?? Infinity);
        if (rating > cap) fail('armour-max', `${def.name} is limited to Protection +${cap} at TL${spec.tl}.`);
        if (nth > 1) fail('armour-dup', 'Only one type of armour can be fitted.');
        break;
      }
      case 'mdrive':
      case 'jdrive': {
        const isJump = part.kind === 'jdrive';
        const def = isJump ? rules.jdrive : rules.mdrive;
        const rating = count(part.rating);
        line.label = isJump ? 'Jump drive' : 'Manoeuvre drive';
        line.detail = isJump ? `Jump-${rating}` : `Thrust ${rating}`;
        line.tons = Math.max(def.minTons ?? 0, (hullTons * def.tonsPct * rating) / 100 + (def.plusTons ?? 0));
        line.cost = line.tons * def.costPerTon;
        if (rating > def.tl.length) fail('drive-rating', `${line.label}s only go up to ${isJump ? 'Jump-' : 'Thrust '}${def.tl.length}.`);
        line.tl = def.tl[Math.min(rating, def.tl.length) - 1] ?? 0;
        if (nth > 1) {
          fail('drive-dup', `Only one ${line.label.toLowerCase()} can be fitted.`);
        } else {
          driveTons += line.tons;
          if (isJump) jump = rating;
          else thrust = rating;
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
        line.tons = Math.max(0, amount(part.tons));
        line.output = line.tons * def.powerPerTon;
        line.cost = line.tons * def.costPerTon;
        line.tl = def.tl;
        line.label = 'Power plant';
        line.detail = `${def.name}, Power ${formatTons(line.output)}`;
        plantTons += line.tons;
        if (line.tons <= 0) fail('plant-size', 'Give the power plant a size.');
        break;
      }
      case 'fuel': {
        line.tons = Math.max(0, amount(part.tons));
        line.label = 'Fuel tanks';
        fuelTons += line.tons;
        break;
      }
      case 'bridge': {
        const def = rules.bridge.types.find((b) => b.id === (part.key ?? 'bridge'));
        if (!def) {
          unknown('Bridge');
          break;
        }
        const options = (part.options ?? []).map((id) => rules.bridge.options.find((o) => o.id === id)).filter((o) => o !== undefined);
        line.label = def.name;
        if (def.tons !== undefined) {
          line.tons = def.tons;
          line.cost = def.cost ?? 0;
          if (def.maxHull !== undefined && hullTons > def.maxHull) fail('cockpit-size', `A ${def.name.toLowerCase()} only suits hulls of ${def.maxHull} tons or less.`);
        } else {
          const step = options.reduce((n, o) => n + (o.sizeStep ?? 0), 0);
          const index = Math.max(0, rules.bridge.sizes.findIndex((s) => hullTons <= s.maxHull));
          line.tons = rules.bridge.sizes[Math.max(0, Math.min(rules.bridge.sizes.length - 1, index + step))].tons;
          line.cost = ceilSafe(hullTons / 100) * rules.bridge.costPer100Tons * options.reduce((n, o) => n * (o.costMult ?? 1), 1) * (1 + options.reduce((n, o) => n + (o.costAdd ?? 0), 0));
          line.detail = options.map((o) => o.name).join(', ');
          line.tl = Math.max(0, ...options.map((o) => o.tl ?? 0));
        }
        bridgeSeats += def.seats ?? 0;
        if (nth > 1) fail('bridge-dup', 'A ship has one bridge or cockpit.');
        break;
      }
      case 'computer': {
        const def = rules.computers.find((c) => c.id === part.key);
        if (!def) {
          unknown('Computer');
          break;
        }
        const options = (part.options ?? []).map((id) => rules.computerOptions.find((o) => o.id === id)).filter((o) => o !== undefined);
        line.label = def.name + options.map((o) => o.suffix ?? '').join('');
        line.detail = options.map((o) => o.name).join(', ');
        line.cost = def.cost * (1 + options.reduce((n, o) => n + (o.costAdd ?? 0), 0));
        line.tl = Math.max(def.tl, ...options.map((o) => o.tl ?? 0));
        const jumpProcessing = def.processing + options.reduce((n, o) => n + (o.jumpBonus ?? 0), 0);
        if (!computer || def.processing > computer.processing) computer = { name: line.label, processing: def.processing, jumpProcessing };
        if (nth > 1) fail('computer-dup', 'A second computer is a backup: software runs on the more powerful one.', 'info');
        break;
      }
      case 'sensors': {
        const def = rules.sensors.find((s) => s.id === part.key);
        if (!def) {
          unknown('Sensors');
          break;
        }
        line.label = `${def.name} sensors`;
        line.detail = `DM${def.dm >= 0 ? '+' : ''}${def.dm}${def.suite ? ` · ${def.suite}` : ''}`;
        line.tons = def.tons;
        line.cost = def.cost;
        line.power = def.power;
        line.tl = def.tl;
        if (def.dm >= sensors.dm) sensors = { name: def.name, dm: def.dm };
        if (nth > 1) fail('sensors-dup', 'Only one sensor suite is needed.', 'warn');
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
        const slots = smallCraft && def.smallCraftSlots !== undefined ? def.smallCraftSlots : def.slots;
        const names = new Map<string, number>();
        for (const w of weapons) names.set(w.name, (names.get(w.name) ?? 0) + 1);
        line.qty = qty;
        line.label = qty > 1 ? `${def.name}s x${qty}` : def.name;
        line.detail = weapons.length ? [...names].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(', ') : def.accepts ? 'No weapon fitted' : 'Empty';
        line.tons = qty * def.tons;
        line.cost = qty * (def.cost + weapons.reduce((n, w) => n + w.cost, 0));
        line.power = qty * (def.power + weapons.reduce((n, w) => n + w.power, 0));
        line.tl = Math.max(def.tl, ...weapons.map((w) => w.tl));
        line.hardpoints = qty;
        if (def.gunner) gunners += qty;
        if (weapons.length > slots) fail('mount-slots', `${def.name === 'Fixed mount' && smallCraft ? 'A small craft fixed mount' : `A ${def.name.toLowerCase()}`} holds ${plural(slots, 'weapon')}.`);
        for (const w of weapons) {
          if ((w.mount ?? '') !== (def.accepts ?? '')) fail('mount-weapon', w.mount ? `A ${w.name.toLowerCase()} needs its own ${w.mount} mount.` : `A ${def.name.toLowerCase()} cannot carry a ${w.name.toLowerCase()}.`);
        }
        if (smallCraft && !def.firmpoint) fail('mount-firmpoint', 'A small craft firmpoint takes only a fixed mount or a single turret.');
        break;
      }
      case 'fitting': {
        const def = rules.fittings.find((f) => f.id === part.key);
        if (!def) {
          unknown('Fitting');
          break;
        }
        const builtIn = !!def.builtInWhen && (cfg as unknown as Record<string, unknown>)[def.builtInWhen] === true;
        const f = fittingFigures(def, part, hullTons, builtIn);
        line.group = def.group;
        line.label = def.name;
        line.detail = f.detail;
        line.qty = f.qty;
        line.tons = f.tons;
        line.cost = f.cost;
        line.power = f.power;
        line.tl = def.tl ?? 0;
        const n = (fittingsSeen.get(def.id) ?? 0) + 1;
        fittingsSeen.set(def.id, n);
        if (def.single && n > 1) fail('fitting-dup', `Only one set of ${def.name.toLowerCase()} can be fitted.`);
        if (def.needsAtmosphere && cfg.streamlined === 'none') fail('fitting-atmosphere', `${def.name} are no use on a hull that cannot enter atmosphere.`);
        if (def.size === 'tons' && def.minTons && f.tons < def.minTons) fail('fitting-min', `A ${def.name.toLowerCase()} needs at least ${formatTons(def.minTons)} tons.`, 'warn');
        if (def.maxHullPct && f.tons > (hullTons * def.maxHullPct) / 100 + 1e-9) fail('fitting-max', `${def.name}s can take up at most ${def.maxHullPct}% of the hull (${formatTons((hullTons * def.maxHullPct) / 100)} tons).`);
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
        break;
      }
    }
    if (line.tl > spec.tl) fail('tl', `${line.label} needs TL${line.tl}; this design is TL${spec.tl}.`);
    lines.push(line);
  }

  // ── fuel ──
  const perParsec = (hullTons * (rules.jdrive.fuelPct ?? 0)) / 100;
  const perPeriod = plantTons > 0 ? Math.max(rules.fuel.plantMinTons, ceilSafe((plantTons * rules.fuel.plantPct) / 100)) : 0;
  const parsecs = jump > 0 && perParsec > 0 ? Math.max(0, Math.min(jump, Math.floor(r3((fuelTons - perPeriod) / perParsec)))) : 0;
  const periods = perPeriod > 0 ? Math.max(0, Math.floor(r3((fuelTons - parsecs * perParsec) / perPeriod))) : 0;
  const weeks = periods * rules.fuel.plantWeeks;
  for (const line of lines) {
    if (line.kind === 'fuel') line.detail = [jump > 0 ? `J-${parsecs}` : '', `${weeks} weeks of operation`].filter(Boolean).join(', ');
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
  need('mdrive', 'warn', 'No manoeuvre drive: the ship cannot move under its own power.');
  if (seen.plant) {
    if (!seen.fuel) {
      missing.push('fuel');
      issues.push({ level: 'error', code: 'missing-fuel', kind: 'fuel', text: `No fuel tanks: the power plant needs ${formatTons(perPeriod)} tons for every ${rules.fuel.plantWeeks} weeks.` });
    } else if (periods === 0) {
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

  // ── power ──
  const output = lines.reduce((n, l) => n + l.output, 0);
  const power = {
    output,
    basic: (hullTons * rules.power.basicPct) / 100,
    mdrive: (hullTons * rules.mdrive.powerPct * thrust) / 100,
    jdrive: (hullTons * rules.jdrive.powerPct * jump) / 100,
    other: lines.reduce((n, l) => n + l.power, 0),
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
  }

  // ── hardpoints ──
  const hp = hardpointsFor(rules, hullTons);
  const used = lines.reduce((n, l) => n + l.hardpoints, 0);
  if (used > hp.total) {
    issues.push({ level: 'error', code: 'hardpoints', kind: 'mount', text: `${plural(used, 'weapon mount')} fitted but the hull has ${plural(hp.total, hp.firm ? 'firmpoint' : 'hardpoint')}.` });
  }

  // ── software against the computer ──
  const best = new Map<string, number>();
  for (const s of software) {
    const capacity = computer ? (s.family === 'jump' ? computer.jumpProcessing : computer.processing) : 0;
    if (computer && s.bandwidth > capacity) issues.push({ level: 'error', code: 'software-bandwidth', partId: s.partId, text: `${s.name} needs Processing ${s.bandwidth}; ${computer.name} offers ${capacity}.` });
    if (best.has(s.family)) issues.push({ level: 'info', code: 'software-dup', partId: s.partId, text: `${s.name} duplicates another program of the same kind; only the better one matters.` });
    best.set(s.family, Math.max(best.get(s.family) ?? 0, s.level));
  }
  if (jump > 0 && (best.get('jump') ?? 0) < jump) {
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
  const salary = (role: string) => rules.crew.roles.find((r) => r.id === role);
  const crew: CrewLine[] = [];
  const add = (role: string, n: number) => {
    const def = salary(role);
    if (n > 0 && def) crew.push({ role, name: def.name, count: n, salary: def.salary });
  };
  if (smallCraft) {
    add('pilot', 1);
  } else {
    add('pilot', 1);
    add('astrogator', jump > 0 ? 1 : 0);
    add('engineer', Math.max(1, Math.ceil(r3((driveTons + plantTons) / rules.crew.engineerPerTons))));
    add('gunner', gunners);
    const base = crew.reduce((n, c) => n + c.count, 0);
    const spare = quarters.berths - base;
    if (quarters.lowBerths > 0 || quarters.high > 0 || spare >= 3) {
      const middle = Math.max(0, spare - quarters.high - 2);
      add('medic', Math.max(1, Math.ceil((base + Math.max(0, spare) + quarters.lowBerths) / rules.crew.medicPerPeople)));
      add('steward', Math.max(1, Math.ceil(r3(quarters.high / rules.crew.stewardPerHigh + middle / rules.crew.stewardPerMiddle))));
    }
  }
  const crewCount = crew.reduce((n, c) => n + c.count, 0);
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
  const buildDays = Math.ceil(r3((purchase / 1_000_000) * rules.hull.buildDaysPerMCr));

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
    power: { output: r3(power.output), basic: r3(power.basic), mdrive: r3(power.mdrive), jdrive: r3(power.jdrive), other: r3(power.other) },
    thrust,
    jump,
    fuel: { tons: r3(fuelTons), perParsec: r3(perParsec), perPeriod, parsecs, weeks },
    hardpoints: { total: hp.total, used, firm: hp.firm },
    computer,
    sensors,
    quarters,
    crew,
    crewCount,
    payroll,
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
  const hullCost = hullTons * rules.hull.costPerTon * cfg.costMult;
  const out: CatalogueEntry[] = [];
  for (const a of rules.armour) {
    out.push({ kind: 'armour', key: a.id, name: `${a.name} armour`, group: 'hull', tl: a.tl, figures: `${figures((hullTons * a.tonsPct) / 100, (hullCost * a.costPct) / 100)} per point` });
  }
  const m = rules.mdrive;
  out.push({ kind: 'mdrive', name: 'Manoeuvre drive', group: 'drives', tl: m.tl[0] ?? 0, figures: `${figures((hullTons * m.tonsPct) / 100, ((hullTons * m.tonsPct) / 100) * m.costPerTon)} per Thrust`, note: 'Gravitic thrusters. Each point of Thrust is 1G of acceleration.' });
  const jd = rules.jdrive;
  const j1 = Math.max(jd.minTons ?? 0, (hullTons * jd.tonsPct) / 100 + (jd.plusTons ?? 0));
  out.push({ kind: 'jdrive', name: 'Jump drive', group: 'drives', tl: jd.tl[0] ?? 0, figures: `${figures(j1, j1 * jd.costPerTon)} for Jump-1`, note: 'Faster-than-light travel: one parsec per point, a week in jump space.' });
  for (const p of rules.plants) out.push({ kind: 'plant', key: p.id, name: p.name, group: 'power', tl: p.tl, figures: `${p.powerPerTon} Power and ${formatMCr(p.costPerTon)} per ton` });
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
  for (const mount of rules.mounts) out.push({ kind: 'mount', key: mount.id, name: mount.name, group: 'weapons', tl: mount.tl, note: mount.note, figures: figures(mount.tons, mount.cost || undefined, mount.power) || 'Priced with its weapon' });
  for (const f of rules.fittings) {
    let fig = '';
    if (f.size === 'unit') fig = figures(f.unitTons, f.unitCost, f.unitPower) + (f.unitLabel ? ` per ${f.unitLabel}` : '');
    else if (f.size === 'tons') fig = f.costPerStep ? `${formatMCr(f.costPerStep)} per ${f.stepTons} tons` : f.costPerTon ? `${formatMCr(f.costPerTon)} per ton` : 'No cost';
    else if (f.size === 'hull') fig = figures(f.hullPct ? Math.max(f.minTons ?? 0, (hullTons * f.hullPct) / 100) : 0, (f.hullPct ? Math.max(f.minTons ?? 0, (hullTons * f.hullPct) / 100) * (f.costPerTon ?? 0) : 0) + hullTons * (f.costPerHullTon ?? 0), hullTons * (f.powerPerHullTon ?? 0));
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
      if (existing('mdrive')) state.blocked = 'Already fitted';
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
      if (report.smallCraft && def && !def.firmpoint) state.blocked = 'Not on a small craft firmpoint';
      else if (report.hardpoints.used >= report.hardpoints.total) state.blocked = report.hardpoints.total === 0 ? 'This hull has no hardpoints' : `All ${report.hardpoints.firm ? 'firmpoints' : 'hardpoints'} are in use`;
      break;
    }
    case 'fitting': {
      const def = rules.fittings.find((f) => f.id === entry.key);
      if (!def) break;
      if (def.builtInWhen && (cfg as unknown as Record<string, unknown>)[def.builtInWhen] === true) state.blocked = 'Built into this hull';
      else if (def.needsAtmosphere && cfg.streamlined === 'none') state.blocked = 'No use on this hull';
      else if (def.single && spec.parts.some((p) => p.kind === 'fitting' && p.key === def.id)) state.blocked = 'Already fitted';
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
export function defaultPart(rules: ShipRules, spec: ShipSpec, report: DesignReport, entry: { kind: PartKind; key?: string }): DesignPart {
  const part: DesignPart = { id: newPartId(), kind: entry.kind, ...(entry.key ? { key: entry.key } : {}) };
  switch (entry.kind) {
    case 'armour':
    case 'mdrive':
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
    case 'mount':
      part.weapons = [];
      break;
    case 'fitting': {
      const def = rules.fittings.find((f) => f.id === entry.key);
      if (def?.size === 'unit') part.qty = 1;
      else if (def?.size === 'tons') part.tons = def.minTons ?? (def.stepTons ? def.stepTons : 1);
      else if (def?.size === 'docking') part.rating = 4;
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
      return 10;
    default:
      break;
  }
  switch (line.group) {
    case 'weapons':
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
    thrust: report.thrust,
    cargo: Math.max(0, report.cargo),
    fuelCapacity: report.fuel.tons,
    staterooms: report.quarters.staterooms + report.quarters.high,
    lowBerths: report.quarters.lowBerths,
    hullMax: report.hullPoints,
    armour: report.armour,
    maintenance: report.maintenance,
  };
}
