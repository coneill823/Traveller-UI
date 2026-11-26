import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePage } from '../src/shared/markdown';
import type { Body, StarSystem, WikiPage } from '../src/shared/types';
import { RulesService } from '../src/server/rules';
import { GitHubBackend, gitBlobSha } from '../src/server/wiki/backend';
import { vaultRulepackDir, VAULT_RULEPACKS } from '../src/server/wiki/rulepacks';
import { eventually, setTable, testConfig, type Table } from './helpers';

const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
const write = (dir: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};
const pageAt = (t: Table, rel: string) => t.gm.all('wikiPage').find((p) => p.path === rel);

describe('wiki sync with a local Chronicler vault', () => {
  let table: Table;
  let vault: string;
  let ann: Awaited<ReturnType<Table['join']>>;
  let sectorId: string;
  let ardent: string;
  const ARDENT = 'Atlas/Kestrel Reach/Subsector A/Ardent.md';

  beforeAll(async () => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'traveller-vault-'));
    write(vault, 'Test.md', 'Hello\n---\ntags: [add, your, tags]\n---\n');
    write(vault, 'Lore/The Cult.md', '---\ntitle: The Cult of the Ninth Star\ntags: [faction]\n---\nThey meet at night.\n\n## GM Notes\nThe duke is a member.\n');
    write(vault, '.obsidian/ignored.md', 'not a page');
    table = await setTable({ wiki: { dir: vault, branch: 'main', pollSeconds: 3600, atlasFolder: 'Atlas' } });
    ann = await table.join('Ann');
    sectorId = (await table.gm.act('sector.create', { name: 'Kestrel Reach', x: 0, y: 0 })).id;
    ardent = (await table.gm.act('system.create', { sectorId, hex: '0103', name: 'Ardent', uwp: 'A646930-D', bases: 'NS', pbg: '812' })).id;
    await table.gm.act('reveal.preset', { ids: [ardent], preset: 'charted', audience: 'party' });
  });
  afterAll(async () => {
    await table.close();
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('reads existing pages, skipping hidden folders, and shows players nothing by default', async () => {
    const summary = await table.gm.act('wiki.sync');
    expect(summary.pagesRead).toBe(2);
    await eventually(() => expect(table.gm.all('wikiPage').map((p) => p.title).sort()).toEqual(['Test', 'The Cult of the Ninth Star']));
    const cult = pageAt(table, 'Lore/The Cult.md')!;
    expect(cult.sections.map((s) => [s.id, !!s.locked])).toEqual([['_intro', false], ['gm-notes', true]]);
    expect(ann.client.all('wikiPage')).toHaveLength(0);
    expect((await table.gm.act('wiki.status')).pages).toBe(2);
  });

  it('publishes a system as a page with its data in the infobox', async () => {
    const res = await table.gm.act('wiki.publish', { ids: [ardent] });
    expect(res).toMatchObject({ written: 1 });
    const fm = parsePage(read(vault, ARDENT)).frontmatter;
    expect(fm).toMatchObject({ title: 'Ardent', type: 'system', ref: ardent, sector: 'Kestrel Reach', hex: '0103', uwp: 'A646930-D', bases: 'NS', travel_zone: 'Green', pbg: '812', subtitle: 'Kestrel Reach 0103' });
    expect(read(vault, ARDENT)).toContain('hex: "0103"');
    await eventually(() => expect(pageAt(table, ARDENT)?.entityId).toBe(ardent));
    // Publishing again does nothing.
    expect(await table.gm.act('wiki.publish', { ids: [ardent] })).toMatchObject({ written: 0, skipped: 1 });
  });

  it('brings wiki text into the app, revealed section by section, with spoilers and GM notes held back', async () => {
    const page = read(vault, ARDENT);
    write(vault, ARDENT, `${page}\nA trade hub on the Reach main. ||Its fusion plant is failing.||\n\n## History\nSettled in 900.\n\n## GM Notes\nAmbush at the highport.\n`);
    await table.gm.act('wiki.sync');
    const p = pageAt(table, ARDENT)!;
    await eventually(() => expect(pageAt(table, ARDENT)!.sections.map((s) => s.id)).toEqual(['_intro', 'history', 'gm-notes']));
    expect(ann.client.get(p.id)).toBeUndefined();

    await table.gm.act('wiki.reveal', { pageId: p.id, sectionId: '_intro', audience: 'party', on: true });
    await eventually(() => expect(ann.client.get<WikiPage>(p.id)?.sections.map((s) => s.id)).toEqual(['_intro']));
    const seen = ann.client.get<WikiPage>(p.id)!;
    expect(seen.entityId).toBe(ardent);
    expect(seen.sections[0].body).toBe('A trade hub on the Reach main. ');
    expect(JSON.stringify(seen)).not.toMatch(/failing|Ambush|Settled|Atlas\//);

    await table.gm.act('wiki.reveal', { pageId: p.id, sectionId: '_intro', audience: 'party', on: true, spoilers: true });
    await eventually(() => expect(ann.client.get<WikiPage>(p.id)!.sections[0].body).toContain('failing'));
    await expect(table.gm.act('wiki.reveal', { pageId: p.id, sectionId: 'gm-notes', audience: 'party', on: true })).rejects.toThrow(/cannot be revealed/);
    // "Reveal all" skips the locked section rather than failing.
    await table.gm.act('wiki.reveal', { pageId: p.id, all: true, audience: 'party', on: true });
    await eventually(() => expect(ann.client.get<WikiPage>(p.id)!.sections.map((s) => s.id)).toEqual(['_intro', 'history']));
  });

  it('applies infobox edits made in Chronicler to the map, keeping what was revealed', async () => {
    write(vault, ARDENT, read(vault, ARDENT).replace('uwp: A646930-D', 'uwp: B646930-C').replace('travel_zone: Green', 'travel_zone: Amber').replace('title: Ardent', 'title: Ardent Prime'));
    const summary = await table.gm.act('wiki.sync');
    expect(summary.entitiesUpdated).toBe(1);
    await eventually(() => expect(ann.client.get<StarSystem>(ardent)).toMatchObject({ name: 'Ardent Prime', uwp: 'B646930-C', zone: 'A' }));
    expect(ann.client.get<WikiPage>(pageAt(table, ARDENT)!.id)!.sections).toHaveLength(2);
    // A bad value is reported and ignored rather than breaking the system.
    write(vault, ARDENT, read(vault, ARDENT).replace('uwp: B646930-C', 'uwp: nonsense'));
    const bad = await table.gm.act('wiki.sync');
    expect(bad.warnings.join(' ')).toMatch(/not a valid world profile/);
    expect(table.gm.get<StarSystem>(ardent)!.uwp).toBe('B646930-C');
    await eventually(() => expect(pageAt(table, ARDENT)!.warnings?.[0]).toMatch(/not a valid/));
    // The app then puts the page right again.
    expect(read(vault, ARDENT)).toContain('uwp: B646930-C');
  });

  it('writes app edits to the infobox without touching the text', async () => {
    await table.gm.act('entity.patch', { id: ardent, ops: [{ op: 'set', path: ['bases'], value: 'N' }, { op: 'set', path: ['allegiance'], value: 'Kc' }] });
    const summary = await table.gm.act('wiki.sync');
    expect(summary.pagesWritten).toBe(1);
    const text = read(vault, ARDENT);
    expect(parsePage(text).frontmatter).toMatchObject({ bases: 'N', allegiance: 'Kc', title: 'Ardent Prime' });
    expect(text).toContain('## History\nSettled in 900.');
    expect(text).toContain('||Its fusion plant is failing.||');
    // Nothing more to do on the next pass.
    expect(await table.gm.act('wiki.sync')).toMatchObject({ pagesChanged: 0, pagesWritten: 0, entitiesUpdated: 0 });
  });

  it('lets the wiki win when both sides changed the same value', async () => {
    await table.gm.act('entity.patch', { id: ardent, ops: [{ op: 'set', path: ['bases'], value: 'S' }, { op: 'set', path: ['stars'], value: 'G2 V' }] });
    write(vault, ARDENT, read(vault, ARDENT).replace('bases: N', 'bases: NW'));
    await table.gm.act('wiki.sync');
    await eventually(() => expect(table.gm.get<StarSystem>(ardent)).toMatchObject({ bases: 'NW', stars: 'G2 V' }));
    expect(parsePage(read(vault, ARDENT)).frontmatter).toMatchObject({ bases: 'NW', stars: 'G2 V' });
  });

  it('creates a system from a page written in Chronicler', async () => {
    write(vault, 'Atlas/Kestrel Reach/Vesk.md', '---\ntitle: Vesk\ntype: system\nsector: Kestrel Reach\nhex: 0308\nuwp: X555423-2\ntravel_zone: Red\npbg: 13\n---\nInterdicted.\n');
    const summary = await table.gm.act('wiki.sync');
    expect(summary.entitiesCreated).toBe(1);
    await eventually(() => expect(table.gm.all('system').find((s) => s.name === 'Vesk')).toMatchObject({ hex: '0308', uwp: 'X555423-2', zone: 'R', pbg: '013' }));
    const vesk = table.gm.all('system').find((s) => s.name === 'Vesk')!;
    expect(table.gm.all('body').filter((b: Body) => b.systemId === vesk.id).length).toBeGreaterThan(1);
    // The page now carries the link, and players still cannot see the new system.
    expect(parsePage(read(vault, 'Atlas/Kestrel Reach/Vesk.md')).frontmatter).toMatchObject({ ref: vesk.id, hex: '0308' });
    expect(ann.client.get(vesk.id)).toBeUndefined();
    // A page for a sector that does not exist is reported, not guessed at.
    write(vault, 'Atlas/Nowhere.md', '---\ntitle: Nowhere\ntype: system\nsector: Missing Sector\nhex: "0101"\n---\n');
    expect((await table.gm.act('wiki.sync')).warnings.join(' ')).toMatch(/does not exist in the app/);
  });

  it('keeps links and reveals when a page is renamed or moved', async () => {
    const before = pageAt(table, ARDENT)!;
    const moved = 'Atlas/Kestrel Reach/Subsector A/Ardent Prime.md';
    fs.renameSync(path.join(vault, ARDENT), path.join(vault, moved));
    const summary = await table.gm.act('wiki.sync');
    expect(summary.pagesRemoved).toBe(0);
    await eventually(() => expect(pageAt(table, moved)).toBeDefined());
    const after = pageAt(table, moved)!;
    expect(after.id).toBe(before.id);
    expect(after.entityId).toBe(ardent);
    expect(after.sections.find((s) => s.id === 'history')!.known).toEqual(['party']);
    expect(ann.client.get<WikiPage>(after.id)!.sections).toHaveLength(2);
  });

  it('links a lore page to a map entry by hand and records the link in the page', async () => {
    const cult = pageAt(table, 'Lore/The Cult.md')!;
    const main = table.gm.all('body').find((b) => b.systemId === ardent && b.mainworld)!;
    await table.gm.act('wiki.link', { pageId: cult.id, entityId: main.id });
    await eventually(() => expect(pageAt(table, 'Lore/The Cult.md')!.entityId).toBe(main.id));
    const text = read(vault, 'Lore/The Cult.md');
    expect(parsePage(text).frontmatter).toMatchObject({ ref: main.id, title: 'The Cult of the Ninth Star', tags: ['faction'] });
    // A hand-linked lore page keeps its own infobox: no system fields are forced into it.
    expect(parsePage(text).frontmatter.uwp).toBeUndefined();
    expect(text).toContain('They meet at night.');
    await table.gm.act('wiki.link', { pageId: cult.id, entityId: null });
    await eventually(() => expect(pageAt(table, 'Lore/The Cult.md')!.entityId).toBeUndefined());
    expect(parsePage(read(vault, 'Lore/The Cult.md')).frontmatter.ref).toBeUndefined();
  });

  it('reveals pages marked players: true as they arrive', async () => {
    write(vault, 'Handouts/Starport Notice.md', '---\ntitle: Starport Notice\nplayers: true\nissued: 1105-032\n---\nAll crews must register.\n\n## GM Notes\nThe inspector is corrupt.\n');
    await table.gm.act('wiki.sync');
    await eventually(() => expect(ann.client.all('wikiPage').find((p) => p.title === 'Starport Notice')).toBeDefined());
    const seen = ann.client.all('wikiPage').find((p) => p.title === 'Starport Notice')!;
    expect(seen.sections.map((s) => s.id)).toEqual(['_intro']);
    expect(seen.frontmatter).toMatchObject({ issued: '1105-032' });
  });

  it('removes a page that was deleted from the vault but keeps the map entry', async () => {
    fs.rmSync(path.join(vault, 'Atlas/Kestrel Reach/Subsector A/Ardent Prime.md'));
    const summary = await table.gm.act('wiki.sync');
    expect(summary.pagesRemoved).toBe(1);
    expect(table.gm.get(ardent)).toBeDefined();
    await eventually(() => expect(ann.client.all('wikiPage').some((p) => p.entityId === ardent)).toBe(false));
  });

  it('publishes every imported system automatically', async () => {
    const summary = await table.gm.act('map.import', {
      sectorId,
      subsector: 'B',
      worlds: [
        { hex: '0101', name: 'Brannoch', uwp: 'C8759A9-8' },
        { hex: '0102', name: 'Brannoch', uwp: 'E200000-0' },
        { hex: '0307', name: 'St. Idris: "The Rock"', uwp: 'B544756-A' },
      ],
    });
    expect(summary.created).toBe(3);
    await eventually(() => expect(fs.existsSync(path.join(vault, 'Atlas/Kestrel Reach/Subsector B/Brannoch.md'))).toBe(true), 4000);
    // Two systems with the same name get distinct files; awkward characters are made safe.
    await eventually(() => expect(fs.readdirSync(path.join(vault, 'Atlas/Kestrel Reach/Subsector B')).sort()).toEqual(['Brannoch (0902).md', 'Brannoch.md', 'St. Idris The Rock.md']), 4000);
    // Turning auto-publish off stops it.
    await table.gm.act('entity.patch', { id: 'campaign', ops: [{ op: 'set', path: ['settings', 'wikiAutoPublish'], value: false }] });
    await table.gm.act('map.import', { sectorId, subsector: 'C', worlds: [{ hex: '0101', name: 'Quiet', uwp: 'C8759A9-8' }] });
    await new Promise((r) => setTimeout(r, 150));
    expect(fs.existsSync(path.join(vault, 'Atlas/Kestrel Reach/Subsector C'))).toBe(false);
  });
});

describe('rules packs kept in a local vault', () => {
  it('are read in place from the hidden folder, which the wiki sync ignores', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'trav-vault-'));
    const config = { ...testConfig(), wiki: { dir: vault, branch: 'main', pollSeconds: 3600, atlasFolder: 'Atlas' } };
    expect(await vaultRulepackDir(config)).toBeUndefined();
    write(vault, `${VAULT_RULEPACKS}/house/pack.json`, JSON.stringify({ id: 'house', name: 'House rules' }));
    write(vault, `${VAULT_RULEPACKS}/house/tasks.json`, JSON.stringify({ defaultTarget: 7 }));
    write(vault, 'Lore/Intro.md', '# Intro\n');
    const dir = await vaultRulepackDir(config);
    expect(dir).toBe(path.join(vault, VAULT_RULEPACKS));
    expect(new RulesService([dir!]).pack.tasks?.defaultTarget).toBe(7);
    const table = await setTable({ wiki: config.wiki });
    try {
      expect(table.running.services.rules.packNames()).toContain('House rules');
      const summary = await table.gm.act('wiki.sync');
      expect(summary.pagesRead).toBe(1);
    } finally {
      await table.close();
      fs.rmSync(vault, { recursive: true, force: true });
      fs.rmSync(config.dataDir, { recursive: true, force: true });
    }
  });
});

/** A tiny in-memory stand-in for the parts of the GitHub API the backend uses. */
function mockGitHub() {
  const files = new Map<string, string>([['Lore/Intro.md', '---\ntitle: Intro\n---\nWelcome.\n']]);
  let head = 'commit-0';
  let counter = 0;
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, string>([['commit-0', 'tree-0']]);
  const stats = { patches: 0, rejectNext: 0, lastAuth: '' as string | undefined, commits: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const url = new URL(req.url!, 'http://x');
      const p = url.pathname.replace('/repos/owner/wiki', '');
      stats.lastAuth = req.headers.authorization;
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method !== 'GET' && req.headers.authorization !== 'Bearer good-token') return send(403, { message: 'Resource not accessible' });
      if (req.method === 'GET' && p === '/git/ref/heads/main') return send(200, { object: { sha: head } });
      if (req.method === 'GET' && p.startsWith('/git/trees/')) {
        return send(200, { truncated: false, tree: [...files].map(([path, content]) => ({ path, type: 'blob', sha: gitBlobSha(content) })).concat([{ path: 'Lore', type: 'tree', sha: 'x' }]) });
      }
      if (req.method === 'GET' && p.startsWith('/git/blobs/')) {
        const sha = p.split('/').pop();
        const content = [...files.values()].find((c) => gitBlobSha(c) === sha);
        return content === undefined ? send(404, {}) : send(200, { encoding: 'base64', content: Buffer.from(content).toString('base64') });
      }
      if (req.method === 'GET' && p.startsWith('/git/commits/')) return send(200, { tree: { sha: commits.get(p.split('/').pop()!) } });
      if (req.method === 'POST' && p === '/git/trees') {
        const id = `tree-${++counter}`;
        trees.set(id, new Map(body.tree.map((e: { path: string; content: string }) => [e.path, e.content])));
        return send(201, { sha: id, tree: [] });
      }
      if (req.method === 'POST' && p === '/git/commits') {
        const id = `commit-${++counter}`;
        commits.set(id, body.tree);
        return send(201, { sha: id });
      }
      if (req.method === 'PATCH' && p === '/git/refs/heads/main') {
        stats.patches++;
        if (stats.rejectNext > 0) {
          stats.rejectNext--;
          return send(422, { message: 'Update is not a fast forward' });
        }
        for (const [path, content] of trees.get(commits.get(body.sha)!)!) files.set(path, content);
        head = body.sha;
        stats.commits++;
        return send(200, { object: { sha: head } });
      }
      send(404, { message: 'Not Found' });
    });
  });
  return { server, files, stats, edit: (path: string, content: string) => (files.set(path, content), (head = `commit-ext-${++counter}`), commits.set(head, 'tree-0')) };
}

describe('wiki sync with a GitHub repository', () => {
  const gh = mockGitHub();
  let table: Table;
  let apiBase: string;
  let ardent: string;

  beforeAll(async () => {
    await new Promise<void>((r) => gh.server.listen(0, '127.0.0.1', r));
    apiBase = `http://127.0.0.1:${(gh.server.address() as { port: number }).port}`;
    const wiki = { repo: 'owner/wiki', branch: 'main', token: 'good-token', pollSeconds: 3600, atlasFolder: 'Atlas' };
    table = await setTable({ wiki }, { wikiBackend: new GitHubBackend({ ...wiki, apiBase }) });
    const sectorId = (await table.gm.act('sector.create', { name: 'Kestrel Reach', x: 0, y: 0 })).id;
    ardent = (await table.gm.act('system.create', { sectorId, hex: '0103', name: 'Ardent', uwp: 'A646930-D' })).id;
  });
  afterAll(async () => {
    await table.close();
    await new Promise((r) => gh.server.close(r));
  });

  it('fetches rules packs kept beside the wiki, and keeps them out of the wiki itself', async () => {
    gh.files.set('.traveller-ui/rulepacks/house/pack.json', JSON.stringify({ id: 'house', name: 'House rules' }));
    gh.files.set('.traveller-ui/rulepacks/house/tasks.json', JSON.stringify({ defaultTarget: 9 }));
    gh.files.set('.traveller-ui/rulepacks/../../escape/evil.json', '{}');
    gh.files.set('.traveller-ui/rulepacks/house/deep/nested.json', '{}');
    const config = { ...testConfig(), wiki: { repo: 'owner/wiki', branch: 'main', token: 'good-token', pollSeconds: 3600, atlasFolder: 'Atlas' } };
    const dir = await vaultRulepackDir(config, new GitHubBackend({ ...config.wiki, apiBase }));
    expect(dir).toBe(path.join(config.dataDir, 'rulepacks-wiki'));
    expect(fs.readdirSync(path.join(dir!, 'house')).sort()).toEqual(['pack.json', 'tasks.json']);
    expect(fs.existsSync(path.join(config.dataDir, 'escape'))).toBe(false);
    // Layered over whatever is in the usual folder.
    const rules = new RulesService([path.join(config.dataDir, 'nothing-here'), dir!]);
    expect(rules.packNames()).toEqual(['House rules']);
    expect(rules.pack.tasks?.defaultTarget).toBe(9);
    fs.rmSync(config.dataDir, { recursive: true, force: true });
    for (const key of [...gh.files.keys()]) if (key.startsWith('.traveller-ui')) gh.files.delete(key);
  });

  it('reads pages from the repository', async () => {
    const summary = await table.gm.act('wiki.sync');
    expect(summary.pagesRead).toBe(1);
    await eventually(() => expect(table.gm.all('wikiPage').map((p) => p.title)).toEqual(['Intro']));
    expect(await table.gm.act('wiki.status')).toMatchObject({ configured: true, kind: 'github', canWrite: true, pages: 1 });
  });

  it('publishes many pages as a single commit and retries when someone else pushed first', async () => {
    const sectorId = table.gm.all('sector')[0].id;
    await table.gm.act('entity.patch', { id: 'campaign', ops: [{ op: 'set', path: ['settings', 'wikiAutoPublish'], value: false }] });
    const made = await table.gm.act('map.import', { sectorId, subsector: 'B', worlds: [{ hex: '0101', name: 'One', uwp: 'C8759A9-8' }, { hex: '0102', name: 'Two', uwp: 'E200000-0' }] });
    gh.stats.rejectNext = 1;
    const res = await table.gm.act('wiki.publish', { ids: [ardent, ...made.systemIds] });
    expect(res.written).toBe(3);
    expect(gh.stats.commits).toBe(1);
    expect(gh.stats.patches).toBe(2);
    expect(gh.stats.lastAuth).toBe('Bearer good-token');
    expect([...gh.files.keys()].sort()).toEqual(['Atlas/Kestrel Reach/Subsector A/Ardent.md', 'Atlas/Kestrel Reach/Subsector B/One.md', 'Atlas/Kestrel Reach/Subsector B/Two.md', 'Lore/Intro.md']);
    // What was just written is not mistaken for an outside edit.
    expect(await table.gm.act('wiki.sync')).toMatchObject({ pagesChanged: 0, pagesWritten: 0 });
  });

  it('picks up edits pushed to the repository and writes app edits back', async () => {
    const file = 'Atlas/Kestrel Reach/Subsector A/Ardent.md';
    gh.edit(file, gh.files.get(file)!.replace('uwp: A646930-D', 'uwp: A646930-E') + '\nNew lore from Chronicler.\n');
    await table.gm.act('wiki.sync');
    await eventually(() => expect(table.gm.get<StarSystem>(ardent)!.uwp).toBe('A646930-E'));
    expect(table.gm.all('wikiPage').find((p) => p.entityId === ardent)!.sections[0].body).toContain('New lore');
    await table.gm.act('entity.patch', { id: ardent, ops: [{ op: 'set', path: ['zone'], value: 'A' }] });
    const before = gh.stats.commits;
    expect((await table.gm.act('wiki.sync')).pagesWritten).toBe(1);
    expect(gh.stats.commits).toBe(before + 1);
    expect(gh.files.get(file)).toContain('travel_zone: Amber');
    expect(gh.files.get(file)).toContain('New lore from Chronicler.');
  });

  it('explains clearly when the token cannot write', async () => {
    const wiki = { repo: 'owner/wiki', branch: 'main', token: 'bad-token', pollSeconds: 3600, atlasFolder: 'Atlas' };
    const readOnly = await setTable({ wiki }, { wikiBackend: new GitHubBackend({ ...wiki, apiBase }) });
    const sectorId = (await readOnly.gm.act('sector.create', { name: 'Elsewhere', x: 0, y: 0 })).id;
    const id = (await readOnly.gm.act('system.create', { sectorId, hex: '0101', name: 'Nope', uwp: 'A000000-0' })).id;
    await expect(readOnly.gm.act('wiki.publish', { ids: [id] })).rejects.toThrow(/403.*Contents: read and write/);
    expect((await readOnly.gm.act('wiki.status')).lastError).toMatch(/403/);
    await readOnly.close();
  });
});
