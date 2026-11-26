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

export interface TradeGood {
  /** D66 code on the trade goods table. */
  code: number;
  name: string;
  /** Trade codes of worlds where the good is found; "*" means everywhere. */
  availability: string[];
  /** Tons on offer: dice x multiplier. */
  tons: { dice: number; mult: number };
  basePrice: number;
  /** Modifiers by trade code, or "Amber"/"Red" for travel zones. */
  purchaseDm: Record<string, number>;
  saleDm: Record<string, number>;
  examples?: string;
  illegal?: boolean;
  /** Handled through play, not the trade rules. */
  exotic?: boolean;
}

export interface TrafficWorldDm {
  pop?: RangeDm[];
  starport?: Record<string, number>;
  tl?: RangeDm[];
  zone?: Record<string, number>;
}

export interface TradeRules {
  goods: TradeGood[];
  /** Price as a percentage of base price for each modified roll (clamped at both ends). */
  modifiedPrice: { result: number; purchase: number; sale: number }[];
  priceRoll: { dice: number; opposingBroker: number };
  quantity: { lowPopMax: number; lowPopDm: number; highPopMin: number; highPopDm: number };
  supplier: { starportDm: Record<string, number>; repeatDm: number; checks: { name: string; skill: string; chars: string[]; target: number; time: string; blackMarket?: boolean; minTl?: number }[] };
  localBroker: { skillDice: number; skillDivisor: number; negotiationDm: number; fee: number; illegalFee: number };
  passage: { parsecs: number; high: number; middle: number; basic: number; low: number; freight: number }[];
  passengerTraffic: { table: { max: number; dice: number }[]; classDm: Record<string, number>; worldDm: TrafficWorldDm; perExtraParsec: number; checkSkills: string[] };
  freightTraffic: { table: { max: number; dice: number }[]; lots: Record<string, { dm: number; dice: number; mult: number }>; worldDm: TrafficWorldDm; perExtraParsec: number; checkSkills: string[]; latePenalty: string };
  mail: { target: number; tonsPerContainer: number; payPerContainer: number; containers: { dice: number }; armedDm: number; lowTlMax: number; lowTlDm: number; freightDmBands: { max: number; dm: number }[] };
}

// ───────────────────────────── spacecraft ─────────────────────────────

export interface HullConfigDef {
  id: string;
  name: string;
  streamlined: 'full' | 'partial' | 'none';
  /** Multiplier on the basic hull cost and on Hull points. */
  costMult: number;
  hullMult: number;
  /** Fuel scoops come with the hull. */
  fuelScoop?: boolean;
  noArmour?: boolean;
  note?: string;
}

/** An option on a hull, bridge or computer. `costAdd` is a fraction added to the base cost. */
export interface PartOptionDef {
  id: string;
  name: string;
  tl?: number;
  costAdd?: number;
  costMult?: number;
  hullMult?: number;
  /** Bridges: use the size this many rows up or down the table. */
  sizeStep?: number;
  /** Computers: extra Processing for Jump Control software. */
  jumpBonus?: number;
  suffix?: string;
  note?: string;
}

export interface ShipArmourDef {
  id: string;
  name: string;
  tl: number;
  /** Per point of protection: percentage of hull tonnage and of hull cost. */
  tonsPct: number;
  costPct: number;
  /** Protection cannot exceed the design's TL, and/or a flat cap. */
  maxByTl?: boolean;
  max?: number;
}

export interface DriveRules {
  /** Percentage of the hull per point of rating. */
  tonsPct: number;
  plusTons?: number;
  minTons?: number;
  costPerTon: number;
  /** Power needed: this percentage of hull tonnage per point of rating. */
  powerPct: number;
  /** Fuel per jump: this percentage of hull tonnage per parsec. */
  fuelPct?: number;
  /** Smallest hull that can carry the drive. */
  minHull?: number;
  /** Minimum TL for rating 1, 2, 3... */
  tl: number[];
}

export interface PlantDef {
  id: string;
  name: string;
  tl: number;
  powerPerTon: number;
  costPerTon: number;
}

export interface BridgeTypeDef {
  id: string;
  name: string;
  /** Largest hull it can be fitted to. */
  maxHull?: number;
  /** Fixed size and cost; a bridge without these is sized from the table. */
  tons?: number;
  cost?: number;
  seats?: number;
  note?: string;
}

export interface ShipComputerDef {
  id: string;
  name: string;
  tl: number;
  processing: number;
  cost: number;
}

export interface ShipSensorDef {
  id: string;
  name: string;
  tl: number;
  dm: number;
  power: number;
  tons: number;
  cost: number;
  suite?: string;
  /** Every ship has this grade without fitting anything. */
  included?: boolean;
}

export interface ShipSoftwareDef {
  id: string;
  name: string;
  /** Programs of one family supersede each other by level. */
  family: string;
  level: number;
  tl: number;
  bandwidth: number;
  cost: number;
  included?: boolean;
  effect?: string;
}

export interface MountDef {
  id: string;
  name: string;
  tl: number;
  power: number;
  tons: number;
  cost: number;
  /** Weapons it can carry (fewer on small craft where `smallCraftSlots` is set). */
  slots: number;
  smallCraftSlots?: number;
  /** Can be fitted to a small craft's firmpoint. */
  firmpoint?: boolean;
  /** Only takes weapons whose `mount` matches. */
  accepts?: string;
  gunner?: boolean;
  note?: string;
}

export interface ShipWeaponDef {
  id: string;
  name: string;
  tl: number;
  range: string;
  power: number;
  damage: string;
  cost: number;
  traits: string[];
  /** Needs a mount that `accepts` this value. */
  mount?: string;
  ammo?: string;
  defensive?: boolean;
}

/**
 * A fitting from the catalogue. `size` says how it is dimensioned:
 *  - unit: `qty` copies of fixed size;
 *  - tons: the designer picks a tonnage;
 *  - hull: a percentage of the hull;
 *  - docking: sized from the tonnage of the craft carried (`rating`).
 */
export interface FittingDef {
  id: string;
  name: string;
  group: string;
  size: 'unit' | 'tons' | 'hull' | 'docking';
  tl?: number;
  unitTons?: number;
  unitCost?: number;
  unitPower?: number;
  unitLabel?: string;
  costPerTon?: number;
  powerPerTon?: number;
  minTons?: number;
  maxHullPct?: number;
  /** Tons-sized fittings that need equipment per so many tons (rounded up). */
  stepTons?: number;
  costPerStep?: number;
  powerPerStep?: number;
  perTonLabel?: string;
  perTonValue?: number;
  hullPct?: number;
  costPerHullTon?: number;
  powerPerHullTon?: number;
  dockingPct?: number;
  /** People it accommodates. */
  berths?: number;
  lowBerths?: number;
  seats?: number;
  passage?: 'high';
  /** Only one may be fitted. */
  single?: boolean;
  /** Free when the hull configuration has this flag. */
  builtInWhen?: string;
  /** Useless on a hull that cannot enter atmosphere. */
  needsAtmosphere?: boolean;
  note?: string;
}

export interface StockDesign {
  id: string;
  name: string;
  type?: string;
  tl: number;
  hull: { tons: number; config: string; options?: string[] };
  outline?: string;
  crew?: string;
  /** Figures printed with the design, for reference. */
  listed?: { cost: number; hull?: number; cargo?: number };
  noDiscount?: boolean;
  summary?: string;
  note?: string;
  parts: Omit<import('./types').DesignPart, 'id'>[];
}

export interface ShipyardDef {
  smallCraft: boolean;
  ships: boolean;
  jump: boolean;
  label: string;
}

export interface ShipRules {
  hull: {
    costPerTon: number;
    tonsPerHullPoint: number;
    minTons: number;
    maxTons: number;
    sizes: number[];
    /** Hulls below this tonnage are small craft. */
    smallCraftBelow: number;
    buildDaysPerMCr: number;
    selfSealingTl?: number;
    configurations: HullConfigDef[];
    options: PartOptionDef[];
  };
  armour: ShipArmourDef[];
  mdrive: DriveRules;
  jdrive: DriveRules;
  plants: PlantDef[];
  power: { basicPct: number };
  fuel: { plantPct: number; plantMinTons: number; plantWeeks: number };
  bridge: {
    sizes: { maxHull: number; tons: number }[];
    costPer100Tons: number;
    types: BridgeTypeDef[];
    options: PartOptionDef[];
  };
  computers: ShipComputerDef[];
  computerOptions: PartOptionDef[];
  sensors: ShipSensorDef[];
  software: ShipSoftwareDef[];
  mounts: MountDef[];
  weapons: ShipWeaponDef[];
  hardpoints: { perTons: number; firmpoints: { maxHull: number; points: number }[]; firmpointNote?: string };
  fittings: FittingDef[];
  crew: {
    roles: { id: string; name: string; salary: number }[];
    engineerPerTons: number;
    medicPerPeople: number;
    stewardPerHigh: number;
    stewardPerMiddle: number;
    skillBonusPct?: number;
  };
  costs: { standardDiscountPct: number; maintenanceDivisor: number };
  /** Keyed by the starport table's `shipyard` value. */
  shipyards: Record<string, ShipyardDef>;
  usedShips?: { roll: [number, number]; age: string; discountPct: number; quirks: number }[];
  designs: StockDesign[];
}

// ───────────────────────────── space combat ─────────────────────────────

export type BattleStep = 'manoeuvre' | 'attack' | 'actions';

export interface SpaceRange {
  id: string;
  name: string;
  distance: string;
  /** Thrust needed to move one band from here, closer or further. */
  thrust: number;
  attackDm?: number;
  /** Ships this close fight by the dogfighting rules instead. */
  dogfight?: boolean;
  example?: string;
}

export interface SpaceDuty {
  id: string;
  name: string;
  /** Only one crew member can hold it. */
  single?: boolean;
  skill?: string;
  /** Held at a particular turret or barbette. */
  mount?: boolean;
  note: string;
}

export interface SpaceAction {
  id: string;
  name: string;
  /** Duty id, or "any". */
  duty: string;
  step: BattleStep | 'reaction';
  check?: { skill: string; target: number; char?: string };
  /** Takes a variable amount of Thrust (`thrust`) or a fixed amount (`thrustCost`). */
  thrust?: boolean;
  thrustCost?: number;
  /** Is aimed at another ship, a weapon mount, a salvo in flight or a damaged location. */
  target?: boolean;
  weapon?: boolean;
  salvo?: boolean;
  location?: boolean;
  repair?: boolean;
  lock?: boolean;
  initiative?: boolean;
  note: string;
}

/** What a critical hit of one severity does. `text` is for the crew; the rest is applied automatically. */
export interface CriticalEffect {
  text: string;
  damageDice?: number;
  armourLoss?: number;
  armourLossD3?: number;
  armourLossDice?: number;
  powerLossPct?: number;
  fuelLossPct?: number;
  fuelLossDicePct?: number;
  thrustLoss?: number;
  thrustZero?: boolean;
  jumpDisabled?: boolean;
  /** Raises the severity of the Hull location by this much, or by this many dice. */
  hullSeverity?: number;
  hullSeverityDice?: number;
}

export interface SpaceRules {
  roundMinutes: number;
  steps: { id: BattleStep; name: string; note: string }[];
  initiative: { note: string };
  ranges: SpaceRange[];
  attack: {
    target: number;
    skill: string;
    char: string;
    pilotFiringDm: number;
    targetSizeTons: number;
    targetSizeMaxDm: number;
    sensorLockDm: number;
    calledShotDm: number;
    calledShotMaxRange: string;
    /** DM by weapon id. */
    weaponDm: Record<string, number>;
    extraWeaponPerDie: number;
    /** Weapons whose damage is multiplied once armour has been taken off. */
    afterArmourMultiplier: Record<string, number>;
  };
  duties: SpaceDuty[];
  actions: SpaceAction[];
  criticals: {
    effectAtLeast: number;
    severityOffset: number;
    /** A Severity 1 critical for every this-much percent of starting Hull lost. */
    sustainedPct: number;
    maxSeverity: number;
    /** Dice of damage when a location already at maximum severity is hit again. */
    overflowDice: number;
    locations: { roll: number; id: string; name: string }[];
    effects: Record<string, CriticalEffect[]>;
  };
  repair: { baseTarget: number; lastsHoursDice: number; note: string };
  missiles: { perTurret: number; refillCost: number; flight: { range: string; rounds: number }[]; maxRounds: number; dmPerMissile: number; distantDm: number; note: string };
  sand: { perTurret: number; refillCost: number };
  scale?: Record<string, number>;
  dogfight?: { note: string };
}

export interface RulePack {
  packs: PackMeta[];
  world?: WorldRules;
  tasks?: TaskRules;
  characters?: CharacterRules;
  gear?: GearRules;
  combat?: CombatRules;
  trade?: TradeRules;
  ships?: ShipRules;
  space?: SpaceRules;
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
