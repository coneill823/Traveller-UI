/** The interactive map surface: pan, zoom, drill-down, picking and the tool clicks. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SECTOR_H, SECTOR_W, fromGlobal, globalKey, hexBlockRect, hexCenter, pointToHex, sectorRect, subsectorOf, subsectorRect, type GlobalHex, type Rect } from '../../../shared/hex';
import type { Id } from '../../../shared/types';
import { systemLabel, type MapData, type SysInfo } from './mapData';
import { LOD, useMap, type FitTarget, type MapView } from './mapStore';
import { drawBase, drawOverlay, fitRect, toWorld, type OverlayOptions, type Viewport } from './renderer';

export interface MapPick {
  hex: GlobalHex;
  system?: SysInfo;
  /** Sector grid position under the pointer. */
  sectorPos: { x: number; y: number };
  shift: boolean;
}

interface Props {
  data: MapData;
  gm: boolean;
  /** Empty sector positions offered to the GM for a new sector. */
  ghostSlots: { x: number; y: number }[];
  overlay: Omit<OverlayOptions, 'hover' | 'time' | 'selectedHex' | 'multi' | 'routeFrom'>;
  onPick: (pick: MapPick) => void;
  onOpen: (system: SysInfo) => void;
  onGhostSlot: (pos: { x: number; y: number }) => void;
}

function boundsOf(data: MapData): Rect | null {
  if (data.sectors.length === 0) return null;
  let r: Rect | null = null;
  for (const s of data.sectors) {
    const sr = sectorRect(s.x, s.y);
    r = r ? { x0: Math.min(r.x0, sr.x0), y0: Math.min(r.y0, sr.y0), x1: Math.max(r.x1, sr.x1), y1: Math.max(r.y1, sr.y1) } : sr;
  }
  return r;
}

export function MapCanvas({ data, gm, ghostSlots, overlay, onPick, onOpen, onGhostSlot }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<GlobalHex | undefined>();
  const [tip, setTip] = useState<{ x: number; y: number; info: SysInfo } | null>(null);
  const [fontsReady, setFontsReady] = useState(0);

  const view = useMap((s) => s.view);
  const layers = useMap((s) => s.layers);
  const selectedHex = useMap((s) => s.selectedHex);
  const multi = useMap((s) => s.multi);
  const routeFrom = useMap((s) => s.routeFrom);
  const fit = useMap((s) => s.fit);
  const tool = useMap((s) => s.tool);

  // Track the element size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Canvas text uses web fonts; redraw once they have loaded.
  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => live && setFontsReady((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);

  const computeFit = useCallback(
    (target: FitTarget): MapView | null => {
      if (size.w === 0) return null;
      if (target.kind === 'all') {
        const b = boundsOf(data);
        return b ? fitRect(b, size.w, size.h, 40) : { cx: 15.5, cy: 22, scale: 16 };
      }
      if (target.kind === 'sector') {
        const s = data.sectors.find((x) => x.id === target.id);
        return s ? fitRect(sectorRect(s.x, s.y), size.w, size.h) : null;
      }
      if (target.kind === 'subsector') {
        const s = data.sectors.find((x) => x.id === target.id);
        return s ? fitRect(subsectorRect(s.x, s.y, target.letter), size.w, size.h) : null;
      }
      const info = data.byId.get(target.id);
      if (!info) return null;
      return { cx: info.x, cy: info.y, scale: Math.max(useMap.getState().view?.scale ?? 0, 52) };
    },
    [data, size.w, size.h],
  );

  // First view: frame everything that exists.
  useEffect(() => {
    if (view || size.w === 0) return;
    const v = computeFit({ kind: 'all' });
    if (v) useMap.setState({ view: v });
  }, [view, size.w, computeFit]);

  // Fit requests from the rest of the page (breadcrumbs, "centre on party", search).
  const lastFit = useRef(0);
  useEffect(() => {
    if (!fit || fit.nonce === lastFit.current || size.w === 0) return;
    const v = computeFit(fit.target);
    if (!v) return;
    lastFit.current = fit.nonce;
    useMap.setState({ view: v });
  }, [fit, computeFit, size.w]);

  const vp: Viewport | null = useMemo(() => (view && size.w ? { ...view, w: size.w, h: size.h } : null), [view, size]);

  // Base layer.
  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas || !vp) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(vp.w * dpr) || canvas.height !== Math.round(vp.h * dpr)) {
      canvas.width = Math.round(vp.w * dpr);
      canvas.height = Math.round(vp.h * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBase(ctx, vp, data, { gm, layers, ghostSlots });
  }, [vp, data, gm, layers, ghostSlots, fontsReady]);

  // Overlay layer; animates only while the party marker is on screen.
  useEffect(() => {
    const canvas = overRef.current;
    if (!canvas || !vp) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(vp.w * dpr) || canvas.height !== Math.round(vp.h * dpr)) {
      canvas.width = Math.round(vp.w * dpr);
      canvas.height = Math.round(vp.h * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    let frame = 0;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const paint = (ms: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawOverlay(ctx, vp, data, { ...overlay, hover, selectedHex, multi, routeFrom, time: reduceMotion ? 0 : ms / 1000 });
      if (overlay.party && !reduceMotion) frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [vp, data, overlay, hover, selectedHex, multi, routeFrom, fontsReady]);

  // ── interaction ──

  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean; id: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const zoomAt = useCallback((sx: number, sy: number, factor: number) => {
    const state = useMap.getState();
    const el = wrapRef.current;
    if (!state.view || !el) return;
    const v: Viewport = { ...state.view, w: el.clientWidth, h: el.clientHeight };
    const scale = Math.max(LOD.min, Math.min(LOD.max, v.scale * factor));
    const before = toWorld(v, sx, sy);
    // Keep the point under the cursor fixed while zooming.
    useMap.setState({ view: { scale, cx: before.x - (sx - v.w / 2) / scale, cy: before.y - (sy - v.h / 2) / scale } });
  }, []);

  // Wheel must be registered as non-passive to stop the page from scrolling.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const pickAt = (sx: number, sy: number): { hex: GlobalHex; info?: SysInfo } | null => {
    if (!vp) return null;
    const w = toWorld(vp, sx, sy);
    const hex = pointToHex(w.x, w.y);
    return { hex, info: data.byHex.get(globalKey(hex.gx, hex.gy)) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !view) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
      drag.current = null;
      return;
    }
    drag.current = { x: p.x, y: p.y, cx: view.cx, cy: view.cy, moved: false, id: e.pointerId };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const current = useMap.getState().view;
      if (current && pinch.current.dist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.current.scale * (dist / pinch.current.dist)) / current.scale);
      return;
    }
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      const dx = p.x - d.x;
      const dy = p.y - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true;
      if (d.moved) {
        const scale = useMap.getState().view!.scale;
        useMap.setState({ view: { scale, cx: d.cx - dx / scale, cy: d.cy - dy / scale } });
        setTip(null);
      }
      return;
    }
    // Hover feedback.
    const hit = pickAt(p.x, p.y);
    if (!hit || !vp) return;
    if (vp.scale >= LOD.subsector) {
      setHover((h) => (h && h.gx === hit.hex.gx && h.gy === hit.hex.gy ? h : hit.hex));
      setTip(hit.info ? { x: p.x, y: p.y, info: hit.info } : null);
    } else {
      setHover(undefined);
      setTip(null);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || d.id !== e.pointerId || !vp) return;
    const p = local(e);
    const w = toWorld(vp, p.x, p.y);
    const hex = pointToHex(w.x, w.y);
    const g = fromGlobal(hex.gx, hex.gy);
    const sector = data.sectorAt.get(`${g.sx},${g.sy}`);

    // Drill down: at low zoom a click frames what was clicked instead of picking one tiny hex.
    if (vp.scale < LOD.subsector) {
      // Sector positions follow the frame lines rather than hex centres at the far edges.
      const sx = Math.floor((w.x + 0.5) / SECTOR_W);
      const sy = Math.floor((w.y / (2 / Math.sqrt(3)) + 0.25) / SECTOR_H);
      const framed = data.sectorAt.get(`${sx},${sy}`);
      if (!framed) {
        if (gm && vp.scale < LOD.sector && ghostSlots.some((s) => s.x === sx && s.y === sy)) onGhostSlot({ x: sx, y: sy });
        return;
      }
      if (vp.scale < LOD.sector) useMap.setState({ view: fitRect(sectorRect(framed.x, framed.y), vp.w, vp.h) });
      else {
        const col = Math.max(1, Math.min(SECTOR_W, hex.gx - framed.x * SECTOR_W + 1));
        const row = Math.max(1, Math.min(SECTOR_H, hex.gy - framed.y * SECTOR_H + 1));
        useMap.setState({ view: fitRect(subsectorRect(framed.x, framed.y, subsectorOf(col, row)), vp.w, vp.h) });
      }
      return;
    }
    if (!sector) return;
    onPick({ hex, system: data.byHex.get(globalKey(hex.gx, hex.gy)), sectorPos: { x: g.sx, y: g.sy }, shift: e.shiftKey });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const p = local(e);
    const hit = pickAt(p.x, p.y);
    if (hit?.info && vp && vp.scale >= LOD.subsector) onOpen(hit.info);
  };

  // Keyboard: arrows pan, +/- zoom.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const v = useMap.getState().view;
    if (!v || !vp) return;
    const step = 80 / v.scale;
    if (e.key === 'ArrowLeft') useMap.setState({ view: { ...v, cx: v.cx - step } });
    else if (e.key === 'ArrowRight') useMap.setState({ view: { ...v, cx: v.cx + step } });
    else if (e.key === 'ArrowUp') useMap.setState({ view: { ...v, cy: v.cy - step } });
    else if (e.key === 'ArrowDown') useMap.setState({ view: { ...v, cy: v.cy + step } });
    else if (e.key === '+' || e.key === '=') zoomAt(vp.w / 2, vp.h / 2, 1.3);
    else if (e.key === '-' || e.key === '_') zoomAt(vp.w / 2, vp.h / 2, 1 / 1.3);
    else return;
    e.preventDefault();
  };

  const cursor = tool === 'select' ? (vp && vp.scale < LOD.subsector ? 'zoom-in' : 'default') : 'crosshair';

  return (
    <div
      ref={wrapRef}
      className="map-canvas"
      style={{ cursor }}
      tabIndex={0}
      role="application"
      aria-label="Star map. Drag to pan, scroll to zoom, click a hex to select it."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        setHover(undefined);
        setTip(null);
      }}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      <canvas ref={baseRef} />
      <canvas ref={overRef} />
      {tip && (
        <div className="map-tip" style={{ left: Math.min(tip.x + 14, size.w - 230), top: Math.min(tip.y + 14, size.h - 70) }}>
          <strong>{systemLabel(tip.info)}</strong>
          <div className="mono tiny dim">
            {tip.info.sys.hex}
            {tip.info.sys.uwp ? ` · ${tip.info.sys.uwp}` : ''}
          </div>
          {tip.info.codes.length > 0 && <div className="tiny dim">{tip.info.codes.join(' ')}</div>}
        </div>
      )}
    </div>
  );
}

/** Rectangle of a single hex, for "zoom to" helpers. */
export function hexRect(h: GlobalHex): Rect {
  const c = hexCenter(h.gx, h.gy);
  return { x0: c.x - 3, x1: c.x + 3, y0: c.y - 3, y1: c.y + 3 };
}

export { hexBlockRect };
export type { Id };
