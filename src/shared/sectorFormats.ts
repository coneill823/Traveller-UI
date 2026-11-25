/**
 * Parsers for sector and subsector data produced by online generators and map tools.
 *
 * Supported inputs, detected automatically:
 *  - Second Survey tab-delimited (header row with Hex / Name / UWP …)
 *  - Second Survey column-delimited (header row + a row of dashes marking the columns)
 *  - Legacy SEC fixed-column files
 *  - JSON world lists (e.g. { "Worlds": [{ "Hex": "0101", "UWP": "…" }] })
 *  - CSV with a header row
 *  - "Loose" text: any lines that contain a hex number and a world profile
 * plus sector metadata mixed in or pasted separately: subsector names and routes in
 * comment headers, MSEC lines or XML.
 */
import { SUB_H, SUB_W, SUBSECTOR_LETTERS, formatHex, parseHex, subsectorOrigin } from './hex';
import { UWP_PATTERN, isValidUwp } from './uwp';

export interface ParsedWorld {
  hex: string;
  name: string;
  uwp: string;
  bases?: string;
  remarks?: string;
  zone?: '' | 'A' | 'R';
  pbg?: string;
  allegiance?: string;
  stars?: string;
  ix?: string;
  ex?: string;
  cx?: string;
  nobility?: string;
  worlds?: string;
  ru?: string;
  /** Subsector letter given by the source, when it has one. */
  subsector?: string;
}

export interface ParsedMeta {
  sectorName?: string;
  abbreviation?: string;
  /** Subsector names by letter A–P. */
  subsectors: Record<string, string>;
  routes: { start: string; end: string }[];
}

export interface ParseResult {
  format: 'tab' | 'columns' | 'sec' | 'json' | 'csv' | 'loose' | 'none';
  formatLabel: string;
  worlds: ParsedWorld[];
  meta: ParsedMeta;
  warnings: string[];
  /** True when every hex fits inside one subsector (0101–0810), i.e. this is probably subsector data. */
  looksLikeSubsector: boolean;
}

const FORMAT_LABELS: Record<ParseResult['format'], string> = {
  tab: 'Second Survey (tab-delimited)',
  columns: 'Second Survey (column-delimited)',
  sec: 'Legacy SEC',
  json: 'JSON world list',
  csv: 'CSV',
  loose: 'Loose text (hex + UWP per line)',
  none: 'Not recognised',
};

const UWP_GLOBAL = new RegExp(UWP_PATTERN.source, 'g');

function cleanZone(value: string | undefined): '' | 'A' | 'R' {
  const z = (value ?? '').trim().toUpperCase();
  if (z === 'A' || z === 'AMBER') return 'A';
  if (z === 'R' || z === 'RED') return 'R';
  return '';
}

function cleanField(value: string | undefined): string | undefined {
  const v = (value ?? '').trim();
  return v === '' || v === '-' ? undefined : v;
}

/** Maps assorted header spellings onto our field names. */
function fieldFor(header: string): keyof ParsedWorld | 'sector' | undefined {
  const h = header.trim().toLowerCase().replace(/[^a-z{}()[\]]/g, '');
  switch (h) {
    case 'hex':
    case 'hexnbr':
    case 'location':
    case 'loc':
      return 'hex';
    case 'name':
    case 'worldname':
    case 'world':
    case 'mainworld':
      return 'name';
    case 'uwp':
    case 'profile':
    case 'upp':
      return 'uwp';
    case 'bases':
    case 'base':
    case 'b':
      return 'bases';
    case 'remarks':
    case 'codes':
    case 'tradecodes':
    case 'trade':
    case 'comments':
    case 'codescomments':
    case 'notes':
      return 'remarks';
    case 'zone':
    case 'z':
    case 'travelzone':
      return 'zone';
    case 'pbg':
      return 'pbg';
    case 'allegiance':
    case 'alleg':
    case 'a':
      return 'allegiance';
    case 'stars':
    case 'stellar':
    case 'stellardata':
      return 'stars';
    case '{ix}':
    case 'ix':
    case 'importance':
      return 'ix';
    case '(ex)':
    case 'ex':
    case 'economic':
      return 'ex';
    case '[cx]':
    case 'cx':
    case 'cultural':
      return 'cx';
    case 'nobility':
    case 'n':
      return 'nobility';
    case 'w':
    case 'worlds':
      return 'worlds';
    case 'ru':
      return 'ru';
    case 'ss':
    case 'subsector':
      return 'subsector';
    case 'sector':
      return 'sector';
    default:
      return undefined;
  }
}

function worldFromRecord(rec: Partial<Record<keyof ParsedWorld, string>>): ParsedWorld | null {
  const hexMatch = /\d{4}/.exec(rec.hex ?? '');
  const uwp = (rec.uwp ?? '').trim().toUpperCase();
  if (!hexMatch || !isValidUwp(uwp)) return null;
  return {
    hex: hexMatch[0],
    name: (rec.name ?? '').trim(),
    uwp,
    bases: cleanField(rec.bases),
    remarks: cleanField(rec.remarks),
    zone: cleanZone(rec.zone),
    pbg: cleanField(rec.pbg),
    allegiance: cleanField(rec.allegiance),
    stars: cleanField(rec.stars),
    ix: cleanField(rec.ix),
    ex: cleanField(rec.ex),
    cx: cleanField(rec.cx),
    nobility: cleanField(rec.nobility),
    worlds: cleanField(rec.worlds),
    ru: cleanField(rec.ru),
    subsector: cleanField(rec.subsector)?.toUpperCase(),
  };
}

// ───────────────────────────── metadata ─────────────────────────────

function parseMeta(text: string): ParsedMeta {
  const meta: ParsedMeta = { subsectors: {}, routes: [] };
  // Comment headers: "# Subsector A: Name", "# Name: Sector", "# Abbreviation: Abc"
  for (const m of text.matchAll(/^\s*#\s*Subsector\s+([A-P])\s*:\s*(.+?)\s*$/gim)) meta.subsectors[m[1].toUpperCase()] = m[2];
  const nameHeader = /^\s*#\s*Name\s*:\s*(.+?)\s*$/im.exec(text);
  if (nameHeader && !/\(\w{2}\)\s*$/.test(nameHeader[1])) meta.sectorName = nameHeader[1];
  const abbr = /^\s*#\s*Abbreviation\s*:\s*(\S+)/im.exec(text);
  if (abbr) meta.abbreviation = abbr[1];
  // MSEC: "sector Name", "a Name" … "p Name", "route 0101 0202"
  const msecSector = /^\s*sector\s+(.+?)\s*$/im.exec(text);
  if (msecSector) meta.sectorName ??= msecSector[1];
  for (const m of text.matchAll(/^\s*([a-p])\s+(\S.*?)\s*$/gim)) {
    // Only treat single-letter lines as subsector names when the file looks like MSEC.
    if (msecSector || /^\s*route\s+\d{4}\s+\d{4}/im.test(text)) meta.subsectors[m[1].toUpperCase()] ??= m[2];
  }
  for (const m of text.matchAll(/^\s*route\s+(?:[-+]?\d\s+[-+]?\d\s+)?(\d{4})\s+(?:[-+]?\d\s+[-+]?\d\s+)?(\d{4})/gim)) {
    meta.routes.push({ start: m[1], end: m[2] });
  }
  // XML metadata.
  if (/<Sector[\s>]/i.test(text)) {
    const xmlName = /<Name(?:\s[^>]*)?>([^<]+)<\/Name>/i.exec(text);
    if (xmlName) meta.sectorName ??= xmlName[1].trim();
    const xmlAbbr = /<Sector[^>]*\sAbbreviation="([^"]+)"/i.exec(text);
    if (xmlAbbr) meta.abbreviation ??= xmlAbbr[1];
    for (const m of text.matchAll(/<Subsector\s+Index="([A-P])"[^>]*>([^<]*)<\/Subsector>/gi)) {
      if (m[2].trim()) meta.subsectors[m[1].toUpperCase()] ??= m[2].trim();
    }
    for (const m of text.matchAll(/<Route\s+([^>]*?)\/?>/gi)) {
      const start = /Start="(\d{4})"/i.exec(m[1]);
      const end = /End="(\d{4})"/i.exec(m[1]);
      // Routes that leave the sector carry offsets; those are skipped.
      if (start && end && !/(Start|End)Offset[XY]="[-+]?[1-9]/i.test(m[1])) meta.routes.push({ start: start[1], end: end[1] });
    }
  }
  return meta;
}

// ───────────────────────────── formats ─────────────────────────────

function parseJson(text: string, warnings: string[]): ParsedWorld[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const list: unknown[] | undefined = Array.isArray(data)
    ? data
    : (Object.values(data as Record<string, unknown>).find((v) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') as unknown[] | undefined);
  if (!list) return null;
  const worlds: ParsedWorld[] = [];
  let skipped = 0;
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const rec: Partial<Record<keyof ParsedWorld, string>> = {};
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      const field = fieldFor(key);
      if (field && field !== 'sector' && (typeof value === 'string' || typeof value === 'number')) rec[field] = String(value);
    }
    const world = worldFromRecord(rec);
    if (world) worlds.push(world);
    else skipped++;
  }
  if (skipped) warnings.push(`${skipped} JSON record(s) had no usable hex and UWP and were skipped.`);
  return worlds.length ? worlds : null;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseDelimited(lines: string[], split: (line: string) => string[], warnings: string[]): ParsedWorld[] | null {
  const headerIndex = lines.findIndex((l) => {
    const fields = split(l).map(fieldFor);
    return fields.includes('hex') && fields.includes('uwp');
  });
  if (headerIndex < 0) return null;
  const fields = split(lines[headerIndex]).map(fieldFor);
  const worlds: ParsedWorld[] = [];
  let skipped = 0;
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const cells = split(line);
    const rec: Partial<Record<keyof ParsedWorld, string>> = {};
    fields.forEach((field, i) => {
      if (field && field !== 'sector' && cells[i] !== undefined) rec[field] = cells[i];
    });
    const world = worldFromRecord(rec);
    if (world) worlds.push(world);
    else skipped++;
  }
  if (skipped) warnings.push(`${skipped} row(s) had no usable hex and UWP and were skipped.`);
  return worlds.length ? worlds : null;
}

/** Second Survey column format: the dashes row under the header gives each column's extent. */
function parseColumns(lines: string[], warnings: string[]): ParsedWorld[] | null {
  for (let i = 0; i < lines.length - 1; i++) {
    const header = lines[i];
    const rule = lines[i + 1];
    if (!/^[-\s]+$/.test(rule) || !rule.includes('-') || !/hex/i.test(header) || !/uwp/i.test(header)) continue;
    const spans: { start: number; end: number; field: ReturnType<typeof fieldFor> }[] = [];
    for (const m of rule.matchAll(/-+/g)) {
      const start = m.index!;
      const end = start + m[0].length;
      spans.push({ start, end, field: fieldFor(header.slice(start, end)) });
    }
    const worlds: ParsedWorld[] = [];
    let skipped = 0;
    for (const line of lines.slice(i + 2)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const rec: Partial<Record<keyof ParsedWorld, string>> = {};
      spans.forEach((span, n) => {
        if (!span.field || span.field === 'sector') return;
        // The last column runs to the end of the line.
        rec[span.field] = n === spans.length - 1 ? line.slice(span.start) : line.slice(span.start, span.end);
      });
      const world = worldFromRecord(rec);
      if (world) worlds.push(world);
      else skipped++;
    }
    if (skipped) warnings.push(`${skipped} row(s) had no usable hex and UWP and were skipped.`);
    return worlds.length ? worlds : null;
  }
  return null;
}

const LUMINOSITY = /^(?:Ia|Ib|II|III|IV|V|VI|D)$/;

/** Index of the first token that starts the stellar data ("G2 V", "M1V", …), or -1. */
function stellarStart(tokens: string[]): number {
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (/^[OBAFGKM]\d?$/.test(t) && LUMINOSITY.test(tokens[k + 1] ?? '')) return k;
    if (/^[OBAFGKM]\d(?:Ia|Ib|II|III|IV|V|VI|D)$/.test(t)) return k;
  }
  return -1;
}

/**
 * Loose line parser, also used for legacy SEC files. Finds the world profile, then the hex number
 * (before or after the name), and interprets what follows the profile token by token.
 */
function parseLooseLine(line: string): ParsedWorld | null {
  const uwpMatch = UWP_PATTERN.exec(line);
  if (!uwpMatch) return null;
  const before = line.slice(0, uwpMatch.index);
  const after = line.slice(uwpMatch.index + uwpMatch[0].length);

  // Hex: the last four-digit group before the profile, else the first one after it.
  let hex: string | undefined;
  let name = before;
  const hexesBefore = [...before.matchAll(/(?<![\d.])(\d{4})(?![\d.])/g)];
  if (hexesBefore.length) {
    const m = hexesBefore[hexesBefore.length - 1];
    hex = m[1];
    name = before.slice(0, m.index) + ' ' + before.slice(m.index! + 4);
  }
  let rest = after;
  if (!hex) {
    const m = /(?<![\d.])(\d{4})(?![\d.])/.exec(after);
    if (!m) return null;
    hex = m[1];
    rest = after.slice(0, m.index) + ' ' + after.slice(m.index + 4);
  }
  if (!parseHex(hex)) return null;
  name = name.replace(/[|,;:\t]+/g, ' ').replace(/\s+/g, ' ').trim();

  const world: ParsedWorld = { hex, name, uwp: uwpMatch[0].toUpperCase(), zone: '' };

  let tokens = rest.replace(/[|,;\t]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  // Stellar data sits at the end of the line.
  const starAt = stellarStart(tokens);
  const stars: string[] = [];
  if (starAt >= 0) {
    stars.push(...tokens.slice(starAt));
    tokens = tokens.slice(0, starAt);
  }

  const remarks: string[] = [];
  const afterPbg: string[] = [];
  let i = 0;
  // Bases come first when present: capital letters (or '*') that are not a trade code.
  if (tokens[i] && /^[A-Z*]{1,3}$/.test(tokens[i])) {
    // A single 'A' or 'R' directly followed by a PBG is a travel zone, not a base.
    if (!(/^[AR]$/.test(tokens[i]) && /^\d[0-9A-F]{2}$/i.test(tokens[i + 1] ?? ''))) world.bases = tokens[i++];
  } else if (tokens[i] === '-') {
    i++;
  }
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d[0-9A-F]{2}$/i.test(t) && world.pbg === undefined) {
      world.pbg = t.toUpperCase();
      // Allegiance normally follows the PBG.
      const next = tokens[i + 1];
      if (next && /^[A-Za-z][A-Za-z0-9]{1,3}$/.test(next)) {
        world.allegiance = next;
        i++;
      }
      continue;
    }
    if (t === '-') continue;
    if (/^\{.*\}$/.test(t)) world.ix = t;
    else if (/^\(.*\)$/.test(t) && /[0-9A-Z]{3}[+-]\d/.test(t)) world.ex = t;
    else if (/^\[.*\]$/.test(t)) world.cx = t;
    else if (world.pbg !== undefined) afterPbg.push(t); // anything after the PBG block is stellar (e.g. a lone "BD")
    else if (/^[AR]$/.test(t)) world.zone = t as 'A' | 'R';
    else remarks.push(t);
  }
  if (remarks.length) world.remarks = remarks.join(' ');
  if (afterPbg.length || stars.length) world.stars = [...afterPbg, ...stars].join(' ');
  return world;
}

/** Legacy SEC files pack two bases into one letter. */
const LEGACY_BASES: Record<string, string> = { A: 'NS', B: 'NW', F: 'NM', H: 'CN' };

function parseLoose(lines: string[], warnings: string[]): { worlds: ParsedWorld[]; sec: boolean } {
  const worlds: ParsedWorld[] = [];
  let candidates = 0;
  let fixedColumns = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*(#|\/\/)/.test(line)) continue;
    if (!UWP_GLOBAL.test(line)) {
      UWP_GLOBAL.lastIndex = 0;
      continue;
    }
    UWP_GLOBAL.lastIndex = 0;
    candidates++;
    // Legacy SEC puts the hex in columns 15–18 and the profile in 20–28.
    if (/^\d{4}$/.test(line.slice(14, 18)) && isValidUwp(line.slice(19, 28))) fixedColumns++;
    const world = parseLooseLine(line);
    if (world) worlds.push(world);
  }
  if (candidates > worlds.length) warnings.push(`${candidates - worlds.length} line(s) had a world profile but no hex number and were skipped.`);
  const sec = worlds.length > 0 && fixedColumns >= worlds.length * 0.8;
  if (sec) for (const w of worlds) if (w.bases && LEGACY_BASES[w.bases]) w.bases = LEGACY_BASES[w.bases];
  return { worlds, sec };
}

// ───────────────────────────── entry point ─────────────────────────────

export function parseSectorData(input: string): ParseResult {
  const text = input.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const warnings: string[] = [];
  const meta = parseMeta(text);
  const lines = text.split('\n');

  let format: ParseResult['format'] = 'none';
  let worlds: ParsedWorld[] = [];

  const json = parseJson(text, warnings);
  if (json) {
    format = 'json';
    worlds = json;
  }
  if (format === 'none') {
    const tab = lines.some((l) => l.includes('\t')) ? parseDelimited(lines, (l) => l.split('\t'), warnings) : null;
    if (tab) {
      format = 'tab';
      worlds = tab;
    }
  }
  if (format === 'none') {
    const columns = parseColumns(lines, warnings);
    if (columns) {
      format = 'columns';
      worlds = columns;
    }
  }
  if (format === 'none') {
    const csv = lines.some((l) => l.includes(',')) ? parseDelimited(lines, splitCsvLine, warnings) : null;
    if (csv) {
      format = 'csv';
      worlds = csv;
    }
  }
  if (format === 'none') {
    const loose = parseLoose(lines, warnings);
    if (loose.worlds.length) {
      format = loose.sec ? 'sec' : 'loose';
      worlds = loose.worlds;
    }
  }

  // Drop impossible hexes and duplicates (keeping the first).
  const seen = new Set<string>();
  const valid: ParsedWorld[] = [];
  for (const w of worlds) {
    if (!parseHex(w.hex)) {
      warnings.push(`Hex ${w.hex} (${w.name || 'unnamed'}) is outside a 32×40 sector and was skipped.`);
      continue;
    }
    if (seen.has(w.hex)) {
      warnings.push(`Hex ${w.hex} appears more than once; kept the first entry.`);
      continue;
    }
    seen.add(w.hex);
    valid.push(w);
  }

  const looksLikeSubsector =
    valid.length > 0 &&
    valid.every((w) => {
      const h = parseHex(w.hex)!;
      return h.col <= SUB_W && h.row <= SUB_H;
    });

  return { format, formatLabel: FORMAT_LABELS[format], worlds: valid, meta, warnings, looksLikeSubsector };
}

/** Moves subsector-local hexes (0101–0810) to their place inside a sector. */
export function placeInSubsector(worlds: ParsedWorld[], letter: string): ParsedWorld[] {
  const { col0, row0 } = subsectorOrigin(letter);
  return worlds.map((w) => {
    const h = parseHex(w.hex)!;
    return { ...w, hex: formatHex(h.col + col0, h.row + row0) };
  });
}

/** Serialises worlds in Second Survey tab-delimited form, for export and round-trip tests. */
export function toTabDelimited(worlds: ParsedWorld[]): string {
  const header = ['Hex', 'Name', 'UWP', 'Bases', 'Remarks', 'Zone', 'PBG', 'Allegiance', 'Stars', '{Ix}', '(Ex)', '[Cx]', 'Nobility', 'W', 'RU'];
  const rows = worlds.map((w) =>
    [w.hex, w.name, w.uwp, w.bases ?? '', w.remarks ?? '', w.zone ?? '', w.pbg ?? '', w.allegiance ?? '', w.stars ?? '', w.ix ?? '', w.ex ?? '', w.cx ?? '', w.nobility ?? '', w.worlds ?? '', w.ru ?? ''].join('\t'),
  );
  return [header.join('\t'), ...rows].join('\n');
}

export { SUBSECTOR_LETTERS };
