/**
 * Worlds in detail: what each world, moon and belt of a surveyed system is like. Its makeup and
 * gravity, where its moons and rings lie, its air and water, the length of its day, its climate,
 * its geology, any life, and what it is worth. Every table, formula and threshold comes from the
 * rules pack (`WorldRules.detail`); this file only carries the procedure out, and holds no figure
 * from a rulebook.
 *
 * Names a pack's formulas and conditions may use:
 *   the system   age (Gyr), spread
 *   its place    orbit, AU, ecc, year (in years), hz (orbit numbers from the middle of the habitable zone, negative
 *                hotter), starMass, starCount, L (light of the stars inside the orbit)
 *   the body     size (0 for a belt or a body below size 1), giant, moon, km, density, grav, mass, DIA (a gas
 *                giant's diameter in Earths)
 *   its air      atm (-1 for a gas giant), bar, tainted, taintL (too little oxygen), oxygenTaint, severity, runaway,
 *                troll (the temperature roll its place suggests), thick, extreme
 *   its water    hyd, surface, LO (lowest percentage of its code)
 *   its days     tilt, T (tilt taken within 0 to 90), day, solarDay, locked (one face to its sun)
 *   its climate  K (mean), high, low, albedo, greenhouse, A and G (the figure being adjusted), R (a roll made first)
 *   moons        HILL, LIMIT, MOR (room for moons, in planetary diameters), pd, pmass, retro, msize, moons,
 *                moonSizes, Mkm (millions of km apart), days (period)
 *   geology      tide, stress
 *   life         biomass, biocomplexity, biodiversity, compatibility
 *   belts        giantNext, outermost, m, s, c (percent), bulk, span
 *   DM           the modifiers that apply
 */
import type { Vars } from '../dicex';
import type { AtmosphereResult, AtmosphereSubtype, DetailRules, SystemRules, WorldRules } from '../rulepack';
import type { AirTaint, BodyDetail } from '../types';
import type { Rng } from '../util';
import { ehexChar } from '../uwp';
import { Dice, rollEccentricity, type KnownSystem, type MoonInfo, type SystemLayout, type WorldInfo } from './system';

/** Hours in a standard year, and kilometres in a million. */
const HOURS_PER_YEAR = 8766;
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const figures = (n: number, digits = 3) => (n === 0 || !Number.isFinite(n) ? 0 : Number(n.toPrecision(digits)));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

interface Ctx {
  dice: Dice<DetailRules>;
  sys: Dice<SystemRules>;
  rules: DetailRules;
  age: number;
}

type Air = NonNullable<BodyDetail['atm']>;

/** Every name a condition may ask for, so that none is ever missing. */
function blank(c: Ctx, layout: SystemLayout, w: WorldInfo): Vars {
  return {
    age: c.age, spread: layout.spread, orbit: w.orbit, AU: w.au, ecc: w.ecc, year: w.period, hz: w.hzDeviation,
    starMass: Math.max(w.starMass, 1e-6), starCount: w.starCount, L: w.starLight,
    size: 0, giant: 0, moon: 0, km: 0, density: 0, grav: 0, mass: 0, DIA: 0,
    atm: -1, bar: 0, tainted: 0, taintL: 0, oxygenTaint: 0, severity: 0, runaway: 0, troll: 0, thick: 0, extreme: 0, life: 0,
    hyd: 0, surface: 0, tilt: 0, T: 0, day: 0, solarDay: 0, locked: 0,
    K: 0, high: 0, low: 0, albedo: 0, greenhouse: 0,
    MOR: 0, pd: 0, pmass: 0, retro: 0, msize: 0, moons: 0, moonSizes: 0, Mkm: 0, days: 0,
    tide: 0, stress: 0, biomass: 0, biocomplexity: 0, biodiversity: 0, compatibility: 0,
  };
}

// ───────────────────────────── size ─────────────────────────────

function sizeFigures(c: Ctx, v: Vars, d: BodyDetail, small: boolean): void {
  const { dice, rules } = c;
  const km = Math.round(small ? dice.f('diameter.S') : dice.f('diameter', v));
  const made = dice.row(rules.composition, dice.f('composition', { DM: dice.dm('composition', v) }));
  const column = rules.density[made.id] ?? [1];
  const density = column[clamp(Math.round(dice.f('densityRoll')), 2, column.length + 1) - 2];
  const gravity = dice.f('gravity', { density, km });
  const mass = dice.f('mass', { density, km });
  Object.assign(d, { km, composition: made.name, density, gravity: round(gravity, 2), mass: figures(mass), escape: round(dice.f('escape', { mass, km }), 2) });
  Object.assign(v, { km, density, grav: gravity, mass });
}

function giantFigures(c: Ctx, v: Vars, d: BodyDetail, giant: NonNullable<WorldInfo['giant']>): void {
  const { dice } = c;
  const km = Math.round(dice.f('diameter.giant', { DIA: giant.diameter }));
  const mass = giant.mass;
  // (density and gravity mean little for a ball of gas, and the size bands are too broad to work them out from)
  Object.assign(d, { km, mass });
  Object.assign(v, { km, mass, giant: 1, DIA: giant.diameter });
}

// ───────────────────────────── moons and rings ─────────────────────────────

/** Where a world's moons circle. A world held too tightly by its star keeps none: the first is torn into a ring. */
function placeMoons(c: Ctx, w: WorldInfo, v: Vars): void {
  const { dice, rules } = c;
  const limit = dice.f('moon.limit', { HILL: dice.f('hill', v) });
  if (limit < dice.f('moon.least') && w.moons.length) {
    w.moons = [];
    w.rings += 1;
  }
  if (limit < dice.f('ring.least')) w.rings = 0;
  let room = Math.max(0, dice.f('moon.range', { LIMIT: limit }));
  const cap = dice.f('moon.rangeCap');
  if (room > cap) room = Math.min(room, cap + w.moons.length);
  v.MOR = room;
  const listed = w.moons.filter((m) => m.size !== 'S');
  const places = listed
    .map(() => {
      const band = dice.row(rules.moonOrbit, dice.f('moon.band', { DM: dice.dm('moonBand', v) }));
      return { band, pd: Math.max(dice.f('moon.least'), dice.roll(band.pd, v) + dice.f('moon.variance')) };
    })
    .sort((a, b) => a.pd - b.pd);
  const apart = dice.f('moon.apart');
  for (let i = 1; i < places.length; i++) if (places[i].pd - places[i - 1].pd < apart) places[i].pd = places[i - 1].pd + apart;
  listed.forEach((moon, i) => {
    const { band } = places[i];
    const pd = round(places[i].pd, 1);
    const eccDm = pd > room + dice.f('moon.least') ? dice.f('moon.beyondDm') : band.eccDm;
    const ecc = rollEccentricity(c.sys, { star: 0, extraStars: 0, orbit: 9, age: c.age, beltBody: 0, proto: 0, primordial: 0 }, eccDm);
    const retro = !!dice.f('moon.retro', { DM: eccDm });
    const hours = dice.f('moon.period', { pd, km: v.km, pmass: v.mass });
    moon.detail = { moon: { pd, km: Math.round(pd * v.km), hours: round(hours, 1), ecc, retro: retro || undefined, range: band.range } };
  });
}

function placeRings(c: Ctx, w: WorldInfo, d: BodyDetail): void {
  const { dice } = c;
  if (!w.rings) return;
  const rings = Array.from({ length: w.rings }, () => ({ centre: dice.f('ring.centre'), span: dice.f('ring.span') })).sort((a, b) => a.centre - b.centre);
  const floor = dice.f('ring.floor');
  rings.forEach((ring, i) => {
    const inner = rings[i - 1];
    // rings do not overlap, and none reaches down to the world itself
    if (inner && ring.centre - ring.span / 2 < inner.centre + inner.span / 2) ring.centre = inner.centre + inner.span / 2 + ring.span / 2;
    if (ring.centre - ring.span / 2 < floor) {
      const outer = ring.centre + ring.span / 2;
      ring.span = Math.max(0.01, outer - floor);
      ring.centre = floor + ring.span / 2;
    }
  });
  d.ringSpans = rings.map((r) => ({ centre: round(r.centre, 2), span: round(r.span, 2) }));
}

// ───────────────────────────── air ─────────────────────────────

/** The temperature roll a world's place and air suggest, before its climate is worked out. */
function temperatureRoll(c: Ctx, v: Vars): number {
  const zones = c.sys.rules.zones;
  let raw = c.sys.f('climate.temperate');
  if (Math.abs(v.hz) <= c.dice.f('zone.breadth')) {
    let best = zones[0];
    for (const zone of zones) if (Math.abs(zone.deviation - v.hz) < Math.abs(best.deviation - v.hz)) best = zone;
    raw = best.raw;
  }
  return raw + c.dice.dm('temperatureRoll', v);
}

/** Rolls what is wrong with the air: one taint, or more where the table asks for another roll. */
function rollTaints(c: Ctx, v: Vars, air: Air, first?: 'low' | 'high'): void {
  const { dice, rules } = c;
  const taints: AirTaint[] = air.taints ?? (air.taints = []);
  const cold = v.troll < dice.f('taint.coldBelow');
  const breathable = !!rules.atmospheres.find((a) => a.code === v.atm)?.breathable;
  const byCode = (code: string | undefined) => rules.taints.find((t) => t.code === code && !t.oxygen);
  let oxygen = false;
  const add = (found: (typeof rules.taints)[number], adjust: boolean) => {
    let row = found;
    // oxygen is only the question where the air could otherwise be breathed, and only once;
    // and air too thin to hold too much oxygen cannot have too much of it
    const thin = row.oxygen === 'high' && (air.bar ?? 0) <= dice.f('oxygen.high');
    if (row.oxygen && (!breathable || oxygen || thin)) row = byCode(row.otherwise) ?? row;
    if (row.coldAs && cold) row = byCode(row.coldAs) ?? row;
    const taint: AirTaint = { code: row.code, name: row.name };
    if (row.oxygen) {
      oxygen = true;
      if (adjust) air.ppo = round(Math.min(air.bar ?? 0, Math.max(0.001, dice.f(row.oxygen === 'low' ? 'oxygen.lowered' : 'oxygen.raised'))), 3);
      if (row.oxygen === 'low') v.taintL = 1;
    }
    if (row.life) v.life = 1;
    const vars = { ...v, oxygenTaint: row.oxygen ? 1 : 0, severity: 0 };
    const severity = dice.row(rules.severity, dice.f('severity', { DM: dice.dm('severity', vars) }));
    vars.severity = severity.code;
    const persistence = dice.row(rules.persistence, dice.f('persistence', { DM: dice.dm('persistence', vars) }));
    Object.assign(taint, { severity: severity.code, severityName: severity.name, persistence: persistence.code, persistenceName: persistence.name });
    taints.push(taint);
  };
  const draw = () => dice.row(rules.taints, dice.f('taint', { DM: dice.dm('taint', v) }));
  if (first) {
    // the oxygen stands first; anything more comes only when the dice ask for another roll
    add(rules.taints.find((t) => t.oxygen === first)!, false);
    let row = draw();
    if (row.again) {
      add(row, true);
      row = draw();
      if (row.again) add(draw(), true);
    }
  } else {
    let row = draw();
    add(row, true);
    while (row.again && taints.length < dice.f('taint.most')) {
      row = draw();
      add(row, true);
    }
  }
  v.tainted = 1;
}

/** The air of a world: its code (kept when the listing gives it), pressure, oxygen, and what is wrong with it. */
function airOf(c: Ctx, v: Vars, d: BodyDetail, fixed?: number): void {
  const { dice, rules } = c;
  const def = (code: number) => rules.atmospheres.find((a) => a.code === code) ?? rules.atmospheres[0];
  const breadth = dice.f('zone.breadth');
  let code: number;
  let given: AtmosphereResult | undefined;
  if (fixed !== undefined) code = fixed;
  else if (v.size < dice.f('atmosphere.fromSize')) code = 0;
  else if (Math.abs(v.hz) <= breadth) code = clamp(Math.round(dice.f('atmosphere', { ...v, DM: dice.dm('atmosphere', v) })), 0, dice.f('atmosphere.most'));
  else {
    const rows = rules.zoneAtmospheres.find((b) => (b.min === undefined || v.hz > b.min) && (b.max === undefined || v.hz <= b.max))?.rows ?? [];
    given = rows[clamp(Math.round(dice.f('atmosphere.zone', v)), 0, rows.length - 1)] ?? { atm: 0 };
    code = given.atm;
    if (given.furnace && v.hz <= dice.f('furnace.within')) {
      // this close to its star, little may be left of the air, or something far worse
      const left = dice.row(rules.furnace, dice.f('furnace', { DM: dice.dm('furnace', { ...v, thick: given.thick ? 1 : 0 }) }));
      if (left.atm !== undefined) {
        code = left.atm;
        given = undefined;
      }
    }
  }
  v.atm = code;
  v.troll = temperatureRoll(c, v);
  let runaway = false;
  const thickEnough = !['none', 'trace', 'gas'].includes(def(code).kind);
  if (fixed === undefined && Math.abs(v.hz) <= breadth && thickEnough && v.troll >= dice.f('runaway.from') && dice.f('runaway', { DM: dice.dm('runaway', v) })) {
    // the oceans boil into the air and the heat feeds on itself
    runaway = true;
    v.runaway = 1;
    if (def(code).kind === 'air') {
      v.tainted = def(code).tainted ? 1 : 0;
      code = dice.row(rules.greenhouseCodes, dice.f('runaway.code', { DM: dice.dm('greenhouseCode', v) })).atm;
      v.tainted = 0;
      given = undefined;
    }
    v.atm = code;
    v.troll = Math.max(v.troll, dice.f('runaway.boiling'));
  }

  const a = def(code);
  const air: Air = { code, name: a.name };
  d.atm = air;
  if (a.gear) air.gear = a.gear;
  if (runaway) air.runaway = true;
  const pressure = (min: number, span: number) => round(min + span * dice.f('pressure.part'), 3);

  if (a.kind === 'trace') air.bar = pressure(a.min ?? 0, a.span ?? 0);
  else if (a.kind === 'gas') air.bar = a.min;
  else if (a.kind === 'air') {
    air.bar = pressure(a.min ?? 0, a.span ?? 0);
    let share = dice.f('oxygen', { DM: dice.dm('oxygen', v) });
    if (share <= 0) share = dice.f('oxygen.trace');
    let ppo = share * air.bar;
    const low = dice.f('oxygen.low');
    const high = dice.f('oxygen.high');
    let first: 'low' | 'high' | undefined;
    if (a.breathable && (ppo < low || ppo > high)) {
      // air that could be breathed but for its oxygen: a taint if it is tainted air, otherwise near enough to breathe after all
      if (a.tainted) first = ppo < low ? 'low' : 'high';
      else ppo = clamp(ppo, low, high);
    }
    air.ppo = round(ppo, 3);
    if (first === 'low') v.taintL = 1;
    if (a.tainted || (a.taintOn && dice.roll(a.taintOn, v))) rollTaints(c, v, air, first);
    if (air.ppo < low) air.oxygen = 'low';
    else if (air.ppo > high) air.oxygen = 'high';
    air.scale = round(dice.f('scaleHeight', v), 1);
  } else if (a.kind === 'exotic' || a.kind === 'corrosive' || a.kind === 'insidious') {
    const list = a.kind === 'exotic' ? rules.subtypes.exotic : rules.subtypes.corrosive;
    let row: AtmosphereSubtype | undefined;
    if (a.kind === 'exotic' && given?.density) {
      const irritant = given.irritant === 'yes' || (given.irritant === 'maybe' && !!dice.f('irritant.maybe'));
      row = list.find((s) => s.density === given!.density && !!s.irritant === irritant && !s.attimes);
    }
    row ??= dice.row(list, dice.f('subtype', { DM: dice.dm(a.kind === 'exotic' ? 'exoticSubtype' : 'corrosiveSubtype', v) }));
    air.sub = row.code;
    air.subName = row.name;
    air.bar = row.bar ? figures(dice.roll(row.bar, v)) : pressure(row.min ?? 0, row.span ?? 0);
    if (row.irritant) rollTaints(c, v, air);
    if (row.attimes) {
      // corrosive at times: the worst of irritants, never long away
      const gas = dice.row(rules.taints, dice.f('attimes.taint'));
      const severity = dice.row(rules.severity, dice.f('severity.attimes'));
      const persistence = dice.row(rules.persistence, dice.f('persistence.attimes'));
      (air.taints ??= []).push({ code: gas.code, name: gas.name, severity: severity.code, severityName: severity.name, persistence: persistence.code, persistenceName: persistence.name });
    }
    if (a.kind === 'insidious') {
      const hazard = dice.row(rules.hazards, dice.f('hazard', { DM: dice.dm('hazard', { ...v, extreme: row.extreme ? 1 : 0 }) }));
      if (hazard.life) v.life = 1;
      const always = row.hazard && row.hazard !== hazard.code ? rules.hazards.find((h) => h.code === row!.hazard) : undefined;
      air.hazard = (always?.code ?? '') + hazard.code;
      air.hazardName = always ? `${always.name} and ${hazard.name.toLowerCase()}` : hazard.name;
    }
  }
  v.bar = air.bar ?? 0;
  if (air.taints?.length === 0) delete air.taints;
}

/** An unusual atmosphere's subtype, which waits on the world's water. */
function unusualOf(c: Ctx, v: Vars, air: Air): void {
  const { dice, rules } = c;
  const plain = rules.unusual.find((u) => !u.when && !u.combine)!;
  const pick = (combine: boolean) => {
    for (let tries = 0; tries < 12; tries++) {
      const roll = dice.f('unusual');
      const row = rules.unusual.find((u) => u.roll === roll);
      if (!row || (row.combine && !combine) || (row.when && !dice.roll(row.when, v))) continue;
      return row;
    }
    return plain;
  };
  let rows = [pick(true)];
  if (rows[0].combine) {
    const one = pick(false);
    const two = pick(false);
    rows = one === two ? [one] : [one, two];
  }
  air.sub = rows.map((r) => r.code).join('.');
  air.subName = rows.map((r) => r.name).join(' and ');
  const bars = rows.filter((r) => r.bar).map((r) => dice.roll(r.bar!, v));
  air.bar = figures(bars.length ? Math.max(...bars) : dice.f('unusual.bar'));
  v.bar = air.bar;
}

// ───────────────────────────── water ─────────────────────────────

function waterOf(c: Ctx, v: Vars, d: BodyDetail, fixed?: number): void {
  const { dice, rules } = c;
  const last = rules.hydroRanges.length - 1;
  let code: number;
  if (fixed !== undefined) code = clamp(fixed, 0, last);
  else if (v.size < dice.f('hydro.fromSize')) code = 0;
  else code = clamp(Math.round(dice.f('hydrographics', { ...v, DM: dice.dm('hydrographics', v) })), 0, last);
  let pct = 0;
  if (v.size >= dice.f('hydro.fromSize') || fixed !== undefined) {
    if (code === 0) pct = dice.f('hydro.percent.none');
    else if (code === last) pct = v.size > dice.f('hydro.fullAbove') ? 100 : dice.f('hydro.percent.full');
    else pct = dice.f('hydro.percent', { LO: rules.hydroRanges[code][0] });
  }
  const surface = clamp(Math.round(dice.f('surface')), 0, rules.surface.length - 1);
  d.hydro = { code, pct: Math.round(pct) };
  if (code > 0 && code < last) d.hydro.surface = rules.surface.find((s) => s.roll === surface)?.name;
  v.hyd = code;
  v.surface = surface;
}

/** What fills the seas of a world whose air is not for breathing. */
function liquidOf(c: Ctx, v: Vars, d: BodyDetail): void {
  const kind = c.rules.atmospheres.find((a) => a.code === d.atm?.code)?.kind;
  if (!d.hydro || d.hydro.code === 0 || (kind !== 'exotic' && kind !== 'corrosive' && kind !== 'insidious' && kind !== 'unusual')) return;
  const fits = c.rules.liquids.filter((l) => v.K > l.melt && v.K < l.boil);
  let pick = fits.reduce((n, l) => n + l.abundance, 0) * c.dice.rng();
  for (const liquid of fits) {
    pick -= liquid.abundance;
    if (pick <= 0) {
      d.hydro.liquid = liquid.name;
      return;
    }
  }
}

// ───────────────────────────── days ─────────────────────────────

/** A day and a tilt as the world was made, before tides have had their say. */
function spinOf(c: Ctx, v: Vars, d: BodyDetail, fast: boolean): void {
  const { dice, rules } = c;
  const roll = () => dice.f(fast ? 'day.fast' : 'day', { DM: dice.dm('rotation', v) });
  let hours = roll();
  if (hours >= dice.f('day.long')) while (dice.f('day.more')) hours += roll();
  hours += dice.rng();
  const row = dice.row(rules.tilt, dice.f('tilt'));
  let tilt = row.extreme ? dice.roll(dice.row(rules.extremeTilt, dice.f('tilt.extreme')).roll) + dice.rng() : dice.roll(row.roll ?? '0');
  if (tilt > 180) tilt = 360 - tilt;
  d.day = { hours: Math.max(1, hours), tilt: clamp(tilt, 0, 180) };
}

/** What the tides of one neighbour have done, for a total modifier: nothing, a slower day, or a lock. */
function lockRow(c: Ctx, dm: number): DetailRules['tidalLock'][number] | undefined {
  const { dice, rules } = c;
  if (dm <= dice.f('lock.never')) return undefined;
  const full = rules.tidalLock[rules.tidalLock.length - 1];
  let row = dm >= dice.f('lock.always') ? full : dice.row(rules.tidalLock, dice.f('lock', { DM: dm }));
  // even a full lock may have been knocked loose
  if (row === full && dice.f('lock.broken')) row = dice.row(rules.tidalLock, dice.f('lock', { DM: 0 }));
  return row;
}

/** Applies a tidal result to a day. Returns true for a full lock. `period` is the orbit it is locked into, in hours. */
function applyLock(c: Ctx, d: BodyDetail, row: DetailRules['tidalLock'][number] | undefined, period: number, to: string): boolean {
  const { dice, rules } = c;
  const day = d.day!;
  if (!row) return false;
  if (row.times) day.hours *= row.times;
  else if (row.days) {
    day.hours = dice.roll(row.days) * 24 + dice.rng() * 24;
    if (row.retro && day.tilt < 90) day.tilt = 180 - day.tilt;
  } else if (row.lock) {
    const full = row === rules.tidalLock[rules.tidalLock.length - 1];
    hold(c, d, full ? period : period / dice.f('lock.resonance'), full ? to : row.lock);
    return full;
  }
  return false;
}

/** Holds a world's turning in step with an orbit, which also stands it nearly upright. */
function hold(c: Ctx, d: BodyDetail, hours: number, to: string): void {
  const day = d.day!;
  day.hours = hours;
  if (day.tilt > c.dice.f('tilt.lockedAbove')) day.tilt = c.dice.f('tilt.locked');
  day.lock = to;
}

/** Settles the day: a backward turn counts as negative, and noon to noon follows from the year. */
function settleDay(v: Vars, d: BodyDetail, yearHours: number): void {
  const day = d.day!;
  const turn = Math.abs(day.hours) * (day.tilt > 90 ? -1 : 1);
  day.tilt = round(day.tilt, 1);
  let solar: number | undefined;
  if (day.lock !== 'star') {
    const days = yearHours / turn - 1;
    if (Math.abs(days) > 1e-6) solar = Math.abs(yearHours / days);
  }
  day.hours = round(turn, 2);
  if (solar !== undefined) day.solar = round(solar, 2);
  Object.assign(v, { tilt: day.tilt, T: day.tilt > 90 ? 180 - day.tilt : day.tilt, day: turn, solarDay: solar ?? 0, locked: day.lock === 'star' ? 1 : 0 });
}

// ───────────────────────────── climate ─────────────────────────────

function climateOf(c: Ctx, v: Vars, d: BodyDetail): void {
  const { dice, rules } = c;
  const base = rules.albedo.find((row) => dice.roll(row.when, v));
  let albedo = base ? dice.roll(base.roll, v) : 0.3;
  if (base?.then) albedo = dice.roll(base.then, { ...v, A: albedo });
  for (const row of rules.albedoAdd) if (dice.roll(row.when, v)) albedo += dice.roll(row.roll, v);
  albedo = clamp(albedo, dice.f('albedo.least'), dice.f('albedo.most'));
  let greenhouse = 0;
  if (v.bar > 0) {
    greenhouse = dice.f('greenhouse', v);
    const row = rules.greenhouse.find((g) => dice.roll(g.when, v));
    if (row) greenhouse = dice.roll(row.f, { ...v, G: greenhouse, R: row.R ? dice.roll(row.R, v) : 0 });
  }
  const kelvin = (light: number, au: number) => dice.f('temperature', { L: Math.max(light, 0), albedo, greenhouse, AU: Math.max(au, 1e-6) });
  const mean = kelvin(v.L, v.AU);
  // how far the warmest and coldest times stray: tilt, the length of the day and the lie of the land, damped by the air
  const stray = Math.min(dice.f('stray.most'), clamp(dice.f('tiltFactor', v) + dice.f('rotationFactor', v) + dice.f('geographicFactor', v), 0, 1) / dice.f('atmosphereFactor', v));
  const high = kelvin(v.L * (1 + stray), v.AU * (1 - v.ecc));
  const low = kelvin(v.L * (1 - stray), v.AU * (1 + v.ecc));
  d.temp = { mean: Math.round(mean), high: Math.round(high), low: Math.round(low), albedo: round(albedo, 2), greenhouse: round(greenhouse, 2) };
  Object.assign(v, { K: mean, high, low, albedo, greenhouse });
}

/** Heat from within adds to heat from the sky by fourth powers. */
function addHeat(v: Vars, d: BodyDetail, extra: number): void {
  if (!d.temp || extra <= 0) return;
  const sum = (kelvin: number) => (kelvin ** 4 + extra ** 4) ** 0.25;
  Object.assign(v, { K: sum(v.K), high: sum(v.high), low: sum(v.low) });
  Object.assign(d.temp, { mean: Math.round(v.K), high: Math.round(v.high), low: Math.round(v.low) });
}

// ───────────────────────────── geology, gases, life, worth ─────────────────────────────

function geologyOf(c: Ctx, v: Vars, d: BodyDetail, heating: number): void {
  const { dice } = c;
  const residual = dice.f('seismic.residual', { ...v, DM: dice.dm('seismic', v) });
  const tidal = Math.max(0, dice.f('seismic.tidal', v));
  const total = residual + tidal + Math.max(0, heating);
  v.stress = total;
  d.seismic = { residual, tidal, heating: Math.max(0, heating), total, activity: dice.row(c.rules.activity, total).name };
  if (total > 0 && v.hyd >= 1 && !d.hydro?.liquid) {
    const plates = dice.f('plates', { ...v, DM: dice.dm('plates', v) });
    if (plates > 1) d.seismic.plates = plates;
  }
  addHeat(v, d, total);
}

function gasesOf(c: Ctx, v: Vars, air: Air): void {
  const { dice, rules } = c;
  const kind = rules.atmospheres.find((a) => a.code === air.code)?.kind;
  if (kind === 'air' && air.bar && air.ppo !== undefined) {
    const oxygen = clamp(Math.round((air.ppo / air.bar) * 100), 0, 100);
    air.gases = [{ gas: 'Nitrogen', pct: 100 - oxygen - 1 }, { gas: 'Oxygen', pct: oxygen }].sort((a, b) => b.pct - a.pct);
    return;
  }
  if (kind !== 'exotic' && kind !== 'corrosive' && kind !== 'insidious') return;
  const table = rules.gasMix.find((t) => t.above === undefined || v.K >= t.above);
  if (!table) return;
  const dm = dice.sum(table.dm, v);
  const shares = new Map<string, number>();
  let left = 100;
  for (let n = 0; n < dice.f('gas.rolls') && left > 100 - dice.f('gas.enough'); n++) {
    let gas = dice.row(table.rows, dice.f('gasMix', { DM: dm }))[kind];
    // some gases do not last beside water
    if (gas.endsWith('*')) gas = v.hyd === 0 ? gas.slice(0, -1) : (table.instead ?? gas.slice(0, -1));
    const share = (Math.min(100, dice.f('gas.share')) * left) / 100;
    shares.set(gas, (shares.get(gas) ?? 0) + share);
    left -= share;
  }
  air.gases = [...shares].map(([gas, pct]) => ({ gas, pct: Math.round(pct) })).filter((g) => g.pct >= 1).sort((a, b) => b.pct - a.pct);
}

/** Native life, if any. `force` is for the one unlikely place in a system where something lives after all. */
function lifeOf(c: Ctx, v: Vars, d: BodyDetail, force = false): void {
  const { dice, rules } = c;
  if (c.age <= dice.f('life.minimumAge')) return;
  let biomass = dice.f('biomass', { DM: dice.dm('biomass', v) });
  let complexity: number | undefined;
  if (biomass <= 0) {
    if (!v.life && !force) return;
    biomass = 1;
    if (v.life) complexity = 1;
  }
  biomass += dice.dm('biomassExotic', v);
  v.biomass = biomass;
  complexity ??= dice.f('biocomplexity', { ...v, DM: dice.dm('biocomplexity', v) });
  v.biocomplexity = complexity;
  v.biodiversity = dice.f('biodiversity', v);
  v.compatibility = dice.f('compatibility', { ...v, DM: dice.dm('compatibility', v) });
  const top = rules.complexity[rules.complexity.length - 1];
  d.life = { biomass, complexity, complexityName: (rules.complexity.find((x) => x.code === complexity) ?? (complexity > (top?.code ?? 0) ? top : undefined))?.name, diversity: v.biodiversity, compatibility: v.compatibility };
  if (complexity >= dice.f('sophonts.from')) {
    if (dice.f('sophonts', v)) d.life.sophonts = 'living';
    else if (dice.f('sophonts.extinct', { ...v, DM: dice.dm('sophontsExtinct', v) })) d.life.sophonts = 'extinct';
  }
}

function worthOf(c: Ctx, v: Vars, d: BodyDetail): void {
  d.resources = c.dice.f('resources', { ...v, DM: c.dice.dm('resources', v) });
  d.habitability = c.dice.f('habitability', { DM: c.dice.dm('habitability', v) });
}

/** A belt: how wide, what of, how much, what it is worth, and its largest bodies. */
function beltOf(c: Ctx, layout: SystemLayout, w: WorldInfo, v: Vars, d: BodyDetail, main?: KnownSystem['mainworld']): void {
  const { dice, rules } = c;
  const mates = layout.worlds.filter((o) => o.group === w.group && !o.anomaly).sort((a, b) => a.orbit - b.orbit);
  const at = mates.indexOf(w);
  v.giantNext = [mates[at - 1], mates[at + 1]].some((o) => o?.kind === 'gasGiant') ? 1 : 0;
  v.outermost = at === mates.length - 1 ? 1 : 0;
  if (!(v.spread > 0)) v.spread = dice.f('belt.spread');
  const span = dice.f('belt.span', { ...v, DM: dice.dm('beltSpan', v) });
  const mix = dice.row(rules.beltComposition, dice.d(2) + dice.dm('beltComposition', v));
  let m = Math.max(0, dice.roll(mix.m));
  let s = Math.max(0, dice.roll(mix.s));
  const cc = Math.max(0, dice.roll(mix.c));
  // more than the whole: the metal gives way first, then the stone
  let over = m + s + cc - 100;
  if (over > 0) {
    const cut = Math.min(m, over);
    m -= cut;
    over -= cut;
    s -= Math.min(s, over);
  }
  Object.assign(v, { m, s, c: cc, span });
  const bulk = dice.f('belt.bulk', { DM: dice.dm('beltBulk', v) });
  v.bulk = bulk;
  let resources = dice.f('belt.resources', { ...v, DM: dice.dm('beltResources', v) });
  // a belt that industry has been working is the poorer for it
  if (main?.industrial && (main.tl ?? 0) >= dice.f('belt.exploitedTl')) resources -= dice.f('belt.exploited');
  const size1 = Math.max(0, dice.f('belt.size1', { ...v, DM: dice.dm('beltSize1', v) }));
  let sizeS = Math.max(0, dice.f('belt.sizeS', { ...v, DM: dice.dm('beltSizeS', v) }));
  if (span < dice.f('belt.narrow')) sizeS = Math.ceil(sizeS / 2);
  d.belt = { span: figures(span, 2), m, s, c: cc, other: Math.max(0, 100 - m - s - cc), bulk, resources: clamp(resources, dice.f('belt.resources.least'), dice.f('belt.resources.most')), size1, sizeS };
  d.resources = d.belt.resources;
}

// ───────────────────────────── the whole system ─────────────────────────────

const sah = (size: string, d: BodyDetail) => `${size}${ehexChar(Math.max(0, d.atm?.code ?? 0))}${ehexChar(d.hydro?.code ?? 0)}`;

/**
 * Works out every world, moon and belt of a surveyed system in detail, writing the result on to the
 * layout. A mainworld the listing describes keeps its size, air and water. Moons that their world
 * cannot hold are removed (the first leaves a ring).
 */
export function detailSystem(world: WorldRules, rng: Rng, layout: SystemLayout, known?: KnownSystem): void {
  if (!world.system || !world.detail) return;
  const c: Ctx = { dice: new Dice(world.detail, rng), sys: new Dice(world.system, rng), rules: world.detail, age: Math.max(layout.age, 0.001) };
  const { dice } = c;
  const kindOf = (d: BodyDetail) => c.rules.atmospheres.find((a) => a.code === d.atm?.code)?.kind;
  const unlikely: { v: Vars; d: BodyDetail }[] = [];

  /** Air, water and the first cut of its days, for a rocky world or moon. */
  const surface = (v: Vars, d: BodyDetail, main?: KnownSystem['mainworld']) => {
    airOf(c, v, d, main?.atm);
    waterOf(c, v, d, main?.hydro);
    if (kindOf(d) === 'unusual') unusualOf(c, v, d.atm!);
    spinOf(c, v, d, false);
  };
  /** Climate, geology, gases, life and worth, once the day is settled. */
  const finish = (v: Vars, d: BodyDetail, heating: number, likely: boolean) => {
    climateOf(c, v, d);
    geologyOf(c, v, d, heating);
    gasesOf(c, v, d.atm!);
    liquidOf(c, v, d);
    if (likely) lifeOf(c, v, d);
    else unlikely.push({ v, d });
    worthOf(c, v, d);
  };

  for (const w of layout.worlds) {
    const main = w.mainworld ? known?.mainworld : undefined;
    const d: BodyDetail = {};
    const v = blank(c, layout, w);
    w.detail = d;
    if (w.kind === 'belt') {
      beltOf(c, layout, w, v, d, main);
      continue;
    }
    v.size = w.giant ? 0 : w.sizeValue;
    if (w.giant) giantFigures(c, v, d, w.giant);
    else sizeFigures(c, v, d, false);
    placeMoons(c, w, v);
    placeRings(c, w, d);
    const yearHours = w.period * HOURS_PER_YEAR;
    const listed = w.moons.filter((m): m is MoonInfo & { detail: BodyDetail } => !!m.detail?.moon);
    v.moons = listed.length;
    v.moonSizes = listed.reduce((n, m) => n + (m.giant ? 0 : Math.max(0, m.sizeValue)), 0);

    // ── its moons first: their size and their hold on the world bear on it ──
    const held: { moon: MoonInfo; v: Vars }[] = [];
    for (const moon of listed) {
      const md = moon.detail;
      const place = md.moon!;
      const mv: Vars = { ...v, moon: 1, giant: 0, size: moon.giant ? 0 : moon.sizeValue, pd: place.pd, pmass: v.mass, retro: place.retro ? 1 : 0, Mkm: place.km / 1e6, days: place.hours / 24, moons: 0, moonSizes: 0, MOR: v.MOR, DIA: 0 };
      if (moon.giant) {
        giantFigures(c, mv, md, moon.giant);
        mv.atm = -1;
        spinOf(c, mv, md, true);
        settleDay(mv, md, yearHours);
        climateOf(c, mv, md);
        addHeat(mv, md, dice.f('giantHeat', mv));
        continue;
      }
      sizeFigures(c, mv, md, false);
      surface(mv, md);
      // a moon nearly always keeps one face to its world
      const full = applyLock(c, md, lockRow(c, dice.dm('lock', { ...mv, ecc: place.ecc ?? 0, tilt: md.day!.tilt }) + dice.dm('lockMoon', mv)), place.hours, 'planet');
      // (and one that turns more slowly than it circles is held all the same)
      if (!full && Math.abs(md.day!.hours) > place.hours) hold(c, md, place.hours, 'planet');
      if (md.day!.lock === 'planet') {
        if ((place.ecc ?? 0) > dice.f('lock.eccAbove')) place.ecc = Math.min(place.ecc ?? 0, rollEccentricity(c.sys, { star: 0, extraStars: 0, orbit: 9, age: c.age, beltBody: 0, proto: 0, primordial: 0 }, dice.f('lock.eccDm')));
        held.push({ moon, v: mv });
      }
      settleDay(mv, md, yearHours);
      // tides: its sun always, its world too unless it is locked to it
      mv.tide = dice.f('tide.star', mv) + (md.day!.lock === 'planet' ? 0 : dice.f('tide.body', { ...mv, mass: v.mass }));
      md.tide = figures(mv.tide, 2);
      let heating = dice.f('seismic.heating', { ...mv, ecc: place.ecc ?? 0 });
      const most = dice.f('seismic.heatingMost');
      if (heating > most) {
        // so much heat is the moon's own orbit being worn round: it is taken as far rounder already
        place.ecc = figures((place.ecc ?? 0) * Math.sqrt(most / heating), 2);
        heating = most;
      }
      finish(mv, md, heating, kindOf(md) === 'air');
      md.sah = sah(moon.size, md);
    }

    // ── then the world itself ──
    if (w.giant) {
      v.atm = -1;
      spinOf(c, v, d, true);
      applyLock(c, d, lockRow(c, dice.dm('lock', { ...v, tilt: d.day!.tilt }) + dice.dm('lockStar', v)), yearHours, 'star');
      settleDay(v, d, yearHours);
      climateOf(c, v, d);
      addHeat(v, d, dice.f('giantHeat', v));
      continue;
    }
    surface(v, d, main);
    const all = dice.dm('lock', { ...v, tilt: d.day!.tilt });
    const star = all + dice.dm('lockStar', v);
    // only a moon that is itself held by the world can hold the world in turn
    const pulls = held.map((h) => ({ ...h, dm: all + dice.dm('lockPlanet', { ...v, msize: h.moon.sizeValue, pd: h.moon.detail!.moon!.pd }) })).sort((a, b) => b.dm - a.dm);
    const lockedTo = pulls[0] && pulls[0].dm >= star ? pulls[0] : undefined;
    if (lockedTo) applyLock(c, d, lockRow(c, lockedTo.dm), lockedTo.moon.detail!.moon!.hours, 'moon');
    else if (applyLock(c, d, lockRow(c, star), yearHours, 'star') && w.ecc > dice.f('lock.eccAbove')) {
      w.ecc = Math.min(w.ecc, rollEccentricity(c.sys, { star: 0, extraStars: Math.max(0, w.starCount - 1), orbit: w.orbit, age: c.age, beltBody: 0, proto: 0, primordial: 0 }, dice.f('lock.eccDm')));
      v.ecc = w.ecc;
    }
    settleDay(v, d, yearHours);
    v.tide = (d.day!.lock === 'star' ? 0 : dice.f('tide.star', v)) + listed.reduce((n, m) => n + (d.day!.lock === 'moon' && m === lockedTo?.moon ? 0 : dice.f('tide.body', { ...v, mass: m.detail.mass ?? 0, Mkm: m.detail.moon!.km / 1e6 })), 0);
    d.tide = figures(v.tide, 2);
    finish(v, d, 0, !!main || kindOf(d) === 'air');
    d.sah = sah(w.size, d);
  }

  // somewhere unlikely, once in a long while, something lives
  if (unlikely.length && dice.f('life.unlikely')) {
    const { v, d } = dice.pick(unlikely);
    lifeOf(c, v, d, true);
    if (d.life) worthOf(c, v, d);
  }
}
