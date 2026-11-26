/**
 * The action bar: a turn is put together by dragging actions into order, ticking each off as it is
 * resolved at the table and noting the rolls. Nothing is shown to the rest of the table until it
 * is published.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CombatRules } from '../../../shared/rulepack';
import type { Character, CharacterWeapon, Encounter, Id, TurnStep } from '../../../shared/types';
import { newId } from '../../../shared/util';
import { act } from '../../net';
import { toast, useRules, useType } from '../../store';
import { cx } from '../../ui/basics';
import { beginDrag, useDropZone } from '../../ui/drag';
import { Icon } from '../../ui/Icon';
import { AttackDialog, CheckDialog } from '../characters/rolling';
import type { CombatantInfo } from './model';

type ActionDef = CombatRules['actions'][number];

/** What is offered when no rules pack supplies the list of combat actions. */
const FALLBACK_ACTIONS: ActionDef[] = [
  { id: 'attack', name: 'Attack', type: 'significant', note: 'A melee or ranged attack.' },
  { id: 'skill', name: 'Skill check / other', type: 'significant', note: 'Anything that needs full attention.' },
  { id: 'move', name: 'Move', type: 'minor', note: 'Move up to your Movement.' },
  { id: 'aim', name: 'Aim', type: 'minor', note: 'Steady your next shot.' },
  { id: 'minor', name: 'Other minor action', type: 'minor', note: 'Something quick.' },
  { id: 'free', name: 'Free action', type: 'free', note: 'A shout, a button pushed.' },
];

const TYPE_LABEL: Record<TurnStep['type'], string> = { significant: 'Significant', minor: 'Minor', free: 'Free', reaction: 'Reaction' };

/** The turn being planned, kept through a page reload until it is published. */
export function usePlan(key: string): [TurnStep[], (next: TurnStep[]) => void] {
  const storageKey = `traveller.plan.${key}`;
  const [steps, setSteps] = useState<TurnStep[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storageKey) ?? '[]') as TurnStep[];
    } catch {
      return [];
    }
  });
  const lastKey = useRef(storageKey);
  useEffect(() => {
    if (lastKey.current === storageKey) return;
    lastKey.current = storageKey;
    try {
      setSteps(JSON.parse(sessionStorage.getItem(storageKey) ?? '[]') as TurnStep[]);
    } catch {
      setSteps([]);
    }
  }, [storageKey]);
  const update = (next: TurnStep[]) => {
    setSteps(next);
    try {
      if (next.length) sessionStorage.setItem(storageKey, JSON.stringify(next));
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* storage full or unavailable: the plan simply will not survive a reload */
    }
  };
  return [steps, update];
}

export function newStep(def: ActionDef): TurnStep {
  return { id: newId('stp'), action: def.id, type: def.type, label: def.name };
}

export function actionDefs(rules: CombatRules | undefined): ActionDef[] {
  return rules?.actions?.length ? rules.actions : FALLBACK_ACTIONS;
}

interface Props {
  encounter: Encounter;
  actor: CombatantInfo;
  infos: Map<Id, CombatantInfo>;
  steps: TurnStep[];
  setSteps: (next: TurnStep[]) => void;
  /** The step whose target is picked by clicking a card or token. */
  focus?: Id;
  setFocus: (id: Id | undefined) => void;
  distanceTo: (targetId: Id) => number | undefined;
  moveMetres?: number;
}

function IntBox({ value, onChange, label, width = 56, placeholder }: { value: number | undefined; onChange: (n: number | undefined) => void; label: string; width?: number; placeholder?: string }) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    if (draft.trim() === '') {
      if (value !== undefined) onChange(undefined);
      return;
    }
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n)) {
      setDraft(value === undefined ? '' : String(value));
      return;
    }
    if (n !== value) onChange(n);
  };
  return <input className="input mono" style={{ width }} type="number" inputMode="numeric" aria-label={label} placeholder={placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}

export function ActionBar({ encounter, actor, infos, steps, setSteps, focus, setFocus, distanceTo, moveMetres }: Props) {
  const rules = useRules().combat;
  const defs = useMemo(() => actionDefs(rules), [rules]);
  const rolls = useType('roll');
  const sheet = actor.character;
  const [busy, setBusy] = useState(false);
  const [attackWith, setAttackWith] = useState<{ stepId: Id; weapon: CharacterWeapon } | null>(null);
  const [checkFor, setCheckFor] = useState<Id | null>(null);
  const added = useRef(new Map<Id, number>());
  const rowRef = useRef<HTMLDivElement>(null);
  const attackTarget = rules?.attackTarget ?? 8;
  // The step a check was last opened for: the next check roll from this sheet belongs to it.
  const checkForRef = useRef<Id | null>(null);
  if (checkFor) checkForRef.current = checkFor;

  const patch = (id: Id, change: Partial<TurnStep>) => setSteps(steps.map((s) => (s.id === id ? { ...s, ...change } : s)));
  const add = (def: ActionDef, at?: number) => {
    const step = newStep(def);
    added.current.set(step.id, Date.now());
    if (def.id === 'attack' && sheet?.weapons?.[0]) step.weapon = sheet.weapons[0].name;
    const next = [...steps];
    next.splice(at ?? next.length, 0, step);
    setSteps(next);
    if (def.id === 'attack') setFocus(step.id);
  };
  const remove = (id: Id) => {
    setSteps(steps.filter((s) => s.id !== id));
    if (focus === id) setFocus(undefined);
  };

  // Where along the bar a drop lands: before the first card whose middle is right of the pointer.
  const dropIndex = (x: number): number => {
    const cards = [...(rowRef.current?.querySelectorAll<HTMLElement>('[data-step]') ?? [])];
    const at = cards.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return x < r.left + r.width / 2;
    });
    return at === -1 ? cards.length : at;
  };
  useDropZone('plan', {
    accepts: (p) => p.kind === 'action' || p.kind === 'step',
    drop: (p, pt) => {
      const index = dropIndex(pt.x);
      if (p.kind === 'action') {
        const def = defs.find((d) => d.id === p.action);
        if (def) add(def, index);
        return;
      }
      const from = steps.findIndex((s) => s.id === p.id);
      if (from === -1) return;
      const next = [...steps];
      const [moved] = next.splice(from, 1);
      next.splice(from < index ? index - 1 : index, 0, moved);
      setSteps(next);
    },
  });

  // Rolls made from the sheet or the dice dock while planning are picked up by the step waiting for them.
  useEffect(() => {
    if (!sheet) return;
    const used = new Set(steps.map((s) => s.roll?.rollId).filter(Boolean));
    let next = steps;
    for (const roll of rolls) {
      if (roll.characterId !== sheet.id || used.has(roll.id)) continue;
      if (roll.kind === 'attack') {
        const step = next.find((s) => s.action === 'attack' && !s.roll && (added.current.get(s.id) ?? Infinity) <= roll.at);
        if (step) {
          used.add(roll.id);
          next = next.map((s) => (s.id === step.id ? { ...s, roll: { total: roll.total, target: roll.target ?? attackTarget, dice: roll.dice, dm: roll.dm, rollId: roll.id }, done: true } : s));
        }
      } else if (roll.kind === 'damage') {
        const step = next.find((s) => s.action === 'attack' && s.roll && s.damage === undefined && s.roll.total >= (s.roll.target ?? attackTarget) && (added.current.get(s.id) ?? Infinity) <= roll.at);
        if (step) next = next.map((s) => (s.id === step.id ? { ...s, damage: roll.total, addEffect: false } : s));
      } else if (roll.kind === 'check') {
        const step = next.find((s) => s.action !== 'attack' && s.id === checkForRef.current && !s.roll);
        if (step) {
          used.add(roll.id);
          next = next.map((s) => (s.id === step.id ? { ...s, roll: { total: roll.total, target: roll.target ?? 8, dice: roll.dice, dm: roll.dm, rollId: roll.id }, done: true } : s));
        }
      }
    }
    if (next !== steps) setSteps(next);
  }, [rolls]); // eslint-disable-line react-hooks/exhaustive-deps
  const used = { significant: steps.filter((s) => s.type === 'significant').length, minor: steps.filter((s) => s.type === 'minor').length };
  const budget = rules?.turn ?? { significant: 1, minor: 1, minorsInsteadOfSignificant: 2 };
  const minorsAllowed = budget.minor + (used.significant === 0 ? budget.minorsInsteadOfSignificant : 0);
  const over = used.significant > budget.significant ? `More than ${budget.significant} significant action` : used.minor > minorsAllowed ? `More minor actions than a turn allows (${minorsAllowed}${used.significant ? '' : ' when no significant action is taken'})` : '';
  const penalty = actor.combatant.reactions ?? 0;
  const others = encounter.combatants.filter((c) => c.id !== actor.combatant.id);

  const publish = async (list: TurnStep[]) => {
    setBusy(true);
    try {
      await act('encounter.publish', { id: encounter.id, combatantId: actor.combatant.id, steps: list });
      setSteps([]);
      setFocus(undefined);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="actionbar" aria-label={`Turn for ${actor.name}`}>
      <div className="actionbar-who">
        <span className="upper tiny faint">Planning the turn of</span>
        <b>{actor.name}</b>
        <span className="small dim">
          {used.significant}/{budget.significant} significant · {used.minor}/{minorsAllowed} minor
        </span>
        {penalty > 0 && (
          <span className="small status warn" title="Each reaction made since the last turn is DM-1 on this turn's checks">
            <Icon name="warning" size={12} /> DM-{penalty} from reactions
          </span>
        )}
      </div>

      <div className="actionbar-palette" aria-label="Actions">
        {(['significant', 'minor', 'free'] as const).map((type) => (
          <div key={type} className="palette-group">
            <span className="upper tiny faint">{TYPE_LABEL[type]}</span>
            <div className="palette-chips">
              {defs
                .filter((d) => d.type === type)
                .map((d) => (
                  <button key={d.id} className={cx('action-chip', type)} title={`${d.note} Drag into the turn, or click to add it at the end.`} onPointerDown={(e) => beginDrag(e, { kind: 'action', action: d.id }, d.name)} onClick={() => add(d)}>
                    {d.name}
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>

      <div className="actionbar-plan" data-drop="plan" ref={rowRef}>
        {steps.length === 0 && <div className="plan-empty">Drag actions here in the order you take them. Drag your token on the map to plan a move.</div>}
        {steps.map((step, i) => {
          const isAttack = step.action === 'attack';
          const needed = step.roll?.target ?? (isAttack ? attackTarget : 8);
          const effect = step.roll ? step.roll.total - needed : undefined;
          const hit = effect !== undefined && effect >= 0;
          const range = step.targetId ? distanceTo(step.targetId) : undefined;
          const weapon = sheet?.weapons?.find((w) => w.name === step.weapon);
          return (
            <div key={step.id} data-step={step.id} className={cx('step', step.type, step.done && 'is-done', focus === step.id && 'is-focus')}>
              <div className="step-head" onPointerDown={(e) => beginDrag(e, { kind: 'step', id: step.id }, step.label)}>
                <span className="step-n">{i + 1}</span>
                <label className="check" title="Tick when this has been resolved at the table" onPointerDown={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={!!step.done} onChange={(e) => patch(step.id, { done: e.target.checked })} aria-label={`${step.label} done`} />
                </label>
                <b className="grow">{step.label}</b>
                <span className={cx('step-type', step.type)}>{TYPE_LABEL[step.type]}</span>
                <button className="btn ghost icon sm" aria-label={`Remove ${step.label}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => remove(step.id)}>
                  <Icon name="x" size={12} />
                </button>
              </div>
              <div className="step-body">
                {isAttack && (
                  <>
                    <div className="step-row">
                      <select className="select" aria-label="Target" value={step.targetId ?? ''} onFocus={() => setFocus(step.id)} onChange={(e) => patch(step.id, { targetId: e.target.value || undefined })}>
                        <option value="">Target…</option>
                        {others.map((c) => (
                          <option key={c.id} value={c.id}>
                            {infos.get(c.id)?.name ?? 'Unknown'}
                            {c.out ? ' (down)' : ''}
                          </option>
                        ))}
                      </select>
                      {range !== undefined && <span className="small dim nowrap">{range} m</span>}
                    </div>
                    <div className="step-row">
                      {sheet?.weapons?.length ? (
                        <select className="select" aria-label="Weapon" value={step.weapon ?? ''} onChange={(e) => patch(step.id, { weapon: e.target.value || undefined })}>
                          <option value="">Weapon…</option>
                          {sheet.weapons.map((w) => (
                            <option key={w.id} value={w.name}>
                              {w.name} · {w.damage}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input className="input" aria-label="Weapon" placeholder="Weapon" value={step.weapon ?? ''} maxLength={80} onChange={(e) => patch(step.id, { weapon: e.target.value })} />
                      )}
                      {weapon && sheet && (
                        <button className="btn sm" onClick={() => setAttackWith({ stepId: step.id, weapon })} title="Roll the attack from the sheet, with range, aim and cover; the result is filled in here">
                          <Icon name="dice" size={13} /> Roll
                        </button>
                      )}
                    </div>
                    <div className="step-row">
                      <span className="small dim">Attack</span>
                      <IntBox label="Attack roll total" placeholder="total" value={step.roll?.total} onChange={(total) => patch(step.id, { roll: total === undefined ? undefined : { ...step.roll, total, target: needed } })} />
                      <span className="small dim">vs {needed}</span>
                      {effect !== undefined && (
                        <span className={cx('status small', hit ? 'ok' : 'danger')}>
                          <Icon name={hit ? 'check' : 'x'} size={12} /> {hit ? `Hit, Effect ${effect}` : 'Miss'}
                        </span>
                      )}
                    </div>
                    {hit && (
                      <div className="step-row">
                        <span className="small dim">Damage</span>
                        <IntBox label="Damage rolled" placeholder="dice" value={step.damage} onChange={(damage) => patch(step.id, { damage, addEffect: undefined })} />
                        {step.damage !== undefined && <span className="small dim nowrap">{step.addEffect === false ? 'Effect included' : `+ Effect ${effect} = ${step.damage + Math.max(0, effect ?? 0)}`}</span>}
                      </div>
                    )}
                  </>
                )}
                {step.action === 'move' && (
                  <div className="step-row small dim">
                    {step.to ? (
                      <>
                        <Icon name="move" size={13} />
                        {moveMetres !== undefined ? `${moveMetres} m` : 'Destination set'}
                        {moveMetres !== undefined && sheet?.movement !== undefined && moveMetres > sheet.movement && <span className="status warn"> · over {sheet.movement} m for one move</span>}
                        <button className="btn ghost sm" onClick={() => patch(step.id, { to: undefined })}>
                          Clear
                        </button>
                      </>
                    ) : (
                      'Drag your token on the map to where you end up.'
                    )}
                  </div>
                )}
                {!isAttack && step.action !== 'move' && (step.type === 'significant' || step.roll) && (
                  <div className="step-row">
                    <span className="small dim">Check</span>
                    <IntBox label="Check total" placeholder="total" value={step.roll?.total} onChange={(total) => patch(step.id, { roll: total === undefined ? undefined : { ...step.roll, total, target: needed } })} />
                    <span className="small dim">vs</span>
                    <IntBox label="Target number" width={48} value={needed} onChange={(target) => step.roll && patch(step.id, { roll: { ...step.roll, target: target ?? 8 } })} />
                    {sheet && (
                      <button className="btn sm" onClick={() => setCheckFor(step.id)} title="Roll a check from the sheet; the result is filled in here">
                        <Icon name="dice" size={13} />
                      </button>
                    )}
                    {effect !== undefined && <span className={cx('status small', hit ? 'ok' : 'danger')}>{hit ? `Effect ${effect}` : `Failed by ${-effect}`}</span>}
                  </div>
                )}
                <input className="input step-note" aria-label="Note" placeholder={isAttack ? 'Note (cover, aim, called shot…)' : 'What you do'} value={step.note ?? ''} maxLength={300} onChange={(e) => patch(step.id, { note: e.target.value })} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="actionbar-go">
        {over && (
          <span className="small status warn">
            <Icon name="warning" size={12} /> {over}
          </span>
        )}
        <button className="btn primary" disabled={busy || steps.length === 0} onClick={() => void publish(steps)} title="Show the table what you did and pass play on">
          <Icon name="send" size={14} /> Publish turn
        </button>
        <button className="btn sm ghost" disabled={busy} onClick={() => void publish([])} title="Do nothing this turn">
          Pass
        </button>
      </div>
      {attackWith && sheet && <AttackDialog character={sheet as Character} weapon={attackWith.weapon} onClose={() => setAttackWith(null)} />}
      {checkFor && sheet && <CheckDialog request={{ character: sheet as Character, chooseSkill: true, label: steps.find((s) => s.id === checkFor)?.label }} onClose={() => setCheckFor(null)} />}
    </div>
  );
}
