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
  /** Packs this one is layered over, by id. Without it packs layer in the order of their folder names. */
  after?: string[];
}

/**
 * The order in which packs are layered: as given (folder by folder, by name), except that a pack which
 * names others in `after` is moved to come after them. Names of packs that are not installed are ignored,
 * and packs that name each other in a circle keep their given order.
 */
export function packOrder<T extends { id: string; after?: string[] }>(packs: T[]): T[] {
  const present = new Set(packs.map((p) => p.id));
  const placed = new Set<string>();
  const out: T[] = [];
  const waiting = [...packs];
  while (waiting.length) {
    const next = waiting.findIndex((p) => (p.after ?? []).every((id) => id === p.id || !present.has(id) || placed.has(id)));
    const [pack] = waiting.splice(next < 0 ? 0 : next, 1);
    out.push(pack);
    placed.add(pack.id);
  }
  return out;
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
  /** Detailed star systems: stars, orbits, worlds and moons. Without it, systems get a simple layout. */
  system?: SystemRules;
  /** Each world of a system in detail: makeup, air, water, days, climate, geology and life. */
  detail?: DetailRules;
  /** The people of a mainworld in depth, and the lesser settlements of its system. */
  society?: SocietyRules;
}

/** A modifier that applies when a condition holds; `times` multiplies it by a value (per star, per object). */
export interface WhenDm {
  /** A condition in the formula language of `dicex.ts`, e.g. "stars >= 3". */
  when: string;
  dm: number;
  times?: string;
}

/** A figure for each luminosity class (in the order of `SystemRules.classes`) of one star type, "G5". */
export interface StarRow {
  type: string;
  v: (number | null)[];
}

/** A row chosen by a roll: the first row whose `max` is not below the roll applies. */
export interface RollRow {
  max: number;
}

/**
 * Tables and formulas for generating a star system. Formulas are strings in the language of
 * `dicex.ts`; the names each may use are listed in `src/shared/rules/system.ts`.
 */
export interface SystemRules {
  /** Distance in AU of each whole orbit number, from 0 upward. */
  orbits: number[];
  /** Luminosity classes, brightest first. */
  classes: string[];
  starTables: {
    /** Results for 2D rolls of 2 to 12 in each column of the star type table. */
    types: Record<'type' | 'hot' | 'special' | 'unusual' | 'giants' | 'peculiar', string[]>;
    /** Numeric subtype for 2D rolls of 2 to 12; `mPrimary` for a primary of type M. */
    subtype: { numeric: number[]; mPrimary: number[] };
    temperature: { type: string; k: number }[];
    mass: StarRow[];
    diameter: StarRow[];
    /** The closest orbit a world can keep. */
    mao: StarRow[];
    brownDwarfs: { type: string; mass: number; k: number; diameter: number }[];
    whiteDwarfCooling: { gyr: number; k: number }[];
  };
  /** Limits on the spectral types of some classes. */
  limits: Record<string, { remap?: Record<string, string>; mAdd?: number; coolest?: string; subtractAbove?: { type: string; above: number; by: number }; fallback?: string }>;
  /** How another star's type follows from its parent, for 2D rolls of 2 to 12. */
  nonPrimary: Record<'secondary' | 'companion' | 'postStellar' | 'other', string[]>;
  /** Where the other stars of an already listed system sit, by 1D. */
  knownPlaces: { binary: string[]; multiple: string[] };
  eccentricity: (RollRow & { value: string })[];
  quantities: Record<'gasGiants' | 'belts' | 'emptyOrbits' | 'anomalousOrbits', (RollRow & { n: number })[]>;
  anomalies: (RollRow & { kind: string; eccDm: number })[];
  /** The habitable zone: deviation from its centre for each raw temperature roll. */
  zones: { raw: number; deviation: number; name: string }[];
  sizes: {
    terrestrial: (RollRow & { roll: string })[];
    gasGiant: (RollRow & { code: string; name: string; diameter: string; mass: string; heavyFrom?: number; heavy?: string })[];
    moonCount: { sizes?: number[]; code?: string; roll: string; dice: number }[];
    moon: (RollRow & { size?: string; roll?: string; giant?: boolean })[];
    giantMoon: (RollRow & { roll: string; giantAt?: number })[];
  };
  dm: Record<string, WhenDm[]>;
  f: Record<string, string | number>;
}

/** The air a table gives a world outright: its code, and for exotic air how thick it is and whether it irritates. */
export interface AtmosphereResult {
  atm: number;
  density?: string;
  /** Dense or thicker. */
  thick?: boolean;
  irritant?: 'yes' | 'maybe';
  /** Close enough to its star for a further check on what is left of the air. */
  furnace?: boolean;
}

/** A subtype of exotic, corrosive or insidious air. Pressure is `min` plus part of `span`, or the `bar` formula. */
export interface AtmosphereSubtype extends RollRow {
  code: string;
  name: string;
  density: string;
  irritant?: boolean;
  /** Corrosive at times: a standing irritant of the worst kind. */
  attimes?: boolean;
  min?: number;
  span?: number;
  bar?: string;
  /** Far thicker than any air to breathe. */
  extreme?: boolean;
  /** A hazard (by code) an insidious atmosphere of this subtype always has. */
  hazard?: string;
}

/**
 * Tables and formulas for detailing a world. Formulas are strings in the language of `dicex.ts`;
 * the names each may use are listed in `src/shared/rules/worlddetail.ts`.
 */
export interface DetailRules {
  /** What a world is made of, by 2D and modifiers, and the density (Earth = 1) of each for 2D rolls of 2 to 12. */
  composition: (RollRow & { id: string; name: string })[];
  density: Record<string, number[]>;
  /** Belts: shares of metallic, stony and icy bodies by 2D and modifiers, and the density column each kind uses. */
  beltComposition: (RollRow & { m: string; s: string; c: string })[];
  beltDensity: { m: string; s: string; c: string };
  /** Where a moon circles, by 1D and modifiers: the band, its distance in planetary diameters, and the modifier to its eccentricity. */
  moonOrbit: (RollRow & { range: string; pd: string; eccDm: number })[];
  /**
   * Atmosphere codes from 0 upward. `kind` is none, trace, air (nitrogen and oxygen), exotic, corrosive, insidious,
   * unusual or gas. `breathable` air is spoiled only by its oxygen or a taint; `taintOn` is a roll for whether
   * other air is tainted.
   */
  atmospheres: { code: number; name: string; kind: string; min?: number; span?: number; breathable?: boolean; tainted?: boolean; taintOn?: string; gear?: string }[];
  /** Air outside the habitable zone: bands of distance from its centre (hotter is negative), each with results for rolls of 0 upward. */
  zoneAtmospheres: { min?: number; max?: number; rows: AtmosphereResult[] }[];
  /** What a world very close to its star keeps of its air, by 1D and modifiers; no `atm` leaves it as it was. */
  furnace: (RollRow & { atm?: number })[];
  subtypes: { exotic: AtmosphereSubtype[]; corrosive: AtmosphereSubtype[] };
  /** Standing hazards of insidious air; `life` means something lives there. */
  hazards: (RollRow & { code: string; name: string; life?: boolean })[];
  /** Unusual atmospheres by a two-dice code (tens then units); `when` is what the world must be like, `combine` asks for two others. */
  unusual: { roll: number; code: string; name: string; when?: string; bar?: string; combine?: boolean }[];
  /**
   * Taints by 2D and modifiers. `again` adds another roll; `oxygen` marks too little or too much of it, read as the
   * taint coded `otherwise` where oxygen is not the question; `coldAs` is the taint it becomes on a cold world;
   * `life` means something lives there.
   */
  taints: (RollRow & { code: string; name: string; again?: boolean; oxygen?: 'low' | 'high'; otherwise?: string; coldAs?: string; life?: boolean })[];
  severity: (RollRow & { code: number; name: string })[];
  persistence: (RollRow & { code: number; name: string })[];
  /** What the air becomes when a greenhouse runs away, by 1D and modifiers. */
  greenhouseCodes: (RollRow & { atm: number })[];
  /** Gas mixes, hottest table first: use the first whose `above` (kelvin) the world's mean temperature reaches. A gas ending in * needs a dry world. */
  gasMix: { above?: number; instead?: string; dm: WhenDm[]; rows: (RollRow & { exotic: string; corrosive: string; insidious: string })[] }[];
  /** Liquids other than water that can fill a sea, with boiling and melting points in kelvin. */
  liquids: { name: string; boil: number; melt: number; abundance: number }[];
  /** Lowest and highest percentage of surface liquid for each hydrographics code. */
  hydroRanges: [number, number][];
  /** How the lesser of land and water is spread, by the roll named in `f`. */
  surface: { roll: number; name: string }[];
  tilt: (RollRow & { roll?: string; extreme?: boolean })[];
  extremeTilt: (RollRow & { roll: string })[];
  /** What tides have done to a world's spin, by 2D and modifiers. */
  tidalLock: (RollRow & { times?: number; days?: string; retro?: boolean; lock?: string })[];
  /** Climate bands of the basic temperature roll. */
  climates: (RollRow & { id: string })[];
  /** Albedo: the first row whose condition holds is rolled (`then` adjusts the result, called A), and every matching addition is added. */
  albedo: { when: string; roll: string; then?: string }[];
  albedoAdd: { when: string; roll: string }[];
  /** Greenhouse: the first row whose condition holds turns the starting factor G into the final one; `R` is rolled first when given. */
  greenhouse: { when: string; R?: string; f: string }[];
  complexity: { code: number; name: string }[];
  /** How restless the ground is, by its total stress. */
  activity: (RollRow & { name: string })[];
  dm: Record<string, WhenDm[]>;
  f: Record<string, string | number>;
}

/** A row with a code and a name; `flag` names a condition that holds when the row is the result. */
export interface CodedRow extends RollRow {
  code: string;
  name: string;
  flag?: string;
}

/** A way of settling something outright where a condition holds: a fixed code, a roll on rows of its own, or a modifier to the usual roll. */
export interface DecideRule {
  when: string;
  code?: string;
  roll?: string;
  rows?: (RollRow & { code: string })[];
  dm?: number;
}

/**
 * Tables and formulas for the people of a world. Formulas are strings in the language of
 * `dicex.ts`; the names each may use are listed in `src/shared/rules/society.ts`.
 */
export interface SocietyRules {
  concentration: (RollRow & { code: number; name: string })[];
  /** Share of people living in towns, by 2D and modifiers; `pct` is a formula. */
  urbanisation: (RollRow & { pct: string })[];
  /** Limits on that share where a condition holds. A least beats a most. */
  urbanLimits: { when: string; least?: string; most?: string }[];
  centralisation: CodedRow[];
  authority: CodedRow[];
  /** The functions of government; `code` matches an authority code, and `flag` is set while its makeup is being settled. */
  functions: { code: string; name: string; flag?: string }[];
  /** How a function is made up, by 2D and modifiers. A `sole` body in authority over a unitary government runs every function. */
  structure: (CodedRow & { sole?: boolean })[];
  structureRules: DecideRule[];
  strength: CodedRow[];
  relations: (RollRow & { code: number; name: string })[];
  justice: CodedRow[];
  uniformity: CodedRow[];
  uniformityRules: DecideRule[];
  /** The branches of law, each with what its levels mean from 0 upward and the list of modifiers it takes. */
  lawParts: { id: string; name: string; dm: string }[];
  lawEffects: Record<string, string[]>;
  /** The modifier a roll of two dice gives a technology sub-level, for rolls of 2 to 12. */
  techModifier: number[];
  /** The least technology that keeps people alive, by the world's air and how liveable it is: the highest that applies. */
  minimumTech: { when: string; tl: number }[];
  /** Technology sub-levels in turn: each from a base, held within bounds (formulas over those before it), with its modifiers. */
  tech: { id: string; name: string; from: string; least: string; most: string; dm: string; zeroWhen?: string }[];
  /** What each level of a field brings, from 0 upward. */
  techSteps: Record<string, string[]>;
  /** Cultural traits in turn; each takes the modifier list of its own name. */
  culture: { id: string; name: string; low: string; high: string }[];
  portModifier: Record<string, number>;
  governmentModifier: number[];
  tradeModifier: Record<string, number>;
  /** The port's bearing on the world trade number, by band of the base figure. */
  wtnPort: (RollRow & { mods: Record<string, number> })[];
  tariffs: (RollRow & { name: string; rate?: string; again?: boolean })[];
  /** The roll needed for a highport, by starport class. */
  highport: Record<string, number>;
  /** Shipping by importance: the first row whose `least` the world reaches. */
  traffic: { least: number; name: string; daily: string; weekly: number }[];
  spaceports: CodedRow[];
  secondaryGovernment: (RollRow & { gov: number })[];
  /** What a lesser settlement is for: what it takes, and the roll (if any) that decides it. `flag` is set when it applies. */
  classes: { code: string; name: string; when: string; on?: string; flag?: string }[];
  captiveLaw: (RollRow & { f: string })[];
  dm: Record<string, WhenDm[]>;
  f: Record<string, string | number>;
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

/** A ready-made bundle of skills and benefits for creating a character quickly: an upbringing or a whole career. */
export interface CharacterPackage {
  id: string;
  kind: 'background' | 'career';
  name: string;
  /** Changes to characteristics. */
  mods?: Record<string, number>;
  /** Skills given and their levels. A name such as "Science (any)" or "Blade or Staff" is for the player to settle. */
  skills: Record<string, number>;
  credits?: number;
  /** For a career: the rank left with. */
  rank?: string;
  /** Whatever else comes with it, in words: gear, contacts, titles. */
  benefits?: string[];
  note?: string;
  source?: string;
}

/** How packages are applied. Every figure is the pack's; without one, that limit or change is not made. */
export interface PackageRules {
  /** The highest level that stacking packages can bring a skill to. */
  skillCap?: number;
  /** Bounds that a package's changes cannot push a characteristic beyond. */
  charMin?: number;
  charMax?: number;
  /** The age a character has reached once a background is taken. */
  backgroundAge?: number;
  /** Years a career adds, as a formula ("3D"), and the length of a term for turning them into terms. */
  careerYears?: string;
  termYears?: number;
}

export interface CharacterRules {
  /**
   * The characteristics, in the order a sheet shows them. Optional ones are on a sheet only once added to it;
   * `start` is the score one is added with: a number, or the id of another characteristic to copy (7 when absent).
   */
  characteristics: { id: string; name: string; physical: boolean; optional?: boolean; start?: number | string; note?: string }[];
  maxUnaugmented: number;
  skills: SkillDef[];
  species: SpeciesDef[];
  careers: string[];
  /** Quick-creation packages, where a pack carries any. */
  packages?: CharacterPackage[];
  packageRules?: PackageRules;
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
  /** Which special ammunition it can take ('pistol', 'rifle', 'shotgun' or 'heavy'); none when absent. */
  ammoClass?: string;
  /** The book it is listed in, for supplements. */
  source?: string;
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
  /** Catalogue section, e.g. "Civilian suits". */
  group?: string;
  /** Protection that only counts against some attacks, in words: "+16 vs. lasers and fire". */
  versus?: string;
  /** Changes to the wearer's STR and DEX while it is worn (for checks and carrying, not for taking damage). */
  str?: number;
  dex?: number;
  /** Slots for modifications (battle dress). */
  slots?: number;
  source?: string;
}

/** How a kind of special ammunition changes the weapon that fires it. */
export interface AmmoEffect {
  /** Multiple of the weapon's ordinary magazine cost. */
  costMult: number;
  /** Weapon classes it is made for; see WeaponDef.ammoClass. */
  weapons: string[];
  /** Further classes it becomes available for at a later tech level. */
  later?: { tl: number; weapons: string[] };
  /** Change to the weapon's range, in percent; or a fixed range in metres. */
  rangePct?: number;
  range?: number;
  damage?: { set?: string; dice?: number; perDie?: number; none?: boolean; special?: boolean };
  /** Armour piercing: so many points per damage die (added to the weapon's own), or a multiple of its own. */
  ap?: { perDie?: number; mult?: number; beforeBonus?: boolean };
  blast?: { set?: number; mult?: number; base?: number; perDie?: number };
  /** Traits gained and lost. */
  traits?: string[];
  strip?: string[];
}

/** Anything in the catalogue that is neither a weapon nor a suit of armour. */
export interface EquipmentDef {
  id: string;
  name: string;
  /** Chapter of the catalogue, and the section within it. */
  group: string;
  section?: string;
  tl?: number;
  /** Where the tech level is not one figure: "TL8+". */
  tlNote?: string;
  /** Mass in kilograms; none means too little to count. */
  kg?: number;
  kgNote?: string;
  cost?: number;
  /** A price that is not a plain figure: "x2 the magazine", "+25% of augment". */
  costNote?: string;
  /** What it does, in a line. */
  effect?: string;
  /** Modification slots it takes (battle dress), or the bandwidth it needs (software). */
  slots?: number;
  bandwidth?: number;
  kind?: 'augment' | 'software' | 'modification' | 'consumable' | 'ammunition';
  /** Computers and electronics get cheaper and lighter when built at a higher tech level. */
  electronic?: boolean | 'computer';
  ammo?: AmmoEffect;
  source?: string;
}

/** A band of values with the modifier it gives. */
export interface DmBand {
  min?: number;
  max?: number;
  dm: number;
  name?: string;
}

export interface TableResult {
  min?: number;
  max?: number;
  name: string;
  note?: string;
}

/** Finding an item for sale: the check, and what a world adds to or takes from it. */
export interface AvailabilityRules {
  check: { skills: string[]; target: number };
  note?: string;
  /** By how many tech levels the item is above the world; every band that fits applies. */
  tlAbove: DmBand[];
  /** By starport class. */
  starport: Record<string, number>;
  tradeCodes: { codes: string[]; dm: number }[];
  population: DmBand[];
  /** Circumstances the buyer or the referee chooses. */
  options: { id: string; name: string; dm: number; priceMult?: number; excludes?: string[] }[];
  referee?: { min: number; max: number };
  blackMarket?: {
    skills: string[];
    note?: string;
    lawLevel: DmBand[];
    categories: { id: string; name: string; dm: number; priceMult: number; examples?: string }[];
    attention?: { effect: number; roll: string; results: TableResult[] };
    sentencing?: { roll: string; note?: string; results: TableResult[] };
  };
}

/** An item built ahead of or behind its listed tech level. */
export interface GearVariant {
  id: string;
  name: string;
  note?: string;
  /** Tech levels earlier (negative) than the listing. */
  tl?: number;
  costMult?: number;
  kgMult?: number;
  /** Different multiples for computers and electronics. */
  electronic?: { costMult: number; kgMult: number };
  availabilityDm?: number;
  /** Applied once for every tech level above the listing. */
  perTl?: { costMult: number; kgMult: number };
  only?: 'electronic';
  maxSteps?: number;
  computerSteps?: number;
}

export interface GearRules {
  weapons: WeaponDef[];
  armour: ArmourDef[];
  weaponTraits: { id: string; name: string; note: string }[];
  equipment?: EquipmentDef[];
  availability?: AvailabilityRules;
  variants?: GearVariant[];
  /** What can be wrong with a prototype: roll one die. */
  quirks?: string[];
  /** Short rules to keep at hand when shopping. */
  /** Notes to keep to hand when buying. Give each an `id` so that another pack can add to the list rather than replace it. */
  reference?: { id?: string; title: string; text: string }[];
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
  /** Multiplier on armour tonnage: awkward shapes need more plate for the same protection. */
  armourMult?: number;
  /** Price per ton in place of the standard hull price (a hollowed-out planetoid). */
  costPerTon?: number;
  /** Percentage of the hull that can be built into; the rest is solid. */
  usablePct?: number;
  /** Protection the hull gives before any armour is added. */
  armourBonus?: number;
  /** Cannot be built as a specialised hull (reinforced, light and so on). */
  noOptions?: boolean;
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
  /** Only on hulls over, or up to, this tonnage. */
  overTons?: number;
  maxTons?: number;
  /** Options that cannot be combined with this one. */
  excludes?: string[];
  /** Catalogue rows it can be applied to; any when absent. */
  appliesTo?: string[];
  /** Size and price changes to the part it is fitted to. */
  tonsMult?: number;
  tonsAdd?: number;
  /** Smallest size the part can then be, by hull tonnage. */
  minTonsByHull?: { maxHull: number; tons: number }[];
  costFlat?: number;
  /** Credits per ton of the part (or per ton of fuel carried, for tank options). */
  costPerTon?: number;
  powerMult?: number;
  /** Drives: multiplier on the rating actually delivered, rounded down. */
  ratingMult?: number;
  /** Raises the tech level needed by this much (a spinal mount built ahead of its time). */
  tlAdd?: number;
  /** Hulls: multiplier on the heaviest armour that can be fitted, and on basic power needs. */
  armourMaxMult?: number;
  basicPowerMult?: number;
  note?: string;
}

/** How far ahead of, or behind, its normal tech level a component is built. */
export interface GradeDef {
  id: string;
  name: string;
  /** Added to the component's tech level. */
  tlShift: number;
  /** Percentage change in tonnage. */
  tonsPct?: number;
  costMult: number;
  advantages?: number;
  disadvantages?: number;
}

/** An advantage or disadvantage a customised component can be given. Percentages add up. */
export interface ModDef {
  id: string;
  name: string;
  /** What it applies to: mdrive, rdrive, jdrive, plant or weapon (mounts and screens). */
  kinds: string[];
  advantage: boolean;
  /** Advantage or disadvantage slots it uses; one unless stated. */
  slots?: number;
  tonsPct?: number;
  powerPct?: number;
  outputPct?: number;
  fuelPct?: number;
  /** Cannot be taken more than once. */
  once?: boolean;
  /** Not for weapons in turrets and fixed mounts. */
  notTurrets?: boolean;
  /** In a fight: DM to attacks with the weapon, and extra armour piercing. */
  attackDm?: number;
  ap?: number;
  effect?: string;
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
  /** With `maxByTl`, protection may exceed the tech level by this much. */
  maxTlPlus?: number;
  /** Priced per ton of armour instead of as a share of the hull cost. */
  costPerTon?: number;
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
  /** A rating-0 drive: enough to hold station, no more. */
  zero?: { tonsPct: number; tl: number; powerMult?: number; fuelTonsPerHour?: number };
  /** Reaction drives: fuel burned per hour, as a percentage of hull tonnage per point of Thrust. */
  fuelPctPerHour?: number;
  options?: PartOptionDef[];
  name?: string;
  note?: string;
}

export interface PlantDef {
  id: string;
  name: string;
  tl: number;
  powerPerTon: number;
  costPerTon: number;
  /** Cannot deliver the burst of power a jump drive needs. */
  noJump?: boolean;
  /** Fuel by its own measure (tons per ton of plant every `fuelWeeks`) instead of the usual share of its size. */
  fuelTonsPerTon?: number;
  fuelWeeks?: number;
  note?: string;
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
  /** A computer core: runs Jump Control on top of its Processing, with that software included. */
  core?: boolean;
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
  /** Gunners on a warship, where that differs from one per mount. */
  gunnersMilitary?: number;
  /** Hardpoints taken (one unless stated), and firmpoints on a small craft. */
  hardpoints?: number;
  firmpoints?: number;
  /** A spinal mount: sized by its weapon, in multiples of the weapon's base size (`rating`). */
  variable?: boolean;
  /** Not for hulls of this tonnage or less. */
  overTons?: number;
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
  /** DM to attack rolls from the weapon's own handling. */
  attackDm?: number;
  /** Damage is multiplied by this after armour (barbettes, bays and spinal mounts). */
  multiple?: number;
  /** Attacks or salvoes carried before reloading, and missiles launched in each salvo. */
  magazine?: number;
  salvo?: number;
  /** Extra tons when fitted to a small craft's firmpoint. */
  firmpointTons?: number;
  /** Spinal weapons: tons at base size and the largest that can be built. Power, damage dice and cost are per base size. */
  spinal?: { baseTons: number; maxTons: number };
  note?: string;
}

/**
 * A fitting from the catalogue. `size` says how it is dimensioned:
 *  - unit: `qty` copies of fixed size;
 *  - tons: the designer picks a tonnage;
 *  - hull: a percentage of the hull;
 *  - docking: sized from the tonnage of the craft carried (`rating`);
 *  - capacity: sized from something else it serves (`rating`): craft launched, cargo slung, fuel carried;
 *  - plant: a percentage of the power plant.
 */
export interface FittingDef {
  id: string;
  name: string;
  group: string;
  size: 'unit' | 'tons' | 'hull' | 'docking' | 'capacity' | 'plant';
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
  /** Hull-sized fittings: tons added on top of the percentage. */
  plusTons?: number;
  /** Capacity fittings: tons taken per ton served, what is served, and whether to round up. */
  capacityMult?: number;
  capacityLabel?: string;
  capacityRound?: boolean;
  costPerCapacity?: number;
  /** Capacity may not exceed this percentage of the hull. */
  maxCapacityHullPct?: number;
  /** Adds this fraction of the basic hull cost (a pressure hull multiplies it many times over). */
  hullCostAdd?: number;
  /** Adds this percentage of the hull cost for each percent of the hull served; `fullPercent` counts whole percents only. */
  hullCostPerCapacityPct?: number;
  fullPercent?: boolean;
  /** Plant-sized fittings: percentage of the power plant's tonnage and cost. */
  plantPct?: number;
  /** Power generated (solar), per unit or per ton, and power held in reserve (batteries). */
  unitOutput?: number;
  outputPerTon?: number;
  storePerTon?: number;
  /** Unit fittings: no more than this percentage of the hull tonnage in units. */
  maxQtyHullPct?: number;
  /** Only on hulls over, or up to, this tonnage. */
  overTons?: number;
  maxHull?: number;
  /** Fittings (by id) that cannot be combined with this one. */
  excludes?: string[];
  /** Hardpoints taken, each. */
  hardpoints?: number;
  /** Gunners needed, each: on a commercial ship and on a warship. */
  gunners?: number;
  gunnersMilitary?: number;
  /** Protection added to the hull's armour. */
  armourBonus?: number;
  /** Can be built ahead of or behind its tech level, with this kind of advantages. */
  custom?: string;
  /** Extra people who can be carried in cramped conditions (barracks, brig). */
  troops?: number;
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
  crewing?: 'commercial' | 'military';
  /** Which book the design is from, for grouping the catalogue. */
  source?: string;
  summary?: string;
  note?: string;
  parts: Omit<import('./types').DesignPart, 'id'>[];
}

/** Crew numbers by ship size, for a commercial ship and for a warship. */
export interface CrewEstablishment {
  pilots: { commercial: number; military: number };
  /** Commercial ships from this tonnage carry a captain who is not one of the other crew; warships always do. */
  captainFromTons: number;
  maintenancePerTons: { commercial: number; military: number };
  adminPerTons: { commercial: number; military: number };
  sensors: { perTons: number; commercial: number; military: number };
  officerPerCrew: { commercial: number; military: number };
  /** Large ships need proportionally fewer hands in these roles. */
  reductions: { fromTons: number; mult: number }[];
  reducedRoles: string[];
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
    /** Very large hulls are sturdier for their size: tons per Hull point from each tonnage up. */
    pointBands?: { fromTons: number; tonsPerPoint: number }[];
    /** Armour takes more room on small hulls: multiplier on armour tonnage by hull size. */
    armourSizeMult?: { maxHull: number; mult: number }[];
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
  /** Reaction drives: rockets, burning fuel instead of drawing power. */
  rdrive?: DriveRules;
  plants: PlantDef[];
  power: { basicPct: number };
  fuel: {
    plantPct: number;
    plantMinTons: number;
    plantWeeks: number;
    /** Small craft carry exactly the fuel their plant burns, with no minimum and no rounding up. */
    smallCraftExact?: boolean;
    options?: PartOptionDef[];
  };
  bridge: {
    sizes: { maxHull: number; tons: number }[];
    /** Beyond the table: extra tons for every further `perTons` of hull above `aboveTons`. */
    extra?: { aboveTons: number; perTons: number; tons: number };
    costPer100Tons: number;
    types: BridgeTypeDef[];
    options: PartOptionDef[];
  };
  computers: ShipComputerDef[];
  computerOptions: PartOptionDef[];
  sensors: ShipSensorDef[];
  sensorOptions?: PartOptionDef[];
  software: ShipSoftwareDef[];
  mounts: MountDef[];
  mountOptions?: PartOptionDef[];
  weapons: ShipWeaponDef[];
  hardpoints: {
    perTons: number;
    firmpoints: { maxHull: number; points: number }[];
    firmpointNote?: string;
    /** Weapons on a firmpoint draw this percentage of their usual Power, rounded up. */
    firmpointPowerPct?: number;
    /** How many of a small craft's firmpoints can carry a turret. */
    firmpointTurrets?: number;
  };
  fittings: FittingDef[];
  crew: {
    roles: { id: string; name: string; salary: number }[];
    engineerPerTons: number;
    medicPerPeople: number;
    stewardPerHigh: number;
    stewardPerMiddle: number;
    skillBonusPct?: number;
    /** The fuller establishment for larger and military ships. Absent, only the core roles are worked out. */
    establishment?: CrewEstablishment;
  };
  costs: {
    standardDiscountPct: number;
    maintenanceDivisor: number;
    /** A naval architect's fee for a new design, as a percentage of its cost. */
    architectPct?: number;
    /** Higher-tech yards build faster: percentage of the usual time, from each tech level up. */
    buildTimeByTl?: { tl: number; pct: number }[];
  };
  /** Components built ahead of or behind their tech level. */
  customising?: { grades: GradeDef[]; mods: ModDef[] };
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
  /** Works by itself: no check, just the number of missiles it stops (rolled by hand). */
  count?: boolean;
  note: string;
}

/** A kind of missile, torpedo or sandcaster canister. */
export interface AmmoDef {
  id: string;
  kind: 'missile' | 'torpedo' | 'canister';
  name: string;
  tl: number;
  thrust?: number;
  damage?: string;
  /** Credits for a batch of `per`. */
  cost: number;
  per: number;
  traits?: string[];
  /** The standard load, used when nothing else is named. */
  standard?: boolean;
  /** Keeps its numbers however long the flight. */
  endurance?: boolean;
  note?: string;
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
    /** The skill for bay and spinal weapons, where it differs from the turret skill. */
    capitalSkill?: string;
    /** Heavy mounts track small targets badly: DM by the weapon's mount and the target's tonnage. */
    sizeDm?: { mount: string; maxTons: number; dm: number }[];
    /** Spinal weapons at close quarters: DM by range band, for attackers up to each tonnage in `attackerTons` and beyond. */
    spinalRange?: { attackerTons: number[]; bands: { range: string; dm: number[] }[]; minTargetTons?: number };
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
    /** Big ships shrug off telling blows from light weapons: over this tonnage, hits from these mounts ("" for turrets) cause no critical. */
    immunity?: { overTons: number; mounts: string[] }[];
  };
  repair: { baseTarget: number; lastsHoursDice: number; note: string };
  missiles: {
    perTurret: number;
    refillCost: number;
    flight: { range: string; rounds: number }[];
    /** Flight times for other drives, keyed by Thrust. */
    flightByThrust?: Record<string, { range: string; rounds: number }[]>;
    /** A salvo of missiles halves for every this-many full rounds in flight. */
    halveEvery?: number;
    maxRounds: number;
    dmPerMissile: number;
    distantDm: number;
    note: string;
  };
  /** Kinds of missile, torpedo and canister beyond the standard load. */
  ammo?: AmmoDef[];
  sand: { perTurret: number; refillCost: number };
  scale?: Record<string, number>;
  dogfight?: { note: string };
}

/** A table of the rules reference. With a `roll`, the first heading is for the result and each row says which results it covers. */
export interface ReferenceTable {
  id: string;
  title?: string;
  /** How to roll on it: "2D", "1D", "D66", "D3", with "+ DM" where the situation modifies it. */
  roll?: string;
  columns: string[];
  rows: { /** The results this row covers: "7", "3-4", "11+", "2-". */ on?: string; cells: string[] }[];
  note?: string;
}

/** A topic of the rules reference: a rule in a few paragraphs, with any tables that go with it. */
export interface ReferenceTopic {
  id: string;
  title: string;
  /** The heading it is filed under. */
  group: string;
  source?: string;
  /** An optional rule, to be used only where the referee has taken it up. */
  optional?: boolean;
  text?: string[];
  tables?: ReferenceTable[];
}

export interface ReferenceRules {
  topics: ReferenceTopic[];
}

export interface RulePack {
  packs: PackMeta[];
  world?: WorldRules;
  reference?: ReferenceRules;
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
