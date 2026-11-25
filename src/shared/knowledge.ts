/**
 * Knowledge gating: the single place that decides what a viewer may see.
 *
 * The GM sees every entity in full. A player sees a redacted copy built from the facets and
 * notes that have been revealed to the party or to that player. Redaction runs on the server
 * before anything is sent, so hidden data never reaches a player's device.
 */
import {
  PARTY,
  type Audience,
  type Body,
  type Character,
  type Entity,
  type EntityType,
  type Id,
  type Known,
  type Note,
  type Objective,
  type Roll,
  type RouteLine,
  type WikiPage,
  type WikiSection,
} from './types';

export interface Viewer {
  role: 'gm' | 'player';
  playerId: Id;
}

/** Pseudo player id used when the GM previews "what the party knows" with no personal knowledge. */
export const PARTY_VIEWER_ID = '__party__';

export function isGm(v: Viewer): boolean {
  return v.role === 'gm';
}

export function audienceMatches(audiences: Audience[] | undefined, v: Viewer): boolean {
  if (v.role === 'gm') return true;
  if (!audiences || audiences.length === 0) return false;
  return audiences.includes(PARTY) || audiences.includes(v.playerId);
}

export function knows(entity: { known?: Known }, facet: string, v: Viewer): boolean {
  if (v.role === 'gm') return true;
  return audienceMatches(entity.known?.[facet], v);
}

export interface FacetSpec {
  key: string;
  label: string;
  hint: string;
  /** Entity fields that become visible with this facet. */
  fields: string[];
}

/**
 * Facets per entity type. `exists` is always the base facet: without it the entity is invisible.
 * Fields not listed under any facet are GM-only.
 */
export const FACETS: Partial<Record<EntityType, FacetSpec[]>> = {
  sector: [
    { key: 'exists', label: 'Charted', hint: 'The sector and its subsector names appear on the map.', fields: ['name', 'abbr', 'x', 'y', 'subsectors'] },
  ],
  system: [
    { key: 'exists', label: 'Detected', hint: 'A system is known to be in this hex.', fields: ['sectorId', 'hex'] },
    { key: 'name', label: 'Name', hint: 'The system name is shown.', fields: ['name'] },
    {
      key: 'survey',
      label: 'Survey data',
      hint: 'World profile, starport, bases, travel zone, gas giants and stars.',
      fields: ['uwp', 'bases', 'remarks', 'zone', 'pbg', 'allegiance', 'stars', 'ext'],
    },
  ],
  body: [
    { key: 'exists', label: 'Detected', hint: 'The body appears in the system view.', fields: ['systemId', 'parentId', 'kind', 'orbit', 'mainworld'] },
    { key: 'name', label: 'Name', hint: 'The name is shown.', fields: ['name'] },
    { key: 'survey', label: 'Details', hint: 'Profile, classification and summary.', fields: ['uwp', 'subtype', 'summary'] },
  ],
  route: [{ key: 'exists', label: 'Known', hint: 'The route is drawn on the map.', fields: ['a', 'b', 'kind', 'label'] }],
  region: [{ key: 'exists', label: 'Known', hint: 'The region is drawn on the map.', fields: ['name', 'color', 'hexes'] }],
  // Non-player characters and creatures. Player characters are always visible to the whole party.
  character: [
    { key: 'exists', label: 'Seen', hint: 'Players know this character or creature exists.', fields: ['kind', 'portrait', 'ownerId'] },
    { key: 'name', label: 'Name', hint: 'Name, role and species.', fields: ['name', 'title', 'species'] },
    {
      key: 'details',
      label: 'Stats',
      hint: 'Characteristics, skills, weapons, armour and background.',
      fields: ['age', 'homeworld', 'careers', 'chars', 'skills', 'weapons', 'armour', 'traits', 'bio', 'conditions', 'movement'],
    },
  ],
  asset: [{ key: 'exists', label: 'Shared', hint: 'The file can be opened by players.', fields: ['name', 'mime', 'size', 'url', 'uploadedBy'] }],
};

/** One-click knowledge levels for systems and bodies. */
export const PRESETS: Record<string, { label: string; facets: string[] }> = {
  hidden: { label: 'Hidden', facets: [] },
  detected: { label: 'Detected', facets: ['exists'] },
  charted: { label: 'Charted', facets: ['exists', 'name', 'survey'] },
};

/** The preset matching the facets an audience currently knows, or 'custom'. */
export function presetFor(known: Known | undefined, audience: Audience): string {
  const have = Object.keys(known ?? {}).filter((f) => known![f]?.includes(audience)).sort();
  for (const [key, preset] of Object.entries(PRESETS)) {
    const want = [...preset.facets].sort();
    if (want.length === have.length && want.every((f, i) => f === have[i])) return key;
  }
  return 'custom';
}

const ALWAYS = ['id', 'type', 'rev', 'createdAt', 'updatedAt'] as const;

type Lookup = (id: Id) => Entity | undefined;

/** Removes ||spoiler|| spans (Chronicler syntax) from markdown. */
export function stripSpoilers(markdown: string): string {
  return markdown.replace(/\|\|[\s\S]*?\|\|/g, '').replace(/[ \t]+\n/g, '\n');
}

function visibleNotes(notes: Note[] | undefined, v: Viewer): Note[] | undefined {
  if (!notes) return undefined;
  const out = notes.filter((n) => audienceMatches(n.known, v)).map((n) => ({ id: n.id, title: n.title, body: n.body, known: [] as Audience[] }));
  return out.length ? out : undefined;
}

function facetView(entity: Entity, v: Viewer): Record<string, unknown> | null {
  const specs = FACETS[entity.type];
  if (!specs) return null;
  if (!knows(entity, 'exists', v)) return null;
  const src = entity as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ALWAYS) out[key] = src[key];
  for (const spec of specs) {
    if (!knows(entity, spec.key, v)) continue;
    for (const field of spec.fields) if (src[field] !== undefined) out[field] = src[field];
  }
  const notes = visibleNotes(entity.notes, v);
  if (notes) out.notes = notes;
  return out;
}

function wikiPageView(page: WikiPage, v: Viewer): Record<string, unknown> | null {
  const sections: WikiSection[] = [];
  for (const s of page.sections) {
    if (s.locked || !audienceMatches(s.known, v)) continue;
    const spoilers = audienceMatches(s.spoilersKnown, v);
    sections.push({ id: s.id, heading: s.heading, level: s.level, body: spoilers ? s.body : stripSpoilers(s.body), known: [] });
  }
  if (sections.length === 0) return null;
  const out: Record<string, unknown> = {
    id: page.id,
    type: page.type,
    rev: page.rev,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    title: page.title,
    sections,
    entityId: page.entityId,
    tags: [],
    frontmatter: {},
    path: '',
    hash: '',
  };
  if (knows(page, 'infobox', v)) {
    out.frontmatter = page.frontmatter;
    out.tags = page.tags;
  }
  return out;
}

/**
 * Returns the copy of `entity` that `v` is allowed to see, or null if it is invisible to them.
 * `get` resolves other entities for rules that depend on them (a body needs its system, etc.).
 */
export function redact(entity: Entity, v: Viewer, get: Lookup): Entity | null {
  if (v.role === 'gm') return entity;

  switch (entity.type) {
    case 'campaign': {
      const { gm: _gm, known: _known, ...rest } = entity;
      return { ...rest, notes: visibleNotes(entity.notes, v) } as Entity;
    }
    case 'player': {
      const { gm: _gm, known: _known, notes: _notes, ...rest } = entity;
      return rest as Entity;
    }
    case 'body': {
      const system = get((entity as Body).systemId);
      if (!system || !knows(system, 'exists', v)) return null;
      return facetView(entity, v) as Entity | null;
    }
    case 'route': {
      const r = entity as RouteLine;
      const a = get(r.a);
      const b = get(r.b);
      if (!a || !b || !knows(a, 'exists', v) || !knows(b, 'exists', v)) return null;
      return facetView(entity, v) as Entity | null;
    }
    case 'objective': {
      const o = entity as Objective;
      if (o.scope !== PARTY && o.scope !== v.playerId && o.createdBy !== v.playerId) return null;
      const { gm: _gm, known: _known, ...rest } = o;
      return { ...rest, notes: visibleNotes(o.notes, v) } as Entity;
    }
    case 'wikiPage':
      return wikiPageView(entity as WikiPage, v) as Entity | null;
    case 'character': {
      const c = entity as Character;
      if (c.kind !== 'pc') return facetView(entity, v) as Entity | null;
      // Party members know each other; only private notes stay with the owner.
      const { gm: _gm, known: _known, secrets, ...rest } = c;
      return { ...rest, ...(c.ownerId === v.playerId && secrets !== undefined ? { secrets } : {}), notes: visibleNotes(c.notes, v) } as Entity;
    }
    case 'roll': {
      const r = entity as Roll;
      if (r.playerId !== v.playerId && !audienceMatches(r.to, v)) return null;
      const { gm: _gm, known: _known, ...rest } = r;
      return rest as Entity;
    }
    case 'asset': {
      if ((entity as { uploadedBy?: Id }).uploadedBy === v.playerId) {
        const { gm: _gm, known: _known, ...rest } = entity;
        return rest as Entity;
      }
      return facetView(entity, v) as Entity | null;
    }
    default:
      return facetView(entity, v) as Entity | null;
  }
}

/** Adds or removes an audience from a facet list, returning a new Known map. */
export function withAudience(known: Known | undefined, facet: string, audience: Audience, on: boolean): Known {
  const next: Known = { ...(known ?? {}) };
  const current = new Set(next[facet] ?? []);
  if (on) current.add(audience);
  else current.delete(audience);
  if (current.size) next[facet] = [...current];
  else delete next[facet];
  return next;
}

/** Toggles an audience in a plain audience list (notes, wiki sections, rolls). */
export function toggleAudience(list: Audience[] | undefined, audience: Audience, on: boolean): Audience[] {
  const current = new Set(list ?? []);
  if (on) current.add(audience);
  else current.delete(audience);
  return [...current];
}
