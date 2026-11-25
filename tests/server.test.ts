import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Body, Campaign, Sector, StarSystem } from '../src/shared/types';
import { startServer } from '../src/server/index';
import { eventually, HAS_CORE_RULES, post, setTable, TestClient, testConfig, type Table } from './helpers';

let table: Table;
let ann: Awaited<ReturnType<Table['join']>>;
let bob: Awaited<ReturnType<Table['join']>>;

beforeAll(async () => {
  table = await setTable();
  ann = await table.join('Ann');
  bob = await table.join('Bob');
});
afterAll(async () => {
  await table.close();
});

describe('sign-in', () => {
  it('reports status and refuses bad credentials', async () => {
    const status = await (await fetch(`http://127.0.0.1:${table.port}/api/status`)).json();
    expect(status).toMatchObject({ needsSetup: false, campaignName: 'Test Campaign' });
    expect((await post(table.port, '/api/login/gm', { password: 'wrong' })).status).toBe(403);
    expect((await post(table.port, '/api/login/player', { code: 'NOPE-NOPE' })).status).toBe(403);
    expect((await post(table.port, '/api/setup', { setupCode: 'x', password: 'whatever' })).status).toBe(409);
    expect((await post(table.port, '/api/login/gm', { password: 'correct horse' })).status).toBe(200);
  });

  it('rejects a socket with a bad token', async () => {
    const c = new TestClient();
    await expect(TestClient.connect(table.port, 'not-a-token')).resolves.toMatchObject({ closed: true });
    c.closed = true;
  });

  it('gives everyone the campaign and the player list, but not other people\'s invite codes', () => {
    expect(ann.client.all('campaign')[0]).toMatchObject({ name: 'Test Campaign' });
    expect(ann.client.all('player').map((p) => p.name).sort()).toEqual(['Ann', 'Bob', 'Ref']);
    expect(JSON.stringify([...ann.client.ents.values()])).not.toContain(bob.code);
  });

  it('only lets the GM use GM actions', async () => {
    await expect(ann.client.act('sector.create', { name: 'Nope', x: 0, y: 0 })).rejects.toThrow(/Only the GM/);
    await expect(ann.client.act('player.create', { name: 'Eve' })).rejects.toThrow(/Only the GM/);
    await expect(ann.client.act('view.as', { playerId: bob.id })).rejects.toThrow(/Only the GM/);
    await expect(ann.client.act('no.such.action')).rejects.toThrow(/Unknown action/);
  });
});

describe('map knowledge', () => {
  let sectorId: string;
  let ardent: string;
  let vesk: string;

  it('creates a sector and systems that players cannot see yet', async () => {
    sectorId = (await table.gm.act('sector.create', { name: 'Kestrel Reach', x: 0, y: 0 })).id;
    ardent = (await table.gm.act('system.create', { sectorId, hex: '0103', name: 'Ardent', uwp: 'A646930-D', bases: 'NS', pbg: '812', stars: 'F8 V M2 V' })).id;
    vesk = (await table.gm.act('system.create', { sectorId, hex: '0308', name: 'Vesk', uwp: 'X555423-2', pbg: '013' })).id;
    await eventually(() => expect(table.gm.all('system')).toHaveLength(2));
    await expect(table.gm.act('system.create', { sectorId, hex: '0103', name: 'Clash' })).rejects.toThrow(/already has a system/);
    await expect(table.gm.act('system.create', { sectorId, hex: '0104', uwp: 'ZZZ' })).rejects.toThrow(/not a valid world profile/);
    // Survey bodies: two stars, the mainworld, one belt and two gas giants.
    const bodies = table.gm.all('body').filter((b) => b.systemId === ardent);
    expect(bodies.filter((b) => b.kind === 'star').map((b) => b.subtype)).toEqual(['F8 V', 'M2 V']);
    expect(bodies.filter((b) => b.mainworld)).toHaveLength(1);
    expect(bodies.filter((b) => b.kind === 'belt')).toHaveLength(1);
    expect(bodies.filter((b) => b.kind === 'gasGiant')).toHaveLength(2);
    expect(ann.client.all('sector')).toHaveLength(0);
    expect(ann.client.all('system')).toHaveLength(0);
    expect(ann.client.all('body')).toHaveLength(0);
  });

  it('reveals step by step, to the party or to one player', async () => {
    await table.gm.act('reveal.set', { ids: [ardent], facets: ['exists'], audience: 'party', on: true });
    await eventually(() => expect(ann.client.all('system')).toHaveLength(1));
    // The sector is revealed along with its first system.
    expect(ann.client.all('sector').map((s: Sector) => s.name)).toEqual(['Kestrel Reach']);
    expect(ann.client.get<StarSystem>(ardent)).toMatchObject({ hex: '0103' });
    expect(ann.client.get<StarSystem>(ardent)!.name).toBeUndefined();
    expect(ann.client.get<StarSystem>(ardent)!.uwp).toBeUndefined();

    await table.gm.act('reveal.set', { ids: [ardent], facets: ['name'], audience: ann.id, on: true });
    await eventually(() => expect(ann.client.get<StarSystem>(ardent)!.name).toBe('Ardent'));
    expect(bob.client.get<StarSystem>(ardent)!.name).toBeUndefined();
  });

  it('charting a system reveals survey bodies; hiding it removes everything', async () => {
    await table.gm.act('reveal.preset', { ids: [ardent], preset: 'charted', audience: 'party' });
    await eventually(() => expect(bob.client.get<StarSystem>(ardent)).toMatchObject({ name: 'Ardent', uwp: 'A646930-D', bases: 'NS' }));
    await eventually(() => expect(bob.client.all('body').filter((b: Body) => b.systemId === ardent)).toHaveLength(6));

    // A custom point of interest stays secret until revealed on its own.
    const main = table.gm.all('body').find((b) => b.systemId === ardent && b.mainworld)!;
    const poi = (await table.gm.act('body.create', { systemId: ardent, parentId: main.id, kind: 'poi', name: 'Smuggler cache', subtype: 'hideout' })).id;
    await eventually(() => expect(table.gm.get(poi)).toBeDefined());
    expect(bob.client.get(poi)).toBeUndefined();
    await table.gm.act('reveal.preset', { ids: [poi], preset: 'charted', audience: bob.id });
    await eventually(() => expect(bob.client.get<Body>(poi)).toMatchObject({ name: 'Smuggler cache' }));
    expect(ann.client.get(poi)).toBeUndefined();

    await table.gm.act('reveal.preset', { ids: [ardent], preset: 'hidden', audience: 'party' });
    // Party knowledge is gone, but what each player learned personally stays: Ann knows the name,
    // and Bob knows the cache, the world it is on and that the system exists.
    await eventually(() => expect(ann.client.all('body').filter((b: Body) => b.systemId === ardent)).toHaveLength(0));
    expect(ann.client.get<StarSystem>(ardent)).toMatchObject({ name: 'Ardent' });
    expect(ann.client.get<StarSystem>(ardent)!.uwp).toBeUndefined();
    await eventually(() => expect(bob.client.all('body').filter((b: Body) => b.systemId === ardent).map((b: Body) => b.name).sort()).toEqual(['Smuggler cache', undefined].sort()));
    expect(bob.client.get<StarSystem>(ardent)!.name).toBeUndefined();
    await table.gm.act('reveal.preset', { ids: [ardent], preset: 'charted', audience: 'party' });
    await eventually(() => expect(bob.client.get<StarSystem>(ardent)!.uwp).toBe('A646930-D'));
  });

  it('never sends hidden data, GM notes or knowledge lists to players', async () => {
    await table.gm.act('entity.patch', { id: vesk, ops: [{ op: 'set', path: ['gm', 'secret'], value: 'Ancient vault under the ice' }] });
    await table.gm.act('note.add', { entityId: ardent, title: 'Rumour', body: 'The port master takes bribes.' });
    await eventually(() => expect(table.gm.get<StarSystem>(ardent)!.notes).toHaveLength(1));
    const seen = JSON.stringify([...ann.client.ents.values()]) + JSON.stringify([...bob.client.ents.values()]);
    expect(seen).not.toMatch(/Vesk|Ancient vault|bribes|"known":\{|"gm":/);

    const noteId = table.gm.get<StarSystem>(ardent)!.notes![0].id;
    await table.gm.act('note.reveal', { entityId: ardent, noteId, audience: ann.id, on: true });
    await eventually(() => expect(ann.client.get<StarSystem>(ardent)!.notes?.[0].body).toMatch(/bribes/));
    expect(bob.client.get<StarSystem>(ardent)!.notes).toBeUndefined();
  });

  it('lets the GM preview exactly what a player or the party sees', async () => {
    const asAnn = await TestClient.connect(table.port, table.gmToken, ann.id);
    expect(asAnn.me).toMatchObject({ role: 'gm', viewAs: ann.id });
    expect(asAnn.get<StarSystem>(ardent)!.notes?.[0].title).toBe('Rumour');
    expect(asAnn.get(vesk)).toBeUndefined();
    const snap = asAnn.nextSnapshot();
    await asAnn.act('view.as', { playerId: '__party__' });
    await snap;
    expect(asAnn.get<StarSystem>(ardent)!.notes).toBeUndefined();
    const back = asAnn.nextSnapshot();
    await asAnn.act('view.as', {});
    await back;
    expect(asAnn.get<StarSystem>(vesk)).toMatchObject({ name: 'Vesk' });
    asAnn.close();
  });

  it('draws routes only between systems the viewer knows', async () => {
    const route = (await table.gm.act('route.create', { a: ardent, b: vesk, kind: 'comm' })).id;
    await table.gm.act('reveal.set', { ids: [route], facets: ['exists'], audience: 'party', on: true });
    await eventually(() => expect(table.gm.get(route)).toBeDefined());
    expect(ann.client.get(route)).toBeUndefined();
    await table.gm.act('reveal.preset', { ids: [vesk], preset: 'detected', audience: 'party' });
    await eventually(() => expect(ann.client.get(route)).toBeDefined());
    await table.gm.act('reveal.preset', { ids: [vesk], preset: 'hidden', audience: 'party' });
    await eventually(() => expect(ann.client.get(route)).toBeUndefined());
  });

  it('moves the party and marks the destination as charted', async () => {
    await table.gm.act('party.moveTo', { systemId: vesk });
    await eventually(() => expect(ann.client.all('campaign')[0] as Campaign).toMatchObject({ location: { systemId: vesk } }));
    await eventually(() => expect(ann.client.get<StarSystem>(vesk)).toMatchObject({ name: 'Vesk', uwp: 'X555423-2' }));
  });

  it('deleting a system removes its bodies and routes for everyone', async () => {
    await table.gm.act('entity.delete', { id: vesk });
    await eventually(() => expect(ann.client.get(vesk)).toBeUndefined());
    expect(table.gm.all('body').filter((b) => b.systemId === vesk)).toHaveLength(0);
    expect(table.gm.all('route')).toHaveLength(0);
    expect((table.gm.all('campaign')[0] as Campaign).location).toBeUndefined();
  });
});

describe('imports and generation', () => {
  it('imports parsed worlds into a subsector with routes and names', async () => {
    const sectorId = (await table.gm.act('sector.create', { name: 'Import Test', x: 1, y: 0 })).id;
    const summary = await table.gm.act('map.import', {
      sectorId,
      subsector: 'F',
      worlds: [
        { hex: '0101', name: 'Brannoch', uwp: 'C8759A9-8', bases: 'S', zone: 'A', pbg: '504' },
        { hex: '0307', name: 'St. Idris', uwp: 'B544756-A', pbg: '212', stars: 'G2 V' },
      ],
      subsectorNames: { F: 'The Shallows' },
      routes: [{ start: '0911', end: '1117' }],
      reveal: { preset: 'charted', audience: 'party' },
    });
    expect(summary).toMatchObject({ created: 2, replaced: 0, skipped: 0, routes: 1 });
    await eventually(() => expect(ann.client.all('system').filter((s: StarSystem) => s.sectorId === sectorId).map((s: StarSystem) => s.hex).sort()).toEqual(['0911', '1117']));
    expect(table.gm.get<Sector>(sectorId)!.subsectors).toEqual({ F: 'The Shallows' });

    // Importing again skips by default, and replaces in place (keeping knowledge) when asked.
    const again = await table.gm.act('map.import', { sectorId, subsector: 'F', worlds: [{ hex: '0101', name: 'Brannoch II', uwp: 'B8759A9-9' }] });
    expect(again).toMatchObject({ created: 0, skipped: 1 });
    const replaced = await table.gm.act('map.import', { sectorId, subsector: 'F', mode: 'replace', worlds: [{ hex: '0101', name: 'Brannoch II', uwp: 'B8759A9-9' }] });
    expect(replaced).toMatchObject({ replaced: 1 });
    await eventually(() => expect(ann.client.all('system').find((s: StarSystem) => s.hex === '0911')).toMatchObject({ name: 'Brannoch II', uwp: 'B8759A9-9' }));
    await expect(table.gm.act('map.import', { sectorId, subsector: 'A', worlds: [{ hex: '0911', name: 'Too far', uwp: 'B8759A9-9' }] })).rejects.toThrow(/does not fit/);
  });

  it.skipIf(!HAS_CORE_RULES)('generates a subsector from the rules pack, reproducibly by seed', async () => {
    const sectorId = (await table.gm.act('sector.create', { name: 'Generated', x: 0, y: 1 })).id;
    const first = await table.gm.act('map.generate', { sectorId, subsector: 'A', seed: 42 });
    expect(first.created).toBeGreaterThan(20);
    expect(first.created).toBeLessThan(60);
    await eventually(() => expect(table.gm.all('system').filter((s) => s.sectorId === sectorId)).toHaveLength(first.created));
    const profile = (id: string) => table.gm.all('system').filter((s) => s.sectorId === id).map((s) => `${s.hex} ${s.uwp} ${s.bases ?? ''} ${s.pbg}`).sort();
    const a = profile(sectorId);
    expect(a.every((line) => /^\d{4} [A-EX][0-9A-HJ-NP-Z]{6}-[0-9A-HJ-NP-Z] /.test(line))).toBe(true);

    const second = (await table.gm.act('sector.create', { name: 'Generated again', x: 0, y: 2 })).id;
    await table.gm.act('map.generate', { sectorId: second, subsector: 'A', seed: 42 });
    await eventually(() => expect(profile(second)).toEqual(a));
    // An occupied area is never changed by accident: the GM must choose to fill or replace.
    await expect(table.gm.act('map.generate', { sectorId, subsector: 'A', seed: 42 })).rejects.toThrow(/already has/);
    expect((await table.gm.act('map.generate', { sectorId, subsector: 'A', seed: 42, existing: 'replace' })).created).toBe(first.created);
    await eventually(() => expect(profile(sectorId)).toEqual(a));
    expect((await table.gm.act('map.generate', { sectorId, subsector: 'A', seed: 7, existing: 'fill' })).created).toBeGreaterThan(0);
    expect(ann.client.all('system').filter((s: StarSystem) => s.sectorId === sectorId)).toHaveLength(0);
  });
});

describe('objectives and dice', () => {
  it('keeps personal objectives private and lets owners edit only their own', async () => {
    const mine = (await ann.client.act('objective.create', { title: 'Find my sister' })).id;
    const shared = (await table.gm.act('objective.create', { title: 'Deliver the cargo' })).id;
    await eventually(() => expect(bob.client.get(shared)).toBeDefined());
    expect(bob.client.get(mine)).toBeUndefined();
    expect(table.gm.get(mine)).toBeDefined();
    await ann.client.act('entity.patch', { id: mine, ops: [{ op: 'set', path: ['status'], value: 'done' }] });
    await expect(bob.client.act('entity.patch', { id: shared, ops: [{ op: 'set', path: ['title'], value: 'Hacked' }] })).rejects.toThrow(/cannot edit/);
    await expect(ann.client.act('entity.patch', { id: mine, ops: [{ op: 'set', path: ['createdBy'], value: bob.id }] })).rejects.toThrow();
    await expect(bob.client.act('entity.delete', { id: mine })).rejects.toThrow(/cannot delete/);
    await expect(ann.client.act('objective.create', { title: 'Sneaky', scope: 'party' })).rejects.toThrow(/personal/);
  });

  it('rolls dice on the server, accepts table rolls, and hides GM rolls', async () => {
    const r = await ann.client.act('dice.roll', { label: 'Pilot check', dm: 2, target: 8, actor: 'Jax' });
    expect(r.dice).toHaveLength(2);
    expect(r.total).toBe(r.dice[0] + r.dice[1] + 2);
    expect(r.effect).toBe(r.total - 8);
    await eventually(() => expect(bob.client.get(r.id)).toMatchObject({ label: 'Pilot check', actor: 'Jax' }));

    const manual = await bob.client.act('dice.roll', { label: 'At the table', manual: [6, 6], dm: -1 });
    expect(manual.total).toBe(11);
    await expect(bob.client.act('dice.roll', { label: 'Cheat', manual: [7, 7] })).rejects.toThrow();

    const secret = await table.gm.act('dice.roll', { label: 'Ambush?', to: 'gm' });
    await eventually(() => expect(table.gm.get(secret.id)).toBeDefined());
    expect(ann.client.get(secret.id)).toBeUndefined();
  });

  it('pushes navigation to players only', async () => {
    await table.gm.act('ui.push', { path: '/map' });
    await eventually(() => expect(ann.client.events.some((e) => e.ev === 'navigate' && e.d.path === '/map')).toBe(true));
    expect(table.gm.events.some((e) => e.ev === 'navigate')).toBe(false);
  });
});

describe('players', () => {
  it('signs a player out when their invite is reset, and removes their knowledge when deleted', async () => {
    const eve = await table.join('Eve');
    const sys = table.gm.all('system')[0];
    await table.gm.act('reveal.set', { ids: [sys.id], facets: ['exists'], audience: eve.id, on: true });
    await eventually(() => expect(table.gm.get<StarSystem>(sys.id)!.known!.exists).toContain(eve.id));

    const fresh = await table.gm.act('player.invite', { id: eve.id, reset: true });
    expect(fresh.code).not.toBe(eve.code);
    await eventually(() => expect(eve.client.closed).toBe(true));
    expect((await post(table.port, '/api/login/player', { code: eve.code })).status).toBe(403);
    expect((await post(table.port, '/api/login/player', { code: fresh.code })).status).toBe(200);

    await table.gm.act('player.remove', { id: eve.id });
    await eventually(() => expect(table.gm.get(eve.id)).toBeUndefined());
    expect(table.gm.get<StarSystem>(sys.id)!.known!.exists ?? []).not.toContain(eve.id);
    expect((await post(table.port, '/api/login/player', { code: fresh.code })).status).toBe(403);
  });
});

describe('persistence', () => {
  it('keeps the campaign and sessions across a restart', async () => {
    const config = testConfig();
    let running = await startServer(config, { quiet: true });
    const setup = await post(running.port, '/api/setup', { setupCode: running.services.auth.setupCode, campaignName: 'Durable', password: 'correct horse' });
    let gm = await TestClient.connect(running.port, setup.json.token);
    const sectorId = (await gm.act('sector.create', { name: 'Persisted', x: 3, y: 3 })).id;
    await gm.act('system.create', { sectorId, hex: '0505', name: 'Anchor', uwp: 'B789876-A' });
    gm.close();
    await running.close();

    running = await startServer(config, { quiet: true });
    gm = await TestClient.connect(running.port, setup.json.token);
    expect(gm.all('campaign')[0]).toMatchObject({ name: 'Durable' });
    expect(gm.all('system').map((s) => s.name)).toEqual(['Anchor']);
    expect(gm.all('body').length).toBeGreaterThan(0);
    gm.close();
    await running.close();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });
});
