/** The inspector: sizing and options for whichever part of the design is selected. */
import { useEffect, useState, type ReactNode } from 'react';
import { OUTLINES, outlineOf, parseOutlineText } from '../../../shared/outlines';
import type { PartOptionDef, ShipRules } from '../../../shared/rulepack';
import { formatMCr, formatTons, fuelTonsFor, inSentence, type DesignIssue, type DesignReport, type PartLine } from '../../../shared/rules/ship';
import type { DesignPart, ShipOutline, ShipSpec } from '../../../shared/types';
import { upload } from '../../net';
import { toast } from '../../store';
import { cx, Field, Modal } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { CARGO } from './hullLayout';

/** A number box that commits when you leave it or press Enter, so half-typed values are never sent. */
export function Num({
  value,
  onCommit,
  min = 0,
  max = 1_000_000,
  step = 1,
  disabled,
  suffix,
  width = 84,
  label,
}: {
  value: number;
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  suffix?: string;
  width?: number;
  label?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || draft.trim() === '') {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <span className="num-box">
      <input
        className="input mono"
        style={{ width }}
        type="number"
        inputMode="decimal"
        aria-label={label}
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {suffix && <span className="faint small">{suffix}</span>}
    </span>
  );
}

export function Stepper({ value, onChange, min, max, disabled, label }: { value: number; onChange: (n: number) => void; min: number; max: number; disabled?: boolean; label: string }) {
  return (
    <span className="stepper" role="group" aria-label={label}>
      <button className="btn sm icon" disabled={disabled || value <= min} onClick={() => onChange(value - 1)} aria-label={`Less ${label}`}>
        <Icon name="minus" size={13} />
      </button>
      <b className="mono">{value}</b>
      <button className="btn sm icon" disabled={disabled || value >= max} onClick={() => onChange(value + 1)} aria-label={`More ${label}`}>
        <Icon name="plus" size={13} />
      </button>
    </span>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="insp-row">
      <span className="dim small">{label}</span>
      <span className="insp-ctl">{children}</span>
    </div>
  );
}

function IssueList({ issues }: { issues: DesignIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="issue-list">
      {issues.map((i, n) => (
        <li key={n} className={i.level}>
          <Icon name={i.level === 'info' ? 'info' : 'warning'} size={13} />
          <span>{i.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Tick-boxes for the options a part can take, greyed out where the hull, the tech level or another option rules one out. */
function OptionChecks({ defs, chosen, itemKey, hullTons, tl, disabled, onChange }: { defs: PartOptionDef[] | undefined; chosen: string[] | undefined; itemKey?: string; hullTons: number; tl: number; disabled: boolean; onChange: (next: string[]) => void }) {
  const offered = (defs ?? []).filter((o) => !o.appliesTo || itemKey === undefined || o.appliesTo.includes(itemKey) || chosen?.includes(o.id));
  if (offered.length === 0) return null;
  const picked = new Set(chosen ?? []);
  return (
    <div className="col gap-4">
      {offered.map((o) => {
        const clash = offered.find((other) => other.id !== o.id && picked.has(other.id) && (other.excludes?.includes(o.id) || o.excludes?.includes(other.id)));
        const why =
          (o.tl ?? 0) > tl
            ? `TL${o.tl}`
            : o.overTons !== undefined && hullTons <= o.overTons
              ? `hulls over ${o.overTons.toLocaleString('en-GB')} tons`
              : o.maxTons !== undefined && hullTons > o.maxTons
                ? `hulls up to ${o.maxTons.toLocaleString('en-GB')} tons`
                : clash
                  ? `not with ${inSentence(clash.name)}`
                  : undefined;
        const on = picked.has(o.id);
        return (
          <label key={o.id} className="check" title={o.note}>
            <input
              type="checkbox"
              checked={on}
              disabled={disabled || (!!why && !on)}
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(o.id);
                else next.delete(o.id);
                onChange([...next]);
              }}
            />
            <span>
              {o.name}
              {why ? <span className="faint"> · {why}</span> : o.tl ? <span className="faint"> · TL{o.tl}</span> : null}
              {o.note && <span className="faint tiny block">{o.note}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Build quality: a component made ahead of or behind its tech level, and the advantages or drawbacks that brings. */
function BuildQuality({ rules, tag, part, turret, disabled, onPatch }: { rules: ShipRules; tag: string; part: DesignPart; turret?: boolean; disabled: boolean; onPatch: (patch: Partial<DesignPart>) => void }) {
  const table = rules.customising;
  if (!table) return null;
  const grade = table.grades.find((g) => g.id === part.grade);
  const advantages = (grade?.advantages ?? 0) > 0;
  const allowed = grade ? (grade.advantages ?? grade.disadvantages ?? 0) : 0;
  const choices = grade ? table.mods.filter((m) => m.kinds.includes(tag) && m.advantage === advantages && !(m.notTurrets && turret)) : [];
  const mods = part.mods ?? [];
  const used = mods.reduce((n, id) => n + (table.mods.find((m) => m.id === id)?.slots ?? 1), 0);
  const word = advantages ? 'advantage' : 'drawback';
  const setCount = (id: string, n: number) => onPatch({ mods: [...mods.filter((m) => m !== id), ...Array.from({ length: n }, () => id)] });
  if (!table.mods.some((m) => m.kinds.includes(tag))) return null;
  return (
    <details className="insp-more" open={!!part.grade}>
      <summary>
        Build quality: <b>{grade?.name ?? 'Standard'}</b>
      </summary>
      <div className="col gap-4">
        <select
          className="select"
          aria-label="Build quality"
          value={part.grade ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const next = table.grades.find((g) => g.id === e.target.value);
            const keep = next && grade && (next.advantages ?? 0) > 0 === advantages;
            onPatch({ grade: next?.id, mods: keep ? mods : undefined });
          }}
        >
          <option value="">Standard</option>
          {table.grades.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} · TL{g.tlShift >= 0 ? '+' : ''}
              {g.tlShift} · {g.costMult >= 1 ? '+' : ''}
              {Math.round((g.costMult - 1) * 100)}% cost · {g.advantages ? `${g.advantages} advantage${g.advantages > 1 ? 's' : ''}` : `${g.disadvantages} drawback${(g.disadvantages ?? 0) > 1 ? 's' : ''}`}
            </option>
          ))}
        </select>
        {grade && (
          <>
            <div className={cx('small', used > allowed ? 'status danger' : 'dim')}>
              {used} of {allowed} {word}
              {allowed === 1 ? '' : 's'} chosen
            </div>
            {choices.map((m) => {
              const n = mods.filter((id) => id === m.id).length;
              const cost = m.slots ?? 1;
              const room = Math.floor((allowed - used) / cost);
              return (
                <div key={m.id} className="insp-row" title={m.effect}>
                  <span className="small">
                    {m.name}
                    {cost > 1 ? <span className="faint"> · counts as {cost}</span> : null}
                    {m.effect && <span className="faint tiny block">{m.effect}</span>}
                  </span>
                  <span className="insp-ctl">
                    <Stepper label={m.name} value={n} min={0} max={m.once ? Math.min(1, n + Math.max(0, room)) : n + Math.max(0, room)} disabled={disabled} onChange={(v) => setCount(m.id, v)} />
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </details>
  );
}

interface PartProps {
  rules: ShipRules;
  spec: ShipSpec;
  report: DesignReport;
  part: DesignPart;
  line: PartLine;
  issues: DesignIssue[];
  canEdit: boolean;
  onPatch: (patch: Partial<DesignPart>) => void;
  onRemove: () => void;
  onNudge: (dir: -1 | 1) => void;
}

export function PartInspector({ rules, spec, report, part, line, issues, canEdit, onPatch, onRemove, onNudge }: PartProps) {
  const off = !canEdit;
  const toggle = (list: string[] | undefined, id: string, on: boolean) => {
    const set = new Set(list ?? []);
    if (on) set.add(id);
    else set.delete(id);
    return [...set];
  };
  let controls: ReactNode = null;

  switch (part.kind) {
    case 'armour': {
      const def = rules.armour.find((a) => a.id === part.key);
      const hullOptions = (spec.hull.options ?? []).map((id) => rules.hull.options.find((o) => o.id === id));
      const cap = Math.min(def?.maxByTl ? spec.tl + (def.maxTlPlus ?? 0) : 99, def?.max ?? 99) * hullOptions.reduce((n, o) => n * (o?.armourMaxMult ?? 1), 1);
      controls = (
        <Row label={`Protection (up to +${cap} at TL${spec.tl})`}>
          <Stepper label="protection" value={part.rating ?? 1} min={1} max={Math.max(cap, part.rating ?? 1)} disabled={off} onChange={(rating) => onPatch({ rating })} />
        </Row>
      );
      break;
    }
    case 'mdrive':
    case 'rdrive':
    case 'jdrive': {
      const def = part.kind === 'jdrive' ? rules.jdrive : part.kind === 'rdrive' ? rules.rdrive : rules.mdrive;
      if (!def) break;
      const jump = part.kind === 'jdrive';
      const shift = rules.customising?.grades.find((g) => g.id === part.grade)?.tlShift ?? 0;
      const allowed = def.tl.filter((tl) => tl + shift <= spec.tl).length;
      const floor = def.zero ? 0 : 1;
      const rating = part.rating ?? 1;
      const nextTl = def.tl[rating] !== undefined ? def.tl[rating] + shift : undefined;
      const basis = part.tons && part.tons > 0 ? part.tons : spec.hull.tons;
      controls = (
        <>
          <Row label={jump ? 'Jump rating' : 'Thrust'}>
            <Stepper label={jump ? 'jump rating' : 'thrust'} value={rating} min={floor} max={Math.max(allowed, rating)} disabled={off} onChange={(r) => onPatch({ rating: r })} />
          </Row>
          <p className="faint tiny">
            {rating >= def.tl.length || nextTl === undefined ? 'This is as far as the rules go.' : nextTl > spec.tl ? `The next step needs TL${nextTl}.` : `TL${spec.tl} allows up to ${jump ? 'Jump-' : 'Thrust '}${allowed}.`}
            {jump ? ` Each parsec jumped burns ${formatTons(report.fuel.perParsec)} tons of fuel.` : ''}
            {part.kind === 'rdrive' ? ` At full thrust it burns ${formatTons(report.reaction.fuelPerHour)} tons of fuel an hour; the tanks give it ${report.reaction.hours} hours.` : ''}
            {rating === 0 ? ' Rating 0 holds a station in its orbit and no more.' : ''}
          </p>
          <OptionChecks defs={def.options} chosen={part.options} hullTons={spec.hull.tons} tl={spec.tl} disabled={off} onChange={(options) => onPatch({ options })} />
          <details className="insp-more" open={basis !== spec.hull.tons}>
            <summary>Sized for {basis === spec.hull.tons ? 'this hull' : <b>{formatTons(basis)} tons</b>}</summary>
            <Row label="Tonnage the drive is built to move">
              <Num label="tonnage the drive is sized for" value={basis} min={1} max={2_000_000} step={10} disabled={off} suffix="tons" onCommit={(tons) => onPatch({ tons: tons === spec.hull.tons ? undefined : tons })} />
            </Row>
            <p className="faint tiny">Size the drive for more than the hull if the ship will carry drop tanks, external cargo or craft on clamps; for less, and it delivers a lower rating.</p>
          </details>
          <BuildQuality rules={rules} tag={part.kind} part={part} disabled={off} onPatch={onPatch} />
        </>
      );
      break;
    }
    case 'plant': {
      const def = rules.plants.find((p) => p.id === part.key);
      const others = report.power.output - line.output;
      const sized = (everything: boolean) => {
        const need = report.power.basic + Math.max(report.power.mdrive + (everything ? report.power.other : 0), report.power.jdrive);
        return Math.max(1, Math.ceil(Math.round(((need - others) / (def?.powerPerTon ?? 1)) * 1000) / 1000));
      };
      controls = (
        <>
          <Row label="Size">
            <Num label="power plant tons" value={part.tons ?? 0} min={0} step={1} disabled={off} suffix="tons" onCommit={(tons) => onPatch({ tons })} />
          </Row>
          {canEdit && (
            <div className="row wrap gap-4">
              <button className="btn sm" onClick={() => onPatch({ tons: sized(false) })} title="Basic systems plus the manoeuvre drive, or a jump, whichever needs more">
                Size for the drives ({sized(false)} t)
              </button>
              <button className="btn sm" onClick={() => onPatch({ tons: sized(true) })} title="Basic systems, the manoeuvre drive and every powered system at once">
                Run everything ({sized(true)} t)
              </button>
            </div>
          )}
          <p className="faint tiny">
            {part.grade ? 'The size above is the standard article; build quality changes what it takes up. ' : ''}
            The ship's power plants burn {formatTons(report.fuel.perPeriod)} tons of fuel every four weeks.{def?.noJump ? ' This type cannot feed a jump drive.' : ''}
          </p>
          <BuildQuality rules={rules} tag="plant" part={part} disabled={off} onPatch={onPatch} />
        </>
      );
      break;
    }
    case 'fuel': {
      const weeksOptions = [4, 8, 12];
      controls = (
        <>
          <Row label="Tankage">
            <Num label="fuel tons" value={part.tons ?? 0} min={0} step={1} disabled={off} suffix="tons" onCommit={(tons) => onPatch({ tons })} />
          </Row>
          {canEdit && (
            <div className="row wrap gap-4">
              {weeksOptions.map((w) => {
                const tons = fuelTonsFor(rules, report, w) - (report.fuel.tons - (part.tons ?? 0));
                return (
                  <button key={w} className="btn sm" onClick={() => onPatch({ tons: Math.max(0, tons) })}>
                    {report.jump > 0 ? `J-${report.jump} + ` : ''}
                    {w} weeks ({formatTons(Math.max(0, tons))} t)
                  </button>
                );
              })}
            </div>
          )}
          {canEdit && report.reaction.fuelPerHour > 0 && (
            <div className="row wrap gap-4">
              {[1, 4].map((h) => (
                <button key={h} className="btn sm" onClick={() => onPatch({ tons: Math.round(((part.tons ?? 0) + report.reaction.fuelPerHour * h) * 1000) / 1000 })}>
                  +{h} hour{h > 1 ? 's' : ''} of reaction thrust ({formatTons(report.reaction.fuelPerHour * h)} t)
                </button>
              ))}
            </div>
          )}
          <p className="faint tiny">
            {report.jump > 0 ? `One parsec of jump takes ${formatTons(report.fuel.perParsec)} tons. ` : ''}
            The power plant uses {formatTons(report.fuel.perPeriod)} tons every four weeks.
            {report.reaction.fuelPerHour > 0 ? ` The reaction drive burns ${formatTons(report.reaction.fuelPerHour)} tons an hour at full thrust.` : ''}
          </p>
          <OptionChecks defs={rules.fuel.options} chosen={part.options} hullTons={spec.hull.tons} tl={spec.tl} disabled={off} onChange={(options) => onPatch({ options })} />
        </>
      );
      break;
    }
    case 'bridge':
    case 'computer':
    case 'sensors': {
      const options = part.kind === 'bridge' ? (part.key === 'bridge' || !part.key ? rules.bridge.options : []) : part.kind === 'computer' ? rules.computerOptions : rules.sensorOptions;
      const spare = part.kind !== 'computer' && ((part.qty ?? 1) > 1 || spec.hull.tons > 1000);
      controls = (
        <>
          {spare && (
            <Row label={part.kind === 'bridge' ? 'Bridges (more than one is a backup)' : 'Suites fitted'}>
              <Stepper label="number" value={part.qty ?? 1} min={1} max={9} disabled={off} onChange={(qty) => onPatch({ qty })} />
            </Row>
          )}
          <OptionChecks defs={options} chosen={part.options} itemKey={part.key ?? 'bridge'} hullTons={spec.hull.tons} tl={spec.tl} disabled={off} onChange={(next) => onPatch({ options: next })} />
        </>
      );
      break;
    }
    case 'mount': {
      const def = rules.mounts.find((m) => m.id === part.key);
      const slots = def ? (def.variable ? 1 : report.smallCraft && def.smallCraftSlots !== undefined ? def.smallCraftSlots : def.slots) : 0;
      const free = report.hardpoints.total - report.hardpoints.used;
      const each = def?.variable ? Math.max(1, Math.round(line.hardpoints / Math.max(1, part.qty ?? 1))) : report.smallCraft ? (def?.firmpoints ?? 1) : (def?.hardpoints ?? 1);
      const weapons = part.weapons ?? [];
      const choices = rules.weapons.filter((w) => (w.mount ?? '') === (def?.accepts ?? ''));
      const spinal = def?.variable ? rules.weapons.find((w) => w.id === weapons[0])?.spinal : undefined;
      const points = report.hardpoints.firm ? 'firmpoint' : 'hardpoint';
      controls = (
        <>
          <Row label={each > 1 ? `Number (${each} ${points}s each)` : `Number (a ${points} each)`}>
            <Stepper label="mounts" value={part.qty ?? 1} min={1} max={(part.qty ?? 1) + Math.max(0, Math.floor(free / each))} disabled={off} onChange={(qty) => onPatch({ qty })} />
          </Row>
          {Array.from({ length: Math.max(slots, weapons.length) }, (_, i) => (
            <Row key={i} label={slots === 1 ? 'Weapon' : `Weapon ${i + 1}`}>
              <select
                className="select"
                value={weapons[i] ?? ''}
                disabled={off}
                aria-label={`Weapon ${i + 1}`}
                onChange={(e) => {
                  const next = [...weapons];
                  if (e.target.value) next[i] = e.target.value;
                  else next.splice(i, 1);
                  onPatch({ weapons: next.filter(Boolean) });
                }}
              >
                <option value="">{def?.accepts ? 'None' : 'Empty'}</option>
                {choices.map((w) => (
                  <option key={w.id} value={w.id} disabled={w.tl > spec.tl}>
                    {w.name} · {w.damage}
                    {w.multiple ? ` x${w.multiple}` : ''} · {w.range} · {formatMCr(w.cost)}
                    {w.tl > spec.tl ? ` (TL${w.tl})` : ''}
                  </option>
                ))}
              </select>
            </Row>
          ))}
          {def?.variable && spinal && (
            <>
              <Row label={`Size, in multiples of ${spinal.baseTons.toLocaleString('en-GB')} tons`}>
                <Stepper label="size" value={part.rating ?? 1} min={1} max={Math.max(part.rating ?? 1, Math.floor(spinal.maxTons / spinal.baseTons) + 2)} disabled={off} onChange={(rating) => onPatch({ rating })} />
              </Row>
              <p className="faint tiny">Power, damage dice and price all rise with each multiple. A spinal mount takes a hardpoint for every 100 tons and can fill no more than half the ship.</p>
            </>
          )}
          {(part.qty ?? 1) > 1 && !def?.variable && <p className="faint tiny">All {part.qty} mounts carry the same weapons.</p>}
          {report.hardpoints.firm && rules.hardpoints.firmpointNote && <p className="faint tiny">{rules.hardpoints.firmpointNote}</p>}
          <OptionChecks defs={rules.mountOptions} chosen={part.options} itemKey={def?.id} hullTons={spec.hull.tons} tl={spec.tl} disabled={off} onChange={(options) => onPatch({ options })} />
          <BuildQuality rules={rules} tag="weapon" part={part} turret={!def?.accepts} disabled={off} onPatch={onPatch} />
        </>
      );
      break;
    }
    case 'fitting': {
      const def = rules.fittings.find((f) => f.id === part.key);
      const most = def?.maxQtyHullPct ? Math.max(1, Math.floor((spec.hull.tons * def.maxQtyHullPct) / 100)) : 100000;
      if (def?.size === 'unit' && (!def.single || def.maxQtyHullPct)) {
        controls = (
          <Row label={def.unitLabel ? `Number (each a ${def.unitLabel})` : 'Number'}>
            <Stepper label="number" value={part.qty ?? 1} min={1} max={most} disabled={off} onChange={(qty) => onPatch({ qty })} />
            <Num label="number" value={part.qty ?? 1} min={1} max={most} width={64} disabled={off} onCommit={(qty) => onPatch({ qty: Math.round(qty) })} />
          </Row>
        );
      } else if (def?.size === 'capacity') {
        controls = (
          <>
            <Row label={`For how many ${def.capacityLabel ?? 'tons'}`}>
              <Num label={def.capacityLabel ?? 'tons'} value={part.rating ?? 0} min={0} max={2_000_000} step={1} disabled={off} onCommit={(rating) => onPatch({ rating })} />
            </Row>
            {!def.single && (
              <Row label="Number of this size">
                <Stepper label="number" value={part.qty ?? 1} min={1} max={999} disabled={off} onChange={(qty) => onPatch({ qty })} />
              </Row>
            )}
          </>
        );
      } else if (def?.size === 'tons') {
        controls = (
          <Row label="Size">
            <Num label="tons" value={part.tons ?? 0} min={0} step={def.stepTons ? 1 : 0.5} disabled={off} suffix="tons" onCommit={(tons) => onPatch({ tons })} />
          </Row>
        );
      } else if (def?.size === 'docking') {
        controls = (
          <>
            <Row label="Tonnage of the craft carried">
              <Num label="craft tons" value={part.rating ?? 0} min={0.5} step={1} disabled={off} suffix="tons" onCommit={(rating) => onPatch({ rating })} />
            </Row>
            <Row label="Bays of this size">
              <Stepper label="bays" value={part.qty ?? 1} min={1} max={99} disabled={off} onChange={(qty) => onPatch({ qty })} />
            </Row>
          </>
        );
      }
      controls = (
        <>
          {controls}
          {def?.note && <p className="faint tiny">{def.note}</p>}
          {def && (canEdit || part.name) && (
            <details className="insp-more" open={!!part.name}>
              <summary>Label{part.name ? <b>: {part.name}</b> : ''}</summary>
              <TextBox value={part.name ?? ''} disabled={off} onCommit={(name) => onPatch({ name: name.trim() || undefined })} />
              <p className="faint tiny">A note of your own for the manifest: what it protects, who it is for.</p>
            </details>
          )}
          {def?.custom && <BuildQuality rules={rules} tag={def.custom} part={part} disabled={off} onPatch={onPatch} />}
        </>
      );
      break;
    }
    case 'craft':
    case 'custom':
      controls = (
        <>
          <Field label="Name">
            <TextBox value={part.name ?? ''} disabled={off} onCommit={(name) => onPatch({ name })} />
          </Field>
          {part.kind === 'custom' && (
            <Row label="Tons each">
              <Num label="tons" value={part.tons ?? 0} min={-100000} step={0.5} disabled={off} suffix="tons" onCommit={(tons) => onPatch({ tons })} />
            </Row>
          )}
          <Row label="Price each">
            <Num label="price in megacredits" value={(part.cost ?? 0) / 1_000_000} min={0} max={1_000_000} step={0.05} disabled={off} suffix="MCr" onCommit={(mcr) => onPatch({ cost: Math.round(mcr * 1_000_000) })} />
          </Row>
          {part.kind === 'custom' && (
            <Row label="Power drawn">
              <Num label="power" value={part.power ?? 0} min={0} step={1} disabled={off} onCommit={(power) => onPatch({ power })} />
            </Row>
          )}
          <Row label="Number">
            <Stepper label="number" value={part.qty ?? 1} min={1} max={999} disabled={off} onChange={(qty) => onPatch({ qty })} />
          </Row>
          {part.kind === 'craft' && rules.crew.establishment && (
            <Row label="Crew each needs from the ship">
              <Stepper label="crew for the craft" value={part.rating ?? 0} min={0} max={20} disabled={off} onChange={(rating) => onPatch({ rating })} />
            </Row>
          )}
          <p className="faint tiny">{part.kind === 'craft' ? 'A boat or vehicle bought with the ship. It takes no tonnage itself: give it docking space.' : 'Use this for house rules and parts from other books.'}</p>
        </>
      );
      break;
    default:
      break;
  }

  return (
    <div className="insp">
      <div className="insp-head">
        <div className="grow">
          <h3>{line.label}</h3>
          {line.detail && <div className="small dim">{line.detail}</div>}
        </div>
        {line.tl > 0 && <span className={cx('chip', line.tl > spec.tl && 'danger')}>TL{line.tl}</span>}
      </div>
      <dl className="insp-figs">
        <div>
          <dt>Tons</dt>
          <dd>{formatTons(line.tons)}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{line.cost ? formatMCr(line.cost) : '—'}</dd>
        </div>
        <div>
          <dt>{line.output ? 'Power out' : 'Power'}</dt>
          <dd>{line.output ? formatTons(line.output) : line.power ? formatTons(line.power) : '—'}</dd>
        </div>
      </dl>
      {controls}
      <IssueList issues={issues} />
      {canEdit && (
        <div className="row gap-4 insp-foot">
          {line.tons > 0 && (
            <>
              <button className="btn sm" onClick={() => onNudge(-1)} title="Move one place toward the stern">
                <Icon name="chevronLeft" size={13} /> Stern
              </button>
              <button className="btn sm" onClick={() => onNudge(1)} title="Move one place toward the bow">
                Bow <Icon name="chevronRight" size={13} />
              </button>
            </>
          )}
          <span className="grow" />
          <button className="btn sm danger" onClick={onRemove}>
            <Icon name="trash" size={13} /> Remove
          </button>
        </div>
      )}
    </div>
  );
}

function TextBox({ value, onCommit, disabled }: { value: string; onCommit: (text: string) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <input className="input" value={draft} maxLength={120} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && onCommit(draft)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}

// ───────────────────────────── hull ─────────────────────────────

export function HullInspector({ rules, spec, report, canEdit, yardTl, onChange }: { rules: ShipRules; spec: ShipSpec; report: DesignReport; canEdit: boolean; yardTl?: number; onChange: (next: ShipSpec) => void }) {
  const [picking, setPicking] = useState(false);
  const off = !canEdit;
  const cfg = rules.hull.configurations.find((c) => c.id === spec.hull.config);
  const outline = outlineOf(spec);
  const setHull = (hull: Partial<ShipSpec['hull']>) => onChange({ ...spec, hull: { ...spec.hull, ...hull } });
  const hp = report.hardpoints;
  const tlMin = Math.min(7, ...rules.plants.map((p) => p.tl));
  const tlMax = Math.max(15, ...rules.plants.map((p) => p.tl), ...rules.armour.map((a) => a.tl));
  return (
    <div className="insp">
      <div className="insp-head">
        <div className="grow">
          <h3>Hull</h3>
          <div className="small dim">
            {report.hullPoints} Hull points · {hp.total} {hp.firm ? 'firmpoint' : 'hardpoint'}
            {hp.total === 1 ? '' : 's'}
            {report.smallCraft ? ' · small craft' : ''}
          </div>
        </div>
      </div>
      <Row label="Tonnage">
        <select className="select" aria-label="Standard hull sizes" disabled={off} value={rules.hull.sizes.includes(spec.hull.tons) ? spec.hull.tons : ''} onChange={(e) => e.target.value && setHull({ tons: Number(e.target.value) })}>
          <option value="">Custom</option>
          {rules.hull.sizes.map((s) => (
            <option key={s} value={s}>
              {s.toLocaleString('en-GB')} t
            </option>
          ))}
        </select>
        <Num label="hull tons" value={spec.hull.tons} min={rules.hull.minTons} max={rules.hull.maxTons} step={10} width={76} disabled={off} onCommit={(tons) => setHull({ tons })} />
      </Row>
      <Field label="Configuration" hint={cfg?.note}>
        <select className="select" disabled={off} value={spec.hull.config} onChange={(e) => setHull({ config: e.target.value })}>
          {rules.hull.configurations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.costPerTon !== undefined ? `Cr${c.costPerTon.toLocaleString('en-GB')} a ton` : c.costMult === 1 ? 'standard cost' : `${c.costMult > 1 ? '+' : ''}${Math.round((c.costMult - 1) * 100)}% cost`})
            </option>
          ))}
        </select>
      </Field>
      {cfg?.noOptions ? (
        rules.hull.options.length > 0 && <p className="faint tiny">A {cfg.name.toLowerCase()} hull is what it is: it cannot be built reinforced, light or the like.</p>
      ) : (
        <OptionChecks defs={rules.hull.options} chosen={spec.hull.options} hullTons={spec.hull.tons} tl={spec.tl} disabled={off} onChange={(options) => setHull({ options })} />
      )}
      {rules.crew.establishment && !report.smallCraft && (
        <Row label="Crewed as">
          <select className="select" aria-label="Crewing standard" disabled={off} value={spec.crewing ?? 'commercial'} onChange={(e) => onChange({ ...spec, crewing: e.target.value === 'military' ? 'military' : undefined })}>
            <option value="commercial">A commercial ship</option>
            <option value="military">A warship</option>
          </select>
        </Row>
      )}
      <Row label="Design tech level">
        <Stepper label="tech level" value={spec.tl} min={Math.min(tlMin, spec.tl)} max={Math.max(tlMax, spec.tl)} disabled={off} onChange={(tl) => onChange({ ...spec, tl })} />
        {canEdit && yardTl !== undefined && yardTl !== spec.tl && (
          <button className="btn sm" onClick={() => onChange({ ...spec, tl: Math.min(tlMax, Math.max(tlMin, yardTl)) })}>
            Match this yard (TL{yardTl})
          </button>
        )}
      </Row>
      <div className="section-title" style={{ marginTop: 10 }}>
        Outline
      </div>
      <div className="outline-grid">
        {OUTLINES.map((o) => (
          <button
            key={o.key}
            className={cx('outline-thumb', outline.kind === 'builtin' && outline.key === o.key && 'on')}
            disabled={off}
            title={o.name}
            aria-label={`${o.name} outline`}
            onClick={() => onChange({ ...spec, outline: { kind: 'builtin', key: o.key } })}
          >
            <svg viewBox={o.viewBox.join(' ')} aria-hidden="true">
              <path d={o.d} />
            </svg>
          </button>
        ))}
        <button className={cx('outline-thumb', 'custom', outline.kind !== 'builtin' && 'on')} disabled={off} onClick={() => setPicking(true)} title="Use your own outline">
          <Icon name="upload" size={16} />
          <span className="tiny">Your own</span>
        </button>
      </div>
      {picking && (
        <OutlineDialog
          current={outline}
          onClose={() => setPicking(false)}
          onUse={(o) => {
            onChange({ ...spec, outline: o });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

export function CargoInspector({ report }: { report: DesignReport }) {
  return (
    <div className="insp">
      <div className="insp-head">
        <div className="grow">
          <h3>Cargo hold</h3>
          <div className="small dim">{formatTons(Math.max(0, report.cargo))} tons</div>
        </div>
      </div>
      <p className="small dim">Whatever tonnage is not given over to something else is cargo space. It costs nothing. Drag the block along the hull to put the hold where you want it.</p>
    </div>
  );
}

/** Pick an outline of your own: pasted SVG path data, an .svg file, or a picture of a silhouette. */
function OutlineDialog({ current, onClose, onUse }: { current: ShipOutline; onClose: () => void; onUse: (o: ShipOutline) => void }) {
  const [text, setText] = useState(current.kind === 'path' ? current.d : '');
  const [name, setName] = useState(current.kind !== 'builtin' ? (current.name ?? '') : '');
  const [busy, setBusy] = useState(false);
  const parsed = text.trim() ? parseOutlineText(text, name.trim() || undefined) : {};
  const loadSvg = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 400_000) {
      toast('That SVG is too large. Simplify it to a single silhouette first.', 'error');
      return;
    }
    setText(await file.text());
    if (!name) setName(file.name.replace(/\.svg$/i, ''));
  };
  const loadImage = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const res = await upload(file);
      onUse({ kind: 'image', url: res.url, name: name.trim() || file.name.replace(/\.[a-z0-9]+$/i, '') });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Your own hull outline"
      icon="ship"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!parsed.outline} onClick={() => parsed.outline && onUse(parsed.outline)}>
            Use this outline
          </button>
        </>
      }
    >
      <div className="outline-dialog">
        <div className="col gap-12">
          <Field label="Name (optional)">
            <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="SVG path" hint="Paste path data (it starts with M) or the contents of an .svg file. Draw the ship from above with the bow to the right. Any drawing program can export this." error={text.trim() && parsed.error ? parsed.error : undefined}>
            <textarea className="textarea mono" rows={7} value={text} spellCheck={false} placeholder="M 30 40 L 420 110 Q 570 150 420 190 L 30 260 Z" onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="row wrap gap-4">
            <label className="btn sm">
              <Icon name="upload" size={13} /> Load an .svg file
              <input type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => void loadSvg(e.target.files?.[0])} />
            </label>
            <label className={cx('btn sm', busy && 'disabled')}>
              <Icon name="image" size={13} /> {busy ? 'Uploading…' : 'Use a picture instead'}
              <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={busy} onChange={(e) => void loadImage(e.target.files?.[0])} />
            </label>
          </div>
          <p className="faint tiny">A picture works too: a PNG with a transparent background, or a dark shape on a light background. The opaque or dark area becomes the hull.</p>
        </div>
        <div className="outline-preview">
          {parsed.outline ? (
            <svg viewBox={parsed.outline.viewBox.join(' ')} aria-label="Outline preview">
              <path d={parsed.outline.d} />
            </svg>
          ) : (
            <span className="faint small">Preview</span>
          )}
        </div>
      </div>
    </Modal>
  );
}

export { CARGO, IssueList };
