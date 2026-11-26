/** Campaign-wide actions: settings, players, generic edits, knowledge reveals, notes and dice. */
import { FACETS, PRESETS, toggleAudience, withAudience, type Viewer } from '../../shared/knowledge';
import { rootField, type PatchOp } from '../../shared/patch';
import { PARTY, type Audience, type Body, type Campaign, type Character, type Encounter, type Entity, type Id, type Note, type Objective, type Player, type Roll, type StarSystem } from '../../shared/types';
import { newId, rollDice, sum } from '../../shared/util';
import { prettyCode } from '../auth';
import type { Tx } from '../state';
import { action, ActionError, check, requireGm, type ActionCtx } from './registry';

export const CAMPAIGN_ID = 'campaign';

const PLAYER_COLORS = ['#4de3ff', '#ffb347', '#7dff9b', '#ff7ab6', '#b69cff', '#ffe066', '#ff8a5c', '#5cf2d0'];

export function createCampaign(tx: Tx, name: string): Campaign {
  return tx.create('campaign', {
    id: CAMPAIGN_ID,
    name,
    date: { day: 1, year: 1105 },
    polities: [],
    settings: { defaultJump: 2, wikiAutoPublish: true },
  });
}

export function createPlayer(tx: Tx, name: string, role: 'gm' | 'player'): Player {
  const used = new Set(tx.all('player').map((p) => p.color));
  const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[tx.all('player').length % PLAYER_COLORS.length];
  return tx.create('player', { name, role, color: role === 'gm' ? '#c77dff' : color });
}

/** True when `audience` is the party or an existing player. */
export function checkAudience(tx: Tx, value: unknown, name = 'audience'): Audience {
  const audience = check.id(value, name);
  if (audience === PARTY) return audience;
  const player = tx.get(audience);
  if (!player || player.type !== 'player') throw new ActionError(`Unknown audience "${audience}"`);
  return audience;
}

// ── generic edits ──

const ALWAYS_LOCKED = new Set(['id', 'type', 'rev', 'createdAt', 'updatedAt', 'known', 'notes']);

/** Fields even the GM must change through a dedicated action, because other data depends on them. */
const GM_LOCKED: Record<string, string[]> = {
  system: ['sectorId', 'hex'],
  body: ['systemId'],
  sector: ['x', 'y'],
  route: ['a', 'b'],
  player: ['role'],
  wikiPage: ['path', 'sections', 'hash', 'frontmatter', 'tags', 'title'],
  roll: ['dice', 'total', 'dm', 'playerId', 'effect', 'target'],
  asset: ['url', 'mime', 'size', 'uploadedBy'],
  objective: ['createdBy'],
  character: ['kind'],
  item: ['holderId'],
  market: ['systemId'],
};

/** Fields a player may edit on entities they own. Returns null when the entity is not theirs to edit. */
function playerEditable(entity: Entity, me: Viewer): string[] | null {
  switch (entity.type) {
    case 'player':
      return entity.id === me.playerId ? ['name', 'color'] : null;
    case 'objective': {
      const o = entity as Objective;
      return o.createdBy === me.playerId && o.scope === me.playerId ? ['title', 'body', 'status', 'targets', 'reward'] : null;
    }
    case 'character': {
      const c = entity as Character;
      return c.kind === 'pc' && c.ownerId === me.playerId ? PLAYER_CHARACTER_FIELDS : null;
    }
    default:
      return null;
  }
}

/** Everything on their own sheet except who owns it and what kind of character it is. */
const PLAYER_CHARACTER_FIELDS = ['name', 'title', 'species', 'age', 'homeworld', 'careers', 'chars', 'skills', 'weapons', 'armour', 'credits', 'portrait', 'bio', 'secrets', 'traits', 'conditions', 'movement'];

function checkOps(value: unknown): PatchOp[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) throw new ActionError('Invalid "ops": expected a list of edits');
  for (const op of value) {
    if (typeof op !== 'object' || op === null || !Array.isArray((op as PatchOp).path)) throw new ActionError('Invalid edit operation');
  }
  return value as PatchOp[];
}

export function authorisePatch(entity: Entity, me: Viewer, ops: PatchOp[]): void {
  const allowed = me.role === 'gm' ? null : playerEditable(entity, me);
  if (me.role !== 'gm' && !allowed) throw new ActionError('You cannot edit that');
  for (const op of ops) {
    const field = rootField(op);
    if (ALWAYS_LOCKED.has(field)) throw new ActionError(`"${field}" cannot be edited directly`);
    if (field === 'gm' && me.role !== 'gm') throw new ActionError('You cannot edit that');
    if (GM_LOCKED[entity.type]?.includes(field)) throw new ActionError(`"${field}" cannot be edited directly`);
    if (allowed && !allowed.includes(field)) throw new ActionError(`You cannot edit "${field}"`);
  }
}

/** Deletes an entity together with everything that only makes sense while it exists. */
export function cascadeDelete(tx: Tx, id: Id): void {
  const entity = tx.get(id);
  if (!entity) return;
  switch (entity.type) {
    case 'sector':
      for (const system of tx.where('system', 'sectorId', id)) cascadeDelete(tx, system.id);
      break;
    case 'system':
      for (const body of tx.where('body', 'systemId', id)) tx.delete(body.id);
      for (const route of [...tx.where('route', 'a', id), ...tx.where('route', 'b', id)]) tx.delete(route.id);
      for (const market of tx.where('market', 'systemId', id)) tx.delete(market.id);
      for (const objective of tx.all('objective')) {
        if (objective.targets.some((t) => t.systemId === id)) {
          tx.update<Objective>(objective.id, (o) => {
            o.targets = o.targets.filter((t) => t.systemId !== id);
          });
        }
      }
      {
        const campaign = tx.get<Campaign>(CAMPAIGN_ID);
        if (campaign?.location?.systemId === id) tx.update<Campaign>(CAMPAIGN_ID, (c) => void delete c.location);
      }
      break;
    case 'body':
      for (const child of tx.where('body', 'parentId', id)) cascadeDelete(tx, child.id);
      break;
    case 'character':
    case 'ship':
    case 'stash':
      for (const item of tx.where('item', 'holderId', id)) tx.delete(item.id);
      // A deleted character leaves any fight it was in.
      if (entity.type === 'character') {
        for (const e of tx.all('encounter')) {
          if (!e.combatants.some((c) => c.characterId === id)) continue;
          tx.update<Encounter>(e.id, (draft) => {
            const gone = new Set(draft.combatants.filter((c) => c.characterId === id).map((c) => c.id));
            draft.combatants = draft.combatants.filter((c) => !gone.has(c.id));
            if (draft.turn && gone.has(draft.turn)) draft.turn = draft.combatants.find((c) => !c.out && !c.acted)?.id;
          });
        }
      }
      break;
    case 'campaign':
      throw new ActionError('The campaign itself cannot be deleted');
    default:
      break;
  }
  // Wiki pages survive, but stop pointing at the deleted entity.
  for (const page of tx.where('wikiPage', 'entityId', id)) {
    tx.update(page.id, (p) => void delete (p as { entityId?: Id }).entityId);
  }
  tx.delete(id);
}

action('entity.patch', (ctx, p) => {
  const id = check.id(p.id, 'id');
  const entity = ctx.tx.get(id);
  if (!entity) throw new ActionError('That no longer exists');
  const ops = checkOps(p.ops);
  authorisePatch(entity, ctx.me, ops);
  ctx.tx.patch(id, ops);
});

action('entity.delete', (ctx, p) => {
  const id = check.id(p.id, 'id');
  const entity = ctx.tx.get(id);
  if (!entity) return;
  if (ctx.me.role !== 'gm') {
    const own =
      (entity.type === 'objective' && (entity as Objective).createdBy === ctx.me.playerId && (entity as Objective).scope === ctx.me.playerId) ||
      (entity.type === 'character' && (entity as Character).kind === 'pc' && (entity as Character).ownerId === ctx.me.playerId);
    if (!own) throw new ActionError('You cannot delete that');
  }
  if (entity.type === 'player') throw new ActionError('Use the players panel to remove a player');
  cascadeDelete(ctx.tx, id);
});

// ── campaign & players ──

action('player.create', (ctx, p) => {
  requireGm(ctx.me);
  const player = createPlayer(ctx.tx, check.str(p.name, 'name', { max: 40 }), 'player');
  return { id: player.id, code: prettyCode(ctx.services.auth.inviteFor(player.id)) };
});

action('player.invite', (ctx, p) => {
  requireGm(ctx.me);
  const player = ctx.tx.need('player', check.id(p.id, 'id'));
  if (player.role === 'gm') throw new ActionError('The GM signs in with the passphrase');
  const code = p.reset ? ctx.services.auth.resetInvite(player.id) : ctx.services.auth.inviteFor(player.id);
  if (p.reset) {
    ctx.services.auth.revokeAll(player.id);
    ctx.after(() => (ctx.services.extra.hub as { disconnectPlayer(id: Id): void } | undefined)?.disconnectPlayer(player.id));
  }
  return { code: prettyCode(code) };
});

action('player.remove', (ctx, p) => {
  requireGm(ctx.me);
  const player = ctx.tx.need('player', check.id(p.id, 'id'));
  if (player.role === 'gm') throw new ActionError('The GM cannot be removed');
  // Strip the player from every knowledge list so nothing dangles.
  for (const entity of ctx.tx.state.everything()) {
    const touchesKnown = Object.values(entity.known ?? {}).some((list) => list.includes(player.id));
    const touchesNotes = entity.notes?.some((n) => n.known.includes(player.id));
    if (!touchesKnown && !touchesNotes) continue;
    ctx.tx.update(entity.id, (e) => {
      for (const facet of Object.keys(e.known ?? {})) e.known = withAudience(e.known, facet, player.id, false);
      for (const note of e.notes ?? []) note.known = note.known.filter((a) => a !== player.id);
    });
  }
  for (const objective of ctx.tx.all('objective')) if (objective.scope === player.id) ctx.tx.delete(objective.id);
  ctx.services.auth.forgetPlayer(player.id);
  ctx.tx.delete(player.id);
  ctx.after(() => (ctx.services.extra.hub as { disconnectPlayer(id: Id): void } | undefined)?.disconnectPlayer(player.id));
});

action('gm.password', (ctx, p) => {
  requireGm(ctx.me);
  ctx.services.auth.setGmPassword(check.str(p.password, 'password', { min: 6, max: 200 }));
});

// ── knowledge ──

function revealOne(tx: Tx, id: Id, facets: string[], audience: Audience, on: boolean): void {
  const entity = tx.get(id);
  if (!entity) return;
  const specs = FACETS[entity.type];
  if (!specs) throw new ActionError(`Knowledge of a ${entity.type} is not controlled by facets`);
  const valid = new Set(specs.map((s) => s.key));
  const wanted = facets.filter((f) => valid.has(f));
  if (wanted.length === 0) return;
  const current = entity.known ?? {};
  // Hiding "exists" hides everything; revealing any facet implies "exists".
  const list = on ? [...new Set(['exists', ...wanted])] : wanted.includes('exists') ? [...valid] : wanted;
  if (list.every((f) => (current[f]?.includes(audience) ?? false) === on)) return;
  tx.update(id, (e) => {
    for (const facet of list) e.known = withAudience(e.known, facet, audience, on);
  });
  if (on) revealAncestors(tx, entity, audience);
}

/** Something inside a hidden container would be invisible, so reveal the containers too. */
function revealAncestors(tx: Tx, entity: Entity, audience: Audience): void {
  if (entity.type === 'body') {
    const body = entity as Body;
    if (body.parentId) revealOne(tx, body.parentId, ['exists'], audience, true);
    revealOne(tx, body.systemId, ['exists'], audience, true);
  } else if (entity.type === 'system') {
    revealOne(tx, (entity as StarSystem).sectorId, ['exists'], audience, true);
  } else if (entity.type === 'market') {
    // Knowing about a market means knowing where it is.
    revealOne(tx, (entity as { systemId: Id }).systemId, ['exists', 'name'], audience, true);
  }
}

export function applyPreset(tx: Tx, id: Id, presetKey: string, audience: Audience): void {
  const preset = PRESETS[presetKey];
  if (!preset) throw new ActionError(`Unknown knowledge level "${presetKey}"`);
  const entity = tx.get(id);
  if (!entity) return;
  const specs = FACETS[entity.type];
  if (!specs) return;
  const all = specs.map((s) => s.key);
  const on = preset.facets.filter((f) => all.includes(f));
  const off = all.filter((f) => !on.includes(f));
  if (off.length) {
    const current = entity.known ?? {};
    if (off.some((f) => current[f]?.includes(audience))) {
      tx.update(id, (e) => {
        for (const facet of off) e.known = withAudience(e.known, facet, audience, false);
      });
    }
  }
  if (on.length) revealOne(tx, id, on, audience, true);
  // Charting a system also reveals the bodies any survey would list; hiding it hides them all.
  if (entity.type === 'system') {
    for (const body of tx.where('body', 'systemId', id)) {
      if (presetKey === 'charted') {
        if (body.origin === 'survey') applyPreset(tx, body.id, 'charted', audience);
      } else {
        applyPreset(tx, body.id, 'hidden', audience);
      }
    }
  }
}

action('reveal.set', (ctx, p) => {
  requireGm(ctx.me);
  const ids = check.arr(p.ids, 'ids', check.id, 5000);
  const facets = check.arr(p.facets, 'facets', (v, n) => check.str(v, n, { max: 40 }), 20);
  const audience = checkAudience(ctx.tx, p.audience);
  const on = check.bool(p.on, 'on');
  for (const id of ids) revealOne(ctx.tx, id, facets, audience, on);
});

action('reveal.preset', (ctx, p) => {
  requireGm(ctx.me);
  const ids = check.arr(p.ids, 'ids', check.id, 5000);
  const audience = checkAudience(ctx.tx, p.audience);
  const preset = check.str(p.preset, 'preset', { max: 20 });
  for (const id of ids) applyPreset(ctx.tx, id, preset, audience);
});

// ── notes ──

function canEditNotes(ctx: ActionCtx, _entity: Entity): void {
  requireGm(ctx.me);
}

action('note.add', (ctx, p) => {
  const entity = ctx.tx.get(check.id(p.entityId, 'entityId'));
  if (!entity) throw new ActionError('That no longer exists');
  canEditNotes(ctx, entity);
  const note: Note = {
    id: newId('note'),
    title: check.str(p.title ?? 'Note', 'title', { max: 120 }),
    body: check.text(p.body ?? '', 'body'),
    known: p.reveal ? [checkAudience(ctx.tx, p.reveal, 'reveal')] : [],
  };
  ctx.tx.update(entity.id, (e) => {
    e.notes = [...(e.notes ?? []), note];
  });
  return { id: note.id };
});

action('note.update', (ctx, p) => {
  const entity = ctx.tx.get(check.id(p.entityId, 'entityId'));
  if (!entity) throw new ActionError('That no longer exists');
  canEditNotes(ctx, entity);
  const noteId = check.id(p.noteId, 'noteId');
  ctx.tx.update(entity.id, (e) => {
    const note = e.notes?.find((n) => n.id === noteId);
    if (!note) throw new ActionError('That note no longer exists');
    if (p.title !== undefined) note.title = check.str(p.title, 'title', { max: 120 });
    if (p.body !== undefined) note.body = check.text(p.body, 'body');
  });
});

action('note.remove', (ctx, p) => {
  const entity = ctx.tx.get(check.id(p.entityId, 'entityId'));
  if (!entity) return;
  canEditNotes(ctx, entity);
  const noteId = check.id(p.noteId, 'noteId');
  ctx.tx.update(entity.id, (e) => {
    e.notes = (e.notes ?? []).filter((n) => n.id !== noteId);
  });
});

action('note.reveal', (ctx, p) => {
  requireGm(ctx.me);
  const entity = ctx.tx.get(check.id(p.entityId, 'entityId'));
  if (!entity) throw new ActionError('That no longer exists');
  const noteId = check.id(p.noteId, 'noteId');
  const audience = checkAudience(ctx.tx, p.audience);
  const on = check.bool(p.on, 'on');
  ctx.tx.update(entity.id, (e) => {
    const note = e.notes?.find((n) => n.id === noteId);
    if (!note) throw new ActionError('That note no longer exists');
    note.known = toggleAudience(note.known, audience, on);
  });
});

// ── dice ──

const MAX_ROLLS = 300;

export interface RollInput {
  label: string;
  dm: number;
  target?: number;
  /** Number of dice (before any boon/bane die). */
  dice?: number;
  mode?: 'boon' | 'bane';
  /** Dice rolled at the table and typed in (including the extra boon/bane die). */
  manual?: number[];
  secret?: boolean;
  actor?: string;
  kind?: Roll['kind'];
  characterId?: Id;
  breakdown?: Roll['breakdown'];
  detail?: string;
  /** Fixed total for rolls whose dice were resolved elsewhere (weapon damage). */
  total?: number;
  /** Dice already rolled by a rules engine; logged as rolled by the app, not as a table roll. */
  fixedDice?: number[];
}

/** Rolls (or records) dice and adds the result to the shared log. */
export function makeRoll(ctx: ActionCtx, input: RollInput): Roll {
  let dice: number[];
  if (input.fixedDice) dice = input.fixedDice;
  else if (input.manual) dice = input.manual;
  else dice = rollDice((input.dice ?? 2) + (input.mode ? 1 : 0));
  // A boon drops the lowest die, a bane the highest.
  let dropped: number[] | undefined;
  if (input.mode && dice.length > 1) {
    const sorted = [...dice].sort((a, b) => a - b);
    const drop = input.mode === 'boon' ? sorted[0] : sorted[sorted.length - 1];
    const at = dice.indexOf(drop);
    dropped = [drop];
    dice = dice.filter((_, i) => i !== at);
  }
  const total = input.total ?? sum(dice) + input.dm;
  const roll = ctx.tx.create('roll', {
    playerId: ctx.me.playerId,
    actor: input.actor,
    label: input.label,
    dice,
    dm: input.dm,
    total,
    target: input.target,
    effect: input.target === undefined ? undefined : total - input.target,
    manual: input.manual ? true : undefined,
    mode: input.mode,
    dropped,
    kind: input.kind,
    characterId: input.characterId,
    breakdown: input.breakdown,
    detail: input.detail,
    to: input.secret ? [] : [PARTY],
    at: Date.now(),
  });
  // Keep the log bounded.
  const rolls = ctx.tx.all('roll');
  if (rolls.length > MAX_ROLLS) {
    const oldest = [...rolls].sort((a: Roll, b: Roll) => a.at - b.at).slice(0, rolls.length - MAX_ROLLS);
    for (const old of oldest) ctx.tx.delete(old.id);
  }
  return roll;
}

/** Reads the dice options shared by every rolling action. */
export function rollOptions(p: any, diceNeeded = 2): Pick<RollInput, 'mode' | 'manual' | 'secret'> {
  const mode = p.mode === undefined || p.mode === null ? undefined : check.oneOf(p.mode, 'mode', ['boon', 'bane'] as const);
  let manual: number[] | undefined;
  if (p.manual !== undefined && p.manual !== null) {
    manual = check.arr(p.manual, 'manual', (v, n) => check.int(v, n, { min: 1, max: 6 }), 20);
    const needed = diceNeeded + (mode ? 1 : 0);
    if (manual.length !== needed) throw new ActionError(`Enter ${needed} dice`);
  }
  const to = p.to === undefined ? 'party' : check.oneOf(p.to, 'to', ['party', 'gm'] as const);
  return { mode, manual, secret: to === 'gm' };
}

action('dice.roll', (ctx, p) => {
  const dice = p.dice === undefined ? 2 : check.int(p.dice, 'dice', { min: 1, max: 20 });
  const roll = makeRoll(ctx, {
    label: check.str(p.label ?? 'Roll', 'label', { max: 120 }),
    dm: p.dm === undefined ? 0 : check.int(p.dm, 'dm', { min: -30, max: 30 }),
    target: p.target === undefined || p.target === null ? undefined : check.int(p.target, 'target', { min: 0, max: 40 }),
    dice,
    actor: check.optStr(p.actor, 'actor', { max: 80 }),
    ...rollOptions(p, dice),
  });
  return { id: roll.id, dice: roll.dice, dropped: roll.dropped, total: roll.total, effect: roll.effect };
});

action('dice.clear', (ctx) => {
  requireGm(ctx.me);
  for (const roll of ctx.tx.all('roll')) ctx.tx.delete(roll.id);
});

// ── GM screen control ──

action('ui.push', (ctx, p) => {
  requireGm(ctx.me);
  const path = check.str(p.path, 'path', { max: 300 });
  if (!path.startsWith('/')) throw new ActionError('Invalid path');
  ctx.emit('navigate', { path, from: ctx.me.playerId }, (v) => v.role !== 'gm');
});
