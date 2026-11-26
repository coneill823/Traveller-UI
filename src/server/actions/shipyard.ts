/** Shipyard actions: design drafts, showing them to the party, sign-off and construction. */
import type { Viewer } from '../../shared/knowledge';
import { arrangeParts, blankSpec, evaluateDesign, isBuildable, newPartId, shipFigures, specFromStock, yardAt, yardIssues } from '../../shared/rules/ship';
import type { ShipRules } from '../../shared/rulepack';
import type { Campaign, Character, DesignPart, Id, PartKind, Ship, ShipDesign, ShipOutline, ShipSpec } from '../../shared/types';
import { deepClone } from '../../shared/util';
import type { Tx } from '../state';
import { CAMPAIGN_ID } from './core';
import { adjustFunds, balanceOf, canManage } from './inventory';
import { action, ActionError, check, requireGm, type ActionCtx } from './registry';

const PART_KINDS: readonly PartKind[] = ['armour', 'mdrive', 'rdrive', 'jdrive', 'plant', 'fuel', 'bridge', 'computer', 'sensors', 'software', 'mount', 'fitting', 'craft', 'custom'];
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE,.\s+-]+$/;

function shipRules(ctx: ActionCtx): ShipRules {
  const rules = ctx.services.rules.pack.ships;
  if (!rules) throw new ActionError('No ship construction rules are loaded. Add a rules pack with a ships section.');
  return rules;
}

function cleanPart(value: unknown, name: string): DesignPart {
  const p = check.obj(value, name);
  const part: DesignPart = { id: check.str(p.id, `${name}.id`, { max: 40 }), kind: check.oneOf(p.kind, `${name}.kind`, PART_KINDS) };
  if (p.key !== undefined) part.key = check.str(p.key, `${name}.key`, { max: 60 });
  if (p.rating !== undefined) part.rating = check.num(p.rating, `${name}.rating`, { min: 0, max: 100_000 });
  if (p.qty !== undefined) part.qty = check.int(p.qty, `${name}.qty`, { min: 1, max: 100_000 });
  if (p.tons !== undefined) part.tons = check.num(p.tons, `${name}.tons`, { min: -100_000, max: 1_000_000 });
  if (p.options !== undefined) part.options = check.arr(p.options, `${name}.options`, (v, n) => check.str(v, n, { max: 40 }), 8);
  if (p.weapons !== undefined) part.weapons = check.arr(p.weapons, `${name}.weapons`, (v, n) => check.str(v, n, { max: 40 }), 6);
  if (p.name !== undefined) part.name = check.str(p.name, `${name}.name`, { min: 0, max: 120 });
  if (p.cost !== undefined) part.cost = check.num(p.cost, `${name}.cost`, { min: 0, max: 1e12 });
  if (p.power !== undefined) part.power = check.num(p.power, `${name}.power`, { min: 0, max: 1_000_000 });
  if (p.grade !== undefined) part.grade = check.str(p.grade, `${name}.grade`, { max: 40 });
  if (p.mods !== undefined) part.mods = check.arr(p.mods, `${name}.mods`, (v, n) => check.str(v, n, { max: 40 }), 6);
  return part;
}

function cleanOutline(value: unknown): ShipOutline | undefined {
  if (value === undefined || value === null) return undefined;
  const o = check.obj(value, 'spec.outline');
  if (o.kind === 'builtin') return { kind: 'builtin', key: check.str(o.key, 'spec.outline.key', { max: 40 }) };
  if (o.kind === 'path') {
    const d = check.text(o.d, 'spec.outline.d', 20_000).trim();
    if (!d || !PATH_DATA.test(d)) throw new ActionError('That outline is not valid SVG path data');
    const box = check.arr(o.viewBox, 'spec.outline.viewBox', (v, n) => check.num(v, n, { min: -100_000, max: 100_000 }), 4);
    if (box.length !== 4 || box[2] <= 0 || box[3] <= 0) throw new ActionError('An outline needs a view box of four numbers');
    return { kind: 'path', d, viewBox: box as [number, number, number, number], name: check.optStr(o.name, 'spec.outline.name', { max: 60 }) };
  }
  if (o.kind === 'image') {
    const url = check.str(o.url, 'spec.outline.url', { max: 200 });
    if (!url.startsWith('/uploads/')) throw new ActionError('Outline images must be uploaded to this server');
    return { kind: 'image', url, name: check.optStr(o.name, 'spec.outline.name', { max: 60 }) };
  }
  throw new ActionError('Unknown kind of outline');
}

function cleanSpec(value: unknown): ShipSpec {
  const v = check.obj(value, 'spec');
  const hull = check.obj(v.hull, 'spec.hull');
  const parts = check.arr(v.parts, 'spec.parts', cleanPart, 300);
  if (new Set(parts.map((p) => p.id)).size !== parts.length) throw new ActionError('Two parts of the design share an id');
  const options = hull.options === undefined ? undefined : check.arr(hull.options, 'spec.hull.options', (o, n) => check.str(o, n, { max: 40 }), 8);
  const outline = cleanOutline(v.outline);
  const stock = check.optStr(v.stock, 'spec.stock', { max: 60 });
  return {
    tl: check.int(v.tl, 'spec.tl', { min: 0, max: 30 }),
    hull: { tons: check.num(hull.tons, 'spec.hull.tons', { min: 1, max: 1_000_000 }), config: check.str(hull.config, 'spec.hull.config', { max: 40 }), ...(options?.length ? { options } : {}) },
    parts,
    ...(outline ? { outline } : {}),
    ...(v.cargoAt !== undefined ? { cargoAt: check.int(v.cargoAt, 'spec.cargoAt', { min: 0, max: 300 }) } : {}),
    ...(stock ? { stock } : {}),
    ...(v.crewing === 'military' || v.crewing === 'commercial' ? { crewing: v.crewing } : {}),
  };
}

function canEdit(me: Viewer, design: ShipDesign): boolean {
  return me.role === 'gm' || design.ownerId === me.playerId;
}

function needDesign(ctx: ActionCtx, id: unknown, forEdit = true): ShipDesign {
  const design = ctx.tx.need('design', check.id(id, 'id'));
  const visible = ctx.me.role === 'gm' || design.ownerId === ctx.me.playerId || design.shared || design.status !== 'draft';
  if (!visible) throw new ActionError('No design with that id');
  if (forEdit && !canEdit(ctx.me, design)) throw new ActionError('Only whoever drew up a design (or the GM) can change it');
  return design;
}

function partyPlayers(tx: Tx): Id[] {
  return tx.all('player').filter((p) => p.role === 'player').map((p) => p.id);
}

/** A proposal is approved once the GM has signed it off or every player has. */
function settle(tx: Tx, id: Id): void {
  tx.update<ShipDesign>(id, (d) => {
    if (d.status !== 'proposed' && d.status !== 'approved') return;
    const players = partyPlayers(tx);
    const everyone = players.length > 0 && players.every((p) => d.approvals?.includes(p));
    d.status = d.gmSigned || everyone ? 'approved' : 'proposed';
  });
}

function today(tx: Tx): { day: number; year: number } {
  return tx.get<Campaign>(CAMPAIGN_ID)?.date ?? { day: 1, year: 1105 };
}

function addDays(date: { day: number; year: number }, days: number): { day: number; year: number } {
  let day = date.day + days;
  let year = date.year;
  while (day > 365) {
    day -= 365;
    year += 1;
  }
  return { day, year };
}

action('design.create', (ctx, p) => {
  const rules = shipRules(ctx);
  let spec: ShipSpec;
  let name = check.optStr(p.name, 'name', { max: 80 });
  let className: string | undefined;
  let summary: string | undefined;
  let refitOf: Id | undefined;

  if (p.stock !== undefined) {
    const stock = rules.designs.find((d) => d.id === check.str(p.stock, 'stock', { max: 60 }));
    if (!stock) throw new ActionError('That stock design is not in the rules pack');
    spec = arrangeParts(rules, specFromStock(stock));
    className = stock.type ? `${stock.name} (${stock.type})` : stock.name;
    summary = stock.summary;
    name ??= stock.name;
  } else if (p.copyOf !== undefined) {
    const source = needDesign(ctx, p.copyOf, false);
    spec = deepClone(source.spec);
    className = source.className;
    summary = source.summary;
    name ??= `${source.name} (copy)`;
  } else if (p.refitOf !== undefined) {
    const ship = ctx.tx.need('ship', check.id(p.refitOf, 'refitOf'));
    if (!canManage(ctx.me, ship)) throw new ActionError('That is not your ship');
    if (!ship.spec) throw new ActionError('This ship has no design on file to refit. Draw one up and have the GM attach it.');
    spec = deepClone(ship.spec);
    delete spec.stock;
    className = ship.className;
    refitOf = ship.id;
    name ??= `${ship.name ?? ship.className ?? 'Ship'} refit`;
  } else {
    spec = blankSpec(rules, p.tons === undefined ? 200 : check.num(p.tons, 'tons', { min: rules.hull.minTons, max: rules.hull.maxTons }), p.tl === undefined ? 12 : check.int(p.tl, 'tl', { min: 0, max: 30 }));
    if (p.config !== undefined) spec.hull.config = check.str(p.config, 'config', { max: 40 });
    name ??= 'New design';
  }
  // Parts get fresh ids so that copies never share them.
  spec.parts = spec.parts.map((part) => ({ ...part, id: newPartId() }));
  const design = ctx.tx.create('design', { name: name!, className, summary, status: 'draft', ownerId: ctx.me.playerId, spec, ...(refitOf ? { refitOf } : {}) });
  return { id: design.id };
});

action('design.update', (ctx, p) => {
  const design = needDesign(ctx, p.id);
  if (design.status === 'built') throw new ActionError('This design has been built. Copy it to make changes.');
  const spec = p.spec === undefined ? undefined : cleanSpec(p.spec);
  ctx.tx.update<ShipDesign>(design.id, (d) => {
    if (p.name !== undefined) d.name = check.str(p.name, 'name', { max: 80 });
    if (p.className !== undefined) d.className = check.optStr(p.className, 'className', { max: 80 });
    if (p.summary !== undefined) d.summary = check.optStr(p.summary, 'summary', { max: 2000 });
    if (spec) {
      d.spec = spec;
      // The party signed off on something else: ask again.
      if (d.status !== 'draft') {
        const players = partyPlayers(ctx.tx);
        d.approvals = players.includes(d.ownerId) ? [d.ownerId] : [];
        d.gmSigned = false;
        d.status = 'proposed';
      }
    }
  });
  if (spec) settle(ctx.tx, design.id);
});

action('design.share', (ctx, p) => {
  const design = needDesign(ctx, p.id);
  const shared = check.bool(p.shared, 'shared');
  if (!shared && design.status !== 'draft') throw new ActionError('Withdraw the proposal first');
  ctx.tx.update<ShipDesign>(design.id, (d) => void (d.shared = shared));
});

action('design.propose', (ctx, p) => {
  const design = needDesign(ctx, p.id);
  if (design.status === 'built') throw new ActionError('This design has already been built');
  ctx.tx.update<ShipDesign>(design.id, (d) => {
    d.status = 'proposed';
    d.shared = true;
    d.gmSigned = false;
    d.approvals = partyPlayers(ctx.tx).includes(d.ownerId) ? [d.ownerId] : [];
  });
  settle(ctx.tx, design.id);
  ctx.emit('design.proposed', { id: design.id, name: design.name, by: ctx.me.playerId });
});

action('design.withdraw', (ctx, p) => {
  const design = needDesign(ctx, p.id);
  if (design.status === 'built') throw new ActionError('This design has already been built');
  ctx.tx.update<ShipDesign>(design.id, (d) => {
    d.status = 'draft';
    d.approvals = [];
    d.gmSigned = false;
  });
});

/** A player signs off (or takes their signature back); the GM can sign off for the whole table. */
action('design.approve', (ctx, p) => {
  const design = needDesign(ctx, p.id, false);
  if (design.status !== 'proposed' && design.status !== 'approved') throw new ActionError('This design has not been put to the party');
  const approve = p.approve !== false;
  ctx.tx.update<ShipDesign>(design.id, (d) => {
    if (ctx.me.role === 'gm') {
      d.gmSigned = approve;
    } else {
      const set = new Set(d.approvals ?? []);
      if (approve) set.add(ctx.me.playerId);
      else set.delete(ctx.me.playerId);
      d.approvals = [...set];
    }
  });
  settle(ctx.tx, design.id);
});

action('design.delete', (ctx, p) => {
  const design = needDesign(ctx, p.id);
  if (design.status === 'built' && ctx.me.role !== 'gm') throw new ActionError('Only the GM can delete the record of a ship that was built');
  ctx.tx.delete(design.id);
});

/**
 * Lays the ship down. Players can commission an approved design at the yard where the party is,
 * paying the list price from a purse they control. The GM can build anything anywhere at any price.
 */
action('design.build', (ctx, p) => {
  const design = needDesign(ctx, p.id, false);
  const gm = ctx.me.role === 'gm';
  if (design.status === 'built') throw new ActionError('This design has already been built');
  if (!gm && design.status !== 'approved') throw new ActionError('The party has not signed off on this design yet');
  const rules = shipRules(ctx);
  const force = gm && p.force === true;
  const report = evaluateDesign(rules, design.spec);
  if (!isBuildable(report) && !force) throw new ActionError(`The design cannot be built as drawn: ${report.issues[0].text}`);

  const campaign = ctx.tx.get<Campaign>(CAMPAIGN_ID);
  const systemId = gm && p.systemId !== undefined ? check.id(p.systemId, 'systemId') : campaign?.location?.systemId;
  const system = systemId ? ctx.tx.need('system', systemId) : undefined;
  if (!force) {
    if (!system) throw new ActionError('The party is not at a starport. The GM can set where you are on the map.');
    const problems = yardIssues(report, yardAt(rules, ctx.services.rules.pack.world, system.uwp));
    if (problems.length) throw new ActionError(`${system.name ?? 'This world'} cannot build it: ${problems[0].text}`);
  }

  const refit = design.refitOf ? ctx.tx.get<Ship>(design.refitOf) : undefined;
  if (design.refitOf && !refit) throw new ActionError('The ship this design refits no longer exists');
  const previous = refit?.spec ? evaluateDesign(rules, refit.spec).cost : 0;
  const listPrice = refit ? Math.max(0, report.cost - previous) : report.purchase;
  const price = gm && p.price !== undefined ? Math.round(check.num(p.price, 'price', { min: 0, max: 1e12 })) : listPrice;

  if (p.payerId !== undefined && p.payerId !== null) {
    const payer = ctx.tx.get(check.id(p.payerId, 'payerId'));
    if (!payer || (payer.type !== 'ship' && payer.type !== 'character')) throw new ActionError('Pick a ship account or a traveller to pay');
    if (!canManage(ctx.me, payer)) throw new ActionError('Those are not your credits to spend');
    const purse = payer as Ship | Character;
    if (balanceOf(purse) < price && !gm) throw new ActionError(`Not enough credits: the yard wants Cr${price.toLocaleString('en-GB')} and there is Cr${balanceOf(purse).toLocaleString('en-GB')} available`);
    if (price > 0) adjustFunds(ctx.tx, purse, -price);
  } else if (!gm && price > 0) {
    throw new ActionError('Choose who pays the shipyard');
  }

  const figures = shipFigures(report);
  const days = gm && p.instant === true ? 0 : refit ? Math.ceil(price / 1_000_000) : report.buildDays;
  const date = today(ctx.tx);
  const ready = addDays(date, days);
  const construction = days > 0 ? { readyDay: ready.day, readyYear: ready.year, ...(system ? { systemId: system.id } : {}) } : undefined;
  const className = design.className ?? report.stock?.name;
  let shipId: Id;

  if (refit) {
    shipId = refit.id;
    ctx.tx.update<Ship>(refit.id, (s) => {
      const damage = Math.max(0, (s.hullMax ?? figures.hullMax) - (s.hull ?? s.hullMax ?? figures.hullMax));
      Object.assign(s, figures);
      s.hull = Math.max(0, figures.hullMax - damage);
      s.fuel = Math.min(s.fuel ?? 0, figures.fuelCapacity);
      s.spec = deepClone(design.spec);
      s.designId = design.id;
      if (className) s.className = className;
      if (construction) s.construction = construction;
      else delete s.construction;
    });
  } else {
    const ship = ctx.tx.create('ship', {
      name: check.optStr(p.name, 'name', { max: 80 }) ?? design.name,
      className,
      party: p.party !== false || !gm,
      ...figures,
      hull: figures.hullMax,
      fuel: figures.fuelCapacity,
      funds: 0,
      spec: deepClone(design.spec),
      designId: design.id,
      summary: design.summary,
      ...(system ? { location: { systemId: system.id, status: 'docked' as const } } : {}),
      ...(construction ? { construction } : {}),
    });
    shipId = ship.id;
  }

  ctx.tx.update<ShipDesign>(design.id, (d) => {
    d.status = 'built';
    d.shared = true;
    d.shipId = shipId;
    d.built = { day: date.day, year: date.year, price, ...(system ? { systemId: system.id } : {}) };
  });
  return { shipId, days, price };
});

/** The GM attaches a design to a ship that was created by hand, so it can be refitted and shown in detail. */
action('design.attach', (ctx, p) => {
  requireGm(ctx.me);
  const design = needDesign(ctx, p.id);
  const ship = ctx.tx.need('ship', check.id(p.shipId, 'shipId'));
  const report = evaluateDesign(shipRules(ctx), design.spec);
  const figures = shipFigures(report);
  ctx.tx.update<Ship>(ship.id, (s) => {
    Object.assign(s, figures);
    s.hull = Math.min(s.hull ?? figures.hullMax, figures.hullMax);
    s.fuel = Math.min(s.fuel ?? figures.fuelCapacity, figures.fuelCapacity);
    s.spec = deepClone(design.spec);
    s.designId = design.id;
    s.className ??= design.className;
  });
  ctx.tx.update<ShipDesign>(design.id, (d) => {
    d.status = 'built';
    d.shared = true;
    d.shipId = ship.id;
    const date = today(ctx.tx);
    d.built = { day: date.day, year: date.year, price: 0 };
  });
});
