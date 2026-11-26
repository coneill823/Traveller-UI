/** The hologram: a design laid out on its hull outline, with parts as draggable blocks. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMCr, formatTons, type DesignReport, type PartLine } from '../../../shared/rules/ship';
import type { PartKind, ShipSpec } from '../../../shared/types';
import { beginDrag, useDropZone } from '../../ui/drag';
import { Icon } from '../../ui/Icon';
import { cx } from '../../ui/basics';
import { allocate, blockBox, CARGO, cellAt, cellsPath, edgesPath, gridForImage, gridKey, gridNow, hullOrder, labelSpot, outlineOf, type HullGrid } from './hullLayout';
import { shortLabel, zoneColor, zoneOf, ZONES } from './zones';

interface Props {
  spec: ShipSpec;
  report: DesignReport;
  selected?: string;
  onSelect: (id: string | undefined) => void;
  editable: boolean;
  /** Part ids with a problem. */
  flagged?: Set<string>;
  onMove?: (id: string, beforeId: string | undefined) => void;
  onDropEntry?: (entry: { kind: PartKind; key?: string }, beforeId: string | undefined) => void;
  compact?: boolean;
}

interface Target {
  id: string;
  after: boolean;
}

function useGrid(spec: ShipSpec): HullGrid | undefined {
  const outline = outlineOf(spec);
  const key = gridKey(outline);
  const sync = useMemo(() => gridNow(outline), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [loaded, setLoaded] = useState<{ key: string; grid: HullGrid } | null>(null);
  useEffect(() => {
    if (sync || outline.kind !== 'image') return;
    let live = true;
    gridForImage(outline.url)
      .then((grid) => live && setLoaded({ key, grid }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return sync ?? (loaded?.key === key ? loaded.grid : undefined);
}

export function HullView({ spec, report, selected, onSelect, editable, flagged, onMove, onDropEntry, compact }: Props) {
  const grid = useGrid(spec);
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);

  const lineById = useMemo(() => new Map(report.lines.map((l) => [l.partId, l])), [report]);
  const order = useMemo(() => hullOrder(spec, report.lines), [spec, report]);
  const layout = useMemo(() => {
    if (!grid) return undefined;
    const placed = report.lines.reduce((n, l) => n + Math.max(0, l.tons), 0);
    const free = Math.max(0, report.hullTons - placed);
    const slots = order.map((id) => ({ id, tons: id === CARGO ? free : Math.max(0, lineById.get(id)?.tons ?? 0) }));
    return allocate(grid, report.hullTons, slots);
  }, [grid, order, report, lineById]);

  const locate = (x: number, y: number): Target | null => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m || !grid || !layout) return null;
    const p = new DOMPoint(x, y).matrixTransform(m.inverse());
    const cell = cellAt(grid, p.x, p.y);
    const id = cell === undefined ? undefined : layout.owner.get(cell);
    if (!id) return null;
    const block = layout.blocks.find((b) => b.id === id)!;
    // The bow is on the right, so the left half of a block is its stern side.
    return { id, after: p.x < blockBox(grid, block.cells).cx };
  };
  const beforeOf = (t: Target | null): string | undefined => {
    if (!t) return undefined;
    if (!t.after) return t.id;
    return order[order.indexOf(t.id) + 1];
  };

  useDropZone('hull', {
    accepts: (p) => editable && (p.kind === 'part' || p.kind === 'entry'),
    over: (p, pt) => setTarget(p && pt ? locate(pt.x, pt.y) : null),
    drop: (p, pt) => {
      const t = locate(pt.x, pt.y);
      setTarget(null);
      if (p.kind === 'part') {
        if (t && t.id !== p.id) onMove?.(p.id as string, beforeOf(t));
      } else {
        onDropEntry?.(p.entry as { kind: PartKind; key?: string }, beforeOf(t));
      }
    },
  });

  if (!grid || !layout) {
    return (
      <div className="holo holo-empty" ref={boxRef}>
        <span className="faint small">Loading outline…</span>
      </div>
    );
  }

  const [vx, vy, vw, vh] = grid.viewBox;
  const inset = grid.size * 0.07;
  // Lines of surface colour wherever two different blocks meet: a gap, not a border.
  let seams = '';
  for (const block of layout.blocks) seams += edgesPath(grid, block.cells, (n) => n !== undefined && layout.owner.has(n) && layout.owner.get(n) !== block.id && layout.owner.get(n)! > block.id);
  const fontSize = Math.max(grid.size * 1.25, vw / 62);
  const describe = (id: string): { name: string; value: string; line?: PartLine } => {
    if (id === CARGO) return { name: 'Cargo hold (free space)', value: `${formatTons(Math.max(0, report.cargo))} t` };
    const line = lineById.get(id);
    if (!line) return { name: id, value: '' };
    return { name: [line.label, line.detail].filter(Boolean).join(' · '), value: `${formatTons(line.tons)} t · ${line.cost ? formatMCr(line.cost) : 'no cost'}`, line };
  };
  const tipInfo = tip ? describe(tip.id) : null;
  const weightless = report.lines.filter((l) => l.partId !== 'hull' && l.tons <= 0);
  const zoneTons = ZONES.map((z) => ({ ...z, tons: report.lines.filter((l) => l.partId !== 'hull' && l.tons > 0 && zoneOf(l) === z.id).reduce((n, l) => n + l.tons, 0) }));
  const targetLine = target ? describe(target.id).name : '';

  return (
    <div className={cx('holo', compact && 'compact')} ref={boxRef} data-drop="hull">
      <svg
        ref={svgRef}
        className="holo-svg"
        viewBox={`${vx} ${vy} ${vw} ${vh}`}
        role="img"
        aria-label={`Hull plan: ${formatTons(report.hullTons)} tons, ${formatTons(report.tonsUsed)} tons fitted, ${formatTons(Math.max(0, report.cargo))} tons of cargo space`}
        onClick={(e) => e.target === e.currentTarget && onSelect(undefined)}
        onPointerLeave={() => setTip(null)}
      >
        <defs>
          <filter id="holo-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation={vw / 150} result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {grid.imageUrl && <image href={grid.imageUrl} x={vx} y={vy} width={vw} height={vh} className="holo-image" preserveAspectRatio="xMidYMid meet" />}
        {grid.d && <path d={grid.d} className="holo-body" />}
        {layout.blocks.map((block) => {
          const info = describe(block.id);
          const isCargo = block.id === CARGO;
          const d = cellsPath(grid, block.cells, inset);
          return (
            <path
              key={block.id}
              d={d}
              className={cx('holo-block', isCargo && 'is-cargo', editable && 'is-draggable', selected === block.id && 'is-selected')}
              fill={isCargo ? undefined : zoneColor(info.line ? zoneOf(info.line) : 'other')}
              tabIndex={0}
              role="button"
              aria-label={`${info.name}, ${info.value}`}
              onPointerDown={(e) => editable && beginDrag(e, { kind: 'part', id: block.id }, isCargo ? 'Cargo hold' : (info.line?.label ?? 'Part'))}
              onPointerMove={(e) => {
                const rect = boxRef.current!.getBoundingClientRect();
                // Keep the readout inside the panel near its right and bottom edges.
                const x = Math.min(e.clientX - rect.left, rect.width - 262);
                const y = e.clientY - rect.top > rect.height - 80 ? e.clientY - rect.top - 76 : e.clientY - rect.top;
                setTip({ id: block.id, x: Math.max(0, x), y });
              }}
              onFocus={() => {
                const spot = blockBox(grid, block.cells);
                const m = svgRef.current!.getScreenCTM()!;
                const p = new DOMPoint(spot.cx, spot.cy).matrixTransform(m);
                const rect = boxRef.current!.getBoundingClientRect();
                setTip({ id: block.id, x: p.x - rect.left, y: p.y - rect.top });
              }}
              onBlur={() => setTip(null)}
              onClick={() => onSelect(block.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(block.id);
                }
              }}
            />
          );
        })}
        <path d={seams} className="holo-seam" strokeWidth={grid.size * 0.36} />
        {layout.blocks.map((block) => {
          const ring = selected === block.id || target?.id === block.id || flagged?.has(block.id);
          if (!ring) return null;
          return (
            <path
              key={`ring-${block.id}`}
              d={edgesPath(grid, block.cells, (n) => n === undefined || layout.owner.get(n) !== block.id)}
              className={cx('holo-ring', target?.id === block.id ? 'is-target' : selected === block.id ? 'is-selected' : 'is-flagged')}
            />
          );
        })}
        {grid.d && <path d={grid.d} className="holo-edge" filter="url(#holo-glow)" />}
        {layout.blocks.map((block) => {
          const info = describe(block.id);
          const spot = labelSpot(grid, block.cells);
          const name = block.id === CARGO ? 'Cargo' : info.line ? shortLabel(info.line) : '';
          const withTons = `${name} ${formatTons(block.tons)} t`;
          const fits = (text: string) => text.length * fontSize * 0.56 <= spot.width - grid.size * 0.6;
          const text = block.cells.length >= 6 && fits(withTons) ? withTons : block.cells.length >= 4 && fits(name) ? name : '';
          if (!text) return null;
          return (
            <text key={`label-${block.id}`} x={spot.x} y={spot.y} fontSize={fontSize} className={cx('holo-label', block.id === CARGO && 'on-surface')}>
              {flagged?.has(block.id) ? '⚠ ' : ''}
              {text}
            </text>
          );
        })}
      </svg>
      {tip && tipInfo && (
        <div className="holo-tip" style={{ left: tip.x, top: tip.y }}>
          <strong>{tipInfo.value}</strong>
          <span>{tipInfo.name}</span>
        </div>
      )}
      <div className="holo-caption">
        <span>◂ Stern</span>
        <span className="grow center">{target ? `Place ${target.after ? 'astern of' : 'ahead of'} ${targetLine}` : editable ? 'Drag parts onto the hull, or drag blocks to rearrange them' : ''}</span>
        <span>Bow ▸</span>
      </div>
      {!compact && (
        <>
          <ul className="holo-legend" aria-label="Legend">
            {zoneTons.map((z) => (
              <li key={z.id} title={z.hint}>
                <i style={{ background: z.color }} />
                {z.label}
                <b>{formatTons(z.tons)} t</b>
              </li>
            ))}
            <li title="Unallocated tonnage is the cargo hold">
              <i className="swatch-empty" />
              Cargo hold
              <b>{formatTons(Math.max(0, report.cargo))} t</b>
            </li>
          </ul>
          {weightless.length > 0 && (
            <div className="holo-chips">
              <span className="faint tiny upper">No tonnage</span>
              {weightless.map((l) => (
                <button key={l.partId} className={cx('chip', 'clickable', selected === l.partId && 'on', flagged?.has(l.partId) && 'danger')} onClick={() => onSelect(l.partId)}>
                  {flagged?.has(l.partId) && <Icon name="warning" size={11} />}
                  {l.label}
                </button>
              ))}
            </div>
          )}
          {layout.overflow.length > 0 && (
            <div className="notice danger small">
              <Icon name="warning" size={14} /> No room left for: {layout.overflow.map((id) => describe(id).name).join('; ')}
            </div>
          )}
        </>
      )}
    </div>
  );
}
