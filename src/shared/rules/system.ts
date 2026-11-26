/**
 * Star system generation: the stars of a system, the orbits open to worlds around them, and the
 * worlds and moons that fill those orbits. Every table and formula comes from the rules pack
 * (`WorldRules.system`); this file only carries the procedure out.
 *
 * Names a pack's formulas and conditions may use:
 *   a star            class (1 = brightest class … 7; 0 for objects), type (0 = O … 6 = M; -1 for objects),
 *                     bd, wd, ns, psr, bh, proto (0 or 1), M (mass), DIA (diameter), T (temperature), L (luminosity)
 *                     (a lone D is a die, so no value is called that)
 *   the system        stars, secondaries, dead (dead stars), deadPrimary, companion (primary has one),
 *                     primordial, age, gasGiants, worlds, DM (the modifiers that apply), natural (the dice alone)
 *   orbits            HZCO, MAO, MIN, N (baseline number), W (total worlds), B (baseline orbit), A (orbits
 *                     available), S (slots), T (stars), OUT (outermost orbit), SPREAD, E (eccentricity), AU
 *   eccentricity      star, extraStars, orbit, beltBody
 *   sizes             P (parent's size), spread, R (the roll being judged)
 *   a listed mainworld  size, atm, raw (the climate roll before the air's modifier)
 *
 * Thresholds are the pack's as well: this file holds no figure from a rulebook, and says so plainly
 * when a pack leaves one out.
 */
import { evaluate, type Vars } from '../dicex';
import type { RollRow, StarRow, SystemRules, WhenDm } from '../rulepack';
import type { BodyDetail } from '../types';
import type { Rng } from '../util';
import { ehexChar } from '../uwp';

export type StarKind = 'star' | 'BD' | 'D' | 'NS' | 'PSR' | 'BH';
export type StarRole = 'primary' | 'close' | 'near' | 'far' | 'companion';

export interface StarInfo {
  /** "A", "Aa", "Ab", "B" … */
  designation: string;
  role: StarRole;
  /** The star a companion circles (index into the list). */
  parent?: number;
  kind: StarKind;
  proto?: boolean;
  spectral?: string;
  subtype?: number;
  cls?: string;
  /** "G7 V", "D", "BD". */
  label: string;
  /** In units of the Sun. */
  mass: number;
  diameter: number;
  temperature: number;
  luminosity: number;
  /** Orbit number around the primary, or around its parent for a companion. */
  orbit?: number;
  au?: number;
  ecc?: number;
  /** Years. */
  period?: number;
}

/** A star, or stars taken together, that worlds can circle. */
export interface OrbitGroup {
  /** "A", "Aab", "B", "Cab". */
  key: string;
  /** The star at the centre, and its companion if it has one. */
  stars: number[];
  mao: number;
  luminosity: number;
  mass: number;
  /** Centre of the habitable zone, as an orbit number (for the primary, counting the light of stars that circle inside it). */
  hzco: number;
  /** Orbit number ranges where worlds can keep a stable orbit. */
  ranges: [number, number][];
}

export interface MoonInfo {
  /** "S", "3", "A", "GS4"; rings are counted on the planet instead. */
  size: string;
  sizeValue: number;
  giant?: { code: string; diameter: number; mass: number };
  mainworld?: boolean;
  detail?: BodyDetail;
}

export interface WorldInfo {
  kind: 'terrestrial' | 'gasGiant' | 'belt';
  /** Which stars it circles: "A", "Aab", "AB", "Cab". */
  around: string;
  /** Index of the orbit group it belongs to. */
  group: number;
  orbit: number;
  au: number;
  ecc: number;
  /** Years. */
  period: number;
  /** "Aab IV", "B I", "PI". */
  designation: string;
  size: string;
  sizeValue: number;
  giant?: { code: string; diameter: number; mass: number };
  /** How far from the habitable zone's centre, in orbit numbers (negative is hotter), and what that means. */
  hzDeviation: number;
  zone: string;
  anomaly?: string;
  inclination?: number;
  mainworld?: boolean;
  moons: MoonInfo[];
  rings: number;
  /** The stars inside its orbit: how many, their mass and their light together (Sun = 1). */
  starCount: number;
  starMass: number;
  starLight: number;
  /** Centre of the habitable zone it is measured against, as an orbit number. */
  hzco: number;
  /** The world in detail, once worked out. */
  detail?: BodyDetail;
}

export interface SystemLayout {
  /** Billions of years. */
  age: number;
  stars: StarInfo[];
  groups: OrbitGroup[];
  worlds: WorldInfo[];
  gasGiants: number;
  belts: number;
  terrestrials: number;
  baseline: number;
  spread: number;
  /** Short profile: giants-belts-terrestrials-baseline-spread. */
  profile: string;
  /** Things the referee should know about how the dice fell. */
  notes: string[];
}

/** What is already settled about a system (from a sector listing) and must be kept. */
export interface KnownSystem {
  /** Star labels in listing order, e.g. ["G2 V", "M5 V", "D"]. */
  stars?: string[];
  gasGiants?: number;
  /** Belts as a listing counts them: a mainworld that is itself a belt is not included. */
  belts?: number;
  /** Total worlds, where the listing gives it. */
  worlds?: number;
  mainworld?: { size: number; atm: number; hydro?: number; pop?: number; tl?: number; industrial?: boolean; temperature?: 'frozen' | 'cold' | 'temperate' | 'hot' | 'boiling' };
}

const SPECTRAL = 'OBAFGKM';
const DEAD: StarKind[] = ['D', 'NS', 'PSR', 'BH'];
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

// ───────────────────────────── tables and formulas ─────────────────────────────

/** The dice, read against the named formulas, modifier lists and tables of one part of a rules pack. */
export class Dice<R extends { f: Record<string, string | number>; dm: Record<string, WhenDm[]> } = SystemRules> {
  constructor(
    readonly rules: R,
    readonly rng: Rng,
  ) {}

  /** A formula of the pack, by name. */
  f(name: string, vars: Vars = {}): number {
    const formula = this.rules.f[name];
    if (formula === undefined) throw new Error(`The rules pack has no "${name}" for star systems and their worlds`);
    return evaluate(formula, this.rng, vars);
  }

  has(name: string): boolean {
    return this.rules.f[name] !== undefined;
  }

  roll(formula: string | number, vars: Vars = {}): number {
    return evaluate(formula, this.rng, vars);
  }

  d(count: number): number {
    let total = 0;
    for (let i = 0; i < count; i++) total += 1 + Math.floor(this.rng() * 6);
    return total;
  }

  /** The modifiers of a named list that apply. */
  dm(name: string, vars: Vars): number {
    return this.sum(this.rules.dm[name] ?? [], vars);
  }

  /** The modifiers of a list that apply. */
  sum(rows: WhenDm[], vars: Vars): number {
    let total = 0;
    for (const row of rows) if (evaluate(row.when, this.rng, vars)) total += row.dm * (row.times ? evaluate(row.times, this.rng, vars) : 1);
    return total;
  }

  row<T extends RollRow>(rows: T[], value: number): T {
    return rows.find((r) => value <= r.max) ?? rows[rows.length - 1];
  }

  /** A result for a 2D roll of 2 to 12 (with a modifier) from a column of eleven entries. */
  column(entries: string[], dm = 0): string {
    const roll = Math.max(2, Math.min(12, this.d(2) + dm));
    return entries[roll - 2];
  }

  pick<T>(list: T[]): T {
    return list[Math.floor(this.rng() * list.length)];
  }
}

/** Distance in AU of a (fractional) orbit number. */
export function orbitToAu(rules: SystemRules, orbit: number): number {
  const table = rules.orbits;
  const last = table.length - 1;
  const whole = Math.max(0, Math.min(last, Math.floor(orbit)));
  const step = whole < last ? table[whole + 1] - table[whole] : table[last] - table[last - 1];
  return table[whole] + step * (orbit - whole);
}

/** The orbit number of a distance in AU. */
export function auToOrbit(rules: SystemRules, au: number): number {
  const table = rules.orbits;
  const last = table.length - 1;
  let whole = 0;
  while (whole < last && table[whole + 1] <= au) whole++;
  const step = whole < last ? table[whole + 1] - table[whole] : table[last] - table[last - 1];
  return whole + (au - table[whole]) / step;
}

/** A star table read between its rows: types are listed at subtypes 0 and 5 (and M9). */
function between(rows: { type: string }[], spectral: string, subtype: number, read: (row: number) => number | null): number | undefined {
  const at = (letter: string, digit: number) => rows.findIndex((r) => r.type === `${letter}${digit}`);
  const next = SPECTRAL[SPECTRAL.indexOf(spectral) + 1];
  let lo: number;
  let hi: number;
  let fraction: number;
  if (subtype < 5) {
    lo = at(spectral, 0);
    hi = at(spectral, 5);
    fraction = subtype / 5;
  } else if (next) {
    lo = at(spectral, 5);
    hi = at(next, 0);
    fraction = (subtype - 5) / 5;
  } else {
    lo = at(spectral, 5);
    hi = at(spectral, 9);
    fraction = (subtype - 5) / 4;
  }
  const a = lo >= 0 ? read(lo) : null;
  const b = hi >= 0 ? read(hi) : null;
  if (a === null && b === null) return undefined;
  if (a === null) return b!;
  if (b === null) return a;
  return a + (b - a) * fraction;
}

function starRow(rules: SystemRules, rows: StarRow[], spectral: string, subtype: number, cls: string): number | undefined {
  const c = rules.classes.indexOf(cls);
  return between(rows, spectral, subtype, (i) => rows[i].v[c]);
}

function conditionVars(star: Pick<StarInfo, 'kind' | 'spectral' | 'cls' | 'proto'>, rules: SystemRules): Vars {
  return {
    class: star.kind === 'star' && star.cls ? rules.classes.indexOf(star.cls) + 1 : 0,
    type: star.kind === 'star' && star.spectral ? SPECTRAL.indexOf(star.spectral) : -1,
    bd: star.kind === 'BD' ? 1 : 0,
    wd: star.kind === 'D' ? 1 : 0,
    ns: star.kind === 'NS' ? 1 : 0,
    psr: star.kind === 'PSR' ? 1 : 0,
    bh: star.kind === 'BH' ? 1 : 0,
    proto: star.proto ? 1 : 0,
  };
}

// ───────────────────────────── stars ─────────────────────────────

type StarSeed = Pick<StarInfo, 'kind' | 'spectral' | 'subtype' | 'cls' | 'proto'>;

/** How hot a star is among its fellows: lower is hotter. Objects come after every star. */
function heat(star: StarSeed): number {
  if (star.kind !== 'star') return 100;
  return SPECTRAL.indexOf(star.spectral!) * 10 + (star.subtype ?? 5);
}

function rollSubtype(dice: Dice, spectral: string, cls: string, primary: boolean): number {
  const t = dice.rules.starTables.subtype;
  const roll = dice.d(2) - 2;
  let subtype = primary && spectral === 'M' && cls === 'V' ? t.mPrimary[roll] : t.numeric[roll];
  const cut = dice.rules.limits[cls]?.subtractAbove;
  if (cut && cut.type === spectral && subtype > cut.above) subtype -= cut.by;
  return subtype;
}

/** A spectral type from the type column (and the hot column behind it), with a modifier for class results. */
function rollSpectral(dice: Dice, cls: string, dm: number): string {
  const tables = dice.rules.starTables.types;
  const limit = dice.rules.limits[cls];
  let roll = Math.max(2, Math.min(12, dice.d(2) + dm));
  let result = tables.type[roll - 2];
  if (result === 'M' && limit?.mAdd) {
    roll = Math.min(12, roll + limit.mAdd);
    result = tables.type[roll - 2];
  }
  if (result === 'Hot') result = dice.column(tables.hot);
  // a second "special" on a class roll has nothing more to say: take the commonest star
  if (!SPECTRAL.includes(result)) result = 'M';
  return limit?.remap?.[result] ?? result;
}

/** A star rolled from scratch on the type table. */
function rollStarType(dice: Dice, notes: string[], primary: boolean, allowUnusual: boolean): StarSeed {
  const tables = dice.rules.starTables.types;
  const dm = dice.f('classRollDm');
  let result = dice.column(tables.type);
  if (result === 'Hot') result = dice.column(tables.hot);
  if (SPECTRAL.includes(result)) return { kind: 'star', spectral: result, cls: 'V', subtype: rollSubtype(dice, result, 'V', primary) };

  result = dice.column(allowUnusual ? tables.unusual : tables.special);
  if (result === 'Giants') result = dice.column(tables.giants);
  if (result === 'Peculiar') {
    const odd = dice.column(tables.peculiar);
    if (odd === 'Black Hole') return { kind: 'BH' };
    if (odd === 'Pulsar') return { kind: 'PSR' };
    if (odd === 'Neutron Star') return { kind: 'NS' };
    if (odd === 'Protostar') {
      const rolled = rollSpectral(dice, 'V', dm);
      const spectral = dice.rules.limits.proto?.remap?.[rolled] ?? rolled;
      return { kind: 'star', spectral, cls: 'V', subtype: rollSubtype(dice, spectral, 'V', primary), proto: true };
    }
    // nebulae, clusters and anomalies are for the referee to place: a dead star stands in
    notes.push(`The dice called for a ${odd.toLowerCase()} here; a dead star stands in for it.`);
    return { kind: dice.f('peculiar.blackHole') ? 'BH' : 'NS' };
  }
  if (result === 'BD' || result === 'D') return { kind: result };
  const cls = result.replace(/^Class\s+/, '');
  if (!dice.rules.classes.includes(cls)) return { kind: 'star', spectral: 'M', cls: 'V', subtype: rollSubtype(dice, 'M', 'V', primary) };
  const spectral = rollSpectral(dice, cls, dm);
  return fitClass(dice, { kind: 'star', spectral, cls, subtype: rollSubtype(dice, spectral, cls, primary) });
}

/** Keeps a star within what its class allows (a subgiant cannot be cooler than a set type). */
function fitClass(dice: Dice, star: StarSeed): StarSeed {
  const limit = star.cls ? dice.rules.limits[star.cls] : undefined;
  if (!limit?.coolest || star.kind !== 'star') return star;
  const coolest = SPECTRAL.indexOf(limit.coolest[0]) * 10 + Number(limit.coolest[1]);
  if (heat(star) > coolest && limit.fallback) return { ...star, cls: limit.fallback };
  return star;
}

function labelOf(star: StarSeed): string {
  if (star.kind !== 'star') return star.kind;
  return `${star.spectral}${star.subtype} ${star.cls}`;
}

/** Reads "G2 V", "M5 III", "D", "BD", "DA", "NS" from a listing. Unknown text gives nothing. */
export function parseStar(text: string): StarSeed | undefined {
  const t = text.trim();
  if (/^BD$/i.test(t) || /^[LTY]\d?$/i.test(t)) return { kind: 'BD' };
  if (/^(BH)$/i.test(t)) return { kind: 'BH' };
  if (/^(NS)$/i.test(t)) return { kind: 'NS' };
  if (/^(PSR)$/i.test(t)) return { kind: 'PSR' };
  if (/^D[A-Z]?\d?$/.test(t)) return { kind: 'D' };
  const m = /^([OBAFGKM])(\d)?\s*(Ia|Ib|II|III|IV|V|VI|D)?$/.exec(t);
  if (!m) return undefined;
  if (m[3] === 'D') return { kind: 'D' };
  return { kind: 'star', spectral: m[1], subtype: m[2] === undefined ? undefined : Number(m[2]), cls: m[3] ?? 'V' };
}

/** Mass, size, heat and light of a star once its type is settled. */
function starFigures(dice: Dice, seed: StarSeed, age?: number): Pick<StarInfo, 'mass' | 'diameter' | 'temperature' | 'luminosity'> {
  const rules = dice.rules;
  const t = rules.starTables;
  const light = (diameter: number, temperature: number) => dice.f('luminosity', { DIA: diameter, T: temperature });
  if (seed.kind === 'BD') {
    const mass = dice.f('mass.BD');
    const rows = [...t.brownDwarfs].sort((a, b) => b.mass - a.mass);
    const hi = rows.filter((r) => r.mass >= mass).pop() ?? rows[0];
    const lo = rows.find((r) => r.mass <= mass) ?? rows[rows.length - 1];
    const fraction = hi.mass === lo.mass ? 0 : (hi.mass - mass) / (hi.mass - lo.mass);
    const temperature = hi.k + (lo.k - hi.k) * fraction;
    const diameter = hi.diameter + (lo.diameter - hi.diameter) * fraction;
    return { mass: round(mass, 3), diameter: round(diameter, 3), temperature: Math.round(temperature), luminosity: light(diameter, temperature) };
  }
  if (seed.kind !== 'star') {
    const key = seed.kind === 'PSR' ? 'NS' : seed.kind;
    let mass = dice.f(`mass.${key}`);
    // a pack may have a six on a further die add to the mass, once or for as long as sixes come
    if (dice.has(`mass.${key}.six`)) {
      const again = dice.has(`mass.${key}.six.again`) && !!dice.f(`mass.${key}.six.again`);
      while (dice.d(1) === 6) {
        mass += dice.f(`mass.${key}.six`);
        if (!again) break;
      }
    }
    const diameter = dice.f(`diameter.${key}`, { M: mass });
    if (seed.kind === 'BH') return { mass: round(mass, 2), diameter, temperature: 0, luminosity: 0 };
    const cooling = [...t.whiteDwarfCooling].sort((a, b) => a.gyr - b.gyr);
    const since = Math.max(0, age ?? 1);
    let k = cooling[cooling.length - 1].k;
    for (let i = 0; i < cooling.length - 1; i++) {
      if (since >= cooling[i].gyr && since <= cooling[i + 1].gyr) {
        k = cooling[i].k + ((cooling[i + 1].k - cooling[i].k) * (since - cooling[i].gyr)) / (cooling[i + 1].gyr - cooling[i].gyr);
        break;
      }
    }
    const temperature = k * (mass / dice.f('whiteDwarfMass'));
    return { mass: round(mass, 2), diameter, temperature: Math.round(temperature), luminosity: light(diameter, temperature) };
  }
  const spectral = seed.spectral!;
  const subtype = seed.subtype ?? 5;
  const cls = seed.cls ?? 'V';
  const vary = () => (dice.has('variance') ? 1 + dice.f('variance') : 1);
  const mass = (starRow(rules, t.mass, spectral, subtype, cls) ?? starRow(rules, t.mass, spectral, subtype, 'V') ?? 1) * vary();
  let diameter = (starRow(rules, t.diameter, spectral, subtype, cls) ?? starRow(rules, t.diameter, spectral, subtype, 'V') ?? 1) * vary();
  if (seed.proto && dice.has('diameter.proto')) diameter *= dice.f('diameter.proto');
  const temperature = between(t.temperature, spectral, subtype, (i) => t.temperature[i].k) ?? 5000;
  return { mass: round(mass, 3), diameter: round(diameter, 3), temperature: Math.round(temperature), luminosity: light(diameter, temperature) };
}

/** The type of a further star, from the star it answers to. */
function rollNonPrimary(dice: Dice, parent: StarSeed, companion: boolean, notes: string[], depth = 0): StarSeed {
  const rules = dice.rules;
  if (parent.kind === 'BD') return { kind: 'BD' };
  const dead = DEAD.includes(parent.kind);
  const column = dead ? rules.nonPrimary.postStellar : companion ? rules.nonPrimary.companion : rules.nonPrimary.secondary;
  let result = dice.column(column, dice.dm('nonPrimary', conditionVars(parent, rules)));
  if (result === 'Other') result = dice.column(rules.nonPrimary.other);
  if (result === 'D' || result === 'BD') return { kind: result };

  const lesser = (): StarSeed => {
    if (parent.kind === 'BH') return { kind: 'NS' };
    if (parent.kind === 'NS' || parent.kind === 'PSR') return { kind: 'D' };
    if (parent.kind === 'D') return { kind: 'BD' };
    const index = SPECTRAL.indexOf(parent.spectral!);
    const cls = parent.cls ?? 'V';
    if (index === SPECTRAL.length - 1) {
      // nothing is cooler than M: another M star, or a brown dwarf if the dice make it hotter than its parent
      const subtype = rollSubtype(dice, 'M', cls, false);
      return subtype < (parent.subtype ?? 0) ? { kind: 'BD' } : { kind: 'star', spectral: 'M', cls, subtype, proto: parent.proto };
    }
    const spectral = SPECTRAL[index + 1];
    return fitClass(dice, { kind: 'star', spectral, cls, subtype: rollSubtype(dice, spectral, cls, false), proto: parent.proto });
  };
  if (result === 'Twin') return { ...parent };
  if (result === 'Sibling') {
    if (parent.kind !== 'star') return { ...parent };
    let subtype = (parent.subtype ?? 0) + dice.f('sibling');
    let index = SPECTRAL.indexOf(parent.spectral!);
    if (subtype > 9) {
      subtype -= 10;
      index += 1;
    }
    if (index >= SPECTRAL.length) return { kind: 'BD' };
    return fitClass(dice, { kind: 'star', spectral: SPECTRAL[index], cls: parent.cls, subtype, proto: parent.proto });
  }
  if (result === 'Random' && depth < 3) {
    const star = parent.proto ? lesser() : rollStarType(dice, notes, false, true);
    // nothing in a system outshines its primary
    if (heat(star) < heat(parent) || (star.kind === 'star' && rules.classes.indexOf(star.cls!) < rules.classes.indexOf(parent.cls ?? 'V'))) return lesser();
    if (dead && star.kind === 'star') return lesser();
    return star;
  }
  return lesser();
}

/** Age of the system in Gyr from its primary, and how long a dead primary has been dead. */
function systemAge(dice: Dice, primary: StarInfo): { age: number; since?: number } {
  const universe = dice.f('universe');
  const small = () => Math.min(universe - 0.3, Math.max(0.1, dice.f('age.small')));
  if (primary.proto) return { age: dice.f('age.proto') };
  if (primary.kind === 'BD') return { age: small() };
  if (primary.kind === 'PSR') {
    const since = dice.f('age.pulsar');
    return { age: round(finalAge(dice, progenitorMass(dice, primary)) + since, 3), since };
  }
  if (primary.kind !== 'star') {
    const before = finalAge(dice, progenitorMass(dice, primary));
    const since = Math.min(small(), Math.max(0.05, universe - before - 0.1));
    return { age: round(before + since, 3), since };
  }
  const lifespan = dice.f('lifespan', { M: primary.mass });
  const fraction = () => Math.min(0.999, Math.max(0.001, dice.f('age.fraction')));
  const cls = primary.cls ?? 'V';
  let age: number;
  if (cls === 'IV') age = lifespan + dice.f('subgiant', { L: lifespan, M: primary.mass }) * fraction();
  else if (cls === 'III') age = lifespan + dice.f('subgiant', { L: lifespan, M: primary.mass }) + dice.f('giant', { L: lifespan, M: primary.mass }) * fraction();
  else if (primary.mass < dice.f('smallStarBelow')) age = small();
  else {
    age = lifespan * fraction();
    if (primary.mass < dice.f('age.minimumBelowMass')) age = Math.max(dice.f('age.minimum'), age);
  }
  return { age: Math.min(universe - 0.1, age) };
}

/** The mass of the star a dead one was, which a pack may hold to a least figure for each kind of remnant. */
function progenitorMass(dice: Dice, star: Pick<StarInfo, 'kind' | 'mass'>): number {
  const key = star.kind === 'PSR' ? 'NS' : star.kind;
  const least = dice.has(`progenitor.min.${key}`) ? dice.f(`progenitor.min.${key}`) : 0;
  return Math.max(least, dice.f('progenitor', { M: star.mass }));
}

/** How long a star of this mass lasts before it dies, in Gyr. */
function finalAge(dice: Dice, mass: number): number {
  const lifespan = dice.f('lifespan', { M: mass });
  return lifespan + dice.f('subgiant', { L: lifespan, M: mass }) + dice.f('giant', { L: lifespan, M: mass });
}

export function rollEccentricity(dice: Dice, vars: Vars, extraDm = 0): number {
  const roll = dice.d(2) + dice.dm('eccentricity', vars) + extraDm;
  const value = dice.roll(dice.row(dice.rules.eccentricity, roll).value);
  return round(Math.max(0, Math.min(0.999, value)), 3);
}

/** The stars of a system: rolled afresh, or built around the ones a listing already names. */
function buildStars(dice: Dice, known: KnownSystem | undefined, notes: string[], allowUnusual: boolean): { stars: StarInfo[]; age: number } {
  const rules = dice.rules;
  const listed = (known?.stars ?? []).map(parseStar).filter((s): s is StarSeed => !!s);
  const seeds: { seed: StarSeed; role: StarRole; parent?: number }[] = [];

  const finish = (seed: StarSeed, primary: boolean): StarSeed => {
    if (seed.kind === 'star' && seed.subtype === undefined) return { ...seed, subtype: rollSubtype(dice, seed.spectral!, seed.cls ?? 'V', primary) };
    return seed;
  };
  // giants leave no room for a star close by, and keep their companions further off
  const giant = (s: StarSeed) => !!dice.f('isGiant', conditionVars(s, rules));

  if (listed.length > 0) {
    // the stars are known; only where they sit has to be found
    const primary = finish(listed[0], true);
    seeds.push({ seed: primary, role: 'primary' });
    const taken = new Map<string, number>();
    const hasCompanion = (index: number) => seeds.some((s) => s.role === 'companion' && s.parent === index);
    const order: StarRole[] = ['close', 'near', 'far'];
    const place = (seed: StarSeed, want: string) => {
      const add = (role: StarRole, parent?: number) => {
        seeds.push({ seed, role, parent });
        if (role !== 'companion') taken.set(role, seeds.length - 1);
      };
      if (want === 'companion' && !hasCompanion(0)) return add('companion', 0);
      let at = want === 'companion' ? 0 : Math.max(0, order.indexOf(want as StarRole));
      if (order[at] === 'close' && giant(primary)) at = 1;
      for (let step = 0; step < 6; step++) {
        const role = order[Math.min(at, 2)];
        const holder = taken.get(role);
        if (holder === undefined) return add(role);
        if (!hasCompanion(holder)) return add('companion', holder);
        if (at >= 2) break;
        at++;
      }
      // every place is taken: the first free one from the inside
      for (const role of order) if (!taken.has(role) && !(role === 'close' && giant(primary))) return add(role);
      add('companion', seeds.length - 1);
    };
    const table = listed.length === 2 ? rules.knownPlaces.binary : rules.knownPlaces.multiple;
    for (const raw of listed.slice(1)) {
      const seed = finish(raw, false);
      let want = '';
      for (let tries = 0; tries < 20 && !want; tries++) {
        const result = table[dice.d(1) - 1];
        if (result === 'again') continue;
        if (result === 'same') {
          if (seed.kind === primary.kind && seed.spectral === primary.spectral && seed.cls === primary.cls && !hasCompanion(0)) want = 'companion';
          continue;
        }
        want = result;
      }
      place(seed, want || 'far');
    }
  } else {
    const primary = rollStarType(dice, notes, true, allowUnusual);
    seeds.push({ seed: primary, role: 'primary' });
    const vars = conditionVars(primary, rules);
    const present = () => !!dice.f('starPresent', { DM: dice.dm('starPresence', vars) });
    for (const role of ['close', 'near', 'far'] as StarRole[]) {
      if (role === 'close' && giant(primary)) continue;
      if (present()) seeds.push({ seed: rollNonPrimary(dice, primary, false, notes), role });
    }
    for (let i = 0, n = seeds.length; i < n; i++) if (present()) seeds.push({ seed: rollNonPrimary(dice, seeds[i].seed, true, notes), role: 'companion', parent: i });
  }

  // put the stars in order: each star followed by its companion
  const ordered: typeof seeds = [];
  const remap = new Map<number, number>();
  seeds.forEach((s, i) => {
    if (s.role === 'companion') return;
    remap.set(i, ordered.length);
    ordered.push(s);
    const companion = seeds.find((c) => c.role === 'companion' && c.parent === i);
    if (companion) ordered.push({ ...companion, parent: ordered.length - 1 });
  });

  // figures; a lesser star never outweighs the one it answers to
  const stars: StarInfo[] = ordered.map((s) => ({ designation: '', role: s.role, parent: s.parent, ...s.seed, label: labelOf(s.seed), ...starFigures(dice, s.seed) }));
  for (const star of stars) {
    const above = star.role === 'companion' ? stars[star.parent!] : star.role === 'primary' ? undefined : stars[0];
    if (above && star.kind === 'star' && above.kind === 'star' && star.mass > above.mass) star.mass = round(above.mass * 0.98, 3);
  }

  // age: from the primary, lengthened if a dead companion needs longer to have lived and died
  let { age, since } = systemAge(dice, stars[0]);
  const universe = dice.f('universe');
  for (const star of stars.slice(1)) {
    if (!DEAD.includes(star.kind)) continue;
    const before = finalAge(dice, progenitorMass(dice, star));
    if (before >= age) {
      const limit = stars[0].kind === 'star' ? Math.min(universe - 0.1, dice.f('lifespan', { M: stars[0].mass })) : universe - 0.1;
      if (before + 0.1 <= limit) age = before + dice.roll('D3') * 0.1;
      else notes.push(`${star.label} companion: its parent star would have outlived the system; it is taken to have been a heavier, shorter-lived star.`);
    }
    Object.assign(star, starFigures(dice, star, Math.max(0.05, age - Math.min(before, age - 0.05))));
  }
  if (DEAD.includes(stars[0].kind)) Object.assign(stars[0], starFigures(dice, stars[0], since ?? 1), { mass: stars[0].mass });
  age = round(age, 3);

  // designations: A, B, C, D outward; a pair is Xa and Xb
  let letter = 0;
  stars.forEach((star, i) => {
    if (star.role === 'companion') return;
    const name = String.fromCharCode(65 + letter++);
    const companion = stars[i + 1]?.role === 'companion' ? stars[i + 1] : undefined;
    star.designation = companion ? `${name}a` : name;
    if (companion) companion.designation = `${name}b`;
  });

  // orbits of the other stars
  const primary = stars[0];
  const maoOf = (s: StarInfo) => maoOfStar(dice, s);
  stars.forEach((star, i) => {
    if (i === 0) return;
    const parent = star.role === 'companion' ? stars[star.parent!] : primary;
    let orbit: number;
    if (star.role === 'companion') {
      orbit = giant(parent) && dice.has('orbit.giantCompanion') ? dice.f('orbit.giantCompanion', { MAO: maoOf(parent) }) : dice.f('orbit.companion');
      orbit = Math.max(0.01, orbit);
    } else {
      orbit = dice.f(`orbit.${star.role}`);
      if (dice.has('orbit.variance') && orbit >= 1) orbit += dice.f('orbit.variance');
      orbit = Math.max(maoOf(primary) + 0.5, orbit);
    }
    star.orbit = round(orbit, 2);
    star.ecc = rollEccentricity(dice, { star: 1, extraStars: 0, orbit, age, beltBody: 0, proto: primary.proto ? 1 : 0, primordial: 0 });
  });
  // crossing paths: move the outer star out until they clear
  const secondaries = stars.filter((s) => s.role !== 'primary' && s.role !== 'companion');
  for (let i = 1; i < secondaries.length; i++) {
    const inner = secondaries[i - 1];
    const outer = secondaries[i];
    for (let guard = 0; guard < 10; guard++) {
      const innerMax = orbitToAu(rules, inner.orbit!) * (1 + inner.ecc!);
      const outerMin = orbitToAu(rules, outer.orbit!) * (1 - outer.ecc!);
      if (outerMin > innerMax) break;
      outer.orbit = round(outer.orbit! + 1, 2);
    }
  }
  // distances and periods
  stars.forEach((star, i) => {
    if (i === 0) return;
    star.au = round(orbitToAu(rules, star.orbit!), star.orbit! < 1 ? 4 : 2);
    let inside: number;
    if (star.role === 'companion') inside = stars[star.parent!].mass;
    else inside = stars.filter((s, j) => j < i && (s.role === 'primary' || s.role === 'companion' ? true : (s.orbit ?? 0) < star.orbit!)).reduce((n, s) => n + s.mass, 0);
    const own = star.mass + (stars[i + 1]?.role === 'companion' && star.role !== 'companion' ? stars[i + 1].mass : 0);
    star.period = dice.f('period', { AU: star.au, M: inside + own });
  });
  return { stars, age };
}

function maoOfStar(dice: Dice, star: StarInfo): number {
  if (star.kind === 'BD') return dice.f('mao.BD');
  if (star.kind !== 'star') return dice.f('mao.dead');
  return starRow(dice.rules, dice.rules.starTables.mao, star.spectral!, star.subtype ?? 5, star.cls ?? 'V') ?? starRow(dice.rules, dice.rules.starTables.mao, star.spectral!, star.subtype ?? 5, 'V') ?? 0;
}

// ───────────────────────────── orbits ─────────────────────────────

/** Cuts a span out of a list of ranges. */
function without(ranges: [number, number][], from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of ranges) {
    if (to <= a || from >= b) out.push([a, b]);
    else {
      if (from > a) out.push([a, from]);
      if (to < b) out.push([to, b]);
    }
  }
  return out;
}

const widthOf = (ranges: [number, number][]) => ranges.reduce((n, [a, b]) => n + (b - a), 0);
const inRanges = (ranges: [number, number][], orbit: number) => ranges.some(([a, b]) => orbit >= a - 1e-9 && orbit <= b + 1e-9);

/** The groups of stars worlds can circle, with the orbits open around each. */
function buildGroups(dice: Dice, stars: StarInfo[]): OrbitGroup[] {
  const rules = dice.rules;
  const maxOrbit = dice.f('maxOrbit');
  const maoCounts = dice.f('maoCounts');
  const eccentric = dice.f('secondaryExclusion.eccentric');
  const veryEccentric = dice.f('secondaryExclusion.veryEccentric');
  const groups: OrbitGroup[] = [];
  const centres = stars.map((s, i) => ({ s, i })).filter(({ s }) => s.role !== 'companion');
  for (const { s: star, i } of centres) {
    const companion = stars[i + 1]?.role === 'companion' ? stars[i + 1] : undefined;
    const members = companion ? [i, i + 1] : [i];
    let start = maoOfStar(dice, star);
    if (companion) {
      const own = start;
      start = dice.f('companionExclusion', { E: companion.ecc ?? 0 }) + (companion.orbit ?? 0);
      start = Math.max(start, (companion.orbit ?? 0) + 0.1);
      if (own > maoCounts) start += own;
    }
    let ranges: [number, number][];
    if (star.role === 'primary') {
      ranges = [[start, maxOrbit]];
      for (const { s: other } of centres) {
        if (other.role === 'primary') continue;
        let reach = dice.f('secondaryExclusion');
        if ((other.ecc ?? 0) > eccentric) reach += 1;
        if (other.role !== 'far' && (other.ecc ?? 0) > veryEccentric) reach += 1;
        const mao = maoOfStar(dice, other);
        if (mao > maoCounts) reach += mao;
        ranges = without(ranges, other.orbit! - reach, other.orbit! + reach);
      }
    } else {
      const zones: StarRole[] = ['close', 'near', 'far'];
      const zone = zones.indexOf(star.role);
      const neighbours = centres.filter(({ s }) => s.role !== 'primary' && Math.abs(zones.indexOf(s.role) - zone) === 1).map(({ s }) => s);
      let outer = star.orbit! - dice.f('secondaryReach');
      if (neighbours.length) outer -= 1;
      if ((star.ecc ?? 0) > eccentric || neighbours.some((n) => (n.ecc ?? 0) > eccentric)) outer -= 1;
      if ((star.ecc ?? 0) > veryEccentric) outer -= 1;
      ranges = outer > start ? [[start, outer]] : [];
    }
    const luminosity = members.reduce((n, m) => n + stars[m].luminosity, 0);
    const mass = members.reduce((n, m) => n + stars[m].mass, 0);
    const key = companion ? `${star.designation.slice(0, -1)}ab` : star.designation;
    groups.push({ key, stars: members, mao: round(start, 3), luminosity, mass, hzco: round(auToOrbit(rules, dice.f('hzco', { L: Math.max(luminosity, 1e-12) })), 2), ranges: ranges.map(([a, b]) => [round(a, 3), round(b, 3)]) });
  }
  // A star that circles the primary inside its habitable zone adds its light to it, which moves the
  // zone outward (and may bring a further star inside it): settle on where it comes to rest.
  const home = groups[0];
  for (let pass = 0; home && pass < 4; pass++) {
    let light = home.luminosity;
    for (const { s, i } of centres) {
      if (s.role === 'primary' || s.orbit! >= home.hzco) continue;
      light += s.luminosity + (stars[i + 1]?.role === 'companion' ? stars[i + 1].luminosity : 0);
    }
    const hzco = round(auToOrbit(rules, dice.f('hzco', { L: Math.max(light, 1e-12) })), 2);
    if (hzco === home.hzco) break;
    home.hzco = hzco;
  }
  return groups;
}

// ───────────────────────────── worlds ─────────────────────────────

interface Slot {
  group: number;
  orbit: number;
  content?: 'empty' | 'gasGiant' | 'belt' | 'terrestrial';
  mainworld?: boolean;
  baseline?: boolean;
  anomaly?: { kind: string; eccDm: number; inclination?: number };
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
const roman = (n: number) => ROMAN[n - 1] ?? String(n);
const sizeCode = (n: number) => (n <= 0 ? '0' : ehexChar(n));

/** The orbit a world of known climate keeps, from the centre of the habitable zone. */
function orbitForRawRoll(rules: SystemRules, hzco: number, raw: number): number {
  const rows = rules.zones;
  const row = rows.find((r) => r.raw === Math.max(rows[0].raw, Math.min(rows[rows.length - 1].raw, raw))) ?? rows[Math.floor(rows.length / 2)];
  if (hzco >= 1) return hzco + row.deviation;
  return row.deviation >= 0 ? hzco * (1 + row.deviation) : hzco / (1 - row.deviation);
}

/** How far a world sits from the habitable zone's centre, and the kind of climate that suggests. */
export function habitableZone(rules: SystemRules, orbit: number, hzco: number): { deviation: number; zone: string } {
  const plain = orbit - hzco;
  const deviation = orbit < 1 || hzco < 1 ? plain / Math.max(0.001, Math.min(orbit, hzco)) : plain;
  // the table runs from the coldest to the hottest; take the row whose deviation is nearest
  let best = rules.zones[0];
  for (const row of rules.zones) if (Math.abs(row.deviation - deviation) < Math.abs(best.deviation - deviation)) best = row;
  const coldest = rules.zones[0];
  const hottest = rules.zones[rules.zones.length - 1];
  const zone = deviation >= coldest.deviation ? coldest.name : deviation <= hottest.deviation ? hottest.name : best.name;
  return { deviation: round(deviation, 2), zone };
}

function rollGasGiant(dice: Dice, vars: Vars): { code: string; diameter: number; mass: number } {
  const rules = dice.rules;
  const row = dice.row(rules.sizes.gasGiant, dice.f('gasGiantSize', { DM: dice.dm('gasGiantSize', vars) }));
  let mass = dice.roll(row.mass);
  if (row.heavyFrom !== undefined && row.heavy && mass >= row.heavyFrom) mass = dice.roll(row.heavy);
  return { code: row.code, diameter: dice.roll(row.diameter), mass };
}

function rollMoons(dice: Dice, world: WorldInfo, squeezed: boolean): void {
  const rules = dice.rules;
  const count = rules.sizes.moonCount.find((r) => (world.giant ? r.code === world.giant.code : r.sizes?.includes(world.sizeValue)));
  if (!count) return;
  const n = dice.roll(count.roll) - (squeezed ? count.dice : 0);
  if (n < 0) return;
  if (n === 0) {
    world.rings = 1;
    return;
  }
  for (let i = 0; i < n; i++) {
    const row = dice.row(rules.sizes.moon, dice.f('moonSize'));
    let value: number;
    let giant: MoonInfo['giant'];
    if (row.size === 'S') value = -1;
    else if (row.giant && world.giant) {
      const special = dice.row(rules.sizes.giantMoon, dice.f('giantMoonSize'));
      value = dice.roll(special.roll);
      if (special.giantAt !== undefined && value >= special.giantAt) {
        // a gas giant for a moon: always a size below its parent
        const small = rules.sizes.gasGiant[0];
        if (world.giant.code !== small.code) {
          const diameter = Math.min(world.giant.diameter - 1, dice.roll(small.diameter));
          giant = { code: small.code, diameter: Math.max(2, diameter), mass: dice.roll(small.mass) };
        }
        value = Math.min(15, value);
      }
    } else value = dice.roll(row.roll ?? '0', { P: world.giant ? 16 : world.sizeValue });
    if (giant) {
      world.moons.push({ size: `${giant.code}${sizeCode(giant.diameter)}`, sizeValue: giant.diameter * 8, giant });
      continue;
    }
    if (!world.giant) {
      // a moon is smaller than its planet, unless the dice make them a pair
      if (world.sizeValue === 1 && value >= 1) value = -1;
      if (value >= world.sizeValue) value = world.sizeValue - 1;
      if (value === world.sizeValue - 2 && value > 0 && dice.has('twinCheck')) {
        const R = dice.f('twinCheck');
        if (dice.f('twin.close', { R })) value = world.sizeValue - 1;
        else if (dice.f('twin.equal', { R })) value = world.sizeValue;
      }
    }
    if (value === 0) world.rings += 1;
    else world.moons.push({ size: value < 0 ? 'S' : sizeCode(value), sizeValue: Math.max(0, value) });
  }
}

/** How many gas giants, belts and terrestrial planets a system has; nothing when a dead primary left none. */
function countWorlds(dice: Dice, stars: StarInfo[], age: number, known: KnownSystem | undefined, notes: string[]): { sys: Vars; giants: number; belts: number; terrestrials: number; anomalies: NonNullable<Slot['anomaly']>[] } | undefined {
  const rules = dice.rules;
  const primary = stars[0];
  const deadCount = stars.filter((s) => DEAD.includes(s.kind)).length;
  const secondaries = stars.filter((s) => s.role !== 'primary' && s.role !== 'companion').length;
  // a system too young, or with too short-lived a primary, for its worlds to have settled
  const primordial = dice.f('primordial', { ...conditionVars(primary, rules), age }) ? 1 : 0;
  const sys: Vars = {
    ...conditionVars(primary, rules),
    stars: stars.length,
    secondaries,
    dead: deadCount,
    deadPrimary: DEAD.includes(primary.kind) ? 1 : 0,
    companion: stars[1]?.role === 'companion' ? 1 : 0,
    primordial,
    age,
  };
  const main = known?.mainworld;
  const mainIsBelt = main?.size === 0;
  let giants: number;
  let belts: number;
  let terrestrials: number;
  if (sys.deadPrimary && known?.gasGiants === undefined && !main) {
    const natural = dice.d(2);
    if (!dice.f('deadSystemExists', { natural, DM: dice.dm('deadSystem', sys) })) {
      notes.push('Nothing survived the death of the primary star: the system has no worlds.');
      return undefined;
    }
  }
  const variant = sys.deadPrimary ? '.dead' : sys.bd ? '.BD' : '';
  const named = (name: string) => (dice.has(name + variant) ? name + variant : name);
  if (known?.gasGiants !== undefined) giants = known.gasGiants;
  else giants = dice.f(named('gasGiantsExist')) ? dice.row(rules.quantities.gasGiants, dice.d(2) + dice.dm('gasGiants', sys)).n : 0;
  sys.gasGiants = giants;
  if (known?.belts !== undefined) belts = known.belts + (mainIsBelt ? 1 : 0);
  else {
    belts = dice.f(named('beltsExist'), { DM: dice.dm('beltsExist', sys) }) ? dice.row(rules.quantities.belts, dice.d(2) + dice.dm('belts', sys)).n : 0;
    if (mainIsBelt && belts === 0) belts = 1;
  }
  if (known?.worlds !== undefined) terrestrials = Math.max(main && !mainIsBelt ? 1 : 0, known.worlds - giants - (known.belts ?? belts));
  else {
    terrestrials = dice.f(named('terrestrials')) + dice.dm('terrestrials', sys);
    if (terrestrials < dice.f('terrestrials.fewBelow')) terrestrials = dice.f('terrestrials.few');
    else terrestrials += dice.f('terrestrials.more');
    if (main && !mainIsBelt) terrestrials = Math.max(1, terrestrials);
  }
  // anomalous orbits each bring a world of their own
  const anomalies: NonNullable<Slot['anomaly']>[] = [];
  if (known?.worlds === undefined) {
    const extra = dice.row(rules.quantities.anomalousOrbits, dice.d(2)).n;
    for (let i = 0; i < extra; i++) {
      const kind = dice.row(rules.anomalies, dice.d(2));
      if (terrestrials + 1 > dice.f('maxTerrestrials')) {
        belts += 1;
        continue;
      }
      terrestrials += 1;
      anomalies.push({ kind: kind.kind, eccDm: kind.eccDm, inclination: kind.kind === 'inclined' ? dice.f('anomaly.inclination') : undefined });
    }
  }
  sys.worlds = giants + belts + terrestrials;
  return { sys, giants, belts, terrestrials, anomalies };
}

/**
 * Generates a star system. With nothing known it is rolled from scratch; given what a listing
 * says (stars, counts of giants and belts, the mainworld's size, air and climate) it is built
 * around that.
 */
export function generateSystem(rules: SystemRules, rng: Rng, known?: KnownSystem, opts: { unusualPrimaries?: boolean } = {}): SystemLayout {
  const dice = new Dice(rules, rng);
  let notes: string[] = [];
  // The climate of a listed mainworld, as the roll that would have given it, and whether that and
  // its air tie it to the habitable zone.
  const main = known?.mainworld;
  const mainIsBelt = main?.size === 0;
  const climate = main?.temperature ?? 'temperate';
  const rawRoll = dice.f(`climate.${climate}`) - (main && climate !== 'frozen' && climate !== 'boiling' ? dice.dm('temperatureByAtmosphere', { atm: main.atm }) : 0);
  const inZone = !!main && !mainIsBelt && !!dice.f('mainworld.inZone', { size: main.size, atm: main.atm, raw: rawRoll });
  let { stars, age } = buildStars(dice, known, notes, !!opts.unusualPrimaries);
  let groups = buildGroups(dice, stars);
  // Such a mainworld must be able to sit where its climate is found. If the other stars of the
  // system crowd that orbit out, they are arranged again (a referee would move them by hand).
  for (let attempt = 0; inZone && stars.length > 1 && attempt < 12; attempt++) {
    const home = groups[0];
    if (inRanges(home.ranges, home.hzco) && home.ranges.some(([a, b]) => a <= home.hzco - 0.5 || b >= home.hzco + 0.5)) break;
    notes = [];
    ({ stars, age } = buildStars(dice, known, notes, !!opts.unusualPrimaries));
    groups = buildGroups(dice, stars);
  }
  const primary = stars[0];
  const layout: SystemLayout = { age, stars, groups, worlds: [], gasGiants: 0, belts: 0, terrestrials: 0, baseline: 0, spread: 0, profile: '', notes };
  const counted = countWorlds(dice, stars, age, known, notes);
  if (!counted) {
    layout.profile = '0-0-0-0-0';
    return layout;
  }
  const { sys, giants, belts, terrestrials, anomalies } = counted;
  const primordial = sys.primordial;
  const regular = giants + belts + terrestrials - anomalies.length;
  layout.gasGiants = giants;
  layout.belts = belts;
  layout.terrestrials = terrestrials;

  // ── which stars they circle ──
  const open = groups.map((g, i) => ({ i, width: widthOf(g.ranges) })).filter((g) => g.width > 0);
  if (open.length === 0) {
    notes.push('The stars leave no stable orbit for a world.');
    return layout;
  }
  const shares = open.map((g) => Math.max(1, Math.floor(g.width + (groups[g.i].stars.length === 1 ? 1 : 0))));
  const sum = shares.reduce((a, b) => a + b, 0);
  const allot = open.map(() => 0);
  let left = regular;
  open.forEach((_, n) => {
    if (n === open.length - 1) allot[n] = left;
    else {
      const share = (regular * shares[n]) / sum;
      allot[n] = Math.min(left, n === 0 ? Math.ceil(share) : Math.floor(share));
      left -= allot[n];
    }
  });
  // empty orbits add room: around the other stars first, then the primary
  const empties = dice.row(rules.quantities.emptyOrbits, dice.d(2)).n;
  const emptyAt: number[] = [];
  for (let e = 0; e < empties; e++) {
    const order = [...open.keys()].slice(1).concat(0);
    const target = order.find((n) => allot[n] > 0 && !emptyAt.includes(n)) ?? order[order.length - 1];
    emptyAt.push(target);
    allot[target] += 1;
  }

  // ── the baseline world and the spacing of the rest ──
  const home = groups[open[0].i];
  const slots: Slot[] = [];
  let baselineNumber = dice.f('baselineNumber', { DM: dice.dm('baseline', sys) });
  const homeCount = allot[0];
  let baselineOrbit: number;
  const vars: Vars = { HZCO: home.hzco, N: baselineNumber, W: homeCount, MAO: home.mao, MIN: home.mao };
  if (inZone) {
    // a mainworld with a known climate fixes the baseline
    baselineNumber = Math.max(1, Math.min(homeCount, baselineNumber));
    baselineOrbit = orbitForRawRoll(rules, home.hzco, rawRoll);
  } else if (baselineNumber >= 1 && baselineNumber <= homeCount) baselineOrbit = dice.f(home.hzco >= 1 ? 'baselineOrbit.zone' : 'baselineOrbit.zoneLow', vars);
  else if (baselineNumber < 1) baselineOrbit = dice.f(home.mao >= 1 || home.hzco >= 1 ? 'baselineOrbit.cold' : 'baselineOrbit.coldLow', vars);
  else {
    const reach = home.hzco - baselineNumber + homeCount;
    baselineOrbit = dice.f(reach >= 1 ? 'baselineOrbit.hot' : 'baselineOrbit.hotLow', vars);
    if (baselineOrbit <= home.mao) baselineOrbit = dice.f('baselineOrbit.hotFloor', vars);
  }
  const nearest = (ranges: [number, number][], orbit: number): number => {
    if (inRanges(ranges, orbit)) return orbit;
    let best = ranges[0][0];
    for (const [a, b] of ranges) for (const edge of [a, b]) if (Math.abs(edge - orbit) < Math.abs(best - orbit)) best = edge;
    const nudge = dice.f('baselineOrbit.nudge');
    const range = ranges.find(([a, b]) => best === a || best === b)!;
    return Math.max(range[0], Math.min(range[1], best === range[0] ? best + Math.min(nudge, (range[1] - range[0]) / 2) : best - Math.min(nudge, (range[1] - range[0]) / 2)));
  };
  baselineOrbit = nearest(home.ranges, Math.max(home.mao + 0.01, baselineOrbit));
  let spread = Math.max(0.01, dice.f('spread', { B: baselineOrbit, MAO: home.mao, N: baselineNumber }));
  const maxSpread = dice.f('maxSpread', { A: widthOf(home.ranges), S: Math.max(1, homeCount), T: stars.length });
  if (spread * (homeCount - Math.max(1, baselineNumber)) + baselineOrbit > dice.f('maxOrbit')) spread = Math.min(spread, maxSpread);
  layout.baseline = Math.max(0, Math.round(baselineNumber));
  layout.spread = round(spread, 2);

  /** The orbit reached by going a distance outward from a starting orbit, counting only stretches open to worlds. */
  const along = (ranges: [number, number][], from: number, distance: number): number => {
    let left = distance;
    let at = from;
    for (const [a, b] of ranges) {
      if (b <= at) continue;
      const start = Math.max(a, at);
      if (left <= b - start) return start + left;
      left -= b - start;
      at = b;
    }
    return at + left;
  };
  const openBetween = (ranges: [number, number][], from: number, to: number) => ranges.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
  const fill = (n: number, group: OrbitGroup, groupIndex: number, step: number, baseAt: number, baseOrbit: number | undefined) => {
    const limit = group.ranges[group.ranges.length - 1][1];
    const orbits: number[] = [];
    let at = group.mao;
    for (let k = 1; k <= n; k++) {
      if (baseOrbit !== undefined && k === baseAt) at = baseOrbit;
      else at = along(group.ranges, at, Math.max(step * 0.5, step + dice.f('slotVariance', { SPREAD: step })));
      orbits.push(at);
    }
    // the worlds inside the baseline must stay inside it: space them evenly if the dice ran past
    if (baseOrbit !== undefined && baseAt > 1 && orbits.slice(0, baseAt - 1).some((o) => o >= baseOrbit)) {
      const room = openBetween(group.ranges, group.mao, baseOrbit);
      for (let k = 1; k < baseAt; k++) orbits[k - 1] = along(group.ranges, group.mao, (room * k) / baseAt);
    }
    // and nothing lies beyond the last stable orbit: draw the outer worlds in to fit
    if (orbits[n - 1] > limit) {
      const from = baseOrbit !== undefined && baseAt >= 1 && baseOrbit < limit ? baseAt : 0;
      const start = from ? orbits[from - 1] : group.mao;
      const room = openBetween(group.ranges, start, limit);
      const count = n - from;
      for (let j = 1; j <= count; j++) orbits[from + j - 1] = along(group.ranges, start, (room * j) / (count + 0.5));
    }
    return orbits.map((orbit, k): Slot => ({ group: groupIndex, orbit: round(orbit, orbit < 1 ? 3 : 2), baseline: baseOrbit !== undefined && k + 1 === baseAt }));
  };
  open.forEach((g, n) => {
    const group = groups[g.i];
    if (allot[n] === 0) return;
    if (n === 0) {
      const baseAt = Math.max(1, Math.min(allot[n], Math.round(baselineNumber)));
      const inZone = baselineNumber >= 1 && baselineNumber <= homeCount;
      slots.push(...fill(allot[n], group, g.i, spread, inZone ? baseAt : baselineNumber < 1 ? 1 : allot[n], baselineOrbit));
      // two worlds cannot share an orbit: nudge any that the rounding brought together
      for (let k = 1; k < slots.length; k++) if (slots[k].orbit <= slots[k - 1].orbit) slots[k].orbit = round(slots[k - 1].orbit + (slots[k - 1].orbit < 1 ? 0.002 : 0.01), 3);
    } else {
      const outer = group.ranges[group.ranges.length - 1][1];
      const own = Math.min(spread, dice.f('secondarySpread', { OUT: outer, MAO: group.mao, S: allot[n] }));
      const made = fill(allot[n], group, g.i, Math.max(0.005, own), 0, undefined);
      for (let k = 1; k < made.length; k++) if (made[k].orbit <= made[k - 1].orbit) made[k].orbit = round(made[k - 1].orbit + (made[k - 1].orbit < 1 ? 0.002 : 0.01), 3);
      slots.push(...made);
    }
  });
  // worlds on orbits of their own
  for (const anomaly of anomalies) {
    const g = dice.pick(open);
    const group = groups[g.i];
    let orbit = dice.f('anomaly.orbit');
    if (anomaly.kind === 'trojan') {
      const mates = slots.filter((s) => s.group === g.i && !s.anomaly);
      if (mates.length) orbit = dice.pick(mates).orbit;
    }
    orbit = Math.max(group.mao + 0.01, Math.min(dice.f('maxOrbit'), orbit));
    if (!inRanges(group.ranges, orbit)) orbit = nearest(group.ranges, orbit);
    slots.push({ group: g.i, orbit: round(orbit, 2), anomaly, content: 'terrestrial' });
  }

  // ── what sits in each orbit ──
  const free = () => slots.filter((s) => !s.content);
  const mainSlot = main ? (slots.find((s) => s.baseline) ?? slots[0]) : undefined;
  if (main && mainSlot) {
    if (!inZone) {
      // no pleasant climate to place it by: a frozen world goes out beyond the zone, a boiling one inside it, the rest wherever the dice say
      const coldest = rules.zones[0];
      const hottest = rules.zones[rules.zones.length - 1];
      const candidates = free().filter((s) => {
        const d = habitableZone(rules, s.orbit, groups[s.group].hzco).deviation;
        return rawRoll <= coldest.raw ? d >= coldest.deviation : rawRoll >= hottest.raw ? d <= hottest.deviation : true;
      });
      const chosen = candidates.length ? dice.pick(candidates) : mainSlot;
      chosen.content = mainIsBelt ? 'belt' : 'terrestrial';
      chosen.mainworld = true;
    } else {
      mainSlot.content = mainIsBelt ? 'belt' : 'terrestrial';
      mainSlot.mainworld = true;
    }
  }
  let toPlace = { empty: empties, gasGiant: giants, belt: belts - (main && mainIsBelt ? 1 : 0), terrestrial: 0 };
  for (const kind of ['empty', 'gasGiant', 'belt'] as const) {
    for (let k = 0; k < toPlace[kind]; k++) {
      const pool = free();
      if (!pool.length) break;
      dice.pick(pool).content = kind;
    }
  }
  for (const slot of free()) slot.content = 'terrestrial';
  toPlace = { ...toPlace };

  // ── the worlds themselves ──
  const starLetters = (groupIndex: number, orbit: number): string => {
    const group = groups[groupIndex];
    if (groupIndex !== 0) return group.key;
    // around the primary: every star whose own orbit lies inside this one is circled too
    const inside = stars.filter((s) => s.role !== 'primary' && s.role !== 'companion' && s.orbit! < orbit);
    if (!inside.length) return group.key;
    return `A${inside.map((s) => s.designation[0]).join('')}`;
  };
  const insideOf = (groupIndex: number, orbit: number) => {
    if (groupIndex !== 0) return groups[groupIndex].stars.map((i) => stars[i]);
    return stars.filter((s, i) => groups[0].stars.includes(i) || (s.role !== 'companion' && s.role !== 'primary' && s.orbit! < orbit) || (s.role === 'companion' && s.parent !== 0 && stars[s.parent!].orbit! < orbit));
  };
  const ordered = slots.filter((s) => s.content && s.content !== 'empty').sort((a, b) => a.group - b.group || a.orbit - b.orbit);
  const counters = new Map<string, { planets: number; belts: number }>();
  for (const slot of ordered) {
    const around = starLetters(slot.group, slot.orbit);
    const circled = insideOf(slot.group, slot.orbit);
    const mass = circled.reduce((n, s) => n + s.mass, 0);
    const luminosity = circled.reduce((n, s) => n + s.luminosity, 0);
    // the zone a world sits in is set by the light of every star inside its orbit
    const hzco = slot.group === 0 ? round(auToOrbit(rules, dice.f('hzco', { L: Math.max(luminosity, 1e-12) })), 2) : groups[slot.group].hzco;
    const au = orbitToAu(rules, slot.orbit);
    const counter = counters.get(around) ?? { planets: 0, belts: 0 };
    counters.set(around, counter);
    const prefix = stars.length === 1 ? '' : `${around} `;
    const world: WorldInfo = {
      kind: slot.content as WorldInfo['kind'],
      around,
      group: slot.group,
      orbit: slot.orbit,
      au: round(au, au < 1 ? 3 : 2),
      ecc: 0,
      period: 0,
      designation: '',
      size: '0',
      sizeValue: 0,
      ...habitableZone(rules, slot.orbit, hzco),
      hzDeviation: 0,
      moons: [],
      rings: 0,
      mainworld: slot.mainworld,
      starCount: circled.length,
      starMass: mass,
      starLight: luminosity,
      hzco,
    };
    world.hzDeviation = habitableZone(rules, slot.orbit, hzco).deviation;
    if (slot.anomaly) {
      world.anomaly = slot.anomaly.kind;
      world.inclination = slot.anomaly.inclination;
    }
    if (world.kind === 'belt') {
      counter.belts += 1;
      world.designation = `${prefix}P${roman(counter.belts)}`;
    } else {
      counter.planets += 1;
      world.designation = `${prefix}${roman(counter.planets)}`;
      world.ecc = rollEccentricity(dice, { star: 0, extraStars: circled.length - 1, orbit: slot.orbit, age, beltBody: 0, proto: primary.proto ? 1 : 0, primordial }, slot.anomaly?.eccDm ?? 0);
    }
    world.period = dice.f('period', { AU: au, M: Math.max(mass, 1e-6) });
    if (world.kind === 'gasGiant') {
      world.giant = rollGasGiant(dice, { ...conditionVars(primary, rules), spread });
      world.size = `${world.giant.code}${sizeCode(world.giant.diameter)}`;
      world.sizeValue = world.giant.diameter * 8;
    } else if (world.kind === 'terrestrial') {
      world.sizeValue = slot.mainworld && main ? main.size : dice.roll(dice.row(rules.sizes.terrestrial, dice.f('terrestrialSize')).roll);
      world.size = sizeCode(world.sizeValue);
    }
    if (world.kind !== 'belt' && !(slot.mainworld && main && main.size === 0)) {
      const group = groups[slot.group];
      const edge = group.ranges.some(([a, b]) => Math.abs(slot.orbit - a) < spread || Math.abs(b - slot.orbit) < spread);
      const squeezed = slot.orbit < 1 || (edge && (stars.length > 1 || group.stars.length > 1));
      rollMoons(dice, world, squeezed);
    }
    layout.worlds.push(world);
  }
  layout.worlds.sort((a, b) => a.group - b.group || a.orbit - b.orbit);
  layout.profile = `${giants}-${belts}-${sizeCode(terrestrials)}-${layout.baseline}-${layout.spread}`;
  return layout;
}

/**
 * The world best suited to be the mainworld of a system surveyed with none named. Where the worlds
 * have been worked out in detail it is the rocky world easiest to live on (then the richest);
 * otherwise the one nearest the middle of its habitable zone (the larger of two equally near).
 * Failing any rocky world, a belt.
 */
export function likelyMainworld(layout: SystemLayout): WorldInfo | undefined {
  const best = (kind: WorldInfo['kind']) =>
    layout.worlds
      .filter((w) => w.kind === kind)
      .sort(
        (a, b) =>
          (b.detail?.habitability ?? 0) - (a.detail?.habitability ?? 0) ||
          (b.detail?.resources ?? 0) - (a.detail?.resources ?? 0) ||
          Math.abs(a.hzDeviation) - Math.abs(b.hzDeviation) ||
          b.sizeValue - a.sizeValue,
      )[0];
  return best('terrestrial') ?? best('belt');
}

/** A short line of stellar data for a system listing: "G7 V G8 V K8 V M0 V D". */
export function starsLabel(stars: StarInfo[]): string {
  return stars.map((s) => s.label).join(' ');
}

/** What a sector listing says of a new system: its stars, and how many giants, belts and worlds in all it has. */
export function rollListing(rules: SystemRules, rng: Rng, mainworld?: KnownSystem['mainworld']): { stars: string; gasGiants: number; belts: number; worlds: number } {
  const dice = new Dice(rules, rng);
  // a listed mainworld needs a living star to circle: dead and failed stars are kept for companions
  const { stars, age } = buildStars(dice, undefined, [], false);
  const counted = countWorlds(dice, stars, age, mainworld ? { mainworld } : undefined, []);
  if (!counted) return { stars: starsLabel(stars), gasGiants: 0, belts: 0, worlds: mainworld ? 1 : 0 };
  const mainIsBelt = mainworld?.size === 0;
  return { stars: starsLabel(stars), gasGiants: counted.giants, belts: counted.belts - (mainIsBelt ? 1 : 0), worlds: counted.giants + counted.belts + counted.terrestrials };
}

export type { WhenDm };
