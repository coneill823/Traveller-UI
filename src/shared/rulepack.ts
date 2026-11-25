/**
 * Shape of a rules pack. The app's engines are generic; every table, price and threshold that
 * comes from a rulebook lives in JSON packs loaded at run time (see /rulepacks). Packs can be
 * layered, so house rules or supplements only need to list what they add or change.
 */

export interface PackMeta {
  id: string;
  name: string;
  version?: string;
  note?: string;
}

export interface DiceFormula {
  /** Number of six-sided dice. */
  dice: number;
  /** Flat modifier. */
  mod?: number;
  /** Name of another generated value to add (e.g. "size"). */
  add?: string;
  min?: number;
  max?: number;
}

/** Inclusive range or explicit list of digit values a world must have. */
export interface DigitRule {
  min?: number;
  max?: number;
  any?: number[];
}

export interface TradeCodeDef {
  code: string;
  name: string;
  note?: string;
  size?: DigitRule;
  atm?: DigitRule;
  hydro?: DigitRule;
  pop?: DigitRule;
  gov?: DigitRule;
  law?: DigitRule;
  tl?: DigitRule;
}

export interface StarportDef {
  quality: string;
  /** Weekly berthing cost: dice x multiplier credits. */
  berthing: { dice: number; mult: number } | null;
  fuel: 'Refined' | 'Unrefined' | 'None';
  shipyard: 'all' | 'spacecraft' | 'smallcraft' | 'none';
  repair: 'full' | 'limited' | 'none';
  /** Base code -> 2D target needed for that base to be present. */
  bases: Record<string, number>;
}

/** A modifier that applies when a digit falls in a range. */
export interface RangeDm extends DigitRule {
  dm: number;
}

export interface WorldRules {
  size: { code: number; diameter: string; gravity: string; example?: string }[];
  atmosphere: { code: number; name: string; pressure?: string; gear?: string; tainted?: boolean }[];
  hydrographics: { code: number; range: string; name: string }[];
  population: { code: number; name: string; range: string; note?: string }[];
  government: { code: number; name: string; note?: string; contraband?: string[] }[];
  law: { code: number; weapons: string; armour?: string }[];
  techLevel: { code: number; name: string; note?: string }[];
  starport: Record<string, StarportDef>;
  bases: { code: string; name: string; note?: string }[];
  zones: { code: string; name: string; note?: string }[];
  temperature: { max: number; name: string; range: string; note?: string }[];
  tradeCodes: TradeCodeDef[];
  /** Fuel prices per ton. */
  fuelCost: { refined: number; unrefined: number };
  generation: {
    /** 1D roll needed for a hex to contain a system, with modifiers by density name. */
    occurrence: { target: number; density: Record<string, number> };
    /** 2D result at or above which a system has NO gas giant. */
    gasGiantAbsentOn: number;
    rolls: Record<'size' | 'atm' | 'hydro' | 'pop' | 'gov' | 'law' | 'tl', DiceFormula>;
    hydro: { zeroIfSizeAtMost: number; atmDm: RangeDm[]; temperatureDm: Record<string, number> };
    temperatureAtmDm: RangeDm[];
    starportTable: { max: number; class: string }[];
    starportPopDm: RangeDm[];
    techDm: Record<'starport', Record<string, number>> & Record<'size' | 'atm' | 'hydro' | 'pop' | 'gov', Record<string, number>>;
    techMinByAtm: Record<string, number>;
    highportDm: { tl: RangeDm[]; pop: RangeDm[] };
    corsairDm: { law: RangeDm[] };
    /** Conditions suggesting an Amber travel zone. */
    amber: { atm: DigitRule; gov: DigitRule; law: DigitRule };
  };
  tradeRoutes: { maxDistance: number; pairs: { from: string[]; to: string[] }[] };
}

export interface TaskRules {
  difficulties: { name: string; target: number }[];
  defaultTarget: number;
  /** Named bands for a check's Effect (total minus target); the first row whose max is >= the effect applies. */
  effects: { max: number; name: string }[];
  /** Characteristic score -> dice modifier; the first row whose max is >= the score applies. */
  characteristicDm: { max: number; dm: number }[];
  /** DM for attempting a skill the Traveller does not have. */
  unskilledDm: number;
}

export interface SkillDef {
  name: string;
  /** Characteristic most often used with the skill (a default for one-click checks). */
  char?: string;
  specialities?: string[];
  /** Default characteristic per speciality, where it differs from `char`. */
  specialityChar?: Record<string, string>;
  /** Players may add their own specialities (languages, sciences, professions). */
  openSpecialities?: boolean;
  /** 'jack' marks the skill that offsets the unskilled penalty instead of being rolled. */
  special?: 'jack';
}

export interface SpeciesDef {
  id: string;
  name: string;
  /** Characteristic modifiers applied at creation. */
  mods: Record<string, number>;
  /** Metres moved per minor action. */
  movement: number;
  traits: { name: string; note: string }[];
  weapons?: { name: string; skill: string; damage: string; range: WeaponRange }[];
}

export interface CharacterRules {
  characteristics: { id: string; name: string; physical: boolean; optional?: boolean }[];
  maxUnaugmented: number;
  skills: SkillDef[];
  species: SpeciesDef[];
  careers: string[];
  encumbrance: { note: string; overloadDm: number; overloadMultiple: number; wornArmourFraction: number };
  damageOrder: { first: string; then: string[] };
}

/** Effective range in metres, or 'melee'. */
export type WeaponRange = number | 'melee';

export interface WeaponDef {
  id: string;
  name: string;
  group: string;
  /** Skill used to attack, e.g. "Gun Combat (slug)". */
  skill: string;
  tl?: number;
  range: WeaponRange;
  /** Damage dice such as "3D-3", "2DD" (destructive), or "" for none. */
  damage: string;
  kg?: number;
  cost?: number;
  magazine?: number | 'unlimited';
  magazineCost?: number;
  traits?: string[];
  note?: string;
}

export interface ArmourDef {
  id: string;
  name: string;
  protection: number;
  /** Protection against lasers, where it differs. */
  laserProtection?: number;
  tl: number;
  rad?: number;
  kg: number;
  cost: number;
  skill?: { name: string; level: number };
  /** Powered armour carries its own weight. */
  powered?: boolean;
  note?: string;
}

export interface GearRules {
  weapons: WeaponDef[];
  armour: ArmourDef[];
  weaponTraits: { id: string; name: string; note: string }[];
}

export interface CombatRules {
  attackTarget: number;
  roundSeconds: number;
  squareMetres: number;
  closeCombatMetres: number;
  movement: number;
  initiative: { characteristics: string[]; ambushDm: number; note: string };
  range: {
    shortFraction: number;
    longMultiple: number;
    extremeMultiple: number;
    /** Without an aimed scope, anything beyond this many metres counts as extreme range. */
    unscopedExtremeBeyond: number;
    bands: { id: string; name: string; dm: number }[];
  };
  modifiers: { id: string; name: string; dm: number; stack?: number; note?: string }[];
  actions: { id: string; name: string; type: 'significant' | 'minor' | 'free' | 'reaction'; note: string }[];
  turn: { significant: number; minor: number; minorsInsteadOfSignificant: number };
  cover: { name: string; protection: number }[];
  damage: { minimumOnEffect: number; destructiveMultiplier: number; meleeAddsStrDm: boolean };
}

export interface RulePack {
  packs: PackMeta[];
  world?: WorldRules;
  tasks?: TaskRules;
  characters?: CharacterRules;
  gear?: GearRules;
  combat?: CombatRules;
  // Later slices add: skills, gear, trade, ships, combat, spaceCombat.
  [section: string]: unknown;
}

export const EMPTY_PACK: RulePack = { packs: [] };

/**
 * Layers `over` on top of `base`. Objects merge key by key. Arrays of records that carry a
 * `code` or `id` merge by that key (so a supplement can override one row); other arrays replace.
 */
export function mergePacks<T>(base: T, over: T): T {
  if (Array.isArray(base) && Array.isArray(over)) {
    const keyOf = (item: unknown): string | undefined => {
      if (typeof item !== 'object' || item === null) return undefined;
      const rec = item as Record<string, unknown>;
      const key = rec.id ?? rec.code;
      return key === undefined ? undefined : String(key);
    };
    if (base.every((i) => keyOf(i) !== undefined) && over.every((i) => keyOf(i) !== undefined)) {
      const out = new Map<string, unknown>();
      for (const item of base) out.set(keyOf(item)!, item);
      for (const item of over) {
        const key = keyOf(item)!;
        out.set(key, out.has(key) ? mergePacks(out.get(key), item) : item);
      }
      return [...out.values()] as T;
    }
    return over;
  }
  if (typeof base === 'object' && base !== null && typeof over === 'object' && over !== null && !Array.isArray(over)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(over as Record<string, unknown>)) {
      out[key] = key in out ? mergePacks(out[key], value) : value;
    }
    return out as T;
  }
  return over === undefined ? base : over;
}
