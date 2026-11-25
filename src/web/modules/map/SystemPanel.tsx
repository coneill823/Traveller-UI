/** Side panel content for whatever is selected on the map: a system, an empty hex, or several systems. */
import { useMemo, useState } from 'react';
import { formatHex, fromGlobal, subsectorOf, type GlobalHex } from '../../../shared/hex';
import { PRESETS } from '../../../shared/knowledge';
import { amberCandidate, decodeUwp } from '../../../shared/rules/world';
import { PARTY, type Objective } from '../../../shared/types';
import { parsePbg } from '../../../shared/uwp';
import { PushViewButton } from '../../app/Shell';
import { run } from '../../net';
import { navigate } from '../../router';
import { useCampaign, useIsGm, useRules, useType } from '../../store';
import { ConfirmButton, Empty, Segmented } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { KnowledgeBadge, KnowledgeControl } from '../../ui/Knowledge';
import { Notes } from '../../ui/Notes';
import { systemLabel, type MapData, type SysInfo } from './mapData';
import { selectSystem, setPlanner, useMap } from './mapStore';
import { SystemEditor } from './SystemEditor';

export function ZoneChip({ zone }: { zone: string | undefined }) {
  if (zone === 'A') return <span className="chip warn">Amber zone</span>;
  if (zone === 'R') return <span className="chip danger">Red zone</span>;
  return null;
}

export function TradeCodes({ codes }: { codes: string[] }) {
  const defs = useRules().world?.tradeCodes;
  if (codes.length === 0) return null;
  return (
    <div className="row wrap gap-4">
      {codes.map((code) => {
        const def = defs?.find((d) => d.code === code);
        return (
          <span key={code} className="chip mono" title={def ? `${def.name}${def.note ? ` — ${def.note}` : ''}` : code}>
            {code}
            {def && <span style={{ fontFamily: 'var(--font-body)' }}>{def.name}</span>}
          </span>
        );
      })}
    </div>
  );
}

function ObjectivesHere({ systemId }: { systemId: string }) {
  const objectives = useType('objective');
  const players = useType('player');
  const here = objectives.filter((o: Objective) => o.status === 'active' && o.targets.some((t) => t.systemId === systemId));
  if (here.length === 0) return null;
  return (
    <div className="section">
      <h3>Objectives here</h3>
      <div className="col gap-4">
        {here.map((o) => (
          <button key={o.id} className="objective-pill" onClick={() => navigate(`/objectives?o=${o.id}`)}>
            <Icon name="target" size={13} style={{ color: o.scope === PARTY ? 'var(--warn)' : (players.find((p) => p.id === o.scope)?.color ?? 'var(--accent)') }} />
            <span className="grow">{o.title}</span>
            <span className="tiny faint">{o.scope === PARTY ? 'Party' : (players.find((p) => p.id === o.scope)?.name ?? 'Personal')}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function SystemPanel({ info }: { info: SysInfo }) {
  const gm = useIsGm();
  const rules = useRules().world;
  const campaign = useCampaign();
  const [editing, setEditing] = useState(false);
  const sys = info.sys;
  const decoded = useMemo(() => decodeUwp(sys.uwp, rules), [sys.uwp, rules]);
  const pbg = parsePbg(sys.pbg);
  const h = fromGlobal(info.gx, info.gy);
  const letter = subsectorOf(h.col, h.row);
  const subName = info.sector.subsectors[letter];
  const isHere = campaign?.location?.systemId === sys.id;
  const baseDefs = rules?.bases ?? [];

  return (
    <div className="side-scroll">
      <div className="section">
        <div className="row top">
          <div className="grow">
            <h2 style={{ fontSize: 17 }}>{systemLabel(info)}</h2>
            <div className="small dim">
              {info.sector.name} <span className="mono">{sys.hex}</span> · {subName ?? `Subsector ${letter}`}
            </div>
          </div>
          {gm && <KnowledgeBadge entity={sys} />}
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          {sys.uwp ? <span className="uwp">{sys.uwp}</span> : <span className="chip">No survey data</span>}
          <ZoneChip zone={sys.zone} />
          {isHere && (
            <span className="chip accent">
              <Icon name="pin" size={11} /> Party is here
            </span>
          )}
          {gm && !sys.zone && amberCandidate(sys.uwp, rules) && (
            <span className="chip gm" title="This world shows one of the rulebook's warning signs for an Amber zone. Your call.">
              Amber candidate
            </span>
          )}
        </div>
        <div style={{ marginTop: 8 }}>
          <TradeCodes codes={info.codes} />
        </div>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <button className="btn primary sm" onClick={() => navigate(`/map/system/${sys.id}`)}>
            <Icon name="expand" size={12} /> Open system
          </button>
          <button
            className="btn sm"
            onClick={() => {
              setPlanner({ to: sys.id, from: useMap.getState().planner.from ?? campaign?.location?.systemId, objectives: false });
              useMap.setState({ panel: 'planner' });
            }}
          >
            <Icon name="route" size={12} /> Route here
          </button>
          {gm && !isHere && (
            <button className="btn sm gm" onClick={() => void run('party.moveTo', { systemId: sys.id }, 'Party moved; the system is now charted for them')} title="Set the party's current location. This also charts the system for the party.">
              <Icon name="pin" size={12} /> Move party here
            </button>
          )}
          <PushViewButton path={`/map?sys=${sys.id}&focus=1`} />
        </div>
      </div>

      {decoded.length > 0 && (
        <div className="section">
          <h3>World profile</h3>
          <dl className="kv">
            {decoded.map((row) => (
              <div key={row.key} style={{ display: 'contents' }}>
                <dt>
                  {row.label} <span className="mono">{row.code}</span>
                </dt>
                <dd>
                  {row.value}
                  {row.detail && <div className="tiny faint">{row.detail}</div>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {info.surveyed && (
        <div className="section">
          <h3>System</h3>
          <dl className="kv">
            {sys.bases && (
              <>
                <dt>Bases</dt>
                <dd>
                  {sys.bases
                    .split('')
                    .map((code) => baseDefs.find((b) => b.code === code)?.name ?? code)
                    .join(', ')}
                </dd>
              </>
            )}
            <dt>Fuel</dt>
            <dd>
              {[info.fuel.refined ? 'Refined at the starport' : info.fuel.unrefined ? 'Unrefined at the starport' : null, info.fuel.gasGiant ? 'Gas giant skimming' : null, info.fuel.water ? 'Water on the mainworld' : null].filter(Boolean).join(' · ') || 'None known'}
            </dd>
            {pbg && (
              <>
                <dt>Gas giants</dt>
                <dd>{pbg.gasGiants}</dd>
                <dt>Belts</dt>
                <dd>{pbg.belts}</dd>
              </>
            )}
            {sys.stars && (
              <>
                <dt>Stars</dt>
                <dd className="mono">{sys.stars}</dd>
              </>
            )}
            {sys.allegiance && (
              <>
                <dt>Allegiance</dt>
                <dd>{sys.allegiance}</dd>
              </>
            )}
            {sys.remarks && (
              <>
                <dt>Remarks</dt>
                <dd>{sys.remarks}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      <ObjectivesHere systemId={sys.id} />

      {gm && (
        <div className="section gm-section">
          <h3>Who knows what</h3>
          <KnowledgeControl entity={sys} />
          <div className="tiny faint" style={{ marginTop: 6 }}>
            Charting also reveals the stars, mainworld, gas giants and belts. Points of interest you add are revealed one by one in the system view.
          </div>
        </div>
      )}

      <Notes entity={sys} />

      {gm && (
        <div className="section">
          <h3>Edit</h3>
          <div className="row wrap">
            <button className="btn sm" onClick={() => setEditing(true)}>
              <Icon name="edit" size={12} /> Edit system
            </button>
            <ConfirmButton label="Re-roll world" confirm="Replace the profile" className="btn sm" icon="dice" title="Roll a new random world profile for this system" onConfirm={() => void run('system.regenerate', { id: sys.id })} />
            <ConfirmButton
              label="Delete"
              confirm="Delete system"
              icon="trash"
              onConfirm={() => {
                selectSystem(undefined);
                void run('entity.delete', { id: sys.id });
              }}
            />
          </div>
        </div>
      )}
      {editing && <SystemEditor system={sys} sector={info.sector} hex={sys.hex} onClose={() => setEditing(false)} />}
    </div>
  );
}

export function HexPanel({ hex, data }: { hex: GlobalHex; data: MapData }) {
  const gm = useIsGm();
  const [creating, setCreating] = useState(false);
  const g = fromGlobal(hex.gx, hex.gy);
  const sector = data.sectorAt.get(`${g.sx},${g.sy}`);
  const hexText = formatHex(g.col, g.row);
  if (!sector) return <Empty icon="hex" title="Uncharted space" />;
  const letter = subsectorOf(g.col, g.row);
  return (
    <div className="side-scroll">
      <div className="section">
        <h2 style={{ fontSize: 17 }}>Empty hex</h2>
        <div className="small dim">
          {sector.name} <span className="mono">{hexText}</span> · {sector.subsectors[letter] ?? `Subsector ${letter}`}
        </div>
        <p className="small dim" style={{ marginTop: 10 }}>
          {gm ? 'No system here. A ship could still jump to deep space if it carries fuel for the onward jump.' : 'No known system here.'}
        </p>
        {gm && (
          <div className="row wrap">
            <button className="btn primary sm" onClick={() => setCreating(true)}>
              <Icon name="plus" size={12} /> New system here
            </button>
            <button
              className="btn sm"
              onClick={() =>
                void run<{ id: string }>('system.create', { sectorId: sector.id, hex: hexText, generate: true }).then((res) => {
                  if (res?.id) selectSystem(res.id, hex);
                })
              }
            >
              <Icon name="dice" size={12} /> Random system
            </button>
          </div>
        )}
      </div>
      {creating && <SystemEditor sector={sector} hex={hexText} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Bulk actions when the GM has shift-clicked several systems. */
export function BulkPanel({ ids, data }: { ids: string[]; data: MapData }) {
  const systems = ids.map((id) => data.byId.get(id)).filter((s): s is SysInfo => !!s);
  return (
    <div className="side-scroll">
      <div className="section">
        <h2 style={{ fontSize: 17 }}>{systems.length} systems selected</h2>
        <div className="small dim">{systems.map((s) => systemLabel(s)).join(', ')}</div>
      </div>
      <div className="section gm-section">
        <h3>Party knowledge</h3>
        <Segmented gm value={undefined} options={Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label }))} onChange={(preset) => void run('reveal.preset', { ids, preset, audience: PARTY }, `${systems.length} systems set to ${PRESETS[preset].label.toLowerCase()}`)} />
      </div>
      <div className="section">
        <div className="row">
          <button className="btn sm" onClick={() => useMap.setState({ multi: [] })}>
            Clear selection
          </button>
          <ConfirmButton
            label="Delete all"
            confirm={`Delete ${systems.length} systems`}
            icon="trash"
            onConfirm={() => {
              for (const id of ids) void run('entity.delete', { id });
              selectSystem(undefined);
            }}
          />
        </div>
      </div>
    </div>
  );
}
