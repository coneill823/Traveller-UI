/**
 * Reading and writing Chronicler wiki pages: Markdown files with a YAML frontmatter block
 * (the page's infobox) followed by the body. The body is split into sections by heading so each
 * can be revealed to players separately.
 */
import { parseDocument, stringify } from 'yaml';
import { slugify } from './util';

export interface PageSection {
  id: string;
  heading: string;
  level: number;
  body: string;
  /** True for sections under a heading that marks GM-only material. */
  locked: boolean;
}

export interface ParsedPage {
  frontmatter: Record<string, unknown>;
  /** Everything after the frontmatter block, unchanged. */
  body: string;
  sections: PageSection[];
  /** False when the frontmatter block exists but is not valid YAML (it is then left untouched). */
  frontmatterOk: boolean;
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** Headings that mark a section, and everything nested under it, as never shown to players. */
const GM_HEADING = /^\s*(gm\b|g\.m\.|referee|ref notes|secret|spoiler)/i;

export function splitFrontmatter(content: string): { yaml: string | null; body: string } {
  const m = FRONTMATTER.exec(content);
  if (!m) return { yaml: null, body: content.replace(/^﻿/, '') };
  return { yaml: m[1], body: content.slice(m[0].length) };
}

export function parsePage(content: string): ParsedPage {
  const { yaml, body } = splitFrontmatter(content);
  let frontmatter: Record<string, unknown> = {};
  let frontmatterOk = true;
  if (yaml !== null) {
    try {
      const doc = parseDocument(yaml);
      if (doc.errors.length) frontmatterOk = false;
      else {
        const value = doc.toJS() as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) frontmatter = value as Record<string, unknown>;
      }
    } catch {
      frontmatterOk = false;
    }
  }
  return { frontmatter, body, sections: splitSections(body), frontmatterOk };
}

/** Splits markdown into sections at headings, ignoring "#" lines inside fenced code blocks. */
export function splitSections(body: string): PageSection[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const sections: PageSection[] = [];
  const used = new Map<string, number>();
  let current: PageSection = { id: '_intro', heading: '', level: 0, body: '', locked: false };
  let buffer: string[] = [];
  let fence: string | null = null;
  // Level of the GM heading we are currently nested under (0 = none).
  let lockLevel = 0;

  const flush = () => {
    current.body = buffer.join('\n').replace(/^\n+|\n+$/g, '');
    if (current.id !== '_intro' || current.body.trim() !== '') sections.push(current);
    buffer = [];
  };

  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      buffer.push(line);
      continue;
    }
    const heading = fence === null ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (!heading) {
      buffer.push(line);
      continue;
    }
    flush();
    const level = heading[1].length;
    const text = heading[2].trim();
    if (lockLevel && level <= lockLevel) lockLevel = 0;
    if (!lockLevel && GM_HEADING.test(text)) lockLevel = level;
    const base = slugify(text) || 'section';
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    current = { id: n === 1 ? base : `${base}-${n}`, heading: text, level, body: '', locked: lockLevel > 0 };
  }
  flush();
  return sections;
}

/**
 * Updates a page's frontmatter while keeping the author's formatting, comments and any keys the
 * app does not manage. `set` values replace or add keys; keys in `remove` are deleted.
 */
export function updateFrontmatter(content: string, set: Record<string, unknown>, remove: string[] = []): string {
  const { yaml, body } = splitFrontmatter(content);
  if (yaml === null) {
    const fresh = stringify(set, { lineWidth: 0 }).trimEnd();
    return `---\n${fresh}\n---\n${body.startsWith('\n') || body === '' ? '' : '\n'}${body}`;
  }
  const doc = parseDocument(yaml);
  if (doc.errors.length) return content; // never rewrite frontmatter we could not read
  if (doc.contents === null) doc.contents = doc.createNode({}) as never;
  for (const [key, value] of Object.entries(set)) doc.set(key, value);
  for (const key of remove) doc.delete(key);
  const text = doc.toString({ lineWidth: 0 }).trimEnd();
  return `---\n${text}\n---\n${body}`;
}

/** Builds a new page from frontmatter and a body. */
export function buildPage(frontmatter: Record<string, unknown>, body = ''): string {
  return `---\n${stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n${body ? `\n${body.replace(/^\n+/, '')}` : ''}`;
}

/** Makes a string safe to use as a file or folder name on Windows, macOS and Linux. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned);
  return (reserved ? `${cleaned}_` : cleaned).slice(0, 80) || 'Untitled';
}

/** Page title: the frontmatter title when present, otherwise the file name. */
export function pageTitle(path: string, frontmatter: Record<string, unknown>): string {
  const title = frontmatter.title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.md$/i, '');
}

export function pageTags(frontmatter: Record<string, unknown>): string[] {
  const tags = frontmatter.tags;
  if (Array.isArray(tags)) return tags.map(String);
  if (typeof tags === 'string') return tags.split(/[,\s]+/).filter(Boolean);
  return [];
}
