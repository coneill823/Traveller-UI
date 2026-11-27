/**
 * Adds sectors straight from the Traveller Map (travellermap.com). The GM picks sectors on a grid
 * laid out like the map itself; this browser fetches each one and hands it to the same importer
 * that reads pasted files, so worlds, subsector names, routes and borders all arrive in place.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseSectorData } from '../../../shared/sectorFormats';
import { parseUniverse, sectorsBetween, sectorUrls, TRAVELLERMAP_URL, universeUrl, type MapSector } from '../../../shared/travellermap';
import { PARTY, type Sector } from '../../../shared/types';
import { act } from '../../net';
import { toast, useApp, useCampaign, useType } from '../../store';
import { cx, Field, Modal, Segmented } from '../../ui/basics';
import { cssToHex } from '../../ui/color';
import { Icon } from '../../ui/Icon';
import { RevealChoice, type Reveal } from './ImportDialog';
import { fitTo } from './mapStore';

const CELL_W = 104;
const CELL_H = 38;
const GAP = 3;
/** The grid shows charted space; sectors further out are reached through the search box. */
const NEAR = { x: 16, yMin: -12, yMax: 10 };
/** A short pause between requests, so that a long list is fetched gently. */
const PAUSE_MS = 120;

const keyOf = (s: { x: number; y: number }): string => `${s.x},${s.y}`;
const isNear = (s: MapSector): boolean => Math.abs(s.x) <= NEAR.x && s.y >= NEAR.yMin && s.y <= NEAR.yMax;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Line {
  name: string;
  created: number;
  replaced: number;
  skipped: number;
  routes: number;
  regions: number;
  error?: string;
}

interface Run {
  phase: 'running' | 'done';
  total: number;
  current?: string;
  lines: Line[];
  /** Routes still waiting for a sector that is not on the map. */
  waiting: number;
  stopped?: boolean;
}

/** Fetches a text file from the map, trying three times before giving up: connections drop now and then. */
async function fetchText(url: string, signal: AbortSignal, optional = false): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= 2;
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return await res.text();
      // A sector with no metadata simply has none; any other answer is worth another try.
      if (optional && res.status === 404) return '';
      if (last) throw new Error(`the map answered ${res.status}`);
    } catch (err) {
      if (signal.aborted || last) throw err instanceof TypeError ? new Error('could not reach travellermap.com') : err;
    }
    await sleep(1000 + attempt * 1500);
  }
}

export function TravellerMapDialog({ onClose }: { onClose: () => void }) {
  const sectors = useType('sector');
  const systems = useType('system');
  const campaign = useCampaign();
  const [list, setList] = useState<MapSector[] | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'skip' | 'replace'>('skip');
  const [reveal, setReveal] = useState<Reveal>('hidden');
  const [withMeta, setWithMeta] = useState(true);
  const [wikiPages, setWikiPages] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const lastClick = useRef<MapSector | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const autoWiki = campaign?.settings.wikiAutoPublish ?? false;

  const closed = useRef(new AbortController());
  const load = (): void => {
    setLoadError(undefined);
    fetchText(universeUrl(), closed.current.signal)
      .then((text) => {
        const parsed = parseUniverse(JSON.parse(text));
        if (parsed.length === 0) throw new Error('the map sent no sectors');
        setList(parsed);
      })
      .catch((err: Error) => {
        if (!closed.current.signal.aborted) setLoadError(`The list of sectors did not load: ${err instanceof SyntaxError ? 'the map sent something unexpected' : err.message}. Check the internet connection and try again.`);
      });
  };
  useEffect(load, []);
  // Leaving the dialog stops any fetch still on its way.
  useEffect(
    () => () => {
      closed.current.abort();
      abort.current?.abort();
    },
    [],
  );

  const mine = useMemo(() => new Map(sectors.map((s) => [keyOf(s), s])), [sectors]);
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const s of systems) out.set(s.sectorId, (out.get(s.sectorId) ?? 0) + 1);
    return out;
  }, [systems]);
  const near = useMemo(() => (list ?? []).filter(isNear), [list]);
  const bounds = useMemo(() => {
    if (near.length === 0) return null;
    return { x0: Math.min(...near.map((s) => s.x)), x1: Math.max(...near.map((s) => s.x)), y0: Math.min(...near.map((s) => s.y)), y1: Math.max(...near.map((s) => s.y)) };
  }, [near]);
  const byKey = useMemo(() => new Map((list ?? []).map((s) => [keyOf(s), s])), [list]);
  const chosen = useMemo(() => [...selected].map((k) => byKey.get(k)).filter((s): s is MapSector => !!s).sort((a, b) => a.y - b.y || a.x - b.x), [selected, byKey]);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !list) return [];
    return list.filter((s) => s.name.toLowerCase().includes(needle) || s.abbr?.toLowerCase() === needle).slice(0, 10);
  }, [query, list]);

  const scrollTo = (s: { x: number; y: number }, smooth = true): void => {
    const el = gridRef.current;
    if (!el || !bounds) return;
    const left = (s.x - bounds.x0) * (CELL_W + GAP) - el.clientWidth / 2 + CELL_W / 2;
    const top = (s.y - bounds.y0) * (CELL_H + GAP) - el.clientHeight / 2 + CELL_H / 2;
    el.scrollTo({ left, top, behavior: smooth ? 'smooth' : 'auto' });
  };
  // Open on the part of the grid the campaign already uses, or on the middle of charted space.
  useEffect(() => {
    if (!bounds) return;
    const here = sectors.filter((s) => s.x >= bounds.x0 && s.x <= bounds.x1 && s.y >= bounds.y0 && s.y <= bounds.y1);
    const centre = here.length ? { x: Math.round(here.reduce((n, s) => n + s.x, 0) / here.length), y: Math.round(here.reduce((n, s) => n + s.y, 0) / here.length) } : { x: 0, y: 0 };
    scrollTo(centre, false);
    // Only when the list first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds]);

  const toggle = (s: MapSector, range: boolean): void => {
    if (run?.phase === 'running') return;
    setSelected((old) => {
      const next = new Set(old);
      if (range && lastClick.current && list) {
        // Shift-click takes the whole block between this sector and the last one clicked.
        for (const t of sectorsBetween(list, lastClick.current, s)) next.add(keyOf(t));
      } else if (next.has(keyOf(s))) next.delete(keyOf(s));
      else next.add(keyOf(s));
      return next;
    });
    lastClick.current = s;
  };

  const start = async (): Promise<void> => {
    const todo = chosen;
    if (todo.length === 0) return;
    const controller = new AbortController();
    abort.current = controller;
    const lines: Line[] = [];
    let waiting = 0;
    setRun({ phase: 'running', total: todo.length, lines, waiting });
    for (const s of todo) {
      if (controller.signal.aborted) break;
      setRun({ phase: 'running', total: todo.length, current: s.name, lines: [...lines], waiting });
      const line: Line = { name: s.name, created: 0, replaced: 0, skipped: 0, routes: 0, regions: 0 };
      try {
        const urls = sectorUrls(s.x, s.y);
        const data = await fetchText(urls.data, controller.signal);
        await sleep(PAUSE_MS);
        const metadata = withMeta ? await fetchText(urls.metadata, controller.signal, true) : '';
        if (withMeta) await sleep(PAUSE_MS);
        const borders = withMeta ? await fetchText(urls.borders, controller.signal, true) : '';
        const parsed = parseSectorData(`${data}\n${metadata}\n${borders}`);
        if (parsed.worlds.length === 0) throw new Error('the map has no worlds for this sector');
        // The sector may already be on the map, from an earlier import or from this one.
        const existing = (useApp.getState().byType.sector as Sector[] | undefined)?.find((x) => x.x === s.x && x.y === s.y);
        const sectorId = existing?.id ?? (await act<{ id: string }>('sector.create', { name: s.name, abbr: s.abbr, x: s.x, y: s.y })).id;
        const res = await act<{ created: number; replaced: number; skipped: number; routes: number; routesWaiting: number; regions: number }>('map.import', {
          sectorId,
          worlds: parsed.worlds,
          mode,
          subsectorNames: parsed.meta.subsectors,
          routes: withMeta ? parsed.meta.routes : [],
          borders: withMeta ? parsed.meta.borders.map((b) => ({ name: b.name, color: cssToHex(b.color), hexes: b.hexes })) : [],
          reveal: reveal === 'hidden' ? undefined : { preset: reveal, audience: PARTY },
          wikiPages: autoWiki && wikiPages,
        });
        Object.assign(line, { created: res.created, replaced: res.replaced, skipped: res.skipped, routes: res.routes, regions: res.regions });
      } catch (err) {
        if (controller.signal.aborted) break;
        line.error = (err as Error).message;
      }
      lines.push(line);
      await sleep(PAUSE_MS);
    }
    // Routes that lead off the map wait with their sector; count what is left once everything is in.
    for (const s of (useApp.getState().byType.sector as Sector[] | undefined) ?? []) {
      const list = s.gm?.waitingRoutes;
      if (Array.isArray(list)) waiting += list.length;
    }
    const stopped = controller.signal.aborted;
    abort.current = null;
    setRun({ phase: 'done', total: todo.length, lines: [...lines], waiting, stopped });
    const ok = lines.filter((l) => !l.error);
    if (ok.length) {
      fitTo({ kind: 'all' });
      toast(`Added ${ok.reduce((n, l) => n + l.created, 0)} systems in ${ok.length} sector${ok.length === 1 ? '' : 's'} from the Traveller Map.`, 'ok');
    }
    // What went in is no longer selected; anything that failed stays ticked for another go.
    setSelected(new Set(todo.filter((s) => !ok.some((l) => l.name === s.name)).map(keyOf)));
  };

  const running = run?.phase === 'running';
  const worldsHint = chosen.length ? `${chosen.length} sector${chosen.length === 1 ? '' : 's'} selected` : 'Click sectors to select them';
  const totals = run ? run.lines.reduce((t, l) => ({ created: t.created + l.created, replaced: t.replaced + l.replaced, routes: t.routes + l.routes }), { created: 0, replaced: 0, routes: 0 }) : null;
  const failed = run ? run.lines.filter((l) => l.error) : [];

  return (
    <Modal
      title="Add sectors from the Traveller Map"
      icon="globe"
      size="xwide"
      onClose={onClose}
      footer={
        <>
          <span className="grow small dim">
            {running ? `Fetching ${run.current ?? ''} (${run.lines.length + 1} of ${run.total})…` : worldsHint}
            {!running && chosen.length > 0 && (
              <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => setSelected(new Set())}>
                Clear
              </button>
            )}
          </span>
          {running ? (
            <button className="btn" onClick={() => abort.current?.abort()} title="Sectors already added stay; the rest stay selected">
              Stop
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                {run ? 'Close' : 'Cancel'}
              </button>
              <button className="btn primary" disabled={chosen.length === 0} onClick={() => void start()}>
                <Icon name="download" size={13} /> Add {chosen.length || ''} sector{chosen.length === 1 ? '' : 's'}
              </button>
            </>
          )}
        </>
      }
    >
      <div className="col gap-12">
        <p className="small dim" style={{ margin: 0 }}>
          Each sector you pick is fetched from <a href={TRAVELLERMAP_URL} target="_blank" rel="noreferrer">travellermap.com</a> by this browser and put at the same place on your map, with its worlds, subsector names, routes and borders. Sectors already
          on your map are added to, not replaced.
        </p>
        {loadError && (
          <div className="notice warn row">
            <Icon name="warning" size={14} />
            <span className="grow">{loadError}</span>
            <button className="btn sm" onClick={load}>
              Try again
            </button>
          </div>
        )}
        {!list && !loadError && <div className="faint small">Fetching the list of sectors…</div>}
        {list && bounds && (
          <>
            <div className="row">
              <div className="picker grow" style={{ maxWidth: 360 }}>
                <div className="row">
                  <Icon name="search" size={14} className="faint" />
                  <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a sector by name…" aria-label="Find a sector by name" />
                </div>
                {matches.length > 0 && (
                  <div className="picker-results">
                    {matches.map((s) => (
                      <button
                        key={keyOf(s)}
                        type="button"
                        onClick={() => {
                          if (!selected.has(keyOf(s))) toggle(s, false);
                          if (isNear(s)) scrollTo(s);
                          setQuery('');
                        }}
                      >
                        <strong>{s.name}</strong>
                        <span className="mono tiny faint">
                          {s.x}, {s.y}
                          {selected.has(keyOf(s)) ? ' · selected' : isNear(s) ? '' : ' · off the grid below'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="small faint">Shift-click selects the whole block between two sectors.</span>
            </div>
            <div className="tm-grid-wrap" ref={gridRef}>
              <div
                className="tm-grid"
                style={{ gridTemplateColumns: `repeat(${bounds.x1 - bounds.x0 + 1}, ${CELL_W}px)`, gridTemplateRows: `repeat(${bounds.y1 - bounds.y0 + 1}, ${CELL_H}px)`, gap: GAP }}
                role="group"
                aria-label="Sectors of the Traveller Map"
              >
                {near.map((s) => {
                  const have = mine.get(keyOf(s));
                  const on = selected.has(keyOf(s));
                  const n = have ? (counts.get(have.id) ?? 0) : 0;
                  return (
                    <button
                      key={keyOf(s)}
                      type="button"
                      className={cx('tm-cell', on && 'on', have && 'have')}
                      style={{ gridColumn: s.x - bounds.x0 + 1, gridRow: s.y - bounds.y0 + 1 }}
                      aria-pressed={on}
                      disabled={running}
                      onClick={(e) => toggle(s, e.shiftKey)}
                      title={have ? `${s.name}: on your map${have.name !== s.name ? ` as ${have.name}` : ''} with ${n} system${n === 1 ? '' : 's'}` : s.name}
                    >
                      <span>{s.name}</span>
                      {have && <i aria-hidden />}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="row between tiny faint">
              <span>← Spinward</span>
              <span>Coreward ↑ · Rimward ↓ · a dot marks a sector already on your map</span>
              <span>Trailing →</span>
            </div>
            {chosen.some((s) => !isNear(s)) && (
              <div className="small dim">
                Also selected, beyond the grid:{' '}
                {chosen
                  .filter((s) => !isNear(s))
                  .map((s) => s.name)
                  .join(', ')}
              </div>
            )}
            <div className="grid-2" style={{ alignItems: 'start' }}>
              <RevealChoice value={reveal} onChange={setReveal} />
              <Field label="If a hex already has a system">
                <Segmented
                  value={mode}
                  onChange={setMode}
                  options={[
                    { id: 'skip', label: 'Keep existing' },
                    { id: 'replace', label: 'Update from the map', title: 'Replaces survey data but keeps notes, wiki links and what players know' },
                  ]}
                />
              </Field>
            </div>
            <label className="check small">
              <input type="checkbox" checked={withMeta} onChange={(e) => setWithMeta(e.target.checked)} />
              Also bring the routes, and the borders as coloured regions
            </label>
            {autoWiki && (
              <label className="check small">
                <input type="checkbox" checked={wikiPages} onChange={(e) => setWikiPages(e.target.checked)} />
                Add a wiki page for every system (a sector holds several hundred; pages can be added later for the worlds you use)
              </label>
            )}
          </>
        )}
        {run && (
          <div className="col gap-4">
            <div className="tm-progress" role="progressbar" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.lines.length}>
              <span style={{ width: `${(run.lines.length / Math.max(1, run.total)) * 100}%` }} />
            </div>
            {run.phase === 'done' && totals && (
              <div className={cx('notice', failed.length > 0 && 'warn')}>
                {run.stopped ? 'Stopped. ' : ''}
                {run.lines.length - failed.length} of {run.total} sector{run.total === 1 ? '' : 's'} added: {totals.created} new systems
                {totals.replaced ? `, ${totals.replaced} updated` : ''}, {totals.routes} routes.
                {run.waiting > 0 && run.lines.length > failed.length && ` ${run.waiting} route${run.waiting === 1 ? ' leads' : 's lead'} into sectors that are not on your map; they will be drawn if you add those sectors.`}
              </div>
            )}
            {failed.map((l) => (
              <div key={l.name} className="small" style={{ color: 'var(--danger)' }}>
                {l.name}: {l.error}. It is still selected, so you can try again.
              </div>
            ))}
            {run.lines.length > 0 && (
              <div className="scroll small" style={{ maxHeight: 132, border: '1px solid var(--line)' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Sector</th>
                      <th>New</th>
                      <th>Updated</th>
                      <th>Kept</th>
                      <th>Routes</th>
                      <th>Regions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.lines
                      .filter((l) => !l.error)
                      .map((l) => (
                        <tr key={l.name}>
                          <td>{l.name}</td>
                          <td className="mono">{l.created}</td>
                          <td className="mono">{l.replaced}</td>
                          <td className="mono">{l.skipped}</td>
                          <td className="mono">{l.routes}</td>
                          <td className="mono">{l.regions}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
