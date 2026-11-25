/**
 * The character sheet. In play, everything rollable is a button: characteristics, skills and
 * weapons. The owner (or the GM) can switch to editing to change the numbers.
 */
import { useMemo, useRef, useState } from 'react';
import type { ArmourDef, WeaponDef } from '../../../shared/rulepack';
import { carryLimit, charDm, defaultChar, healthStatus, joinSkill, parseDamage, skillLevel, unskilledDm, wornProtection } from '../../../shared/rules/character';
import type { CharKey, Character, CharacterArmour, CharacterWeapon } from '../../../shared/types';
import { newId } from '../../../shared/util';
import { patch, run, setFields, upload } from '../../net';
import { navigate } from '../../router';
import { toast, useIsGm, useMe, usePlayers, useRules } from '../../store';
import { ConfirmButton, cx, EditableText, Field, Modal, Segmented, Tabs } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { KnowledgeBadge, KnowledgeControl } from '../../ui/Knowledge';
import { Markdown } from '../../ui/Markdown';
import { Notes } from '../../ui/Notes';
import { AttackDialog, CheckDialog, DiceModeSwitch, quickCheck, useRollPrefs, type CheckRequest } from './rolling';

const CHAR_ORDER: CharKey[] = ['STR', 'DEX', 'END', 'INT', 'EDU', 'SOC', 'PSI'];

function fmt(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

export function characterName(c: Character | undefined): string {
  if (!c) return 'Unknown';
  return c.name ?? (c.kind === 'creature' ? 'Unknown creature' : c.kind === 'npc' ? 'Unknown figure' : 'Unnamed traveller');
}

export function HealthBars({ c }: { c: Character }) {
  const keys = (['END', 'STR', 'DEX'] as CharKey[]).filter((k) => c.chars?.[k]);
  if (keys.length === 0) return null;
  return (
    <div className="health">
      {keys.map((k) => {
        const s = c.chars![k]!;
        const pct = s.max > 0 ? Math.max(0, Math.min(100, (s.value / s.max) * 100)) : 0;
        return (
          <div key={k} className="health-row" title={`${k} ${s.value} of ${s.max}`}>
            <span>{k}</span>
            <div className="health-bar">
              <i style={{ width: `${pct}%` }} className={cx(pct <= 0 ? 'zero' : pct < 50 ? 'low' : '')} />
            </div>
            <span className="mono">
              {s.value}/{s.max}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────────── damage & healing ─────────────────────────────

function DamageDialog({ c, onClose }: { c: Character; onClose: () => void }) {
  const [amount, setAmount] = useState('');
  const [armour, setArmour] = useState(true);
  const [ap, setAp] = useState('');
  const [laser, setLaser] = useState(false);
  const [stun, setStun] = useState(false);
  const [prefer, setPrefer] = useState<'auto' | 'STR' | 'DEX'>('auto');
  const protection = wornProtection(c, { laser });
  const n = Number(amount) || 0;
  const through = Math.max(0, n - (armour ? Math.max(0, protection - (Number(ap) || 0)) : 0));
  const apply = async () => {
    const res = await run<{ taken: number; absorbed: number; status: string; stunnedRounds?: number }>('character.damage', {
      id: c.id,
      amount: n,
      armour,
      ap: Number(ap) || 0,
      laser,
      stun,
      prefer: prefer === 'auto' ? undefined : prefer,
    });
    if (res) {
      toast(`${characterName(c)} takes ${res.taken} damage${res.absorbed ? ` (${res.absorbed} stopped by armour)` : ''}${res.status === 'unconscious' ? ' and is out of action' : res.status === 'dead' ? ' and is killed' : ''}.`, res.status === 'ok' || res.status === 'wounded' ? 'info' : 'error');
      onClose();
    }
  };
  return (
    <Modal
      title={`${characterName(c)} takes damage`}
      icon="shield"
      onClose={onClose}
      footer={
        <>
          <span className="grow small dim">{n > 0 ? `${through} gets through` : ''}</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={n <= 0} onClick={() => void apply()}>
            Apply damage
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <div className="grid-2">
          <Field label="Damage rolled">
            <input className="input mono" autoFocus inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && n > 0 && void apply()} />
          </Field>
          <Field label="Armour piercing (AP)" hint="Points of armour the weapon ignores.">
            <input className="input mono" inputMode="numeric" value={ap} onChange={(e) => setAp(e.target.value.replace(/\D/g, ''))} placeholder="0" />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={armour} onChange={(e) => setArmour(e.target.checked)} />
          Subtract worn armour ({protection} protection)
        </label>
        <div className="row wrap gap-16">
          <label className="check small">
            <input type="checkbox" checked={laser} onChange={(e) => setLaser(e.target.checked)} />
            Laser weapon
          </label>
          <label className="check small" title="Stun damage only comes off END">
            <input type="checkbox" checked={stun} onChange={(e) => setStun(e.target.checked)} />
            Stun weapon
          </label>
        </div>
        {!stun && (
          <Field label="Once END is gone, take it from" hint="Damage comes off END first. The rest comes off STR or DEX, the target's choice.">
            <Segmented
              value={prefer}
              onChange={setPrefer}
              options={[
                { id: 'auto', label: 'Whichever is higher' },
                { id: 'STR', label: 'STR' },
                { id: 'DEX', label: 'DEX' },
              ]}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ───────────────────────────── gear pickers ─────────────────────────────

function WeaponPicker({ c, onClose }: { c: Character; onClose: () => void }) {
  const gear = useRules().gear;
  const [q, setQ] = useState('');
  const [custom, setCustom] = useState({ name: '', skill: 'Gun Combat (slug)', damage: '3D', range: '10', traits: '' });
  const list = useMemo(() => (gear?.weapons ?? []).filter((w) => !q.trim() || `${w.name} ${w.group} ${w.skill}`.toLowerCase().includes(q.trim().toLowerCase())), [gear, q]);
  const add = async (w: CharacterWeapon) => {
    await patch(c.id, [{ op: 'push', path: ['weapons'], value: w }]);
    toast(`${w.name} added`, 'ok');
  };
  const fromDef = (d: WeaponDef): CharacterWeapon => ({
    id: newId('wpn'),
    defId: d.id,
    name: d.tl !== undefined && (gear?.weapons.filter((x) => x.name === d.name).length ?? 0) > 1 ? `${d.name} (TL${d.tl})` : d.name,
    skill: d.skill,
    damage: d.damage,
    range: d.range,
    traits: d.traits,
    magazine: d.magazine,
    ammo: typeof d.magazine === 'number' ? d.magazine : undefined,
    note: d.note,
  });
  return (
    <Modal title="Add a weapon" icon="sword" size="wide" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="col gap-12">
        <input className="input" autoFocus placeholder="Search weapons…" value={q} onChange={(e) => setQ(e.target.value)} />
        {list.length > 0 ? (
          <div className="scroll" style={{ maxHeight: 340, border: '1px solid var(--line)' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Weapon</th>
                  <th>TL</th>
                  <th>Range</th>
                  <th>Damage</th>
                  <th>Traits</th>
                  <th className="num">Cost</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((w) => (
                  <tr key={w.id}>
                    <td>
                      {w.name}
                      <div className="tiny faint">{w.skill}</div>
                    </td>
                    <td className="mono">{w.tl ?? '—'}</td>
                    <td className="mono">{typeof w.range === 'number' ? `${w.range} m` : 'Melee'}</td>
                    <td className="mono">{w.damage || '—'}</td>
                    <td className="small dim">{w.traits?.join(', ')}</td>
                    <td className="num">{w.cost !== undefined ? `Cr${w.cost.toLocaleString('en-GB')}` : '—'}</td>
                    <td>
                      <button className="btn sm" onClick={() => void add(fromDef(w))}>
                        <Icon name="plus" size={12} /> Add
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="faint small">{gear ? 'No weapons match.' : 'No weapon catalogue is installed; add a custom weapon below.'}</div>
        )}
        <div className="panel">
          <div className="panel-head">
            <h3>Custom weapon</h3>
          </div>
          <div className="panel-body col">
            <div className="grid-3">
              <Field label="Name">
                <input className="input" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
              </Field>
              <Field label="Skill">
                <input className="input" value={custom.skill} onChange={(e) => setCustom({ ...custom, skill: e.target.value })} />
              </Field>
              <Field label="Damage" error={custom.damage && !parseDamage(custom.damage) ? 'e.g. 3D or 2D+3' : undefined}>
                <input className="input mono" value={custom.damage} onChange={(e) => setCustom({ ...custom, damage: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="Range (m)" hint="Leave empty for melee.">
                <input className="input mono" value={custom.range} onChange={(e) => setCustom({ ...custom, range: e.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field label="Traits" hint="Comma separated, e.g. AP 3, Auto 2">
                <input className="input" value={custom.traits} onChange={(e) => setCustom({ ...custom, traits: e.target.value })} />
              </Field>
            </div>
            <div>
              <button
                className="btn"
                disabled={!custom.name.trim()}
                onClick={() =>
                  void add({
                    id: newId('wpn'),
                    name: custom.name.trim(),
                    skill: custom.skill.trim() || 'Melee (unarmed)',
                    damage: custom.damage.trim(),
                    range: custom.range ? Number(custom.range) : 'melee',
                    traits: custom.traits
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })
                }
              >
                <Icon name="plus" size={12} /> Add custom weapon
              </button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ArmourPicker({ c, onClose }: { c: Character; onClose: () => void }) {
  const gear = useRules().gear;
  const [custom, setCustom] = useState({ name: '', protection: '' });
  const add = async (a: CharacterArmour) => {
    await patch(c.id, [{ op: 'push', path: ['armour'], value: a }]);
    toast(`${a.name} added`, 'ok');
  };
  const fromDef = (d: ArmourDef): CharacterArmour => ({ id: newId('arm'), defId: d.id, name: `${d.name} (TL${d.tl})`, protection: d.protection, laserProtection: d.laserProtection, rad: d.rad, kg: d.kg, worn: (c.armour ?? []).every((x) => !x.worn), note: d.note });
  return (
    <Modal title="Add armour" icon="shield" size="wide" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="col gap-12">
        {gear && (
          <div className="scroll" style={{ maxHeight: 340, border: '1px solid var(--line)' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Armour</th>
                  <th>TL</th>
                  <th>Protection</th>
                  <th>Rad</th>
                  <th>Kg</th>
                  <th>Needs</th>
                  <th className="num">Cost</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {gear.armour.map((a) => (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td className="mono">{a.tl}</td>
                    <td className="mono">
                      +{a.protection}
                      {a.laserProtection !== undefined ? ` (+${a.laserProtection} vs lasers)` : ''}
                    </td>
                    <td className="mono">{a.rad ?? '—'}</td>
                    <td className="mono">{a.kg}</td>
                    <td className="small dim">{a.skill ? `${a.skill.name} ${a.skill.level}` : ''}</td>
                    <td className="num">Cr{a.cost.toLocaleString('en-GB')}</td>
                    <td>
                      <button className="btn sm" onClick={() => void add(fromDef(a))}>
                        <Icon name="plus" size={12} /> Add
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row">
          <input className="input" style={{ maxWidth: 260 }} placeholder="Custom armour name" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
          <input className="input mono" style={{ maxWidth: 110 }} placeholder="Protection" value={custom.protection} onChange={(e) => setCustom({ ...custom, protection: e.target.value.replace(/\D/g, '') })} />
          <button className="btn" disabled={!custom.name.trim()} onClick={() => void add({ id: newId('arm'), name: custom.name.trim(), protection: Number(custom.protection) || 0, worn: true })}>
            <Icon name="plus" size={12} /> Add custom
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SkillAdder({ c }: { c: Character }) {
  const defs = useRules().characters?.skills ?? [];
  const [base, setBase] = useState('');
  const [spec, setSpec] = useState('');
  const [other, setOther] = useState('');
  const def = defs.find((d) => d.name === base);
  const name = base === '__other' ? other.trim() : joinSkill(base, spec === '__other' ? other.trim() : spec || undefined);
  const add = () => {
    if (!name) return;
    if (c.skills && name in c.skills) {
      toast(`${name} is already on the sheet`, 'error');
      return;
    }
    void patch(c.id, [{ op: 'set', path: ['skills', name], value: def?.specialities?.length && !spec ? 0 : 1 }]);
    setSpec('');
    setOther('');
  };
  return (
    <div className="row wrap">
      <select
        className="select"
        style={{ maxWidth: 190 }}
        value={base}
        onChange={(e) => {
          setBase(e.target.value);
          setSpec('');
        }}
        aria-label="Skill"
      >
        <option value="">Add a skill…</option>
        {defs.map((d) => (
          <option key={d.name} value={d.name}>
            {d.name}
          </option>
        ))}
        <option value="__other">Other…</option>
      </select>
      {def?.specialities && (
        <select className="select" style={{ maxWidth: 170 }} value={spec} onChange={(e) => setSpec(e.target.value)} aria-label="Speciality">
          <option value="">Level 0 (no speciality)</option>
          {def.specialities.map((s) => (
            <option key={s} value={s.toLowerCase()}>
              {s}
            </option>
          ))}
          {def.openSpecialities && <option value="__other">Other…</option>}
        </select>
      )}
      {(base === '__other' || spec === '__other') && <input className="input" style={{ maxWidth: 170 }} placeholder={base === '__other' ? 'Skill name' : 'Speciality'} value={other} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />}
      <button className="btn sm" disabled={!base || (base === '__other' && !other.trim()) || (spec === '__other' && !other.trim())} onClick={add}>
        <Icon name="plus" size={12} /> Add
      </button>
    </div>
  );
}

// ───────────────────────────── the sheet ─────────────────────────────

export function Sheet({ c }: { c: Character }) {
  const pack = useRules();
  const gm = useIsGm();
  const me = useMe();
  const players = usePlayers();
  const diceMode = useRollPrefs((s) => s.dice);
  const canEdit = gm || (c.kind === 'pc' && c.ownerId === me?.playerId && !me?.viewAs);
  const [editing, setEditing] = useState(false);
  const [check, setCheck] = useState<CheckRequest | null>(null);
  const [attack, setAttack] = useState<CharacterWeapon | null>(null);
  const [dialog, setDialog] = useState<'damage' | 'weapon' | 'armour' | null>(null);
  const [tab, setTab] = useState<'actions' | 'background' | 'notes'>('actions');
  const [skillFilter, setSkillFilter] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const edit = canEdit && editing;
  const owner = players.find((p) => p.id === c.ownerId);
  const status = healthStatus(c);
  const known = c.chars !== undefined;
  const charDefs = pack.characters?.characteristics;
  const keys = CHAR_ORDER.filter((k) => c.chars?.[k] || (edit && k !== 'PSI'));
  const skills = useMemo(() => Object.entries(c.skills ?? {}).sort((a, b) => a[0].localeCompare(b[0])), [c.skills]);
  const shownSkills = skills.filter(([name]) => !skillFilter.trim() || name.toLowerCase().includes(skillFilter.trim().toLowerCase()));
  const protection = wornProtection(c);
  const speciesDef = pack.characters?.species.find((s) => s.name === c.species);

  /** Click = roll now with the usual characteristic; table dice (or shift-click) opens the options. */
  const roll = (req: CheckRequest, e?: React.MouseEvent) => {
    if (!canEdit) return;
    if (diceMode === 'table' || e?.shiftKey) setCheck(req);
    else void quickCheck(req);
  };

  const setChar = (key: CharKey, field: 'value' | 'max', n: number) => {
    const current = c.chars?.[key] ?? { value: 0, max: 0 };
    const next = { ...current, [field]: Math.max(0, n) };
    // Changing the full score of an unhurt characteristic moves the current value with it.
    if (field === 'max' && current.value === current.max) next.value = next.max;
    if (next.value > next.max) next.value = next.max;
    void setFields(c.id, { [`chars.${key}`]: next });
  };

  const uploadPortrait = async (file: File) => {
    try {
      const res = await upload(file);
      await setFields(c.id, { portrait: res.url });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="sheet">
      <header className="sheet-head">
        <button className="btn sm" onClick={() => navigate('/characters')}>
          <Icon name="chevronLeft" size={13} /> Roster
        </button>
        <button className={cx('portrait', edit && 'editable')} onClick={() => edit && fileRef.current?.click()} disabled={!edit} title={edit ? 'Upload a portrait' : undefined} style={c.portrait ? { backgroundImage: `url(${c.portrait})` } : undefined}>
          {!c.portrait && <Icon name={c.kind === 'creature' ? 'star' : 'user'} size={26} />}
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => e.target.files?.[0] && void uploadPortrait(e.target.files[0])} />
        <div className="grow">
          <h1>
            <EditableText value={c.name} disabled={!edit} placeholder={characterName(c)} onCommit={(name) => void setFields(c.id, { name: name || undefined })} />
          </h1>
          <div className="row wrap gap-4 small dim">
            <EditableText value={c.title} disabled={!edit} placeholder={edit ? 'Role or rank' : ''} onCommit={(title) => void setFields(c.id, { title: title || undefined })} />
            {c.title && <span>·</span>}
            {edit ? (
              <select className="select" style={{ width: 120, height: 24 }} value={c.species ?? ''} onChange={(e) => void setFields(c.id, { species: e.target.value })} aria-label="Species">
                {[...(pack.characters?.species.map((s) => s.name) ?? ['Human']), ...(c.species && !pack.characters?.species.some((s) => s.name === c.species) ? [c.species] : [])].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            ) : (
              c.species && <span>{c.species}</span>
            )}
            {(c.age !== undefined || edit) && (
              <span className="row gap-4">
                · age <EditableText value={c.age === undefined ? '' : String(c.age)} disabled={!edit} placeholder="—" inputClassName="mono" onCommit={(v) => void setFields(c.id, { age: v ? Number(v) || undefined : undefined })} />
              </span>
            )}
            {(c.homeworld || edit) && (
              <span className="row gap-4">
                · from <EditableText value={c.homeworld} disabled={!edit} placeholder="homeworld" onCommit={(v) => void setFields(c.id, { homeworld: v || undefined })} />
              </span>
            )}
          </div>
          <div className="row wrap gap-4" style={{ marginTop: 6 }}>
            <span className="chip">{c.kind === 'pc' ? 'Traveller' : c.kind === 'npc' ? 'NPC' : 'Creature'}</span>
            {owner && (
              <span className="chip">
                <span className="dot" style={{ background: owner.color }} /> {owner.name}
              </span>
            )}
            {status === 'wounded' && <span className="chip warn">Wounded</span>}
            {(c.conditions ?? []).map((x) => (
              <span key={x} className="chip danger">
                {x}
                {edit && (
                  <button className="chip-x" onClick={() => void patch(c.id, [{ op: 'pull', path: ['conditions'], value: x }])} aria-label={`Remove ${x}`}>
                    ×
                  </button>
                )}
              </span>
            ))}
            {gm && c.kind !== 'pc' && <KnowledgeBadge entity={c} />}
          </div>
        </div>
        <div className="col" style={{ alignItems: 'flex-end' }}>
          {canEdit && (
            <div className="row">
              <DiceModeSwitch />
              <button className={cx('btn', editing && 'on')} onClick={() => setEditing((v) => !v)}>
                <Icon name="edit" size={13} /> {editing ? 'Done editing' : 'Edit'}
              </button>
            </div>
          )}
          {canEdit && known && (
            <div className="row">
              <button className="btn danger" onClick={() => setDialog('damage')}>
                <Icon name="shield" size={13} /> Take damage
              </button>
              <button className="btn" onClick={() => void run('character.heal', { id: c.id, full: true }, 'Fully healed')} disabled={status === 'ok'}>
                Heal all
              </button>
            </div>
          )}
        </div>
      </header>

      {!known ? (
        <div className="page">
          <div className="notice">
            <Icon name="eyeOff" size={14} /> You do not know this {c.kind === 'creature' ? 'creature' : 'person'}&apos;s abilities yet.
          </div>
        </div>
      ) : (
        <div className="sheet-body">
          {/* ── characteristics ── */}
          <section className="sheet-col">
            <h3>Characteristics</h3>
            <div className="char-grid">
              {keys.map((k) => {
                const s = c.chars?.[k] ?? { value: 0, max: 0 };
                const dm = charDm(s.value, pack.tasks);
                const hurt = s.value < s.max;
                const name = charDefs?.find((d) => d.id === k)?.name ?? k;
                return edit ? (
                  <div key={k} className="char-tile editing">
                    <span className="char-key">{k}</span>
                    <label className="tiny faint">
                      now
                      <input className="input mono" type="number" min={0} value={s.value} onChange={(e) => setChar(k, 'value', Number(e.target.value))} aria-label={`${name} current`} />
                    </label>
                    <label className="tiny faint">
                      full
                      <input className="input mono" type="number" min={0} value={s.max} onChange={(e) => setChar(k, 'max', Number(e.target.value))} aria-label={`${name} full score`} />
                    </label>
                  </div>
                ) : (
                  <button key={k} className={cx('char-tile', hurt && 'hurt')} onClick={(e) => roll({ character: c, char: k, label: `${name} check` }, e)} disabled={!canEdit} title={canEdit ? `Roll a ${name} check (shift-click for options)` : name}>
                    <span className="char-key">{k}</span>
                    <span className="char-val">{s.value}</span>
                    {hurt && <span className="char-max">of {s.max}</span>}
                    <span className="char-dm">{fmt(dm)}</span>
                  </button>
                );
              })}
            </div>
            {edit && !c.chars?.PSI && (
              <button className="btn sm ghost" onClick={() => void setFields(c.id, { 'chars.PSI': { value: 7, max: 7 } })}>
                <Icon name="plus" size={12} /> Add PSI
              </button>
            )}

            <h3 style={{ marginTop: 16 }}>Armour</h3>
            <div className="row">
              <span className="big-number">{protection}</span>
              <span className="small dim">
                protection worn
                {wornProtection(c, { laser: true }) !== protection ? ` · ${wornProtection(c, { laser: true })} vs lasers` : ''}
              </span>
            </div>
            <div className="col gap-4">
              {(c.armour ?? []).map((a) => (
                <div key={a.id} className="gear-row" title={a.note}>
                  <label className="check grow">
                    <input type="checkbox" checked={a.worn} disabled={!canEdit} onChange={(e) => void patch(c.id, [{ op: 'set', path: ['armour', a.id, 'worn'], value: e.target.checked }])} />
                    {a.name}
                  </label>
                  <span className="mono small">
                    +{a.protection}
                    {a.laserProtection !== undefined ? `/${a.laserProtection}L` : ''}
                  </span>
                  {edit && (
                    <button className="btn ghost icon sm" onClick={() => void patch(c.id, [{ op: 'del', path: ['armour', a.id] }])} aria-label={`Remove ${a.name}`}>
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </div>
              ))}
              {(c.armour ?? []).length === 0 && <span className="faint small">No armour.</span>}
              {canEdit && (
                <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setDialog('armour')}>
                  <Icon name="plus" size={12} /> Armour
                </button>
              )}
            </div>

            <h3 style={{ marginTop: 16 }}>Other</h3>
            <dl className="kv">
              <dt>Credits</dt>
              <dd className="mono">
                Cr <EditableText value={String(c.credits ?? 0)} disabled={!canEdit} inputClassName="mono" onCommit={(v) => void setFields(c.id, { credits: Math.round(Number(v.replace(/[^\d.-]/g, '')) || 0) })} />
              </dd>
              <dt>Movement</dt>
              <dd>{c.movement ?? speciesDef?.movement ?? pack.combat?.movement ?? 6} m per minor action</dd>
              <dt>Carry</dt>
              <dd title={pack.characters?.encumbrance.note}>{carryLimit(c)} kg without penalty</dd>
            </dl>
            {(c.traits ?? []).length > 0 && (
              <div className="col gap-4" style={{ marginTop: 8 }}>
                {c.traits!.map((t) => (
                  <div key={t} className="small dim">
                    <Icon name="star" size={11} /> {t}
                  </div>
                ))}
              </div>
            )}
            {edit && (
              <div className="row" style={{ marginTop: 8 }}>
                <input
                  className="input"
                  placeholder="Add a condition (e.g. Fatigued)"
                  onKeyDown={(e) => {
                    const v = e.currentTarget.value.trim();
                    if (e.key === 'Enter' && v) {
                      void patch(c.id, [{ op: 'push', path: ['conditions'], value: v }]);
                      e.currentTarget.value = '';
                    }
                  }}
                />
              </div>
            )}
          </section>

          {/* ── skills ── */}
          <section className="sheet-col">
            <div className="section-title">
              <h3>Skills</h3>
              <input className="input" style={{ maxWidth: 150, height: 24 }} placeholder="Filter…" value={skillFilter} onChange={(e) => setSkillFilter(e.target.value)} aria-label="Filter skills" />
            </div>
            <div className="skill-list">
              {shownSkills.map(([name, level]) => {
                const dc = defaultChar(name, pack);
                const total = level + (dc ? charDm(c.chars?.[dc]?.value, pack.tasks) : 0);
                return (
                  <div key={name} className="skill-row">
                    <button className="skill-main" disabled={!canEdit} onClick={(e) => roll({ character: c, skill: name }, e)} title={canEdit ? 'Roll (shift-click for options)' : undefined}>
                      <span className="skill-level">{level}</span>
                      <span className="grow">{name}</span>
                      {dc && <span className="tiny faint">{dc}</span>}
                      <span className="skill-total mono">{fmt(total)}</span>
                    </button>
                    {canEdit && !edit && (
                      <button className="btn ghost icon sm" title="Roll with options" onClick={() => setCheck({ character: c, skill: name })}>
                        <Icon name="settings" size={12} />
                      </button>
                    )}
                    {edit && (
                      <>
                        <div className="stepper">
                          <button type="button" onClick={() => void patch(c.id, [{ op: 'set', path: ['skills', name], value: Math.max(0, level - 1) }])}>
                            −
                          </button>
                          <output>{level}</output>
                          <button type="button" onClick={() => void patch(c.id, [{ op: 'set', path: ['skills', name], value: Math.min(15, level + 1) }])}>
                            +
                          </button>
                        </div>
                        <button className="btn ghost icon sm" onClick={() => void patch(c.id, [{ op: 'del', path: ['skills', name] }])} aria-label={`Remove ${name}`}>
                          <Icon name="x" size={12} />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
              {skills.length === 0 && <div className="faint small">No skills yet.{canEdit ? ' Switch to Edit to add some.' : ''}</div>}
            </div>
            {canEdit && skills.length > 0 && !edit && (
              <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setCheck({ character: c, chooseSkill: true })} title="Roll for a skill that is not on the sheet">
                <Icon name="dice" size={12} /> Roll another skill…
              </button>
            )}
            {canEdit && skills.length > 0 && <div className="tiny faint">Unskilled checks take {fmt(unskilledDm(c.skills, pack))}.</div>}
            {edit && <SkillAdder c={c} />}
          </section>

          {/* ── actions / background ── */}
          <section className="sheet-col wide">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'actions', label: 'Actions' },
                { id: 'background', label: 'Background' },
                { id: 'notes', label: gm && c.kind !== 'pc' ? 'Notes & knowledge' : 'Notes' },
              ]}
            />
            {tab === 'actions' && (
              <div className="col gap-12" style={{ paddingTop: 12 }}>
                <div className="section-title">
                  <h3>Attacks</h3>
                  {canEdit && (
                    <button className="btn sm" onClick={() => setDialog('weapon')}>
                      <Icon name="plus" size={12} /> Weapon
                    </button>
                  )}
                </div>
                {(c.weapons ?? []).map((w) => {
                  const lvl = skillLevel(c.skills, w.skill);
                  return (
                    <div key={w.id} className="weapon-row">
                      <div className="grow">
                        <strong>{w.name}</strong>
                        <div className="small dim">
                          {w.skill} {lvl === null ? '(unskilled)' : lvl} · <span className="mono">{w.damage || 'no damage'}</span> · {typeof w.range === 'number' ? `${w.range} m` : 'melee'}
                          {w.traits?.length ? ` · ${w.traits.join(', ')}` : ''}
                        </div>
                        {w.note && <div className="tiny faint">{w.note}</div>}
                      </div>
                      {typeof w.ammo === 'number' && (
                        <button className={cx('chip mono', w.ammo === 0 && 'danger')} disabled={!canEdit} onClick={() => void run('character.reload', { id: c.id, weaponId: w.id })} title="Click to reload (a minor action)">
                          {w.ammo}/{w.magazine}
                        </button>
                      )}
                      {canEdit && (
                        <button className="btn primary sm" onClick={() => setAttack(w)}>
                          <Icon name="crosshair" size={12} /> Attack
                        </button>
                      )}
                      {edit && (
                        <button className="btn ghost icon sm" onClick={() => void patch(c.id, [{ op: 'del', path: ['weapons', w.id] }])} aria-label={`Remove ${w.name}`}>
                          <Icon name="x" size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
                {(c.weapons ?? []).length === 0 && <div className="faint small">No weapons. Everyone can still attack unarmed: add “Unarmed” from the weapon list.</div>}

                {canEdit && (
                  <>
                    <h3>In a fight</h3>
                    <div className="row wrap">
                      {(pack.combat?.initiative.characteristics ?? ['DEX', 'INT']).map((k) => (
                        <button key={k} className="btn sm" onClick={(e) => roll({ character: c, char: k as CharKey, label: `Initiative (${k})` }, e)} title={pack.combat?.initiative.note}>
                          Initiative ({k})
                        </button>
                      ))}
                    </div>
                    <div className="action-ref">
                      {(['significant', 'minor', 'reaction', 'free'] as const).map((type) => (
                        <div key={type}>
                          <div className="label">{type === 'significant' ? 'Significant action (1)' : type === 'minor' ? 'Minor actions (1, or 3 with no significant action)' : type === 'reaction' ? 'Reactions' : 'Free actions'}</div>
                          <div className="row wrap gap-4">
                            {(pack.combat?.actions ?? [])
                              .filter((a) => a.type === type)
                              .map((a) => (
                                <span key={a.id} className="chip" title={a.note}>
                                  {a.name}
                                </span>
                              ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {tab === 'background' && (
              <div className="col gap-12" style={{ paddingTop: 12 }}>
                <div className="section-title">
                  <h3>Careers</h3>
                  {edit && (
                    <button className="btn sm" onClick={() => void patch(c.id, [{ op: 'push', path: ['careers'], value: { name: pack.characters?.careers[0] ?? 'Drifter', terms: 1 } }])}>
                      <Icon name="plus" size={12} /> Career
                    </button>
                  )}
                </div>
                {(c.careers ?? []).map((career, i) =>
                  edit ? (
                    <div key={i} className="row">
                      <input className="input" list="career-names" value={career.name} onChange={(e) => void patch(c.id, [{ op: 'set', path: ['careers', i, 'name'], value: e.target.value }])} aria-label="Career" />
                      <input className="input mono" style={{ width: 70 }} type="number" min={0} value={career.terms} onChange={(e) => void patch(c.id, [{ op: 'set', path: ['careers', i, 'terms'], value: Number(e.target.value) || 0 }])} aria-label="Terms" />
                      <input className="input" placeholder="Rank" value={career.rank ?? ''} onChange={(e) => void patch(c.id, [{ op: 'set', path: ['careers', i, 'rank'], value: e.target.value }])} aria-label="Rank" />
                      <button className="btn ghost icon sm" onClick={() => void patch(c.id, [{ op: 'del', path: ['careers', i] }])} aria-label="Remove career">
                        <Icon name="x" size={12} />
                      </button>
                    </div>
                  ) : (
                    <div key={i}>
                      <strong>{career.name}</strong> <span className="dim">· {career.terms} term{career.terms === 1 ? '' : 's'}</span>
                      {career.rank && <span className="dim"> · {career.rank}</span>}
                    </div>
                  ),
                )}
                <datalist id="career-names">{(pack.characters?.careers ?? []).map((n) => <option key={n} value={n} />)}</datalist>
                {(c.careers ?? []).length === 0 && !edit && <div className="faint small">No careers recorded.</div>}
                <h3>Background</h3>
                {edit ? <textarea className="textarea" rows={8} defaultValue={c.bio ?? ''} placeholder="Who is this traveller? The rest of the party can read this." onBlur={(e) => e.target.value !== (c.bio ?? '') && void setFields(c.id, { bio: e.target.value || undefined })} /> : c.bio ? <Markdown text={c.bio} /> : <div className="faint small">Nothing written yet.</div>}
                {(c.secrets !== undefined || edit) && (c.ownerId === me?.playerId || gm) && (
                  <>
                    <h3 style={{ color: 'var(--gm)' }}>
                      <Icon name="lock" size={12} /> Private notes
                    </h3>
                    <div className="tiny faint">Only {c.kind === 'pc' ? 'this character’s player and the GM' : 'the GM'} can read these.</div>
                    {edit ? <textarea className="textarea" rows={5} defaultValue={c.secrets ?? ''} onBlur={(e) => e.target.value !== (c.secrets ?? '') && void setFields(c.id, { secrets: e.target.value || undefined })} /> : <Markdown text={c.secrets ?? ''} />}
                  </>
                )}
              </div>
            )}
            {tab === 'notes' && (
              <div style={{ margin: '0 -12px' }}>
                {gm && c.kind !== 'pc' && (
                  <div className="section gm-section">
                    <h3>Who knows what</h3>
                    <KnowledgeControl entity={c} />
                  </div>
                )}
                <Notes entity={c} title="Notes" />
                {gm && (
                  <div className="section">
                    {c.kind === 'pc' && (
                      <Field label="Played by">
                        <select className="select" style={{ maxWidth: 220 }} value={c.ownerId ?? ''} onChange={(e) => void setFields(c.id, { ownerId: e.target.value || undefined })}>
                          <option value="">Nobody (GM)</option>
                          {players.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                  </div>
                )}
                {canEdit && (
                  <div className="section">
                    <ConfirmButton
                      label="Delete character"
                      confirm="Delete for good"
                      icon="trash"
                      onConfirm={() => {
                        navigate('/characters');
                        void run('entity.delete', { id: c.id });
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {check && <CheckDialog request={check} onClose={() => setCheck(null)} />}
      {attack && <AttackDialog character={c} weapon={attack} onClose={() => setAttack(null)} />}
      {dialog === 'damage' && <DamageDialog c={c} onClose={() => setDialog(null)} />}
      {dialog === 'weapon' && <WeaponPicker c={c} onClose={() => setDialog(null)} />}
      {dialog === 'armour' && <ArmourPicker c={c} onClose={() => setDialog(null)} />}
    </div>
  );
}
