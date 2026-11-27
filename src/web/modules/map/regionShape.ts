/**
 * The outline of a painted region, worked out once and kept: a region can cover tens of
 * thousands of hexes, far too many to examine one by one on every frame.
 */
import { HEX_SIZE, ROW_H, hexCenter, parseGlobalKey } from '../../../shared/hex';

export interface RegionShape {
  /** Unbroken vertical stretches of hexes, three numbers each: column, first row, last row. */
  runs: Int32Array;
  /** The edges that face a hex outside the region, four numbers each: x1, y1, x2, y2 in world units. */
  edges: Float32Array;
  /** World-unit box around the whole region, for skipping one that is off screen. */
  box: { x0: number; y0: number; x1: number; y1: number };
}

/** One number per hex, so that membership tests need no strings. */
const cell = (gx: number, gy: number): number => (gx + 100_000) * 1_000_000 + (gy + 100_000);

export function regionShape(hexes: readonly string[]): RegionShape {
  const columns = new Map<number, number[]>();
  const members = new Set<number>();
  for (const key of hexes) {
    const { gx, gy } = parseGlobalKey(key);
    if (!Number.isInteger(gx) || !Number.isInteger(gy) || members.has(cell(gx, gy))) continue;
    members.add(cell(gx, gy));
    const column = columns.get(gx);
    if (column) column.push(gy);
    else columns.set(gx, [gy]);
  }

  const runs: number[] = [];
  const edges: number[] = [];
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const s = HEX_SIZE;
  const h = ROW_H / 2;
  for (const [gx, rows] of columns) {
    rows.sort((a, b) => a - b);
    let start = rows[0];
    for (let i = 0; i < rows.length; i++) {
      const gy = rows[i];
      if (i + 1 === rows.length || rows[i + 1] !== gy + 1) {
        runs.push(gx, start, gy);
        start = rows[i + 1];
      }
      const c = hexCenter(gx, gy);
      box.x0 = Math.min(box.x0, c.x - s);
      box.x1 = Math.max(box.x1, c.x + s);
      box.y0 = Math.min(box.y0, c.y - h);
      box.y1 = Math.max(box.y1, c.y + h);
      // Corners clockwise from the right-hand one, and the neighbour across the edge that follows each.
      const corners = [c.x + s, c.y, c.x + s / 2, c.y + h, c.x - s / 2, c.y + h, c.x - s, c.y, c.x - s / 2, c.y - h, c.x + s / 2, c.y - h];
      const shift = gx & 1;
      const across = [gx + 1, gy + shift, gx, gy + 1, gx - 1, gy + shift, gx - 1, gy + shift - 1, gx, gy - 1, gx + 1, gy + shift - 1];
      for (let e = 0; e < 6; e++) {
        if (members.has(cell(across[e * 2], across[e * 2 + 1]))) continue;
        const n = (e + 1) % 6;
        edges.push(corners[e * 2], corners[e * 2 + 1], corners[n * 2], corners[n * 2 + 1]);
      }
    }
  }
  return { runs: Int32Array.from(runs), edges: Float32Array.from(edges), box };
}

const cache = new WeakMap<readonly string[], RegionShape>();

/** The shape for a region's list of hexes. The list is replaced whenever the region changes, so it is the key. */
export function shapeOf(hexes: readonly string[]): RegionShape {
  let shape = cache.get(hexes);
  if (!shape) cache.set(hexes, (shape = regionShape(hexes)));
  return shape;
}
