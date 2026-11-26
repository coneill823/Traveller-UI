/**
 * Lays a design out on its hull outline. The outline is rasterised into a grid of cells; each
 * part with tonnage takes a run of cells in proportion, from bow to stern, and whatever is left
 * is the cargo hold. Any silhouette works: a built-in one, pasted SVG path data, or an image.
 */
import { outlineByKey, outlineOf } from '../../../shared/outlines';
import { CARGO_RANK, rankOf, type PartLine } from '../../../shared/rules/ship';
import type { ShipOutline, ShipSpec } from '../../../shared/types';

export interface HullGrid {
  viewBox: [number, number, number, number];
  /** Edge length of a cell in view box units. */
  size: number;
  cols: number;
  rows: number;
  /** Cell indices (col * rows + row) inside the hull, ordered from bow (right) to stern. */
  order: number[];
  /** Path data for the silhouette, when it has one. */
  d?: string;
  imageUrl?: string;
}

const COLS = 64;
const cache = new Map<string, HullGrid>();

function build(viewBox: [number, number, number, number], inside: (cx: number, cy: number) => boolean, extra: Partial<HullGrid>): HullGrid {
  const [x0, y0, w, h] = viewBox;
  const size = w / COLS;
  const rows = Math.max(1, Math.ceil(h / size));
  const order: number[] = [];
  for (let step = 0; step < COLS; step++) {
    const col = COLS - 1 - step;
    for (let i = 0; i < rows; i++) {
      // Serpentine, so that a run of cells stays in one piece when it wraps to the next column.
      const row = step % 2 === 0 ? i : rows - 1 - i;
      if (inside(x0 + (col + 0.5) * size, y0 + (row + 0.5) * size)) order.push(col * rows + row);
    }
  }
  return { viewBox, size, cols: COLS, rows, order, ...extra };
}

export function gridForPath(d: string, viewBox: [number, number, number, number]): HullGrid {
  const key = `p:${viewBox.join(',')}:${d}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let grid: HullGrid;
  try {
    const ctx = document.createElement('canvas').getContext('2d')!;
    const path = new Path2D(d);
    grid = build(viewBox, (x, y) => ctx.isPointInPath(path, x, y), { d });
  } catch {
    grid = build(viewBox, () => false, { d });
  }
  cache.set(key, grid);
  return grid;
}

/** An image outline: opaque pixels are hull, or dark pixels when the image has no transparency. */
export function gridForImage(url: string): Promise<HullGrid> {
  const key = `i:${url}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 600;
      const h = img.naturalHeight || 300;
      const rows = Math.max(1, Math.ceil(h / (w / COLS)));
      const canvas = document.createElement('canvas');
      canvas.width = COLS;
      canvas.height = rows;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, COLS, (h / w) * COLS);
      const px = ctx.getImageData(0, 0, COLS, rows).data;
      let transparent = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] < 128) transparent++;
      const useAlpha = transparent > px.length / 4 / 50;
      const size = w / COLS;
      const grid = build(
        [0, 0, w, h],
        (cx, cy) => {
          const i = (Math.min(rows - 1, Math.floor(cy / size)) * COLS + Math.min(COLS - 1, Math.floor(cx / size))) * 4;
          if (useAlpha) return px[i + 3] >= 128;
          return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] < 128;
        },
        { imageUrl: url },
      );
      cache.set(key, grid);
      resolve(grid);
    };
    img.onerror = () => reject(new Error('The outline image could not be loaded'));
    img.src = url;
  });
}

export function gridKey(outline: ShipOutline): string {
  return outline.kind === 'builtin' ? `b:${outline.key}` : outline.kind === 'path' ? `p:${outline.viewBox.join(',')}:${outline.d}` : `i:${outline.url}`;
}

/** The grid for an outline if it can be had without waiting (everything except images not yet loaded). */
export function gridNow(outline: ShipOutline): HullGrid | undefined {
  if (outline.kind === 'builtin') {
    const def = outlineByKey(outline.key);
    return gridForPath(def.d, def.viewBox);
  }
  if (outline.kind === 'path') return gridForPath(outline.d, outline.viewBox);
  return cache.get(`i:${outline.url}`);
}

// ───────────────────────────── order along the hull ─────────────────────────────

export const CARGO = 'cargo';

/** Index in `spec.parts` at which the cargo hold is drawn. */
export function cargoIndex(spec: ShipSpec, lines: PartLine[]): number {
  if (spec.cargoAt !== undefined) return Math.max(0, Math.min(spec.parts.length, spec.cargoAt));
  const byId = new Map(lines.map((l) => [l.partId, l]));
  const at = spec.parts.findIndex((p) => {
    const line = byId.get(p.id);
    return line ? rankOf(line) > CARGO_RANK : false;
  });
  return at === -1 ? spec.parts.length : at;
}

/** Where a new part of this rank should go so the plan stays tidy. */
export function insertIndex(spec: ShipSpec, lines: PartLine[], rank: number): number {
  const byId = new Map(lines.map((l) => [l.partId, l]));
  const at = spec.parts.findIndex((p) => {
    const line = byId.get(p.id);
    return line ? rankOf(line) > rank : false;
  });
  return at === -1 ? spec.parts.length : at;
}

/** Part ids in hull order with the cargo hold in its place. */
export function hullOrder(spec: ShipSpec, lines: PartLine[]): string[] {
  const ids = spec.parts.map((p) => p.id);
  ids.splice(cargoIndex(spec, lines), 0, CARGO);
  return ids;
}

/** Moves `id` (a part or the cargo hold) to sit just before `beforeId`, or to the stern when that is undefined. */
export function moveInOrder(spec: ShipSpec, lines: PartLine[], id: string, beforeId: string | undefined): Pick<ShipSpec, 'parts' | 'cargoAt'> {
  const order = hullOrder(spec, lines).filter((x) => x !== id);
  const at = beforeId === undefined ? -1 : order.indexOf(beforeId);
  if (at === -1) order.push(id);
  else order.splice(at, 0, id);
  const byId = new Map(spec.parts.map((p) => [p.id, p]));
  return { parts: order.filter((x) => x !== CARGO).map((x) => byId.get(x)!), cargoAt: order.indexOf(CARGO) };
}

// ───────────────────────────── cells ─────────────────────────────

export interface Block {
  id: string;
  cells: number[];
  tons: number;
}

export interface Allocation {
  blocks: Block[];
  /** Cell index -> block id. */
  owner: Map<number, string>;
  /** Parts that did not get any room because the hull is full. */
  overflow: string[];
}

export function allocate(grid: HullGrid, hullTons: number, slots: { id: string; tons: number }[]): Allocation {
  const total = grid.order.length;
  const owner = new Map<number, string>();
  const blocks: Block[] = [];
  const overflow: string[] = [];
  if (total === 0 || hullTons <= 0) return { blocks, owner, overflow: slots.map((s) => s.id) };
  const perCell = hullTons / total;
  let cursor = 0;
  let cumulative = 0;
  for (const slot of slots) {
    if (slot.tons <= 0) continue;
    cumulative += slot.tons;
    // Every part shows up, however small; the running total keeps the rest in proportion.
    const end = Math.max(cursor + 1, Math.round(cumulative / perCell));
    const cells = grid.order.slice(cursor, Math.min(end, total));
    if (cells.length === 0) {
      overflow.push(slot.id);
      continue;
    }
    for (const c of cells) owner.set(c, slot.id);
    blocks.push({ id: slot.id, cells, tons: slot.tons });
    cursor = Math.min(end, total);
  }
  return { blocks, owner, overflow };
}

export function cellXY(grid: HullGrid, index: number): { x: number; y: number } {
  const col = Math.floor(index / grid.rows);
  const row = index % grid.rows;
  return { x: grid.viewBox[0] + col * grid.size, y: grid.viewBox[1] + row * grid.size };
}

export function cellAt(grid: HullGrid, x: number, y: number): number | undefined {
  const col = Math.floor((x - grid.viewBox[0]) / grid.size);
  const row = Math.floor((y - grid.viewBox[1]) / grid.size);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return undefined;
  return col * grid.rows + row;
}

/** Path data filling a block's cells, each inset a little so the grid shows through. */
export function cellsPath(grid: HullGrid, cells: number[], inset: number): string {
  const s = grid.size - inset * 2;
  let d = '';
  for (const c of cells) {
    const { x, y } = cellXY(grid, c);
    d += `M${r(x + inset)} ${r(y + inset)}h${r(s)}v${r(s)}h${r(-s)}Z`;
  }
  return d;
}

/** Path data for the edges where a cell meets a cell that `differs`. */
export function edgesPath(grid: HullGrid, cells: number[], differs: (neighbour: number | undefined) => boolean): string {
  const { rows, cols, size } = grid;
  let d = '';
  for (const c of cells) {
    const col = Math.floor(c / rows);
    const row = c % rows;
    const { x, y } = cellXY(grid, c);
    if (differs(row > 0 ? c - 1 : undefined)) d += `M${r(x)} ${r(y)}h${r(size)}`;
    if (differs(row < rows - 1 ? c + 1 : undefined)) d += `M${r(x)} ${r(y + size)}h${r(size)}`;
    if (differs(col > 0 ? c - rows : undefined)) d += `M${r(x)} ${r(y)}v${r(size)}`;
    if (differs(col < cols - 1 ? c + rows : undefined)) d += `M${r(x + size)} ${r(y)}v${r(size)}`;
  }
  return d;
}

export function blockBox(grid: HullGrid, cells: number[]): { cx: number; cy: number; x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let sx = 0;
  let sy = 0;
  for (const c of cells) {
    const { x, y } = cellXY(grid, c);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + grid.size);
    maxY = Math.max(maxY, y + grid.size);
    sx += x + grid.size / 2;
    sy += y + grid.size / 2;
  }
  return { cx: sx / cells.length, cy: sy / cells.length, x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The widest horizontal run of a block's cells: where a label has the most room. */
export function labelSpot(grid: HullGrid, cells: number[]): { x: number; y: number; width: number } {
  const byRow = new Map<number, number[]>();
  for (const c of cells) {
    const row = c % grid.rows;
    const list = byRow.get(row);
    if (list) list.push(Math.floor(c / grid.rows));
    else byRow.set(row, [Math.floor(c / grid.rows)]);
  }
  const box = blockBox(grid, cells);
  let best = { x: box.cx, y: box.cy, width: 0, score: -Infinity };
  for (const [row, colsInRow] of byRow) {
    colsInRow.sort((a, b) => a - b);
    let start = colsInRow[0];
    let prev = colsInRow[0];
    const close = (end: number) => {
      const width = (end - start + 1) * grid.size;
      const y = grid.viewBox[1] + (row + 0.5) * grid.size;
      // Prefer long runs near the block's vertical middle.
      const score = width - Math.abs(y - box.cy) * 0.6;
      if (score > best.score) best = { x: grid.viewBox[0] + ((start + end + 1) / 2) * grid.size, y, width, score };
    };
    for (let i = 1; i < colsInRow.length; i++) {
      if (colsInRow[i] !== prev + 1) {
        close(prev);
        start = colsInRow[i];
      }
      prev = colsInRow[i];
    }
    close(prev);
  }
  return best;
}

function r(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export { outlineOf, rankOf };
