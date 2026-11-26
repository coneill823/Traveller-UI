/** Messages exchanged over the WebSocket between a client and the server. */
import type { Entity, Id } from './types';

export interface Me {
  playerId: Id;
  role: 'gm' | 'player';
  /** When the GM previews a player's view: the player id being impersonated (or '__party__'). */
  viewAs?: Id;
}

export type ClientMessage =
  | { t: 'hello'; token: string; viewAs?: Id }
  | { t: 'act'; id: number; type: string; p: unknown }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'welcome'; me: Me; serverTime: number; version: string }
  /** Full replacement of everything the viewer can see. */
  | { t: 'snap'; ents: Entity[] }
  /** Incremental change: entities to insert/replace and ids to remove. */
  | { t: 'patch'; up: Entity[]; del: Id[] }
  | { t: 'res'; id: number; ok: true; data?: unknown }
  | { t: 'res'; id: number; ok: false; err: string }
  /** Ephemeral event that is not stored: presence, pushed navigation, replays. */
  | { t: 'ev'; ev: string; d: unknown }
  | { t: 'err'; code: 'auth' | 'bad-message'; msg: string }
  | { t: 'pong' };

export interface PresenceEvent {
  online: Id[];
}

/** GM asks every player's screen to open a view. */
export interface NavigateEvent {
  path: string;
  from: Id;
  /** What to tell the player about why their screen changed. */
  note?: string;
}

export interface StatusResponse {
  needsSetup: boolean;
  campaignName?: string;
  version: string;
  rulesPacks: string[];
}

export const APP_VERSION = '0.1.0';
