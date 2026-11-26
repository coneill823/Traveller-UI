/** Universe actions: sectors, systems, bodies, routes, regions, imports and random generation. */
import { SECTOR_H, SECTOR_W, SUBSECTOR_LETTERS, formatHex, parseHex, subsectorOf, subsectorOrigin, toGlobal } from '../../shared/hex';
import { PRESETS } from '../../shared/knowledge';
import { generateNames } from '../../shared/names';
import { generateArea, generateWorld, suggestTradeRoutes, systemTradeCodes } from '../../shared/rules/world';
import type { ParsedWorld } from '../../shared/sectorFormats';
import type { Body, BodyKind, Campaign, Id, RouteKind, Sector, StarSystem, TravelZone } from '../../shared/types';
import { isValidUwp, parsePbg, parseUwp } from '../../shared/uwp';
import { hashString, seededRng } from '../../shared/util';
import type { Tx } from '../state';
import { applyPreset, CAMPAIGN_ID, cascadeDelete, checkAudience } from './core';
import { action, ActionError, check, requireGm, type ActionCtx } from './registry';

const BODY_KINDS: readonly BodyKind[] = ['star', 'planet', 'gasGiant', 'belt', 'moon', 'station', 'poi'];
const ROUTE_KINDS: readonly RouteKind[] = ['comm', 'trade', 'custom'];

function checkHex(value: unknown, name = 'hex'): string {
  const hex = check.str(value, name, { max: 4 });
  if (!parseHex(hex)) throw new ActionError(`"${hex}" is not a valid hex (0101–${formatHex(SECTOR_W, SECTOR_H)})`);
  return hex;
}

function systemAt(tx: Tx, sectorId: Id, hex: string): StarSystem | undefined {
  return tx.where('system', 'sectorId', sectorId).find((s) => s.hex === hex);
}

function worldRules(ctx: ActionCtx) {
  const rules = ctx.services.rules.pack.world;
  if (!rules) throw new ActionError('No rules pack with world-creation tables is installed on the server');
  return rules;
}

/** Splits stellar data such as "M1 V M7 V" or "G2 V BD" into one entry per star. */
export function splitStars(stars: string | undefined): string[] {
  if (!stars) return [];
  const out: string[] = [];
  const re = /(?:[OBAFGKM]\d?\s*(?:Ia|Ib|III|II|IV|VI|V|D)|BD|BH|PSR|NS|D[ABCOQZ]?\d?)/g;
  for (const m of stars.matchAll(re)) out.push(m[0].replace(/\s+/g, ' ').trim());
  return out;
}

/**
 * Creates the bodies any star chart would list for a system: its star(s), the mainworld, and the
 * gas giants and belts counted in its PBG. Orbits are a stable pseudo-random arrangement.
 */
export function buildSurveyBodies(tx: Tx, system: StarSystem): Body[] {
  const rng = seededRng(parseInt(hashString(system.id), 16));
  const made: Body[] = [];
  const add = (kind: BodyKind, orbit: number, extra: Partial<Body> = {}) => {
    made.push(tx.create('body', { systemId: system.id, kind, orbit, origin: 'survey', ...extra }));
  };

  const stars = splitStars(system.stars);
  if (stars.length === 0) add('star', 0, { name: system.name ? `${system.name} Primary` : undefined });
  stars.forEach((cls, i) =>
    add('star', i * 0.1, { subtype: cls, name: system.name ? `${system.name} ${stars.length > 1 ? String.fromCharCode(65 + i) : 'Primary'}` : undefined }),
  );

  const uwp = parseUwp(system.uwp);
  const pbg = parsePbg(system.pbg);
  const giants = Math.min(pbg?.gasGiants ?? 0, 6);
  const mainIsBelt = uwp?.size === 0;
  const belts = Math.max(0, Math.min(pbg?.belts ?? 0, 4) - (mainIsBelt ? 1 : 0));

  // Lay bodies out on orbit slots 1..n: mainworld in the inner-middle, giants mostly further out.
  const slots: { kind: BodyKind; main?: boolean }[] = [];
  const inner = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < inner; i++) slots.push({ kind: 'planet' });
  slots.push({ kind: mainIsBelt ? 'belt' : 'planet', main: true });
  const outer: { kind: BodyKind }[] = [];
  for (let i = 0; i < belts; i++) outer.push({ kind: 'belt' });
  for (let i = 0; i < giants; i++) outer.push({ kind: 'gasGiant' });
  // Stable shuffle of the outer system.
  for (let i = outer.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [outer[i], outer[j]] = [outer[j], outer[i]];
  }
  slots.push(...outer);

  slots.forEach((slot, i) => {
    if (slot.main) add(slot.kind, i + 1, { mainworld: true, name: system.name });
    else if (slot.kind === 'planet') {
      // Unremarkable inner worlds are not listed on charts; only the mainworld, belts and giants are.
    } else add(slot.kind, i + 1);
  });
  return made;
}

function createSystem(
  tx: Tx,
  sector: Sector,
  data: { hex: string; name?: string; uwp?: string; bases?: string; remarks?: string; zone?: TravelZone; pbg?: string; allegiance?: string; stars?: string; ext?: StarSystem['ext'] },
): StarSystem {
  const system = tx.create('system', { sectorId: sector.id, ...data });
  buildSurveyBodies(tx, system);
  return system;
}

// ── sectors ──

action('sector.create', (ctx, p) => {
  requireGm(ctx.me);
  const name = check.str(p.name, 'name', { max: 60 });
  const x = check.int(p.x, 'x', { min: -500, max: 500 });
  const y = check.int(p.y, 'y', { min: -500, max: 500 });
  if (ctx.tx.all('sector').some((s) => s.x === x && s.y === y)) throw new ActionError('There is already a sector in that position');
  const sector = ctx.tx.create('sector', { name, abbr: check.optStr(p.abbr, 'abbr', { max: 6 }), x, y, subsectors: {} });
  return { id: sector.id };
});

action('sector.move', (ctx, p) => {
  requireGm(ctx.me);
  const sector = ctx.tx.need('sector', check.id(p.id, 'id'));
  const x = check.int(p.x, 'x', { min: -500, max: 500 });
  const y = check.int(p.y, 'y', { min: -500, max: 500 });
  if (ctx.tx.all('sector').some((s) => s.id !== sector.id && s.x === x && s.y === y)) throw new ActionError('There is already a sector in that position');
  ctx.tx.update<Sector>(sector.id, (s) => {
    s.x = x;
    s.y = y;
  });
});

action('sector.clear', (ctx, p) => {
  requireGm(ctx.me);
  const sector = ctx.tx.need('sector', check.id(p.id, 'id'));
  const letter = p.subsector === undefined ? undefined : check.oneOf(p.subsector, 'subsector', SUBSECTOR_LETTERS.split(''));
  let removed = 0;
  for (const system of ctx.tx.where('system', 'sectorId', sector.id)) {
    const h = parseHex(system.hex)!;
    if (letter && subsectorOf(h.col, h.row) !== letter) continue;
    cascadeDelete(ctx.tx, system.id);
    removed++;
  }
  return { removed };
});

// ── systems ──

action('system.create', (ctx, p) => {
  requireGm(ctx.me);
  const sector = ctx.tx.need('sector', check.id(p.sectorId, 'sectorId'));
  const hex = checkHex(p.hex);
  if (systemAt(ctx.tx, sector.id, hex)) throw new ActionError(`Hex ${hex} already has a system`);
  let data: Parameters<typeof createSystem>[2] = { hex, name: check.optStr(p.name, 'name', { max: 60 }) };
  if (p.generate) {
    const rules = worldRules(ctx);
    const world = generateWorld(rules, Math.random);
    const taken = new Set(ctx.tx.all('system').map((s) => (s.name ?? '').toLowerCase()));
    data = { ...data, name: data.name ?? generateNames(1, Math.random, undefined, taken)[0], uwp: world.uwp, bases: world.bases, pbg: world.pbg, zone: world.zone, stars: world.stars };
  } else {
    const uwp = check.optStr(p.uwp, 'uwp', { max: 9 })?.toUpperCase();
    if (uwp && !isValidUwp(uwp)) throw new ActionError(`"${uwp}" is not a valid world profile (e.g. CA6A643-9)`);
    data = { ...data, uwp, bases: check.optStr(p.bases, 'bases', { max: 8 }), pbg: check.optStr(p.pbg, 'pbg', { max: 3 }), stars: check.optStr(p.stars, 'stars', { max: 60 }) };
  }
  const system = createSystem(ctx.tx, sector, data);
  if (p.reveal) applyPreset(ctx.tx, system.id, check.oneOf(p.reveal.preset, 'reveal.preset', Object.keys(PRESETS)), checkAudience(ctx.tx, p.reveal.audience, 'reveal.audience'));
  return { id: system.id };
});

action('system.move', (ctx, p) => {
  requireGm(ctx.me);
  const system = ctx.tx.need('system', check.id(p.id, 'id'));
  const sector = ctx.tx.need('sector', check.id(p.sectorId ?? system.sectorId, 'sectorId'));
  const hex = checkHex(p.hex);
  const occupant = systemAt(ctx.tx, sector.id, hex);
  if (occupant && occupant.id !== system.id) throw new ActionError(`Hex ${hex} already has a system`);
  ctx.tx.update<StarSystem>(system.id, (s) => {
    s.sectorId = sector.id;
    s.hex = hex;
  });
});

action('system.regenerate', (ctx, p) => {
  requireGm(ctx.me);
  const system = ctx.tx.need('system', check.id(p.id, 'id'));
  const world = generateWorld(worldRules(ctx), Math.random);
  ctx.tx.update<StarSystem>(system.id, (s) => {
    s.uwp = world.uwp;
    s.bases = world.bases;
    s.pbg = world.pbg;
    s.zone = world.zone;
    s.stars = world.stars;
    delete s.remarks;
    delete s.ext;
  });
  rebuildBodies(ctx.tx, system.id);
});

/** Replaces a system's survey bodies, keeping custom bodies and the knowledge of the mainworld. */
function rebuildBodies(tx: Tx, systemId: Id): void {
  const system = tx.need('system', systemId);
  const old = tx.where('body', 'systemId', systemId).filter((b) => b.origin === 'survey');
  const mainKnown = old.find((b) => b.mainworld)?.known;
  const mainNotes = old.find((b) => b.mainworld)?.notes;
  const oldMainId = old.find((b) => b.mainworld)?.id;
  const customChildren = tx.where('body', 'systemId', systemId).filter((b) => b.origin !== 'survey');
  for (const body of old) tx.delete(body.id);
  const made = buildSurveyBodies(tx, system);
  const main = made.find((b) => b.mainworld);
  if (main) {
    tx.update<Body>(main.id, (b) => {
      if (mainKnown) b.known = mainKnown;
      if (mainNotes) b.notes = mainNotes;
    });
    // Points of interest that sat on the old mainworld move to the new one.
    for (const child of customChildren) {
      if (child.parentId && child.parentId === oldMainId) tx.update<Body>(child.id, (b) => void (b.parentId = main.id));
    }
  }
  for (const child of customChildren) {
    if (child.parentId && child.parentId !== oldMainId && !tx.get(child.parentId)) tx.update<Body>(child.id, (b) => void delete b.parentId);
  }
}

action('system.rebuildBodies', (ctx, p) => {
  requireGm(ctx.me);
  rebuildBodies(ctx.tx, check.id(p.id, 'id'));
});

// ── bodies ──

action('body.create', (ctx, p) => {
  requireGm(ctx.me);
  const system = ctx.tx.need('system', check.id(p.systemId, 'systemId'));
  const kind = check.oneOf(p.kind, 'kind', BODY_KINDS);
  let parentId: Id | undefined;
  if (p.parentId) {
    const parent = ctx.tx.need('body', check.id(p.parentId, 'parentId'));
    if (parent.systemId !== system.id) throw new ActionError('The parent body is in another system');
    parentId = parent.id;
  }
  const siblings = ctx.tx.where('body', 'systemId', system.id).filter((b) => b.parentId === parentId);
  const orbit = p.orbit === undefined ? Math.max(0, ...siblings.map((b) => b.orbit)) + 1 : check.num(p.orbit, 'orbit', { min: 0, max: 1000 });
  const uwp = check.optStr(p.uwp, 'uwp', { max: 9 })?.toUpperCase();
  if (uwp && !isValidUwp(uwp)) throw new ActionError(`"${uwp}" is not a valid world profile`);
  const body = ctx.tx.create('body', {
    systemId: system.id,
    parentId,
    kind,
    orbit,
    name: check.optStr(p.name, 'name', { max: 80 }),
    subtype: check.optStr(p.subtype, 'subtype', { max: 60 }),
    summary: check.optStr(p.summary, 'summary', { max: 600 }),
    uwp,
    origin: 'custom',
  });
  if (p.reveal) applyPreset(ctx.tx, body.id, check.oneOf(p.reveal.preset, 'reveal.preset', Object.keys(PRESETS)), checkAudience(ctx.tx, p.reveal.audience, 'reveal.audience'));
  return { id: body.id };
});

// ── routes & regions ──

action('route.create', (ctx, p) => {
  requireGm(ctx.me);
  const a = ctx.tx.need('system', check.id(p.a, 'a'));
  const b = ctx.tx.need('system', check.id(p.b, 'b'));
  if (a.id === b.id) throw new ActionError('A route needs two different systems');
  const kind = check.oneOf(p.kind ?? 'comm', 'kind', ROUTE_KINDS);
  const existing = ctx.tx.where('route', 'a', a.id).concat(ctx.tx.where('route', 'a', b.id)).find((r) => r.kind === kind && ((r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id)));
  if (existing) return { id: existing.id, existed: true };
  const route = ctx.tx.create('route', { a: a.id, b: b.id, kind, label: check.optStr(p.label, 'label', { max: 60 }) });
  return { id: route.id };
});

action('routes.suggest', (ctx, p) => {
  requireGm(ctx.me);
  const rules = worldRules(ctx);
  const sector = ctx.tx.need('sector', check.id(p.sectorId, 'sectorId'));
  const systems = ctx.tx.where('system', 'sectorId', sector.id);
  const worlds = systems.map((s) => {
    const h = parseHex(s.hex)!;
    return { pos: toGlobal(sector.x, sector.y, h.col, h.row), codes: systemTradeCodes(s.uwp, s.remarks, rules) };
  });
  let created = 0;
  for (const pair of suggestTradeRoutes(worlds, rules)) {
    const a = systems[pair.a];
    const b = systems[pair.b];
    const exists = ctx.tx.where('route', 'a', a.id).concat(ctx.tx.where('route', 'a', b.id)).some((r) => r.kind === 'trade' && ((r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id)));
    if (exists) continue;
    ctx.tx.create('route', { a: a.id, b: b.id, kind: 'trade' });
    created++;
  }
  return { created };
});

action('region.create', (ctx, p) => {
  requireGm(ctx.me);
  const region = ctx.tx.create('region', {
    name: check.str(p.name, 'name', { max: 60 }),
    color: check.str(p.color ?? '#e5484d', 'color', { max: 20 }),
    hexes: check.arr(p.hexes ?? [], 'hexes', (v, n) => check.str(v, n, { max: 24 }), 20_000),
  });
  return { id: region.id };
});

// ── party location ──

action('party.moveTo', (ctx, p) => {
  requireGm(ctx.me);
  const system = ctx.tx.need('system', check.id(p.systemId, 'systemId'));
  const bodyId = p.bodyId ? ctx.tx.need('body', check.id(p.bodyId, 'bodyId')).id : undefined;
  ctx.tx.update<Campaign>(CAMPAIGN_ID, (c) => {
    c.location = { systemId: system.id, bodyId };
  });
  // The party's ships travel with them.
  for (const ship of ctx.tx.all('ship')) {
    if (ship.party) ctx.tx.update(ship.id, (s) => void ((s as typeof ship).location = { systemId: system.id, bodyId, status: 'docked' }));
  }
  // Arriving somewhere means the party at least knows the system is there.
  if (p.reveal !== false) applyPreset(ctx.tx, system.id, 'charted', 'party');
});

// ── import & generation ──

function checkWorld(value: unknown, name: string): ParsedWorld {
  const w = check.obj(value, name);
  const uwp = check.str(w.uwp, `${name}.uwp`, { max: 9 }).toUpperCase();
  if (!isValidUwp(uwp)) throw new ActionError(`${name}: "${uwp}" is not a valid world profile`);
  const zone = w.zone === 'A' || w.zone === 'R' ? w.zone : '';
  return {
    hex: checkHex(w.hex, `${name}.hex`),
    name: check.optStr(w.name, `${name}.name`, { max: 60 }) ?? '',
    uwp,
    bases: check.optStr(w.bases, `${name}.bases`, { max: 8 }),
    remarks: check.optStr(w.remarks, `${name}.remarks`, { max: 200 }),
    zone,
    pbg: check.optStr(w.pbg, `${name}.pbg`, { max: 3 }),
    allegiance: check.optStr(w.allegiance, `${name}.allegiance`, { max: 8 }),
    stars: check.optStr(w.stars, `${name}.stars`, { max: 60 }),
    ix: check.optStr(w.ix, `${name}.ix`, { max: 12 }),
    ex: check.optStr(w.ex, `${name}.ex`, { max: 12 }),
    cx: check.optStr(w.cx, `${name}.cx`, { max: 12 }),
    nobility: check.optStr(w.nobility, `${name}.nobility`, { max: 12 }),
    worlds: check.optStr(w.worlds, `${name}.worlds`, { max: 4 }),
    ru: check.optStr(w.ru, `${name}.ru`, { max: 12 }),
  };
}

function extOf(w: ParsedWorld): StarSystem['ext'] | undefined {
  const ext = { ix: w.ix, ex: w.ex, cx: w.cx, nobility: w.nobility, worlds: w.worlds, ru: w.ru };
  return Object.values(ext).some((v) => v !== undefined) ? ext : undefined;
}

export interface ImportSummary {
  created: number;
  replaced: number;
  skipped: number;
  routes: number;
  systemIds: Id[];
}

/** Writes parsed worlds into a sector. Hexes must already be sector-relative. */
export function importWorlds(
  tx: Tx,
  sector: Sector,
  worlds: ParsedWorld[],
  opts: { mode: 'skip' | 'replace'; subsectorNames?: Record<string, string>; routes?: { start: string; end: string }[] },
): ImportSummary {
  const summary: ImportSummary = { created: 0, replaced: 0, skipped: 0, routes: 0, systemIds: [] };
  const byHex = new Map(tx.where('system', 'sectorId', sector.id).map((s) => [s.hex, s]));

  for (const w of worlds) {
    const data = {
      hex: w.hex,
      name: w.name || undefined,
      uwp: w.uwp,
      bases: w.bases,
      remarks: w.remarks,
      zone: (w.zone ?? '') as TravelZone,
      pbg: w.pbg,
      allegiance: w.allegiance,
      stars: w.stars,
      ext: extOf(w),
    };
    const existing = byHex.get(w.hex);
    if (existing) {
      if (opts.mode === 'skip') {
        summary.skipped++;
        continue;
      }
      // Replace survey data in place so knowledge, notes and wiki links are kept.
      tx.update<StarSystem>(existing.id, (s) => {
        Object.assign(s, data);
        for (const key of Object.keys(data) as (keyof typeof data)[]) if (data[key] === undefined) delete (s as unknown as Record<string, unknown>)[key];
      });
      rebuildBodies(tx, existing.id);
      summary.replaced++;
      summary.systemIds.push(existing.id);
      continue;
    }
    const system = createSystem(tx, sector, data);
    byHex.set(w.hex, system);
    summary.created++;
    summary.systemIds.push(system.id);
  }

  if (opts.subsectorNames && Object.keys(opts.subsectorNames).length) {
    tx.update<Sector>(sector.id, (s) => {
      for (const [letter, name] of Object.entries(opts.subsectorNames!)) {
        if (SUBSECTOR_LETTERS.includes(letter) && name && !s.subsectors[letter]) s.subsectors[letter] = name.slice(0, 60);
      }
    });
  }

  for (const r of opts.routes ?? []) {
    const a = byHex.get(r.start);
    const b = byHex.get(r.end);
    if (!a || !b || a.id === b.id) continue;
    const exists = tx.where('route', 'a', a.id).concat(tx.where('route', 'a', b.id)).some((x) => (x.a === a.id && x.b === b.id) || (x.a === b.id && x.b === a.id));
    if (exists) continue;
    tx.create('route', { a: a.id, b: b.id, kind: 'comm' });
    summary.routes++;
  }
  return summary;
}

action('map.import', (ctx, p) => {
  requireGm(ctx.me);
  const sector = ctx.tx.need('sector', check.id(p.sectorId, 'sectorId'));
  let worlds = check.arr(p.worlds, 'worlds', checkWorld, 2000);
  if (p.subsector) {
    // Subsector-local data: shift 0101–0810 into the chosen subsector.
    const letter = check.oneOf(p.subsector, 'subsector', SUBSECTOR_LETTERS.split(''));
    const { col0, row0 } = subsectorOrigin(letter);
    worlds = worlds.map((w) => {
      const h = parseHex(w.hex)!;
      if (h.col > 8 || h.row > 10) throw new ActionError(`Hex ${w.hex} does not fit in a single subsector`);
      return { ...w, hex: formatHex(h.col + col0, h.row + row0) };
    });
  }
  const mode = check.oneOf(p.mode ?? 'skip', 'mode', ['skip', 'replace'] as const);
  const subsectorNames: Record<string, string> = {};
  for (const [letter, name] of Object.entries(check.obj(p.subsectorNames ?? {}, 'subsectorNames'))) {
    if (typeof name === 'string') subsectorNames[letter.toUpperCase()] = name;
  }
  const routes = check.arr(p.routes ?? [], 'routes', (v, n) => {
    const r = check.obj(v, n);
    return { start: checkHex(r.start, `${n}.start`), end: checkHex(r.end, `${n}.end`) };
  }, 5000);
  const summary = importWorlds(ctx.tx, sector, worlds, { mode, subsectorNames, routes });
  if (p.sectorName && typeof p.sectorName === 'string' && p.renameSector) {
    ctx.tx.update<Sector>(sector.id, (s) => void (s.name = check.str(p.sectorName, 'sectorName', { max: 60 })));
  }
  if (p.reveal) {
    const preset = check.oneOf(p.reveal.preset, 'reveal.preset', Object.keys(PRESETS));
    const audience = checkAudience(ctx.tx, p.reveal.audience, 'reveal.audience');
    for (const id of summary.systemIds) applyPreset(ctx.tx, id, preset, audience);
  }
  publishToWiki(ctx, summary.systemIds);
  return summary;
});

action('map.generate', (ctx, p) => {
  requireGm(ctx.me);
  const rules = worldRules(ctx);
  const sector = ctx.tx.need('sector', check.id(p.sectorId, 'sectorId'));
  const density = check.oneOf(p.density ?? 'standard', 'density', Object.keys(rules.generation.occurrence.density));
  const letters = p.subsector ? [check.oneOf(p.subsector, 'subsector', SUBSECTOR_LETTERS.split(''))] : SUBSECTOR_LETTERS.split('');
  const seed = p.seed === undefined ? Math.floor(Math.random() * 2 ** 31) : check.int(p.seed, 'seed', { min: 0 });
  const rng = seededRng(seed);
  const nameStyle = check.optStr(p.nameStyle, 'nameStyle', { max: 20 });
  // What to do when the target area already has systems: stop, fill the empty hexes, or start over.
  const existing = check.oneOf(p.existing ?? 'abort', 'existing', ['abort', 'fill', 'replace'] as const);
  const inArea = ctx.tx.where('system', 'sectorId', sector.id).filter((s) => {
    const h = parseHex(s.hex)!;
    return letters.includes(subsectorOf(h.col, h.row));
  });
  if (inArea.length && existing === 'abort') {
    throw new ActionError(`That area already has ${inArea.length} system${inArea.length === 1 ? '' : 's'}. Choose whether to fill the empty hexes or replace them.`);
  }
  if (existing === 'replace') for (const system of inArea) cascadeDelete(ctx.tx, system.id);
  const occupied = new Set(ctx.tx.where('system', 'sectorId', sector.id).map((s) => s.hex));
  const taken = new Set(ctx.tx.all('system').map((s) => (s.name ?? '').toLowerCase()));

  const worlds: ParsedWorld[] = [];
  for (const letter of letters) {
    const { col0, row0 } = subsectorOrigin(letter);
    const generated = generateArea(rules, rng, { density, col0, row0, skip: occupied, autoAmber: p.autoAmber !== false });
    const names = generateNames(generated.length, rng, nameStyle, taken);
    generated.forEach((g, i) => worlds.push({ hex: g.hex, name: names[i], uwp: g.uwp, bases: g.bases || undefined, pbg: g.pbg, zone: g.zone, stars: g.stars }));
  }
  const summary = importWorlds(ctx.tx, sector, worlds, { mode: 'skip' });
  if (p.reveal) {
    const preset = check.oneOf(p.reveal.preset, 'reveal.preset', Object.keys(PRESETS));
    const audience = checkAudience(ctx.tx, p.reveal.audience, 'reveal.audience');
    for (const id of summary.systemIds) applyPreset(ctx.tx, id, preset, audience);
  }
  publishToWiki(ctx, summary.systemIds);
  return { ...summary, seed };
});

/** Hands newly created systems to the wiki service (if one is configured) once the change has committed. */
function publishToWiki(ctx: ActionCtx, systemIds: Id[]): void {
  if (systemIds.length === 0) return;
  const campaign = ctx.tx.get<Campaign>(CAMPAIGN_ID);
  if (!campaign?.settings.wikiAutoPublish) return;
  const wiki = ctx.services.extra.wiki as { publishEntities(ids: Id[]): Promise<unknown> } | undefined;
  if (wiki) ctx.after(() => wiki.publishEntities(systemIds).then(() => undefined));
}
