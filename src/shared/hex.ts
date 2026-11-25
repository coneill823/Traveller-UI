/**
 * Hex geometry for Traveller star maps.
 *
 * A sector is 32 columns by 40 rows of one-parsec hexes, split into sixteen 8x10 subsectors
 * lettered A–P. Hexes are flat-topped and numbered "CCRR"; even-numbered columns sit half a
 * hex lower than odd ones. Sectors tile on an integer grid, so every hex also has a global
 * coordinate (gx, gy) that is continuous across sector edges.
 *
 * World units: adjacent columns are 1 apart on x, adjacent rows ROW_H apart on y.
 */

export const SECTOR_W = 32;
export const SECTOR_H = 40;
export const SUB_W = 8;
export const SUB_H = 10;
/** Distance between rows when columns are 1 apart (flat-topped regular hexagons). */
export const ROW_H = 2 / Math.sqrt(3);
/** Centre-to-corner size of a hex in world units. */
export const HEX_SIZE = 2 / 3;

export const SUBSECTOR_LETTERS = 'ABCDEFGHIJKLMNOP';

export interface HexRef {
  col: number;
  row: number;
}
export interface GlobalHex {
  gx: number;
  gy: number;
}
export interface Point {
  x: number;
  y: number;
}

export function parseHex(hex: string | undefined | null): HexRef | null {
  if (!hex) return null;
  const m = /^(\d{2})(\d{2})$/.exec(hex.trim());
  if (!m) return null;
  const col = Number(m[1]);
  const row = Number(m[2]);
  if (col < 1 || col > SECTOR_W || row < 1 || row > SECTOR_H) return null;
  return { col, row };
}

export function formatHex(col: number, row: number): string {
  return `${String(col).padStart(2, '0')}${String(row).padStart(2, '0')}`;
}

export function toGlobal(sectorX: number, sectorY: number, col: number, row: number): GlobalHex {
  return { gx: sectorX * SECTOR_W + (col - 1), gy: sectorY * SECTOR_H + (row - 1) };
}

export function fromGlobal(gx: number, gy: number): { sx: number; sy: number; col: number; row: number } {
  const sx = Math.floor(gx / SECTOR_W);
  const sy = Math.floor(gy / SECTOR_H);
  return { sx, sy, col: gx - sx * SECTOR_W + 1, row: gy - sy * SECTOR_H + 1 };
}

export function globalKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

export function parseGlobalKey(key: string): GlobalHex {
  const i = key.indexOf(',');
  return { gx: Number(key.slice(0, i)), gy: Number(key.slice(i + 1)) };
}

/** Columns with odd gx (even-numbered hex columns) are shifted down half a row. */
function shifted(gx: number): number {
  return gx & 1;
}

export function hexCenter(gx: number, gy: number): Point {
  return { x: gx, y: (gy + 0.5 * shifted(gx)) * ROW_H };
}

/** The six corners of a hex, starting at the right-hand corner and going clockwise on screen. */
export function hexCorners(gx: number, gy: number): Point[] {
  const c = hexCenter(gx, gy);
  const h = ROW_H / 2;
  const s = HEX_SIZE;
  return [
    { x: c.x + s, y: c.y },
    { x: c.x + s / 2, y: c.y + h },
    { x: c.x - s / 2, y: c.y + h },
    { x: c.x - s, y: c.y },
    { x: c.x - s / 2, y: c.y - h },
    { x: c.x + s / 2, y: c.y - h },
  ];
}

interface Cube {
  x: number;
  y: number;
  z: number;
}

function toCube(gx: number, gy: number): Cube {
  const x = gx;
  const z = gy - (gx - shifted(gx)) / 2;
  return { x, y: -x - z, z };
}

function fromCube(c: Cube): GlobalHex {
  return { gx: c.x, gy: c.z + (c.x - shifted(c.x)) / 2 };
}

/** Distance in parsecs (hexes) between two global hexes. */
export function hexDistance(a: GlobalHex, b: GlobalHex): number {
  const ca = toCube(a.gx, a.gy);
  const cb = toCube(b.gx, b.gy);
  return Math.max(Math.abs(ca.x - cb.x), Math.abs(ca.y - cb.y), Math.abs(ca.z - cb.z));
}

/** The global hex containing a point in world units. */
export function pointToHex(x: number, y: number): GlobalHex {
  // Fractional axial coordinates for flat-topped hexes of size HEX_SIZE.
  const q = x;
  const r = -x / 2 + (Math.sqrt(3) / 2) * y;
  let rx = Math.round(q);
  let rz = Math.round(r);
  let ry = Math.round(-q - r);
  const dx = Math.abs(rx - q);
  const dz = Math.abs(rz - r);
  const dy = Math.abs(ry - (-q - r));
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return fromCube({ x: rx, y: ry, z: rz });
}

const CUBE_DIRS: Cube[] = [
  { x: 1, y: -1, z: 0 },
  { x: 1, y: 0, z: -1 },
  { x: 0, y: 1, z: -1 },
  { x: -1, y: 1, z: 0 },
  { x: -1, y: 0, z: 1 },
  { x: 0, y: -1, z: 1 },
];

export function hexNeighbors(gx: number, gy: number): GlobalHex[] {
  const c = toCube(gx, gy);
  return CUBE_DIRS.map((d) => fromCube({ x: c.x + d.x, y: c.y + d.y, z: c.z + d.z }));
}

/** All hexes within `radius` parsecs of a hex, including the hex itself. */
export function hexesWithin(gx: number, gy: number, radius: number): GlobalHex[] {
  const c = toCube(gx, gy);
  const out: GlobalHex[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = Math.max(-radius, -dx - radius); dy <= Math.min(radius, -dx + radius); dy++) {
      out.push(fromCube({ x: c.x + dx, y: c.y + dy, z: c.z - dx - dy }));
    }
  }
  return out;
}

/** Subsector letter (A–P) for a hex within a sector. */
export function subsectorOf(col: number, row: number): string {
  const sx = Math.floor((col - 1) / SUB_W);
  const sy = Math.floor((row - 1) / SUB_H);
  return SUBSECTOR_LETTERS[sy * 4 + sx];
}

/** Column/row offsets of a subsector's top-left hex (0101 of the subsector) within its sector. */
export function subsectorOrigin(letter: string): { col0: number; row0: number } {
  const i = Math.max(0, SUBSECTOR_LETTERS.indexOf(letter.toUpperCase()));
  return { col0: (i % 4) * SUB_W, row0: Math.floor(i / 4) * SUB_H };
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * World-unit rectangle of a block of hexes, drawn along the grid lines between hexes. Because
 * alternate columns are staggered, the horizontal lines run a quarter row above the first row.
 */
export function hexBlockRect(gx0: number, gy0: number, cols: number, rows: number): Rect {
  return { x0: gx0 - 0.5, x1: gx0 + cols - 0.5, y0: (gy0 - 0.25) * ROW_H, y1: (gy0 + rows - 0.25) * ROW_H };
}

/** World-unit rectangle of a sector, used for frames and fit-to-view. */
export function sectorRect(sectorX: number, sectorY: number): Rect {
  return hexBlockRect(sectorX * SECTOR_W, sectorY * SECTOR_H, SECTOR_W, SECTOR_H);
}

/** World-unit rectangle of a subsector. */
export function subsectorRect(sectorX: number, sectorY: number, letter: string): Rect {
  const { col0, row0 } = subsectorOrigin(letter);
  return hexBlockRect(sectorX * SECTOR_W + col0, sectorY * SECTOR_H + row0, SUB_W, SUB_H);
}

/** Compass-style galactic direction name for a sector offset. */
export function galacticDirection(dx: number, dy: number): string {
  const ns = dy < 0 ? 'Coreward' : dy > 0 ? 'Rimward' : '';
  const ew = dx < 0 ? 'Spinward' : dx > 0 ? 'Trailing' : '';
  return [ns, ew].filter(Boolean).join('-') || 'Here';
}
