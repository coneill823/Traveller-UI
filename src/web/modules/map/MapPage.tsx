/** The universe map screen: canvas, drill-down breadcrumbs, GM tools and the side panel. */
import { useEffect, useMemo, useState } from 'react';
import { formatHex, fromGlobal, pointToHex, subsectorOf } from '../../../shared/hex';
import { PRESETS } from '../../../shared/knowledge';
import { PARTY, type Id, type RouteKind } from '../../../shared/types';
import { run } from '../../net';
import { navigate, setQuery, useRoute } from '../../router';
import { useCampaign, useIsGm, useMe, useType } from '../../store';
import { cx, Empty, Segmented, Tabs } from '../../ui/basics';
import { Icon, type IconName } from '../../ui/Icon';
import { MapCanvas, type MapPick } from './MapCanvas';
import { systemLabel, useMapData, type MapData, type SysInfo } from './mapData';
import { fitTo, LOD, selectSystem, setPlanner, useMap, type MapTool } from './mapStore';
import { RoutePlanner, usePlanner } from './RoutePlanner';
import { freeSlots, NewSectorDialog, SectorManager } from './SectorManager';
import { SystemEditor } from './SystemEditor';
import { BulkPanel, HexPanel, SystemPanel } from './SystemPanel';
import { SystemView } from './SystemView';

const TOOLS: { id: MapTool; icon: IconName; label: string; hint: string }[] = [
  { id: 'select', icon: 'move', label: 'Select', hint: 'Click a system for details. Shift-click to select several. Double-click to open a system.' },
  { id: 'add', icon: 'plus', label: 'Add system', hint: 'Click an empty hex to place a new system.' },
  { id: 'route', icon: 'route', label: 'Draw route', hint: 'Click two systems to link them. Click a linked pair again to remove the route.' },
  { id: 'reveal', icon: 'eye', label: 'Reveal', hint: 'Click systems to set what the party knows about them.' },
];

function Crumbs({ data }: { data: MapData }) {
  const view = useMap((s) => s.view);
  const selected = useMap((s) => s.selected);
  if (!view) return null;
  const hex = pointToHex(view.cx, view.cy);
  const g = fromGlobal(hex.gx, hex.gy);
  const sector = view.scale >= LOD.sector ? data.sectorAt.get(`${g.sx},${g.sy}`) : undefined;
  const letter = sector && view.scale >= LOD.subsector ? subsectorOf(g.col, g.row) : undefined;
  const sel = selected ? data.byId.get(selected) : undefined;
  return (
    <nav className="map-crumbs" aria-label="Map location">
      <button onClick={() => fitTo({ kind: 'all' })}>
        <Icon name="globe" size={13} /> Universe
      </button>
      {sector && (
        <>
          <Icon name="chevronRight" size={12} />
          <button onClick={() => fitTo({ kind: 'sector', id: sector.id })}>{sector.name}</button>
        </>
      )}
      {sector && letter && (
        <>
          <Icon name="chevronRight" size={12} />
          <button onClick={() => fitTo({ kind: 'subsector', id: sector.id, letter })}>{sector.subsectors[letter] ?? `Subsector ${letter}`}</button>
        </>
      )}
      {sel && (
        <>
          <Icon name="chevronRight" size={12} />
          <button className="on" onClick={() => navigate(`/map/system/${sel.sys.id}`)} title="Open the system view">
            {systemLabel(sel)}
          </button>
        </>
      )}
    </nav>
  );
}

function Search({ data }: { data: MapData }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    return data.systems.filter((s) => (s.sys.name ?? '').toLowerCase().includes(needle) || s.sys.hex === needle || (s.sys.uwp ?? '').toLowerCase() === needle).slice(0, 8);
  }, [q, data.systems]);
  const go = (s: SysInfo) => {
    selectSystem(s.sys.id, { gx: s.gx, gy: s.gy });
    useMap.setState({ panel: 'info' });
    fitTo({ kind: 'system', id: s.sys.id });
    setQ('');
    setOpen(false);
  };
  return (
    <div className="map-search">
      <Icon name="search" size={14} />
      <input value={q} placeholder="Find a system…" aria-label="Find a system" onChange={(e) => (setQ(e.target.value), setOpen(true))} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={(e) => e.key === 'Enter' && matches[0] && go(matches[0])} />
      {open && matches.length > 0 && (
        <div className="map-search-results">
          {matches.map((s) => (
            <button key={s.sys.id} onMouseDown={(e) => e.preventDefault()} onClick={() => go(s)}>
              <strong>{systemLabel(s)}</strong>
              <span className="mono tiny faint">
                {s.sector.name} {s.sys.hex} {s.sys.uwp ?? ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ViewControls({ data }: { data: MapData }) {
  const campaign = useCampaign();
  const gm = useIsGm();
  const layers = useMap((s) => s.layers);
  const jumpRange = useMap((s) => s.jumpRange);
  const [open, setOpen] = useState(false);
  const zoom = (factor: number) => {
    const v = useMap.getState().view;
    if (v) useMap.setState({ view: { ...v, scale: Math.max(LOD.min, Math.min(LOD.max, v.scale * factor)) } });
  };
  const partyId = campaign?.location?.systemId;
  return (
    <div className="map-controls">
      <div className="control-group">
        <button className="btn icon" onClick={() => zoom(1.5)} title="Zoom in">
          <Icon name="zoomIn" />
        </button>
        <button className="btn icon" onClick={() => zoom(1 / 1.5)} title="Zoom out">
          <Icon name="zoomOut" />
        </button>
        <button className="btn icon" onClick={() => fitTo({ kind: 'all' })} title="Show the whole universe">
          <Icon name="globe" />
        </button>
        {partyId && data.byId.has(partyId) && (
          <button
            className="btn icon"
            onClick={() => {
              const p = data.byId.get(partyId)!;
              selectSystem(p.sys.id, { gx: p.gx, gy: p.gy });
              fitTo({ kind: 'system', id: partyId });
            }}
            title="Go to the party's location"
          >
            <Icon name="pin" />
          </button>
        )}
        <button className={cx('btn icon', open && 'on')} onClick={() => setOpen((v) => !v)} title="Layers and jump range">
          <Icon name="layers" />
        </button>
      </div>
      {open && (
        <div className="panel map-layers">
          <div className="col gap-4">
            <span className="label">Show</span>
            {(
              [
                ['grid', 'Hex grid'],
                ['names', 'Names'],
                ['routes', 'Routes'],
                ['regions', 'Regions'],
                ['objectives', 'Objective markers'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="check small">
                <input type="checkbox" checked={layers[key]} onChange={(e) => useMap.setState({ layers: { ...layers, [key]: e.target.checked } })} />
                {label}
              </label>
            ))}
            {gm && (
              <label className="check small" style={{ color: 'var(--gm)' }}>
                <input type="checkbox" checked={layers.knowledge} onChange={(e) => useMap.setState({ layers: { ...layers, knowledge: e.target.checked } })} />
                Mark what the party does not know
              </label>
            )}
          </div>
          <div className="col gap-4">
            <span className="label">Jump range from the selected system</span>
            <Segmented
              value={String(jumpRange)}
              onChange={(v) => useMap.setState({ jumpRange: Number(v) })}
              options={[{ id: '0', label: 'Off' }, ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: String(n), label: `J${n}` }))]}
            />
          </div>
          <div className="col gap-4 tiny dim">
            <span className="label">Key</span>
            <span className="row">
              <span className="key-line" style={{ background: '#3fd68f' }} /> Communications route
            </span>
            <span className="row">
              <span className="key-line dashed" style={{ color: '#ffb347' }} /> Trade route
            </span>
            <span className="row">
              <span className="key-hex" style={{ borderColor: '#ffb347' }} /> Amber zone <span className="key-hex" style={{ borderColor: '#ff5c6c', marginLeft: 6 }} /> Red zone
            </span>
            {gm && (
              <span className="row" style={{ color: 'var(--gm)' }}>
                <span className="key-wedge" /> Violet corner: hidden from the party (hollow: partly known)
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GmToolbar({ onSectors }: { onSectors: () => void }) {
  const tool = useMap((s) => s.tool);
  const routeKind = useMap((s) => s.routeKind);
  const revealPreset = useMap((s) => s.revealPreset);
  const active = TOOLS.find((t) => t.id === tool)!;
  return (
    <>
      <div className="map-tools" role="toolbar" aria-label="Map tools">
        {TOOLS.map((t) => (
          <button key={t.id} className={cx('btn icon', tool === t.id && 'on')} title={`${t.label} — ${t.hint}`} onClick={() => useMap.setState({ tool: t.id, routeFrom: undefined })}>
            <Icon name={t.icon} />
          </button>
        ))}
        <div className="divider" />
        <button className="btn icon gm" title="Sectors: add, import, generate" onClick={onSectors}>
          <Icon name="hex" />
        </button>
      </div>
      {tool !== 'select' && (
        <div className="map-toolhint">
          <Icon name={active.icon} size={14} />
          <span>{active.hint}</span>
          {tool === 'route' && (
            <Segmented
              value={routeKind}
              onChange={(k) => useMap.setState({ routeKind: k as RouteKind })}
              options={[
                { id: 'comm', label: 'Comms' },
                { id: 'trade', label: 'Trade' },
                { id: 'custom', label: 'Other' },
              ]}
            />
          )}
          {tool === 'reveal' && <Segmented gm value={revealPreset} onChange={(p) => useMap.setState({ revealPreset: p })} options={(Object.keys(PRESETS) as ('hidden' | 'detected' | 'charted')[]).map((id) => ({ id, label: PRESETS[id].label }))} />}
          <button className="btn ghost sm" onClick={() => useMap.setState({ tool: 'select', routeFrom: undefined })}>
            Done
          </button>
        </div>
      )}
    </>
  );
}

function Overview({ data, onSectors }: { data: MapData; onSectors: () => void }) {
  const gm = useIsGm();
  const campaign = useCampaign();
  const party = campaign?.location?.systemId ? data.byId.get(campaign.location.systemId) : undefined;
  const hidden = data.systems.filter((s) => s.party === 'hidden').length;
  return (
    <div className="side-scroll">
      <div className="section">
        <h2 style={{ fontSize: 17 }}>Star map</h2>
        <p className="small dim" style={{ marginTop: 6 }}>
          {gm ? 'Scroll to zoom from the whole universe down to a single hex. Click a system for its details, or double-click to open its worlds.' : 'This map shows what your crew knows. Scroll to zoom, click a system for details, double-click to open it.'}
        </p>
        <dl className="kv">
          <dt>Sectors</dt>
          <dd>{data.sectors.length}</dd>
          <dt>Systems</dt>
          <dd>
            {data.systems.length}
            {gm && hidden > 0 && <span className="chip gm" style={{ marginLeft: 8 }}>{hidden} hidden from the party</span>}
          </dd>
          {party && (
            <>
              <dt>Party at</dt>
              <dd>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    selectSystem(party.sys.id, { gx: party.gx, gy: party.gy });
                    fitTo({ kind: 'system', id: party.sys.id });
                  }}
                >
                  {systemLabel(party)}
                </a>
              </dd>
            </>
          )}
        </dl>
      </div>
      {gm && (
        <div className="section gm-section">
          <h3>Build the universe</h3>
          <p className="small dim">Add sectors, import generator output, or roll subsectors from the rulebook tables. Everything starts hidden from players until you reveal it.</p>
          <button className="btn gm" onClick={onSectors}>
            <Icon name="hex" size={14} /> Sectors, import &amp; generate
          </button>
        </div>
      )}
    </div>
  );
}

export function MapPage() {
  const route = useRoute();
  const data = useMapData();
  const gm = useIsGm();
  const me = useMe();
  const campaign = useCampaign();
  const players = useType('player');
  const selected = useMap((s) => s.selected);
  const selectedHex = useMap((s) => s.selectedHex);
  const multi = useMap((s) => s.multi);
  const panel = useMap((s) => s.panel);
  const jumpRange = useMap((s) => s.jumpRange);
  const layers = useMap((s) => s.layers);
  const picking = useMap((s) => s.planner.picking);
  const [sectorsOpen, setSectorsOpen] = useState(false);
  const [newSectorAt, setNewSectorAt] = useState<{ x: number; y: number } | null>(null);
  const [creatingAt, setCreatingAt] = useState<{ sectorId: Id; hex: string } | null>(null);

  const planner = usePlanner(data);
  const ghostSlots = useMemo(() => (gm ? freeSlots(data.sectors) : []), [gm, data.sectors]);
  const selectedInfo = selected ? data.byId.get(selected) : undefined;

  // Links such as /map?sys=…&focus=1 (party location, GM "show players").
  const querySys = route.query.get('sys');
  const queryFocus = route.query.get('focus');
  useEffect(() => {
    if (!querySys) return;
    const info = data.byId.get(querySys);
    if (!info) return;
    selectSystem(info.sys.id, { gx: info.gx, gy: info.gy });
    useMap.setState({ panel: 'info' });
    if (queryFocus) fitTo({ kind: 'system', id: info.sys.id });
    setQuery({ sys: undefined, focus: undefined }, { replace: true });
  }, [querySys, queryFocus, data.byId]);

  // Tools are a creator-mode feature.
  useEffect(() => {
    if (!gm && useMap.getState().tool !== 'select') useMap.setState({ tool: 'select', routeFrom: undefined });
  }, [gm]);

  // Forget the selection if the system disappears (deleted, or hidden from this viewer).
  useEffect(() => {
    if (selected && !data.byId.has(selected)) selectSystem(undefined);
  }, [selected, data.byId]);

  const markers = useMemo(() => {
    const out = new Map<Id, string[]>();
    if (!layers.objectives) return out;
    for (const [systemId, list] of planner.objectivesBySystem) {
      out.set(
        systemId,
        list.map((o) => (o.scope === PARTY ? '#ffb347' : (players.find((p) => p.id === o.scope)?.color ?? '#4de3ff'))),
      );
    }
    return out;
  }, [planner.objectivesBySystem, players, layers.objectives]);

  const partyId = campaign?.location?.systemId;
  const rangeOrigin = selectedInfo ?? (partyId ? data.byId.get(partyId) : undefined);
  const overlay = useMemo(
    () => ({
      party: partyId && data.byId.has(partyId) ? partyId : undefined,
      plans: planner.lines,
      jumpRange: jumpRange > 0 && rangeOrigin ? { center: { gx: rangeOrigin.gx, gy: rangeOrigin.gy }, n: jumpRange } : undefined,
      markers,
    }),
    [partyId, data.byId, planner.lines, jumpRange, rangeOrigin, markers],
  );

  if (route.parts[1] === 'system' && route.parts[2]) return <SystemView systemId={route.parts[2]} bodyId={route.query.get('body') ?? undefined} data={data} />;

  const onPick = (pick: MapPick) => {
    const state = useMap.getState();
    // Picking an end point for the route planner takes priority over everything else.
    if (state.planner.picking) {
      if (pick.system) setPlanner({ [state.planner.picking]: pick.system.sys.id, picking: undefined });
      return;
    }
    const tool = gm ? state.tool : 'select';
    if (tool === 'add') {
      if (pick.system) selectSystem(pick.system.sys.id, pick.hex);
      else {
        const g = fromGlobal(pick.hex.gx, pick.hex.gy);
        const sector = data.sectorAt.get(`${g.sx},${g.sy}`);
        if (sector) setCreatingAt({ sectorId: sector.id, hex: formatHex(g.col, g.row) });
      }
      return;
    }
    if (tool === 'route') {
      if (!pick.system) return;
      if (!state.routeFrom) useMap.setState({ routeFrom: pick.system.sys.id });
      else if (state.routeFrom === pick.system.sys.id) useMap.setState({ routeFrom: undefined });
      else {
        const a = state.routeFrom;
        const b = pick.system.sys.id;
        const existing = data.routes.find((r) => r.route.kind === state.routeKind && ((r.route.a === a && r.route.b === b) || (r.route.a === b && r.route.b === a)));
        if (existing) void run('entity.delete', { id: existing.route.id });
        else void run('route.create', { a, b, kind: state.routeKind });
        // Carry on from the second system so a chain of routes is quick to draw.
        useMap.setState({ routeFrom: b });
      }
      return;
    }
    if (tool === 'reveal') {
      if (pick.system) void run('reveal.preset', { ids: [pick.system.sys.id], preset: state.revealPreset, audience: PARTY });
      return;
    }
    if (gm && pick.shift && pick.system) {
      const base = state.multi.length ? state.multi : state.selected ? [state.selected] : [];
      const id = pick.system.sys.id;
      useMap.setState({ multi: base.includes(id) ? base.filter((x) => x !== id) : [...base, id], selected: undefined, selectedHex: undefined, panel: 'info' });
      return;
    }
    selectSystem(pick.system?.sys.id, pick.hex);
    if (state.panel === 'none') useMap.setState({ panel: 'info' });
  };

  const creatingSector = creatingAt ? data.sectors.find((s) => s.id === creatingAt.sectorId) : undefined;

  return (
    <div className={cx('map-page', panel === 'none' && 'side-closed')}>
      <div className="map-main">
        <MapCanvas data={data} gm={gm} ghostSlots={ghostSlots} overlay={overlay} onPick={onPick} onOpen={(s) => navigate(`/map/system/${s.sys.id}`)} onGhostSlot={(pos) => setNewSectorAt(pos)} />
        <Crumbs data={data} />
        <Search data={data} />
        {gm && <GmToolbar onSectors={() => setSectorsOpen(true)} />}
        <ViewControls data={data} />
        {picking && (
          <div className="map-toolhint">
            <Icon name="crosshair" size={14} />
            <span>Click a system to set the route&apos;s {picking === 'from' ? 'start' : 'destination'}.</span>
            <button className="btn ghost sm" onClick={() => setPlanner({ picking: undefined })}>
              Cancel
            </button>
          </div>
        )}
        {data.sectors.length === 0 && (
          <div className="map-empty panel">
            {gm ? (
              <Empty icon="hex" title="An empty universe">
                Start by creating a sector. You can then import generator output, roll systems from the rulebook tables, or place them by hand.
                <div style={{ marginTop: 12 }}>
                  <button className="btn primary" onClick={() => setNewSectorAt({ x: 0, y: 0 })}>
                    <Icon name="plus" size={13} /> Create the first sector
                  </button>
                </div>
              </Empty>
            ) : (
              <Empty icon="map" title="Nothing charted yet">
                {me?.viewAs ? 'Players would see an empty map: nothing has been revealed to them.' : 'Your GM has not revealed any of the map yet.'}
              </Empty>
            )}
          </div>
        )}
        {panel === 'none' && (
          <button className="btn icon side-open" onClick={() => useMap.setState({ panel: 'info' })} title="Open the side panel">
            <Icon name="chevronLeft" />
          </button>
        )}
      </div>

      {panel !== 'none' && (
        <aside className="map-side">
          <div className="row" style={{ borderBottom: '1px solid var(--line)' }}>
            <div className="grow">
              <Tabs
                value={panel}
                onChange={(p) => useMap.setState({ panel: p })}
                tabs={[
                  { id: 'info', label: 'Details' },
                  { id: 'planner', label: 'Route planner' },
                ]}
              />
            </div>
            <button className="btn ghost icon sm" style={{ marginRight: 6 }} onClick={() => useMap.setState({ panel: 'none' })} title="Hide the side panel">
              <Icon name="chevronRight" />
            </button>
          </div>
          {panel === 'planner' ? (
            <RoutePlanner data={data} result={planner} />
          ) : multi.length > 1 && gm ? (
            <BulkPanel ids={multi} data={data} />
          ) : selectedInfo ? (
            <SystemPanel key={selectedInfo.sys.id} info={selectedInfo} />
          ) : selectedHex ? (
            <HexPanel hex={selectedHex} data={data} />
          ) : (
            <Overview data={data} onSectors={() => setSectorsOpen(true)} />
          )}
        </aside>
      )}

      {sectorsOpen && <SectorManager onClose={() => setSectorsOpen(false)} />}
      {newSectorAt && <NewSectorDialog at={newSectorAt} onClose={() => setNewSectorAt(null)} />}
      {creatingAt && creatingSector && <SystemEditor sector={creatingSector} hex={creatingAt.hex} onClose={() => setCreatingAt(null)} />}
    </div>
  );
}
