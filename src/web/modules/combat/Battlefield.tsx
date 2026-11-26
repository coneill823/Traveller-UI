/** The field: the battlemap (or an open grid) with a token for everyone in the fight. */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { BattleMap, Combatant, Encounter, Id } from '../../../shared/types';
import { run } from '../../net';
import { cx } from '../../ui/basics';
import { HEALTH_LABEL, initials, replayPosition, type CombatantInfo, type ReplayView } from './model';

/** With no map uploaded the fight is laid out on an open grid 24 squares across. */
export const OPEN_FIELD: BattleMap = { url: '', width: 1600, height: 900, squares: 24, showGrid: true };

export function mapOf(encounter: Encounter): BattleMap {
  return encounter.map ?? OPEN_FIELD;
}

function useFit(ratio: number): { ref: React.RefObject<HTMLDivElement | null>; width: number; height: number } {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const width = Math.min(w, h * ratio);
      setBox({ width: Math.floor(width), height: Math.floor(width / ratio) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ratio]);
  return { ref, ...box };
}

interface Props {
  encounter: Encounter;
  infos: Map<Id, CombatantInfo>;
  replay?: ReplayView;
  selected?: Id;
  onSelect: (id: Id | undefined) => void;
  /** The combatant whose turn is being planned by this viewer: dragging it plans a move instead of moving it. */
  planFor?: Id;
  plannedTo?: { x: number; y: number };
  onPlanMove?: (to: { x: number; y: number }) => void;
  /** Combatant picked as the target of the step being edited. */
  targetId?: Id;
  squareMetres: number;
}

export function Battlefield({ encounter, infos, replay, selected, onSelect, planFor, plannedTo, onPlanMove, targetId, squareMetres }: Props) {
  const map = mapOf(encounter);
  const fit = useFit(map.width / map.height);
  const fieldRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: Id; x: number; y: number; moved: boolean } | null>(null);
  // Tokens glide when a turn is replayed, but must not lag behind the pointer while dragged.
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (!replay) return;
    setSettling(true);
    return () => setSettling(false);
  }, [replay?.record.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const squarePx = map.squares ? fit.width / map.squares : 0;
  const tokenPx = Math.max(30, Math.min(60, squarePx ? squarePx * 0.92 : 40));

  const toFraction = (e: { clientX: number; clientY: number }) => {
    const rect = fieldRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) };
  };
  const metres = (a: { x: number; y: number }, b: { x: number; y: number }): number | undefined => {
    if (!map.squares) return undefined;
    const per = map.width / map.squares;
    return Math.round(Math.hypot(((a.x - b.x) * map.width) / per, ((a.y - b.y) * map.height) / per) * squareMetres * 10) / 10;
  };

  const start = (e: ReactPointerEvent, c: Combatant) => {
    const info = infos.get(c.id);
    if (!info?.controlled || (e.button !== 0 && e.pointerType === 'mouse')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const origin = { x: e.clientX, y: e.clientY };
    const at = positionOf(c);
    setDrag({ id: c.id, ...at, moved: false });
    const el = e.currentTarget as HTMLElement;
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 4) return;
      setDrag({ id: c.id, ...toFraction(ev), moved: true });
    };
    const end = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      const moved = Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) >= 4;
      setDrag(null);
      if (!moved || ev.type === 'pointercancel') {
        if (ev.type !== 'pointercancel') onSelect(c.id);
        return;
      }
      const to = toFraction(ev);
      const rounded = { x: Math.round(to.x * 1000) / 1000, y: Math.round(to.y * 1000) / 1000 };
      if (c.id === planFor && onPlanMove && !ev.shiftKey) onPlanMove(rounded);
      else void run('encounter.move', { id: encounter.id, combatantId: c.id, ...rounded });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };

  const positionOf = (c: Combatant) => replayPosition(replay, c);
  const pct = (n: number) => `${n * 100}%`;
  const actorId = replay?.record.combatantId;
  const actor = actorId ? encounter.combatants.find((c) => c.id === actorId) : undefined;
  const strikeTarget = replay?.step?.action === 'attack' && replay.step.targetId ? encounter.combatants.find((c) => c.id === replay.step!.targetId) : undefined;
  const moveTrail = replay?.result?.from && replay.result.to ? { from: replay.result.from, to: replay.result.to } : undefined;
  const planner = planFor ? encounter.combatants.find((c) => c.id === planFor) : undefined;
  const plannerAt = planner ? { x: planner.x ?? 0.5, y: planner.y ?? 0.5 } : undefined;
  const dragging = drag?.moved ? drag : null;
  const dragFrom = dragging ? encounter.combatants.find((c) => c.id === dragging.id) : undefined;
  const dragMetres = dragging && dragFrom ? metres({ x: dragFrom.x ?? 0.5, y: dragFrom.y ?? 0.5 }, dragging) : undefined;
  const planMetres = plannerAt && plannedTo ? metres(plannerAt, plannedTo) : undefined;
  const grid: CSSProperties = map.showGrid && squarePx > 6 ? { backgroundImage: 'linear-gradient(var(--field-line) 1px, transparent 1px), linear-gradient(90deg, var(--field-line) 1px, transparent 1px)', backgroundSize: `${squarePx}px ${squarePx}px` } : {};

  return (
    <div className="field-wrap" ref={fit.ref}>
      <div
        className={cx('field', !encounter.map && 'open')}
        ref={fieldRef}
        style={{ width: fit.width, height: fit.height, ['--token' as string]: `${tokenPx}px` }}
        onClick={(e) => e.target === e.currentTarget && onSelect(undefined)}
      >
        {encounter.map && <img className="field-map" src={encounter.map.url} alt="" draggable={false} />}
        <div className="field-grid" style={grid} />
        <svg className="field-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {plannerAt && plannedTo && !replay && <line className="line-plan" x1={plannerAt.x * 100} y1={plannerAt.y * 100} x2={plannedTo.x * 100} y2={plannedTo.y * 100} />}
          {dragging && dragFrom && <line className="line-plan" x1={(dragFrom.x ?? 0.5) * 100} y1={(dragFrom.y ?? 0.5) * 100} x2={dragging.x * 100} y2={dragging.y * 100} />}
          {moveTrail && <line className="line-move" x1={moveTrail.from.x * 100} y1={moveTrail.from.y * 100} x2={moveTrail.to.x * 100} y2={moveTrail.to.y * 100} />}
          {actor && strikeTarget && (
            <line
              key={replay!.step!.id}
              className={cx('line-strike', replay!.result?.hit === false && 'miss')}
              pathLength={1}
              x1={positionOf(actor).x * 100}
              y1={positionOf(actor).y * 100}
              x2={(strikeTarget.x ?? 0.5) * 100}
              y2={(strikeTarget.y ?? 0.5) * 100}
            />
          )}
        </svg>
        {plannerAt && plannedTo && !replay && (
          <div className="token ghost" style={{ left: pct(plannedTo.x), top: pct(plannedTo.y) }}>
            <span className="token-face">{initials(infos.get(planFor!)?.name ?? '?')}</span>
            {planMetres !== undefined && <span className="token-name">{planMetres} m</span>}
          </div>
        )}
        {encounter.combatants.map((c) => {
          const info = infos.get(c.id);
          if (!info) return null;
          const at = dragging?.id === c.id ? dragging : positionOf(c);
          const struck = strikeTarget?.id === c.id;
          const hit = struck && replay?.result?.hit !== false;
          return (
            <div
              key={c.id}
              className={cx(
                'token',
                c.side,
                info.controlled && 'is-mine',
                encounter.turn === c.id && encounter.status === 'active' && 'is-turn',
                c.out && 'is-out',
                c.hidden && 'is-hidden',
                (selected === c.id || targetId === c.id) && 'is-selected',
                actorId === c.id && 'is-acting',
                struck && (hit ? 'is-hit' : 'is-missed'),
                dragging?.id === c.id && 'is-dragging',
                settling && actorId === c.id && 'is-gliding',
              )}
              style={{ left: pct(at.x), top: pct(at.y) }}
              role="button"
              tabIndex={0}
              aria-label={`${info.name}, ${c.side === 'party' ? 'party' : c.side}, ${HEALTH_LABEL[info.health]}${encounter.turn === c.id ? ', acting now' : ''}`}
              onPointerDown={(e) => start(e, c)}
              onClick={() => !info.controlled && onSelect(c.id)}
              onKeyDown={(e) => e.key === 'Enter' && onSelect(c.id)}
            >
              <span className="token-face" style={info.portrait ? { backgroundImage: `url(${info.portrait})` } : undefined}>
                {!info.portrait && initials(info.name)}
              </span>
              <span className="token-name">
                {info.name}
                {dragging?.id === c.id && dragMetres !== undefined ? ` · ${dragMetres} m` : ''}
              </span>
              {struck && replay?.result && (
                <span key={replay.step!.id} className={cx('token-pop', hit ? 'hit' : 'miss')}>
                  {hit ? (replay.result.dealt !== undefined ? `−${replay.result.taken ?? replay.result.dealt}` : 'Hit') : 'Miss'}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
