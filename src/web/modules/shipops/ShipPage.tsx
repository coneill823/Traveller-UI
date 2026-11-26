/** The ship's status board: the hull plan with damage showing on it, systems, alerts and crew stations. */
import { useEffect, useMemo, useState } from 'react';
import type { SpaceRules } from '../../../shared/rulepack';
import type { Character, Ship, ShipAlert } from '../../../shared/types';
import { act, onEvent, run } from '../../net';
import { Link, navigate } from '../../router';
import { getEntity, toast, useEntity, useIsGm, useMe, useRules, useType } from '../../store';
import { ConfirmButton, cx, Empty, Field, Modal } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { HullView } from '../shipyard/HullView';
import { BattleList, BattleView } from './BattleView';
import { alertParts, mountsOf, shipStatus, useShipReport, useStations } from './shipState';
import { HullMeter } from './widgets';

export function ShipPage({ parts }: { parts: string[] }) {
  const battle = useEntity(parts[1] === 'battle' ? parts[2] : undefined);
  if (parts[1] === 'battle' && battle?.type === 'battle') return <BattleView key={battle.id} battle={battle} />;
  return <ShipStatusPage shipId={parts[1] === 'battle' ? undefined : parts[1]} missingBattle={parts[1] === 'battle' && !!parts[2]} />;
}

function ShipStatusPage({ shipId, missingBattle }: { shipId?: string; missingBattle: boolean }) {
  const gm = useIsGm();
  const all = useType('ship');
  const ships = useMemo(() => [...all].sort((a, b) => Number(!!b.party) - Number(!!a.party) || (a.name ?? '').localeCompare(b.name ?? '')), [all]);
  const ship = ships.find((s) => s.id === shipId) ?? ships.find((s) => s.party) ?? ships[0];
  const [adding, setAdding] = useState(false);

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Ship</h1>
          <div className="small dim">Condition, crew stations and battle stations.</div>
        </div>
        {gm && (
          <button className="btn gm" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> Add a ship
          </button>
        )}
      </div>
      {missingBattle && <div className="notice warn small">That battle is not available.</div>}
      {ships.length > 1 && (
        <div className="ship-tabs" role="tablist" aria-label="Ships">
          {ships.map((s) => (
            <button key={s.id} role="tab" aria-selected={s.id === ship?.id} className={cx('ship-tab', s.id === ship?.id && 'on', !s.party && 'other')} onClick={() => navigate(`/ship/${s.id}`)}>
              <b>{s.name ?? 'Unnamed ship'}</b>
              <span className="tiny dim">{s.party ? "The party's" : (s.className ?? 'Other ship')}</span>
            </button>
          ))}
        </div>
      )}
      {ship ? (
        <ShipBoard key={ship.id} ship={ship} />
      ) : (
        <Empty icon="ship" title="No ship yet">
          {gm ? 'Add one from a stock design here, or have the party commission one in the yard.' : 'Commission one in the yard, or ask the GM to add the one you already fly.'}
        </Empty>
      )}
      <BattleList />
      {adding && <AddShipDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function Tile({ label, value, sub, bad }: { label: string; value: string | number; sub?: string; bad?: boolean }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        {sub && <small>{sub}</small>}
      </span>
      {bad && (
        <span className="status danger tiny">
          <Icon name="warning" size={11} /> Impaired
        </span>
      )}
    </div>
  );
}

export function ShipBoard({ ship }: { ship: Ship }) {
  const pack = useRules();
  const rules = pack.space;
  const gm = useIsGm();
  const me = useMe();
  const report = useShipReport(ship);
  const status = useMemo(() => shipStatus(ship, rules, pack.ships), [ship, rules, pack.ships]);
  const { parts, struck } = useMemo(() => alertParts(ship), [ship]);
  const stations = useStations(ship);
  const characters = useType('character');
  const [dialog, setDialog] = useState<null | 'hit' | { fault: string | undefined }>(null);
  const [banner, setBanner] = useState<ShipAlert[] | null>(null);
  const crew = ship.party || gm;
  const alerts = useMemo(() => [...(ship.alerts ?? [])].reverse(), [ship.alerts]);
  const live = alerts.filter((a) => !a.cleared && a.kind !== 'repair');
  const mounts = useMemo(() => mountsOf(ship, pack.ships), [ship, pack.ships]);
  const pcs = characters.filter((c): c is Character => c.kind === 'pc');
  const aboard = [...pcs, ...stations.filter((s) => s.character && s.character.kind !== 'pc').map((s) => s.character!)];

  // A klaxon for hits and faults as they come in.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent('ship.alert', (d: { shipId: string; alertIds: string[] }) => {
      if (d.shipId !== ship.id) return;
      setTimeout(() => {
        const fresh = (getEntity<Ship>(ship.id)?.alerts ?? []).filter((a) => d.alertIds.includes(a.id));
        if (fresh.length === 0) return;
        setBanner(fresh);
        clearTimeout(timer);
        timer = setTimeout(() => setBanner(null), 6000);
      }, 40);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [ship.id]);

  return (
    <div className={cx('shipboard', banner && 'is-alarm')}>
      {banner && (
        <div className="alarm" role="alert">
          <Icon name="warning" size={18} />
          <div className="grow">
            {banner.map((a) => (
              <div key={a.id}>
                <b>{a.title}</b>
                {a.text ? <span className="dim"> — {a.text}</span> : null}
              </div>
            ))}
          </div>
          <button className="btn ghost sm" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="shipboard-grid">
        <section className="col gap-12">
          <div className="panel">
            <div className="panel-head">
              <h3 className="grow">
                {ship.name ?? 'Unnamed ship'}
                <span className="dim"> · {ship.className ?? 'Ship'}</span>
              </h3>
              {ship.construction && (
                <span className="chip warn">
                  <Icon name="clock" size={11} /> In the yard until {String(ship.construction.readyDay).padStart(3, '0')}-{ship.construction.readyYear}
                </span>
              )}
              {gm && (
                <div className="row gap-4">
                  <button className="btn sm gm" onClick={() => setDialog('hit')}>
                    <Icon name="crosshair" size={13} /> Simulate attack
                  </button>
                  <button className="btn sm gm" onClick={() => setDialog({ fault: undefined })}>
                    <Icon name="warning" size={13} /> System fault
                  </button>
                </div>
              )}
            </div>
            {ship.spec && report ? (
              <HullView spec={ship.spec} report={report} onSelect={() => undefined} editable={false} alerts={parts} struck={struck} />
            ) : (
              <p className="small dim" style={{ padding: 14 }}>
                No design is on file for this ship, so there is no plan to show. {gm ? 'Draw one up in the yard and attach it to the ship.' : ''}
              </p>
            )}
            <div className="panel-body col gap-12">
              <HullMeter status={status} />
              <div className="stat-row">
                <Tile label="Armour" value={`+${status.armour}`} />
                <Tile label="Thrust" value={status.thrustNow} sub={status.thrustNow !== status.thrust ? ` of ${status.thrust}` : 'G'} bad={status.thrustNow < status.thrust} />
                <Tile label="Jump" value={status.jumpOk ? status.jump : 0} sub={status.jumpOk ? 'pc' : ` of ${status.jump}`} bad={!status.jumpOk} />
                <Tile label="Power" value={`${status.powerPct}%`} bad={status.powerPct < 100} />
                <Tile label="Fuel" value={ship.fuel ?? 0} sub={` of ${ship.fuelCapacity ?? 0} t`} />
              </div>
            </div>
          </div>

          {rules && <SystemsBoard ship={ship} rules={rules} onFault={gm ? (location) => setDialog({ fault: location }) : undefined} />}
        </section>

        <aside className="col gap-12">
          <div className="panel">
            <div className="panel-head">
              <h3 className="grow">Alerts</h3>
              {live.length > 0 && crew && (
                <button className="btn sm" onClick={() => void run('ship.clearAlerts', { shipId: ship.id })}>
                  <Icon name="check" size={13} /> Acknowledge all
                </button>
              )}
            </div>
            {alerts.length === 0 ? (
              <p className="small dim pad">All quiet. Hits, critical hits and faults show up here and on the plan.</p>
            ) : (
              <ul className="alert-list">
                {alerts.slice(0, 30).map((a) => (
                  <li key={a.id} className={cx(a.kind, a.cleared && 'is-cleared')}>
                    <Icon name={a.kind === 'repair' ? 'wrench' : a.kind === 'fault' ? 'warning' : 'crosshair'} size={14} />
                    <div className="grow">
                      <b>{a.title}</b>
                      {a.text && <div className="small dim">{a.text}</div>}
                    </div>
                    {!a.cleared && crew && (
                      <button className="btn ghost icon sm" aria-label={`Acknowledge: ${a.title}`} onClick={() => void run('ship.clearAlerts', { shipId: ship.id, alertId: a.id })}>
                        <Icon name="check" size={13} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {rules && crew && (
            <div className="panel">
              <div className="panel-head">
                <h3 className="grow">Crew stations</h3>
              </div>
              <div className="panel-body col gap-4">
                {aboard.length === 0 && <p className="small dim">No travellers yet. Create characters on the Crew screen.</p>}
                {aboard.map((c) => {
                  const st = stations.find((s) => s.characterId === c.id);
                  const can = gm || (c.kind === 'pc' && c.ownerId === me?.playerId);
                  const def = rules.duties.find((d) => d.id === st?.duty);
                  return (
                    <div key={c.id} className="station-row">
                      <span className="grow">
                        <b>{c.name ?? 'Unnamed'}</b>
                        {def?.skill && <span className="tiny dim block">{def.note}</span>}
                      </span>
                      <select className="select" aria-label={`Station for ${c.name ?? 'crew member'}`} disabled={!can} value={st?.duty ?? ''} onChange={(e) => void run('ship.duty', { shipId: ship.id, characterId: c.id, duty: e.target.value || null, mount: e.target.value === 'gunner' ? (st?.mount ?? mounts[0]?.id) : undefined })}>
                        <option value="">No station</option>
                        {rules.duties.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                      {def?.mount && mounts.length > 0 && (
                        <select className="select" aria-label={`Turret for ${c.name ?? 'crew member'}`} disabled={!can} value={st?.mount ?? ''} onChange={(e) => void run('ship.duty', { shipId: ship.id, characterId: c.id, duty: 'gunner', mount: e.target.value || undefined })}>
                          <option value="">Any turret</option>
                          {mounts.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {gm && (
            <div className="panel">
              <div className="panel-head gm">
                <h3 className="grow">GM</h3>
              </div>
              <div className="panel-body row wrap gap-4">
                <ConfirmButton label="Restore to full repair" confirm="Repair everything" className="btn sm gm" onConfirm={() => void run('ship.repair', { shipId: ship.id, mode: 'restore' }, 'Good as new')} />
                <button className="btn sm gm" onClick={() => void run('ship.update', { id: ship.id, ops: [{ op: 'set', path: ['party'], value: !ship.party }] })}>
                  {ship.party ? 'Not the party’s ship' : 'Make it the party’s ship'}
                </button>
                <Link className="btn sm" to="/inventory">
                  Cargo and accounts
                </Link>
              </div>
            </div>
          )}
        </aside>
      </div>
      {dialog === 'hit' && <HitDialog ship={ship} onClose={() => setDialog(null)} />}
      {dialog && dialog !== 'hit' && <FaultDialog ship={ship} location={dialog.fault} onClose={() => setDialog(null)} />}
    </div>
  );
}

function SystemsBoard({ ship, rules, onFault }: { ship: Ship; rules: SpaceRules; onFault?: (location: string) => void }) {
  const gm = useIsGm();
  const crits = ship.crits ?? {};
  return (
    <div className="panel">
      <div className="panel-head">
        <h3 className="grow">Systems</h3>
        <span className="small dim">Severity 1 to {rules.criticals.maxSeverity}</span>
      </div>
      <table className="table systems">
        <tbody>
          {rules.criticals.locations.map((l) => {
            const sev = crits[l.id] ?? 0;
            const patched = ship.repaired?.includes(l.id) ?? false;
            const effect = sev > 0 ? rules.criticals.effects[l.id]?.[sev - 1]?.text : undefined;
            return (
              <tr key={l.id} className={cx(sev > 0 && !patched && 'is-damaged')}>
                <td className="sys-name">{l.name}</td>
                <td className="sys-pips" aria-label={sev ? `Severity ${sev}` : 'Undamaged'}>
                  {Array.from({ length: rules.criticals.maxSeverity }, (_, i) => (
                    <i key={i} className={cx(i < sev && 'on')} />
                  ))}
                </td>
                <td className="sys-text">
                  {sev === 0 ? (
                    <span className="faint">Working</span>
                  ) : (
                    <>
                      <span className={cx(patched && 'dim')}>{effect}</span>
                      {patched && (
                        <span className="status ok small">
                          {' '}
                          <Icon name="wrench" size={11} /> Patched up for now
                        </span>
                      )}
                    </>
                  )}
                </td>
                {gm && (
                  <td className="sys-tools">
                    {sev > 0 && (
                      <>
                        <button className="btn ghost sm" onClick={() => void run('ship.repair', { shipId: ship.id, location: l.id, mode: patched ? 'unpatch' : 'patch' })}>
                          {patched ? 'Unpatch' : 'Patch'}
                        </button>
                        <button className="btn ghost sm" onClick={() => void run('ship.repair', { shipId: ship.id, location: l.id, mode: 'fix' })}>
                          Fix
                        </button>
                      </>
                    )}
                    {onFault && (
                      <button className="btn ghost icon sm" aria-label={`Fault in ${l.name}`} title="Break this" onClick={() => onFault(l.id)}>
                        <Icon name="warning" size={13} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────── GM dialogs ─────────────────────────────

function numberOr(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function HitDialog({ ship, onClose }: { ship: Ship; onClose: () => void }) {
  const pack = useRules();
  const rules = pack.space;
  const weapons = pack.ships?.weapons ?? [];
  const [attacker, setAttacker] = useState('');
  const [weapon, setWeapon] = useState(weapons[0]?.id ?? '');
  const [roll, setRoll] = useState('');
  const [damage, setDamage] = useState('');
  const [location, setLocation] = useState('');
  const [ignoreArmour, setIgnoreArmour] = useState(false);
  const [busy, setBusy] = useState(false);
  const def = weapons.find((w) => w.id === weapon);
  const target = rules?.attack.target ?? 8;
  const total = numberOr(roll);
  const effect = total === undefined ? 0 : Math.round(total) - target;
  const rolled = numberOr(damage);
  const dealt = rolled === undefined ? undefined : Math.round(rolled) + Math.max(0, effect);
  const multiplier = def ? rules?.attack.afterArmourMultiplier[def.id] : undefined;
  const armour = ignoreArmour ? 0 : (ship.armour ?? 0);
  const through = dealt === undefined ? undefined : Math.max(0, dealt - armour) * (multiplier ?? 1);
  const critical = rules && through !== undefined && through > 0 && effect >= rules.criticals.effectAtLeast;
  const miss = total !== undefined && effect < 0;

  const go = async () => {
    if (dealt === undefined) return;
    setBusy(true);
    try {
      const res = await act<{ taken: number; criticals: { name: string; severity: number }[]; wrecked: boolean }>('ship.hit', {
        shipId: ship.id,
        damage: dealt,
        effect,
        ...(location ? { location } : {}),
        ...(multiplier ? { multiplier } : {}),
        ignoreArmour,
        attacker: attacker.trim() || undefined,
        weapon: def?.name,
      });
      toast(res.wrecked ? `${ship.name ?? 'The ship'} is wrecked` : `${res.taken} to the hull${res.criticals.length ? `; ${res.criticals.map((c) => `${c.name} ${c.severity}`).join(', ')}` : ''}`, res.taken > 0 ? 'error' : 'info');
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Attack on ${ship.name ?? 'the ship'}`}
      icon="crosshair"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || dealt === undefined || miss} onClick={() => void go()}>
            <Icon name="crosshair" size={14} /> Apply the hit
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <div className="form-2">
          <Field label="Attacker">
            <input className="input" value={attacker} maxLength={60} placeholder="Corsair" onChange={(e) => setAttacker(e.target.value)} />
          </Field>
          <Field label="Weapon">
            <select className="select" value={weapon} onChange={(e) => setWeapon(e.target.value)}>
              {weapons.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {w.damage}
                </option>
              ))}
              <option value="">Something else</option>
            </select>
          </Field>
          <Field label="Attack roll (total)" hint={`${target}+ hits. Leave empty for damage with no attack roll (a collision, an explosion).`}>
            <input className="input mono" type="number" value={roll} onChange={(e) => setRoll(e.target.value)} />
          </Field>
          <Field label="Damage rolled" hint={def ? `${def.damage}${multiplier ? `, tripled after armour` : ''}. The Effect is added for you.` : 'The Effect is added for you.'}>
            <input className="input mono" type="number" min={0} value={damage} onChange={(e) => setDamage(e.target.value)} />
          </Field>
        </div>
        <Field label="Critical hit location" hint="Only matters if the attack scores a critical hit (Effect 6 or more with damage getting through).">
          <select className="select" value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">Roll for it</option>
            {(rules?.criticals.locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="check small">
          <input type="checkbox" checked={ignoreArmour} onChange={(e) => setIgnoreArmour(e.target.checked)} />
          <span>Ignore armour</span>
        </label>
        <div className={cx('notice small', miss ? '' : through ? 'danger' : '')}>
          {miss ? (
            `${total} against ${target}: a miss. Nothing to apply.`
          ) : dealt === undefined ? (
            'Enter the damage rolled.'
          ) : (
            <>
              {total !== undefined && `Effect ${effect}. `}
              {dealt} damage, {armour} stopped by armour{multiplier ? `, x${multiplier}` : ''}: <b>{through} to the hull</b> ({Math.max(0, (ship.hull ?? ship.hullMax ?? 0) - (through ?? 0))} left).
              {critical ? ` Critical hit, severity ${effect - (rules?.criticals.severityOffset ?? 5)}.` : ''}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function FaultDialog({ ship, location: preset, onClose }: { ship: Ship; location?: string; onClose: () => void }) {
  const rules = useRules().space;
  const [location, setLocation] = useState(preset ?? '');
  const [severity, setSeverity] = useState(preset ? 1 : 0);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const effect = location && severity && rules ? rules.criticals.effects[location]?.[severity - 1]?.text : undefined;
  const go = async () => {
    const res = await run('ship.fault', { shipId: ship.id, location: location || undefined, severity: severity || undefined, title: title.trim() || undefined, text: text.trim() || undefined });
    if (res) onClose();
  };
  return (
    <Modal
      title={`Fault aboard ${ship.name ?? 'the ship'}`}
      icon="warning"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!location && !title.trim() && !text.trim()} onClick={() => void go()}>
            <Icon name="warning" size={14} /> Raise the alarm
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <p className="small dim">A fault lights up on the plan for the whole crew. Give it a severity to have it act like a critical hit (without damage to the hull), or leave the severity off for something that is only a warning.</p>
        <div className="form-2">
          <Field label="Where">
            <select className="select" value={location} onChange={(e) => setLocation(e.target.value)}>
              <option value="">Nowhere in particular</option>
              {(rules?.criticals.locations ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Severity">
            <select className="select" value={severity} disabled={!location} onChange={(e) => setSeverity(Number(e.target.value))}>
              <option value={0}>Warning only</option>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {effect && <div className="notice small">{effect}</div>}
        <Field label="Headline (optional)">
          <input className="input" value={title} maxLength={120} placeholder="Coolant leak in engineering" onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="What the crew notice (optional)">
          <textarea className="textarea" rows={3} value={text} maxLength={600} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function AddShipDialog({ onClose }: { onClose: () => void }) {
  const designs = useRules().ships?.designs ?? [];
  const [stock, setStock] = useState(designs[0]?.id ?? '');
  const [name, setName] = useState('');
  const [party, setParty] = useState(false);
  const def = designs.find((d) => d.id === stock);
  const go = async () => {
    const res = await run<{ id: string }>('ship.fromStock', { stock, name: name.trim() || undefined, party });
    if (res?.id) {
      onClose();
      navigate(`/ship/${res.id}`);
    }
  };
  return (
    <Modal
      title="Add a ship"
      icon="ship"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!stock} onClick={() => void go()}>
            <Icon name="plus" size={14} /> Add
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <p className="small dim">For a ship the party already flies, or one they are about to meet. Ships built in the yard appear here by themselves.</p>
        {designs.length === 0 ? (
          <div className="notice warn small">No stock designs are loaded. Add a rules pack with a ships section.</div>
        ) : (
          <>
            <Field label="Design" hint={def?.summary}>
              <select className="select" value={stock} onChange={(e) => setStock(e.target.value)}>
                {designs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {d.hull.tons} t
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input className="input" value={name} maxLength={80} placeholder={def?.name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <label className="check">
              <input type="checkbox" checked={party} onChange={(e) => setParty(e.target.checked)} />
              <span>
                This is the party’s ship
                <span className="faint tiny block">Otherwise it stays hidden from players until you reveal it or it turns up in a battle.</span>
              </span>
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}
