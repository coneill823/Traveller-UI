/**
 * Ship operations: crew stations, hits and faults on a ship's status board, and battles between
 * ships, where each crew member queues the actions of their station and the ship acts as one.
 */
import type { Viewer } from '../../shared/knowledge';
import { skillLevel } from '../../shared/rules/character';
import { evaluateDesign, shipFigures, specFromStock, arrangeParts } from '../../shared/rules/ship';
import { effectiveThrust, locationApplies, locationName, missileFlight, partsAt, resolveHit, stepRange, type HitInput, type HitOutcome, type ShipState } from '../../shared/rules/space';
import type { SpaceRules } from '../../shared/rulepack';
import type { Battle, BattleRecord, BattleResult, BattleShip, BattleStepId, Character, CombatSide, CrewAction, Id, Ship, ShipAlert } from '../../shared/types';
import { deepClone, newId, rollDice, sum } from '../../shared/util';
import type { Tx } from '../state';
import { applyPreset, checkAudience } from './core';
import { action, ActionError, check, requireGm, type ActionCtx } from './registry';

const SIDES: readonly CombatSide[] = ['party', 'enemy', 'neutral'];
const STEPS: readonly BattleStepId[] = ['manoeuvre', 'attack', 'actions'];
const MAX_ALERTS = 60;
const MAX_LOG = 300;

function spaceRules(ctx: ActionCtx): SpaceRules {
  const rules = ctx.services.rules.pack.space;
  if (!rules) throw new ActionError('No space combat rules are loaded. Add a rules pack with a space section.');
  return rules;
}

/** A crew member of a party ship, or the GM. */
function crewOf(me: Viewer, ship: Ship): boolean {
  return me.role === 'gm' || ship.party === true;
}

function stateOf(ctx: ActionCtx, ship: Ship): ShipState {
  const perPoint = ctx.services.rules.pack.ships?.hull.tonsPerHullPoint ?? 2.5;
  const hullMax = ship.hullMax ?? Math.max(1, Math.floor((ship.tons ?? 100) / perPoint));
  return { hull: ship.hull ?? hullMax, hullMax, armour: ship.armour ?? 0, fuel: ship.fuel, crits: { ...(ship.crits ?? {}) } };
}

function pushAlerts(draft: Ship, alerts: ShipAlert[]): void {
  draft.alerts = [...(draft.alerts ?? []), ...alerts].slice(-MAX_ALERTS);
}

/** Writes the outcome of a hit to the ship's record and raises the alerts that go with it. */
function applyOutcome(ctx: ActionCtx, ship: Ship, outcome: HitOutcome, source: { attacker?: string; weapon?: string }): Id[] {
  const now = Date.now();
  const alerts: ShipAlert[] = [];
  const from = [source.weapon, source.attacker ? `from ${source.attacker}` : ''].filter(Boolean).join(' ');
  if (outcome.taken > 0 || outcome.absorbed > 0) {
    alerts.push({
      id: newId('alr'),
      kind: 'hit',
      title: outcome.taken > 0 ? `Hit${from ? `: ${from}` : ''}` : `Hit stopped by armour${from ? `: ${from}` : ''}`,
      text: outcome.taken > 0 ? `${outcome.taken} damage to the hull${outcome.absorbed ? `, ${outcome.absorbed} stopped by armour` : ''}.` : undefined,
      at: now,
    });
  }
  for (const c of outcome.criticals) {
    const extra = [c.extraDamage ? `${c.extraDamage} more damage to the hull` : '', c.armourLost ? `${c.armourLost} armour lost` : '', c.fuelLost ? `${c.fuelLost} tons of fuel lost` : ''].filter(Boolean).join('; ');
    alerts.push({
      id: newId('alr'),
      kind: 'critical',
      location: c.location,
      partId: partsAt(ship.spec, c.location)[0],
      severity: c.severity,
      title: `${c.name}: ${c.sustained ? 'damage' : 'critical hit'}, severity ${c.severity}`,
      text: [c.text, extra ? `(${extra})` : ''].filter(Boolean).join(' '),
      at: now,
    });
  }
  if (outcome.wrecked) alerts.push({ id: newId('alr'), kind: 'hit', title: 'The ship is wrecked', text: 'Hull reduced to nothing: no power, no life support.', at: now });
  ctx.tx.update<Ship>(ship.id, (draft) => {
    draft.hull = outcome.hull;
    draft.hullMax = outcome.hullMax;
    draft.armour = outcome.armour;
    if (outcome.fuel !== undefined) draft.fuel = outcome.fuel;
    draft.crits = outcome.crits;
    // A fresh critical on a patched-up location undoes the patch.
    const struck = new Set(outcome.criticals.map((c) => c.location));
    if (draft.repaired) draft.repaired = draft.repaired.filter((l) => !struck.has(l));
    pushAlerts(draft, alerts);
  });
  if (alerts.length) ctx.emit('ship.alert', { shipId: ship.id, alertIds: alerts.map((a) => a.id) }, ship.party ? undefined : (v) => v.role === 'gm');
  return alerts.map((a) => a.id);
}

// ───────────────────────────── ship status ─────────────────────────────

/** Creates a ship straight from a stock design: an NPC vessel, or a ship the party already owns. */
action('ship.fromStock', (ctx, p) => {
  requireGm(ctx.me);
  const rules = ctx.services.rules.pack.ships;
  if (!rules) throw new ActionError('No ship construction rules are loaded');
  const stock = rules.designs.find((d) => d.id === check.str(p.stock, 'stock', { max: 60 }));
  if (!stock) throw new ActionError('That stock design is not in the rules pack');
  const spec = arrangeParts(rules, specFromStock(stock));
  const figures = shipFigures(evaluateDesign(rules, spec));
  const ship = ctx.tx.create('ship', {
    name: check.optStr(p.name, 'name', { max: 80 }) ?? stock.name,
    className: stock.type ? `${stock.name} (${stock.type})` : stock.name,
    party: p.party === true,
    ...figures,
    hull: figures.hullMax,
    fuel: figures.fuelCapacity,
    funds: 0,
    spec,
    summary: stock.summary,
  });
  if (!ship.party && p.reveal) applyPreset(ctx.tx, ship.id, check.str(p.reveal.preset, 'reveal.preset', { max: 20 }), checkAudience(ctx.tx, p.reveal.audience, 'reveal.audience'));
  return { id: ship.id };
});

/** Puts a character at a station (or takes them off: duty null). Players assign their own characters. */
action('ship.duty', (ctx, p) => {
  const ship = ctx.tx.need('ship', check.id(p.shipId, 'shipId'));
  if (!crewOf(ctx.me, ship)) throw new ActionError('That is not your ship');
  const ch = ctx.tx.need('character', check.id(p.characterId, 'characterId'));
  if (ctx.me.role !== 'gm' && !(ch.kind === 'pc' && ch.ownerId === ctx.me.playerId)) throw new ActionError('You can only assign your own character');
  const duties = ctx.services.rules.pack.space?.duties ?? [];
  const duty = p.duty === null || p.duty === undefined ? undefined : check.str(p.duty, 'duty', { max: 40 });
  const def = duties.find((d) => d.id === duty);
  if (duty && duties.length && !def) throw new ActionError('There is no such duty');
  const mount = p.mount === undefined || p.mount === null ? undefined : check.str(p.mount, 'mount', { max: 40 });
  ctx.tx.update<Ship>(ship.id, (draft) => {
    const next = { ...(draft.duties ?? {}) };
    if (!duty) {
      delete next[ch.id];
    } else {
      // One pilot, one captain: whoever takes the seat displaces the last occupant.
      if (def?.single) for (const [id, d] of Object.entries(next)) if (d.duty === duty && id !== ch.id) delete next[id];
      next[ch.id] = { duty, ...(mount ? { mount } : {}) };
    }
    draft.duties = next;
  });
});

/** The GM lands a hit on a ship: hull, armour and any critical hits are worked out and shown to the crew. */
action('ship.hit', (ctx, p) => {
  requireGm(ctx.me);
  const rules = spaceRules(ctx);
  const ship = ctx.tx.need('ship', check.id(p.shipId, 'shipId'));
  const hit: HitInput = {
    damage: check.num(p.damage, 'damage', { min: 0, max: 100000 }),
    effect: p.effect === undefined ? undefined : check.int(p.effect, 'effect', { min: -20, max: 40 }),
    location: p.location === undefined || p.location === null ? undefined : check.str(p.location, 'location', { max: 40 }),
    multiplier: p.multiplier === undefined ? undefined : check.num(p.multiplier, 'multiplier', { min: 0, max: 100 }),
    ignoreArmour: !!p.ignoreArmour,
    extraArmour: p.extraArmour === undefined ? undefined : check.int(p.extraArmour, 'extraArmour', { min: 0, max: 200 }),
    noCritical: !!p.noCritical,
  };
  if (hit.location && !rules.criticals.locations.some((l) => l.id === hit.location)) throw new ActionError('There is no such location');
  const outcome = resolveHit(rules, stateOf(ctx, ship), hit, { applies: (l) => locationApplies(ship, l) });
  const alertIds = applyOutcome(ctx, ship, outcome, { attacker: check.optStr(p.attacker, 'attacker', { max: 60 }), weapon: check.optStr(p.weapon, 'weapon', { max: 60 }) });
  return { taken: outcome.taken, absorbed: outcome.absorbed, hull: outcome.hull, criticals: outcome.criticals, wrecked: outcome.wrecked, alertIds };
});

/** The GM breaks something without a shot being fired: a fault, sabotage, wear and tear. */
action('ship.fault', (ctx, p) => {
  requireGm(ctx.me);
  const ship = ctx.tx.need('ship', check.id(p.shipId, 'shipId'));
  const rules = ctx.services.rules.pack.space;
  const location = p.location === undefined || p.location === null ? undefined : check.str(p.location, 'location', { max: 40 });
  if (location && rules && !rules.criticals.locations.some((l) => l.id === location)) throw new ActionError('There is no such location');
  const severity = p.severity === undefined || p.severity === null ? undefined : check.int(p.severity, 'severity', { min: 1, max: rules?.criticals.maxSeverity ?? 6 });
  const partId = p.partId === undefined || p.partId === null ? (location ? partsAt(ship.spec, location)[0] : undefined) : check.str(p.partId, 'partId', { max: 40 });
  const effect = location && severity && rules ? rules.criticals.effects[location]?.[severity - 1]?.text : undefined;
  const title = check.optStr(p.title, 'title', { max: 120 }) ?? (location && rules ? `${locationName(rules, location)} fault${severity ? `, severity ${severity}` : ''}` : 'System fault');
  const alert: ShipAlert = { id: newId('alr'), kind: 'fault', location, partId, severity, title, text: [check.optStr(p.text, 'text', { max: 600 }), effect].filter(Boolean).join(' ') || undefined, at: Date.now() };
  ctx.tx.update<Ship>(ship.id, (draft) => {
    // A fault with a severity behaves like a critical hit on that location, without the hull damage.
    if (location && severity) {
      draft.crits = { ...(draft.crits ?? {}), [location]: Math.max(draft.crits?.[location] ?? 0, severity) };
      if (draft.repaired) draft.repaired = draft.repaired.filter((l) => l !== location);
    }
    pushAlerts(draft, [alert]);
  });
  ctx.emit('ship.alert', { shipId: ship.id, alertIds: [alert.id] }, ship.party ? undefined : (v) => v.role === 'gm');
  return { alertId: alert.id };
});

/** Patches up, fully fixes or un-patches a damaged location. Patching is what a quick repair in combat does. */
action('ship.repair', (ctx, p) => {
  requireGm(ctx.me);
  const ship = ctx.tx.need('ship', check.id(p.shipId, 'shipId'));
  const mode = check.oneOf(p.mode ?? 'patch', 'mode', ['patch', 'unpatch', 'fix', 'restore'] as const);
  const location = mode === 'restore' ? undefined : check.str(p.location, 'location', { max: 40 });
  const figures = ship.spec && ctx.services.rules.pack.ships ? shipFigures(evaluateDesign(ctx.services.rules.pack.ships, ship.spec)) : undefined;
  ctx.tx.update<Ship>(ship.id, (draft) => {
    const repaired = new Set(draft.repaired ?? []);
    if (mode === 'restore') {
      // Out of the yard as good as new.
      draft.crits = {};
      draft.repaired = [];
      draft.hull = draft.hullMax ?? figures?.hullMax;
      if (figures) draft.armour = figures.armour;
      draft.alerts = (draft.alerts ?? []).map((a) => ({ ...a, cleared: true }));
      return;
    }
    if (mode === 'patch') repaired.add(location!);
    if (mode === 'unpatch') repaired.delete(location!);
    if (mode === 'fix') {
      repaired.delete(location!);
      const crits = { ...(draft.crits ?? {}) };
      delete crits[location!];
      draft.crits = crits;
      draft.alerts = (draft.alerts ?? []).map((a) => (a.location === location ? { ...a, cleared: true } : a));
    }
    draft.repaired = [...repaired];
  });
});

/** Acknowledges alerts so they stop flashing. Any of the crew can do this on their own ship. */
action('ship.clearAlerts', (ctx, p) => {
  const ship = ctx.tx.need('ship', check.id(p.shipId, 'shipId'));
  if (!crewOf(ctx.me, ship)) throw new ActionError('That is not your ship');
  const only = p.alertId === undefined ? undefined : check.id(p.alertId, 'alertId');
  ctx.tx.update<Ship>(ship.id, (draft) => {
    draft.alerts = (draft.alerts ?? []).map((a) => (!only || a.id === only ? { ...a, cleared: true } : a));
  });
});

// ───────────────────────────── battles ─────────────────────────────

function needBattle(ctx: ActionCtx, id: unknown): Battle {
  const b = ctx.tx.need('battle', check.id(id, 'id'));
  if (ctx.me.role !== 'gm' && b.status === 'setup' && !b.open) throw new ActionError('No battle with that id');
  return b;
}

function needBattleShip(b: Battle, id: unknown, me: Viewer): BattleShip {
  const s = b.ships.find((x) => x.id === id);
  if (!s || (s.hidden && me.role !== 'gm')) throw new ActionError('That ship is not in this battle');
  return s;
}

/** Whether the caller is aboard: the GM runs every ship, players the party's. */
function aboard(ctx: ActionCtx, s: BattleShip): boolean {
  if (ctx.me.role === 'gm') return true;
  const ship = s.shipId ? ctx.tx.get<Ship>(s.shipId) : undefined;
  return !!ship && ship.party === true;
}

function initiativeOf(s: BattleShip): number {
  return (s.initiative ?? -99) + (s.initiativeDm ?? 0);
}

export function battleOrder(b: Battle): BattleShip[] {
  return b.ships
    .filter((s) => !s.out)
    .map((s, index) => ({ s, index }))
    .sort((a, z) => initiativeOf(z.s) - initiativeOf(a.s) || a.index - z.index)
    .map((x) => x.s);
}

function thrustOf(ctx: ActionCtx, s: BattleShip): number {
  const rules = ctx.services.rules.pack.space;
  const ship = s.shipId ? ctx.tx.get<Ship>(s.shipId) : undefined;
  const thrust = ship?.thrust ?? s.quick?.thrust ?? 0;
  const crits = ship?.crits ?? s.quick?.crits;
  return rules ? effectiveThrust(rules, thrust, crits, ship?.repaired) : thrust;
}

function pilotSkill(ctx: ActionCtx, s: BattleShip): number {
  const ship = s.shipId ? ctx.tx.get<Ship>(s.shipId) : undefined;
  if (!ship) return s.quick?.pilot ?? 0;
  const entry = Object.entries(ship.duties ?? {}).find(([, d]) => d.duty === 'pilot');
  const pilot = entry ? ctx.tx.get<Character>(entry[0]) : undefined;
  if (!pilot) return s.quick?.pilot ?? 0;
  const levels = Object.keys(pilot.skills ?? {})
    .filter((k) => /^Pilot/i.test(k))
    .map((k) => skillLevel(pilot.skills, k) ?? 0);
  return levels.length ? Math.max(...levels) : (ctx.services.rules.pack.tasks?.unskilledDm ?? -3);
}

/** 2D + the pilot's skill + the ship's Thrust. */
function rollShipInitiative(ctx: ActionCtx, s: BattleShip): number {
  return sum(rollDice(2)) + pilotSkill(ctx, s) + thrustOf(ctx, s);
}

/** Passes play to the next ship in this step, then the next step, then the next round. */
function advance(draft: Battle): void {
  const order = battleOrder(draft);
  if (order.length === 0) {
    draft.turn = undefined;
    return;
  }
  const next = order.find((s) => !s.acted);
  if (next) {
    draft.turn = next.id;
    return;
  }
  for (const s of draft.ships) s.acted = false;
  const at = STEPS.indexOf(draft.step);
  if (at < STEPS.length - 1) {
    draft.step = STEPS[at + 1];
  } else {
    draft.step = STEPS[0];
    draft.round += 1;
    for (const s of draft.ships) {
      s.initiativeDm = s.nextInitiativeDm;
      delete s.nextInitiativeDm;
    }
  }
  draft.turn = battleOrder(draft)[0]?.id;
}

function cleanAction(value: unknown, name: string, me: Viewer): CrewAction {
  const v = check.obj(value, name);
  const a: CrewAction = {
    id: check.str(v.id, `${name}.id`, { max: 40 }),
    step: check.oneOf(v.step, `${name}.step`, [...STEPS, 'reaction'] as const),
    action: check.str(v.action, `${name}.action`, { max: 40 }),
    duty: check.str(v.duty, `${name}.duty`, { max: 40 }),
    label: check.str(v.label, `${name}.label`, { max: 80 }),
    by: me.playerId,
  };
  if (v.characterId !== undefined && v.characterId !== null) a.characterId = check.id(v.characterId, `${name}.characterId`);
  if (v.done) a.done = true;
  if (v.targetId !== undefined && v.targetId !== null) a.targetId = check.id(v.targetId, `${name}.targetId`);
  if (v.mount !== undefined && v.mount !== null) a.mount = check.str(v.mount, `${name}.mount`, { max: 40 });
  if (v.weapon !== undefined && v.weapon !== null) a.weapon = check.str(v.weapon, `${name}.weapon`, { max: 60 });
  if (v.weapons !== undefined) a.weapons = check.int(v.weapons, `${name}.weapons`, { min: 1, max: 12 });
  if (v.roll !== undefined && v.roll !== null) {
    const r = check.obj(v.roll, `${name}.roll`);
    a.roll = { total: check.int(r.total, `${name}.roll.total`, { min: -50, max: 100 }) };
    if (r.target !== undefined && r.target !== null) a.roll.target = check.int(r.target, `${name}.roll.target`, { min: 0, max: 40 });
    if (r.rollId !== undefined) a.roll.rollId = check.id(r.rollId, `${name}.roll.rollId`);
  }
  if (v.damage !== undefined && v.damage !== null) a.damage = check.int(v.damage, `${name}.damage`, { min: 0, max: 100000 });
  if (v.addEffect === false) a.addEffect = false;
  if (v.thrust !== undefined && v.thrust !== null) a.thrust = check.int(v.thrust, `${name}.thrust`, { min: 0, max: 30 });
  if (v.closing !== undefined) a.closing = check.bool(v.closing, `${name}.closing`);
  if (v.location !== undefined && v.location !== null) a.location = check.str(v.location, `${name}.location`, { max: 40 });
  if (v.salvoId !== undefined && v.salvoId !== null) a.salvoId = check.id(v.salvoId, `${name}.salvoId`);
  if (v.missiles !== undefined && v.missiles !== null) a.missiles = check.int(v.missiles, `${name}.missiles`, { min: 1, max: 200 });
  if (v.note !== undefined) a.note = check.optStr(v.note, `${name}.note`, { max: 300 });
  return a;
}

action('battle.create', (ctx, p) => {
  requireGm(ctx.me);
  const b = ctx.tx.create('battle', { name: check.optStr(p.name, 'name', { max: 80 }) ?? 'Battle', status: 'setup', round: 0, step: 'manoeuvre', ships: [], plans: {}, salvos: [], log: [] });
  ctx.tx.update<Battle>(b.id, (draft) => {
    // The ship with the most of the crew at their stations is taken to be the one the party is flying.
    const ships = ctx.tx.all('ship').filter((ship) => ship.party && !ship.construction).sort((a, z) => Object.keys(z.duties ?? {}).length - Object.keys(a.duties ?? {}).length);
    for (const ship of ships) draft.ships.push({ id: newId('bsh'), shipId: ship.id, name: ship.name ?? ship.className ?? 'Ship', side: 'party' });
    draft.flagship = draft.ships[0]?.id;
  });
  return { id: b.id };
});

action('battle.update', (ctx, p) => {
  requireGm(ctx.me);
  const b = needBattle(ctx, p.id);
  ctx.tx.update<Battle>(b.id, (draft) => {
    if (p.name !== undefined) draft.name = check.str(p.name, 'name', { max: 80 });
    if (p.open !== undefined) draft.open = check.bool(p.open, 'open');
    if (p.flagship !== undefined) {
      const flag = draft.ships.find((s) => s.id === p.flagship);
      if (!flag) throw new ActionError('That ship is not in this battle');
      draft.flagship = flag.id;
      delete flag.range;
    }
  });
});

/** Adds a ship: one with a record of its own, or just a name and a few figures. */
action('battle.addShip', (ctx, p) => {
  requireGm(ctx.me);
  const b = needBattle(ctx, p.id);
  const rules = ctx.services.rules.pack.space;
  const side = check.oneOf(p.side ?? 'enemy', 'side', SIDES);
  const range = p.range === undefined ? (side === 'party' ? undefined : 'veryLong') : check.str(p.range, 'range', { max: 20 });
  if (range && rules && !rules.ranges.some((r) => r.id === range)) throw new ActionError('There is no such range band');
  const entry: BattleShip = { id: newId('bsh'), name: '', side, ...(range ? { range } : {}), ...(p.hidden ? { hidden: true } : {}) };
  if (p.shipId !== undefined && p.shipId !== null) {
    const ship = ctx.tx.need('ship', check.id(p.shipId, 'shipId'));
    if (b.ships.some((s) => s.shipId === ship.id)) throw new ActionError(`${ship.name ?? 'That ship'} is already in this battle`);
    entry.shipId = ship.id;
    entry.name = check.optStr(p.name, 'name', { max: 60 }) ?? ship.name ?? ship.className ?? 'Ship';
  } else {
    const q = check.obj(p.quick ?? {}, 'quick');
    entry.name = check.str(p.name, 'name', { max: 60 });
    const tons = q.tons === undefined ? 200 : check.num(q.tons, 'quick.tons', { min: 1, max: 1_000_000 });
    const hullMax = q.hullMax === undefined ? Math.floor(tons / (ctx.services.rules.pack.ships?.hull.tonsPerHullPoint ?? 2.5)) : check.int(q.hullMax, 'quick.hullMax', { min: 1, max: 1_000_000 });
    entry.quick = {
      tons,
      thrust: q.thrust === undefined ? 1 : check.int(q.thrust, 'quick.thrust', { min: 0, max: 20 }),
      pilot: q.pilot === undefined ? 1 : check.int(q.pilot, 'quick.pilot', { min: -3, max: 6 }),
      hull: hullMax,
      hullMax,
      armour: q.armour === undefined ? 0 : check.int(q.armour, 'quick.armour', { min: 0, max: 100 }),
      crits: {},
    };
  }
  ctx.tx.update<Battle>(b.id, (draft) => {
    if (draft.status === 'active') entry.initiative = rollShipInitiative(ctx, entry);
    draft.ships.push(entry);
    if (!draft.flagship && entry.side === 'party') {
      draft.flagship = entry.id;
      delete entry.range;
    }
  });
  return { battleShipId: entry.id };
});

action('battle.removeShip', (ctx, p) => {
  requireGm(ctx.me);
  const b = needBattle(ctx, p.id);
  ctx.tx.update<Battle>(b.id, (draft) => {
    draft.ships = draft.ships.filter((s) => s.id !== p.battleShipId);
    delete draft.plans[p.battleShipId as string];
    if (draft.flagship === p.battleShipId) draft.flagship = draft.ships.find((s) => s.side === 'party')?.id;
    if (draft.turn === p.battleShipId) advance(draft);
  });
});

action('battle.ship', (ctx, p) => {
  const b = needBattle(ctx, p.id);
  const s = needBattleShip(b, p.battleShipId, ctx.me);
  const gm = ctx.me.role === 'gm';
  if (!aboard(ctx, s)) throw new ActionError('That is not your ship');
  const patch = check.obj(p.patch, 'patch');
  const rules = ctx.services.rules.pack.space;
  for (const key of Object.keys(patch)) {
    if (!['name', 'side', 'range', 'hidden', 'out', 'initiative', 'closing', 'acted'].includes(key)) throw new ActionError(`"${key}" cannot be changed`);
    if (!gm && key !== 'initiative') throw new ActionError(`Only the GM can change a ship's ${key}`);
  }
  ctx.tx.update<Battle>(b.id, (draft) => {
    const d = draft.ships.find((x) => x.id === s.id)!;
    if (patch.name !== undefined) d.name = check.str(patch.name, 'name', { max: 60 });
    if (patch.side !== undefined) d.side = check.oneOf(patch.side, 'side', SIDES);
    if (patch.range !== undefined) {
      const range = check.str(patch.range, 'range', { max: 20 });
      if (rules && !rules.ranges.some((r) => r.id === range)) throw new ActionError('There is no such range band');
      d.range = range;
      d.closing = 0;
    }
    if (patch.hidden !== undefined) d.hidden = check.bool(patch.hidden, 'hidden') || undefined;
    if (patch.initiative !== undefined) d.initiative = patch.initiative === null ? undefined : check.int(patch.initiative, 'initiative', { min: -30, max: 60 });
    if (patch.closing !== undefined) d.closing = check.int(patch.closing, 'closing', { min: -200, max: 200 });
    if (patch.acted !== undefined) d.acted = check.bool(patch.acted, 'acted');
    if (patch.out !== undefined) {
      d.out = check.bool(patch.out, 'out') || undefined;
      if (d.out && draft.turn === d.id) advance(draft);
    }
  });
});

action('battle.initiative', (ctx, p) => {
  const b = needBattle(ctx, p.id);
  if (p.battleShipId !== undefined) {
    const s = needBattleShip(b, p.battleShipId, ctx.me);
    if (!aboard(ctx, s)) throw new ActionError('That is not your ship');
    const value = rollShipInitiative(ctx, s);
    ctx.tx.update<Battle>(b.id, (draft) => void (draft.ships.find((x) => x.id === s.id)!.initiative = value));
    return { initiative: value };
  }
  requireGm(ctx.me);
  ctx.tx.update<Battle>(b.id, (draft) => {
    for (const s of draft.ships) if (s.initiative === undefined || p.reroll) s.initiative = rollShipInitiative(ctx, s);
  });
  return {};
});

action('battle.start', (ctx, p) => {
  requireGm(ctx.me);
  const b = needBattle(ctx, p.id);
  if (b.ships.length === 0) throw new ActionError('Add a ship to the battle first');
  ctx.tx.update<Battle>(b.id, (draft) => {
    for (const s of draft.ships) {
      if (s.initiative === undefined) s.initiative = rollShipInitiative(ctx, s);
      s.acted = false;
    }
    draft.status = 'active';
    draft.round = 1;
    draft.step = 'manoeuvre';
    draft.turn = battleOrder(draft)[0]?.id;
  });
});

action('battle.end', (ctx, p) => {
  requireGm(ctx.me);
  const b = needBattle(ctx, p.id);
  ctx.tx.update<Battle>(b.id, (draft) => {
    draft.status = p.reopen ? 'active' : 'ended';
    if (!p.reopen) draft.turn = undefined;
    else if (!draft.turn) advance(draft);
  });
});

/** The GM moves play on: to the next ship, or straight to the next step. */
action('battle.next', (ctx, p) => {
  requireGm(ctx.me);
  const b = needBattle(ctx, p.id);
  if (b.status !== 'active') throw new ActionError('The battle is not under way');
  ctx.tx.update<Battle>(b.id, (draft) => {
    if (p.step) for (const s of draft.ships) s.acted = true;
    else {
      const current = draft.ships.find((s) => s.id === draft.turn);
      if (current) current.acted = true;
    }
    advance(draft);
  });
});

/** Queues, edits or drops one of a ship's crew actions. Everyone aboard sees the plan as it grows. */
action('battle.plan', (ctx, p) => {
  const b = needBattle(ctx, p.id);
  const s = needBattleShip(b, p.battleShipId, ctx.me);
  if (!aboard(ctx, s)) throw new ActionError('That is not your ship');
  const gm = ctx.me.role === 'gm';
  const op = check.oneOf(p.op, 'op', ['add', 'update', 'remove', 'order'] as const);
  const own = (a: CrewAction) => {
    if (gm) return true;
    const ch = a.characterId ? ctx.tx.get<Character>(a.characterId) : undefined;
    return a.by === ctx.me.playerId || (!!ch && ch.kind === 'pc' && ch.ownerId === ctx.me.playerId);
  };
  ctx.tx.update<Battle>(b.id, (draft) => {
    const list = [...(draft.plans[s.id] ?? [])];
    if (op === 'add' || op === 'update') {
      const next = cleanAction(p.action, 'action', ctx.me);
      if (!gm && next.characterId) {
        const ch = ctx.tx.get<Character>(next.characterId);
        if (!ch || ch.kind !== 'pc' || ch.ownerId !== ctx.me.playerId) throw new ActionError('You can only act for your own character');
      }
      const at = list.findIndex((a) => a.id === next.id);
      if (op === 'add') {
        if (at !== -1) throw new ActionError('That action is already queued');
        if (list.length >= 40) throw new ActionError('That is a lot of actions for one round');
        const index = p.index === undefined ? list.length : Math.max(0, Math.min(list.length, check.int(p.index, 'index')));
        list.splice(index, 0, next);
      } else {
        if (at === -1) throw new ActionError('That action is no longer in the plan');
        if (!own(list[at])) throw new ActionError('That is someone else\'s action');
        list[at] = { ...next, by: list[at].by };
      }
    } else if (op === 'remove') {
      const at = list.findIndex((a) => a.id === p.actionId);
      if (at === -1) return;
      if (!own(list[at])) throw new ActionError('That is someone else\'s action');
      list.splice(at, 1);
    } else {
      const order = check.arr(p.order, 'order', (v, n) => check.str(v, n, { max: 40 }), 60);
      list.sort((a, z) => (order.indexOf(a.id) === -1 ? 999 : order.indexOf(a.id)) - (order.indexOf(z.id) === -1 ? 999 : order.indexOf(z.id)));
    }
    draft.plans[s.id] = list;
  });
});

/** Applies damage to a ship in the battle, whether it has a record of its own or only quick figures. */
function strike(ctx: ActionCtx, draft: Battle, target: BattleShip, hit: HitInput, source: { attacker?: string; weapon?: string }): HitOutcome {
  const rules = spaceRules(ctx);
  const ship = target.shipId ? ctx.tx.get<Ship>(target.shipId) : undefined;
  if (ship) {
    const outcome = resolveHit(rules, stateOf(ctx, ship), hit, { applies: (l) => locationApplies(ship, l) });
    applyOutcome(ctx, ship, outcome, source);
    if (outcome.wrecked) draft.ships.find((x) => x.id === target.id)!.out = true;
    return outcome;
  }
  const q = target.quick ?? {};
  const state: ShipState = { hull: q.hull ?? q.hullMax ?? 1, hullMax: q.hullMax ?? q.hull ?? 1, armour: q.armour ?? 0, crits: { ...(q.crits ?? {}) } };
  const outcome = resolveHit(rules, state, hit, {});
  const d = draft.ships.find((x) => x.id === target.id)!;
  d.quick = { ...q, hull: outcome.hull, hullMax: outcome.hullMax, armour: outcome.armour, crits: outcome.crits };
  if (outcome.wrecked) d.out = true;
  return outcome;
}

function resolveActions(ctx: ActionCtx, draft: Battle, actor: BattleShip, actions: CrewAction[]): BattleResult[] {
  const rules = spaceRules(ctx);
  const results: BattleResult[] = [];
  const flagship = draft.ships.find((s) => s.id === draft.flagship) ?? draft.ships.find((s) => s.side === 'party') ?? draft.ships[0];
  const actorShip = actor.shipId ? ctx.tx.get<Ship>(actor.shipId) : undefined;
  for (const a of actions) {
    const def = rules.actions.find((x) => x.id === a.action);
    const r: BattleResult = { actionId: a.id };
    let used = false;
    const target = a.targetId ? draft.ships.find((s) => s.id === a.targetId) : undefined;
    if (a.targetId && !target) throw new ActionError('A target of this plan is no longer in the battle');
    if (target) {
      r.targetId = target.id;
      used = true;
    }
    if (a.roll) {
      r.effect = a.roll.total - (a.roll.target ?? def?.check?.target ?? rules.attack.target);
      r.hit = r.effect >= 0;
      used = true;
    }
    const success = r.hit === true;
    // The range between two ships is kept on whichever is not the flagship.
    const between = target && (actor.id === flagship.id ? target : target.id === flagship.id ? actor : undefined);
    const band = between?.range;

    if (def?.thrust && a.thrust && between && band) {
      const d = draft.ships.find((s) => s.id === between.id)!;
      const from = band;
      let banked = (d.closing ?? 0) + (a.closing === false ? -a.thrust : a.thrust);
      let at = band;
      for (let guard = 0; guard < 12; guard++) {
        const need = rules.ranges.find((x) => x.id === at)?.thrust ?? 1;
        const dir = banked > 0 ? -1 : 1;
        const next = stepRange(rules, at, dir);
        if (Math.abs(banked) < need || next === at) break;
        banked -= Math.sign(banked) * need;
        at = next;
      }
      d.range = at;
      d.closing = banked;
      r.range = { from, to: at };
      used = true;
    }

    if (def?.weapon && target && a.roll) {
      const flight = /missile/i.test(a.weapon ?? '') ? missileFlight(rules, band) : 0;
      if (flight > 0 && !a.salvoId) {
        // Missiles take time to arrive: the attack roll is made when they do.
        const salvo = { id: newId('slv'), fromId: actor.id, toId: target.id, missiles: a.missiles ?? a.weapons ?? 1, launched: draft.round, impactRound: draft.round + flight, ...(actor.hidden ? { hidden: true } : {}) };
        draft.salvos.push(salvo);
        r.salvo = { id: salvo.id, missiles: salvo.missiles, impactRound: salvo.impactRound };
        delete r.hit;
        delete r.effect;
      } else if (success && a.damage !== undefined) {
        const salvo = a.salvoId ? draft.salvos.find((x) => x.id === a.salvoId) : undefined;
        const effect = r.effect ?? 0;
        const key = (a.weapon ?? '').toLowerCase();
        const multiplier = salvo ? Math.max(1, Math.min(effect, salvo.missiles)) : Object.entries(rules.attack.afterArmourMultiplier).find(([w]) => key.includes(w))?.[1];
        // A salvo's Effect multiplies its damage instead of adding to it.
        const dealt = a.damage + (salvo || a.addEffect === false ? 0 : Math.max(0, effect));
        const outcome = strike(ctx, draft, target, { damage: dealt, effect, location: a.location, multiplier }, { attacker: actor.name, weapon: a.weapon });
        r.dealt = dealt;
        r.taken = outcome.taken;
        r.absorbed = outcome.absorbed;
        r.wrecked = outcome.wrecked || undefined;
        if (outcome.criticals.length) r.criticals = outcome.criticals.map((c) => ({ location: c.location, name: c.name, severity: c.severity, text: c.text }));
      }
      if (a.salvoId) {
        const salvo = draft.salvos.find((x) => x.id === a.salvoId);
        if (salvo) salvo.done = true;
      }
    }

    if (def?.salvo && a.salvoId && success) {
      const salvo = draft.salvos.find((x) => x.id === a.salvoId);
      if (salvo) {
        salvo.missiles = Math.max(0, salvo.missiles - (r.effect ?? 0));
        if (salvo.missiles === 0) salvo.done = true;
        r.missilesLeft = salvo.missiles;
      }
    }
    if (def?.repair && a.location && success && actorShip) {
      ctx.tx.update<Ship>(actorShip.id, (ship) => {
        ship.repaired = [...new Set([...(ship.repaired ?? []), a.location!])];
        pushAlerts(ship, [{ id: newId('alr'), kind: 'repair', location: a.location, title: `${locationName(rules, a.location!)} patched up`, text: 'A quick repair: it will hold for a few hours.', at: Date.now(), cleared: true }]);
      });
      r.repaired = a.location;
    }
    if (def?.initiative && a.roll) {
      draft.ships.find((s) => s.id === actor.id)!.nextInitiativeDm = r.effect;
      r.initiativeDm = r.effect;
    }
    if (def?.lock && target && success) {
      const d = draft.ships.find((s) => s.id === actor.id)!;
      d.locks = [...new Set([...(d.locks ?? []), target.id])];
      r.lock = true;
    }
    if (used) results.push(r);
  }
  return results;
}

/** The ship takes its turn in the current step: everything its crew queued for the step is resolved together. */
action('battle.publish', (ctx, p) => {
  const b = needBattle(ctx, p.id);
  if (b.status !== 'active') throw new ActionError('The battle is not under way');
  const s = needBattleShip(b, p.battleShipId, ctx.me);
  const gm = ctx.me.role === 'gm';
  if (!aboard(ctx, s)) throw new ActionError('That is not your ship');
  if (!gm && b.turn !== s.id) throw new ActionError('It is not your ship\'s turn yet');
  let record: BattleRecord | undefined;
  ctx.tx.update<Battle>(b.id, (draft) => {
    const actor = draft.ships.find((x) => x.id === s.id)!;
    const plan = draft.plans[s.id] ?? [];
    const now = plan.filter((a) => a.step === draft.step || a.step === 'reaction');
    const results = resolveActions(ctx, draft, actor, now);
    record = { id: newId('brc'), round: draft.round, step: draft.step, shipId: s.id, by: ctx.me.playerId, actions: deepClone(now), results, at: Date.now() };
    draft.log.push(record);
    if (draft.log.length > MAX_LOG) draft.log.splice(0, draft.log.length - MAX_LOG);
    draft.plans[s.id] = plan.filter((a) => !now.includes(a));
    actor.acted = true;
    if (draft.turn === s.id || !draft.ships.some((x) => x.id === draft.turn && !x.out)) advance(draft);
  });
  ctx.emit('battle.turn', { battleId: b.id, recordId: record!.id }, s.hidden ? (v) => v.role === 'gm' : undefined);
  return { recordId: record!.id };
});

action('battle.salvo', (ctx, p) => {
  requireGm(ctx.me);
  const b = needBattle(ctx, p.id);
  const patch = check.obj(p.patch, 'patch');
  ctx.tx.update<Battle>(b.id, (draft) => {
    const salvo = draft.salvos.find((x) => x.id === p.salvoId);
    if (!salvo) throw new ActionError('That salvo is no longer in flight');
    if (patch.missiles !== undefined) salvo.missiles = check.int(patch.missiles, 'missiles', { min: 0, max: 500 });
    if (patch.impactRound !== undefined) salvo.impactRound = check.int(patch.impactRound, 'impactRound', { min: 0, max: 10000 });
    if (patch.hidden !== undefined) salvo.hidden = check.bool(patch.hidden, 'hidden') || undefined;
    if (patch.done !== undefined) salvo.done = check.bool(patch.done, 'done') || undefined;
  });
});
