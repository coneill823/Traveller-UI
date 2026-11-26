/**
 * Core data model shared by server and client.
 *
 * Everything in the campaign is an "entity": a JSON document with an id and a type.
 * The server holds the full version of every entity. Each connected viewer receives a
 * redacted copy containing only what that viewer knows (see knowledge.ts).
 */

export type Id = string;

/** Who knows something: the whole party, or one player (by player id). The GM always knows. */
export type Audience = string;
export const PARTY: Audience = 'party';

/** facet name -> audiences who know that facet of the entity. A missing facet is GM-only. */
export type Known = Record<string, Audience[]>;

/** A free-form write-up attached to an entity, revealed to players section by section. */
export interface Note {
  id: Id;
  title: string;
  /** Markdown. */
  body: string;
  known: Audience[];
}

/** Link from an entity to a page in the Chronicler wiki. */
export interface WikiLink {
  /** Vault-relative path of the page, e.g. "Atlas/Kestrel Reach/Ardent.md". */
  path: string;
}

/** Cross-link between entities, for story threads that tie things together later. */
export interface EntityLink {
  id: Id;
  label?: string;
}

export interface EntityBase {
  id: Id;
  type: string;
  rev: number;
  createdAt: number;
  updatedAt: number;
  known?: Known;
  notes?: Note[];
  links?: EntityLink[];
  wiki?: WikiLink;
  /** GM-only scratch space. Never sent to players. */
  gm?: Record<string, unknown>;
}

// ───────────────────────────── campaign & people ─────────────────────────────

export interface GameDate {
  /** Day of year, 1–365. */
  day: number;
  year: number;
}

export interface Polity {
  code: string;
  name: string;
  color: string;
}

export interface Campaign extends EntityBase {
  type: 'campaign';
  name: string;
  date: GameDate;
  /** Where the party currently is. */
  location?: { systemId?: Id; bodyId?: Id };
  polities: Polity[];
  settings: {
    /** Default jump rating used by the route planner until a ship is selected. */
    defaultJump: number;
    /** Systems created or imported are published to the wiki automatically. */
    wikiAutoPublish: boolean;
  };
}

export interface Player extends EntityBase {
  type: 'player';
  name: string;
  role: 'gm' | 'player';
  color: string;
}

// ───────────────────────────────── universe ─────────────────────────────────

export interface Sector extends EntityBase {
  type: 'sector';
  name: string;
  abbr?: string;
  /** Position on the universe grid, in whole sectors. +x is trailing, +y is rimward. */
  x: number;
  y: number;
  /** Subsector names keyed by letter A–P. */
  subsectors: Record<string, string>;
}

export type TravelZone = '' | 'A' | 'R';

export interface StarSystem extends EntityBase {
  type: 'system';
  sectorId: Id;
  /** Hex within the sector, "CCRR" e.g. "0101". */
  hex: string;
  name?: string;
  /** Universal World Profile of the mainworld, e.g. "CA6A643-9". */
  uwp?: string;
  /** Base codes, e.g. "NS". */
  bases?: string;
  /** Free remarks from imports (extra trade codes, comments). */
  remarks?: string;
  zone?: TravelZone;
  /** Population multiplier, belts, gas giants, e.g. "703". */
  pbg?: string;
  allegiance?: string;
  stars?: string;
  /** Extended Second Survey fields kept verbatim so imports round-trip. */
  ext?: { ix?: string; ex?: string; cx?: string; nobility?: string; worlds?: string; ru?: string };
  /** What a detailed survey of the whole system found. */
  survey?: { /** Age in billions of years. */ age: number; /** Giants-belts-terrestrials-baseline-spread. */ profile: string };
  /** The people of the mainworld in depth. */
  society?: Society;
}

/** Figures a detailed survey records for a star, world or moon. Everything is optional. */
export interface BodyData {
  /** Survey designation: "Aab IV", "B I", "PI". */
  designation?: string;
  /** Which stars it circles: "A", "Aab", "AB". */
  around?: string;
  /** Orbit number, distance in AU, eccentricity, and period in years. */
  orbitNo?: number;
  au?: number;
  ecc?: number;
  period?: number;
  /** Size code ("7", "A", "S", "GM9"); for gas giants also diameter and mass in Earths. */
  size?: string;
  diameter?: number;
  mass?: number;
  /** Distance from the centre of the habitable zone in orbit numbers (negative is hotter), and what that suggests. */
  hz?: number;
  zone?: string;
  /** An orbit out of the ordinary: retrograde, inclined (with the angle), eccentric, trojan, random. */
  anomaly?: string;
  inclination?: number;
  rings?: number;
  /** Moons too small to list one by one. */
  smallMoons?: number;
  /** Stars: place in the system, and mass, diameter, luminosity in Suns, surface temperature in kelvin. */
  role?: string;
  solarMass?: number;
  solarDiameter?: number;
  luminosity?: number;
  temperature?: number;
  /** The world itself in detail: what it is made of, its air, water, days, climate, geology and life. */
  detail?: BodyDetail;
}

/** One thing wrong with a world's air: what it is, how bad, and how often. */
export interface AirTaint {
  code: string;
  name: string;
  severity?: number;
  severityName?: string;
  persistence?: number;
  persistenceName?: string;
}

/** A world, moon or belt in detail, as a full survey records it. Everything is optional. */
export interface BodyDetail {
  /** Size, atmosphere and hydrographics as three digits, "867". */
  sah?: string;
  /** Diameter in km, what it is made of, density (Earth = 1), surface gravity in G, mass in Earths, escape velocity in km/s. */
  km?: number;
  composition?: string;
  density?: number;
  gravity?: number;
  mass?: number;
  escape?: number;
  atm?: {
    code: number;
    name: string;
    /** Pressure at the surface in bar, and the share of it that is oxygen. */
    bar?: number;
    ppo?: number;
    /** Too little or too much oxygen to breathe. */
    oxygen?: 'low' | 'high';
    /** Subtype of an exotic, corrosive, insidious or unusual atmosphere, and the standing hazard of an insidious one. */
    sub?: string;
    subName?: string;
    hazard?: string;
    hazardName?: string;
    taints?: AirTaint[];
    /** The main gases, by percentage. */
    gases?: { gas: string; pct: number }[];
    /** Height in km over which the pressure falls to about a third. */
    scale?: number;
    /** Its oceans boiled away into the air. */
    runaway?: boolean;
    gear?: string;
  };
  hydro?: { code: number; pct: number; surface?: string; liquid?: string };
  day?: {
    /** Length of a turn on its axis in hours (negative when it turns backwards), and from noon to noon. */
    hours: number;
    solar?: number;
    tilt: number;
    /** Held with one face to "star" or "planet", turning in step with its "moon", or in a 3:2 "resonance". */
    lock?: string;
  };
  /** Kelvin. */
  temp?: { mean: number; high?: number; low?: number; albedo?: number; greenhouse?: number };
  /** Height of the tides raised on it, in metres on open water. */
  tide?: number;
  seismic?: { residual: number; tidal: number; heating: number; total: number; activity?: string; plates?: number };
  life?: { biomass: number; complexity: number; complexityName?: string; diversity: number; compatibility: number; sophonts?: 'living' | 'extinct' };
  resources?: number;
  habitability?: number;
  /** A belt: its width in orbit numbers, what its bodies are made of (percent), bulk, worth, and its largest bodies. */
  belt?: { span: number; m: number; s: number; c: number; other: number; bulk: number; resources: number; size1: number; sizeS: number };
  /** A moon's path: distance in planetary diameters and km, period in hours. */
  moon?: { pd: number; km: number; hours: number; ecc?: number; retro?: boolean; range?: string };
  /** Rings: centre and width of each, in planetary diameters. */
  ringSpans?: { centre: number; span: number }[];
  /** People living on a world other than the mainworld. */
  settlement?: Settlement;
}

/** A lesser settlement of a system: its people, how it is run, and what it is for. */
export interface Settlement {
  pop: number;
  gov: number;
  law: number;
  tl: number;
  /** Spaceport class. */
  port: string;
  portName?: string;
  classes?: { code: string; name: string }[];
  /** Port, size, air, water, population, government, law and technology in the usual form. */
  profile: string;
}

/** A named level on a scale, with what it means. */
export interface SocietyPart {
  id: string;
  name: string;
  level: number;
  note?: string;
}

/** The people of a mainworld in depth: who they are, how they are ruled, what they may do, what they can make. */
export interface Society {
  people?: {
    /** First digit of the population, and the whole of it. */
    digit: number;
    total: number;
    /** How gathered the people are, 0 (spread everywhere) to 9 (all in one place). */
    pcr: number;
    pcrName?: string;
    /** Percentage living in towns, and how many that is. */
    urban: number;
    urbanPeople: number;
    cities: number;
    cityPeople: number;
    /** The largest cities, or the largest town where there is no city. */
    largest?: number[];
  };
  government?: {
    code: number;
    /** On a world of many states: how many there are, the government of each, and the one by the starport that the rest of this describes. */
    nations?: number[];
    host?: number;
    centralisation?: string;
    centralisationName?: string;
    authority?: string;
    authorityName?: string;
    /** How each function of government is made up. */
    structure?: { function: string; functionName: string; code: string; name: string }[];
    profile?: string;
    factions?: { government: number; strength?: string; strengthName?: string; relation?: number; relationName?: string }[];
  };
  law?: {
    justice?: string;
    justiceName?: string;
    /** Economic matters go to an administrative court of their own. */
    economicCourts?: boolean;
    uniformity?: string;
    uniformityName?: string;
    presumption?: boolean;
    death?: boolean;
    parts: SocietyPart[];
    profile?: string;
  };
  tech?: { high: number; least?: number; parts: SocietyPart[]; profile?: string };
  culture?: (SocietyPart & { leaning?: string })[];
  economy?: {
    importance: number;
    resource: number;
    labour: number;
    infrastructure: number;
    efficiency: number;
    ru: number;
    gwpPerHead: number;
    gwp: number;
    wtn: number;
    inequality: number;
    development: number;
    tariff?: string;
    tariffRate?: number;
  };
  port?: { highport?: boolean; standing?: string; daily?: number; weekly?: number };
}

export type BodyKind = 'star' | 'planet' | 'gasGiant' | 'belt' | 'moon' | 'station' | 'poi';

/** A stellar body or a point of interest inside a system. */
export interface Body extends EntityBase {
  type: 'body';
  systemId: Id;
  /** Parent body for moons, stations in orbit and surface points of interest. */
  parentId?: Id;
  kind: BodyKind;
  name?: string;
  /** Sort order outward from the primary (or within the parent). */
  orbit: number;
  /** True for the system's mainworld; its profile is the system's UWP. */
  mainworld?: boolean;
  /** Profile for secondary inhabited worlds. */
  uwp?: string;
  /** Spectral class for stars, category for points of interest (ruins, city, base…). */
  subtype?: string;
  /** Short public description. */
  summary?: string;
  /** Figures from a detailed survey. */
  data?: BodyData;
  /**
   * 'survey' bodies are what any star chart would list (stars, mainworld, gas giants, belts) and
   * are revealed along with the system's survey data. 'custom' ones are revealed individually.
   */
  origin?: 'survey' | 'custom';
}

export type RouteKind = 'comm' | 'trade' | 'custom';

/** A communications or trade route drawn between two systems. */
export interface RouteLine extends EntityBase {
  type: 'route';
  a: Id;
  b: Id;
  kind: RouteKind;
  label?: string;
}

/** A painted region of hexes: polity borders, nebulae, quarantine areas. */
export interface Region extends EntityBase {
  type: 'region';
  name: string;
  color: string;
  /** Global hex keys "gx,gy". */
  hexes: string[];
}

// ───────────────────────────────── objectives ────────────────────────────────

export interface Objective extends EntityBase {
  type: 'objective';
  title: string;
  /** Markdown. */
  body?: string;
  /** 'party' or a player id for a personal objective. */
  scope: Audience;
  status: 'active' | 'done' | 'failed';
  targets: { systemId: Id; bodyId?: Id }[];
  reward?: string;
  createdBy: Id;
}

// ─────────────────────────────────── wiki ───────────────────────────────────

export interface WikiSection {
  /** Stable slug of the heading (or "_intro" for text before the first heading). */
  id: string;
  heading: string;
  level: number;
  /** Markdown body of this section, excluding sub-headings handled as their own sections. */
  body: string;
  /** Who can read the section. */
  known: Audience[];
  /** Audiences who may also read ||spoiler|| text in this section. */
  spoilersKnown?: Audience[];
  /** Sections under a "GM …" heading can never be revealed. */
  locked?: boolean;
}

export interface WikiPage extends EntityBase {
  type: 'wikiPage';
  path: string;
  title: string;
  /** Parsed YAML frontmatter (the Chronicler infobox). */
  frontmatter: Record<string, unknown>;
  tags: string[];
  sections: WikiSection[];
  /** Entity this page documents, if any. */
  entityId?: Id;
  /** Content hash of the file as last read from or written to the vault. */
  hash: string;
  /** The backend's version marker for the file (git blob id or size-and-time). */
  sha?: string;
  /** Infobox values as they stood after the last sync, to tell which side changed since. */
  synced?: Record<string, string>;
  /** Problems found while reading the page (bad infobox values and the like). GM only. */
  warnings?: string[];
}

// ──────────────────────────────── characters ────────────────────────────────

/** A characteristic's id: STR, DEX, END, INT, EDU, SOC, PSI, or any other that a rules pack lists (Luck, Morale and so on). */
export type CharKey = string;

export interface CharScore {
  /** Current value, after damage. */
  value: number;
  /** Undamaged score. */
  max: number;
}

export interface CharacterWeapon {
  id: Id;
  /** Rules-pack weapon this was taken from, if any. */
  defId?: string;
  name: string;
  skill: string;
  damage: string;
  range: number | 'melee';
  traits?: string[];
  magazine?: number | 'unlimited';
  /** Rounds left in the weapon. */
  ammo?: number;
  note?: string;
  tl?: number;
  /** Which special ammunition it takes ('pistol', 'rifle', 'shotgun' or 'heavy'). */
  ammoClass?: string;
  /** Special ammunition loaded: the catalogue entry it comes from. */
  load?: { id: string; name: string };
}

export interface CharacterArmour {
  id: Id;
  defId?: string;
  name: string;
  protection: number;
  laserProtection?: number;
  /** Protection that only counts against some attacks, in words. */
  versus?: string;
  rad?: number;
  kg?: number;
  worn: boolean;
  note?: string;
  /** Changes to STR and DEX while worn: for checks and carrying, not for taking damage. */
  str?: number;
  dex?: number;
  /** Skill needed to move freely in it. */
  skill?: { name: string; level: number };
  /** Powered: weighs nothing on the wearer while it runs. */
  powered?: boolean;
  slots?: number;
}

/** A player character, non-player character or creature. */
export interface Character extends EntityBase {
  type: 'character';
  kind: 'pc' | 'npc' | 'creature';
  /** The player who runs this character. */
  ownerId?: Id;
  name?: string;
  /** Role, rank or a one-line descriptor. */
  title?: string;
  species?: string;
  age?: number;
  homeworld?: string;
  careers?: { name: string; terms: number; rank?: string }[];
  chars?: Partial<Record<CharKey, CharScore>>;
  /** Skill name (with speciality in brackets) -> level. */
  skills?: Record<string, number>;
  weapons?: CharacterWeapon[];
  armour?: CharacterArmour[];
  credits?: number;
  /** Uploaded portrait image. */
  portrait?: string;
  /** Background the rest of the party may read (markdown). */
  bio?: string;
  /** Private notes: the owning player and the GM only. */
  secrets?: string;
  traits?: string[];
  conditions?: string[];
  /** Metres per minor action. */
  movement?: number;
}

// ───────────────────────────── ships (basics) ─────────────────────────────

/** A starship or small craft. The ship builder and ship operations add detail to this record. */
export interface Ship extends EntityBase {
  type: 'ship';
  name?: string;
  /** Class or design name, e.g. "Far Trader". */
  className?: string;
  /** True for ships the party crews; every player can see and use these. */
  party?: boolean;
  tons?: number;
  jump?: number;
  thrust?: number;
  /** Tons of cargo space. */
  cargo?: number;
  /** Tons of fuel tankage and fuel aboard. */
  fuelCapacity?: number;
  fuel?: number;
  /** The ship's account, in credits. */
  funds?: number;
  location?: { systemId?: Id; bodyId?: Id; status?: 'docked' | 'orbit' | 'in-flight' | 'jump' };
  /** Staterooms and low berths available for passengers. */
  staterooms?: number;
  lowBerths?: number;
  summary?: string;
  /** The as-built design: hull, parts and outline. Set when the ship comes out of the shipyard. */
  spec?: ShipSpec;
  /** The design record this ship was built from. */
  designId?: Id;
  /** Current and full Hull points, and armour protection. */
  hull?: number;
  hullMax?: number;
  armour?: number;
  /** Monthly maintenance cost in credits. */
  maintenance?: number;
  /** Set while the ship is still in the yard. */
  construction?: { readyDay: number; readyYear: number; systemId?: Id };
  /** Critical hit severity by location (sensors, powerPlant, mDrive...). */
  crits?: Record<string, number>;
  /** Locations whose critical hit effects have been patched up for the time being. */
  repaired?: string[];
  /** What has gone wrong lately, newest last: hits, critical hits, faults and repairs. */
  alerts?: ShipAlert[];
  /** Who is at which station: character id -> duty, and the turret for gunners. */
  duties?: Record<Id, { duty: string; mount?: string }>;
}

/** Something that happened to a ship and is shown on its status board. */
export interface ShipAlert {
  id: Id;
  kind: 'hit' | 'critical' | 'fault' | 'repair';
  /** Critical hit location id, and the part of the design it shows on. */
  location?: string;
  partId?: string;
  severity?: number;
  title: string;
  text?: string;
  at: number;
  /** Dealt with or acknowledged: no longer highlighted. */
  cleared?: boolean;
}

// ───────────────────────────── ship design ─────────────────────────────

export type PartKind = 'armour' | 'mdrive' | 'rdrive' | 'jdrive' | 'plant' | 'fuel' | 'bridge' | 'computer' | 'sensors' | 'software' | 'mount' | 'fitting' | 'craft' | 'custom';

/**
 * One line of a ship design. `key` names a row of the rules pack's parts catalogue; how a part
 * is sized depends on its kind (a drive has a `rating`, a power plant has `tons`, staterooms a `qty`).
 * `craft` and `custom` lines carry their own name, tonnage and price.
 */
export interface DesignPart {
  id: string;
  kind: PartKind;
  key?: string;
  rating?: number;
  qty?: number;
  tons?: number;
  options?: string[];
  /** Weapon keys fitted to a mount. */
  weapons?: string[];
  name?: string;
  /** Credits (craft and custom lines). */
  cost?: number;
  power?: number;
  /** Built ahead of or behind its tech level: a grade from the rules, and the advantages or disadvantages chosen for it. */
  grade?: string;
  mods?: string[];
}

/**
 * The silhouette a design is drawn on. Built-in outlines are referenced by key; a custom outline
 * is either SVG path data or an uploaded image whose dark or opaque area is the hull.
 */
export type ShipOutline =
  | { kind: 'builtin'; key: string }
  | { kind: 'path'; d: string; viewBox: [number, number, number, number]; name?: string }
  | { kind: 'image'; url: string; name?: string };

export interface ShipSpec {
  /** Tech level the design is drawn up for. */
  tl: number;
  hull: { tons: number; config: string; options?: string[] };
  /** In order from bow to stern, which is how they are laid out on the outline. */
  parts: DesignPart[];
  outline?: ShipOutline;
  /** Where along `parts` the cargo hold is drawn on the outline; by default just ahead of engineering. */
  cargoAt?: number;
  /** Key of the stock design this started from. */
  stock?: string;
  /** Crewed to commercial standards (the default) or as a warship. */
  crewing?: 'commercial' | 'military';
}

/** A ship design on the drawing board: drafted, shown to the party, signed off, then built. */
export interface ShipDesign extends EntityBase {
  type: 'design';
  name: string;
  className?: string;
  status: 'draft' | 'proposed' | 'approved' | 'built';
  /** Who drew it up. Drafts are private to their author and the GM until shared. */
  ownerId: Id;
  shared?: boolean;
  spec: ShipSpec;
  /** Players who have signed off on the proposal. */
  approvals?: Id[];
  /** The GM has signed it off on the party's behalf. */
  gmSigned?: boolean;
  /** The ship this design refits, if it is a refit. */
  refitOf?: Id;
  /** The ship built from it. */
  shipId?: Id;
  built?: { day: number; year: number; systemId?: Id; price: number };
  summary?: string;
}

// ───────────────────────────── encounters ─────────────────────────────

export type CombatSide = 'party' | 'enemy' | 'neutral';

/** What a player is shown of a combatant whose sheet they cannot see. */
export interface CombatantSeen {
  name: string;
  kind: Character['kind'];
  portrait?: string;
  health: 'ok' | 'wounded' | 'unconscious' | 'dead';
}

export interface Combatant {
  id: Id;
  characterId: Id;
  side: CombatSide;
  /** What the table calls them, e.g. "Raider 2". Shown to players instead of the sheet's name. */
  label?: string;
  initiative?: number;
  /** Token position on the battlemap, as fractions of its width and height. */
  x?: number;
  y?: number;
  /** Not yet shown to the players. */
  hidden?: boolean;
  /** Out of the fight: down, fled or dead. */
  out?: boolean;
  /** Has taken a turn this round. */
  acted?: boolean;
  /** Reactions made since their last turn; each is DM-1 on their next actions. */
  reactions?: number;
  conditions?: string[];
  /** Filled in by the server for players. */
  seen?: CombatantSeen;
}

/** One thing done in a turn, in the order it was done. */
export interface TurnStep {
  id: Id;
  /** An action id from the rules pack, or "custom". */
  action: string;
  type: 'significant' | 'minor' | 'free' | 'reaction';
  label: string;
  /** Ticked off as it is resolved at the table. */
  done?: boolean;
  /** Combatant acted upon. */
  targetId?: Id;
  weapon?: string;
  /** The check: what was rolled in total and what it needed. */
  roll?: { total: number; target?: number; dice?: number[]; dm?: number; rollId?: Id };
  /** Damage rolled for a hit. The attack's Effect is added unless `addEffect` is false. */
  damage?: number;
  addEffect?: boolean;
  ap?: number;
  stun?: boolean;
  /** False when the damage was noted but should not be taken off the target automatically. */
  apply?: boolean;
  /** Where a move ends, as map fractions. */
  to?: { x: number; y: number };
  note?: string;
}

/** What a step did, worked out when the turn was published. */
export interface TurnResult {
  stepId: Id;
  targetId?: Id;
  hit?: boolean;
  effect?: number;
  /** Damage dealt before armour, and what got through. */
  dealt?: number;
  taken?: number;
  absorbed?: number;
  status?: 'ok' | 'wounded' | 'unconscious' | 'dead';
  from?: { x: number; y: number };
  to?: { x: number; y: number };
}

export interface TurnRecord {
  id: Id;
  round: number;
  combatantId: Id;
  /** The player who published it. */
  by: Id;
  steps: TurnStep[];
  results: TurnResult[];
  /** A reaction made out of turn rather than a full turn. */
  reaction?: boolean;
  at: number;
}

export interface BattleMap {
  url: string;
  width: number;
  height: number;
  /** Squares across the width of the image, if it has a grid; each is one combat square. */
  squares?: number;
  showGrid?: boolean;
}

/** A fight: who is in it, where they stand, whose turn it is and what has happened so far. */
export interface Encounter extends EntityBase {
  type: 'encounter';
  name: string;
  status: 'setup' | 'active' | 'ended';
  /** Shown to players while still being set up. */
  open?: boolean;
  round: number;
  /** The combatant whose turn it is. */
  turn?: Id;
  combatants: Combatant[];
  map?: BattleMap;
  log: TurnRecord[];
  summary?: string;
}

// ───────────────────────────── space battles ─────────────────────────────

export type BattleStepId = 'manoeuvre' | 'attack' | 'actions';
export type ShipConditionId = 'intact' | 'damaged' | 'crippled' | 'wrecked';

export interface BattleShip {
  id: Id;
  /** The ship's own record, when it has one. */
  shipId?: Id;
  name: string;
  side: CombatSide;
  initiative?: number;
  /** One-round changes to initiative from the captain: this round's, and next round's. */
  initiativeDm?: number;
  nextInitiativeDm?: number;
  /** Range band from the party's flagship. */
  range?: string;
  /** Thrust banked toward the next change of range: positive closes, negative opens. */
  closing?: number;
  hidden?: boolean;
  out?: boolean;
  /** Has acted in the current step. */
  acted?: boolean;
  /** Ships (battle ids) this one holds a sensor lock on. */
  locks?: Id[];
  /** Bare figures for a ship with no record of its own. */
  quick?: { tons?: number; thrust?: number; pilot?: number; hull?: number; hullMax?: number; armour?: number; crits?: Record<string, number> };
  /** Filled in for players: what they can tell about a ship that is not theirs. */
  seen?: { name: string; className?: string; tons?: number; condition: ShipConditionId };
}

/** One thing a member of the crew does in a step of the round. */
export interface CrewAction {
  id: Id;
  step: BattleStepId | 'reaction';
  /** Action and duty ids from the rules pack. */
  action: string;
  duty: string;
  label: string;
  characterId?: Id;
  /** The player who queued it. */
  by: Id;
  done?: boolean;
  /** Battle ship acted upon. */
  targetId?: Id;
  /** Part id of the turret used, the weapon fired and how many of them together. */
  mount?: string;
  weapon?: string;
  weapons?: number;
  roll?: { total: number; target?: number; rollId?: Id };
  damage?: number;
  addEffect?: boolean;
  /** Thrust spent, and whether it closes (true) or opens the range. */
  thrust?: number;
  closing?: boolean;
  /** Critical hit location: a called shot, or the system being repaired. */
  location?: string;
  salvoId?: Id;
  /** Missiles launched, or stopped by a defence that needs no roll. */
  missiles?: number;
  /** Kind of missile or torpedo, from the rules pack. */
  ammo?: string;
  note?: string;
}

export interface BattleResult {
  actionId: Id;
  targetId?: Id;
  hit?: boolean;
  effect?: number;
  dealt?: number;
  taken?: number;
  absorbed?: number;
  criticals?: { location: string; name: string; severity: number; text: string }[];
  wrecked?: boolean;
  range?: { from: string; to: string };
  salvo?: { id: Id; missiles: number; impactRound: number };
  missilesLeft?: number;
  repaired?: string;
  initiativeDm?: number;
  lock?: boolean;
  /** Power knocked out by an ion weapon, and for how many rounds. */
  powerLost?: number;
  powerRounds?: number;
  /** A hit that would have been critical, on a ship too large to notice. */
  shruggedOff?: boolean;
}

export interface BattleRecord {
  id: Id;
  round: number;
  step: BattleStepId;
  /** Battle ship that acted. */
  shipId: Id;
  by: Id;
  actions: CrewAction[];
  results: BattleResult[];
  at: number;
}

export interface Salvo {
  id: Id;
  fromId: Id;
  toId: Id;
  missiles: number;
  launched: number;
  impactRound: number;
  /** Not yet detected by the party. */
  hidden?: boolean;
  done?: boolean;
  /** Kind of missile or torpedo, from the rules pack. */
  ammo?: string;
  torpedoes?: boolean;
}

/** A fight between ships, run in rounds of three steps with each ship acting in initiative order. */
export interface Battle extends EntityBase {
  type: 'battle';
  name: string;
  status: 'setup' | 'active' | 'ended';
  open?: boolean;
  round: number;
  step: BattleStepId;
  /** The battle ship whose turn it is in this step. */
  turn?: Id;
  /** The party's ship that ranges are measured from. */
  flagship?: Id;
  ships: BattleShip[];
  /** Actions each ship's crew have queued, by battle ship id. */
  plans: Record<Id, CrewAction[]>;
  salvos: Salvo[];
  log: BattleRecord[];
}

// ───────────────────────────── inventory & cargo ─────────────────────────────

/** A named place to keep things that is not a person or a ship: a vault, a cache, a storage unit. */
export interface Stash extends EntityBase {
  type: 'stash';
  name?: string;
  /** Where it is, if anywhere in particular. */
  location?: { systemId?: Id; bodyId?: Id };
  summary?: string;
}

export type ItemCategory = 'weapon' | 'armour' | 'gear' | 'consumable' | 'cargo' | 'other';

/** Something owned: personal equipment, or a lot of cargo in a ship's hold. */
export interface Item extends EntityBase {
  type: 'item';
  /** The character, ship or stash holding it. */
  holderId: Id;
  name: string;
  category: ItemCategory;
  qty: number;
  /** Mass of one unit, in kilograms (personal gear). */
  kg?: number;
  /** Value of one unit, in credits. */
  value?: number;
  tl?: number;
  note?: string;
  tags?: string[];
  /** Carried or worn (counts towards what the character is hauling around). */
  carried?: boolean;
  /** Rules-pack entry this came from. */
  defId?: string;
  // ── cargo lots ──
  /** Size of a cargo lot, in tons (cargo is tracked by the ton, with qty 1). */
  tons?: number;
  /** Trade good code, for speculative cargo. */
  good?: number;
  /** Price paid per ton. */
  paid?: number;
  /** Where and when it was bought. */
  origin?: { systemId?: Id; day?: number; year?: number };
  /** Freight, mail and passengers carried for a fee paid on delivery. */
  freight?: { destinationId?: Id; pay: number; kind: 'freight' | 'mail' | 'passengers'; due?: { day: number; year: number } };
  illegal?: boolean;
  /** A price a buyer has quoted for this lot at a market, valid until accepted or refused. */
  saleOffer?: { marketId: Id; pct: number; price: number; fee?: number };
}

// ─────────────────────────────────── trade ───────────────────────────────────

export interface MarketLot {
  id: Id;
  /** Trade good code. */
  good: number;
  name: string;
  tons: number;
  basePrice: number;
  illegal?: boolean;
  /** A price the supplier has quoted, valid until accepted or refused. `fee` is a local broker's cut (0–1). */
  offer?: { pct: number; price: number; by?: Id; fee?: number };
  /** Set when the party walked away: no more dealing on this lot for a month. */
  refused?: { day: number; year: number };
}

/** Something a market is known to want: a story hook as much as a price. */
export interface MarketDemand {
  id: Id;
  /** What is wanted, in plain words. */
  what: string;
  /** Trade good it corresponds to, if any. */
  good?: number;
  /** Bonus to the sale roll for delivering it. */
  dm?: number;
  note?: string;
  known: Audience[];
}

/** A place to buy and sell cargo: a downport exchange, a highport, a belt station. */
export interface Market extends EntityBase {
  type: 'market';
  systemId: Id;
  bodyId?: Id;
  name?: string;
  venue: 'surface' | 'orbit' | 'station';
  blackMarket?: boolean;
  /** Broker skill of the people the party deals with. */
  broker: number;
  lots: MarketLot[];
  demands: MarketDemand[];
  /** In-game date the stock was last generated. */
  stocked?: GameDate;
}

// ─────────────────────────────────── dice ───────────────────────────────────

export interface Roll extends EntityBase {
  type: 'roll';
  playerId: Id;
  /** Who made the roll in the fiction, e.g. a character name. */
  actor?: string;
  label: string;
  dice: number[];
  /** Total modifier applied. */
  dm: number;
  total: number;
  /** Target number for a check, if any. */
  target?: number;
  /** total - target for a check. */
  effect?: number;
  /** True when the dice were rolled at the table and typed in. */
  manual?: boolean;
  /** Boon: an extra die was rolled and the lowest dropped. Bane: the highest dropped. */
  mode?: 'boon' | 'bane';
  /** The die discarded for a boon or bane. */
  dropped?: number[];
  /** What the roll was: a plain roll, a skill check, an attack or a damage roll. */
  kind?: 'roll' | 'check' | 'attack' | 'damage' | 'initiative';
  characterId?: Id;
  /** Where the modifier came from, for display. */
  breakdown?: { label: string; dm: number }[];
  /** Extra detail for damage rolls: armour piercing, multiplier and reminders. */
  detail?: string;
  /** Audiences who see the roll. Empty = GM only (a hidden roll). */
  to: Audience[];
  at: number;
}

// ───────────────────────────────── assets ───────────────────────────────────

export interface Asset extends EntityBase {
  type: 'asset';
  name: string;
  mime: string;
  size: number;
  url: string;
  uploadedBy: Id;
}

export type Entity =
  | Campaign
  | Player
  | Sector
  | StarSystem
  | Body
  | RouteLine
  | Region
  | Objective
  | WikiPage
  | Roll
  | Character
  | Ship
  | ShipDesign
  | Encounter
  | Battle
  | Stash
  | Item
  | Market
  | Asset;

export type EntityType = Entity['type'];

export type EntityOf<T extends EntityType> = Extract<Entity, { type: T }>;

/** Short id prefixes per type, to make ids readable in logs and wiki frontmatter. */
export const ID_PREFIX: Record<EntityType, string> = {
  campaign: 'cmp',
  player: 'ply',
  sector: 'sec',
  system: 'sys',
  body: 'bod',
  route: 'rte',
  region: 'reg',
  objective: 'obj',
  wikiPage: 'wik',
  roll: 'rol',
  character: 'chr',
  ship: 'shp',
  design: 'dsn',
  encounter: 'enc',
  battle: 'btl',
  stash: 'sth',
  item: 'itm',
  market: 'mkt',
  asset: 'ast',
};
