/**
 * Drill-down into one star system: a schematic of its stars and bodies, with moons, stations and
 * points of interest hanging off the world they belong to. Players only see the bodies that have
 * been revealed to them.
 */
import { useMemo, useState } from 'react';
import { subsectorOf, parseHex } from '../../../shared/hex';
import { decodeUwp } from '../../../shared/rules/world';
import type { Body, BodyKind, Id } from '../../../shared/types';
import { isValidUwp, parseUwp } from '../../../shared/uwp';
import { PushViewButton } from '../../app/Shell';
import { run, setFields } from '../../net';
import { navigate, setQuery } from '../../router';
import { useCampaign, useIsGm, useRules, useType } from '../../store';
import { ConfirmButton, cx, EditableText, Empty, Field } from '../../ui/basics';
import { Icon, type IconName } from '../../ui/Icon';
import { KnowledgeBadge, KnowledgeControl } from '../../ui/Knowledge';
import { Notes } from '../../ui/Notes';
import { systemLabel, WORLD_COLORS, type MapData, type SysInfo } from './mapData';
import { fitTo, selectSystem } from './mapStore';
import { SystemPanel, TradeCodes } from './SystemPanel';
import { tradeCodesFor } from '../../../shared/rules/world';

const KIND_LABEL: Record<BodyKind, string> = {
  star: 'Star',
  planet: 'Planet',
  gasGiant: 'Gas giant',
  belt: 'Asteroid belt',
  moon: 'Moon',
  station: 'Station',
  poi: 'Point of interest',
};

const KIND_ICON: Record<BodyKind, IconName> = {
  star: 'star',
  planet: 'globe',
  gasGiant: 'globe',
  belt: 'hex',
  moon: 'globe',
  station: 'ship',
  poi: 'pin',
};

function starColor(subtype: string | undefined): string {
  const c = (subtype ?? 'G')[0].toUpperCase();
  switch (c) {
    case 'O':
    case 'B':
      return '#a8c8ff';
    case 'A':
      return '#e6eeff';
    case 'F':
      return '#fff6d8';
    case 'G':
      return '#ffe08a';
    case 'K':
      return '#ffb26b';
    case 'M':
      return '#ff7a5c';
    case 'D':
      return '#f2f6ff';
    default:
      return '#ffe08a';
  }
}

function bodyColor(body: Body, info: SysInfo): string {
  if (body.kind === 'gasGiant') return '#d8b07a';
  if (body.kind === 'belt') return WORLD_COLORS.vacuum;
  if (body.mainworld) return info.color;
  const u = parseUwp(body.uwp);
  if (u) {
    if (u.atm >= 10 && u.atm <= 12) return WORLD_COLORS.exotic;
    if (u.hydro >= 1 && u.atm >= 2) return WORLD_COLORS.water;
    if (u.atm <= 1) return WORLD_COLORS.vacuum;
    return WORLD_COLORS.desert;
  }
  return body.kind === 'moon' ? '#9aa7b5' : '#8fa3b8';
}

const SHORT_LABEL: Record<BodyKind, string> = { star: 'Star', planet: 'Planet', gasGiant: 'Gas giant', belt: 'Belt', moon: 'Moon', station: 'Station', poi: 'Unknown site' };

/** Name to show for a body; unnamed ones are labelled by what they are. */
function bodyName(body: Body): string {
  return body.name ?? SHORT_LABEL[body.kind];
}

/** Distance from a body's centre to where its label starts; belts are taller than their nominal radius. */
function labelOffset(body: Body, r: number): number {
  return body.kind === 'belt' ? 46 : Math.max(r, 20);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface Layout {
  width: number;
  height: number;
  starX: number;
  cy: number;
  stars: { body: Body; x: number; r: number }[];
  columns: { body: Body; x: number; r: number; children: Body[] }[];
}

function layoutSystem(bodies: Body[], info: SysInfo): Layout {
  const stars = bodies.filter((b) => b.kind === 'star').sort((a, b) => a.orbit - b.orbit);
  const top = bodies.filter((b) => b.kind !== 'star' && !b.parentId).sort((a, b) => a.orbit - b.orbit);
  const childrenOf = (id: Id) => bodies.filter((b) => b.parentId === id).sort((a, b) => a.orbit - b.orbit);
  // Children of stars (rare) and orphans are shown as top-level columns too.
  const known = new Set(bodies.map((b) => b.id));
  const orphans = bodies.filter((b) => b.kind !== 'star' && b.parentId && (!known.has(b.parentId) || stars.some((s) => s.id === b.parentId)));
  const columnBodies = [...top, ...orphans.filter((o) => !top.includes(o))];

  const cy = 150;
  const starX = 90;
  const starLayout = stars.map((body, i) => ({ body, x: starX - i * 6 + i * 46, r: i === 0 ? 44 : 22 }));
  const firstX = starX + 120 + Math.max(0, stars.length - 1) * 40;
  const dx = 132;
  const radius = (b: Body) => {
    if (b.kind === 'gasGiant') return 27;
    if (b.kind === 'belt') return 22;
    if (b.kind === 'station' || b.kind === 'poi') return 10;
    if (b.mainworld && info.uwp) return 9 + Math.min(10, Math.max(1, info.uwp.size)) * 1.1;
    const u = parseUwp(b.uwp);
    return u ? 8 + Math.min(10, Math.max(1, u.size)) : 12;
  };
  const columns = columnBodies.map((body, i) => ({ body, x: firstX + i * dx, r: radius(body), children: childrenOf(body.id) }));
  const deepest = Math.max(0, ...columns.map((c) => c.children.length));
  return {
    width: Math.max(760, firstX + Math.max(columns.length, 1) * dx + 20),
    height: 250 + deepest * 30,
    starX,
    cy,
    stars: starLayout,
    columns,
  };
}

function Schematic({ bodies, info, selectedId, onSelect, gm }: { bodies: Body[]; info: SysInfo; selectedId?: Id; onSelect: (id: Id | undefined) => void; gm: boolean }) {
  const layout = useMemo(() => layoutSystem(bodies, info), [bodies, info]);
  const hiddenFromParty = (b: Body) => gm && !(b.known?.exists?.includes('party') ?? false);
  const pick = (e: React.MouseEvent | React.KeyboardEvent, id: Id) => {
    e.stopPropagation();
    onSelect(id);
  };
  const keyPick = (id: Id) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(e, id);
    }
  };

  return (
    <svg className="orbit-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} style={{ minWidth: layout.width * 0.72 }} onClick={() => onSelect(undefined)} role="group" aria-label={`Bodies of the ${systemLabel(info)} system`}>
      <defs>
        <radialGradient id="star-glow">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="45%" stopColor="currentColor" stopOpacity="0.9" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="sphere" cx="35%" cy="32%" r="75%">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="45%" stopColor="#fff" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.45" />
        </radialGradient>
      </defs>

      {/* Orbit arcs through each column. */}
      {layout.columns.map((c) => (
        <circle key={`o-${c.body.id}`} cx={layout.starX} cy={layout.cy} r={c.x - layout.starX} className="orbit-arc" />
      ))}

      {layout.stars.length === 0 && (
        <text x={layout.starX} y={layout.cy} className="orbit-missing" textAnchor="middle">
          ?
        </text>
      )}
      {layout.stars.map(({ body, x, r }) => (
        <g key={body.id} className={cx('orbit-body', selectedId === body.id && 'on')} tabIndex={0} role="button" aria-label={bodyName(body)} onClick={(e) => pick(e, body.id)} onKeyDown={keyPick(body.id)} style={{ color: starColor(body.subtype) }}>
          <circle cx={x} cy={layout.cy} r={r * 1.9} fill="url(#star-glow)" opacity={0.55} />
          <circle cx={x} cy={layout.cy} r={r} fill="currentColor" />
          <circle cx={x} cy={layout.cy} r={r} fill="url(#sphere)" />
          {selectedId === body.id && <circle cx={x} cy={layout.cy} r={r + 6} className="orbit-select" />}
          {hiddenFromParty(body) && <circle cx={x} cy={layout.cy} r={r + 3} className="orbit-hidden" />}
          <text x={x} y={layout.cy + r + 22} className="orbit-label" textAnchor="middle">
            {body.subtype ?? 'Star'}
          </text>
        </g>
      ))}

      {layout.columns.map(({ body, x, r, children }) => {
        const color = bodyColor(body, info);
        const selected = selectedId === body.id;
        return (
          <g key={body.id}>
            <g className={cx('orbit-body', selected && 'on')} tabIndex={0} role="button" aria-label={`${bodyName(body)}, ${KIND_LABEL[body.kind]}`} onClick={(e) => pick(e, body.id)} onKeyDown={keyPick(body.id)}>
              {/* Generous hit area. */}
              <circle cx={x} cy={layout.cy} r={Math.max(r + 10, 26)} fill="transparent" />
              {body.kind === 'belt' ? (
                <g fill={color}>
                  {Array.from({ length: 22 }, (_, i) => {
                    const a = (i * 137.5 * Math.PI) / 180;
                    const rr = 4 + ((i * 7) % 13) * 1.4;
                    return <circle key={i} cx={x + Math.cos(a) * rr * 0.55} cy={layout.cy + Math.sin(a) * rr * 2.1} r={1.2 + (i % 3) * 0.7} opacity={0.55 + (i % 4) * 0.12} />;
                  })}
                </g>
              ) : body.kind === 'station' ? (
                <g>
                  <rect x={x - r} y={layout.cy - r} width={r * 2} height={r * 2} transform={`rotate(45 ${x} ${layout.cy})`} fill="#0b121d" stroke="#9af0ff" strokeWidth={1.8} />
                  <circle cx={x} cy={layout.cy} r={2.5} fill="#9af0ff" />
                </g>
              ) : body.kind === 'poi' ? (
                <g transform={`translate(${x - 9} ${layout.cy - 12})`} stroke="#ffb347" fill="#0b121d" strokeWidth={1.6}>
                  <path d="M9 22s-7-6.200-7-11.500a7 7 0 1 1 14 0C16 15.800 9 22 9 22Z" />
                  <circle cx={9} cy={10} r={2.3} fill="#ffb347" stroke="none" />
                </g>
              ) : (
                <>
                  {body.kind === 'gasGiant' && <ellipse cx={x} cy={layout.cy} rx={r * 1.75} ry={r * 0.36} className="ring back" transform={`rotate(-14 ${x} ${layout.cy})`} />}
                  <circle cx={x} cy={layout.cy} r={r} fill={color} />
                  {body.kind === 'gasGiant' && (
                    <g clipPath={`circle(${r}px at ${x}px ${layout.cy}px)`} opacity={0.35} stroke="#6b4a22" strokeWidth={3}>
                      <line x1={x - r} y1={layout.cy - r * 0.45} x2={x + r} y2={layout.cy - r * 0.55} />
                      <line x1={x - r} y1={layout.cy + r * 0.05} x2={x + r} y2={layout.cy - r * 0.05} />
                      <line x1={x - r} y1={layout.cy + r * 0.5} x2={x + r} y2={layout.cy + r * 0.4} />
                    </g>
                  )}
                  <circle cx={x} cy={layout.cy} r={r} fill="url(#sphere)" />
                  {body.kind === 'gasGiant' && <path d={`M ${x - r * 1.75} ${layout.cy} A ${r * 1.75} ${r * 0.36} 0 0 0 ${x + r * 1.75} ${layout.cy}`} className="ring" transform={`rotate(-14 ${x} ${layout.cy})`} />}
                </>
              )}
              {selected && <circle cx={x} cy={layout.cy} r={Math.max(r, 16) + 8} className="orbit-select" />}
              {hiddenFromParty(body) && <circle cx={x} cy={layout.cy} r={Math.max(r, 16) + 4} className="orbit-hidden" />}
              {body.mainworld && (
                <text x={x} y={layout.cy - Math.max(r, 16) - 14} className="orbit-tag" textAnchor="middle">
                  MAINWORLD
                </text>
              )}
              <text x={x} y={layout.cy + labelOffset(body, r) + 20} className="orbit-label" textAnchor="middle">
                {clip(bodyName(body), 17)}
              </text>
              <text x={x} y={layout.cy + labelOffset(body, r) + 35} className="orbit-sub" textAnchor="middle">
                {body.mainworld ? (info.sys.uwp ?? '') : (body.uwp ?? (body.name ? SHORT_LABEL[body.kind] : ''))}
              </text>
            </g>
            {children.map((child, i) => {
              const y = layout.cy + labelOffset(body, r) + 60 + i * 30;
              const on = selectedId === child.id;
              return (
                <g key={child.id} className={cx('orbit-child', on && 'on', hiddenFromParty(child) && 'gm-hidden')} tabIndex={0} role="button" aria-label={`${bodyName(child)}, ${KIND_LABEL[child.kind]}`} onClick={(e) => pick(e, child.id)} onKeyDown={keyPick(child.id)}>
                  <line x1={x - 44} y1={y - (i === 0 ? 22 : 30)} x2={x - 44} y2={y} className="orbit-link" />
                  <line x1={x - 44} y1={y} x2={x - 34} y2={y} className="orbit-link" />
                  <rect x={x - 36} y={y - 12} width={150} height={24} rx={3} className="orbit-child-bg" />
                  {child.kind === 'poi' ? (
                    <path d={`M ${x - 24} ${y + 7} l -5 -8 a 5 5 0 1 1 10 0 Z`} fill="#ffb347" />
                  ) : child.kind === 'station' ? (
                    <rect x={x - 28} y={y - 4} width={8} height={8} transform={`rotate(45 ${x - 24} ${y})`} fill="none" stroke="#9af0ff" strokeWidth={1.5} />
                  ) : (
                    <circle cx={x - 24} cy={y} r={5} fill={bodyColor(child, info)} />
                  )}
                  <text x={x - 12} y={y + 4} className="orbit-child-label">
                    {clip(bodyName(child), 20)}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

const ADDABLE: { kind: BodyKind; label: string; child: boolean }[] = [
  { kind: 'planet', label: 'Planet', child: false },
  { kind: 'gasGiant', label: 'Gas giant', child: false },
  { kind: 'belt', label: 'Belt', child: false },
  { kind: 'moon', label: 'Moon', child: true },
  { kind: 'station', label: 'Station', child: true },
  { kind: 'poi', label: 'Point of interest', child: true },
];

function BodyPanel({ body, info, bodies, onSelect }: { body: Body; info: SysInfo; bodies: Body[]; onSelect: (id: Id | undefined) => void }) {
  const gm = useIsGm();
  const rules = useRules().world;
  const campaign = useCampaign();
  const uwpText = body.mainworld ? info.sys.uwp : body.uwp;
  const decoded = useMemo(() => decodeUwp(uwpText, rules), [uwpText, rules]);
  const codes = useMemo(() => (body.mainworld ? info.codes : tradeCodesFor(parseUwp(body.uwp), rules)), [body, info.codes, rules]);
  const children = bodies.filter((b) => b.parentId === body.id).sort((a, b) => a.orbit - b.orbit);
  const parent = body.parentId ? bodies.find((b) => b.id === body.parentId) : undefined;
  const partyHere = campaign?.location?.bodyId === body.id;
  const canHaveChildren = body.kind !== 'poi';

  const add = async (kind: BodyKind) => {
    const res = await run<{ id: Id }>('body.create', { systemId: info.sys.id, parentId: body.id, kind, name: kind === 'poi' ? 'New site' : undefined });
    if (res?.id) onSelect(res.id);
  };

  return (
    <div className="side-scroll">
      <div className="section">
        <div className="row top">
          <div className="grow">
            <div className="row tiny faint upper">
              <Icon name={KIND_ICON[body.kind]} size={12} /> {KIND_LABEL[body.kind]}
              {body.mainworld && <span className="chip accent">Mainworld</span>}
            </div>
            <h2 style={{ fontSize: 17, marginTop: 4 }}>
              <EditableText value={body.name} disabled={!gm} placeholder={gm ? 'Unnamed — click to name' : bodyName(body)} onCommit={(name) => void setFields(body.id, { name: name || undefined })} />
            </h2>
            <div className="small dim">
              {parent ? (
                <>
                  At{' '}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      onSelect(parent.id);
                    }}
                  >
                    {bodyName(parent)}
                  </a>
                  ,{' '}
                </>
              ) : null}
              {systemLabel(info)} system
            </div>
          </div>
          {gm && <KnowledgeBadge entity={body} />}
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          {uwpText && <span className="uwp">{uwpText}</span>}
          {body.subtype && <span className="chip">{body.subtype}</span>}
          {partyHere && (
            <span className="chip accent">
              <Icon name="pin" size={11} /> Party is here
            </span>
          )}
        </div>
        {codes.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <TradeCodes codes={codes} />
          </div>
        )}
        {(body.summary || gm) && (
          <p className="small" style={{ marginTop: 10, marginBottom: 0 }}>
            <EditableText multiline value={body.summary} disabled={!gm} placeholder="Add a short description players will see once details are revealed" onCommit={(summary) => void setFields(body.id, { summary: summary || undefined })} />
          </p>
        )}
        {gm && (
          <div className="row wrap" style={{ marginTop: 10 }}>
            {!partyHere && (
              <button className="btn sm gm" onClick={() => void run('party.moveTo', { systemId: info.sys.id, bodyId: body.id }, 'Party location updated')}>
                <Icon name="pin" size={12} /> Party is here
              </button>
            )}
            <PushViewButton path={`/map/system/${info.sys.id}?body=${body.id}`} />
          </div>
        )}
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

      {canHaveChildren && (children.length > 0 || gm) && (
        <div className="section">
          <div className="section-title">
            <h3>Here</h3>
          </div>
          <div className="col gap-4">
            {children.map((c) => (
              <button key={c.id} className="objective-pill" onClick={() => onSelect(c.id)}>
                <Icon name={KIND_ICON[c.kind]} size={13} style={{ color: c.kind === 'poi' ? 'var(--warn)' : 'var(--accent)' }} />
                <span className="grow">{bodyName(c)}</span>
                <span className="tiny faint">{c.subtype ?? KIND_LABEL[c.kind]}</span>
                {gm && !(c.known?.exists?.includes('party') ?? false) && <Icon name="eyeOff" size={12} style={{ color: 'var(--gm)' }} />}
              </button>
            ))}
            {children.length === 0 && <span className="faint small">Nothing recorded here yet.</span>}
          </div>
          {gm && (
            <div className="row wrap" style={{ marginTop: 8 }}>
              {ADDABLE.filter((a) => a.child).map((a) => (
                <button key={a.kind} className="btn sm" onClick={() => void add(a.kind)}>
                  <Icon name="plus" size={12} /> {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {gm && (
        <div className="section gm-section">
          <h3>Who knows what</h3>
          <KnowledgeControl entity={body} />
        </div>
      )}

      <Notes entity={body} />

      {gm && (
        <div className="section col gap-12">
          <h3>Edit</h3>
          <div className="grid-2">
            <Field label="Type">
              <select className="select" value={body.kind} disabled={body.mainworld} onChange={(e) => void setFields(body.id, { kind: e.target.value })}>
                {(Object.keys(KIND_LABEL) as BodyKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={body.kind === 'star' ? 'Spectral class' : body.kind === 'poi' ? 'Category' : 'Classification'}>
              <input className="input" defaultValue={body.subtype ?? ''} key={`${body.id}-st`} placeholder={body.kind === 'poi' ? 'ruins, city, base…' : ''} onBlur={(e) => e.target.value.trim() !== (body.subtype ?? '') && void setFields(body.id, { subtype: e.target.value.trim() || undefined })} />
            </Field>
            {!body.mainworld && body.kind !== 'star' && body.kind !== 'poi' && (
              <Field label="World profile" hint="Optional, for inhabited secondary worlds.">
                <input
                  className="input mono"
                  defaultValue={body.uwp ?? ''}
                  key={`${body.id}-uwp`}
                  maxLength={9}
                  placeholder="D500264-8"
                  onBlur={(e) => {
                    const next = e.target.value.trim().toUpperCase();
                    if (next === (body.uwp ?? '')) return;
                    if (next && !isValidUwp(next)) e.target.classList.add('invalid');
                    else {
                      e.target.classList.remove('invalid');
                      void setFields(body.id, { uwp: next || undefined });
                    }
                  }}
                />
              </Field>
            )}
            <Field label="Order" hint="Lower numbers are closer in.">
              <input className="input mono" type="number" step="0.5" defaultValue={body.orbit} key={`${body.id}-o`} onBlur={(e) => Number(e.target.value) !== body.orbit && void setFields(body.id, { orbit: Number(e.target.value) || 0 })} />
            </Field>
          </div>
          {body.mainworld ? (
            <span className="tiny faint">The mainworld&apos;s profile is the system&apos;s UWP; edit it from the system details.</span>
          ) : (
            <div>
              <ConfirmButton
                label="Delete"
                confirm={children.length ? `Delete with ${children.length} item${children.length === 1 ? '' : 's'} here` : 'Delete'}
                icon="trash"
                onConfirm={() => {
                  onSelect(parent?.id);
                  void run('entity.delete', { id: body.id });
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SystemView({ systemId, bodyId, data }: { systemId: Id; bodyId?: Id; data: MapData }) {
  const gm = useIsGm();
  const allBodies = useType('body');
  const info = data.byId.get(systemId);
  const bodies = useMemo(() => allBodies.filter((b) => b.systemId === systemId), [allBodies, systemId]);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const selected = bodyId ? bodies.find((b) => b.id === bodyId) : undefined;
  const select = (id: Id | undefined) => setQuery({ body: id }, { replace: true });

  const backToMap = () => {
    if (info) {
      selectSystem(info.sys.id, { gx: info.gx, gy: info.gy });
      fitTo({ kind: 'system', id: info.sys.id });
    }
    navigate('/map');
  };

  if (!info) {
    return (
      <div className="page">
        <Empty icon="globe" title="System not available">
          It may have been removed, or it is not known to you.
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => navigate('/map')}>
              Back to the map
            </button>
          </div>
        </Empty>
      </div>
    );
  }

  const h = parseHex(info.sys.hex)!;
  const letter = subsectorOf(h.col, h.row);
  const add = async (kind: BodyKind) => {
    const res = await run<{ id: Id }>('body.create', { systemId, kind });
    if (res?.id) select(res.id);
  };

  return (
    <div className="map-page">
      <div className="map-main sysview">
        <div className="sysview-head">
          <button className="btn sm" onClick={backToMap}>
            <Icon name="chevronLeft" size={13} /> Map
          </button>
          <nav className="map-crumbs static" aria-label="Location">
            <button
              onClick={() => {
                fitTo({ kind: 'sector', id: info.sector.id });
                navigate('/map');
              }}
            >
              {info.sector.name}
            </button>
            <Icon name="chevronRight" size={12} />
            <button
              onClick={() => {
                fitTo({ kind: 'subsector', id: info.sector.id, letter });
                navigate('/map');
              }}
            >
              {info.sector.subsectors[letter] ?? `Subsector ${letter}`}
            </button>
            <Icon name="chevronRight" size={12} />
            <button className={cx(!selected && 'on')} onClick={() => select(undefined)}>
              {systemLabel(info)}
            </button>
            {selected && (
              <>
                <Icon name="chevronRight" size={12} />
                <button className="on">{bodyName(selected)}</button>
              </>
            )}
          </nav>
          <div className="grow" />
          {info.sys.uwp && <span className="uwp">{info.sys.uwp}</span>}
          <PushViewButton path={`/map/system/${systemId}`} />
        </div>

        <div className="orbit-stage">
          {bodies.length === 0 ? (
            <Empty icon="globe" title="No survey of this system">
              {gm ? 'This system has no bodies yet. Add some below, or rebuild them from its survey data.' : 'Nothing is known about what orbits here.'}
            </Empty>
          ) : (
            <Schematic bodies={bodies} info={info} selectedId={selected?.id} onSelect={select} gm={gm} />
          )}
        </div>

        {gm && (
          <div className="sysview-tools">
            <span className="label">Add to system</span>
            {ADDABLE.filter((a) => !a.child).map((a) => (
              <button key={a.kind} className="btn sm" onClick={() => void add(a.kind)}>
                <Icon name="plus" size={12} /> {a.label}
              </button>
            ))}
            <button className="btn sm" onClick={() => void add('station')}>
              <Icon name="plus" size={12} /> Station
            </button>
            <span className="tiny faint">Select a world to add moons, stations and points of interest to it.</span>
            <div className="grow" />
            {confirmRebuild ? (
              <>
                <span className="tiny" style={{ color: 'var(--warn)' }}>
                  Replaces stars, gas giants and belts from the survey data. Your own additions are kept.
                </span>
                <button
                  className="btn sm danger"
                  onClick={() => {
                    setConfirmRebuild(false);
                    void run('system.rebuildBodies', { id: systemId }, 'Survey bodies rebuilt');
                  }}
                >
                  Rebuild
                </button>
                <button className="btn sm ghost" onClick={() => setConfirmRebuild(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn sm ghost" onClick={() => setConfirmRebuild(true)} title="Recreate the stars, mainworld, gas giants and belts from the system's survey data">
                <Icon name="refresh" size={12} /> Rebuild from survey
              </button>
            )}
          </div>
        )}
      </div>

      <aside className="map-side">{selected ? <BodyPanel key={selected.id} body={selected} info={info} bodies={bodies} onSelect={select} /> : <SystemPanel key={info.sys.id} info={info} />}</aside>
    </div>
  );
}
