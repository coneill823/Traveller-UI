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
  asset: 'ast',
};
