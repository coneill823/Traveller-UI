/**
 * Quick creation: taking a ready-made background or career from the rules pack, which puts its
 * characteristic changes, skills, money and other benefits on the sheet in one go.
 */
import { useMemo, useState } from 'react';
import type { CharacterPackage } from '../../../shared/rulepack';
import { applyPackage, needsChoice } from '../../../shared/rules/packages';
import { splitSkill } from '../../../shared/rules/character';
import type { Character } from '../../../shared/types';
import { act } from '../../net';
import { toast, useRules } from '../../store';
import { cx, Modal } from '../../ui/basics';

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function PackagePicker({ c, onClose }: { c: Character; onClose: () => void }) {
  const rules = useRules().characters;
  const packages = rules?.packages ?? [];
  const [kind, setKind] = useState<CharacterPackage['kind']>(packages.some((p) => p.kind === 'background') && !(c.careers ?? []).length && !Object.keys(c.skills ?? {}).length ? 'background' : (packages.find((p) => p.kind === 'career') ? 'career' : 'background'));
  const [id, setId] = useState<string | undefined>();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const shown = packages.filter((p) => p.kind === kind);
  const pkg = packages.find((p) => p.id === id && p.kind === kind);
  // what the sheet would show afterwards, so that stacking and limits can be seen before taking it
  const after = useMemo(() => (pkg ? applyPackage(c, pkg, rules?.packageRules, choices, () => 0.5) : undefined), [c, pkg, rules, choices]);

  const take = async () => {
    if (!pkg || busy) return;
    setBusy(true);
    try {
      await act('character.applyPackage', { id: c.id, packageId: pkg.id, choices });
      toast(`${pkg.name} taken`, 'ok');
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Quick creation"
      icon="sparkles"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!pkg || busy} onClick={() => void take()}>
            Take {pkg ? pkg.name : 'a package'}
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <div className="segmented" style={{ display: 'flex', maxWidth: 320 }}>
          {(['background', 'career'] as const).map((k) => (
            <button key={k} className={cx(kind === k && 'on')} style={{ flex: 1 }} disabled={!packages.some((p) => p.kind === k)} onClick={() => { setKind(k); setChoices({}); }}>
              {k === 'background' ? 'Backgrounds' : 'Careers'}
            </button>
          ))}
        </div>
        <div className="row wrap" style={{ gap: 4 }}>
          {shown.map((p) => (
            <button key={p.id} className={cx('btn sm', p.id === id && 'primary')} onClick={() => { setId(p.id); setChoices({}); }} title={p.note}>
              {p.name}
            </button>
          ))}
        </div>
        {!pkg && <div className="faint small">{kind === 'background' ? 'A background stands for upbringing, schooling and the first years of work.' : 'A career stands for a whole working life before play begins.'} Choose one to see what it gives.</div>}
        {pkg && after && (
          <div className="col gap-12">
            {pkg.note && <div className="small dim">{pkg.note}</div>}
            <dl className="kv">
              <dt>Characteristics</dt>
              <dd>
                {Object.entries(pkg.mods ?? {}).length
                  ? Object.entries(pkg.mods ?? {}).map(([k, n]) => (
                      <span key={k} className="chip" style={{ marginRight: 4 }} title={c.chars?.[k] ? `${c.chars[k]!.max} becomes ${after.chars[k]?.max}` : 'Not on this sheet'}>
                        {k} {signed(n)}
                      </span>
                    ))
                  : 'No change'}
              </dd>
              {(pkg.credits || pkg.rank || pkg.benefits?.length) && (
                <>
                  <dt>Comes with</dt>
                  <dd>{[pkg.rank, pkg.credits ? `Cr${pkg.credits.toLocaleString('en-GB')}` : undefined, ...(pkg.benefits ?? [])].filter(Boolean).join(' · ')}</dd>
                </>
              )}
            </dl>
            <div className="scroll" style={{ maxHeight: 300, border: '1px solid var(--line)' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Gives</th>
                    <th>Sheet will show</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(pkg.skills).map(([listed, level]) => {
                    const name = (choices[listed] ?? '').trim() || listed;
                    const base = splitSkill(listed).base;
                    const specs = rules?.skills.find((s) => s.name === base)?.specialities ?? [];
                    return (
                      <tr key={listed}>
                        <td>
                          {needsChoice(listed) ? (
                            <>
                              <input className="input" style={{ height: 26, maxWidth: 260 }} list={`pkg-${base}`} placeholder={listed} value={choices[listed] ?? ''} onChange={(e) => setChoices({ ...choices, [listed]: e.target.value })} aria-label={`Which skill for ${listed}`} />
                              <datalist id={`pkg-${base}`}>{specs.map((s) => <option key={s} value={`${base} (${s})`} />)}</datalist>
                            </>
                          ) : (
                            listed
                          )}
                        </td>
                        <td className="mono">{level}</td>
                        <td className="mono">
                          {after.skills[name]}
                          {c.skills?.[name] !== undefined && <span className="faint"> (now {c.skills[name]})</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="tiny faint">Skills named loosely can be settled here or on the sheet afterwards. Gear and contacts are written into the private notes.</div>
          </div>
        )}
      </div>
    </Modal>
  );
}
