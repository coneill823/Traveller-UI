/** Inventory actions: ships (basics), stashes, items, moving things between holders, credits. */
import { contentsVisible, type Viewer } from '../../shared/knowledge';
import type { PatchOp } from '../../shared/patch';
import { rootField } from '../../shared/patch';
import type { Character, CharacterArmour, CharacterWeapon, Entity, Id, Item, ItemCategory, Ship, Stash } from '../../shared/types';
import { newId } from '../../shared/util';
import type { Tx } from '../state';
import { applyPreset, checkAudience } from './core';
import { action, ActionError, check, requireGm, type ActionCtx } from './registry';

const CATEGORIES: readonly ItemCategory[] = ['weapon', 'armour', 'gear', 'consumable', 'cargo', 'other'];

/** Whether the caller may add to, take from and rearrange what a holder contains. */
export function canManage(me: Viewer, holder: Entity | undefined): boolean {
  if (!holder) return false;
  if (me.role === 'gm') return true;
  if (holder.type === 'character') return (holder as Character).kind === 'pc' && (holder as Character).ownerId === me.playerId;
  if (holder.type === 'ship') return (holder as Ship).party === true;
  if (holder.type === 'stash') return contentsVisible(holder, me);
  return false;
}

/** Whether something may be handed to a holder: any traveller, a party ship, or a store the caller can see. */
function canReceive(me: Viewer, holder: Entity | undefined): boolean {
  if (!holder) return false;
  if (me.role === 'gm') return true;
  if (holder.type === 'character') return (holder as Character).kind === 'pc';
  return canManage(me, holder);
}

function needHolder(ctx: ActionCtx, id: unknown, name = 'holderId'): Entity {
  const holder = ctx.tx.get(check.id(id, name));
  if (!holder || !['character', 'ship', 'stash'].includes(holder.type)) throw new ActionError('That is not something that can hold items');
  return holder;
}

/** Tons of cargo in a ship's hold. */
export function cargoUsed(tx: Tx, shipId: Id, exceptItem?: Id): number {
  let total = 0;
  for (const item of tx.where('item', 'holderId', shipId)) if (item.id !== exceptItem && item.category === 'cargo') total += (item.tons ?? 0) * (item.qty || 1);
  return Math.round(total * 100) / 100;
}

// ── ships & stashes ──

action('ship.create', (ctx, p) => {
  requireGm(ctx.me);
  const ship = ctx.tx.create('ship', {
    name: check.optStr(p.name, 'name', { max: 80 }),
    className: check.optStr(p.className, 'className', { max: 80 }),
    party: p.party !== false,
    tons: p.tons === undefined ? 200 : check.num(p.tons, 'tons', { min: 1, max: 1_000_000 }),
    jump: p.jump === undefined ? 1 : check.int(p.jump, 'jump', { min: 0, max: 9 }),
    thrust: p.thrust === undefined ? 1 : check.int(p.thrust, 'thrust', { min: 0, max: 16 }),
    cargo: p.cargo === undefined ? 0 : check.num(p.cargo, 'cargo', { min: 0, max: 1_000_000 }),
    fuelCapacity: p.fuelCapacity === undefined ? 0 : check.num(p.fuelCapacity, 'fuelCapacity', { min: 0, max: 1_000_000 }),
    fuel: p.fuel === undefined ? (p.fuelCapacity ?? 0) : check.num(p.fuel, 'fuel', { min: 0, max: 1_000_000 }),
    funds: p.funds === undefined ? 0 : check.num(p.funds, 'funds', { min: -1e12, max: 1e12 }),
    staterooms: p.staterooms === undefined ? undefined : check.int(p.staterooms, 'staterooms', { min: 0, max: 10000 }),
    lowBerths: p.lowBerths === undefined ? undefined : check.int(p.lowBerths, 'lowBerths', { min: 0, max: 10000 }),
  });
  if (!ship.party && p.reveal) applyPreset(ctx.tx, ship.id, check.str(p.reveal.preset, 'reveal.preset', { max: 20 }), checkAudience(ctx.tx, p.reveal.audience, 'reveal.audience'));
  return { id: ship.id };
});

/** Fields of a party ship that its crew may change themselves. */
const CREW_SHIP_FIELDS = ['fuel', 'funds', 'summary'];

action('ship.update', (ctx, p) => {
  const ship = ctx.tx.need('ship', check.id(p.id, 'id'));
  if (!canManage(ctx.me, ship)) throw new ActionError('That is not your ship');
  if (!Array.isArray(p.ops) || p.ops.length === 0 || p.ops.length > 50) throw new ActionError('Invalid edits');
  const ops = p.ops as PatchOp[];
  for (const op of ops) {
    const field = rootField(op);
    if (ctx.me.role !== 'gm' && !CREW_SHIP_FIELDS.includes(field)) throw new ActionError(`Only the GM can change a ship's ${field}`);
    if (['id', 'type', 'rev', 'known', 'notes', 'gm'].includes(field)) throw new ActionError(`"${field}" cannot be edited here`);
  }
  ctx.tx.patch(ship.id, ops);
});

action('stash.create', (ctx, p) => {
  requireGm(ctx.me);
  const stash = ctx.tx.create('stash', { name: check.str(p.name, 'name', { max: 80 }), summary: check.optStr(p.summary, 'summary', { max: 400 }) });
  if (p.reveal) applyPreset(ctx.tx, stash.id, 'detected', checkAudience(ctx.tx, p.reveal, 'reveal'));
  return { id: stash.id };
});

// ── items ──

action('item.create', (ctx, p) => {
  const holder = needHolder(ctx, p.holderId);
  if (!canManage(ctx.me, holder)) throw new ActionError('You cannot add things there');
  const gear = ctx.services.rules.pack.gear;
  let data: Omit<Item, 'id' | 'type' | 'rev' | 'createdAt' | 'updatedAt'>;
  let weapon: CharacterWeapon | undefined;
  let armour: CharacterArmour | undefined;

  if (p.defKind === 'weapon' || p.defKind === 'armour') {
    // From the rules catalogue.
    const defId = check.str(p.defId, 'defId', { max: 80 });
    if (p.defKind === 'weapon') {
      const def = gear?.weapons.find((w) => w.id === defId);
      if (!def) throw new ActionError('That weapon is not in the catalogue');
      const name = def.tl !== undefined && gear!.weapons.filter((w) => w.name === def.name).length > 1 ? `${def.name} (TL${def.tl})` : def.name;
      data = { holderId: holder.id, name, category: 'weapon', qty: 1, kg: def.kg, value: def.cost, tl: def.tl, defId: def.id, note: def.note, carried: true };
      weapon = { id: newId('wpn'), defId: def.id, name, skill: def.skill, damage: def.damage, range: def.range, traits: def.traits, magazine: def.magazine, ammo: typeof def.magazine === 'number' ? def.magazine : undefined, note: def.note };
    } else {
      const def = gear?.armour.find((a) => a.id === defId);
      if (!def) throw new ActionError('That armour is not in the catalogue');
      const name = `${def.name} (TL${def.tl})`;
      data = { holderId: holder.id, name, category: 'armour', qty: 1, kg: def.kg, value: def.cost, tl: def.tl, defId: def.id, note: def.note, carried: true };
      armour = { id: newId('arm'), defId: def.id, name, protection: def.protection, laserProtection: def.laserProtection, rad: def.rad, kg: def.kg, worn: false, note: def.note };
    }
    if (p.qty !== undefined) data.qty = check.int(p.qty, 'qty', { min: 1, max: 100000 });
  } else {
    const category = check.oneOf(p.category ?? 'gear', 'category', CATEGORIES);
    data = {
      holderId: holder.id,
      name: check.str(p.name, 'name', { max: 120 }),
      category,
      qty: p.qty === undefined ? 1 : check.int(p.qty, 'qty', { min: 1, max: 1_000_000 }),
      kg: p.kg === undefined ? undefined : check.num(p.kg, 'kg', { min: 0, max: 1_000_000 }),
      value: p.value === undefined ? undefined : check.num(p.value, 'value', { min: 0, max: 1e12 }),
      tl: p.tl === undefined ? undefined : check.int(p.tl, 'tl', { min: 0, max: 30 }),
      note: check.optStr(p.note, 'note', { max: 2000 }),
      tags: p.tags === undefined ? undefined : check.arr(p.tags, 'tags', (v, n) => check.str(v, n, { max: 30 }), 12),
      carried: holder.type === 'character' ? p.carried !== false : undefined,
      tons: category === 'cargo' ? check.num(p.tons ?? 1, 'tons', { min: 0.01, max: 1_000_000 }) : undefined,
    };
  }

  if (data.category === 'cargo' && holder.type === 'ship') {
    const ship = holder as Ship;
    const used = cargoUsed(ctx.tx, ship.id);
    if (ship.cargo !== undefined && used + (data.tons ?? 0) * data.qty > ship.cargo + 1e-9) throw new ActionError(`Not enough cargo space: ${Math.max(0, ship.cargo - used)} tons free`);
  }
  const item = ctx.tx.create('item', data);

  // Optionally put a catalogue weapon or armour straight onto the character's sheet.
  if (p.equip && holder.type === 'character') {
    ctx.tx.update<Character>(holder.id, (c) => {
      if (weapon) c.weapons = [...(c.weapons ?? []), weapon];
      if (armour) c.armour = [...(c.armour ?? []), { ...armour, worn: (c.armour ?? []).every((a) => !a.worn) }];
    });
  }
  return { id: item.id };
});

const ITEM_FIELDS = ['name', 'category', 'qty', 'kg', 'value', 'tl', 'note', 'tags', 'carried', 'tons', 'illegal'];

action('item.update', (ctx, p) => {
  const item = ctx.tx.need('item', check.id(p.id, 'id'));
  if (!canManage(ctx.me, ctx.tx.get(item.holderId))) throw new ActionError('That is not yours to change');
  if (!Array.isArray(p.ops) || p.ops.length === 0 || p.ops.length > 50) throw new ActionError('Invalid edits');
  for (const op of p.ops as PatchOp[]) {
    const field = rootField(op);
    if (!ITEM_FIELDS.includes(field) && !(ctx.me.role === 'gm' && ['good', 'paid', 'origin', 'freight', 'defId', 'saleOffer'].includes(field))) throw new ActionError(`"${field}" cannot be edited here`);
  }
  const next = ctx.tx.patch<Item>(item.id, p.ops as PatchOp[]);
  if (!Number.isFinite(next.qty) || next.qty < 0) throw new ActionError('Quantity must be zero or more');
  if (next.qty === 0) ctx.tx.delete(item.id);
});

action('item.delete', (ctx, p) => {
  const item = ctx.tx.need('item', check.id(p.id, 'id'));
  if (!canManage(ctx.me, ctx.tx.get(item.holderId))) throw new ActionError('That is not yours to remove');
  ctx.tx.delete(item.id);
});

action('item.move', (ctx, p) => {
  const item = ctx.tx.need('item', check.id(p.id, 'id'));
  const from = ctx.tx.get(item.holderId);
  const to = needHolder(ctx, p.to, 'to');
  if (!canManage(ctx.me, from)) throw new ActionError('That is not yours to move');
  if (!canReceive(ctx.me, to)) throw new ActionError('You cannot put things there');
  if (to.id === item.holderId) return { id: item.id };
  const qty = p.qty === undefined ? item.qty : check.int(p.qty, 'qty', { min: 1, max: item.qty });

  if (item.category === 'cargo' && to.type === 'ship') {
    const ship = to as Ship;
    const used = cargoUsed(ctx.tx, ship.id);
    const tons = (item.tons ?? 0) * qty;
    if (ship.cargo !== undefined && used + tons > ship.cargo + 1e-9) throw new ActionError(`Not enough cargo space aboard ${ship.name ?? 'that ship'}: ${Math.max(0, ship.cargo - used)} tons free`);
  }

  // Stack with an identical item already there, otherwise move (or split off) the record.
  const twin = ctx.tx.where('item', 'holderId', to.id).find((o) => o.name === item.name && o.category === item.category && o.category !== 'cargo' && o.kg === item.kg && o.value === item.value && (o.note ?? '') === (item.note ?? '') && o.defId === item.defId);
  let resultId: Id;
  if (twin) {
    ctx.tx.update<Item>(twin.id, (t) => void (t.qty += qty));
    resultId = twin.id;
    if (qty === item.qty) ctx.tx.delete(item.id);
    else ctx.tx.update<Item>(item.id, (i) => void (i.qty -= qty));
  } else if (qty === item.qty) {
    ctx.tx.update<Item>(item.id, (i) => {
      i.holderId = to.id;
      if (to.type !== 'character') delete i.carried;
      else i.carried = true;
      delete i.saleOffer;
    });
    resultId = item.id;
  } else {
    ctx.tx.update<Item>(item.id, (i) => void (i.qty -= qty));
    const { id: _id, type: _type, rev: _rev, createdAt: _c, updatedAt: _u, saleOffer: _offer, ...rest } = item;
    resultId = ctx.tx.create('item', { ...rest, holderId: to.id, qty, carried: to.type === 'character' ? true : undefined }).id;
  }
  return { id: resultId };
});

// ── credits ──

function purse(ctx: ActionCtx, id: unknown, name: string): Character | Ship {
  const e = ctx.tx.get(check.id(id, name));
  if (!e || (e.type !== 'character' && e.type !== 'ship')) throw new ActionError('Credits are held by characters and ships');
  return e as Character | Ship;
}

export function balanceOf(e: Character | Ship): number {
  return e.type === 'ship' ? (e.funds ?? 0) : (e.credits ?? 0);
}

export function adjustFunds(tx: Tx, e: Character | Ship, delta: number): void {
  if (e.type === 'ship') tx.update<Ship>(e.id, (s) => void (s.funds = Math.round((s.funds ?? 0) + delta)));
  else tx.update<Character>(e.id, (c) => void (c.credits = Math.round((c.credits ?? 0) + delta)));
}

action('funds.transfer', (ctx, p) => {
  const from = purse(ctx, p.from, 'from');
  const to = purse(ctx, p.to, 'to');
  const amount = check.int(p.amount, 'amount', { min: 1, max: 1e12 });
  if (!canManage(ctx.me, from)) throw new ActionError('Those are not your credits to spend');
  if (!canReceive(ctx.me, to)) throw new ActionError('You cannot pay into that');
  if (from.id === to.id) return;
  if (balanceOf(from) < amount && ctx.me.role !== 'gm') throw new ActionError(`Not enough credits: Cr${balanceOf(from).toLocaleString('en-GB')} available`);
  adjustFunds(ctx.tx, from, -amount);
  adjustFunds(ctx.tx, to, amount);
});

export type { Stash };
