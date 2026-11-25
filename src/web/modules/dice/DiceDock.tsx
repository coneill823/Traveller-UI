/** Shared dice roller and roll log. Rolls happen on the server, or are typed in from the table. */
import { useMemo, useState } from 'react';
import type { Roll } from '../../../shared/types';
import { run } from '../../net';
import { useApp, useIsGm, useMe, useRules, useType } from '../../store';
import { cx, Field, Segmented } from '../../ui/basics';
import { Icon } from '../../ui/Icon';

export function effectName(effect: number | undefined, effects: { max: number; name: string }[] | undefined): string | undefined {
  if (effect === undefined || !effects) return undefined;
  return (effects.find((e) => effect <= e.max) ?? effects[effects.length - 1])?.name;
}

function Stepper({ value, onChange, min = -12, max = 12 }: { value: number; onChange: (n: number) => void; min?: number; max?: number }) {
  return (
    <span className="stepper">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} aria-label="Decrease">
        −
      </button>
      <output>{value > 0 ? `+${value}` : value}</output>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} aria-label="Increase">
        +
      </button>
    </span>
  );
}

export function RollCard({ roll }: { roll: Roll }) {
  const players = useType('player');
  const rules = useRules();
  const who = players.find((p) => p.id === roll.playerId);
  const secret = roll.to.length === 0;
  const name = effectName(roll.effect, rules.tasks?.effects);
  return (
    <div className={cx('roll', secret && 'secret')} style={{ ['--c' as string]: who?.color }}>
      <div className="roll-head">
        <strong style={{ color: who?.color }}>{roll.actor ?? who?.name ?? 'Someone'}</strong>
        <span className="grow" style={{ color: 'var(--text)' }}>
          {roll.label}
        </span>
        {secret && <Icon name="eyeOff" size={11} />}
        {roll.manual && <span title="Rolled at the table and entered by hand">table</span>}
      </div>
      <div className="roll-main">
        {roll.dice.map((d, i) => (
          <span key={i} className={cx('die', d === 6 && 'max', d === 1 && 'min')}>
            {d}
          </span>
        ))}
        {roll.dropped?.map((d, i) => (
          <span key={`x${i}`} className="die" style={{ opacity: 0.35, textDecoration: 'line-through' }} title={roll.mode === 'boon' ? 'Boon: lowest die dropped' : 'Bane: highest die dropped'}>
            {d}
          </span>
        ))}
        {roll.dm !== 0 && <span className="mono dim">{roll.dm > 0 ? `+${roll.dm}` : roll.dm}</span>}
        <span className="roll-total">{roll.total}</span>
      </div>
      {roll.breakdown && roll.breakdown.length > 0 && (
        <div className="tiny faint mono" style={{ marginTop: 3 }}>
          {roll.breakdown.map((b) => `${b.label} ${b.dm >= 0 ? '+' : ''}${b.dm}`).join(' · ')}
        </div>
      )}
      {roll.detail && <div className="tiny" style={{ color: 'var(--warn)', marginTop: 2 }}>{roll.detail}</div>}
      {roll.target !== undefined && (
        <div className={cx('roll-effect', (roll.effect ?? 0) >= 0 ? 'pass' : 'fail')}>
          vs {roll.target}+ · Effect {(roll.effect ?? 0) >= 0 ? '+' : ''}
          {roll.effect}
          {name ? ` · ${name}` : (roll.effect ?? 0) >= 0 ? ' · Success' : ' · Failure'}
        </div>
      )}
    </div>
  );
}

export function DiceDock() {
  const rolls = useType('roll');
  const rules = useRules();
  const gm = useIsGm();
  const me = useMe();
  const [dice, setDice] = useState(2);
  const [dm, setDm] = useState(0);
  const [target, setTarget] = useState<number | ''>('');
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState<'normal' | 'boon' | 'bane'>('normal');
  const [secret, setSecret] = useState(false);
  const [manual, setManual] = useState(false);
  const [manualDice, setManualDice] = useState('');

  const sorted = useMemo(() => [...rolls].sort((a, b) => b.at - a.at), [rolls]);
  const difficulties = rules.tasks?.difficulties ?? [2, 4, 6, 8, 10, 12, 14, 16].map((t) => ({ name: '', target: t }));
  const typed = manualDice.split(/[^1-6]+/).filter(Boolean).join('').split('').map(Number);
  const needed = dice + (mode === 'normal' ? 0 : 1);

  const roll = () => {
    void run('dice.roll', {
      label: label.trim() || `${dice}D${dm ? (dm > 0 ? `+${dm}` : dm) : ''}`,
      dice,
      dm,
      target: target === '' ? undefined : target,
      mode: mode === 'normal' ? undefined : mode,
      manual: manual ? typed : undefined,
      to: secret ? 'gm' : 'party',
    }).then((ok) => ok && manual && setManualDice(''));
  };

  return (
    <aside className="dice-dock">
      <div className="panel-head">
        <h2 className="grow">Dice</h2>
        <button className="btn ghost icon sm" onClick={() => useApp.setState({ diceOpen: false })} aria-label="Close dice">
          <Icon name="x" />
        </button>
      </div>
      <div className="dice-controls">
        <div className="row between">
          <Segmented
            value={String(dice)}
            onChange={(v) => setDice(Number(v))}
            options={[
              { id: '1', label: '1D' },
              { id: '2', label: '2D' },
              { id: '3', label: '3D' },
            ]}
          />
          <Stepper value={dm} onChange={setDm} />
        </div>
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Target number">
          <option value="">No target number</option>
          {difficulties.map((d) => (
            <option key={d.target} value={d.target}>
              {d.name ? `${d.name} (${d.target}+)` : `${d.target}+`}
            </option>
          ))}
        </select>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { id: 'bane', label: 'Bane', title: 'Roll an extra die and drop the highest' },
            { id: 'normal', label: 'Normal', title: 'Normal roll' },
            { id: 'boon', label: 'Boon', title: 'Roll an extra die and drop the lowest' },
          ]}
        />
        <input className="input" placeholder="What is this roll for?" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && roll()} />
        <div className="row between">
          <label className="check small" title="Roll physical dice and type in what they show">
            <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
            Rolled at the table
          </label>
          {(gm || me?.role === 'gm') && (
            <label className="check small" style={{ color: 'var(--gm)' }} title="Only the GM sees this roll">
              <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />
              Secret
            </label>
          )}
        </div>
        {manual && (
          <Field label={`Dice shown (${needed} needed)`} hint={mode !== 'normal' ? `Enter all ${needed}; the ${mode === 'boon' ? 'lowest' : 'highest'} is dropped for you.` : undefined}>
            <input className="input mono" inputMode="numeric" placeholder={Array.from({ length: needed }, (_, i) => ((i * 2) % 6) + 1).join(' ')} value={manualDice} onChange={(e) => setManualDice(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && typed.length === needed && roll()} />
          </Field>
        )}
        <button className="btn primary block" onClick={roll} disabled={manual && typed.length !== needed}>
          <Icon name="dice" size={14} /> {manual ? 'Record roll' : 'Roll'}
        </button>
      </div>
      <div className="dice-log">
        {sorted.length === 0 && <div className="faint small pad">No rolls yet. Everyone at the table sees rolls made here.</div>}
        {sorted.map((r) => (
          <RollCard key={r.id} roll={r} />
        ))}
        {gm && sorted.length > 0 && (
          <button className="btn ghost sm" onClick={() => void run('dice.clear')}>
            Clear log
          </button>
        )}
      </div>
    </aside>
  );
}
