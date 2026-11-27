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
import { SECTOR_H, SECTOR_W, SUB_H, SUB_W, SUBSECTOR_LETTERS, formatHex, hexCenter, hexDistance, hexNeighbors, parseHex, pointToHex, subsectorOrigin } from './hex';
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

/** How many sectors over an end of a route lies: [x, y], +x trailing, +y rimward. */
export type SectorOffset = [number, number];

export interface ParsedRoute {
  start: string;
  end: string;
  /** Set when that end is in a neighbouring sector rather than this one. */
  startOffset?: SectorOffset;
  endOffset?: SectorOffset;
}

export interface ParsedBorder {
  /** What to call the area: the border's own label, else the allegiance's name, else its code. */
  name: string;
  allegiance?: string;
  /** A CSS colour when the source gives one. */
  color?: string;
  /** Every hex of this sector on or inside the border (CCRR). */
  hexes: string[];
}

export interface ParsedMeta {
  sectorName?: string;
  abbreviation?: string;
  /** Subsector names by letter A–P. */
  subsectors: Record<string, string>;
  routes: ParsedRoute[];
  borders: ParsedBorder[];
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

/** "0312" → column 3, row 12. Border paths may step one hex outside the sector (column 0 or 33, row 0 or 41). */
function pathHex(token: string): { col: number; row: number } | null {
  const m = /^(\d{2})(\d{2})$/.exec(token);
  return m ? { col: Number(m[1]), row: Number(m[2]) } : null;
}

/** The hexes on a straight line between two hexes, both ends included. */
function hexLine(a: { gx: number; gy: number }, b: { gx: number; gy: number }): { gx: number; gy: number }[] {
  const n = hexDistance(a, b);
  if (n <= 1) return n === 0 ? [a] : [a, b];
  const from = hexCenter(a.gx, a.gy);
  const to = hexCenter(b.gx, b.gy);
  const out: { gx: number; gy: number }[] = [];
  for (let i = 0; i <= n; i++) {
    // Sampling the line once per hex of distance lands in each hex it crosses; the nudge settles points that fall on an edge.
    const t = i / n;
    out.push(pointToHex(from.x + (to.x - from.x) * t + 1e-6, from.y + (to.y - from.y) * t + 2e-6));
  }
  return out;
}

/**
 * Turns a border path into the hexes it encloses. Map tools list the hexes along the inside of a
 * border, in order; where a state carries on into the next sector the path runs just outside the
 * edge. The result is every hex of this sector that is on the path or cut off by it from the outside.
 */
export function fillBorder(path: string[]): string[] {
  const steps = path.map(pathHex).filter((h): h is { col: number; row: number } => h !== null);
  if (steps.length === 0) return [];
  // Work in the map's own coordinates so that neighbours come from the one hex layout.
  const wall = new Set<string>();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const add = (gx: number, gy: number): void => {
    wall.add(`${gx},${gy}`);
    minX = Math.min(minX, gx);
    maxX = Math.max(maxX, gx);
    minY = Math.min(minY, gy);
    maxY = Math.max(maxY, gy);
  };
  for (let i = 0; i < steps.length; i++) {
    const a = { gx: steps[i].col - 1, gy: steps[i].row - 1 };
    add(a.gx, a.gy);
    const next = steps[i + 1];
    // A path that skips hexes would leak, so close any gap with a straight run.
    if (next) for (const h of hexLine(a, { gx: next.col - 1, gy: next.row - 1 })) add(h.gx, h.gy);
  }
  // Flood the surroundings from a corner of a box one hex bigger than the path; what the flood cannot reach is inside.
  minX--;
  maxX++;
  minY--;
  maxY++;
  const outside = new Set<string>();
  const queue: [number, number][] = [[minX, minY]];
  outside.add(`${minX},${minY}`);
  while (queue.length) {
    const [gx, gy] = queue.pop()!;
    for (const n of hexNeighbors(gx, gy)) {
      if (n.gx < minX || n.gx > maxX || n.gy < minY || n.gy > maxY) continue;
      const key = `${n.gx},${n.gy}`;
      if (wall.has(key) || outside.has(key)) continue;
      outside.add(key);
      queue.push([n.gx, n.gy]);
    }
  }
  const out: string[] = [];
  for (let gx = Math.max(minX, 0); gx <= Math.min(maxX, SECTOR_W - 1); gx++) {
    for (let gy = Math.max(minY, 0); gy <= Math.min(maxY, SECTOR_H - 1); gy++) {
      if (!outside.has(`${gx},${gy}`)) out.push(formatHex(gx + 1, gy + 1));
    }
  }
  return out;
}

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1];

function offsetOf(x: string | undefined, y: string | undefined): SectorOffset | undefined {
  const dx = Number(x ?? 0);
  const dy = Number(y ?? 0);
  return (dx || dy) && Number.isInteger(dx) && Number.isInteger(dy) ? [dx, dy] : undefined;
}

const unescapeXml = (text: string): string => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** True when the text carries MSEC lines ("sector Name", "route 0101 0202", "border 0101 0102 …"). */
const looksLikeMsec = (text: string): boolean => /^[ ]*sector[ ]+[^\t\n]+$/im.test(text) || /^\s*(?:route|border)\s+(?:[-+]?\d\s+[-+]?\d\s+)?\d{4}\b/im.test(text);

function parseMeta(text: string): ParsedMeta {
  const meta: ParsedMeta = { subsectors: {}, routes: [], borders: [] };
  // Comment headers: "# Subsector A: Name", "# Name: Sector", "# Abbreviation: Abc"
  for (const m of text.matchAll(/^\s*#\s*Subsector\s+([A-P])\s*:\s*(.+?)\s*$/gim)) meta.subsectors[m[1].toUpperCase()] = m[2];
  // The first name is the usual one; one in another language carries a tag such as "(va)".
  const nameHeader = /^\s*#\s*Name\s*:\s*(.+?)\s*$/im.exec(text);
  if (nameHeader) meta.sectorName = nameHeader[1].replace(/\s*\(\w{2}\)$/, '') || undefined;
  const abbr = /^\s*#\s*Abbreviation\s*:\s*(\S+)/im.exec(text);
  if (abbr) meta.abbreviation = abbr[1];

  const routeKeys = new Set<string>();
  const addRoute = (start: string, end: string, startOffset?: SectorOffset, endOffset?: SectorOffset): void => {
    const side = (hex: string, o?: SectorOffset): string => `${hex}@${o ? o.join(',') : ''}`;
    const a = side(start, startOffset);
    const b = side(end, endOffset);
    if (a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (routeKeys.has(key)) return;
    routeKeys.add(key);
    meta.routes.push({ start, end, ...(startOffset ? { startOffset } : {}), ...(endOffset ? { endOffset } : {}) });
  };
  // Borders by their path, so that the same border given in two forms (XML and MSEC) is counted once.
  const borders = new Map<string, { path: string[]; name?: string; allegiance?: string; color?: string }>();
  const addBorder = (path: string[], info: { name?: string; allegiance?: string; color?: string }): void => {
    if (path.length === 0) return;
    const key = path.join(' ');
    const have = borders.get(key);
    if (have) {
      have.name ??= info.name;
      have.allegiance ??= info.allegiance;
      have.color ??= info.color;
    } else borders.set(key, { path, ...info });
  };

  // XML metadata.
  if (/<Sector[\s>]/i.test(text)) {
    const xmlName = /<Name(?:\s[^>]*)?>([^<]+)<\/Name>/i.exec(text);
    if (xmlName) meta.sectorName ??= unescapeXml(xmlName[1].trim());
    const xmlAbbr = /<Sector[^>]*\sAbbreviation="([^"]+)"/i.exec(text);
    if (xmlAbbr) meta.abbreviation ??= xmlAbbr[1];
    for (const m of text.matchAll(/<Subsector\s+Index="([A-P])"[^>]*>([^<]*)<\/Subsector>/gi)) {
      if (m[2].trim()) meta.subsectors[m[1].toUpperCase()] ??= unescapeXml(m[2].trim());
    }
    for (const m of text.matchAll(/<Route(\s[^>]*?)\/?>/gi)) {
      const start = attr(m[1], 'Start');
      const end = attr(m[1], 'End');
      if (!start || !end || !/^\d{4}$/.test(start) || !/^\d{4}$/.test(end)) continue;
      addRoute(start, end, offsetOf(attr(m[1], 'StartOffsetX'), attr(m[1], 'StartOffsetY')), offsetOf(attr(m[1], 'EndOffsetX'), attr(m[1], 'EndOffsetY')));
    }
    const allegiances = new Map<string, string>();
    for (const m of text.matchAll(/<Allegiance(\s[^>]*)>([^<]*)<\/Allegiance>/gi)) {
      const code = attr(m[1], 'Code');
      if (code && m[2].trim()) allegiances.set(code, unescapeXml(m[2].trim()));
    }
    for (const m of text.matchAll(/<Border(\s[^>]*)?>([^<]*)<\/Border>/gi)) {
      const tag = m[1] ?? '';
      const code = attr(tag, 'Allegiance');
      const label = attr(tag, 'Label');
      // A name such as "Kestrel Concord, Home Fleet" is one part of a larger state: name the area after the state.
      const name = (label ? unescapeXml(label) : code ? allegiances.get(code)?.split(',')[0] : undefined)?.trim();
      addBorder(m[2].trim().split(/\s+/).filter((t) => /^\d{4}$/.test(t)), { name: name || code, allegiance: code, color: attr(tag, 'Color') });
    }
  }

  // MSEC: "sector Name", "a Name" … "p Name", "route 0101 0202", "label 0101 Name", "border 0101 0102 … colour"
  const msecSector = /^[ ]*sector[ ]+([^\t\n]+?)[ ]*$/im.exec(text);
  if (msecSector) meta.sectorName ??= msecSector[1];
  if (looksLikeMsec(text)) {
    for (const m of text.matchAll(/^\s*([a-p])\s+(\S.*?)\s*$/gim)) meta.subsectors[m[1].toUpperCase()] ??= m[2];
    for (const m of text.matchAll(/^\s*route\s+(?:([-+]?\d)\s+([-+]?\d)\s+)?(\d{4})\s+(?:([-+]?\d)\s+([-+]?\d)\s+)?(\d{4})\b/gim)) {
      addRoute(m[3], m[6], offsetOf(m[1], m[2]), offsetOf(m[4], m[5]));
    }
    // A label line names the borders that follow it; borders of one state share a colour.
    let label: string | undefined;
    const msecBorders: { path: string[]; name?: string; color?: string }[] = [];
    for (const line of text.split('\n')) {
      const l = /^\s*label\s+\d{4}\s+(\S.*?)\s*$/i.exec(line);
      if (l) {
        label = l[1];
        continue;
      }
      const b = /^\s*border\s+(.+?)\s*$/i.exec(line);
      if (!b) {
        if (line.trim() && !line.trim().startsWith('#')) label = undefined;
        continue;
      }
      const tokens = b[1].split(/\s+/);
      const path = tokens.filter((t) => /^\d{4}$/.test(t));
      const color = tokens.find((t) => !/^\d{4}$/.test(t));
      msecBorders.push({ path, name: label, color });
      label = undefined;
    }
    const nameByColor = new Map<string, string>();
    for (const b of msecBorders) if (b.name && b.color && !nameByColor.has(b.color)) nameByColor.set(b.color, b.name);
    for (const b of msecBorders) addBorder(b.path, { name: b.name ?? (b.color ? nameByColor.get(b.color) : undefined), color: b.color });
  }

  for (const b of borders.values()) {
    const hexes = fillBorder(b.path);
    if (hexes.length) meta.borders.push({ name: b.name ?? 'Border', ...(b.allegiance ? { allegiance: b.allegiance } : {}), ...(b.color ? { color: b.color } : {}), hexes });
  }
  return meta;
}

/** The text with sector metadata (an XML document, MSEC lines) taken out, so that it is not read as rows of worlds. */
function withoutMeta(text: string): string {
  let out = text.replace(/<\?xml[^>]*\?>/gi, '').replace(/<Sector[\s>][\s\S]*?<\/Sector>/gi, '');
  if (looksLikeMsec(out)) {
    out = out
      .split('\n')
      // Rows of worlds are never taken out: they hold a world profile, and a tab-delimited header row holds tabs.
      .filter((line) => UWP_PATTERN.test(line) || line.includes('\t') || !/^ *(?:(?:sector|route|border|label|region)\b|[a-p] +\S)/i.test(line))
      .join('\n');
  }
  return out;
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

function parseDelimited(lines: string[], split: (line: string) => string[], warnings: string[], meta?: ParsedMeta): ParsedWorld[] | null {
  const headerIndex = lines.findIndex((l) => {
    const fields = split(l).map(fieldFor);
    return fields.includes('hex') && fields.includes('uwp');
  });
  if (headerIndex < 0) return null;
  const fields = split(lines[headerIndex]).map(fieldFor);
  const worlds: ParsedWorld[] = [];
  const sectors = new Set<string>();
  let skipped = 0;
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const cells = split(line);
    const rec: Partial<Record<keyof ParsedWorld, string>> = {};
    let sector = '';
    fields.forEach((field, i) => {
      if (field === 'sector') sector = (cells[i] ?? '').trim();
      else if (field && cells[i] !== undefined) rec[field] = cells[i];
    });
    const world = worldFromRecord(rec);
    if (world) {
      worlds.push(world);
      if (sector) sectors.add(sector);
    } else skipped++;
  }
  if (skipped) warnings.push(`${skipped} row(s) had no usable hex and UWP and were skipped.`);
  // A "Sector" column that says the same thing on every row names the sector: a short code, or the name in full.
  if (meta && sectors.size === 1) {
    const [value] = sectors;
    if (/^\S{1,6}$/.test(value)) meta.abbreviation ??= value;
    else meta.sectorName ??= value;
  }
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
  const lines = withoutMeta(text).split('\n');

  let format: ParseResult['format'] = 'none';
  let worlds: ParsedWorld[] = [];

  const json = parseJson(text, warnings);
  if (json) {
    format = 'json';
    worlds = json;
  }
  if (format === 'none') {
    const tab = lines.some((l) => l.includes('\t')) ? parseDelimited(lines, (l) => l.split('\t'), warnings, meta) : null;
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
    const csv = lines.some((l) => l.includes(',')) ? parseDelimited(lines, splitCsvLine, warnings, meta) : null;
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
