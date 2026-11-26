/**
 * Encounters: who is in the fight, initiative and turn order, tokens on the battlemap, and
 * turns that are put together privately and then published to the whole table.
 */
import type { Viewer } from '../../shared/knowledge';
import { charDm } from '../../shared/rules/character';
import type { BattleMap, Character, CharKey, CharScore, Combatant, CombatSide, Encounter, Id, TurnRecord, TurnResult, TurnStep } from '../../shared/types';
import { deepClone, newId, rollDice, sum } from '../../shared/util';
import type { Tx } from '../state';
import { inflictDamage } from './characters';
import { makeRoll } from './core';
import { action, ActionError, check, requireGm, type ActionCtx } from './registry';

const SIDES: readonly CombatSide[] = ['party', 'enemy', 'neutral'];
const STEP_TYPES = ['significant', 'minor', 'free', 'reaction'] as const;
const MAX_LOG = 400;

function needEncounter(ctx: ActionCtx, id: unknown): Encounter {
  const e = ctx.tx.need('encounter', check.id(id, 'id'));
  if (ctx.me.role !== 'gm' && e.status === 'setup' && !e.open) throw new ActionError('No encounter with that id');
  return e;
}

function needCombatant(e: Encounter, id: unknown, me: Viewer): Combatant {
  const c = e.combatants.find((x) => x.id === id);
  if (!c || (c.hidden && me.role !== 'gm')) throw new ActionError('That combatant is not in this encounter');
  return c;
}

/** Whether the caller runs this combatant: the GM runs everyone, a player their own character. */
function controls(ctx: ActionCtx, c: Combatant): boolean {
  if (ctx.me.role === 'gm') return true;
  const ch = ctx.tx.get<Character>(c.characterId);
  return !!ch && ch.kind === 'pc' && ch.ownerId === ctx.me.playerId;
}

function dexOf(tx: Tx, c: Combatant): number {
  return tx.get<Character>(c.characterId)?.chars?.DEX?.value ?? 0;
}

/** Combatants still in the fight, best initiative first; ties go to the higher DEX. */
export function turnOrder(tx: Tx, e: Encounter): Combatant[] {
  return e.combatants
    .filter((c) => !c.out)
    .map((c, index) => ({ c, index, dex: dexOf(tx, c) }))
    .sort((a, b) => (b.c.initiative ?? -99) - (a.c.initiative ?? -99) || b.dex - a.dex || a.index - b.index)
    .map((x) => x.c);
}

/** Moves play on to the next combatant who has not acted, starting a new round when everyone has. */
function advance(tx: Tx, draft: Encounter): void {
  const order = turnOrder(tx, draft);
  if (order.length === 0) {
    draft.turn = undefined;
    return;
  }
  const next = order.find((c) => !c.acted);
  if (next) {
    draft.turn = next.id;
    return;
  }
  draft.round += 1;
  for (const c of draft.combatants) c.acted = false;
  draft.turn = order[0].id;
}

/** Initiative is the Effect of a DEX or INT check, whichever characteristic is better. */
function rollInitiative(ctx: ActionCtx, c: Combatant, manual?: number): number {
  if (manual !== undefined) return manual;
  const ch = ctx.tx.get<Character>(c.characterId);
  const rules = ctx.services.rules.pack;
  const target = rules.tasks?.defaultTarget ?? 8;
  const keys = (rules.combat?.initiative.characteristics ?? ['DEX', 'INT']) as CharKey[];
  const best = keys.map((k) => ({ k, dm: charDm(ch?.chars?.[k]?.value ?? 7, rules.tasks) })).sort((a, b) => b.dm - a.dm)[0];
  if (ch?.kind === 'pc') {
    const roll = makeRoll(ctx, { label: 'Initiative', dm: best.dm, target, actor: ch.name ?? 'Traveller', kind: 'initiative', characterId: ch.id, breakdown: [{ label: best.k, dm: best.dm }] });
    return roll.effect ?? roll.total - target;
  }
  return sum(rollDice(2)) + best.dm - target;
}

function place(e: Encounter, side: CombatSide): { x: number; y: number } {
  // New arrivals line up along their own edge of the field: enemies at the top, the party at the bottom.
  const mates = e.combatants.filter((c) => c.side === side).length;
  const y = side === 'enemy' ? 0.14 : side === 'party' ? 0.86 : 0.5;
  const x = 0.12 + ((mates * 0.11) % 0.78);
  return { x: Math.round(x * 1000) / 1000, y };
}

function addCombatant(draft: Encounter, ch: Character, opts: { side?: CombatSide; label?: string; hidden?: boolean }): Combatant {
  const side = opts.side ?? (ch.kind === 'pc' ? 'party' : 'enemy');
  const c: Combatant = { id: newId('cbt'), characterId: ch.id, side, ...place(draft, side), ...(opts.label ? { label: opts.label } : {}), ...(opts.hidden ? { hidden: true } : {}) };
  draft.combatants.push(c);
  return c;
}

function cleanMap(value: unknown): BattleMap {
  const m = check.obj(value, 'map');
  const url = check.str(m.url, 'map.url', { max: 200 });
  if (!url.startsWith('/uploads/')) throw new ActionError('Battlemaps must be uploaded to this server');
  return {
    url,
    width: check.int(m.width, 'map.width', { min: 1, max: 20000 }),
    height: check.int(m.height, 'map.height', { min: 1, max: 20000 }),
    ...(m.squares !== undefined && m.squares !== null ? { squares: check.num(m.squares, 'map.squares', { min: 1, max: 400 }) } : {}),
    ...(m.showGrid ? { showGrid: true } : {}),
  };
}

function cleanStep(value: unknown, name: string): TurnStep {
  const v = check.obj(value, name);
  const step: TurnStep = {
    id: check.str(v.id, `${name}.id`, { max: 40 }),
    action: check.str(v.action, `${name}.action`, { max: 40 }),
    type: check.oneOf(v.type, `${name}.type`, STEP_TYPES),
    label: check.str(v.label, `${name}.label`, { max: 80 }),
  };
  if (v.done) step.done = true;
  if (v.targetId !== undefined && v.targetId !== null) step.targetId = check.id(v.targetId, `${name}.targetId`);
  if (v.weapon !== undefined) step.weapon = check.optStr(v.weapon, `${name}.weapon`, { max: 80 });
  if (v.roll !== undefined && v.roll !== null) {
    const r = check.obj(v.roll, `${name}.roll`);
    step.roll = { total: check.int(r.total, `${name}.roll.total`, { min: -50, max: 100 }) };
    if (r.target !== undefined && r.target !== null) step.roll.target = check.int(r.target, `${name}.roll.target`, { min: 0, max: 40 });
    if (r.dice !== undefined) step.roll.dice = check.arr(r.dice, `${name}.roll.dice`, (d, n) => check.int(d, n, { min: 1, max: 6 }), 6);
    if (r.dm !== undefined) step.roll.dm = check.int(r.dm, `${name}.roll.dm`, { min: -30, max: 30 });
    if (r.rollId !== undefined) step.roll.rollId = check.id(r.rollId, `${name}.roll.rollId`);
  }
  if (v.damage !== undefined && v.damage !== null) step.damage = check.int(v.damage, `${name}.damage`, { min: 0, max: 10000 });
  if (v.addEffect === false) step.addEffect = false;
  if (v.ap !== undefined) step.ap = check.int(v.ap, `${name}.ap`, { min: 0, max: 100 });
  if (v.stun) step.stun = true;
  if (v.apply === false) step.apply = false;
  if (v.to !== undefined && v.to !== null) {
    const to = check.obj(v.to, `${name}.to`);
    step.to = { x: check.num(to.x, `${name}.to.x`, { min: 0, max: 1 }), y: check.num(to.y, `${name}.to.y`, { min: 0, max: 1 }) };
  }
  if (v.note !== undefined) step.note = check.optStr(v.note, `${name}.note`, { max: 300 });
  return step;
}

// ── setting up ──

action('encounter.create', (ctx, p) => {
  requireGm(ctx.me);
  const e = ctx.tx.create('encounter', { name: check.optStr(p.name, 'name', { max: 80 }) ?? 'Encounter', status: 'setup', round: 0, combatants: [], log: [] });
  // The party is in most fights: start with their characters on the field.
  if (p.withParty !== false) {
    ctx.tx.update<Encounter>(e.id, (draft) => {
      for (const ch of ctx.tx.all('character')) if (ch.kind === 'pc') addCombatant(draft, ch, {});
    });
  }
  return { id: e.id };
});

action('encounter.update', (ctx, p) => {
  requireGm(ctx.me);
  const e = needEncounter(ctx, p.id);
  ctx.tx.update<Encounter>(e.id, (draft) => {
    if (p.name !== undefined) draft.name = check.str(p.name, 'name', { max: 80 });
    if (p.summary !== undefined) draft.summary = check.optStr(p.summary, 'summary', { max: 2000 });
    if (p.open !== undefined) draft.open = check.bool(p.open, 'open');
    if (p.map === null) delete draft.map;
    else if (p.map !== undefined) draft.map = cleanMap(p.map);
  });
});

/** Adds existing characters to the fight. `copies` clones a stat block so each has its own wounds. */
action('encounter.add', (ctx, p) => {
  requireGm(ctx.me);
  const e = needEncounter(ctx, p.id);
  const source = ctx.tx.need('character', check.id(p.characterId, 'characterId'));
  const copies = p.copies === undefined ? 1 : check.int(p.copies, 'copies', { min: 1, max: 20 });
  if (source.kind === 'pc' && copies > 1) throw new ActionError('There is only one of each player character');
  if (source.kind === 'pc' && e.combatants.some((c) => c.characterId === source.id)) throw new ActionError(`${source.name ?? 'That traveller'} is already in this encounter`);
  const side = p.side === undefined ? undefined : check.oneOf(p.side, 'side', SIDES);
  const label = check.optStr(p.label, 'label', { max: 60 });
  const ids: Id[] = [];
  const characters: Character[] = [source];
  for (let i = 1; i < copies; i++) {
    const { id: _id, type: _type, rev: _rev, createdAt: _c, updatedAt: _u, ...rest } = deepClone(source);
    characters.push(ctx.tx.create('character', { ...rest, name: `${source.name ?? 'Unnamed'} ${i + 1}`, weapons: rest.weapons?.map((w) => ({ ...w, id: newId('wpn') })), armour: rest.armour?.map((a) => ({ ...a, id: newId('arm') })) }));
  }
  ctx.tx.update<Encounter>(e.id, (draft) => {
    characters.forEach((ch, i) => {
      const c = addCombatant(draft, ch, { side, hidden: !!p.hidden, label: label ? (copies > 1 ? `${label} ${i + 1}` : label) : undefined });
      if (draft.status === 'active') c.initiative = rollInitiative(ctx, c);
      ids.push(c.id);
    });
  });
  return { combatantIds: ids };
});

/** Makes up an NPC or creature on the spot and drops it into the fight. */
action('encounter.addNpc', (ctx, p) => {
  requireGm(ctx.me);
  const e = needEncounter(ctx, p.id);
  const name = check.str(p.name, 'name', { max: 60 });
  const kind = check.oneOf(p.kind ?? 'npc', 'kind', ['npc', 'creature'] as const);
  const copies = p.copies === undefined ? 1 : check.int(p.copies, 'copies', { min: 1, max: 20 });
  const side = check.oneOf(p.side ?? 'enemy', 'side', SIDES);
  const chars: Partial<Record<CharKey, CharScore>> = {};
  for (const key of ['STR', 'DEX', 'END', 'INT', 'EDU', 'SOC'] as CharKey[]) {
    const score = p.chars?.[key] === undefined ? 7 : check.int(p.chars[key], `chars.${key}`, { min: 0, max: 60 });
    chars[key] = { value: score, max: score };
  }
  const skills: Record<string, number> = {};
  if (p.skills !== undefined) for (const [skill, level] of Object.entries(check.obj(p.skills, 'skills'))) skills[check.str(skill, 'skill', { max: 60 })] = check.int(level, `skills.${skill}`, { min: 0, max: 6 });
  const gear = ctx.services.rules.pack.gear;
  const weapons = p.weapons === undefined ? [] : check.arr(p.weapons, 'weapons', (w, n) => {
    if (typeof w === 'string') {
      const def = gear?.weapons.find((x) => x.id === w);
      if (!def) throw new ActionError(`Weapon "${w}" is not in the catalogue`);
      return { defId: def.id, name: def.name, skill: def.skill, damage: def.damage, range: def.range, traits: def.traits, magazine: def.magazine, ammo: typeof def.magazine === 'number' ? def.magazine : undefined };
    }
    const o = check.obj(w, n);
    return { name: check.str(o.name, `${n}.name`, { max: 60 }), skill: check.optStr(o.skill, `${n}.skill`, { max: 60 }) ?? 'Melee (unarmed)', damage: check.str(o.damage, `${n}.damage`, { max: 20 }), range: o.range === undefined || o.range === 'melee' ? ('melee' as const) : check.num(o.range, `${n}.range`, { min: 0, max: 100000 }) };
  }, 6);
  const protection = p.armour === undefined ? 0 : check.int(p.armour, 'armour', { min: 0, max: 60 });
  const ids: Id[] = [];
  const created: Character[] = [];
  for (let i = 0; i < copies; i++) {
    created.push(
      ctx.tx.create('character', {
        kind,
        name: copies > 1 ? `${name} ${i + 1}` : name,
        title: check.optStr(p.title, 'title', { max: 120 }),
        chars: deepClone(chars),
        skills: { ...skills },
        weapons: weapons.map((w) => ({ ...w, id: newId('wpn') })),
        armour: protection > 0 ? [{ id: newId('arm'), name: kind === 'creature' ? 'Hide' : 'Armour', protection, worn: true }] : [],
        credits: 0,
        traits: [],
        careers: [],
        conditions: [],
        movement: p.movement === undefined ? (ctx.services.rules.pack.combat?.movement ?? 6) : check.int(p.movement, 'movement', { min: 0, max: 200 }),
      }),
    );
  }
  ctx.tx.update<Encounter>(e.id, (draft) => {
    for (const ch of created) {
      const c = addCombatant(draft, ch, { side, hidden: !!p.hidden, label: ch.name });
      if (draft.status === 'active') c.initiative = rollInitiative(ctx, c);
      ids.push(c.id);
    }
  });
  return { combatantIds: ids, characterIds: created.map((c) => c.id) };
});

action('encounter.remove', (ctx, p) => {
  requireGm(ctx.me);
  const e = needEncounter(ctx, p.id);
  ctx.tx.update<Encounter>(e.id, (draft) => {
    draft.combatants = draft.combatants.filter((c) => c.id !== p.combatantId);
    if (draft.turn === p.combatantId) advance(ctx.tx, draft);
  });
});

/** Edits a combatant. Players can set their own initiative (rolled at the table) and conditions. */
action('encounter.combatant', (ctx, p) => {
  const e = needEncounter(ctx, p.id);
  const c = needCombatant(e, p.combatantId, ctx.me);
  const gm = ctx.me.role === 'gm';
  if (!controls(ctx, c)) throw new ActionError('That is not your character');
  const patch = check.obj(p.patch, 'patch');
  for (const key of Object.keys(patch)) {
    if (!['label', 'side', 'hidden', 'out', 'initiative', 'conditions', 'acted', 'reactions'].includes(key)) throw new ActionError(`"${key}" cannot be changed`);
    if (!gm && !['initiative', 'conditions'].includes(key)) throw new ActionError(`Only the GM can change a combatant's ${key}`);
  }
  ctx.tx.update<Encounter>(e.id, (draft) => {
    const d = draft.combatants.find((x) => x.id === c.id)!;
    if (patch.label !== undefined) d.label = check.optStr(patch.label, 'label', { max: 60 });
    if (patch.side !== undefined) d.side = check.oneOf(patch.side, 'side', SIDES);
    if (patch.hidden !== undefined) d.hidden = check.bool(patch.hidden, 'hidden') || undefined;
    if (patch.initiative !== undefined) d.initiative = patch.initiative === null ? undefined : check.int(patch.initiative, 'initiative', { min: -30, max: 60 });
    if (patch.conditions !== undefined) d.conditions = check.arr(patch.conditions, 'conditions', (v, n) => check.str(v, n, { max: 30 }), 8);
    if (patch.acted !== undefined) d.acted = check.bool(patch.acted, 'acted');
    if (patch.reactions !== undefined) d.reactions = check.int(patch.reactions, 'reactions', { min: 0, max: 20 });
    if (patch.out !== undefined) {
      d.out = check.bool(patch.out, 'out') || undefined;
      if (d.out && draft.turn === d.id) {
        d.acted = true;
        advance(ctx.tx, draft);
      }
    }
  });
});

/** Rolls initiative: for one combatant (their player or the GM), or for everyone who has none (GM). */
action('encounter.initiative', (ctx, p) => {
  const e = needEncounter(ctx, p.id);
  if (p.combatantId !== undefined) {
    const c = needCombatant(e, p.combatantId, ctx.me);
    if (!controls(ctx, c)) throw new ActionError('That is not your character');
    const value = rollInitiative(ctx, c);
    ctx.tx.update<Encounter>(e.id, (draft) => void (draft.combatants.find((x) => x.id === c.id)!.initiative = value));
    return { initiative: value };
  }
  requireGm(ctx.me);
  ctx.tx.update<Encounter>(e.id, (draft) => {
    for (const c of draft.combatants) if (c.initiative === undefined || p.reroll) c.initiative = rollInitiative(ctx, c);
  });
  return {};
});

action('encounter.start', (ctx, p) => {
  requireGm(ctx.me);
  const e = needEncounter(ctx, p.id);
  if (e.combatants.length === 0) throw new ActionError('Add someone to the encounter first');
  ctx.tx.update<Encounter>(e.id, (draft) => {
    for (const c of draft.combatants) {
      if (c.initiative === undefined) c.initiative = rollInitiative(ctx, c);
      c.acted = false;
      c.reactions = 0;
    }
    draft.status = 'active';
    draft.round = 1;
    draft.turn = turnOrder(ctx.tx, draft)[0]?.id;
  });
  // Bring every player's screen to the fight.
  ctx.emit('navigate', { path: `/combat/${e.id}`, from: ctx.me.playerId, note: `Combat has begun: ${e.name}` }, (v) => v.role !== 'gm');
});

action('encounter.end', (ctx, p) => {
  requireGm(ctx.me);
  const e = needEncounter(ctx, p.id);
  ctx.tx.update<Encounter>(e.id, (draft) => {
    draft.status = p.reopen ? 'active' : 'ended';
    if (!p.reopen) draft.turn = undefined;
    else if (!draft.turn) advance(ctx.tx, draft);
  });
});

/** The GM moves play on: to a named combatant, or to whoever is next. */
action('encounter.next', (ctx, p) => {
  requireGm(ctx.me);
  const e = needEncounter(ctx, p.id);
  if (e.status !== 'active') throw new ActionError('The encounter is not under way');
  ctx.tx.update<Encounter>(e.id, (draft) => {
    if (p.combatantId !== undefined) {
      const c = draft.combatants.find((x) => x.id === p.combatantId);
      if (!c) throw new ActionError('That combatant is not in this encounter');
      draft.turn = c.id;
      return;
    }
    const current = draft.combatants.find((x) => x.id === draft.turn);
    if (current) current.acted = true;
    advance(ctx.tx, draft);
  });
});

/** Drags a token. The GM moves anyone; players move their own character. */
action('encounter.move', (ctx, p) => {
  const e = needEncounter(ctx, p.id);
  const c = needCombatant(e, p.combatantId, ctx.me);
  if (!controls(ctx, c)) throw new ActionError('You can only move your own token');
  const x = check.num(p.x, 'x', { min: 0, max: 1 });
  const y = check.num(p.y, 'y', { min: 0, max: 1 });
  ctx.tx.update<Encounter>(e.id, (draft) => {
    const d = draft.combatants.find((k) => k.id === c.id)!;
    d.x = x;
    d.y = y;
  });
});

// ── turns ──

function resolve(ctx: ActionCtx, draft: Encounter, actor: Combatant, steps: TurnStep[]): TurnResult[] {
  const pack = ctx.services.rules.pack;
  const attackTarget = pack.combat?.attackTarget ?? 8;
  const results: TurnResult[] = [];
  for (const step of steps) {
    const result: TurnResult = { stepId: step.id };
    let used = false;
    if (step.to) {
      result.from = { x: actor.x ?? 0.5, y: actor.y ?? 0.5 };
      result.to = step.to;
      actor.x = step.to.x;
      actor.y = step.to.y;
      used = true;
    }
    const target = step.targetId ? draft.combatants.find((c) => c.id === step.targetId) : undefined;
    if (step.targetId && !target) throw new ActionError('A target of this turn is no longer in the encounter');
    if (target) {
      result.targetId = target.id;
      used = true;
    }
    if (step.roll) {
      const needed = step.roll.target ?? (step.action === 'attack' ? attackTarget : (pack.tasks?.defaultTarget ?? 8));
      result.effect = step.roll.total - needed;
      result.hit = result.effect >= 0;
      used = true;
    }
    if (step.action === 'attack' && target && step.damage !== undefined && result.hit !== false) {
      const effect = Math.max(0, result.effect ?? 0);
      result.dealt = step.damage + (step.addEffect === false ? 0 : effect);
      const ch = ctx.tx.get<Character>(target.characterId);
      if (ch && step.apply !== false) {
        const r = inflictDamage(ctx.tx, ch, result.dealt, { ap: step.ap ?? 0, stun: !!step.stun, effect }, pack);
        result.taken = r.taken;
        result.absorbed = r.absorbed;
        result.status = r.status;
        if (r.status === 'unconscious' || r.status === 'dead') {
          target.out = true;
          target.acted = true;
        }
      }
    }
    if (used) results.push(result);
  }
  return results;
}

/**
 * Publishes a turn: the steps taken, in order, with the rolls that were made for them. Moves the
 * token, takes damage off targets, logs it for everyone to replay and passes play on.
 */
action('encounter.publish', (ctx, p) => {
  const e = needEncounter(ctx, p.id);
  if (e.status !== 'active') throw new ActionError('The encounter is not under way');
  const c = needCombatant(e, p.combatantId, ctx.me);
  const gm = ctx.me.role === 'gm';
  if (!controls(ctx, c)) throw new ActionError('That is not your character');
  if (!gm && e.turn !== c.id) throw new ActionError('It is not your turn yet');
  const steps = check.arr(p.steps, 'steps', cleanStep, 16);
  if (new Set(steps.map((s) => s.id)).size !== steps.length) throw new ActionError('Two steps share an id');
  let record: TurnRecord | undefined;
  ctx.tx.update<Encounter>(e.id, (draft) => {
    const actor = draft.combatants.find((x) => x.id === c.id)!;
    const results = resolve(ctx, draft, actor, steps);
    record = { id: newId('trn'), round: draft.round, combatantId: c.id, by: ctx.me.playerId, steps, results, at: Date.now() };
    draft.log.push(record);
    if (draft.log.length > MAX_LOG) draft.log.splice(0, draft.log.length - MAX_LOG);
    actor.acted = true;
    actor.reactions = 0;
    // Aiming lasts only as long as the aim is held.
    actor.conditions = (actor.conditions ?? []).filter((x) => !/^Aiming/.test(x) || steps.some((s) => s.action === 'aim'));
    if (draft.turn === c.id || !draft.combatants.some((x) => x.id === draft.turn && !x.out)) advance(ctx.tx, draft);
  });
  ctx.emit('encounter.turn', { encounterId: e.id, recordId: record!.id }, c.hidden ? (v) => v.role === 'gm' : undefined);
  return { recordId: record!.id };
});

/** A reaction made on someone else's turn: dodge, parry or dive for cover. */
action('encounter.react', (ctx, p) => {
  const e = needEncounter(ctx, p.id);
  if (e.status !== 'active') throw new ActionError('The encounter is not under way');
  const c = needCombatant(e, p.combatantId, ctx.me);
  if (!controls(ctx, c)) throw new ActionError('That is not your character');
  const def = ctx.services.rules.pack.combat?.actions.find((a) => a.id === p.action && a.type === 'reaction');
  const label = def?.name ?? check.str(p.label, 'label', { max: 60 });
  let recordId = '';
  ctx.tx.update<Encounter>(e.id, (draft) => {
    const actor = draft.combatants.find((x) => x.id === c.id)!;
    actor.reactions = (actor.reactions ?? 0) + 1;
    const record: TurnRecord = { id: newId('trn'), round: draft.round, combatantId: c.id, by: ctx.me.playerId, reaction: true, steps: [{ id: newId('stp'), action: def?.id ?? 'custom', type: 'reaction', label, done: true }], results: [], at: Date.now() };
    recordId = record.id;
    draft.log.push(record);
  });
  ctx.emit('encounter.turn', { encounterId: e.id, recordId }, c.hidden ? (v) => v.role === 'gm' : undefined);
  return { recordId };
});
