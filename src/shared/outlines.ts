/**
 * Hull silhouettes for the shipyard hologram. All are drawn bow-right in a 600 x 300 box.
 *
 * An outline is just SVG path data, so adding your own is a matter of pasting a path (or an
 * .svg file exported from any drawing program) into the outline picker. Holes work as usual:
 * draw the inner loop in the opposite direction to the outer one.
 */
import type { ShipOutline, ShipSpec } from './types';

export interface OutlineDef {
  key: string;
  name: string;
  viewBox: [number, number, number, number];
  d: string;
}

const BOX: [number, number, number, number] = [0, 0, 600, 300];

function circle(cx: number, cy: number, rx: number, ry = rx, clockwise = true): string {
  const sweep = clockwise ? 1 : 0;
  return `M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 ${sweep} ${cx - rx} ${cy} A ${rx} ${ry} 0 1 ${sweep} ${cx + rx} ${cy} Z`;
}

export const OUTLINES: OutlineDef[] = [
  { key: 'wedge', name: 'Wedge', viewBox: BOX, d: 'M 28 34 L 110 46 L 430 112 Q 584 150 430 188 L 110 254 L 28 266 L 62 204 L 44 150 L 62 96 Z' },
  {
    key: 'hauler',
    name: 'Hauler',
    viewBox: BOX,
    d: 'M 36 78 L 150 78 L 172 50 L 404 50 L 446 84 L 524 104 Q 580 150 524 196 L 446 216 L 404 250 L 172 250 L 150 222 L 36 222 L 36 186 L 70 176 L 70 124 L 36 114 Z',
  },
  { key: 'needle', name: 'Needle', viewBox: BOX, d: 'M 36 124 L 66 58 L 124 58 L 152 106 L 430 94 Q 598 150 430 206 L 152 194 L 124 242 L 66 242 L 36 176 L 58 150 Z' },
  {
    key: 'dagger',
    name: 'Dagger',
    viewBox: BOX,
    d: 'M 30 100 L 118 100 L 150 56 L 262 56 L 292 100 L 424 112 L 576 150 L 424 188 L 292 200 L 262 244 L 150 244 L 118 200 L 30 200 L 52 150 Z',
  },
  {
    key: 'ring',
    name: 'Ring',
    viewBox: BOX,
    d: [circle(300, 150, 142), circle(300, 150, 88, 88, false), circle(300, 150, 36), 'M 214 138 L 386 138 L 386 162 L 214 162 Z', 'M 288 64 L 312 64 L 312 236 L 288 236 Z'].join(' '),
  },
  { key: 'sphere', name: 'Sphere', viewBox: BOX, d: circle(300, 150, 150, 140) },
  { key: 'dart', name: 'Dart', viewBox: BOX, d: 'M 60 56 L 204 92 L 336 122 Q 548 150 336 178 L 204 208 L 60 244 L 102 182 L 82 150 L 102 118 Z' },
  { key: 'pod', name: 'Pod', viewBox: BOX, d: 'M 92 78 L 404 78 Q 546 78 546 150 Q 546 222 404 222 L 92 222 L 92 192 L 54 192 L 54 108 L 92 108 Z' },
  {
    key: 'lattice',
    name: 'Lattice',
    viewBox: BOX,
    d: [circle(118, 150, 58), circle(300, 150, 78), circle(482, 150, 58), 'M 60 138 L 540 138 L 540 162 L 60 162 Z', circle(300, 42, 30), circle(300, 258, 30), 'M 290 30 L 310 30 L 310 270 L 290 270 Z'].join(' '),
  },
  { key: 'slab', name: 'Slab', viewBox: BOX, d: 'M 40 60 L 520 60 L 566 106 L 566 194 L 520 240 L 40 240 L 40 196 L 72 186 L 72 114 L 40 104 Z' },
];

export function outlineByKey(key: string | undefined): OutlineDef {
  return OUTLINES.find((o) => o.key === key) ?? OUTLINES[0];
}

/** The outline a design uses when none has been chosen: it follows the hull configuration. */
export function defaultOutlineKey(spec: Pick<ShipSpec, 'hull'>): string {
  const small = spec.hull.tons < 100;
  switch (spec.hull.config) {
    case 'streamlined':
      return small ? 'dart' : 'wedge';
    case 'dispersed':
      return 'lattice';
    case 'sphere':
      return 'sphere';
    default:
      return small ? 'pod' : 'hauler';
  }
}

export function outlineOf(spec: Pick<ShipSpec, 'hull' | 'outline'>): ShipOutline {
  return spec.outline ?? { kind: 'builtin', key: defaultOutlineKey(spec) };
}

const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE,.\s+-]+$/;

/**
 * Reads an outline out of pasted text: either bare path data ("M 0 0 L ...") or the source of an
 * SVG file, from which every <path d="..."> is taken along with the viewBox.
 */
export function parseOutlineText(text: string, name?: string): { outline?: Extract<ShipOutline, { kind: 'path' }>; error?: string } {
  const source = text.trim();
  if (!source) return { error: 'Paste SVG path data or the contents of an SVG file.' };
  let d = '';
  let viewBox: [number, number, number, number] | undefined;
  if (source.includes('<')) {
    const paths = [...source.matchAll(/<path\b[^>]*?\sd\s*=\s*(["'])([\s\S]*?)\1/gi)].map((m) => m[2].trim());
    if (paths.length === 0) return { error: 'No <path> elements found. Convert shapes to paths before exporting.' };
    d = paths.join(' ');
    const vb = /viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)\s*["']/i.exec(source);
    if (vb) viewBox = [Number(vb[1]), Number(vb[2]), Number(vb[3]), Number(vb[4])];
    else {
      const w = /<svg\b[^>]*?\swidth\s*=\s*["']\s*([\d.]+)/i.exec(source);
      const h = /<svg\b[^>]*?\sheight\s*=\s*["']\s*([\d.]+)/i.exec(source);
      if (w && h) viewBox = [0, 0, Number(w[1]), Number(h[1])];
    }
  } else {
    d = source;
  }
  d = d.replace(/\s+/g, ' ');
  if (!PATH_DATA.test(d) || !/^[Mm]/.test(d)) return { error: 'That is not SVG path data. It should start with M and contain only path commands and numbers.' };
  if (d.length > 20_000) return { error: 'That outline is too detailed (over 20,000 characters). Simplify the path first.' };
  if (!viewBox || viewBox.some((n) => !Number.isFinite(n)) || viewBox[2] <= 0 || viewBox[3] <= 0) viewBox = pathBounds(d);
  if (!viewBox) return { error: 'Could not work out the size of the outline. Add a viewBox.' };
  return { outline: { kind: 'path', d, viewBox, ...(name ? { name } : {}) } };
}

/** Rough bounds of path data from its absolute coordinates, for outlines pasted without a viewBox. */
export function pathBounds(d: string): [number, number, number, number] | undefined {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (!tokens) return undefined;
  let cmd = '';
  let nums: number[] = [];
  let x = 0;
  let y = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const mark = (px: number, py: number) => {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  };
  const flush = () => {
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();
    const size = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7 }[c];
    if (!size) return;
    for (let i = 0; i + size <= nums.length; i += size) {
      const n = nums.slice(i, i + size);
      if (c === 'H') x = rel ? x + n[0] : n[0];
      else if (c === 'V') y = rel ? y + n[0] : n[0];
      else if (c === 'A') {
        const nx = rel ? x + n[5] : n[5];
        const ny = rel ? y + n[6] : n[6];
        // An arc can bulge beyond its end points by up to its radii.
        mark(Math.min(x, nx) - n[0], Math.min(y, ny) - n[1]);
        mark(Math.max(x, nx) + n[0], Math.max(y, ny) + n[1]);
        x = nx;
        y = ny;
      } else {
        for (let k = 0; k + 1 < n.length; k += 2) mark(rel ? x + n[k] : n[k], rel ? y + n[k + 1] : n[k + 1]);
        const nx = n[n.length - 2];
        const ny = n[n.length - 1];
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
      }
      mark(x, y);
    }
  };
  for (const t of tokens) {
    if (/[a-zA-Z]/.test(t)) {
      flush();
      cmd = t;
      nums = [];
    } else {
      nums.push(Number(t));
    }
  }
  flush();
  if (!Number.isFinite(minX) || maxX - minX <= 0 || maxY - minY <= 0) return undefined;
  const pad = Math.max(maxX - minX, maxY - minY) * 0.04;
  return [Math.floor(minX - pad), Math.floor(minY - pad), Math.ceil(maxX - minX + pad * 2), Math.ceil(maxY - minY + pad * 2)];
}
