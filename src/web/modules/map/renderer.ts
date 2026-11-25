/**
 * Canvas renderer for the star map, in the classic Traveller style: black field, hex grid,
 * hex numbers, starport class above the world, name below, with travel zones and routes.
 *
 * Two layers are drawn separately. The base layer (grid, worlds, routes) only changes when the
 * view or the data changes. The overlay (hover, selection, planned route, party marker) changes
 * as the pointer moves, so it is kept cheap.
 */
import { HEX_SIZE, ROW_H, SECTOR_H, SECTOR_W, SUBSECTOR_LETTERS, SUB_H, SUB_W, hexCenter, hexesWithin, parseGlobalKey, sectorRect, subsectorRect, type GlobalHex } from '../../../shared/hex';
import type { Id } from '../../../shared/types';
import type { MapData, SysInfo } from './mapData';
import { LOD, type Layers, type MapView } from './mapStore';

export interface Viewport extends MapView {
  w: number;
  h: number;
}

const C = {
  bg: '#03060b',
  sectorLine: '#3a516f',
  sectorName: 'rgba(147, 167, 189, 0.5)',
  subLine: '#1e2c40',
  subName: 'rgba(147, 167, 189, 0.32)',
  grid: '#1a2738',
  hexNumber: '#4b607a',
  text: '#dce8f5',
  textDim: '#93a7bd',
  accent: '#4de3ff',
  gm: '#c77dff',
  amber: '#ffb347',
  red: '#ff5c6c',
  comm: '#3fd68f',
  trade: '#ffb347',
  custom: '#dce8f5',
  capital: '#ff8f8f',
};

const FONT_DISPLAY = "'Orbitron', sans-serif";
const FONT_BODY = "'IBM Plex Sans', sans-serif";
const FONT_MONO = "'IBM Plex Mono', monospace";

export function toScreen(v: Viewport, x: number, y: number): { x: number; y: number } {
  return { x: (x - v.cx) * v.scale + v.w / 2, y: (y - v.cy) * v.scale + v.h / 2 };
}

export function toWorld(v: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - v.w / 2) / v.scale + v.cx, y: (sy - v.h / 2) / v.scale + v.cy };
}

/** Range of global hexes that might be visible, padded by one. */
function visibleHexes(v: Viewport): { gx0: number; gx1: number; gy0: number; gy1: number } {
  const a = toWorld(v, 0, 0);
  const b = toWorld(v, v.w, v.h);
  return { gx0: Math.floor(a.x) - 1, gx1: Math.ceil(b.x) + 1, gy0: Math.floor(a.y / ROW_H) - 1, gy1: Math.ceil(b.y / ROW_H) + 1 };
}

function hexPath(ctx: CanvasRenderingContext2D, px: number, py: number, scale: number, inset = 0): void {
  const s = HEX_SIZE * scale - inset;
  const h = (ROW_H * scale) / 2 - inset * 0.866;
  ctx.beginPath();
  ctx.moveTo(px + s, py);
  ctx.lineTo(px + s / 2, py + h);
  ctx.lineTo(px - s / 2, py + h);
  ctx.lineTo(px - s, py);
  ctx.lineTo(px - s / 2, py - h);
  ctx.lineTo(px + s / 2, py - h);
  ctx.closePath();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 2 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ───────────────────────────── base layer ─────────────────────────────

export interface BaseOptions {
  gm: boolean;
  layers: Layers;
  /** Empty sector positions the GM can click to add a sector. */
  ghostSlots: { x: number; y: number }[];
}

export function drawBase(ctx: CanvasRenderingContext2D, v: Viewport, data: MapData, opts: BaseOptions): void {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, v.w, v.h);
  const vis = visibleHexes(v);
  const scale = v.scale;

  if (opts.layers.regions) drawRegions(ctx, v, data);

  // Hex grid, inside sectors only.
  if (opts.layers.grid && scale >= LOD.grid) {
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.globalAlpha = clamp((scale - LOD.grid) / 14 + 0.3, 0.3, 1);
    const s = HEX_SIZE * scale;
    const h = (ROW_H * scale) / 2;
    ctx.beginPath();
    for (const sector of data.sectors) {
      const gx0 = Math.max(vis.gx0, sector.x * SECTOR_W);
      const gx1 = Math.min(vis.gx1, sector.x * SECTOR_W + SECTOR_W - 1);
      const gy0 = Math.max(vis.gy0, sector.y * SECTOR_H);
      const gy1 = Math.min(vis.gy1, sector.y * SECTOR_H + SECTOR_H - 1);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const c = hexCenter(gx, gy);
          const p = toScreen(v, c.x, c.y);
          ctx.moveTo(p.x + s, p.y);
          ctx.lineTo(p.x + s / 2, p.y + h);
          ctx.lineTo(p.x - s / 2, p.y + h);
          ctx.lineTo(p.x - s, p.y);
          ctx.lineTo(p.x - s / 2, p.y - h);
          ctx.lineTo(p.x + s / 2, p.y - h);
          ctx.lineTo(p.x + s, p.y);
        }
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Hex numbers in every hex, as on printed maps.
  if (scale >= LOD.detail + 4) {
    ctx.fillStyle = C.hexNumber;
    ctx.font = `${clamp(scale * 0.15, 8, 12)}px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const dy = ROW_H * scale * 0.37;
    for (const sector of data.sectors) {
      const gx0 = Math.max(vis.gx0, sector.x * SECTOR_W);
      const gx1 = Math.min(vis.gx1, sector.x * SECTOR_W + SECTOR_W - 1);
      const gy0 = Math.max(vis.gy0, sector.y * SECTOR_H);
      const gy1 = Math.min(vis.gy1, sector.y * SECTOR_H + SECTOR_H - 1);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const c = hexCenter(gx, gy);
          const p = toScreen(v, c.x, c.y);
          const col = gx - sector.x * SECTOR_W + 1;
          const row = gy - sector.y * SECTOR_H + 1;
          ctx.fillText(`${String(col).padStart(2, '0')}${String(row).padStart(2, '0')}`, p.x, p.y - dy);
        }
      }
    }
  }

  drawSectorFrames(ctx, v, data, opts);
  if (opts.layers.routes) drawRoutes(ctx, v, data);

  // Worlds.
  for (const info of data.systems) {
    if (info.gx < vis.gx0 || info.gx > vis.gx1 || info.gy < vis.gy0 || info.gy > vis.gy1) continue;
    const p = toScreen(v, info.x, info.y);
    if (scale >= LOD.detail) drawWorldDetail(ctx, p.x, p.y, scale, info, opts);
    else drawWorldDot(ctx, p.x, p.y, scale, info, opts);
  }
}

function drawSectorFrames(ctx: CanvasRenderingContext2D, v: Viewport, data: MapData, opts: BaseOptions): void {
  const scale = v.scale;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const sector of data.sectors) {
    const r = sectorRect(sector.x, sector.y);
    const a = toScreen(v, r.x0, r.y0);
    const b = toScreen(v, r.x1, r.y1);
    if (b.x < 0 || b.y < 0 || a.x > v.w || a.y > v.h) continue;

    // Subsector grid and names.
    if (scale >= LOD.sector) {
      ctx.strokeStyle = C.subLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < 4; i++) {
        const x = a.x + ((b.x - a.x) * i) / 4;
        const y = a.y + ((b.y - a.y) * i) / 4;
        ctx.moveTo(x, a.y);
        ctx.lineTo(x, b.y);
        ctx.moveTo(a.x, y);
        ctx.lineTo(b.x, y);
      }
      ctx.stroke();
      // Names fade out once individual hexes take over.
      const alpha = scale < LOD.detail ? 1 : clamp(1 - (scale - LOD.detail) / 30, 0.25, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = C.subName;
      const size = clamp(scale * 0.7, 9, 30);
      for (let i = 0; i < 16; i++) {
        const letter = SUBSECTOR_LETTERS[i];
        const sr = subsectorRect(sector.x, sector.y, letter);
        const c = toScreen(v, (sr.x0 + sr.x1) / 2, (sr.y0 + sr.y1) / 2);
        if (c.x < -200 || c.y < -100 || c.x > v.w + 200 || c.y > v.h + 100) continue;
        const name = sector.subsectors[letter];
        ctx.font = `600 ${size}px ${FONT_DISPLAY}`;
        const width = SUB_W * scale * 0.9;
        ctx.fillText(fitText(ctx, (name ?? `Subsector ${letter}`).toUpperCase(), width), c.x, c.y);
        if (name && scale >= 6) {
          ctx.font = `${size * 0.5}px ${FONT_DISPLAY}`;
          ctx.fillText(`SUBSECTOR ${letter}`, c.x, c.y + size * 0.95);
        }
      }
      ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = C.sectorLine;
    ctx.lineWidth = scale < LOD.sector ? 1 : 1.5;
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));

    // Sector name: large at universe zoom, a caption along the top edge when closer.
    if (scale < LOD.sector) {
      ctx.fillStyle = C.textDim;
      ctx.font = `600 ${clamp((b.x - a.x) * 0.085, 8, 22)}px ${FONT_DISPLAY}`;
      ctx.fillText(fitText(ctx, sector.name.toUpperCase(), (b.x - a.x) * 0.92), (a.x + b.x) / 2, (a.y + b.y) / 2);
    } else if (a.y > 52 && a.y < v.h) {
      // A caption above the frame, when the top edge is on screen and clear of the breadcrumbs.
      ctx.fillStyle = C.sectorName;
      ctx.font = `600 ${clamp(scale * 0.9, 10, 16)}px ${FONT_DISPLAY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(sector.name.toUpperCase(), clamp(a.x, 8, v.w - 200) + 2, a.y - 4);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    }
  }

  // Places where the GM can append a new sector.
  if (opts.gm && scale < LOD.sector) {
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(199, 125, 255, 0.4)';
    ctx.fillStyle = 'rgba(199, 125, 255, 0.55)';
    ctx.lineWidth = 1;
    for (const slot of opts.ghostSlots) {
      const r = sectorRect(slot.x, slot.y);
      const a = toScreen(v, r.x0, r.y0);
      const b = toScreen(v, r.x1, r.y1);
      if (b.x < 0 || b.y < 0 || a.x > v.w || a.y > v.h) continue;
      ctx.strokeRect(Math.round(a.x) + 4.5, Math.round(a.y) + 4.5, Math.round(b.x - a.x) - 8, Math.round(b.y - a.y) - 8);
      const size = clamp((b.x - a.x) * 0.3, 14, 44);
      ctx.font = `300 ${size}px ${FONT_BODY}`;
      ctx.fillText('+', (a.x + b.x) / 2, (a.y + b.y) / 2);
      if (b.x - a.x > 70) {
        ctx.font = `${clamp((b.x - a.x) * 0.07, 8, 11)}px ${FONT_DISPLAY}`;
        ctx.fillText('ADD SECTOR', (a.x + b.x) / 2, (a.y + b.y) / 2 + size * 0.7);
      }
    }
    ctx.setLineDash([]);
  }
}

function drawRegions(ctx: CanvasRenderingContext2D, v: Viewport, data: MapData): void {
  if (v.scale < 2) return;
  for (const region of data.regions) {
    if (region.hexes.length === 0) continue;
    const members = new Set(region.hexes);
    ctx.fillStyle = region.color;
    ctx.globalAlpha = 0.1;
    for (const key of region.hexes) {
      const { gx, gy } = parseGlobalKey(key);
      const c = hexCenter(gx, gy);
      const p = toScreen(v, c.x, c.y);
      if (p.x < -v.scale || p.y < -v.scale || p.x > v.w + v.scale || p.y > v.h + v.scale) continue;
      hexPath(ctx, p.x, p.y, v.scale, -0.5);
      ctx.fill();
    }
    // Border: every hex edge that faces a hex outside the region.
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = region.color;
    ctx.lineWidth = clamp(v.scale * 0.06, 1, 3);
    const s = HEX_SIZE * v.scale;
    const h = (ROW_H * v.scale) / 2;
    ctx.beginPath();
    for (const key of region.hexes) {
      const { gx, gy } = parseGlobalKey(key);
      const c = hexCenter(gx, gy);
      const p = toScreen(v, c.x, c.y);
      if (p.x < -v.scale || p.y < -v.scale || p.x > v.w + v.scale || p.y > v.h + v.scale) continue;
      const corners = [
        [p.x + s, p.y],
        [p.x + s / 2, p.y + h],
        [p.x - s / 2, p.y + h],
        [p.x - s, p.y],
        [p.x - s / 2, p.y - h],
        [p.x + s / 2, p.y - h],
      ];
      // Neighbours in the same order as the edges between consecutive corners.
      const shift = gx & 1;
      const neighbours: [number, number][] = [
        [gx + 1, gy + shift],
        [gx, gy + 1],
        [gx - 1, gy + shift],
        [gx - 1, gy + shift - 1],
        [gx, gy - 1],
        [gx + 1, gy + shift - 1],
      ];
      for (let i = 0; i < 6; i++) {
        if (members.has(`${neighbours[i][0]},${neighbours[i][1]}`)) continue;
        const a = corners[i];
        const b = corners[(i + 1) % 6];
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawRoutes(ctx: CanvasRenderingContext2D, v: Viewport, data: MapData): void {
  if (v.scale < 1.5) return;
  ctx.lineCap = 'round';
  for (const { route, a, b } of data.routes) {
    const p = toScreen(v, a.x, a.y);
    const q = toScreen(v, b.x, b.y);
    if (Math.max(p.x, q.x) < 0 || Math.max(p.y, q.y) < 0 || Math.min(p.x, q.x) > v.w || Math.min(p.y, q.y) > v.h) continue;
    ctx.strokeStyle = route.kind === 'trade' ? C.trade : route.kind === 'custom' ? C.custom : C.comm;
    ctx.globalAlpha = route.kind === 'trade' ? 0.55 : 0.7;
    ctx.lineWidth = clamp(v.scale * 0.07, 1, 4);
    ctx.setLineDash(route.kind === 'trade' ? [v.scale * 0.25, v.scale * 0.2] : route.kind === 'custom' ? [2, 5] : []);
    // Stop short of the world glyphs so the lines do not run through them.
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    const gap = v.scale >= LOD.subsector ? Math.min(v.scale * 0.22, len * 0.3) : 0;
    const ux = (q.x - p.x) / len;
    const uy = (q.y - p.y) / len;
    ctx.beginPath();
    ctx.moveTo(p.x + ux * gap, p.y + uy * gap);
    ctx.lineTo(q.x - ux * gap, q.y - uy * gap);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function zoneColor(zone: string | undefined): string | undefined {
  return zone === 'A' ? C.amber : zone === 'R' ? C.red : undefined;
}

function drawGlyph(ctx: CanvasRenderingContext2D, px: number, py: number, r: number, info: SysInfo): void {
  if (info.glyph === 'unknown') {
    // Something is here, but it has not been surveyed.
    ctx.strokeStyle = info.color;
    ctx.lineWidth = Math.max(1, r * 0.22);
    ctx.setLineDash([r * 0.5, r * 0.45]);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  ctx.fillStyle = info.color;
  if (info.glyph === 'belt') {
    const d = r * 0.42;
    for (const [dx, dy] of [
      [-0.9, -0.3],
      [0, -0.75],
      [0.9, -0.2],
      [-0.45, 0.55],
      [0.5, 0.65],
      [0.05, 0.05],
    ]) {
      ctx.beginPath();
      ctx.arc(px + dx * r, py + dy * r, d, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  // A soft highlight so worlds read as spheres.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.beginPath();
  ctx.arc(px - r * 0.3, py - r * 0.3, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
}

/** Mid-zoom: a coloured dot, with a name once there is room. */
function drawWorldDot(ctx: CanvasRenderingContext2D, px: number, py: number, scale: number, info: SysInfo, opts: BaseOptions): void {
  const r = clamp(scale * 0.14, 1, 4.5);
  if (scale < LOD.sector) {
    ctx.fillStyle = info.glyph === 'unknown' ? C.textDim : info.color;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(px - 0.75, py - 0.75, 1.5, 1.5);
    ctx.globalAlpha = 1;
    return;
  }
  const zone = zoneColor(info.sys.zone);
  if (zone) {
    ctx.strokeStyle = zone;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(px, py, r + 2.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (info.glyph === 'unknown' || info.glyph === 'belt') drawGlyph(ctx, px, py, r, info);
  else {
    ctx.fillStyle = info.color;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
  if (opts.gm && opts.layers.knowledge && info.party !== 'charted') {
    // A faint violet ring: not (fully) known to the party.
    ctx.strokeStyle = C.gm;
    ctx.globalAlpha = info.party === 'hidden' ? 0.55 : 0.85;
    ctx.lineWidth = 1;
    ctx.setLineDash(info.party === 'hidden' ? [] : [2, 2]);
    ctx.beginPath();
    ctx.arc(px, py, r + (zone ? 4.5 : 2.2), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  if (opts.layers.names && scale >= LOD.names && info.sys.name) {
    ctx.font = `${info.highPop ? '600 ' : ''}${clamp(scale * 0.42, 8, 11)}px ${FONT_BODY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = C.textDim;
    const name = info.highPop ? info.sys.name.toUpperCase() : info.sys.name;
    ctx.fillText(fitText(ctx, name, scale * 1.25), px, py + r + 2);
  }
}

/** Close zoom: the full classic hex. */
function drawWorldDetail(ctx: CanvasRenderingContext2D, px: number, py: number, scale: number, info: SysInfo, opts: BaseOptions): void {
  const H = ROW_H * scale;
  const zone = zoneColor(info.sys.zone);
  if (zone) {
    ctx.strokeStyle = zone;
    ctx.lineWidth = clamp(scale * 0.045, 1.5, 3.5);
    hexPath(ctx, px, py, scale, ctx.lineWidth / 2 + 1);
    ctx.stroke();
  }
  if (opts.gm && opts.layers.knowledge && info.party !== 'charted') {
    // A violet wedge in the left corner marks what the party does not (fully) know:
    // solid when the system is hidden from them, hollow when they know only part of it.
    const s = HEX_SIZE * scale;
    const w = clamp(scale * 0.2, 6, 13);
    ctx.beginPath();
    ctx.moveTo(px - s + 2.5, py);
    ctx.lineTo(px - s + 2.5 + w * 0.5, py - w * 0.866);
    ctx.lineTo(px - s + 2.5 + w, py);
    ctx.lineTo(px - s + 2.5 + w * 0.5, py + w * 0.866);
    ctx.closePath();
    if (info.party === 'hidden') {
      ctx.fillStyle = C.gm;
      ctx.fill();
    } else {
      ctx.strokeStyle = C.gm;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const discY = py + H * 0.02;
  const r = clamp(scale * 0.115, 3, 10);
  drawGlyph(ctx, px, discY, r, info);

  // Starport class sits above the world.
  if (info.uwp) {
    ctx.fillStyle = C.text;
    ctx.font = `600 ${clamp(scale * 0.2, 8, 15)}px ${FONT_DISPLAY}`;
    ctx.fillText(info.uwp.starport, px, py - H * 0.17);
  } else if (info.glyph === 'unknown') {
    ctx.fillStyle = C.textDim;
    ctx.font = `600 ${clamp(scale * 0.2, 8, 15)}px ${FONT_DISPLAY}`;
    ctx.fillText('?', px, py - H * 0.17);
  }

  // Bases to the left of the world.
  if (info.sys.bases) {
    ctx.fillStyle = C.textDim;
    ctx.font = `${clamp(scale * 0.14, 7, 11)}px ${FONT_MONO}`;
    ctx.textAlign = 'right';
    ctx.fillText(info.sys.bases, px - r - scale * 0.07, discY);
    ctx.textAlign = 'center';
  }

  // Gas giant marker: a small ringed dot to the upper right.
  if (info.gasGiants > 0) {
    const gx = px + scale * 0.32;
    const gy = py - H * 0.17;
    const gr = clamp(scale * 0.045, 1.5, 4);
    ctx.fillStyle = C.textDim;
    ctx.beginPath();
    ctx.arc(gx, gy, gr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = C.textDim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(gx, gy, gr * 2, gr * 0.7, -0.35, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (opts.layers.names) {
    const name = info.sys.name;
    if (name) {
      ctx.fillStyle = /\bC[psx]\b/.test(info.sys.remarks ?? '') ? C.capital : C.text;
      const text = info.highPop ? name.toUpperCase() : name;
      // The hex narrows towards its flat bottom edge, so the name gets less room than the middle.
      const room = HEX_SIZE * scale * 1.42;
      let size = clamp(scale * 0.2, 8, 15);
      ctx.font = `${info.highPop ? '600 ' : '500 '}${size}px ${FONT_BODY}`;
      const width = ctx.measureText(text).width;
      if (width > room) {
        size = Math.max(size * 0.78, Math.min(size, (size * room) / width));
        ctx.font = `${info.highPop ? '600 ' : '500 '}${size}px ${FONT_BODY}`;
      }
      ctx.fillText(fitText(ctx, text, room), px, py + H * (scale >= LOD.profile ? 0.24 : 0.27));
    }
  }

  if (scale >= LOD.profile && info.sys.uwp) {
    ctx.fillStyle = C.textDim;
    // Nine monospace characters have to fit the narrow bottom of the hex.
    ctx.font = `${clamp(scale * 0.142, 8.5, 13)}px ${FONT_MONO}`;
    ctx.fillText(info.sys.uwp, px, py + H * 0.395);
  }
}

// ───────────────────────────── overlay layer ─────────────────────────────

export interface OverlayOptions {
  hover?: GlobalHex;
  selectedHex?: GlobalHex;
  multi: Id[];
  party?: Id;
  /** Planned routes: each a list of system ids to connect in order. */
  plans: { stops: Id[]; color: string }[];
  /** Shade hexes within `n` parsecs of `center`. */
  jumpRange?: { center: GlobalHex; n: number };
  /** Markers above systems: objective colours per system. */
  markers: Map<Id, string[]>;
  /** A system waiting for the second click of the route tool. */
  routeFrom?: Id;
  /** Seconds, for the party marker's slow pulse. */
  time: number;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, v: Viewport, data: MapData, o: OverlayOptions): void {
  ctx.clearRect(0, 0, v.w, v.h);
  const scale = v.scale;
  const hexAt = (h: GlobalHex) => {
    const c = hexCenter(h.gx, h.gy);
    return toScreen(v, c.x, c.y);
  };

  if (o.jumpRange && scale >= 5) {
    const { center, n } = o.jumpRange;
    for (const h of hexesWithin(center.gx, center.gy, n)) {
      const p = hexAt(h);
      if (p.x < -scale || p.y < -scale || p.x > v.w + scale || p.y > v.h + scale) continue;
      ctx.fillStyle = 'rgba(77, 227, 255, 0.07)';
      hexPath(ctx, p.x, p.y, scale, 0.5);
      ctx.fill();
    }
    // Outline of the reachable area.
    ctx.strokeStyle = 'rgba(77, 227, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    const c = hexAt(center);
    ctx.beginPath();
    ctx.arc(c.x, c.y, (n + 0.5) * scale * 1.02, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Planned routes.
  for (const plan of o.plans) {
    const pts = plan.stops.map((id) => data.byId.get(id)).filter((s): s is SysInfo => !!s).map((s) => toScreen(v, s.x, s.y));
    if (pts.length < 2) continue;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pass of [0, 1]) {
      ctx.strokeStyle = plan.color;
      ctx.globalAlpha = pass === 0 ? 0.22 : 0.95;
      ctx.lineWidth = pass === 0 ? clamp(scale * 0.3, 6, 14) : clamp(scale * 0.09, 2, 4);
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Numbered jumps.
    if (scale >= 9) {
      ctx.font = `600 ${clamp(scale * 0.2, 9, 12)}px ${FONT_DISPLAY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 1; i < pts.length; i++) {
        const mx = (pts[i - 1].x + pts[i].x) / 2;
        const my = (pts[i - 1].y + pts[i].y) / 2;
        const rr = clamp(scale * 0.2, 8, 11);
        ctx.fillStyle = '#03060b';
        ctx.beginPath();
        ctx.arc(mx, my, rr, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = plan.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = plan.color;
        ctx.fillText(String(i), mx, my + 0.5);
      }
    }
  }

  // Objective markers: small diamonds above the hex.
  if (scale >= 4) {
    for (const [id, colors] of o.markers) {
      const s = data.byId.get(id);
      if (!s) continue;
      const p = toScreen(v, s.x, s.y);
      if (p.x < -20 || p.y < -20 || p.x > v.w + 20 || p.y > v.h + 20) continue;
      const size = clamp(scale * 0.13, 4, 7);
      const top = p.y - Math.max((ROW_H * scale) / 2, 10) + size * 0.4;
      colors.slice(0, 4).forEach((color, i) => {
        const x = p.x + (i - (Math.min(colors.length, 4) - 1) / 2) * size * 2.4;
        ctx.fillStyle = color;
        ctx.strokeStyle = '#03060b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, top - size);
        ctx.lineTo(x + size, top);
        ctx.lineTo(x, top + size);
        ctx.lineTo(x - size, top);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      });
    }
  }

  // Party marker.
  const party = o.party ? data.byId.get(o.party) : undefined;
  if (party) {
    const p = toScreen(v, party.x, party.y);
    const pulse = 0.5 + 0.5 * Math.sin(o.time * 2.2);
    const base = Math.max(scale * 0.62, 9);
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(p.x, p.y, base, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.35 * (1 - pulse);
    ctx.beginPath();
    ctx.arc(p.x, p.y, base + pulse * Math.max(scale * 0.4, 8), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (scale >= LOD.subsector) {
      ctx.font = `600 ${clamp(scale * 0.16, 8, 10)}px ${FONT_DISPLAY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const label = 'PARTY';
      const w = ctx.measureText(label).width + 8;
      ctx.fillStyle = C.accent;
      ctx.fillRect(p.x - w / 2, p.y - base - 15, w, 13);
      ctx.fillStyle = '#03060b';
      ctx.fillText(label, p.x, p.y - base - 3);
    }
  }

  const outline = (h: GlobalHex, color: string, width: number, dash?: number[]) => {
    const p = hexAt(h);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash ?? []);
    if (scale >= LOD.subsector) hexPath(ctx, p.x, p.y, scale, 1);
    else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(scale * 0.6, 6), 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };

  for (const id of o.multi) {
    const s = data.byId.get(id);
    if (s) outline({ gx: s.gx, gy: s.gy }, 'rgba(77, 227, 255, 0.7)', 1.5, [4, 3]);
  }
  if (o.routeFrom) {
    const s = data.byId.get(o.routeFrom);
    if (s) outline({ gx: s.gx, gy: s.gy }, C.comm, 2.5);
  }
  if (o.hover) outline(o.hover, 'rgba(220, 232, 245, 0.45)', 1);
  if (o.selectedHex) {
    ctx.shadowColor = C.accent;
    ctx.shadowBlur = 10;
    outline(o.selectedHex, C.accent, 2);
    ctx.shadowBlur = 0;
  }
}

/** View that fits a world-unit rectangle into the canvas with some padding. */
export function fitRect(rect: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number, pad = 28): MapView {
  const rw = Math.max(rect.x1 - rect.x0, 0.001);
  const rh = Math.max(rect.y1 - rect.y0, 0.001);
  const scale = clamp(Math.min((w - pad * 2) / rw, (h - pad * 2) / rh), LOD.min, LOD.max);
  return { cx: (rect.x0 + rect.x1) / 2, cy: (rect.y0 + rect.y1) / 2, scale };
}

export { SUB_H, SUB_W };
