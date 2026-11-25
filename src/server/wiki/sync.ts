/**
 * Two-way sync between the campaign and the Chronicler wiki.
 *
 * Wiki → app: every page becomes a `wikiPage` entity whose sections the GM can reveal to players.
 * Pages that carry a `ref` (or describe a system with `type: system`) are attached to that map
 * entry, and edits to their infobox flow back into the app.
 *
 * App → wiki: systems created or imported in the app are written out as pages, and later changes
 * to their data update the infobox while leaving the author's text and other infobox keys alone.
 *
 * When both sides changed the same value since the last sync, the wiki wins: an edit typed into
 * Chronicler is always a deliberate act by the GM.
 */
import { SUBSECTOR_LETTERS, parseHex, subsectorOf } from '../../shared/hex';
import { buildPage, pageTags, pageTitle, parsePage, safeFileName, updateFrontmatter, type PageSection } from '../../shared/markdown';
import { systemTradeCodes } from '../../shared/rules/world';
import { PARTY, type Body, type Campaign, type Entity, type Id, type Sector, type StarSystem, type WikiPage, type WikiSection } from '../../shared/types';
import { isValidUwp } from '../../shared/uwp';
import type { WikiConfig } from '../config';
import type { RulesService } from '../rules';
import type { State, Tx } from '../state';
import { buildSurveyBodies } from '../actions/map';
import { contentHash, GitHubBackend, LocalBackend, type WikiBackend, type WikiFile, type WikiWrite } from './backend';

export interface WikiStatus {
  configured: boolean;
  kind?: 'local' | 'github';
  label?: string;
  canWrite: boolean;
  pages: number;
  linked: number;
  syncing: boolean;
  lastSync?: number;
  lastError?: string;
  lastSummary?: SyncSummary;
}

export interface SyncSummary {
  pagesRead: number;
  pagesChanged: number;
  pagesRemoved: number;
  entitiesUpdated: number;
  entitiesCreated: number;
  pagesWritten: number;
  warnings: string[];
}

const ZONE_NAME: Record<string, string> = { '': 'Green', A: 'Amber', R: 'Red' };
const BODY_TYPE: Record<Body['kind'], string> = { star: 'star', planet: 'world', gasGiant: 'gas giant', belt: 'belt', moon: 'moon', station: 'station', poi: 'site' };

/** Infobox keys the app keeps in step with an entity. `twoWay` keys also flow from the wiki back to the app. */
interface FieldMap {
  values: Record<string, string>;
  twoWay: string[];
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(String).join(' ');
  return String(value).trim();
}

export class WikiService {
  readonly backend?: WikiBackend;
  private queue: Promise<unknown> = Promise.resolve();
  private stopWatching?: () => void;
  private lastRevision: string | null = null;
  private syncing = false;
  private lastSync?: number;
  private lastError?: string;
  private lastSummary?: SyncSummary;
  onStatus?: (status: WikiStatus) => void;

  constructor(
    private state: State,
    private config: WikiConfig,
    private rules: RulesService,
    backend?: WikiBackend,
  ) {
    if (backend) this.backend = backend;
    else if (config.dir) this.backend = new LocalBackend(config.dir);
    else if (config.repo) this.backend = new GitHubBackend({ repo: config.repo, branch: config.branch, token: config.token, pollSeconds: config.pollSeconds });
  }

  status(): WikiStatus {
    const pages = this.state.all('wikiPage');
    return {
      configured: !!this.backend,
      kind: this.backend?.kind,
      label: this.backend?.label,
      canWrite: !!this.backend && (this.backend.kind === 'local' || !!this.config.token),
      pages: pages.length,
      linked: pages.filter((p) => p.entityId).length,
      syncing: this.syncing,
      lastSync: this.lastSync,
      lastError: this.lastError,
      lastSummary: this.lastSummary,
    };
  }

  /** First sync, then keep watching the vault for changes. */
  start(): void {
    if (!this.backend) return;
    void this.sync().catch(() => undefined);
    this.stopWatching = this.backend.watch(() => void this.sync({ quiet: true }).catch(() => undefined));
  }

  stop(): void {
    this.stopWatching?.();
  }

  /** Runs jobs one at a time so a sync never overlaps a publish. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private announce(): void {
    this.onStatus?.(this.status());
  }

  // ───────────────────────────── sync ─────────────────────────────

  sync(opts: { quiet?: boolean; force?: boolean } = {}): Promise<SyncSummary> {
    return this.enqueue(async () => {
      const backend = this.backend;
      if (!backend) throw new Error('No wiki is configured. Set WIKI_DIR or WIKI_REPO on the server.');
      this.syncing = true;
      if (!opts.quiet) this.announce();
      try {
        const summary = await this.runSync(backend, !!opts.force);
        this.lastSync = Date.now();
        this.lastError = undefined;
        if (summary.pagesChanged || summary.pagesRemoved || summary.pagesWritten || !opts.quiet) this.lastSummary = summary;
        return summary;
      } catch (err) {
        this.lastError = (err as Error).message;
        console.error('[wiki] sync failed:', this.lastError);
        throw err;
      } finally {
        this.syncing = false;
        this.announce();
      }
    });
  }

  private async runSync(backend: WikiBackend, force: boolean): Promise<SyncSummary> {
    const summary: SyncSummary = { pagesRead: 0, pagesChanged: 0, pagesRemoved: 0, entitiesUpdated: 0, entitiesCreated: 0, pagesWritten: 0, warnings: [] };

    // ── pull ──
    const revision = await backend.revision();
    const skipPull = !force && revision !== null && revision === this.lastRevision;
    if (!skipPull) {
      const files = await backend.list();
      summary.pagesRead = files.length;
      const known = new Map(this.state.all('wikiPage').map((p) => [p.path, p]));
      const changed: { file: WikiFile; content: string }[] = [];
      const shaOnly: { page: WikiPage; sha: string }[] = [];
      for (const file of files) {
        const page = known.get(file.path);
        if (page && page.sha === file.sha) continue;
        const content = await backend.read(file);
        if (page && page.hash === contentHash(content)) shaOnly.push({ page, sha: file.sha });
        else changed.push({ file, content });
      }
      const present = new Set(files.map((f) => f.path));
      const gone = [...known.values()].filter((p) => !present.has(p.path));

      this.state.transact((tx) => {
        for (const { page, sha } of shaOnly) tx.update<WikiPage>(page.id, (p) => void (p.sha = sha));
        for (const { file, content } of changed) {
          this.ingest(tx, file, content, known.get(file.path), gone, summary);
          summary.pagesChanged++;
        }
        // Pages that disappeared and were not matched to a renamed file.
        for (const page of gone) {
          if (!tx.get(page.id) || present.has(tx.get<WikiPage>(page.id)!.path)) continue;
          tx.delete(page.id);
          summary.pagesRemoved++;
        }
      });
      this.lastRevision = revision;
    }

    // ── push ──
    const writes = this.pendingWrites(summary);
    if (writes.length) {
      if (backend.kind === 'github' && !this.config.token) {
        summary.warnings.push(`${writes.length} page(s) have changes to write, but no WIKI_TOKEN is set so the wiki is read-only.`);
      } else {
        await this.flush(backend, writes, `Traveller UI: update ${writes.length} page${writes.length === 1 ? '' : 's'}`);
        summary.pagesWritten += writes.length;
      }
    }
    return summary;
  }

  /** Reads one changed file into its wikiPage entity and applies infobox edits to the linked entity. */
  private ingest(tx: Tx, file: WikiFile, content: string, existing: WikiPage | undefined, gone: WikiPage[], summary: SyncSummary): void {
    const parsed = parsePage(content);
    const fm = parsed.frontmatter;
    const warnings: string[] = [];
    if (!parsed.frontmatterOk) warnings.push('The infobox (frontmatter) is not valid YAML, so it was ignored.');
    const ref = typeof fm.ref === 'string' ? fm.ref : undefined;

    // A page that moved or was renamed keeps its reveal state and link: match by ref, then by content.
    let previous = existing;
    if (!previous) {
      const hash = contentHash(content);
      const match = gone.find((p) => tx.get(p.id) && ((ref && p.frontmatter.ref === ref) || p.hash === hash));
      if (match) previous = match;
    }

    const playersDefault = fm.players === true || /^(yes|true|all|players)$/i.test(text(fm.players));
    const oldSections = new Map((previous?.sections ?? []).map((s) => [s.id, s]));
    const sections: WikiSection[] = parsed.sections.map((s: PageSection) => {
      const old = oldSections.get(s.id);
      return {
        id: s.id,
        heading: s.heading,
        level: s.level,
        body: s.body,
        known: s.locked ? [] : (old?.known ?? (playersDefault ? [PARTY] : [])),
        spoilersKnown: s.locked ? undefined : old?.spoilersKnown,
        locked: s.locked || undefined,
      };
    });

    // Resolve what the page documents.
    let entityId = previous?.entityId && tx.get(previous.entityId) ? previous.entityId : undefined;
    if (ref && tx.get(ref)) entityId = ref;

    const data = {
      path: file.path,
      title: pageTitle(file.path, fm),
      frontmatter: fm,
      tags: pageTags(fm),
      sections,
      entityId,
      hash: contentHash(content),
      sha: file.sha,
      synced: previous?.synced,
      warnings: undefined as string[] | undefined,
      known: previous?.known ?? (playersDefault ? { infobox: [PARTY] } : undefined),
    };

    let page: WikiPage;
    if (previous && tx.get(previous.id)) {
      page = tx.update<WikiPage>(previous.id, (p) => {
        Object.assign(p, data);
        if (!data.entityId) delete p.entityId;
        if (!data.known) delete p.known;
      });
    } else {
      page = tx.create('wikiPage', data);
    }

    // A page that describes a new system creates it on the map.
    if (!entityId && text(fm.type).toLowerCase() === 'system') {
      const created = this.createSystemFromPage(tx, fm, warnings);
      if (created) {
        entityId = created.id;
        page = tx.update<WikiPage>(page.id, (p) => void (p.entityId = created.id));
        summary.entitiesCreated++;
      }
    }

    // Infobox edits flow back to the entity.
    if (entityId) {
      const entity = tx.get(entityId)!;
      if (this.applyPageToEntity(tx, entity, page, warnings)) summary.entitiesUpdated++;
    }

    if (warnings.length) {
      tx.update<WikiPage>(page.id, (p) => void (p.warnings = warnings));
      for (const w of warnings) summary.warnings.push(`${file.path}: ${w}`);
    }
  }

  private createSystemFromPage(tx: Tx, fm: Record<string, unknown>, warnings: string[]): StarSystem | undefined {
    const sectorName = text(fm.sector).toLowerCase();
    const sector = tx.all('sector').find((s) => s.name.toLowerCase() === sectorName || (s.abbr ?? '').toLowerCase() === sectorName);
    const hex = text(fm.hex).padStart(4, '0');
    if (!sector) {
      warnings.push(`This page describes a system in sector "${text(fm.sector)}", which does not exist in the app. Create the sector first.`);
      return undefined;
    }
    if (!parseHex(hex)) {
      warnings.push(`"${text(fm.hex)}" is not a valid hex number, so no system was created.`);
      return undefined;
    }
    if (tx.where('system', 'sectorId', sector.id).some((s) => s.hex === hex)) {
      warnings.push(`Hex ${hex} of ${sector.name} already has a system. Link this page to it in the app instead.`);
      return undefined;
    }
    const uwp = text(fm.uwp).toUpperCase();
    const system = tx.create('system', {
      sectorId: sector.id,
      hex,
      name: text(fm.title) || undefined,
      uwp: isValidUwp(uwp) ? uwp : undefined,
      bases: text(fm.bases).toUpperCase() || undefined,
      pbg: text(fm.pbg) ? text(fm.pbg).padStart(3, '0').toUpperCase() : undefined,
      zone: zoneCode(text(fm.travel_zone)),
      allegiance: text(fm.allegiance) || undefined,
      stars: text(fm.stars) || undefined,
    });
    buildSurveyBodies(tx, system);
    return system;
  }

  /** Infobox values the app manages for an entity, as strings. Undefined when the type has none. */
  private fieldsFor(entity: Entity): FieldMap | undefined {
    if (entity.type === 'system') {
      const sys = entity as StarSystem;
      const sector = this.state.get<Sector>(sys.sectorId);
      const h = parseHex(sys.hex);
      const letter = h ? subsectorOf(h.col, h.row) : '';
      const subName = sector?.subsectors[letter];
      return {
        values: {
          title: sys.name ?? `Hex ${sys.hex}`,
          subtitle: `${sector?.name ?? 'Unknown sector'} ${sys.hex}`,
          type: 'system',
          ref: sys.id,
          sector: sector?.name ?? '',
          subsector: subName ? `${subName} (${letter})` : letter,
          hex: sys.hex,
          uwp: sys.uwp ?? '',
          trade_codes: systemTradeCodes(sys.uwp, sys.remarks, this.rules.pack.world).join(' '),
          bases: sys.bases ?? '',
          travel_zone: ZONE_NAME[sys.zone ?? ''] ?? 'Green',
          pbg: sys.pbg ?? '',
          allegiance: sys.allegiance ?? '',
          stars: sys.stars ?? '',
        },
        twoWay: ['title', 'hex', 'uwp', 'bases', 'travel_zone', 'pbg', 'allegiance', 'stars'],
      };
    }
    if (entity.type === 'body') {
      const body = entity as Body;
      const system = this.state.get<StarSystem>(body.systemId);
      return {
        values: {
          title: body.name ?? BODY_TYPE[body.kind],
          subtitle: system?.name ? `${system.name} system` : '',
          type: BODY_TYPE[body.kind],
          ref: body.id,
          system: system?.name ?? '',
          uwp: (body.mainworld ? system?.uwp : body.uwp) ?? '',
          category: body.subtype ?? '',
          summary: body.summary ?? '',
        },
        twoWay: body.mainworld ? ['title', 'category', 'summary'] : ['title', 'uwp', 'category', 'summary'],
      };
    }
    return undefined;
  }

  /**
   * Three-way merge of the infobox against the entity. Returns true when the entity changed.
   * Values the page changed since the last sync are applied to the entity.
   */
  private applyPageToEntity(tx: Tx, entity: Entity, page: WikiPage, warnings: string[]): boolean {
    const map = this.fieldsFor(entity);
    // Structured sync only applies to pages typed for this kind of entity (a lore page that was
    // linked by hand keeps its own infobox).
    if (!map || text(page.frontmatter.type).toLowerCase() !== map.values.type) return false;
    const synced = page.synced;
    const edits: Record<string, string> = {};
    for (const key of map.twoWay) {
      const pageValue = normalise(key, page.frontmatter[key]);
      const entityValue = map.values[key];
      // First sight of the page counts as a wiki edit only if it disagrees and the app has no value.
      const base = synced ? (synced[key] ?? '') : entityValue === '' ? '' : pageValue;
      if (pageValue !== base && pageValue !== entityValue) edits[key] = pageValue;
    }
    if (Object.keys(edits).length === 0) return false;

    let changed = false;
    if (entity.type === 'system') {
      const sys = entity as StarSystem;
      tx.update<StarSystem>(sys.id, (s) => {
        for (const [key, value] of Object.entries(edits)) {
          switch (key) {
            case 'title':
              if (value && !/^Hex \d{4}$/.test(value)) s.name = value.slice(0, 60);
              else delete s.name;
              changed = true;
              break;
            case 'uwp':
              if (value === '') delete s.uwp;
              else if (isValidUwp(value.toUpperCase())) s.uwp = value.toUpperCase();
              else {
                warnings.push(`"${value}" is not a valid world profile; kept ${s.uwp ?? 'the old value'}.`);
                break;
              }
              changed = true;
              break;
            case 'hex': {
              const hex = value.padStart(4, '0');
              if (!parseHex(hex)) warnings.push(`"${value}" is not a valid hex number; the system stays in ${s.hex}.`);
              else if (tx.where('system', 'sectorId', s.sectorId).some((o) => o.hex === hex && o.id !== s.id)) warnings.push(`Hex ${hex} is already occupied; the system stays in ${s.hex}.`);
              else {
                s.hex = hex;
                changed = true;
              }
              break;
            }
            case 'bases':
              setOrDelete(s, 'bases', value.toUpperCase().slice(0, 8));
              changed = true;
              break;
            case 'travel_zone':
              s.zone = zoneCode(value);
              changed = true;
              break;
            case 'pbg':
              setOrDelete(s, 'pbg', value ? value.padStart(3, '0').toUpperCase().slice(0, 3) : '');
              changed = true;
              break;
            case 'allegiance':
              setOrDelete(s, 'allegiance', value.slice(0, 8));
              changed = true;
              break;
            case 'stars':
              setOrDelete(s, 'stars', value.slice(0, 60));
              changed = true;
              break;
            default:
              break;
          }
        }
      });
    } else if (entity.type === 'body') {
      tx.update<Body>(entity.id, (b) => {
        for (const [key, value] of Object.entries(edits)) {
          if (key === 'title') setOrDelete(b, 'name', value.slice(0, 80));
          else if (key === 'category') setOrDelete(b, 'subtype', value.slice(0, 60));
          else if (key === 'summary') setOrDelete(b, 'summary', value.slice(0, 600));
          else if (key === 'uwp') {
            if (value === '' || isValidUwp(value.toUpperCase())) setOrDelete(b, 'uwp', value.toUpperCase());
            else {
              warnings.push(`"${value}" is not a valid world profile.`);
              continue;
            }
          }
          changed = true;
        }
      });
    }
    return changed;
  }

  /** Pages whose infobox is behind the entity they document. Also refreshes each page's sync baseline. */
  private pendingWrites(summary: SyncSummary): { page: WikiPage; set: Record<string, string>; remove: string[] }[] {
    const out: { page: WikiPage; set: Record<string, string>; remove: string[] }[] = [];
    const baselines: { id: Id; synced: Record<string, string> }[] = [];
    for (const page of this.state.all('wikiPage')) {
      if (!page.entityId) continue;
      const entity = this.state.get(page.entityId);
      if (!entity) continue;
      const map = this.fieldsFor(entity);
      const typed = map && text(page.frontmatter.type).toLowerCase() === map.values.type;
      if (!map || !typed) {
        // A hand-linked lore page: only make sure it carries the ref so the link survives renames.
        if (text(page.frontmatter.ref) !== entity.id) out.push({ page, set: { ref: entity.id }, remove: [] });
        continue;
      }
      const set: Record<string, string> = {};
      const remove: string[] = [];
      for (const [key, value] of Object.entries(map.values)) {
        // Compare the text as written, so loosely typed values (hex: 308, uwp in lower case) are
        // tidied into the canonical form as well.
        const current = text(page.frontmatter[key]);
        if (current === value) continue;
        if (value === '') {
          if (key in page.frontmatter) remove.push(key);
        } else set[key] = value;
      }
      if (Object.keys(set).length || remove.length) out.push({ page, set, remove });
      else if (JSON.stringify(page.synced ?? null) !== JSON.stringify(map.values)) baselines.push({ id: page.id, synced: map.values });
    }
    if (baselines.length) {
      this.state.transact((tx) => {
        for (const b of baselines) tx.update<WikiPage>(b.id, (p) => void (p.synced = b.synced));
      });
    }
    void summary;
    return out;
  }

  /** Rewrites the infobox of each page and records the result so the write is not read back as an edit. */
  private async flush(backend: WikiBackend, writes: { page: WikiPage; set: Record<string, string>; remove: string[] }[], message: string): Promise<void> {
    const files: WikiWrite[] = [];
    const contents = new Map<string, string>();
    for (const w of writes) {
      const current = await backend.read({ path: w.page.path, sha: w.page.sha ?? '' }).catch(() => undefined);
      if (current === undefined) continue;
      const next = updateFrontmatter(current, w.set, w.remove);
      if (next === current) continue;
      files.push({ path: w.page.path, content: next });
      contents.set(w.page.path, next);
    }
    if (files.length === 0) return;
    const written = await backend.write(files, message);
    this.lastRevision = await backend.revision();
    this.state.transact((tx) => {
      for (const file of written) this.recordWritten(tx, file, contents.get(file.path)!);
    });
  }

  /** Updates (or creates) the wikiPage entity for content the app has just written. */
  private recordWritten(tx: Tx, file: WikiFile, content: string, entityId?: Id): void {
    const parsed = parsePage(content);
    const existing = tx.where('wikiPage', 'path', file.path)[0];
    const link = entityId ?? existing?.entityId;
    const entity = link ? tx.get(link) : undefined;
    const map = entity ? this.fieldsFor(entity) : undefined;
    const oldSections = new Map((existing?.sections ?? []).map((s) => [s.id, s]));
    const data = {
      path: file.path,
      title: pageTitle(file.path, parsed.frontmatter),
      frontmatter: parsed.frontmatter,
      tags: pageTags(parsed.frontmatter),
      sections: parsed.sections.map((s) => ({ id: s.id, heading: s.heading, level: s.level, body: s.body, known: s.locked ? [] : (oldSections.get(s.id)?.known ?? []), spoilersKnown: oldSections.get(s.id)?.spoilersKnown, locked: s.locked || undefined })),
      entityId: entity?.id,
      hash: contentHash(content),
      sha: file.sha,
      synced: map && text(parsed.frontmatter.type).toLowerCase() === map.values.type ? map.values : existing?.synced,
    };
    if (existing) tx.update<WikiPage>(existing.id, (p) => void Object.assign(p, data));
    else tx.create('wikiPage', data);
  }

  // ───────────────────────────── publish ─────────────────────────────

  /** Folder and file name for a new page about an entity. */
  private pathFor(entity: Entity, taken: Set<string>): string | undefined {
    const atlas = safeFileName(this.config.atlasFolder);
    let folder: string;
    let name: string;
    let suffix: string;
    if (entity.type === 'system') {
      const sys = entity as StarSystem;
      const sector = this.state.get<Sector>(sys.sectorId);
      const h = parseHex(sys.hex);
      const letter = h ? subsectorOf(h.col, h.row) : SUBSECTOR_LETTERS[0];
      const subName = sector?.subsectors[letter];
      folder = `${atlas}/${safeFileName(sector?.name ?? 'Unknown sector')}/${safeFileName(subName ? `${letter} - ${subName}` : `Subsector ${letter}`)}`;
      name = safeFileName(sys.name ?? `Hex ${sys.hex}`);
      suffix = sys.hex;
    } else if (entity.type === 'body') {
      const body = entity as Body;
      const system = this.state.get<StarSystem>(body.systemId);
      if (!system) return undefined;
      const systemPage = this.state.where('wikiPage', 'entityId', system.id)[0];
      const base = systemPage ? systemPage.path.replace(/\.md$/i, '') : this.pathFor(system, new Set())?.replace(/\.md$/i, '');
      if (!base) return undefined;
      folder = base;
      name = safeFileName(body.name ?? BODY_TYPE[body.kind]);
      suffix = body.id.slice(-4);
    } else return undefined;
    let path = `${folder}/${name}.md`;
    if (taken.has(path.toLowerCase())) path = `${folder}/${name} (${suffix}).md`;
    return path;
  }

  /** Writes wiki pages for entities that do not have one yet. */
  publishEntities(ids: Id[]): Promise<{ written: number; skipped: number }> {
    return this.enqueue(async () => {
      const backend = this.backend;
      if (!backend) return { written: 0, skipped: ids.length };
      if (backend.kind === 'github' && !this.config.token) throw new Error('Writing to the wiki needs an access token. Set WIKI_TOKEN on the server.');
      const taken = new Set(this.state.all('wikiPage').map((p) => p.path.toLowerCase()));
      const files: WikiWrite[] = [];
      const owner = new Map<string, Id>();
      let skipped = 0;
      for (const id of ids) {
        const entity = this.state.get(id);
        const map = entity ? this.fieldsFor(entity) : undefined;
        if (!entity || !map || this.state.where('wikiPage', 'entityId', id).length) {
          skipped++;
          continue;
        }
        const path = this.pathFor(entity, taken);
        if (!path) {
          skipped++;
          continue;
        }
        taken.add(path.toLowerCase());
        const frontmatter: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(map.values)) if (value !== '') frontmatter[key] = value;
        frontmatter.tags = entity.type === 'system' ? ['system', map.values.sector.toLowerCase().replace(/\s+/g, '-')].filter(Boolean) : [map.values.type.replace(/\s+/g, '-')];
        files.push({ path, content: buildPage(frontmatter) });
        owner.set(path, id);
      }
      if (files.length === 0) return { written: 0, skipped };
      this.syncing = true;
      this.announce();
      try {
        const contents = new Map(files.map((f) => [f.path, f.content]));
        const written = await backend.write(files, `Traveller UI: add ${files.length} page${files.length === 1 ? '' : 's'}`);
        this.lastRevision = await backend.revision();
        this.state.transact((tx) => {
          for (const file of written) this.recordWritten(tx, file, contents.get(file.path)!, owner.get(file.path));
        });
        this.lastSync = Date.now();
        this.lastError = undefined;
        return { written: written.length, skipped };
      } catch (err) {
        this.lastError = (err as Error).message;
        throw err;
      } finally {
        this.syncing = false;
        this.announce();
      }
    });
  }

  /** Attaches a page to an entity (or detaches it) and records the link in the page itself. */
  linkPage(pageId: Id, entityId: Id | undefined): Promise<void> {
    return this.enqueue(async () => {
      const page = this.state.get<WikiPage>(pageId);
      if (!page || page.type !== 'wikiPage') throw new Error('That wiki page no longer exists');
      if (entityId && !this.state.get(entityId)) throw new Error('That entry no longer exists');
      this.state.transact((tx) => {
        tx.update<WikiPage>(pageId, (p) => {
          if (entityId) p.entityId = entityId;
          else delete p.entityId;
          delete p.synced;
        });
      });
      const backend = this.backend;
      if (!backend || (backend.kind === 'github' && !this.config.token)) return;
      const fresh = this.state.get<WikiPage>(pageId)!;
      if (entityId) await this.flush(backend, [{ page: fresh, set: { ref: entityId }, remove: [] }], `Traveller UI: link ${fresh.title}`);
      else if ('ref' in fresh.frontmatter) await this.flush(backend, [{ page: fresh, set: {}, remove: ['ref'] }], `Traveller UI: unlink ${fresh.title}`);
    });
  }

  /** Whether new systems should be published automatically. */
  autoPublish(): boolean {
    return !!this.backend && (this.state.get<Campaign>('campaign')?.settings.wikiAutoPublish ?? false);
  }
}

function zoneCode(value: string): '' | 'A' | 'R' {
  const v = value.trim().toLowerCase();
  if (v === 'a' || v === 'amber') return 'A';
  if (v === 'r' || v === 'red') return 'R';
  return '';
}

/** Brings an infobox value into the same form the app would write, so comparisons are fair. */
function normalise(key: string, value: unknown): string {
  const t = text(value);
  if (t === '') return '';
  if (key === 'hex') return t.padStart(4, '0');
  if (key === 'pbg') return t.padStart(3, '0').toUpperCase();
  if (key === 'uwp' || key === 'bases') return t.toUpperCase();
  if (key === 'travel_zone') return ZONE_NAME[zoneCode(t)];
  return t;
}

function setOrDelete<T extends object>(target: T, key: keyof T & string, value: string): void {
  if (value === '') delete target[key];
  else (target as Record<string, unknown>)[key] = value;
}
