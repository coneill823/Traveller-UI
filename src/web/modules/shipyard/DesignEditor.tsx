/** The drawing board: palette on the left, the hull in the middle, figures and checks on the right. */
import { useMemo, useState } from 'react';
import type { ShipRules } from '../../../shared/rulepack';
import {
  arrangeParts,
  canBuildAnything,
  catalogue,
  defaultPart,
  entryState,
  evaluateDesign,
  formatMCr,
  formatTons,
  isBuildable,
  PART_GROUPS,
  yardAt,
  yardIssues,
  type CatalogueEntry,
  type DesignIssue,
  type DesignReport,
  type Yard,
} from '../../../shared/rules/ship';
import type { Character, DesignPart, PartKind, Ship, ShipDesign, ShipSpec, StarSystem } from '../../../shared/types';
import { formatCredits } from '../../../shared/util';
import { act, run } from '../../net';
import { Link, navigate } from '../../router';
import { toast, useCampaign, useEntity, useIsGm, useMe, usePlayers, useRules, useType } from '../../store';
import { ConfirmButton, cx, EditableText, Field, Modal } from '../../ui/basics';
import { beginDrag, useDropZone } from '../../ui/drag';
import { Icon } from '../../ui/Icon';
import { HullView } from './HullView';
import { CARGO, cargoIndex, hullOrder, insertIndex, moveInOrder, rankOf } from './hullLayout';
import { CargoInspector, HullInspector, IssueList, Num, PartInspector } from './PartInspector';
import { ZONES, zoneOf } from './zones';

const STATUS: Record<ShipDesign['status'], { label: string; cls: string; hint: string }> = {
  draft: { label: 'Draft', cls: '', hint: 'Still on the drawing board.' },
  proposed: { label: 'Awaiting sign-off', cls: 'warn', hint: 'Put to the party; waiting for everyone to sign off.' },
  approved: { label: 'Signed off', cls: 'ok', hint: 'The party has agreed. Ready to commission.' },
  built: { label: 'Built', cls: 'accent', hint: 'This design has been built.' },
};

export function StatusChip({ status }: { status: ShipDesign['status'] }) {
  const s = STATUS[status];
  return (
    <span className={cx('chip', s.cls)} title={s.hint}>
      {status === 'approved' && <Icon name="check" size={11} />}
      {s.label}
    </span>
  );
}

/** The yard where the party is. */
export function useYard(rules: ShipRules | undefined): { system?: StarSystem; yard: Yard } {
  const campaign = useCampaign();
  const world = useRules().world;
  const system = useEntity<StarSystem>(campaign?.location?.systemId);
  const yard = useMemo(() => (rules && system?.uwp ? yardAt(rules, world, system.uwp) : {}), [rules, world, system?.uwp]);
  return { system, yard };
}

export function YardBadge({ system, yard }: { system?: StarSystem; yard: Yard }) {
  if (!system) {
    return (
      <div className="yard-badge none">
        <Icon name="pin" size={14} />
        <span>The party is not at a starport, so there is no yard to price against.</span>
      </div>
    );
  }
  const can = canBuildAnything(yard);
  return (
    <div className={cx('yard-badge', !can && 'none')}>
      <Icon name={can ? 'wrench' : 'lock'} size={14} />
      <span>
        <b>{system.name ?? 'This system'}</b> · class {yard.starport ?? '?'} starport{yard.tl !== undefined ? ` · TL${yard.tl}` : ''}
        <span className="dim"> — {yard.def?.label ?? 'no shipyard data'}</span>
      </span>
    </div>
  );
}

export function DesignEditor({ design }: { design: ShipDesign }) {
  const rules = useRules().ships!;
  const me = useMe();
  const gm = useIsGm();
  const players = usePlayers();
  const allPlayers = useType('player');
  const owner = allPlayers.find((p) => p.id === design.ownerId);
  const mine = design.ownerId === me?.playerId && !me?.viewAs;
  const canEdit = (gm || mine) && design.status !== 'built';
  const spec = design.spec;
  const report = useMemo(() => evaluateDesign(rules, spec), [rules, spec]);
  const { system, yard } = useYard(rules);
  const atYard = useMemo(() => (system ? yardIssues(report, yard) : []), [system, report, yard]);
  const [selected, setSelected] = useState<string | undefined>('hull');
  const [yardOnly, setYardOnly] = useState(true);
  const [query, setQuery] = useState('');
  const [building, setBuilding] = useState(false);
  const refit = useEntity<Ship>(design.refitOf);
  const builtShip = useEntity<Ship>(design.shipId);

  const update = (next: ShipSpec) => void run('design.update', { id: design.id, spec: next });
  const lineOf = (id: string) => report.lines.find((l) => l.partId === id);
  const yardTl = yardOnly && system && canBuildAnything(yard) ? yard.tl : undefined;

  const addEntry = (entry: { kind: PartKind; key?: string }, beforeId?: string) => {
    if (!canEdit) return;
    const cat = palette.find((e) => e.kind === entry.kind && e.key === entry.key);
    const state = cat ? entryState(rules, spec, report, cat, yardTl) : {};
    if (state.blocked) {
      toast(`${cat?.name ?? 'That part'}: ${state.blocked.toLowerCase()}`, 'error');
      return;
    }
    // One set of tanks: adding fuel again just selects them.
    const tanks = entry.kind === 'fuel' ? spec.parts.find((p) => p.kind === 'fuel') : undefined;
    if (tanks) {
      setSelected(tanks.id);
      return;
    }
    const part = defaultPart(rules, spec, report, entry);
    if (state.replaces) {
      const old = spec.parts.find((p) => p.id === state.replaces);
      // Swapping one armour type for another keeps the protection asked for.
      if (old?.kind === 'armour' && old.rating) part.rating = old.rating;
      update({ ...spec, parts: spec.parts.map((p) => (p.id === state.replaces ? part : p)) });
      setSelected(part.id);
      return;
    }
    const group = entry.kind === 'fitting' ? (rules.fittings.find((f) => f.id === entry.key)?.group ?? 'systems') : (cat?.group ?? 'custom');
    const cargoAt = cargoIndex(spec, report.lines);
    let index: number;
    if (beforeId === CARGO) index = cargoAt;
    else if (beforeId !== undefined && spec.parts.some((p) => p.id === beforeId)) index = spec.parts.findIndex((p) => p.id === beforeId);
    else index = insertIndex(spec, report.lines, rankOf({ kind: entry.kind, group }));
    const parts = [...spec.parts];
    parts.splice(index, 0, part);
    // Keep the hold where it was relative to its neighbours.
    const keepCargo = spec.cargoAt !== undefined || beforeId !== undefined;
    update({ ...spec, parts, ...(keepCargo ? { cargoAt: index <= cargoAt && beforeId !== CARGO ? cargoAt + 1 : beforeId === CARGO ? cargoAt + 1 : cargoAt } : {}) });
    setSelected(part.id);
  };
  const patchPart = (id: string, patch: Partial<DesignPart>) => update({ ...spec, parts: spec.parts.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const removePart = (id: string) => {
    const index = spec.parts.findIndex((p) => p.id === id);
    if (index === -1) return;
    const cargoAt = spec.cargoAt;
    update({ ...spec, parts: spec.parts.filter((p) => p.id !== id), ...(cargoAt !== undefined ? { cargoAt: index < cargoAt ? cargoAt - 1 : cargoAt } : {}) });
    setSelected('hull');
  };
  const move = (id: string, beforeId: string | undefined) => update({ ...spec, ...moveInOrder(spec, report.lines, id, beforeId) });
  const nudge = (id: string, dir: -1 | 1) => {
    // Only blocks with tonnage are on the hull; step over the ones that are not.
    const order = hullOrder(spec, report.lines).filter((x) => x === id || x === CARGO || (lineOf(x)?.tons ?? 0) > 0);
    const at = order.indexOf(id);
    // The bow is first in the order.
    const to = at - dir;
    if (to < 0 || to >= order.length) return;
    const rest = order.filter((x) => x !== id);
    move(id, rest[to]);
  };

  useDropZone('bin', {
    accepts: (p) => canEdit && p.kind === 'part' && p.id !== CARGO,
    drop: (p) => removePart(p.id as string),
  });

  const palette = useMemo(() => catalogue(rules, spec), [rules, spec]);
  const flagged = useMemo(() => new Set(report.issues.filter((i) => i.level === 'error' && i.partId).map((i) => i.partId!)), [report]);
  const beyondYard = useMemo(() => new Set(atYard.filter((i) => i.partId).map((i) => i.partId!)), [atYard]);
  const issues: DesignIssue[] = [...report.issues, ...atYard];
  const selectedPart = spec.parts.find((p) => p.id === selected);
  const selectedLine = selected ? lineOf(selected) : undefined;
  const q = query.trim().toLowerCase();

  const signed = new Set(design.approvals ?? []);
  const iSigned = !!me && signed.has(me.playerId);
  const isPlayer = me?.role === 'player';

  return (
    <div className="yard">
      <header className="yard-head">
        <Link to="/shipyard" className="btn ghost sm" aria-label="Back to the shipyard">
          <Icon name="chevronLeft" size={14} /> Yard
        </Link>
        <div className="yard-title">
          <h1>
            <EditableText value={design.name} disabled={!canEdit} onCommit={(name) => name.trim() && void run('design.update', { id: design.id, name })} />
          </h1>
          <div className="small dim">
            <EditableText value={design.className} disabled={!canEdit} placeholder="Class or type" onCommit={(className) => void run('design.update', { id: design.id, className })} /> · drawn up by {owner?.name ?? 'someone'}
            {refit ? ` · refit of ${refit.name ?? 'a ship'}` : ''}
          </div>
        </div>
        <StatusChip status={design.status} />
        <div className="row gap-4 wrap yard-actions">
          {design.status === 'draft' && canEdit && (
            <>
              <button className="btn sm" onClick={() => void run('design.share', { id: design.id, shared: !design.shared })} title={design.shared ? 'Hide this draft from the other players again' : 'Let the other players look at this draft'}>
                <Icon name={design.shared ? 'eyeOff' : 'eye'} size={13} /> {design.shared ? 'Make private' : 'Show the party'}
              </button>
              <button className="btn sm primary" onClick={() => void run('design.propose', { id: design.id }, 'Put to the party for sign-off')}>
                <Icon name="send" size={13} /> Ask for sign-off
              </button>
            </>
          )}
          {(design.status === 'proposed' || design.status === 'approved') && (
            <>
              {isPlayer && (
                <button className={cx('btn sm', !iSigned && 'primary')} onClick={() => void run('design.approve', { id: design.id, approve: !iSigned })}>
                  <Icon name={iSigned ? 'x' : 'check'} size={13} /> {iSigned ? 'Withdraw my sign-off' : 'Sign off'}
                </button>
              )}
              {gm && (
                <button className="btn sm gm" onClick={() => void run('design.approve', { id: design.id, approve: !design.gmSigned })}>
                  <Icon name={design.gmSigned ? 'x' : 'check'} size={13} /> {design.gmSigned ? 'Revoke GM sign-off' : 'Sign off for the table'}
                </button>
              )}
              {canEdit && (
                <button className="btn sm" onClick={() => void run('design.withdraw', { id: design.id })}>
                  Back to draft
                </button>
              )}
            </>
          )}
          {design.status !== 'built' && (design.status === 'approved' || gm) && (
            <button className={cx('btn sm', gm && design.status !== 'approved' ? 'gm' : 'primary')} onClick={() => setBuilding(true)}>
              <Icon name="wrench" size={13} /> {refit ? 'Commission refit' : 'Commission build'}
            </button>
          )}
          {design.status === 'built' && builtShip && (
            <Link className="btn sm" to="/inventory">
              <Icon name="ship" size={13} /> {builtShip.name ?? 'The ship'}
            </Link>
          )}
          <button
            className="btn sm"
            title="Start a new draft from this design"
            onClick={async () => {
              const res = await run<{ id: string }>('design.create', { copyOf: design.id });
              if (res?.id) navigate(`/shipyard/${res.id}`);
            }}
          >
            <Icon name="copy" size={13} /> Copy
          </button>
          {(gm || mine) && (design.status !== 'built' || gm) && (
            <ConfirmButton
              label="Delete"
              icon="trash"
              confirm="Delete this design"
              onConfirm={async () => {
                await run('design.delete', { id: design.id });
                navigate('/shipyard');
              }}
            />
          )}
        </div>
      </header>

      {(design.status === 'proposed' || design.status === 'approved') && (
        <div className="signoff" aria-label="Sign-off">
          <span className="upper tiny faint">Sign-off</span>
          {players.length === 0 && <span className="small dim">No players have joined yet.</span>}
          {players.map((p) => (
            <span key={p.id} className={cx('signoff-who', signed.has(p.id) && 'yes')}>
              <Icon name={signed.has(p.id) ? 'check' : 'clock'} size={12} /> {p.name}
            </span>
          ))}
          {design.gmSigned && (
            <span className="signoff-who yes gm">
              <Icon name="check" size={12} /> Signed off by the GM
            </span>
          )}
          {canEdit && <span className="small faint">Changing the design asks everyone to sign off again.</span>}
        </div>
      )}

      <div className="yard-grid">
        {/* ── palette ── */}
        <aside className="yard-palette panel" aria-label="Parts">
          <div className="panel-head">
            <h3 className="grow">Parts</h3>
          </div>
          <div className="yard-palette-top">
            <YardBadge system={system} yard={yard} />
            {system && canBuildAnything(yard) && (
              <label className="check small">
                <input type="checkbox" checked={yardOnly} onChange={(e) => setYardOnly(e.target.checked)} />
                <span>Only what this yard can fit</span>
              </label>
            )}
            <input className="input" type="search" placeholder="Find a part…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a part" />
          </div>
          <div className="yard-palette-list">
            {PART_GROUPS.map((group) => {
              const entries = palette.filter((e) => e.group === group.id && (!q || e.name.toLowerCase().includes(q) || (e.note ?? '').toLowerCase().includes(q)));
              if (entries.length === 0) return null;
              return (
                <section key={group.id}>
                  <h4>{group.label}</h4>
                  {entries.map((entry) => {
                    const state = entryState(rules, spec, report, entry, yardTl);
                    const label = entry.name;
                    return (
                      <button
                        key={`${entry.kind}:${entry.key ?? ''}`}
                        className={cx('part-card', state.blocked && 'is-blocked', state.needed && !state.blocked && 'is-needed', canEdit && !state.blocked && 'is-draggable')}
                        aria-disabled={!!state.blocked || !canEdit}
                        title={[entry.note, state.blocked].filter(Boolean).join(' — ') || undefined}
                        onPointerDown={(e) => canEdit && !state.blocked && beginDrag(e, { kind: 'entry', entry: { kind: entry.kind, key: entry.key } }, label)}
                        onClick={() => addEntry(entry)}
                      >
                        <span className="part-name">
                          {label}
                          {entry.tl > 0 && <span className="part-tl">TL{entry.tl}</span>}
                        </span>
                        <span className="part-fig">{entry.figures}</span>
                        {state.blocked ? (
                          <span className="part-flag blocked">
                            <Icon name="lock" size={11} /> {state.blocked}
                          </span>
                        ) : state.needed ? (
                          <span className="part-flag needed">
                            <Icon name="warning" size={11} /> Needed
                          </span>
                        ) : state.replaces ? (
                          <span className="part-flag">Replaces the one fitted</span>
                        ) : null}
                      </button>
                    );
                  })}
                </section>
              );
            })}
          </div>
        </aside>

        {/* ── hull, manifest ── */}
        <main className="yard-main">
          <div className="panel yard-hull">
            <HullView spec={spec} report={report} selected={selected} onSelect={(id) => setSelected(id ?? 'hull')} editable={canEdit} flagged={flagged} onMove={move} onDropEntry={addEntry} />
            {canEdit && (
              <div className="yard-hull-tools">
                <button className="btn sm ghost" onClick={() => update(arrangeParts(rules, spec))} title="Put everything back in the usual order: command forward, engineering aft">
                  <Icon name="refresh" size={13} /> Tidy layout
                </button>
              </div>
            )}
            {canEdit && (
              <div className="yard-bin" data-drop="bin">
                <Icon name="trash" size={14} /> Drop a part here to remove it
              </div>
            )}
          </div>
          <Manifest report={report} selected={selected} onSelect={setSelected} flagged={flagged} beyondYard={beyondYard} />
        </main>

        {/* ── inspector, figures, checks ── */}
        <aside className="yard-side">
          <div className="panel">
            {selected === CARGO ? (
              <CargoInspector report={report} />
            ) : selectedPart && selectedLine ? (
              <PartInspector
                rules={rules}
                spec={spec}
                report={report}
                part={selectedPart}
                line={selectedLine}
                issues={issues.filter((i) => i.partId === selectedPart.id)}
                canEdit={canEdit}
                onPatch={(patch) => patchPart(selectedPart.id, patch)}
                onRemove={() => removePart(selectedPart.id)}
                onNudge={(dir) => nudge(selectedPart.id, dir)}
              />
            ) : (
              <HullInspector rules={rules} spec={spec} report={report} canEdit={canEdit} yardTl={system && canBuildAnything(yard) ? yard.tl : undefined} onChange={update} />
            )}
          </div>
          <Figures report={report} />
          <div className="panel">
            <div className="panel-head">
              <h3 className="grow">Checks</h3>
              <span className={cx('chip', isBuildable(report) && atYard.length === 0 ? 'ok' : 'danger')}>
                <Icon name={isBuildable(report) && atYard.length === 0 ? 'check' : 'warning'} size={11} />
                {isBuildable(report) ? (atYard.length === 0 ? (system ? 'Can be built here' : 'Design is sound') : 'Not at this yard') : 'Cannot be built yet'}
              </span>
            </div>
            <div className="panel-body">
              {issues.length === 0 ? (
                <p className="small dim">Nothing missing, nothing that does not fit.</p>
              ) : (
                <ul className="issue-list">
                  {issues.map((i, n) => (
                    <li key={n} className={cx(i.level, (i.partId || i.kind) && 'clickable')} onClick={() => i.partId && setSelected(i.partId)}>
                      <Icon name={i.level === 'info' ? 'info' : 'warning'} size={13} />
                      <span>{i.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </aside>
      </div>
      {building && <BuildDialog design={design} report={report} refit={refit} system={system} atYard={atYard} onClose={() => setBuilding(false)} />}
    </div>
  );
}

// ───────────────────────────── figures ─────────────────────────────

function Stat({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}

export function Figures({ report }: { report: DesignReport }) {
  const used = report.lines.filter((l) => l.partId !== 'hull' && l.tons > 0);
  const zones = ZONES.map((z) => ({ ...z, tons: used.filter((l) => zoneOf(l) === z.id).reduce((n, l) => n + l.tons, 0) })).filter((z) => z.tons > 0);
  const over = report.cargo < 0;
  const scale = Math.max(report.hullTons, report.tonsUsed, 1);
  const p = report.power;
  const underThrust = p.basic + p.mdrive + p.other;
  const demand = Math.max(underThrust, p.basic + p.jdrive);
  const powerState = p.output >= demand ? 'ok' : p.output >= p.basic + p.mdrive ? 'warn' : 'danger';
  const hp = report.hardpoints;
  return (
    <div className="panel">
      <div className="panel-head">
        <h3 className="grow">Figures</h3>
        <span className="chip">TL{report.tl} to build</span>
      </div>
      <div className="panel-body col gap-12">
        <div className="stat-row">
          <Stat label="Thrust" value={report.thrust} unit="G" />
          <Stat label="Jump" value={report.jump} unit="pc" />
          <Stat label="Cargo" value={formatTons(Math.max(0, report.cargo))} unit="t" />
          <Stat label="Hull" value={report.hullPoints} />
          <Stat label="Armour" value={`+${report.armour}`} />
        </div>

        <div className="gauge" role="group" aria-label="Tonnage">
          <div className="gauge-head">
            <span>Tonnage</span>
            <span className={cx(over && 'status danger')}>
              {over && <Icon name="warning" size={12} />}
              <b>{formatTons(report.tonsUsed)}</b> of {formatTons(report.hullTons)} t fitted{over ? ` — ${formatTons(-report.cargo)} t over` : ''}
            </span>
          </div>
          <div className="segbar" aria-hidden="true">
            {zones.map((z) => (
              <i key={z.id} style={{ width: `${(z.tons / scale) * 100}%`, background: z.color }} title={`${z.label}: ${formatTons(z.tons)} t`} />
            ))}
          </div>
          <ul className="seg-legend">
            {zones.map((z) => (
              <li key={z.id}>
                <i style={{ background: z.color }} />
                {z.label} <b>{formatTons(z.tons)} t</b>
              </li>
            ))}
            {!over && (
              <li>
                <i className="swatch-empty" />
                Cargo <b>{formatTons(report.cargo)} t</b>
              </li>
            )}
          </ul>
        </div>

        <div className="gauge" role="group" aria-label="Power">
          <div className="gauge-head">
            <span>Power</span>
            <span className={cx('status', powerState)}>
              <Icon name={powerState === 'ok' ? 'check' : 'warning'} size={12} />
              <b>{formatTons(demand)}</b> needed of {formatTons(p.output)} available
            </span>
          </div>
          <div className={cx('meter-track', powerState)} aria-hidden="true">
            <i style={{ width: `${Math.min(100, (demand / Math.max(p.output, demand, 1)) * 100)}%` }} />
            {p.output < demand && <u style={{ left: `${(p.output / demand) * 100}%` }} title="Power available" />}
          </div>
          <dl className="kv-tight">
            <dt>Basic ship systems</dt>
            <dd>{formatTons(p.basic)}</dd>
            <dt>Manoeuvre drive</dt>
            <dd>{formatTons(p.mdrive)}</dd>
            <dt>Jump drive (while jumping)</dt>
            <dd>{formatTons(p.jdrive)}</dd>
            <dt>Sensors, weapons, systems</dt>
            <dd>{formatTons(p.other)}</dd>
          </dl>
        </div>

        <dl className="kv-tight">
          <dt>Fuel</dt>
          <dd>
            {formatTons(report.fuel.tons)} t{report.jump > 0 ? ` · jump-${report.fuel.parsecs}` : ''} · {report.fuel.weeks} weeks
          </dd>
          <dt>{hp.firm ? 'Firmpoints' : 'Hardpoints'}</dt>
          <dd>
            {hp.used} of {hp.total} used
          </dd>
          <dt>Computer</dt>
          <dd>{report.computer?.name ?? 'None'}</dd>
          <dt>Sensors</dt>
          <dd>
            {report.sensors.name} (DM{report.sensors.dm >= 0 ? '+' : ''}
            {report.sensors.dm})
          </dd>
          <dt>Quarters</dt>
          <dd>
            {report.quarters.staterooms + report.quarters.high} staterooms{report.quarters.lowBerths ? ` · ${report.quarters.lowBerths} low berths` : ''}
            {report.quarters.seats ? ` · ${report.quarters.seats} seats` : ''}
          </dd>
          <dt>Atmosphere</dt>
          <dd>{report.streamlined === 'full' ? 'Streamlined' : report.streamlined === 'partial' ? 'Partially streamlined' : 'Cannot enter atmosphere'}</dd>
        </dl>

        <div>
          <div className="section-title">Crew (recommended)</div>
          <dl className="kv-tight">
            {report.crew.map((c) => (
              <span key={c.role} style={{ display: 'contents' }}>
                <dt>
                  {c.name}
                  {c.count > 1 ? ` x${c.count}` : ''}
                </dt>
                <dd>{formatCredits(c.count * c.salary)}/month</dd>
              </span>
            ))}
            <dt>
              <b>Payroll</b>
            </dt>
            <dd>
              <b>{formatCredits(report.payroll)}/month</b>
            </dd>
          </dl>
          {report.stock?.crew && <p className="faint tiny">As published: {report.stock.crew}.</p>}
        </div>

        <div>
          <div className="section-title">Cost</div>
          <dl className="kv-tight">
            <dt>Parts and hull</dt>
            <dd>{formatMCr(report.cost)}</dd>
            {report.discountPct > 0 && (
              <>
                <dt>Standard design discount</dt>
                <dd>-{report.discountPct}%</dd>
              </>
            )}
            <dt>
              <b>Price new</b>
            </dt>
            <dd>
              <b>{formatMCr(report.purchase)}</b>
            </dd>
            <dt>Maintenance</dt>
            <dd>{formatCredits(report.maintenance)}/month</dd>
            <dt>Time in the yard</dt>
            <dd>about {report.buildDays} days</dd>
          </dl>
          {report.stock?.note && <p className="faint tiny">{report.stock.note}</p>}
        </div>
      </div>
    </div>
  );
}

function Manifest({ report, selected, onSelect, flagged, beyondYard }: { report: DesignReport; selected?: string; onSelect: (id: string) => void; flagged: Set<string>; beyondYard: Set<string> }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3 className="grow">Manifest</h3>
        <span className="small dim">{report.lines.length - 1} lines</span>
      </div>
      <div className="manifest-wrap">
        <table className="table manifest">
          <thead>
            <tr>
              <th>Part</th>
              <th>Detail</th>
              <th className="num">Tons</th>
              <th className="num">Power</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {report.lines.map((l) => (
              <tr key={l.partId} className={cx('clickable', selected === l.partId && 'on')} onClick={() => onSelect(l.partId)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(l.partId)}>
                <td>
                  {flagged.has(l.partId) ? (
                    <span className="flag-error" title="Does not fit the design as drawn">
                      <Icon name="warning" size={12} />
                    </span>
                  ) : beyondYard.has(l.partId) ? (
                    <span className="flag-yard" title="The yard here cannot supply this">
                      <Icon name="lock" size={12} />
                    </span>
                  ) : null}
                  {l.label}
                </td>
                <td className="dim">{l.detail}</td>
                <td className="num">{l.tons ? formatTons(l.tons) : '—'}</td>
                <td className="num">{l.output ? `+${formatTons(l.output)}` : l.power ? formatTons(l.power) : '—'}</td>
                <td className="num">{l.cost ? formatMCr(l.cost) : '—'}</td>
              </tr>
            ))}
            <tr className={cx('clickable', selected === CARGO && 'on')} onClick={() => onSelect(CARGO)}>
              <td>Cargo hold</td>
              <td className="dim">Free space</td>
              <td className="num">{formatTons(report.cargo)}</td>
              <td className="num">—</td>
              <td className="num">—</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>Total</td>
              <td className="num">{formatTons(report.hullTons)}</td>
              <td className="num">+{formatTons(report.power.output)}</td>
              <td className="num">{formatMCr(report.cost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ───────────────────────────── commissioning ─────────────────────────────

function BuildDialog({ design, report, refit, system, atYard, onClose }: { design: ShipDesign; report: DesignReport; refit?: Ship; system?: StarSystem; atYard: DesignIssue[]; onClose: () => void }) {
  const rules = useRules().ships!;
  const gm = useIsGm();
  const me = useMe();
  const ships = useType('ship').filter((s) => s.party);
  const characters = useType('character').filter((c): c is Character => c.kind === 'pc' && (gm || c.ownerId === me?.playerId));
  const previous = useMemo(() => (refit?.spec ? evaluateDesign(rules, refit.spec).cost : 0), [rules, refit]);
  const listPrice = refit ? Math.max(0, report.cost - previous) : report.purchase;
  const [payerId, setPayerId] = useState<string>(refit?.id ?? ships[0]?.id ?? characters[0]?.id ?? '');
  const [name, setName] = useState(design.name);
  const [price, setPrice] = useState(listPrice / 1_000_000);
  const [instant, setInstant] = useState(false);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const payer = [...ships, ...characters].find((x) => x.id === payerId);
  const balance = payer ? (payer.type === 'ship' ? (payer.funds ?? 0) : (payer.credits ?? 0)) : 0;
  const cost = gm ? Math.round(price * 1_000_000) : listPrice;
  const blockers = [...report.issues.filter((i) => i.level === 'error'), ...atYard, ...(system ? [] : [{ level: 'error' as const, code: 'nowhere', text: 'The party is not at a starport.' }])];
  const days = instant ? 0 : refit ? Math.ceil(cost / 1_000_000) : report.buildDays;
  const short = !!payer && balance < cost;
  const canGo = (blockers.length === 0 || (gm && force)) && (gm || (!!payer && !short));

  const go = async () => {
    setBusy(true);
    try {
      const res = await act<{ shipId: string; days: number; price: number }>('design.build', {
        id: design.id,
        ...(payerId ? { payerId } : {}),
        ...(refit ? {} : { name: name.trim() || design.name }),
        ...(gm ? { price: cost, instant, force } : {}),
      });
      toast(res.days > 0 ? `${refit ? 'Refit' : 'Construction'} under way: ready in ${res.days} days` : `${refit ? 'Refit' : 'Ship'} complete`, 'ok');
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={refit ? `Refit ${refit.name ?? 'the ship'}` : 'Commission this design'}
      icon="wrench"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canGo || busy} onClick={() => void go()}>
            <Icon name="wrench" size={14} /> {refit ? 'Start the refit' : 'Lay the keel'}
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <dl className="kv-tight">
          <dt>Yard</dt>
          <dd>{system?.name ?? 'None'}</dd>
          <dt>{refit ? 'Cost of the changes' : report.discountPct ? `Price (standard design, -${report.discountPct}%)` : 'Price'}</dt>
          <dd>
            <b>{formatMCr(listPrice)}</b>
          </dd>
          <dt>Time</dt>
          <dd>{days > 0 ? `about ${days} days` : 'ready at once'}</dd>
        </dl>
        {!refit && (
          <Field label="Name of the ship">
            <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        <Field label="Who pays the yard" error={short ? `${formatCredits(balance)} available: ${formatCredits(cost - balance)} short` : undefined} hint={payer && !short ? `${formatCredits(balance)} available` : undefined}>
          <select className="select" value={payerId} onChange={(e) => setPayerId(e.target.value)}>
            {gm && <option value="">Nobody — no payment is taken</option>}
            {ships.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ?? 'Ship'} — ship's account
              </option>
            ))}
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name ?? 'Traveller'} — personal credits
              </option>
            ))}
          </select>
        </Field>
        {blockers.length > 0 && <IssueList issues={blockers} />}
        {gm && (
          <div className="gm-box col gap-4">
            <div className="upper tiny">GM</div>
            <div className="row gap-4">
              <span className="small grow">Price charged</span>
              <Num label="price in megacredits" value={price} min={0} max={1_000_000} step={0.1} suffix="MCr" onCommit={setPrice} />
            </div>
            <label className="check small">
              <input type="checkbox" checked={instant} onChange={(e) => setInstant(e.target.checked)} />
              <span>Ready at once (skip the time in the yard)</span>
            </label>
            <label className="check small">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              <span>Build it regardless of design errors and yard limits</span>
            </label>
          </div>
        )}
      </div>
    </Modal>
  );
}
