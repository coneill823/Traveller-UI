/**
 * Equipment rules: how hard an item is to find on a world, what it costs when built ahead of or
 * behind its tech level, and what special ammunition does to the weapon that fires it.
 * Numbers come from the rules pack.
 */
import type { AmmoEffect, ArmourDef, AvailabilityRules, DmBand, EquipmentDef, GearRules, GearVariant, WeaponDef, WorldRules } from '../rulepack';
import type { CharacterArmour, CharacterWeapon, ItemCategory } from '../types';
import { parseUwp } from '../uwp';
import { parseDamage, traitValue, type DmPart } from './character';
import { systemTradeCodes } from './world';

/** What matters about a world when shopping there. Unknown figures are left out. */
export interface MarketWorld {
  name?: string;
  tl?: number;
  starport?: string;
  population?: number;
  law?: number;
  tradeCodes: string[];
}

/** Reads a system's profile into the figures the availability rules use. */
export function marketWorld(system: { name?: string; uwp?: string; remarks?: string } | undefined, rules: WorldRules | undefined): MarketWorld | undefined {
  if (!system) return undefined;
  const uwp = parseUwp(system.uwp);
  const known = (n: number | undefined) => (n === undefined || n < 0 ? undefined : n);
  return {
    name: system.name,
    tl: known(uwp?.tl),
    starport: uwp && uwp.starport !== '?' ? uwp.starport : undefined,
    population: known(uwp?.pop),
    law: known(uwp?.law),
    tradeCodes: systemTradeCodes(system.uwp, system.remarks, rules),
  };
}

const inBand = (band: DmBand, n: number): boolean => (band.min === undefined || n >= band.min) && (band.max === undefined || n <= band.max);
const signed = (n: number): string => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);

export interface AvailabilityChoice {
  /** Tech level of the item sought. */
  tl?: number;
  /** Ids of the circumstances that apply (see AvailabilityRules.options). */
  options?: string[];
  /** The referee's own modifier. */
  referee?: number;
  /** A prototype or the like: its own modifier is added. */
  variant?: GearVariant;
  /** Buying on the black market: the id of the item's category. */
  blackMarket?: string;
}

export interface AvailabilityResult {
  dm: number;
  parts: DmPart[];
  /** What the price is multiplied by (paying over the odds, black market rates). */
  priceMult: number;
  /** Skills that may be rolled. */
  skills: string[];
  target: number;
  /** Set when the item cannot be had at all. */
  unavailable?: string;
}

/** The modifier for finding an item on a world, with everything that goes into it. */
export function availability(rules: AvailabilityRules | undefined, world: MarketWorld | undefined, choice: AvailabilityChoice = {}): AvailabilityResult {
  const parts: DmPart[] = [];
  let priceMult = 1;
  if (!rules) return { dm: 0, parts, priceMult, skills: [], target: 8 };
  const market = choice.blackMarket ? rules.blackMarket : undefined;
  const category = market?.categories.find((c) => c.id === choice.blackMarket);
  const out: AvailabilityResult = { dm: 0, parts, priceMult, skills: market ? market.skills : rules.check.skills, target: rules.check.target };

  if (world) {
    if (world.population === 0) out.unavailable = 'Nothing is for sale on a world without people.';
    if (choice.tl !== undefined && world.tl !== undefined) {
      const gap = choice.tl - world.tl;
      for (const band of rules.tlAbove) if (gap > 0 && inBand(band, gap)) parts.push({ label: band.name ?? `TL${choice.tl} on a TL${world.tl} world`, dm: band.dm });
    }
    if (world.starport && rules.starport[world.starport]) parts.push({ label: `Class ${world.starport} starport`, dm: rules.starport[world.starport] });
    for (const row of rules.tradeCodes) {
      const have = row.codes.filter((c) => world.tradeCodes.includes(c));
      if (have.length) parts.push({ label: have.join(', '), dm: row.dm });
    }
    if (world.population !== undefined) for (const band of rules.population) if (inBand(band, world.population)) parts.push({ label: band.name ?? `Population ${world.population}`, dm: band.dm });
    if (market && category && world.law !== undefined) for (const band of market.lawLevel) if (inBand(band, world.law) && band.dm) parts.push({ label: band.name ?? `Law level ${world.law}`, dm: band.dm });
  }
  if (category) {
    if (category.dm) parts.push({ label: category.name, dm: category.dm });
    priceMult *= category.priceMult;
  }
  const chosen = new Set(choice.options ?? []);
  for (const option of rules.options) {
    if (!chosen.has(option.id)) continue;
    if (option.excludes?.some((id) => chosen.has(id) && rules.options.findIndex((o) => o.id === id) > rules.options.findIndex((o) => o.id === option.id))) continue;
    parts.push({ label: option.name, dm: option.dm });
    if (option.priceMult) priceMult *= option.priceMult;
  }
  if (choice.variant?.availabilityDm) parts.push({ label: choice.variant.name, dm: choice.variant.availabilityDm });
  if (choice.referee) parts.push({ label: 'Referee', dm: choice.referee });
  out.dm = parts.reduce((n, p) => n + p.dm, 0);
  out.priceMult = priceMult;
  return out;
}

/** Where a roll lands on one of the pack's result tables. */
export function tableResult<T extends { min?: number; max?: number }>(rows: T[] | undefined, value: number): T | undefined {
  return rows?.find((r) => inBand(r as DmBand & T, value));
}

export interface VariantFigures {
  tl?: number;
  kg?: number;
  cost?: number;
  /** How many tech levels were actually applied (retrotech is capped). */
  steps: number;
}

/** How many tech levels of retrotech an item can take; 0 when the variant does not apply to it. */
export function variantSteps(def: { electronic?: boolean | 'computer' }, variant: GearVariant | undefined): number {
  if (!variant?.perTl) return variant ? 1 : 0;
  if (variant.only === 'electronic' && !def.electronic) return 0;
  return def.electronic === 'computer' ? (variant.computerSteps ?? variant.maxSteps ?? 1) : (variant.maxSteps ?? 1);
}

/** Tech level, mass and price of an item in a special version (a prototype, or built at a higher tech level). */
export function variantFigures(def: { tl?: number; kg?: number; cost?: number; electronic?: boolean | 'computer' }, variant: GearVariant | undefined, steps = 1): VariantFigures {
  const out: VariantFigures = { tl: def.tl, kg: def.kg, cost: def.cost, steps: 0 };
  if (!variant) return out;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  if (variant.perTl) {
    const n = Math.max(0, Math.min(Math.floor(steps), variantSteps(def, variant)));
    out.steps = n;
    if (out.tl !== undefined) out.tl += n;
    if (out.cost !== undefined) out.cost = Math.max(1, Math.round(out.cost * variant.perTl.costMult ** n));
    if (out.kg !== undefined) {
      out.kg = round(out.kg * variant.perTl.kgMult ** n);
      // anything under a quarter of a kilogram is too light to count
      if (n > 0 && out.kg < 0.25) out.kg = 0;
    }
    return out;
  }
  const mult = def.electronic && variant.electronic ? variant.electronic : { costMult: variant.costMult ?? 1, kgMult: variant.kgMult ?? 1 };
  out.steps = 1;
  if (out.tl !== undefined && variant.tl) out.tl = Math.max(0, out.tl + variant.tl);
  if (out.cost !== undefined) out.cost = Math.round(out.cost * mult.costMult);
  if (out.kg !== undefined) out.kg = round(out.kg * mult.kgMult);
  return out;
}

/** How an item from the catalogue is filed in an inventory. */
export function equipmentCategory(def: Pick<EquipmentDef, 'kind'>): ItemCategory {
  return def.kind === 'consumable' || def.kind === 'ammunition' ? 'consumable' : 'gear';
}

/** A catalogue entry's name, with its tech level where several entries share the name. */
export function catalogueName(def: { name: string; tl?: number }, all: { name: string }[]): string {
  return def.tl !== undefined && all.filter((d) => d.name === def.name).length > 1 ? `${def.name} (TL${def.tl})` : def.name;
}

/** A catalogue weapon as it goes on a character sheet (the caller gives it an id). */
export function weaponFromDef(def: WeaponDef, gear: GearRules | undefined): Omit<CharacterWeapon, 'id'> {
  return {
    defId: def.id,
    name: catalogueName(def, gear?.weapons ?? []),
    skill: def.skill,
    damage: def.damage,
    range: def.range,
    traits: def.traits,
    magazine: def.magazine,
    ammo: typeof def.magazine === 'number' ? def.magazine : undefined,
    note: def.note,
    tl: def.tl,
    ammoClass: def.ammoClass,
  };
}

/** Catalogue armour as it goes on a character sheet (the caller gives it an id and says whether it is worn). */
export function armourFromDef(def: ArmourDef): Omit<CharacterArmour, 'id' | 'worn'> {
  return {
    defId: def.id,
    name: `${def.name} (TL${def.tl})`,
    protection: def.protection,
    laserProtection: def.laserProtection,
    versus: def.versus,
    rad: def.rad,
    kg: def.kg,
    note: def.note,
    str: def.str,
    dex: def.dex,
    skill: def.skill,
    powered: def.powered,
    slots: def.slots,
  };
}

// ───────────────────────────── special ammunition ─────────────────────────────

/**
 * The kinds of special ammunition a weapon can load, by its class and tech level. A weapon that
 * does not say (one put on a sheet before the catalogue knew) is looked up by the entry it came from.
 */
export function ammoFor(gear: GearRules | undefined, weapon: { ammoClass?: string; tl?: number; defId?: string }): EquipmentDef[] {
  if (!gear?.equipment) return [];
  const def = weapon.ammoClass === undefined && weapon.defId ? gear.weapons.find((w) => w.id === weapon.defId) : undefined;
  const cls = weapon.ammoClass ?? def?.ammoClass;
  if (!cls) return [];
  const tl = weapon.tl ?? def?.tl ?? 99;
  return gear.equipment.filter((e) => {
    if (!e.ammo) return false;
    if (e.tl !== undefined && tl < e.tl) return false;
    return e.ammo.weapons.includes(cls) || (e.ammo.later !== undefined && tl >= e.ammo.later.tl && e.ammo.later.weapons.includes(cls));
  });
}

function formatDamage(dice: number, mod: number, destructive: boolean): string {
  return `${dice}${destructive ? 'DD' : 'D'}${mod > 0 ? `+${mod}` : mod < 0 ? mod : ''}`;
}

/** A weapon as it performs with special ammunition loaded: damage, range and traits adjusted. */
export function withAmmo<T extends Pick<CharacterWeapon, 'damage' | 'range' | 'traits'>>(weapon: T, ammo: AmmoEffect | undefined): T {
  if (!ammo) return weapon;
  const spec = parseDamage(weapon.damage);
  const baseDice = spec?.dice ?? 0;
  let damage = weapon.damage;
  const d = ammo.damage;
  if (d?.none) damage = '';
  else if (d?.set) damage = d.set;
  else if (spec && !spec.half && (d?.dice || d?.perDie)) {
    let dice = Math.max(1, spec.dice + (d.dice ?? 0));
    let mod = spec.mod + (d.perDie ?? 0) * spec.dice;
    let destructive = spec.destructive;
    // a weapon pushed to ten dice or more becomes Destructive and goes no higher
    if (!destructive && dice >= 10) (dice = 1), (mod = 0), (destructive = true);
    damage = formatDamage(dice, mod, destructive);
  }

  const strip = (ammo.strip ?? []).map((t) => t.toLowerCase());
  const named = (t: string) => t.trim().split(/\s+/)[0].toLowerCase();
  let traits = (weapon.traits ?? []).filter((t) => !strip.includes(named(t)));
  const setTrait = (name: string, value: number | undefined) => {
    traits = traits.filter((t) => named(t) !== name.toLowerCase());
    if (value !== undefined && value > 0) traits.push(`${name} ${value}`);
  };
  if (ammo.ap && !strip.includes('ap')) {
    const own = traitValue(weapon.traits, 'AP');
    let ap = own;
    if (ammo.ap.mult !== undefined) ap = Math.round(own * ammo.ap.mult);
    if (ammo.ap.perDie !== undefined) ap += Math.ceil(ammo.ap.perDie * baseDice) * (ammo.ap.beforeBonus && spec?.destructive ? 10 : 1);
    setTrait('AP', ap);
  }
  if (ammo.blast && !strip.includes('blast')) {
    const own = traitValue(weapon.traits, 'Blast');
    let blast: number | undefined = own || undefined;
    if (ammo.blast.set !== undefined) blast = ammo.blast.set;
    else if (ammo.blast.perDie !== undefined) blast = Math.ceil(ammo.blast.perDie * baseDice);
    else if (ammo.blast.mult !== undefined) blast = own ? Math.max(1, Math.round(own * ammo.blast.mult)) : ammo.blast.base;
    setTrait('Blast', blast);
  }
  for (const t of ammo.traits ?? []) if (!traits.some((x) => named(x) === named(t))) traits.push(t);

  let range = weapon.range;
  if (typeof range === 'number' && range > 0) {
    if (ammo.range !== undefined) range = ammo.range;
    else if (ammo.rangePct) range = Math.max(1, Math.round(range * (1 + ammo.rangePct / 100)));
  }
  return { ...weapon, damage, range, traits: traits.length ? traits : undefined };
}

/** The weapon with whatever special ammunition it has loaded applied, looked up in the catalogue. */
export function loadedWeapon<T extends Pick<CharacterWeapon, 'damage' | 'range' | 'traits' | 'load'>>(weapon: T, gear: GearRules | undefined): T {
  if (!weapon.load) return weapon;
  return withAmmo(weapon, gear?.equipment?.find((e) => e.id === weapon.load!.id)?.ammo);
}
