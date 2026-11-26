/** The inspector: sizing and options for whichever part of the design is selected. */
import { useEffect, useState, type ReactNode } from 'react';
import { OUTLINES, outlineOf, parseOutlineText } from '../../../shared/outlines';
import type { ShipRules } from '../../../shared/rulepack';
import { formatMCr, formatTons, fuelTonsFor, type DesignIssue, type DesignReport, type PartLine } from '../../../shared/rules/ship';
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
      const cap = Math.min(def?.maxByTl ? spec.tl : 99, def?.max ?? 99);
      controls = (
        <Row label={`Protection (up to +${cap} at TL${spec.tl})`}>
          <Stepper label="protection" value={part.rating ?? 1} min={1} max={Math.max(cap, part.rating ?? 1)} disabled={off} onChange={(rating) => onPatch({ rating })} />
        </Row>
      );
      break;
    }
    case 'mdrive':
    case 'jdrive': {
      const def = part.kind === 'jdrive' ? rules.jdrive : rules.mdrive;
      const allowed = def.tl.filter((tl) => tl <= spec.tl).length;
      const rating = part.rating ?? 1;
      const nextTl = def.tl[rating];
      controls = (
        <>
          <Row label={part.kind === 'jdrive' ? 'Jump rating' : 'Thrust'}>
            <Stepper label={part.kind === 'jdrive' ? 'jump rating' : 'thrust'} value={rating} min={1} max={Math.max(allowed, rating)} disabled={off} onChange={(r) => onPatch({ rating: r })} />
          </Row>
          <p className="faint tiny">
            {rating >= def.tl.length ? 'This is as far as the rules go.' : nextTl > spec.tl ? `The next step needs TL${nextTl}.` : `TL${spec.tl} allows up to ${part.kind === 'jdrive' ? 'Jump-' : 'Thrust '}${allowed}.`}
            {part.kind === 'jdrive' ? ` Each parsec jumped burns ${formatTons(report.fuel.perParsec)} tons of fuel.` : ''}
          </p>
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
          <p className="faint tiny">Burns {formatTons(report.fuel.perPeriod)} tons of fuel every four weeks.</p>
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
          <p className="faint tiny">
            {report.jump > 0 ? `One parsec of jump takes ${formatTons(report.fuel.perParsec)} tons. ` : ''}
            The power plant uses {formatTons(report.fuel.perPeriod)} tons every four weeks.
          </p>
        </>
      );
      break;
    }
    case 'bridge':
    case 'computer': {
      const options = part.kind === 'bridge' ? (part.key === 'bridge' || !part.key ? rules.bridge.options : []) : rules.computerOptions;
      controls = options.length ? (
        <div className="col gap-4">
          {options.map((o) => (
            <label key={o.id} className="check" title={o.note}>
              <input type="checkbox" checked={part.options?.includes(o.id) ?? false} disabled={off || (o.tl ?? 0) > spec.tl} onChange={(e) => onPatch({ options: toggle(part.options, o.id, e.target.checked) })} />
              <span>
                {o.name}
                {o.tl ? <span className="faint"> · TL{o.tl}</span> : null}
                <span className="faint tiny block">{o.note}</span>
              </span>
            </label>
          ))}
        </div>
      ) : null;
      break;
    }
    case 'mount': {
      const def = rules.mounts.find((m) => m.id === part.key);
      const slots = def ? (report.smallCraft && def.smallCraftSlots !== undefined ? def.smallCraftSlots : def.slots) : 0;
      const free = report.hardpoints.total - report.hardpoints.used;
      const weapons = part.weapons ?? [];
      const choices = rules.weapons.filter((w) => (w.mount ?? '') === (def?.accepts ?? ''));
      controls = (
        <>
          <Row label={report.hardpoints.firm ? 'Firmpoints used' : 'Hardpoints used'}>
            <Stepper label="mounts" value={part.qty ?? 1} min={1} max={(part.qty ?? 1) + Math.max(0, free)} disabled={off} onChange={(qty) => onPatch({ qty })} />
          </Row>
          {Array.from({ length: Math.max(slots, weapons.length) }, (_, i) => (
            <Row key={i} label={`Weapon ${i + 1}`}>
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
                <option value="">Empty</option>
                {choices.map((w) => (
                  <option key={w.id} value={w.id} disabled={w.tl > spec.tl}>
                    {w.name} · {w.damage} · {w.range} · {formatMCr(w.cost)}
                    {w.tl > spec.tl ? ` (TL${w.tl})` : ''}
                  </option>
                ))}
              </select>
            </Row>
          ))}
          {(part.qty ?? 1) > 1 && <p className="faint tiny">All {part.qty} mounts carry the same weapons.</p>}
          {report.hardpoints.firm && rules.hardpoints.firmpointNote && <p className="faint tiny">{rules.hardpoints.firmpointNote}</p>}
        </>
      );
      break;
    }
    case 'fitting': {
      const def = rules.fittings.find((f) => f.id === part.key);
      if (def?.size === 'unit' && !def.single) {
        controls = (
          <Row label={def.unitLabel ? `Number (each a ${def.unitLabel})` : 'Number'}>
            <Stepper label="number" value={part.qty ?? 1} min={1} max={100000} disabled={off} onChange={(qty) => onPatch({ qty })} />
            <Num label="number" value={part.qty ?? 1} min={1} max={100000} width={64} disabled={off} onCommit={(qty) => onPatch({ qty: Math.round(qty) })} />
          </Row>
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
      if (def?.note) controls = (
        <>
          {controls}
          <p className="faint tiny">{def.note}</p>
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
              {c.name} ({c.costMult === 1 ? 'standard cost' : `${c.costMult > 1 ? '+' : ''}${Math.round((c.costMult - 1) * 100)}% cost`})
            </option>
          ))}
        </select>
      </Field>
      {rules.hull.options.map((o) => (
        <label key={o.id} className="check" title={o.note}>
          <input
            type="checkbox"
            disabled={off}
            checked={spec.hull.options?.includes(o.id) ?? false}
            onChange={(e) => {
              const set = new Set(spec.hull.options ?? []);
              if (e.target.checked) set.add(o.id);
              else set.delete(o.id);
              setHull({ options: [...set] });
            }}
          />
          <span>
            {o.name}
            <span className="faint tiny block">{o.note}</span>
          </span>
        </label>
      ))}
      <Row label="Design tech level">
        <Stepper label="tech level" value={spec.tl} min={7} max={15} disabled={off} onChange={(tl) => onChange({ ...spec, tl })} />
        {canEdit && yardTl !== undefined && yardTl !== spec.tl && (
          <button className="btn sm" onClick={() => onChange({ ...spec, tl: Math.min(15, Math.max(7, yardTl)) })}>
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
