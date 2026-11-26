/**
 * The people of a world in depth: how many and how gathered, how they are governed and by which
 * factions, what their law allows, what their technology runs to field by field, their culture,
 * their economy and their port. And the lesser settlements of the same system. Every table,
 * formula and threshold comes from the rules pack (`WorldRules.society`); this file only carries
 * the procedure out, and holds no figure from a rulebook.
 *
 * Names a pack's formulas and conditions may use:
 *   the world     size, atm, hyd, pop, gov, law, tl, hab (habitability, -1 if unrated), resources, locked,
 *                 belts and giants (others of the system), bases, waystation
 *   its port      portA, portB, portC, portD, portE, portX (0 or 1)
 *   trade codes   Ag, As, Ba, De, Fl, Ga, Hi, Ht, Ic, In, Lo, Lt, Na, Ni, Po, Ri, Va, Wa (0 or 1)
 *   its people    minTl, pcr, urban (percent), urbanPeople, balkanised
 *   government    any `flag` of the result rows (such as confederal or judicialAuthority), and while a
 *                 function's makeup is settled: authoritative, balanced, and that function's flag
 *   factions      withRulers, sameGovernment
 *   law           any `flag` of the justice row; weaponsLaw
 *   technology    high, and each sub-level by its id once settled
 *   culture       each trait by its id once settled
 *   economy       importance, RATING, resource, infrastructure, efficiency, BASE, MODS, gwpPerHead, inequality,
 *                 wtnPort (the port's modifier), freeport
 *   settlements   CAP, inZone, belt, and the mainworld's own figures as mainPop, mainGov, mainLaw, mainTl,
 *                 mainBases, mainPortA…, mainIn, mainPo and so on; any class `flag`
 *   DM            the modifiers that apply
 */
import type { Vars } from '../dicex';
import type { DecideRule, SocietyRules, WorldRules } from '../rulepack';
import type { BodyDetail, Settlement, Society, SocietyPart } from '../types';
import type { Rng } from '../util';
import { ehexChar } from '../uwp';
import { Dice, type SystemLayout } from './system';

const TRADE_CODES = ['Ag', 'As', 'Ba', 'De', 'Fl', 'Ga', 'Hi', 'Ht', 'Ic', 'In', 'Lo', 'Lt', 'Na', 'Ni', 'Po', 'Ri', 'Va', 'Wa'];
const PORTS = ['A', 'B', 'C', 'D', 'E', 'X'];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const figures = (n: number, digits = 3) => (n === 0 || !Number.isFinite(n) ? 0 : Number(n.toPrecision(digits)));

/** What is known of a mainworld before its society is worked out. */
export interface SocietyInput {
  port: string;
  size: number;
  atm: number;
  hyd: number;
  pop: number;
  gov: number;
  law: number;
  tl: number;
  /** First digit of the population, where a listing gives it. */
  digit?: number;
  /** Trade codes. */
  codes: string[];
  /** How many bases it has (pirates' excepted). */
  bases: number;
  waystation?: boolean;
  /** Belts and gas giants of the system besides the mainworld. */
  belts: number;
  giants: number;
  /** From a detailed survey, where there has been one. */
  habitability?: number;
  resources?: number;
  locked?: boolean;
}

type D = Dice<SocietyRules>;

function baseVars(input: SocietyInput, prefix = ''): Vars {
  const v: Vars = {};
  const set = (name: string, value: number) => (v[prefix ? prefix + name.charAt(0).toUpperCase() + name.slice(1) : name] = value);
  for (const key of ['size', 'atm', 'hyd', 'pop', 'gov', 'law', 'tl', 'bases', 'belts', 'giants'] as const) set(key, Math.max(0, input[key]));
  set('hab', input.habitability ?? -1);
  set('resources', input.resources ?? -1);
  set('locked', input.locked ? 1 : 0);
  set('waystation', input.waystation ? 1 : 0);
  for (const port of PORTS) set(`port${port}`, input.port === port ? 1 : 0);
  for (const code of TRADE_CODES) v[prefix + code] = input.codes.includes(code) ? 1 : 0;
  return v;
}

/** The least technology that keeps people alive on a world. */
function leastTech(dice: D, v: Vars): number {
  let least = 0;
  for (const row of dice.rules.minimumTech) if (dice.roll(row.when, v)) least = Math.max(least, row.tl);
  return least;
}

/** Settles something by the first rule that holds, or by the usual roll on its table. */
function decide<T extends { max: number; code: string }>(dice: D, rules: DecideRule[], table: T[], roll: string, dmName: string | undefined, v: Vars): T {
  const rule = rules.find((r) => dice.roll(r.when, v));
  const byCode = (code: string) => table.find((row) => row.code === code) ?? table[0];
  if (rule?.code) return byCode(rule.code);
  if (rule?.rows) return byCode(dice.row(rule.rows, dice.roll(rule.roll ?? '1D', v)).code);
  return dice.row(table, dice.f(roll, { ...v, DM: (dmName ? dice.dm(dmName, v) : 0) + (rule?.dm ?? 0) }));
}

function peopleOf(dice: D, v: Vars, input: SocietyInput): NonNullable<Society['people']> {
  const rules = dice.rules;
  const digit = input.digit && input.digit > 0 ? input.digit : clamp(dice.f('populationDigit'), 1, 9);
  const total = Math.round((digit * 10 + dice.f('populationMore')) * 10 ** (v.pop - 1));
  let pcr: number;
  if (v.pop < dice.f('concentration.onePlaceBelow') && dice.f('concentration.onePlace', v)) pcr = dice.f('concentration.all');
  else {
    pcr = dice.row(rules.concentration, dice.f('concentration', { DM: dice.dm('concentration', v) })).code;
    if (v.pop >= dice.f('concentration.leastFrom')) pcr = Math.max(1, pcr);
  }
  v.pcr = pcr;
  let urban = dice.roll(dice.row(rules.urbanisation, dice.f('urbanisation', { DM: dice.dm('urbanisation', v) })).pct, v);
  // limits that go with some conditions: a least beats a most
  let most = 100;
  let least = 0;
  for (const limit of rules.urbanLimits) {
    if (!dice.roll(limit.when, v)) continue;
    if (limit.most) most = Math.min(most, dice.roll(limit.most, v));
    if (limit.least) least = Math.max(least, dice.roll(limit.least, v));
  }
  urban = clamp(Math.max(least, Math.min(most, urban)), 0, 100);
  const urbanPeople = Math.round((total * urban) / 100);
  Object.assign(v, { urban, urbanPeople });

  const all = dice.f('concentration.all');
  const small = v.pop < dice.f('cities.smallBelow');
  let cities: number;
  let cityPeople = urbanPeople;
  if (pcr === 0) {
    cities = 0;
    cityPeople = 0;
  } else if (small && pcr === all) cities = 1;
  else if (small) cities = Math.max(1, dice.f('cities.few', v));
  else if (pcr === all) cities = dice.f('cities.one', v);
  else {
    cities = dice.f('cities', v);
    cityPeople = Math.round(urbanPeople * Math.min(1, dice.f('cities.people', v)));
  }
  const people: NonNullable<Society['people']> = { digit, total, pcr, pcrName: rules.concentration.find((c) => c.code === pcr)?.name, urban: Math.round(urban), urbanPeople, cities, cityPeople };

  // how the people of the cities are shared out among them: every city has a hundredth at least
  const listed = dice.f('cities.listed');
  if (cities === 0) {
    const town = Math.round(dice.f('town.largest', v));
    if (town >= 1) people.largest = [figures(town, 2)];
  } else if (cities === 1) people.largest = [figures(cityPeople, 2)];
  else {
    const shares: number[] = [];
    if (cities <= 3) {
      let left = 100;
      for (let i = 0; i < cities; i++) {
        const after = cities - 1 - i;
        const share = i === cities - 1 ? left : clamp(Math.round((left * dice.f('city.share')) / 100), 1, left - after);
        shares.push(share);
        left -= share;
      }
    } else {
      const pool = 100 - cities;
      const size = Math.max(1, Math.min(pcr, Math.floor(pool / (2 * cities))));
      let chunks = Math.floor(pool / size);
      const rest = pool - chunks * size;
      for (let i = 0; i < cities; i++) shares.push(1);
      let at = 0;
      while (chunks > 0) {
        const dealt = Math.min(chunks, Math.max(1, dice.f('city.chunks')));
        shares[at % cities] += dealt * size;
        chunks -= dealt;
        at++;
      }
      shares[at % cities] += rest;
    }
    people.largest = shares.sort((a, b) => b - a).slice(0, listed).map((share) => figures((cityPeople * share) / 100, 2));
  }
  return people;
}

function governmentOf(dice: D, v: Vars): NonNullable<Society['government']> {
  const rules = dice.rules;
  const most = dice.f('government.most');
  const split = dice.f('government.balkanised');
  /** A government for a state or faction: never the code for a world of many states, which is no government at all. */
  const rollGovernment = () => {
    let code = clamp(dice.f('government', v), 0, most);
    for (let tries = 0; code === split && tries < 4; tries++) code = clamp(dice.f('government', v), 0, most);
    return code === split ? dice.f('government.none') : code;
  };
  const out: NonNullable<Society['government']> = { code: v.gov };
  v.balkanised = v.gov === split ? 1 : 0;
  if (v.balkanised) {
    // many states: the one by the starport is described; the rest are named by their governments
    const count = dice.f('nations');
    const nations: number[] = [];
    for (let i = 0; i < count; i++) nations.push(rollGovernment());
    out.nations = nations;
    out.host = nations[0];
    v.gov = nations[0];
  }
  if (v.gov !== dice.f('government.none')) {
    const central = dice.row(rules.centralisation, dice.f('centralisation', { DM: dice.dm('centralisation', v) }));
    for (const row of rules.centralisation) if (row.flag) v[row.flag] = row === central ? 1 : 0;
    const authority = dice.row(rules.authority, dice.f('authority', { DM: dice.dm('authority', v) }));
    for (const row of rules.authority) if (row.flag) v[row.flag] = 0;
    if (authority.flag) v[authority.flag] = 1;
    Object.assign(out, { centralisation: central.code, centralisationName: central.name, authority: authority.code, authorityName: authority.name });
    const balanced = !rules.functions.some((fn) => fn.code === authority.code);
    const makeup = (fn: SocietyRules['functions'][number]) => {
      const vars: Vars = { ...v, authoritative: fn.code === authority.code ? 1 : 0, balanced: balanced ? 1 : 0 };
      for (const other of rules.functions) if (other.flag) vars[other.flag] = other === fn ? 1 : 0;
      return decide(dice, rules.structureRules, rules.structure, 'structure', undefined, vars);
    };
    const lead = rules.functions.find((fn) => fn.code === authority.code);
    const first = lead ? makeup(lead) : undefined;
    const unitary = central === rules.centralisation[rules.centralisation.length - 1];
    out.structure = rules.functions
      .filter((fn) => balanced || fn === lead || !(unitary && first?.sole))
      .map((fn) => {
        const body = fn === lead ? first! : makeup(fn);
        return { function: fn.code, functionName: fn.name, code: body.code, name: body.name };
      });
    const own = out.structure.find((s) => s.function === authority.code) ?? out.structure[0];
    out.profile = `${ehexChar(v.gov)}-${central.code}${authority.code}${own?.code ?? ''}`;
  }
  // factions beyond the government itself
  const count = dice.f('factions', { DM: dice.dm('factions', v) });
  const factions: NonNullable<Society['government']>['factions'] = [];
  const limit = dice.f('factions.most');
  for (let i = 1; i < count && factions.length < limit; i++) {
    const government = rollGovernment();
    const strength = dice.row(rules.strength, dice.f('strength'));
    const relation = dice.row(rules.relations, dice.f('relation', { DM: dice.dm('relations', { ...v, withRulers: 1, sameGovernment: government === v.gov ? 1 : 0 }) }));
    factions.push({ government, strength: strength.code, strengthName: strength.name, relation: relation.code, relationName: relation.name });
  }
  if (factions.length) out.factions = factions;
  return out;
}

function lawOf(dice: D, v: Vars): NonNullable<Society['law']> {
  const rules = dice.rules;
  const out: NonNullable<Society['law']> = { parts: [] };
  for (const row of rules.justice) if (row.flag) v[row.flag] = 0;
  if (v.gov !== dice.f('government.none')) {
    const justice = dice.row(rules.justice, dice.f('justice', { DM: dice.dm('justice', v) }));
    if (justice.flag) v[justice.flag] = 1;
    Object.assign(out, { justice: justice.code, justiceName: justice.name });
    // some courts hand matters of trade and regulation to an administrative process of the first kind
    if (justice !== rules.justice[0] && dice.f('justice.economic', v)) out.economicCourts = true;
    const uniformity = decide(dice, rules.uniformityRules, rules.uniformity, 'uniformity', 'uniformity', v);
    Object.assign(out, { uniformity: uniformity.code, uniformityName: uniformity.name });
  }
  out.presumption = !!dice.f('presumption', { DM: dice.dm('presumption', v) });
  out.death = !!dice.f('death', { DM: dice.dm('death', v) });
  for (const part of rules.lawParts) {
    const level = dice.f('lawPart', { ...v, DM: dice.dm(part.dm, v) });
    const effects = rules.lawEffects[part.id] ?? [];
    out.parts.push({ id: part.id, name: part.name, level, note: effects[Math.min(level, effects.length - 1)] });
    v[`${part.id}Law`] = level;
  }
  out.profile = `${ehexChar(v.law)}-${out.parts.map((p) => ehexChar(p.level)).join('')}`;
  return out;
}

function techOf(dice: D, v: Vars): NonNullable<Society['tech']> {
  const rules = dice.rules;
  const ceiling = dice.f('tech.ceiling');
  v.high = v.tl;
  const parts: SocietyPart[] = [];
  for (const part of rules.tech) {
    let level = 0;
    if (!(part.zeroWhen && dice.roll(part.zeroWhen, v))) {
      const modifier = rules.techModifier[clamp(dice.f('techModifier'), 2, rules.techModifier.length + 1) - 2] ?? 0;
      const least = Math.floor(dice.roll(part.least, v));
      const most = Math.floor(dice.roll(part.most, v));
      level = Math.floor(dice.roll(part.from, v)) + modifier + dice.dm(part.dm, v);
      level = clamp(Math.max(least, Math.min(most, level)), 0, Math.max(ceiling, v.tl));
    }
    v[part.id] = level;
    const steps = rules.techSteps[part.id];
    parts.push({ id: part.id, name: part.name, level, note: steps?.[Math.min(level, steps.length - 1)] });
  }
  return { high: v.tl, least: v.minTl, parts, profile: `${ehexChar(v.tl)}-${parts.map((p) => ehexChar(p.level)).join('')}` };
}

function cultureOf(dice: D, v: Vars): NonNullable<Society['culture']> {
  const low = dice.f('trait.lowTo');
  const high = dice.f('trait.highFrom');
  return dice.rules.culture.map((trait) => {
    const level = dice.f('trait', { DM: dice.dm(trait.id, v) });
    v[trait.id] = level;
    return { id: trait.id, name: trait.name, level, leaning: level <= low ? trait.low : level >= high ? trait.high : undefined };
  });
}

function economyOf(dice: D, v: Vars, input: SocietyInput, total: number): NonNullable<Society['economy']> {
  const rules = dice.rules;
  const importance = dice.dm('importance', v);
  v.importance = importance;
  const RATING = v.resources >= 0 ? dice.f('resource.worked', v) : dice.f('resource.unknown');
  const resource = dice.f('resourceFactor', { ...v, RATING });
  const labour = dice.f('labourFactor', v);
  const infrastructure = dice.f('infrastructureFactor', v);
  Object.assign(v, { resource, infrastructure });
  const bound = dice.f('efficiency.bound');
  let efficiency = clamp(dice.f(v.pop >= dice.f('efficiency.largeFrom') ? 'efficiency.large' : 'efficiency.small', { DM: dice.dm('efficiency', v) }), -bound, bound);
  if (efficiency === 0) efficiency = 1;
  v.efficiency = efficiency;
  const one = (n: number) => (n === 0 ? 1 : n);
  const ru = one(resource) * one(labour) * one(infrastructure) * efficiency;
  const BASE = dice.f('baseValue', v);
  let MODS = dice.f('techFactor', v) * (rules.portModifier[input.port] ?? 1) * (rules.governmentModifier[v.gov] ?? 1);
  for (const code of input.codes) MODS *= rules.tradeModifier[code] ?? 1;
  const gwpPerHead = Math.max(0, dice.f(efficiency > 0 ? 'gwp' : 'gwp.inefficient', { BASE, MODS, efficiency }));
  const base = dice.f('wtn', { ...v, DM: dice.dm('wtn', v) });
  const wtnPort = dice.row(rules.wtnPort, base).mods[input.port] ?? 0;
  v.wtnPort = wtnPort;
  const inequality = dice.f('inequality', { ...v, DM: dice.dm('inequality', v) });
  const development = dice.f('development', { gwpPerHead, inequality });
  const out: NonNullable<Society['economy']> = {
    importance, resource, labour, infrastructure, efficiency, ru,
    gwpPerHead: Math.round(gwpPerHead), gwp: figures(gwpPerHead * total, 3), wtn: Math.max(0, base + wtnPort), inequality: Math.round(inequality), development: figures(development, 3),
  };
  let tariff = dice.row(rules.tariffs, dice.f('tariff', { DM: dice.dm('tariffs', { ...v, freeport: 0 }) }));
  out.tariff = tariff.name;
  // some regimes tax only certain goods: what they charge on those comes from a further roll
  if (tariff.again) tariff = dice.row(rules.tariffs, dice.f('tariff.again'));
  if (tariff.rate) out.tariffRate = dice.roll(tariff.rate, v);
  return out;
}

/**
 * Works out the people of a mainworld in depth. Nothing comes back for a world with nobody on it,
 * or where the installed rules do not run to it.
 */
export function societyOf(world: WorldRules, rng: Rng, input: SocietyInput): Society | undefined {
  if (!world.society || input.pop <= 0) return undefined;
  const dice = new Dice(world.society, rng);
  const v = baseVars(input);
  v.minTl = leastTech(dice, v);
  const society: Society = {};
  society.people = peopleOf(dice, v, input);
  society.government = governmentOf(dice, v);
  society.law = lawOf(dice, v);
  society.tech = techOf(dice, v);
  society.culture = cultureOf(dice, v);
  society.economy = economyOf(dice, v, input, society.people.total);
  const target = world.society.highport[input.port];
  const traffic = world.society.traffic.find((t) => society.economy!.importance >= t.least);
  society.port = { highport: target !== undefined && dice.f('highport', { DM: dice.dm('highport', v) }) >= target };
  if (traffic) Object.assign(society.port, { standing: traffic.name, daily: Math.max(0, dice.roll(traffic.daily)), weekly: traffic.weekly });
  return society;
}

/**
 * Settles the other worlds of a surveyed system: which have people, how many, how they are ruled,
 * and what each settlement is for. Written on to the detail of each world, moon and belt. Needs the
 * worlds to have been worked out in detail.
 */
export function settleSystem(world: WorldRules, rng: Rng, layout: SystemLayout, main: SocietyInput): void {
  const rules = world.society;
  if (!rules || main.pop <= 0) return;
  const dice = new Dice(rules, rng);
  const mainVars = baseVars(main, 'main');
  const cap = dice.f('secondary.cap', { pop: main.pop });
  if (cap <= 0) return;
  const breadth = world.detail ? Number(world.detail.f['zone.breadth'] ?? 1) : 1;
  const places: { d: BodyDetail; size: string; hz: number; belt: boolean }[] = [];
  for (const w of layout.worlds) {
    if (w.mainworld || !w.detail) continue;
    if (w.kind !== 'gasGiant') places.push({ d: w.detail, size: w.size, hz: w.hzDeviation, belt: w.kind === 'belt' });
    for (const moon of w.moons) if (moon.detail && !moon.giant) places.push({ d: moon.detail, size: moon.size, hz: w.hzDeviation, belt: false });
  }
  for (const place of places) {
    const d = place.d;
    const v: Vars = {
      ...mainVars, CAP: cap, belt: place.belt ? 1 : 0, inZone: Math.abs(place.hz) <= breadth ? 1 : 0,
      atm: Math.max(0, d.atm?.code ?? 0), hyd: d.hydro?.code ?? 0, hab: d.habitability ?? 0, resources: d.resources ?? 0, pop: 0, gov: 0, law: 0, tl: 0,
    };
    for (const cls of rules.classes) if (cls.flag) v[cls.flag] = 0;
    v.minTl = leastTech(dice, v);
    const pop = clamp(dice.f('secondary.population', v), 0, cap);
    // nobody lives where the technology to stay alive is not to be had
    if (pop <= 0 || v.minTl > main.tl) continue;
    v.pop = pop;
    v.gov = dice.row(rules.secondaryGovernment, dice.f('secondary.government', { DM: dice.dm('secondaryGovernment', v) })).gov;
    const classes: { code: string; name: string }[] = [];
    for (const cls of rules.classes) {
      if (!dice.roll(cls.when, v) || (cls.on && !dice.roll(cls.on, v))) continue;
      classes.push({ code: cls.code, name: cls.name });
      if (cls.flag) v[cls.flag] = 1;
    }
    const captive = v.gov === dice.f('secondary.captive');
    v.law = Math.max(0, captive ? dice.roll(dice.row(rules.captiveLaw, dice.f('secondary.captiveLaw', { DM: dice.dm('captiveLaw', v) })).f, v) : dice.f('secondary.law', v));
    v.tl = Math.max(0, dice.f(v.freeport ? 'secondary.tl.freeport' : 'secondary.tl', v));
    const port = dice.row(rules.spaceports, dice.f('spaceport', { DM: dice.dm('spaceport', v) }));
    const settlement: Settlement = { pop, gov: v.gov, law: v.law, tl: v.tl, port: port.code, portName: port.name, profile: '' };
    if (classes.length) settlement.classes = classes;
    settlement.profile = `${port.code}${place.size.length === 1 ? place.size : '0'}${ehexChar(v.atm)}${ehexChar(v.hyd)}${ehexChar(pop)}${ehexChar(v.gov)}${ehexChar(v.law)}-${ehexChar(v.tl)}`;
    d.settlement = settlement;
  }
}
