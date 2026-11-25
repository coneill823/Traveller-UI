/**
 * Rolling from a character sheet. Checks can be rolled by the app or rolled at the table and
 * typed in; either way the result is recorded in the shared log with its modifier breakdown.
 */
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { attackDm, checkDm, defaultChar, isMelee, parseDamage, traitValue } from '../../../shared/rules/character';
import type { CharKey, Character, CharacterWeapon, Id, Roll } from '../../../shared/types';
import { act } from '../../net';
import { toast, useApp, useEntity, useIsGm, useRules } from '../../store';
import { cx, Field, Modal, Segmented } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { RollCard } from '../dice/DiceDock';

interface RollPrefs {
  /** 'app' rolls on the server; 'table' asks for the dice you rolled. */
  dice: 'app' | 'table';
  /** Roll id to flash on screen. */
  flash?: Id;
}

export const useRollPrefs = create<RollPrefs>(() => ({ dice: (localStorage.getItem('traveller-ui.dice') as 'app' | 'table') || 'app' }));

export function setDiceMode(mode: 'app' | 'table'): void {
  localStorage.setItem('traveller-ui.dice', mode);
  useRollPrefs.setState({ dice: mode });
}

export function flashRoll(id: Id | undefined): void {
  if (id) useRollPrefs.setState({ flash: id });
}

/** A brief pop-up of the roll you just made, so the result is visible without opening the log. */
export function RollFlash() {
  const id = useRollPrefs((s) => s.flash);
  const roll = useEntity<Roll>(id);
  useEffect(() => {
    if (!id) return;
    const timer = setTimeout(() => useRollPrefs.setState((s) => (s.flash === id ? { flash: undefined } : s)), 7000);
    return () => clearTimeout(timer);
  }, [id]);
  if (!roll) return null;
  return (
    <div className="roll-flash" onClick={() => useRollPrefs.setState({ flash: undefined })} role="status">
      <RollCard roll={roll} />
      <button className="btn ghost sm" onClick={() => useApp.setState({ diceOpen: true })}>
        Open the roll log
      </button>
    </div>
  );
}

export function DiceModeSwitch() {
  const mode = useRollPrefs((s) => s.dice);
  return (
    <Segmented
      value={mode}
      onChange={setDiceMode}
      options={[
        { id: 'app', label: 'App dice', title: 'The app rolls for you' },
        { id: 'table', label: 'Table dice', title: 'Roll real dice and type in the result' },
      ]}
    />
  );
}

function parseDice(text: string): number[] {
  return text
    .split('')
    .filter((ch) => ch >= '1' && ch <= '6')
    .map(Number);
}

function fmt(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

export interface CheckRequest {
  character: Character;
  skill?: string;
  char?: CharKey;
  label?: string;
  /** Let the roller name any skill, including ones not on the sheet. */
  chooseSkill?: boolean;
}

/** Rolls a check straight away with the usual characteristic at Average difficulty. */
export async function quickCheck(req: CheckRequest): Promise<void> {
  try {
    const res = await act<{ id: Id }>('character.check', { id: req.character.id, skill: req.skill, char: req.char, label: req.label });
    flashRoll(res.id);
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

/** Full options for a check: characteristic, difficulty, modifier, boon/bane, table dice, secrecy. */
export function CheckDialog({ request, onClose }: { request: CheckRequest; onClose: () => void }) {
  const pack = useRules();
  const gm = useIsGm();
  const prefs = useRollPrefs();
  const c = request.character;
  const chars = (pack.characters?.characteristics ?? ['STR', 'DEX', 'END', 'INT', 'EDU', 'SOC'].map((id) => ({ id, name: id }))).filter((x) => c.chars?.[x.id as CharKey]);
  const [skillText, setSkillText] = useState(request.skill ?? '');
  const skill = request.chooseSkill ? skillText.trim() || undefined : request.skill;
  const [char, setChar] = useState<CharKey | undefined>(request.char ?? (request.skill ? defaultChar(request.skill, pack) : undefined));
  const [target, setTarget] = useState(pack.tasks?.defaultTarget ?? 8);
  const [extra, setExtra] = useState(0);
  const [mode, setMode] = useState<'normal' | 'boon' | 'bane'>('normal');
  const [secret, setSecret] = useState(false);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const table = prefs.dice === 'table';
  const dice = parseDice(manual);
  const needed = 2 + (mode === 'normal' ? 0 : 1);
  const { dm, parts } = useMemo(() => checkDm(c, { char, skill, extra }, pack), [c, char, skill, extra, pack]);
  const allSkills = useMemo(() => (pack.characters?.skills ?? []).flatMap((d) => [d.name, ...(d.specialities ?? []).map((sp) => `${d.name} (${sp.toLowerCase()})`)]), [pack]);
  const difficulties = pack.tasks?.difficulties ?? [{ name: 'Average', target: 8 }];

  const roll = async () => {
    setBusy(true);
    try {
      const res = await act<{ id: Id }>('character.check', {
        id: c.id,
        skill,
        char,
        dm: extra,
        target,
        mode: mode === 'normal' ? undefined : mode,
        manual: table ? dice : undefined,
        to: secret ? 'gm' : 'party',
        label: request.label,
      });
      flashRoll(res.id);
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(false);
  };

  return (
    <Modal
      title={request.label ?? skill ?? `${char ?? ''} check`}
      icon="dice"
      onClose={onClose}
      footer={
        <>
          <span className="grow">
            <DiceModeSwitch />
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || (table && dice.length !== needed)} onClick={() => void roll()}>
            <Icon name="dice" size={13} /> {table ? 'Record roll' : `Roll 2D ${fmt(dm)}`}
          </button>
        </>
      }
    >
      <div className="col gap-12">
        {request.chooseSkill && (
          <Field label="Skill" hint="Any skill, whether or not it is on the sheet. Leave empty for a plain characteristic check.">
            <input
              className="input"
              autoFocus
              list="all-skills"
              value={skillText}
              placeholder="e.g. Medic or Drive (wheel)"
              onChange={(e) => {
                setSkillText(e.target.value);
                const dc = defaultChar(e.target.value, pack);
                if (dc) setChar(dc);
              }}
            />
            <datalist id="all-skills">
              {allSkills.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </Field>
        )}
        <Field label="Characteristic">
          <div className="row wrap gap-4">
            {chars.map((x) => (
              <button key={x.id} className={cx('btn sm', char === x.id && 'on')} onClick={() => setChar(x.id as CharKey)} title={x.name}>
                {x.id}
              </button>
            ))}
            {skill && (
              <button className={cx('btn sm ghost', !char && 'on')} onClick={() => setChar(undefined)}>
                None
              </button>
            )}
          </div>
        </Field>
        <div className="grid-2">
          <Field label="Difficulty">
            <select className="select" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
              {difficulties.map((d) => (
                <option key={d.target} value={d.target}>
                  {d.name} ({d.target}+)
                </option>
              ))}
            </select>
          </Field>
          <Field label="Other modifiers">
            <div className="stepper" style={{ alignSelf: 'flex-start' }}>
              <button type="button" onClick={() => setExtra(extra - 1)}>
                −
              </button>
              <output>{fmt(extra)}</output>
              <button type="button" onClick={() => setExtra(extra + 1)}>
                +
              </button>
            </div>
          </Field>
        </div>
        <Field label="Boon or bane" hint="A boon rolls an extra die and drops the lowest; a bane drops the highest.">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { id: 'bane', label: 'Bane' },
              { id: 'normal', label: 'Normal' },
              { id: 'boon', label: 'Boon' },
            ]}
          />
        </Field>
        <div className="dm-breakdown">
          {parts.map((p, i) => (
            <span key={i} className="chip mono">
              {p.label} <strong>{fmt(p.dm)}</strong>
            </span>
          ))}
          <span className="chip accent mono">
            Total <strong>{fmt(dm)}</strong>
          </span>
          <span className="faint small">
            needs {Math.max(2, target - dm)}+ on the dice
          </span>
        </div>
        {table && (
          <Field label={`Dice you rolled (${needed})`}>
            <input className="input mono" autoFocus inputMode="numeric" value={manual} placeholder={needed === 2 ? '4 3' : '4 3 6'} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && dice.length === needed && void roll()} />
          </Field>
        )}
        {gm && (
          <label className="check small" style={{ color: 'var(--gm)' }}>
            <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />
            Secret roll (only the GM sees it)
          </label>
        )}
      </div>
    </Modal>
  );
}

/** Attack with a weapon: choose range and situation, roll to hit, then roll damage on a hit. */
export function AttackDialog({ character, weapon, onClose }: { character: Character; weapon: CharacterWeapon; onClose: () => void }) {
  const pack = useRules();
  const gm = useIsGm();
  const prefs = useRollPrefs();
  const combat = pack.combat;
  const melee = isMelee(weapon);
  const auto = traitValue(weapon.traits, 'Auto');
  const [band, setBand] = useState('normal');
  const [mods, setMods] = useState<Record<string, number>>({});
  const [extra, setExtra] = useState(0);
  const [char, setChar] = useState<CharKey | undefined>();
  const [fire, setFire] = useState<'single' | 'burst' | 'auto'>('single');
  const [mode, setMode] = useState<'normal' | 'boon' | 'bane'>('normal');
  const [secret, setSecret] = useState(false);
  const [manual, setManual] = useState('');
  const [manualDamage, setManualDamage] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ id: Id; hit: boolean; effect: number; damageDice: number } | null>(null);
  const [damage, setDamage] = useState<{ id: Id; total: number; ap: number; notes: string[] } | null>(null);
  const attackRoll = useEntity<Roll>(result?.id);
  const damageRoll = useEntity<Roll>(damage?.id);
  const table = prefs.dice === 'table';
  const dice = parseDice(manual);
  const dmgDice = parseDice(manualDamage);
  const needed = 2 + (mode === 'normal' ? 0 : 1);
  const effectiveMods = fire === 'single' ? mods : { ...mods, aim: 0 };
  const { dm, parts, char: usedChar } = useMemo(() => attackDm(character, weapon, { band: melee ? undefined : band, mods: effectiveMods, extra, char }, pack), [character, weapon, band, effectiveMods, extra, char, pack, melee]);
  const spec = parseDamage(weapon.damage);
  const target = combat?.attackTarget ?? 8;
  const shots = fire === 'burst' ? auto : fire === 'auto' ? auto * 3 : melee ? 0 : 1;
  const outOfAmmo = typeof weapon.ammo === 'number' && shots > weapon.ammo;

  const rollDamage = async (effect: number, typed?: number[]) => {
    try {
      const res = await act<{ id: Id; total: number; ap: number; notes: string[] }>('character.weaponDamage', { id: character.id, weaponId: weapon.id, effect, burst: fire === 'burst', manual: typed, to: secret ? 'gm' : 'party' });
      setDamage(res);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const attack = async () => {
    setBusy(true);
    try {
      const res = await act<{ id: Id; hit: boolean; effect: number; damageDice: number }>('character.attack', {
        id: character.id,
        weaponId: weapon.id,
        band: melee ? undefined : band,
        mods: effectiveMods,
        dm: extra,
        char,
        fire,
        mode: mode === 'normal' ? undefined : mode,
        manual: table ? dice : undefined,
        to: secret ? 'gm' : 'party',
      });
      setResult(res);
      // With app dice, a hit rolls its damage straight away.
      if (res.hit && spec && !table) await rollDamage(res.effect);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    setBusy(false);
  };

  return (
    <Modal
      title={`Attack with ${weapon.name}`}
      icon="crosshair"
      size="wide"
      onClose={onClose}
      footer={
        result ? (
          <>
            <span className="grow" />
            <button
              className="btn"
              onClick={() => {
                setResult(null);
                setDamage(null);
                setManual('');
                setManualDamage('');
              }}
            >
              Attack again
            </button>
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <>
            <span className="grow">
              <DiceModeSwitch />
            </span>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || outOfAmmo || (table && dice.length !== needed)} onClick={() => void attack()}>
              <Icon name="crosshair" size={13} /> {table ? 'Record attack' : `Roll 2D ${fmt(dm)}`}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div className="col gap-12">
          {attackRoll && <RollCard roll={attackRoll} />}
          <div className={cx('attack-verdict', result.hit ? 'hit' : 'miss')}>{result.hit ? `Hit — Effect ${fmt(result.effect)}` : `Miss — Effect ${result.effect}`}</div>
          {result.hit && spec && !damage && table && (
            <Field label={`Damage dice you rolled (${spec.dice})`} hint={`${weapon.damage} plus the attack's Effect${melee ? ' and STR modifier' : ''} are added for you.`}>
              <div className="row">
                <input className="input mono" autoFocus inputMode="numeric" value={manualDamage} onChange={(e) => setManualDamage(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && dmgDice.length === spec.dice && void rollDamage(result.effect, dmgDice)} />
                <button className="btn primary" disabled={dmgDice.length !== spec.dice} onClick={() => void rollDamage(result.effect, dmgDice)}>
                  Record damage
                </button>
                <button className="btn" onClick={() => void rollDamage(result.effect)}>
                  Let the app roll
                </button>
              </div>
            </Field>
          )}
          {damageRoll && <RollCard roll={damageRoll} />}
          {damage && (
            <div className="notice">
              <Icon name="info" size={14} />
              <div>
                <strong>{damage.total} damage</strong>
                {damage.ap ? `, ignoring ${damage.ap} points of armour` : ''}. The target subtracts their armour and applies the rest with “Take damage” on their sheet.
              </div>
            </div>
          )}
          {result.hit && !spec && <div className="faint small">This weapon has no damage dice; apply its effect as described.</div>}
        </div>
      ) : (
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div className="col gap-12">
            {melee ? (
              <Field label="Attack with">
                <Segmented
                  value={char ?? usedChar}
                  onChange={(v) => setChar(v as CharKey)}
                  options={[
                    { id: 'STR', label: 'Strength' },
                    { id: 'DEX', label: 'Dexterity' },
                  ]}
                />
              </Field>
            ) : (
              <Field
                label="Range"
                hint={typeof weapon.range === 'number' && combat ? `Short to ${Math.floor(weapon.range * combat.range.shortFraction)} m · normal to ${weapon.range} m · long to ${weapon.range * combat.range.longMultiple} m · extreme to ${weapon.range * combat.range.extremeMultiple} m. Beyond ${combat.range.unscopedExtremeBeyond} m counts as extreme without an aimed scope.` : undefined}
              >
                <Segmented value={band} onChange={setBand} options={(combat?.range.bands ?? [{ id: 'normal', name: 'Normal', dm: 0 }]).map((b) => ({ id: b.id, label: `${b.name}${b.dm ? ` ${fmt(b.dm)}` : ''}` }))} />
              </Field>
            )}
            {auto > 0 && (
              <Field label={`Fire mode (Auto ${auto})`} hint={fire === 'burst' ? `Adds ${auto} to damage and uses ${auto} rounds. No aiming bonus.` : fire === 'auto' ? `${auto} separate attacks using ${auto * 3} rounds: roll this attack once per target. No aiming bonus.` : undefined}>
                <Segmented
                  value={fire}
                  onChange={setFire}
                  options={[
                    { id: 'single', label: 'Single' },
                    { id: 'burst', label: 'Burst' },
                    { id: 'auto', label: 'Full auto' },
                  ]}
                />
              </Field>
            )}
            <Field label="Situation">
              <div className="col gap-4">
                {(combat?.modifiers ?? [])
                  .filter((m) => !(melee && ['aim', 'laser-sight', 'cover', 'fast'].includes(m.id)))
                  .map((m) => {
                    const count = mods[m.id] ?? 0;
                    const disabled = m.id === 'aim' && fire !== 'single';
                    return m.stack && m.stack > 1 ? (
                      <div key={m.id} className="row between" title={m.note} style={{ opacity: disabled ? 0.4 : 1 }}>
                        <span className="small">
                          {m.name} <span className="faint mono">({fmt(m.dm)} each)</span>
                        </span>
                        <div className="stepper">
                          <button type="button" disabled={disabled} onClick={() => setMods({ ...mods, [m.id]: Math.max(0, count - 1) })}>
                            −
                          </button>
                          <output>{count}</output>
                          <button type="button" disabled={disabled} onClick={() => setMods({ ...mods, [m.id]: Math.min(m.stack!, count + 1) })}>
                            +
                          </button>
                        </div>
                      </div>
                    ) : (
                      <label key={m.id} className="check small" title={m.note}>
                        <input type="checkbox" checked={count > 0} onChange={(e) => setMods({ ...mods, [m.id]: e.target.checked ? 1 : 0 })} />
                        {m.name} <span className="faint mono">{fmt(m.dm)}</span>
                      </label>
                    );
                  })}
                <div className="row between">
                  <span className="small">Other modifiers</span>
                  <div className="stepper">
                    <button type="button" onClick={() => setExtra(extra - 1)}>
                      −
                    </button>
                    <output>{fmt(extra)}</output>
                    <button type="button" onClick={() => setExtra(extra + 1)}>
                      +
                    </button>
                  </div>
                </div>
              </div>
            </Field>
          </div>
          <div className="col gap-12">
            <div className="weapon-card">
              <strong>{weapon.name}</strong>
              <div className="small dim">
                {weapon.skill} · {weapon.damage || 'no damage'} · {typeof weapon.range === 'number' ? `${weapon.range} m` : 'melee'}
              </div>
              {weapon.traits && weapon.traits.length > 0 && (
                <div className="row wrap gap-4" style={{ marginTop: 6 }}>
                  {weapon.traits.map((t) => (
                    <span key={t} className="chip" title={pack.gear?.weaponTraits.find((d) => t.startsWith(d.id))?.note}>
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {typeof weapon.ammo === 'number' && (
                <div className={cx('small', outOfAmmo && 'fuel-none')} style={{ marginTop: 6 }}>
                  {weapon.ammo} / {weapon.magazine} rounds{shots > 1 ? ` · this uses ${shots}` : ''}
                  {outOfAmmo ? ' — not enough, reload first' : ''}
                </div>
              )}
            </div>
            <Field label="Boon or bane">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { id: 'bane', label: 'Bane' },
                  { id: 'normal', label: 'Normal' },
                  { id: 'boon', label: 'Boon' },
                ]}
              />
            </Field>
            <div className="dm-breakdown">
              {parts.map((p, i) => (
                <span key={i} className="chip mono">
                  {p.label} <strong>{fmt(p.dm)}</strong>
                </span>
              ))}
              <span className="chip accent mono">
                Total <strong>{fmt(dm)}</strong>
              </span>
              <span className="faint small">hits on {Math.max(2, target - dm)}+</span>
            </div>
            {table && (
              <Field label={`Attack dice you rolled (${needed})`}>
                <input className="input mono" inputMode="numeric" value={manual} placeholder="4 3" onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && dice.length === needed && void attack()} />
              </Field>
            )}
            {gm && (
              <label className="check small" style={{ color: 'var(--gm)' }}>
                <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />
                Secret roll (only the GM sees it)
              </label>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
