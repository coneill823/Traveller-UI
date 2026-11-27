/**
 * Reading sectors from the Traveller Map (travellermap.com). Its data services may be called from
 * other sites, so the GM's own browser fetches a sector and the app imports it like a pasted file:
 * nothing from the map is kept in this program.
 */

export const TRAVELLERMAP_URL = 'https://travellermap.com';
/** The era asked for: the classic setting, year 1105. */
export const TRAVELLERMAP_MILIEU = 'M1105';

export interface MapSector {
  /** Position on the sector grid, the same way round as this app: +x trailing, +y rimward. */
  x: number;
  y: number;
  name: string;
  abbr?: string;
  tags: string[];
}

export function universeUrl(): string {
  return `${TRAVELLERMAP_URL}/api/universe?requireData=1&milieu=${TRAVELLERMAP_MILIEU}`;
}

/** The three files that describe one sector: its worlds, its names and routes, and its borders with their colours. */
export function sectorUrls(x: number, y: number): { data: string; metadata: string; borders: string } {
  const at = `sx=${x}&sy=${y}&milieu=${TRAVELLERMAP_MILIEU}`;
  return {
    data: `${TRAVELLERMAP_URL}/api/sec?${at}&type=SecondSurvey`,
    metadata: `${TRAVELLERMAP_URL}/api/metadata?${at}&accept=text/xml`,
    borders: `${TRAVELLERMAP_URL}/api/msec?${at}`,
  };
}

/** The list of sectors from the map's "universe" service, one per position, nearest the centre first. */
export function parseUniverse(data: unknown): MapSector[] {
  const list = (data as { Sectors?: unknown } | null)?.Sectors;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: MapSector[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const s = raw as { X?: unknown; Y?: unknown; Abbreviation?: unknown; Tags?: unknown; Names?: unknown };
    const names = Array.isArray(s.Names) ? s.Names : [];
    const name = (names.find((n) => typeof (n as { Text?: unknown })?.Text === 'string') as { Text: string } | undefined)?.Text.trim();
    if (!name || !Number.isInteger(s.X) || !Number.isInteger(s.Y)) continue;
    const x = s.X as number;
    const y = s.Y as number;
    // The app's grid runs to 500 sectors each way.
    if (Math.abs(x) > 500 || Math.abs(y) > 500 || seen.has(`${x},${y}`)) continue;
    seen.add(`${x},${y}`);
    out.push({
      x,
      y,
      name: name.slice(0, 60),
      abbr: typeof s.Abbreviation === 'string' && s.Abbreviation.trim() ? s.Abbreviation.trim().slice(0, 6) : undefined,
      tags: typeof s.Tags === 'string' ? s.Tags.split(/\s+/).filter(Boolean) : [],
    });
  }
  return out.sort((a, b) => Math.max(Math.abs(a.x), Math.abs(a.y)) - Math.max(Math.abs(b.x), Math.abs(b.y)) || a.y - b.y || a.x - b.x);
}

/** Sectors in the rectangle between two grid positions, corners included. */
export function sectorsBetween(list: MapSector[], a: { x: number; y: number }, b: { x: number; y: number }): MapSector[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return list.filter((s) => s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1);
}
