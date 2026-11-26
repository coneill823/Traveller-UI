/**
 * Adding to an inventory: any item by hand, or from the catalogue of the rules packs, with how
 * hard each thing is to find on the world the party is on and the option of paying for it.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { ArmourDef, EquipmentDef, GearRules, WeaponDef } from '../../../shared/rulepack';
import { skillLevel } from '../../../shared/rules/character';
import { availability, catalogueName, marketWorld, variantFigures, variantSteps, type AvailabilityResult } from '../../../shared/rules/gear';
import type { Character, Id, ItemCategory, Ship, Stash } from '../../../shared/types';
import { formatCredits } from '../../../shared/util';
import { act } from '../../net';
import { toast, useCampaign, useRules } from '../../store';
import { cx, Field, Modal, Segmented } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { CheckDialog, type CheckRequest } from '../characters/rolling';
import { systemLabel, useMapData } from '../map/mapData';
import { SystemPicker } from '../map/SystemPicker';

type Holder = Character | Ship | Stash;
type Mode = 'custom' | 'weapon' | 'armour' | 'equipment' | 'rules';

const CATEGORY_LABEL: Record<ItemCategory, string> = { weapon: 'Weapons', armour: 'Armour', gear: 'Gear', consumable: 'Consumables', cargo: 'Cargo', other: 'Other' };
const SHOWN = 150;
const signed = (n: number) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);
const kgText = (kg: number | undefined, note?: string) => note ?? (kg ? `${kg}` : '—');
const rangeText = (range: number | 'melee') => (range === 'melee' ? 'Melee' : range === 0 ? '—' : range >= 10000 ? `${range / 1000} km` : `${range} m`);

/** "Medikit, Advanced" files under "Medikit". */
const family = (name: string) => name.replace(/,\s.*$/, '').toLowerCase();

/** One line of the catalogue, whatever kind of thing it is. */
interface Row {
  kind: 'weapon' | 'armour' | 'equipment';
  id: string;
  name: string;
  /** Sorts grades of one thing together, in order of tech level. */
  sort: string;
  sub?: string;
  note?: string;
  group: string;
  tl?: number;
  tlNote?: string;
  kg?: number;
  kgNote?: string;
  cost?: number;
  costNote?: string;
  cells: ReactNode[];
  equipment?: EquipmentDef;
}

function weaponRow(w: WeaponDef, gear: GearRules): Row {
  return {
    kind: 'weapon',
    id: w.id,
    name: catalogueName(w, gear.weapons),
    sort: family(w.name),
    sub: w.skill,
    note: w.note,
    group: w.group,
    tl: w.tl,
    kg: w.kg,
    cost: w.cost,
    cells: [rangeText(w.range), w.damage || '—', w.magazine === undefined ? '—' : w.magazine === 'unlimited' ? '∞' : `${w.magazine}${w.magazineCost !== undefined ? ` · Cr${w.magazineCost}` : ''}`, <span className="small dim">{w.traits?.join(', ')}</span>],
  };
}

function armourRow(a: ArmourDef): Row {
  const extras = [a.versus, a.skill ? `needs ${a.skill.name} ${a.skill.level}` : '', a.str ? `STR ${signed(a.str)}` : '', a.dex ? `DEX ${signed(a.dex)}` : '', a.slots ? `${a.slots} slots` : ''].filter(Boolean);
  return {
    kind: 'armour',
    id: a.id,
    name: `${a.name}`,
    sort: family(a.name),
    sub: extras.join(' · ') || undefined,
    note: a.note,
    group: a.group ?? 'Armour',
    tl: a.tl,
    kg: a.kg,
    cost: a.cost,
    cells: [`+${a.protection}`, a.rad ?? '—'],
  };
}

function equipmentRow(e: EquipmentDef, gear: GearRules): Row {
  const extras = [e.slots !== undefined ? `${e.slots} slot${e.slots === 1 ? '' : 's'}` : '', e.bandwidth !== undefined ? `Bandwidth ${e.bandwidth}` : ''].filter(Boolean);
  return {
    kind: 'equipment',
    id: e.id,
    name: catalogueName(e, gear.equipment ?? []),
    sort: family(e.name),
    sub: [e.effect, ...extras].filter(Boolean).join(' · ') || undefined,
    group: e.section ? `${e.group}: ${e.section}` : e.group,
    tl: e.tl,
    tlNote: e.tlNote,
    kg: e.kg,
    kgNote: e.kgNote,
    cost: e.cost,
    costNote: e.costNote,
    cells: [],
    equipment: e,
  };
}

const HEADS: Record<Row['kind'], string[]> = { weapon: ['Range', 'Damage', 'Magazine', 'Traits'], armour: ['Protection', 'Rad'], equipment: [] };

function ResultTable({ title, roll, note, rows }: { title: string; roll: string; note?: string; rows: { min?: number; max?: number; name: string; note?: string }[] }) {
  const band = (r: { min?: number; max?: number }) => (r.min === undefined ? `${r.max} or less` : r.max === undefined ? `${r.min} or more` : r.min === r.max ? `${r.min}` : `${r.min} to ${r.max}`);
  return (
    <div className="col gap-4">
      <h4>{title}</h4>
      <div className="small dim">Roll {roll}.</div>
      <table className="table compact">
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="mono nowrap">{band(r)}</td>
              <td>
                {r.name}
                {r.note && <div className="tiny faint">{r.note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {note && <div className="small dim">{note}</div>}
    </div>
  );
}

/** The rules for finding and buying things, as the installed packs give them. */
function BuyingRules({ gear }: { gear: GearRules }) {
  const av = gear.availability;
  const bm = av?.blackMarket;
  if (!av && !gear.reference?.length) return <div className="notice">The installed rules have nothing on finding or buying equipment.</div>;
  return (
    <div className="col gap-12 catalogue-rules">
      {av && (
        <section>
          <h3>Finding an item</h3>
          <p>
            {av.check.skills.join(' or ')} check, {av.check.target}+. {av.note}
          </p>
          <div className="rule-chips">
            {av.tlAbove.map((b) => (
              <span className="chip" key={b.name}>
                {b.name} {signed(b.dm)}
              </span>
            ))}
            {Object.entries(av.starport).map(([cls, dm]) => (
              <span className="chip" key={cls}>
                Starport {cls} {signed(dm)}
              </span>
            ))}
            {av.tradeCodes.map((t) => (
              <span className="chip" key={t.codes.join()}>
                {t.codes.join(', ')} {signed(t.dm)}
              </span>
            ))}
            {av.population.map((b) => (
              <span className="chip" key={`${b.min}-${b.max}`}>
                Population {b.min === b.max ? b.min : b.max === undefined ? `${b.min}+` : `${b.min}–${b.max}`} {signed(b.dm)}
              </span>
            ))}
            {av.options.map((o) => (
              <span className="chip" key={o.id}>
                {o.name} {signed(o.dm)}
              </span>
            ))}
            {av.referee && (
              <span className="chip">
                Referee {signed(av.referee.min)} to {signed(av.referee.max)}
              </span>
            )}
          </div>
        </section>
      )}
      {bm && (
        <section>
          <h3>The black market</h3>
          <p>
            {bm.skills.join(' or ')} only. {bm.note}
          </p>
          <div className="rule-chips">
            {bm.lawLevel.map((b) => (
              <span className="chip" key={`${b.min}-${b.max}`}>
                Law level {b.min === b.max ? b.min : b.max === undefined ? `${b.min}+` : `${b.min}–${b.max}`} {signed(b.dm)}
              </span>
            ))}
          </div>
          <table className="table compact">
            <thead>
              <tr>
                <th>Kind of item</th>
                <th>DM</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {bm.categories.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.name}
                    {c.examples && <div className="tiny faint">{c.examples}</div>}
                  </td>
                  <td className="mono">{signed(c.dm)}</td>
                  <td className="mono">×{c.priceMult}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid-2" style={{ alignItems: 'start' }}>
            {bm.attention && <ResultTable title={`Attention from the law (Effect ${bm.attention.effect} or worse)`} roll={bm.attention.roll} rows={bm.attention.results} />}
            {bm.sentencing && <ResultTable title="Sentencing" roll={bm.sentencing.roll} note={bm.sentencing.note} rows={bm.sentencing.results} />}
          </div>
        </section>
      )}
      {gear.variants && gear.variants.length > 0 && (
        <section>
          <h3>Ahead of and behind the times</h3>
          {gear.variants.map((v) => (
            <p key={v.id}>
              <strong>{v.name}.</strong> {v.note}{' '}
              {!v.perTl && (
                <span className="dim">
                  Cost ×{v.costMult ?? 1}, mass ×{v.kgMult ?? 1}
                  {v.electronic ? ` (×${v.electronic.costMult} and ×${v.electronic.kgMult} for computers and electronics)` : ''}
                  {v.availabilityDm ? `; ${signed(v.availabilityDm)} to find one` : ''}.
                </span>
              )}
            </p>
          ))}
          {gear.quirks && gear.quirks.length > 0 && (
            <>
              <h4>Prototype quirks (roll one die)</h4>
              <ol className="small">
                {gear.quirks.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}
      {gear.reference?.map((r) => (
        <section key={r.title}>
          <h3>{r.title}</h3>
          <p>{r.text}</p>
        </section>
      ))}
    </div>
  );
}

export function CatalogueDialog({ holder, holderName, onClose }: { holder: Holder; holderName: string; onClose: () => void }) {
  const pack = useRules();
  const gear = pack.gear;
  const campaign = useCampaign();
  const data = useMapData();
  const [mode, setMode] = useState<Mode>('custom');
  const [form, setForm] = useState({ name: '', category: 'gear' as ItemCategory, qty: '1', kg: '', value: '', tons: '1', note: '' });
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('');
  const [maxTl, setMaxTl] = useState('');
  const [equip, setEquip] = useState(holder.type === 'character');
  const [worldId, setWorldId] = useState<Id | null>(campaign?.location?.systemId ?? null);
  const [picking, setPicking] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [referee, setReferee] = useState(0);
  const [black, setBlack] = useState('');
  const [variantId, setVariantId] = useState('');
  const [steps, setSteps] = useState(1);
  const [roll, setRoll] = useState<CheckRequest | null>(null);

  const av = gear?.availability;
  const here = worldId ? data.systems.find((s) => s.sys.id === worldId) : undefined;
  const world = useMemo(() => marketWorld(here?.sys, pack.world), [here, pack.world]);
  const variant = gear?.variants?.find((v) => v.id === variantId);
  const funds = holder.type === 'ship' ? ((holder as Ship).funds ?? 0) : holder.type === 'character' ? ((holder as Character).credits ?? 0) : undefined;

  const rows = useMemo<Row[]>(() => {
    if (!gear) return [];
    if (mode === 'weapon') return gear.weapons.filter((w) => w.cost !== undefined || w.tl !== undefined).map((w) => weaponRow(w, gear));
    if (mode === 'armour') return gear.armour.map(armourRow);
    if (mode === 'equipment') return (gear.equipment ?? []).map((e) => equipmentRow(e, gear));
    return [];
  }, [gear, mode]);
  const groups = useMemo(() => [...new Set(rows.map((r) => r.group))].sort((a, b) => a.localeCompare(b)), [rows]);
  const needle = q.trim().toLowerCase();
  const tlCap = maxTl === '' ? undefined : Number(maxTl);
  const matching = rows
    .filter((r) => !group || r.group === group)
    .filter((r) => tlCap === undefined || r.tl === undefined || r.tl <= tlCap)
    .filter((r) => !needle || `${r.name} ${r.sub ?? ''} ${r.group}`.toLowerCase().includes(needle))
    .sort((a, b) => a.sort.localeCompare(b.sort) || (a.tl ?? 0) - (b.tl ?? 0) || a.name.localeCompare(b.name));
  const shown = matching.slice(0, SHOWN);

  const create = async (payload: Record<string, unknown>, label: string) => {
    try {
      const res = await act<{ id: Id; paid?: number }>('item.create', { holderId: holder.id, ...payload });
      toast(res.paid !== undefined ? `${label} bought for ${formatCredits(res.paid)}` : `${label} added to ${holderName}`, 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  /** Figures for a row in the version being shopped for, and how hard it is to find here. */
  const figure = (r: Row) => {
    const applies = r.equipment && variant && variantSteps(r.equipment, variant) > 0;
    const v = applies ? variantFigures(r.equipment!, variant, steps) : { tl: r.tl, kg: r.kg, cost: r.cost, steps: 0 };
    const found: AvailabilityResult | undefined = av ? availability(av, world, { tl: v.tl, options, referee, blackMarket: black || undefined, variant: applies ? variant : undefined }) : undefined;
    return { ...v, applies: !!applies, found };
  };
  const findRequest = (r: Row, found: AvailabilityResult): CheckRequest | null => {
    if (holder.type !== 'character') return null;
    const c = holder as Character;
    const skill = [...found.skills].sort((a, b) => (skillLevel(c.skills, b) ?? -9) - (skillLevel(c.skills, a) ?? -9))[0];
    return { character: c, skill, chooseSkill: true, label: `Finding ${r.name}${here ? ` on ${systemLabel(here)}` : ''}`, dm: found.dm, target: found.target };
  };

  const toggle = (id: string) => setOptions((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur.filter((x) => !av?.options.find((o) => o.id === id)?.excludes?.includes(x)), id]));
  const catalogue = mode === 'weapon' || mode === 'armour' || mode === 'equipment';

  return (
    <Modal title={`Add to ${holderName}`} icon="plus" size="xwide" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="col gap-12">
        <Segmented
          value={mode}
          onChange={(m) => (setMode(m), setGroup(''))}
          options={[
            { id: 'custom', label: 'Any item' },
            { id: 'weapon', label: `Weapons${gear ? ` (${gear.weapons.length})` : ''}` },
            { id: 'armour', label: `Armour${gear ? ` (${gear.armour.length})` : ''}` },
            ...(gear?.equipment?.length ? [{ id: 'equipment' as const, label: `Equipment (${gear.equipment.length})` }] : []),
            ...(gear?.availability || gear?.reference?.length ? [{ id: 'rules' as const, label: 'Buying rules' }] : []),
          ]}
        />

        {mode === 'custom' && (
          <div className="col gap-12">
            <div className="grid-2">
              <Field label="Name">
                <input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="Kind">
                <select className="select" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as ItemCategory })}>
                  {(Object.keys(CATEGORY_LABEL) as ItemCategory[]).map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid-3">
              <Field label="Quantity">
                <input className="input mono" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value.replace(/\D/g, '') })} />
              </Field>
              {form.category === 'cargo' ? (
                <Field label="Tons (each lot)">
                  <input className="input mono" value={form.tons} onChange={(e) => setForm({ ...form, tons: e.target.value.replace(/[^\d.]/g, '') })} />
                </Field>
              ) : (
                <Field label="Mass each (kg)">
                  <input className="input mono" value={form.kg} onChange={(e) => setForm({ ...form, kg: e.target.value.replace(/[^\d.]/g, '') })} />
                </Field>
              )}
              <Field label={form.category === 'cargo' ? 'Value per ton (Cr)' : 'Value each (Cr)'}>
                <input className="input mono" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value.replace(/[^\d.]/g, '') })} />
              </Field>
            </div>
            <Field label="Notes">
              <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>
            <div>
              <button
                className="btn primary"
                disabled={!form.name.trim()}
                onClick={() =>
                  void create(
                    {
                      name: form.name.trim(),
                      category: form.category,
                      qty: Number(form.qty) || 1,
                      kg: form.kg ? Number(form.kg) : undefined,
                      value: form.value ? Number(form.value) : undefined,
                      tons: form.category === 'cargo' ? Number(form.tons) || 1 : undefined,
                      note: form.note.trim() || undefined,
                    },
                    form.name.trim(),
                  ).then(() => setForm({ ...form, name: '', note: '' }))
                }
              >
                <Icon name="plus" size={13} /> Add item
              </button>
            </div>
          </div>
        )}

        {mode === 'rules' && gear && <BuyingRules gear={gear} />}

        {catalogue && !gear && <div className="notice warn">No equipment catalogue is installed on the server.</div>}

        {catalogue && gear && (
          <div className="col gap-8">
            {av && (
              <div className="panel pad catalogue-where">
                <div className="row wrap">
                  <span className="label">Shopping on</span>
                  {here && world ? (
                    <>
                      <strong>{systemLabel(here)}</strong>
                      {world.tl !== undefined ? (
                        <span className="row gap-4 wrap">
                          <span className="chip mono">TL{world.tl}</span>
                          {world.starport && <span className="chip mono">Starport {world.starport}</span>}
                          {world.population !== undefined && <span className="chip mono">Pop {world.population}</span>}
                          {world.law !== undefined && <span className="chip mono">Law {world.law}</span>}
                          {world.tradeCodes.length > 0 && <span className="chip mono">{world.tradeCodes.join(' ')}</span>}
                        </span>
                      ) : (
                        <span className="small dim">No survey data: the world’s own modifiers are left out.</span>
                      )}
                    </>
                  ) : (
                    <span className="dim">no particular world</span>
                  )}
                  <button className="btn ghost sm" onClick={() => setPicking((v) => !v)}>
                    Change
                  </button>
                  {here && (
                    <button className="btn ghost sm" onClick={() => setWorldId(null)}>
                      Nowhere in particular
                    </button>
                  )}
                </div>
                {picking && <SystemPicker data={data} onPick={(id) => (setWorldId(id), setPicking(false))} placeholder="Which world?" />}
                <div className="row wrap catalogue-options">
                  {av.options.map((o) => (
                    <label className="check small" key={o.id}>
                      <input type="checkbox" checked={options.includes(o.id)} onChange={() => toggle(o.id)} />
                      {o.name} <span className="mono dim">{signed(o.dm)}</span>
                    </label>
                  ))}
                  {av.referee && (
                    <label className="row gap-4 small">
                      Referee
                      <span className="stepper">
                        <button type="button" onClick={() => setReferee(Math.max(av.referee!.min, referee - 1))} aria-label="Lower the referee's modifier">
                          −
                        </button>
                        <output>{signed(referee)}</output>
                        <button type="button" onClick={() => setReferee(Math.min(av.referee!.max, referee + 1))} aria-label="Raise the referee's modifier">
                          +
                        </button>
                      </span>
                    </label>
                  )}
                  {av.blackMarket && (
                    <select className="select sm" value={black} onChange={(e) => setBlack(e.target.value)} aria-label="Black market">
                      <option value="">Bought openly</option>
                      {av.blackMarket.categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          Black market · {c.name} (×{c.priceMult})
                        </option>
                      ))}
                    </select>
                  )}
                  {mode === 'equipment' && gear.variants && gear.variants.length > 0 && (
                    <>
                      <select className="select sm" value={variantId} onChange={(e) => (setVariantId(e.target.value), setSteps(1))} aria-label="Version">
                        <option value="">Standard make</option>
                        {gear.variants.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                      {variant?.perTl && (
                        <label className="row gap-4 small">
                          TLs above the listing
                          <span className="stepper">
                            <button type="button" onClick={() => setSteps(Math.max(1, steps - 1))} aria-label="One tech level fewer">
                              −
                            </button>
                            <output>{steps}</output>
                            <button type="button" onClick={() => setSteps(Math.min(variant.computerSteps ?? variant.maxSteps ?? 3, steps + 1))} aria-label="One tech level more">
                              +
                            </button>
                          </span>
                        </label>
                      )}
                    </>
                  )}
                </div>
                {variant?.note && <div className="tiny faint">{variant.note}</div>}
              </div>
            )}

            <div className="row wrap">
              <input className="input" autoFocus placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 200px', width: 'auto' }} />
              <select className="select" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Section" style={{ maxWidth: 280 }}>
                <option value="">Every section</option>
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <label className="row gap-4 small nowrap">
                TL up to
                <input className="input mono" style={{ width: 56 }} value={maxTl} onChange={(e) => setMaxTl(e.target.value.replace(/\D/g, '').slice(0, 2))} placeholder={world?.tl !== undefined ? String(world.tl) : 'any'} />
              </label>
              {world?.tl !== undefined && (
                <button className={cx('btn sm', maxTl === String(world.tl) && 'on')} onClick={() => setMaxTl(maxTl === String(world.tl) ? '' : String(world.tl))} title="Only what this world can make itself">
                  Made here
                </button>
              )}
              {holder.type === 'character' && (
                <label className="check small nowrap" title="Weapons and armour go on the sheet ready to use; augments are noted among the traits">
                  <input type="checkbox" checked={equip} onChange={(e) => setEquip(e.target.checked)} />
                  Also put it on the sheet
                </label>
              )}
              {funds !== undefined && (
                <span className="chip accent mono" title="Credits available">
                  <Icon name="coins" size={12} /> {formatCredits(funds)}
                </span>
              )}
            </div>

            <div className="scroll catalogue-list">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>TL</th>
                    {HEADS[mode as Row['kind']].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                    <th className="num">Kg</th>
                    <th className="num">Cost</th>
                    {av && <th title={`${av.check.skills.join(' or ')} ${av.check.target}+`}>To find</th>}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const f = figure(r);
                    const mult = f.found?.priceMult ?? 1;
                    const price = f.cost !== undefined ? Math.round(f.cost * mult) : undefined;
                    const request = f.found ? findRequest(r, f.found) : null;
                    const payload = { defKind: r.kind, defId: r.id, equip, ...(f.applies ? { variant: variantId, steps: f.steps } : {}) };
                    return (
                      <tr key={r.id} className={cx(variant && r.equipment && !f.applies && 'muted')}>
                        <td>
                          <strong>{r.name}</strong>
                          {r.sub && <div className="tiny dim">{r.sub}</div>}
                          {r.note && <div className="tiny faint">{r.note}</div>}
                          {!group && r.kind === 'equipment' && <div className="tiny faint">{r.group}</div>}
                        </td>
                        <td className="mono nowrap">{r.tlNote && !f.applies ? r.tlNote.replace(/^TL/, '') : (f.tl ?? '—')}</td>
                        {r.cells.map((cell, i) => (
                          <td key={i} className={cx('mono', i < 3 && 'nowrap')}>
                            {cell}
                          </td>
                        ))}
                        <td className="num">{kgText(f.kg, r.kgNote)}</td>
                        <td className="num">
                          {price !== undefined ? formatCredits(price) : (r.costNote ?? '—')}
                          {price !== undefined && r.costNote && <div className="tiny faint">{r.costNote}</div>}
                          {price !== undefined && mult !== 1 && <div className="tiny faint">list {formatCredits(f.cost!)}</div>}
                        </td>
                        {av && (
                          <td className="nowrap">
                            {f.found?.unavailable ? (
                              <span className="chip danger" title={f.found.unavailable}>
                                none
                              </span>
                            ) : f.found ? (
                              <button
                                className={cx('chip mono', f.found.dm < 0 && 'warn', f.found.dm > 0 && 'ok')}
                                disabled={!request}
                                onClick={() => request && setRoll(request)}
                                title={`${f.found.skills.join(' or ')} ${f.found.target}+${f.found.parts.length ? `\n${f.found.parts.map((p) => `${p.label} ${signed(p.dm)}`).join('\n')}` : ''}${request ? '\nClick to roll' : ''}`}
                              >
                                DM {signed(f.found.dm)}
                              </button>
                            ) : null}
                          </td>
                        )}
                        <td className="nowrap">
                          <div className="row gap-4" style={{ justifyContent: 'flex-end' }}>
                            {funds !== undefined && price !== undefined && (
                              <button className="btn sm primary" disabled={!!(variant && r.equipment && !f.applies)} onClick={() => void create({ ...payload, pay: true, priceMult: mult }, r.name)} title={`Pay ${formatCredits(price)} from ${holderName}`}>
                                Buy
                              </button>
                            )}
                            <button className="btn sm" disabled={!!(variant && r.equipment && !f.applies)} onClick={() => void create(payload, r.name)} title="Add without paying">
                              <Icon name="plus" size={12} /> Add
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {matching.length === 0 && <div className="pad faint small">Nothing matches.</div>}
              {matching.length > shown.length && (
                <div className="pad faint small">
                  Showing the first {shown.length} of {matching.length}: search or pick a section to narrow it down.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {roll && <CheckDialog request={roll} onClose={() => setRoll(null)} />}
    </Modal>
  );
}
