/**
 * Battle stations. Other ships along the top in initiative order, the party's ship below with
 * damage showing on its plan, and a shared plan that each of the crew adds their station's
 * actions to. The ship then acts as one in each step of the round.
 */
import { useEffect, useMemo, useState } from 'react';
import type { SpaceAction, SpaceRules } from '../../../shared/rulepack';
import { attackDm, CONDITION_LABEL, conditionOf, linkedBonus, locationName, rangeIndex } from '../../../shared/rules/space';
import type { Battle, BattleRecord, BattleResult, BattleShip, BattleStepId, Character, CrewAction, Id, Ship } from '../../../shared/types';
import { newId } from '../../../shared/util';
import { act, onEvent, run } from '../../net';
import { Link, navigate } from '../../router';
import { getEntity, toast, useApp, useIsGm, useMe, useRules, useType } from '../../store';
import { ConfirmButton, cx, EditableText, Field, Modal } from '../../ui/basics';
import { beginDrag, useDropZone } from '../../ui/drag';
import { Icon } from '../../ui/Icon';
import { flashRoll } from '../characters/rolling';
import { HullView } from '../shipyard/HullView';
import { HullMeter } from './widgets';
import { alertParts, mountsOf, shipStatus, useShipReport, useStations, type Station } from './shipState';

const STATUS: Record<Battle['status'], { label: string; cls: string }> = { setup: { label: 'Being set up', cls: '' }, active: { label: 'Under way', cls: 'accent' }, ended: { label: 'Over', cls: '' } };
const STEP_ORDER: BattleStepId[] = ['manoeuvre', 'attack', 'actions'];

export function BattleList() {
  const battles = useType('battle');
  const gm = useIsGm();
  const sorted = useMemo(() => [...battles].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.updatedAt - a.updatedAt), [battles]);
  const create = async () => {
    const res = await run<{ id: string }>('battle.create', {});
    if (res?.id) navigate(`/ship/battle/${res.id}`);
  };
  if (!gm && sorted.length === 0) return null;
  return (
    <section className="battle-list">
      <div className="row gap-12">
        <h3 className="grow yard-section">Battle stations</h3>
        {gm && (
          <button className="btn sm gm" onClick={() => void create()}>
            <Icon name="plus" size={13} /> New battle
          </button>
        )}
      </div>
      {sorted.length === 0 ? (
        <p className="small dim">No battles. Create one to put ships at ranges and run the fight round by round.</p>
      ) : (
        <div className="enc-list">
          {sorted.map((b) => (
            <Link key={b.id} to={`/ship/battle/${b.id}`} className={cx('enc-row', b.status)}>
              <span className="grow">
                <b>{b.name}</b>
                <span className="small dim block">
                  {b.ships.length} ship{b.ships.length === 1 ? '' : 's'}
                  {b.status !== 'setup' ? ` · round ${b.round}` : ''}
                  {b.status === 'setup' && gm ? (b.open ? ' · open to players' : ' · hidden from players') : ''}
                </span>
              </span>
              <span className={cx('chip', STATUS[b.status].cls)}>{STATUS[b.status].label}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

// ───────────────────────────── helpers ─────────────────────────────

function orderOf(battle: Battle): BattleShip[] {
  const init = (s: BattleShip) => (s.initiative ?? -99) + (s.initiativeDm ?? 0);
  return battle.ships
    .map((s, index) => ({ s, index }))
    .sort((a, b) => Number(!!a.s.out) - Number(!!b.s.out) || init(b.s) - init(a.s) || a.index - b.index)
    .map((x) => x.s);
}

function describe(rules: SpaceRules | undefined, a: CrewAction, r: BattleResult | undefined, nameOf: (id: Id | undefined) => string | undefined): string {
  const target = nameOf(a.targetId);
  const bits: string[] = [];
  const check = a.roll ? `${a.roll.total} against ${a.roll.target ?? 8}` : '';
  if (r?.salvo) {
    bits.push(`launches ${r.salvo.missiles} missile${r.salvo.missiles === 1 ? '' : 's'} at ${target ?? 'a target'}, arriving in round ${r.salvo.impactRound}`);
  } else if (a.action === 'fire' || a.action === 'pilotFire') {
    bits.push(`fires${a.weapon ? ` ${a.weapon}` : ''}${target ? ` at ${target}` : ''}`);
    if (check) bits.push(`${check}: ${r?.hit === false ? 'miss' : 'hit'}`);
    if (r?.dealt !== undefined) bits.push(`${r.dealt} damage${r.taken !== undefined && r.taken !== r.dealt ? ` (${r.taken} past armour)` : ''}`);
    for (const c of r?.criticals ?? []) bits.push(`${c.name} damaged, severity ${c.severity}`);
    if (r?.wrecked) bits.push(`${target ?? 'the target'} is wrecked`);
  } else if (r?.range) {
    const name = (id: string) => rules?.ranges.find((x) => x.id === id)?.name ?? id;
    bits.push(`${a.closing === false ? 'opens' : 'closes'} the range to ${target ?? 'a ship'} with ${a.thrust} Thrust${r.range.from !== r.range.to ? `: ${name(r.range.from)} to ${name(r.range.to)}` : ` (still ${name(r.range.to)})`}`);
  } else {
    bits.push(a.label.toLowerCase() + (target ? ` (${target})` : '') + (a.location && rules ? `: ${locationName(rules, a.location)}` : ''));
    if (check) bits.push(`${check}: ${(r?.effect ?? 0) >= 0 ? 'success' : 'failure'}`);
    if (r?.missilesLeft !== undefined) bits.push(`${r.missilesLeft} missile${r.missilesLeft === 1 ? '' : 's'} left in the salvo`);
    if (r?.repaired) bits.push('patched up');
    if (r?.initiativeDm !== undefined) bits.push(`initiative ${r.initiativeDm >= 0 ? '+' : ''}${r.initiativeDm} next round`);
    if (r?.lock) bits.push('lock held');
  }
  if (a.note) bits.push(a.note);
  return bits.join(' — ');
}

interface Replay {
  record: BattleRecord;
  index: number;
}

/** Steps through each published turn so everyone sees what the ship just did. */
function useBattleReplay(battleId: Id): [Replay | null, (r: BattleRecord) => void, () => void] {
  const [replay, setReplay] = useState<Replay | null>(null);
  useEffect(() => {
    const off = onEvent('battle.turn', (d: { battleId: Id; recordId: Id }) => {
      if (d.battleId !== battleId) return;
      setTimeout(() => {
        const record = getEntity<Battle>(battleId)?.log.find((r) => r.id === d.recordId);
        if (record && record.actions.length) setReplay({ record, index: 0 });
      }, 30);
    });
    return off;
  }, [battleId]);
  useEffect(() => {
    if (!replay) return;
    const timer = setTimeout(() => setReplay(replay.index + 1 < replay.record.actions.length ? { record: replay.record, index: replay.index + 1 } : null), 2200);
    return () => clearTimeout(timer);
  }, [replay]);
  return [replay, (record) => record.actions.length && setReplay({ record, index: 0 }), () => setReplay(null)];
}

// ───────────────────────────── the battle ─────────────────────────────

export function BattleView({ battle }: { battle: Battle }) {
  const gm = useIsGm();
  const me = useMe();
  const pack = useRules();
  const rules = pack.space;
  const ents = useApp((s) => s.ents);
  const [dialog, setDialog] = useState(false);
  const [actFor, setActFor] = useState<Id | undefined>();
  const [ahead, setAhead] = useState(false);
  const [replay, play, stop] = useBattleReplay(battle.id);

  const active = battle.status === 'active';
  const order = useMemo(() => orderOf(battle), [battle]);
  const shipOf = (s: BattleShip | undefined) => (s?.shipId ? (ents[s.shipId] as Ship | undefined) : undefined);
  // Ranges are measured from the flagship; a player aboard another of the party's ships sees that one as their own.
  const flagship = battle.ships.find((s) => s.id === battle.flagship) ?? battle.ships.find((s) => s.side === 'party');
  const aboard = battle.ships.find((s) => {
    const ship = shipOf(s);
    return !!ship?.party && Object.keys(ship.duties ?? {}).some((id) => (ents[id] as Character | undefined)?.ownerId === me?.playerId);
  });
  const flag = (gm ? undefined : aboard) ?? flagship;
  const flagShip = shipOf(flag);
  const others = order.filter((s) => s.id !== flag?.id);
  const nameOf = (id: Id | undefined) => battle.ships.find((s) => s.id === id)?.name;
  // The ship whose plan is on screen: the party's for players; the GM can take any ship's chair.
  const planShip = (gm && actFor ? battle.ships.find((s) => s.id === actFor) : undefined) ?? (gm && active && battle.turn && battle.turn !== flag?.id ? battle.ships.find((s) => s.id === battle.turn) : undefined) ?? flag;
  const planEntity = shipOf(planShip);
  const stations = useStations(planEntity);
  const myStations = stations.filter((s) => s.mine);
  const plan = planShip ? (battle.plans[planShip.id] ?? []) : [];
  const canPlan = !!planShip && (gm || planEntity?.party === true);
  const report = useShipReport(flagShip);
  const status = useMemo(() => (flagShip ? shipStatus(flagShip, rules, pack.ships) : undefined), [flagShip, rules, pack.ships]);
  const alerts = useMemo(() => (flagShip ? alertParts(flagShip) : { parts: new Set<string>(), struck: false }), [flagShip]);
  const stepDef = rules?.steps.find((s) => s.id === battle.step);
  const turnShip = battle.ships.find((s) => s.id === battle.turn);
  const replayAction = replay?.record.actions[replay.index];
  const replayResult = replayAction ? replay?.record.results.find((r) => r.actionId === replayAction.id) : undefined;
  const incoming = battle.salvos.filter((s) => !s.done);

  return (
    <div className="combat battle">
      <header className="combat-head">
        <Link to="/ship" className="btn ghost sm" aria-label="Back to the ship">
          <Icon name="chevronLeft" size={14} /> Ship
        </Link>
        <h1 className="grow">
          <EditableText value={battle.name} disabled={!gm} onCommit={(name) => name.trim() && void run('battle.update', { id: battle.id, name })} />
        </h1>
        {active && rules && (
          <ol className="step-track" aria-label="Steps of the round">
            <li className="round">Round {battle.round}</li>
            {rules.steps.map((s) => (
              <li key={s.id} className={cx(s.id === battle.step && 'on', STEP_ORDER.indexOf(s.id) < STEP_ORDER.indexOf(battle.step) && 'done')} title={s.note}>
                {s.name}
              </li>
            ))}
          </ol>
        )}
        {!active && <span className={cx('chip', STATUS[battle.status].cls)}>{STATUS[battle.status].label}</span>}
        {gm && (
          <div className="row gap-4 wrap">
            {battle.status === 'setup' && (
              <>
                <button className="btn sm gm" onClick={() => void run('battle.update', { id: battle.id, open: !battle.open })}>
                  <Icon name={battle.open ? 'eyeOff' : 'eye'} size={13} /> {battle.open ? 'Hide from players' : 'Open to players'}
                </button>
                <button className="btn sm gm" onClick={() => void run('battle.initiative', { id: battle.id })} title="2D + Pilot + Thrust for every ship without initiative">
                  <Icon name="dice" size={13} /> Roll initiative
                </button>
                <button className="btn sm primary" onClick={() => void run('battle.start', { id: battle.id })}>
                  <Icon name="play" size={13} /> Start
                </button>
              </>
            )}
            {active && (
              <>
                <button className="btn sm gm" onClick={() => void run('battle.next', { id: battle.id })} title="Pass over the ship that is acting">
                  Next ship <Icon name="chevronRight" size={13} />
                </button>
                <button className="btn sm gm" onClick={() => void run('battle.next', { id: battle.id, step: true })} title="Move straight on to the next step">
                  Next step
                </button>
              </>
            )}
            <button className="btn sm gm" onClick={() => setDialog(true)}>
              <Icon name="plus" size={13} /> Add ship
            </button>
            {active && <ConfirmButton label="End" confirm="End the battle" className="btn sm gm" onConfirm={() => void run('battle.end', { id: battle.id })} />}
            {battle.status === 'ended' && (
              <button className="btn sm gm" onClick={() => void run('battle.end', { id: battle.id, reopen: true })}>
                Resume
              </button>
            )}
            {!active && (
              <ConfirmButton
                label="Delete"
                icon="trash"
                confirm="Delete this battle"
                onConfirm={async () => {
                  await run('entity.delete', { id: battle.id });
                  navigate('/ship');
                }}
              />
            )}
          </div>
        )}
      </header>

      {!rules && (
        <div className="notice warn small" style={{ margin: '0 16px 10px' }}>
          <Icon name="warning" size={14} /> No space combat rules are loaded, so range bands, crew actions and critical hits are not available. Add a rules pack with a space section (see the README).
        </div>
      )}
      <div className="combat-grid">
        <section className="combat-stage battle-stage">
          <div className="card-row" aria-label="Other ships">
            <span className="card-row-title upper tiny faint">Contacts</span>
            {others.length === 0 && <span className="small faint">No other ships yet.</span>}
            {others.map((s) => (
              <ShipCard key={s.id} battle={battle} entry={s} ship={shipOf(s)} rules={rules} locked={flag?.locks?.includes(s.id) ?? false} replayAction={replayAction} replayResult={replayResult} acting={replay?.record.shipId === s.id} onActFor={gm ? setActFor : undefined} planning={planShip?.id === s.id} flagship={s.id === flagship?.id} />
            ))}
          </div>

          {rules && flagship && <RangeTrack rules={rules} flag={flagship} others={order.filter((s) => s.id !== flagship.id)} turn={battle.turn} />}

          <div className="replay-strip">
            {replay && replayAction ? (
              <div className="replay-caption" role="status" aria-live="polite">
                <span className="upper tiny faint">
                  Replay · {replay.index + 1} of {replay.record.actions.length}
                </span>
                <span>
                  <b>{nameOf(replay.record.shipId) ?? 'A ship'}</b> {describe(rules, replayAction, replayResult, nameOf)}
                </span>
                <button className="btn ghost sm" onClick={stop}>
                  Skip
                </button>
              </div>
            ) : active ? (
              <span className="small dim">
                {stepDef ? `${stepDef.name} step. ` : ''}
                {turnShip ? `${turnShip.name} to act.` : 'An unseen ship is acting.'} {stepDef?.note}
              </span>
            ) : null}
          </div>

          {flag && (
            <div className={cx('panel ownship', replay && replayAction?.targetId === flag.id && replayResult?.hit && 'is-hit')}>
              <div className="panel-head">
                <h3 className="grow">
                  {flag.name}
                  {flagShip?.className ? <span className="dim"> · {flagShip.className}</span> : null}
                </h3>
                <span className="chip" title="Initiative">
                  Initiative {flag.initiative ?? '–'}
                  {flag.initiativeDm ? ` ${flag.initiativeDm > 0 ? '+' : ''}${flag.initiativeDm}` : ''}
                </span>
                {active && battle.turn === flag.id && <span className="chip accent">Acting now</span>}
                {flagShip && (
                  <Link className="btn ghost sm" to={`/ship/${flagShip.id}`}>
                    Status board
                  </Link>
                )}
              </div>
              <div className="ownship-body">
                {flagShip?.spec && report ? <HullView spec={flagShip.spec} report={report} onSelect={() => undefined} editable={false} alerts={alerts.parts} struck={alerts.struck} compact /> : <div className="small dim pad">No plan on file for this ship.</div>}
                <div className="col gap-12 ownship-side">
                  {status && <HullMeter status={status} />}
                  {status && (
                    <dl className="kv-tight">
                      <dt>Armour</dt>
                      <dd>+{status.armour}</dd>
                      <dt>Thrust</dt>
                      <dd>
                        {status.thrustNow}
                        {status.thrustNow !== status.thrust ? ` of ${status.thrust}` : ''}
                      </dd>
                      <dt>Power</dt>
                      <dd>{status.powerPct}%</dd>
                      {status.damaged.slice(0, 4).map((d) => (
                        <span key={d.location} style={{ display: 'contents' }}>
                          <dt className="status danger">
                            <Icon name="warning" size={11} /> {d.name}
                          </dt>
                          <dd>
                            severity {d.severity}
                            {d.patched ? ' (patched)' : ''}
                          </dd>
                        </span>
                      ))}
                    </dl>
                  )}
                  <div className="ownship-crew">
                    <StationsList ship={flagShip} rules={rules} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        <aside className="combat-side">
          <div className="panel">
            <div className="panel-head">
              <h3 className="grow">Initiative</h3>
            </div>
            <ol className="turn-list">
              {order.map((s) => (
                <li key={s.id} className={cx(s.side, active && battle.turn === s.id && 'is-turn', s.out && 'is-out', s.acted && 'has-acted')}>
                  <span className="turn-init mono">{s.initiative === undefined ? '–' : s.initiative + (s.initiativeDm ?? 0)}</span>
                  <span className={cx('turn-side', s.side)} aria-hidden="true" />
                  <span className="grow">
                    {s.name}
                    {s.hidden && <span className="faint"> (hidden)</span>}
                  </span>
                  <span className="tiny dim">{active && battle.turn === s.id ? 'acting' : s.out ? 'out' : s.acted ? 'done' : ''}</span>
                </li>
              ))}
            </ol>
          </div>
          {incoming.length > 0 && (
            <div className="panel">
              <div className="panel-head">
                <h3 className="grow">Missiles in flight</h3>
              </div>
              <ul className="alert-list">
                {incoming.map((s) => (
                  <li key={s.id} className={cx(s.toId === flag?.id ? 'critical' : 'hit')}>
                    <Icon name="warning" size={14} />
                    <div className="grow">
                      <b>
                        {s.missiles} missile{s.missiles === 1 ? '' : 's'}: {nameOf(s.fromId) ?? '?'} to {nameOf(s.toId) ?? '?'}
                      </b>
                      <div className="small dim">{s.impactRound <= battle.round ? 'Arriving now: resolve in the attack step' : `Arrives in round ${s.impactRound}`}</div>
                    </div>
                    {gm && (
                      <button className="btn ghost sm" onClick={() => void run('battle.salvo', { id: battle.id, salvoId: s.id, patch: { done: true } })}>
                        Clear
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="panel combat-log">
            <div className="panel-head">
              <h3 className="grow">What has happened</h3>
            </div>
            {battle.log.length === 0 ? (
              <p className="small dim turn-note">Each ship's actions appear here as they are carried out.</p>
            ) : (
              <ul className="log-list">
                {[...battle.log].reverse().map((r) => (
                  <li key={r.id}>
                    <div className="log-head">
                      <span className="tiny faint mono">
                        R{r.round} {rules?.steps.find((s) => s.id === r.step)?.name ?? r.step}
                      </span>
                      <b className="grow">{nameOf(r.shipId) ?? 'A ship'}</b>
                      {r.actions.length > 0 && (
                        <button className="btn ghost sm" onClick={() => play(r)} aria-label="Replay">
                          <Icon name="play" size={12} />
                        </button>
                      )}
                    </div>
                    {r.actions.length === 0 ? (
                      <span className="small dim">Nothing.</span>
                    ) : (
                      <ol className="log-steps">
                        {r.actions.map((a) => (
                          <li key={a.id}>{describe(rules, a, r.results.find((x) => x.actionId === a.id), nameOf)}</li>
                        ))}
                      </ol>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>

      {active && planShip && canPlan && rules ? (
        <CrewPlan battle={battle} rules={rules} planShip={planShip} ship={planEntity} flag={flag} plan={plan} stations={gm && !planEntity?.party ? [] : gm ? stations : myStations} freeHand={gm} ahead={ahead} setAhead={setAhead} me={me?.playerId ?? ''} />
      ) : (
        <div className="actionbar idle">
          <span className="dim">
            {battle.status === 'setup'
              ? gm
                ? 'Add the other ships, set their ranges, then start the battle.'
                : 'The GM is setting up. Take your station on the ship’s status board.'
              : battle.status === 'ended'
                ? 'This battle is over.'
                : 'Waiting.'}
          </span>
        </div>
      )}
      {dialog && <AddBattleShipDialog battle={battle} onClose={() => setDialog(false)} />}
    </div>
  );
}

/** Who is at which station, one chip each. */
function StationsList({ ship, rules }: { ship: Ship | undefined; rules: SpaceRules | undefined }) {
  const stations = useStations(ship);
  if (stations.length === 0) return <span className="small faint">Nobody is at a station yet. Take one on the status board.</span>;
  return (
    <>
      {stations.map((s) => (
        <span key={s.characterId} className={cx('chip', s.mine && 'accent')}>
          {rules?.duties.find((d) => d.id === s.duty)?.name ?? s.duty}: {s.name}
        </span>
      ))}
    </>
  );
}

function ShipCard({ battle, entry, ship, rules, locked, replayAction, replayResult, acting, onActFor, planning, flagship }: { battle: Battle; entry: BattleShip; ship?: Ship; rules?: SpaceRules; locked: boolean; replayAction?: CrewAction; replayResult?: BattleResult; acting: boolean; onActFor?: (id: Id | undefined) => void; planning: boolean; flagship: boolean }) {
  const gm = useIsGm();
  const turn = battle.status === 'active' && battle.turn === entry.id;
  const state = ship?.hullMax !== undefined ? { hull: ship.hull ?? ship.hullMax, hullMax: ship.hullMax } : entry.quick?.hullMax ? { hull: entry.quick.hull ?? entry.quick.hullMax, hullMax: entry.quick.hullMax } : undefined;
  const condition = entry.seen?.condition ?? (state ? conditionOf(state) : 'intact');
  const struck = replayAction?.targetId === entry.id && (replayAction.action === 'fire' || replayAction.action === 'pilotFire');
  const hit = struck && replayResult?.hit !== false && !replayResult?.salvo;
  const range = rules?.ranges.find((r) => r.id === entry.range);
  const patch = (p: Record<string, unknown>) => void run('battle.ship', { id: battle.id, battleShipId: entry.id, patch: p });
  return (
    <div className={cx('ccard shipcard', entry.side, turn && 'is-turn', entry.out && 'is-out', entry.hidden && 'is-hidden', acting && 'is-acting', struck && (hit ? 'is-hit' : 'is-missed'))} aria-label={`${entry.name}, ${range?.name ?? 'range unknown'}, ${CONDITION_LABEL[condition]}`}>
      <div className="ccard-top">
        <span className={cx('ccard-face', entry.side)}>
          <Icon name="ship" size={15} />
        </span>
        <span className="ccard-name">
          <b>{entry.name}</b>
          <span className="tiny dim">
            {turn ? 'Acting now' : entry.out ? 'Out of the fight' : entry.acted ? 'Has acted' : (ship?.className ?? (entry.seen?.tons ?? entry.quick?.tons ? `${entry.seen?.tons ?? entry.quick?.tons} tons` : entry.side === 'enemy' ? 'Hostile' : 'Contact'))}
            {entry.hidden ? ' · hidden' : ''}
          </span>
        </span>
        <span className="ccard-init" title="Initiative">
          {entry.initiative === undefined ? '–' : entry.initiative + (entry.initiativeDm ?? 0)}
        </span>
      </div>
      <div className={cx('ccard-health', condition === 'intact' ? 'ok' : condition === 'damaged' ? 'wounded' : 'dead')}>
        <Icon name={condition === 'intact' ? 'check' : 'warning'} size={12} /> {CONDITION_LABEL[condition]}
        {gm && state ? (
          <span className="dim">
            {' '}
            · hull {state.hull}/{state.hullMax}
          </span>
        ) : null}
      </div>
      <div className="ccard-tags">
        {flagship ? (
          <span className="chip accent" title="Ranges are measured from this ship">
            Flagship
          </span>
        ) : (
          <span className="chip" title={range ? `${range.distance}. ${range.thrust} Thrust to change band.` : undefined}>
            {range?.name ?? 'Range not set'}
            {gm && entry.closing ? ` (${entry.closing > 0 ? '+' : ''}${entry.closing})` : ''}
          </span>
        )}
        {locked && (
          <span className="chip accent" title="We hold a sensor lock: DM+2 to attacks on it">
            <Icon name="crosshair" size={11} /> Lock
          </span>
        )}
      </div>
      {struck && replayResult && (
        <span key={replayAction!.id} className={cx('ccard-pop', hit ? 'hit' : 'miss')}>
          {replayResult.salvo ? 'Launch' : hit ? (replayResult.dealt !== undefined ? `−${replayResult.taken ?? replayResult.dealt}` : 'Hit') : 'Miss'}
        </span>
      )}
      {gm && (
        <div className="shipcard-tools">
          {flagship ? (
            <span className="grow" />
          ) : (
            <select className="select" aria-label={`Range to ${entry.name}`} value={entry.range ?? ''} onChange={(e) => patch({ range: e.target.value })}>
              {!entry.range && <option value="">Range…</option>}
              {(rules?.ranges ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          {!flagship && entry.side === 'party' && (
            <button className="btn sm gm" onClick={() => void run('battle.update', { id: battle.id, flagship: entry.id })} title="Measure ranges from this ship">
              Flagship
            </button>
          )}
          {onActFor && !planning && (
            <button className="btn sm gm" onClick={() => onActFor(entry.id)} title="Queue this ship's actions">
              Act
            </button>
          )}
          <button className="btn ghost icon sm" title={entry.hidden ? 'Reveal to players' : 'Hide from players'} aria-label={entry.hidden ? 'Reveal' : 'Hide'} onClick={() => patch({ hidden: !entry.hidden })}>
            <Icon name={entry.hidden ? 'eye' : 'eyeOff'} size={13} />
          </button>
          <button
            className="btn ghost icon sm"
            title="Set initiative"
            aria-label="Set initiative"
            onClick={() => {
              const v = window.prompt(`Initiative for ${entry.name}`, String(entry.initiative ?? ''));
              if (v !== null && v.trim() !== '' && Number.isFinite(Number(v))) patch({ initiative: Math.round(Number(v)) });
            }}
          >
            <Icon name="dice" size={13} />
          </button>
          <ConfirmButton label="" icon="trash" confirm="Remove" className="btn ghost icon sm" onConfirm={() => void run('battle.removeShip', { id: battle.id, battleShipId: entry.id })} />
        </div>
      )}
    </div>
  );
}

/** Where everyone is: the party's ship at the left, the others at their range bands. */
function RangeTrack({ rules, flag, others, turn }: { rules: SpaceRules; flag: BattleShip; others: BattleShip[]; turn?: Id }) {
  return (
    <div className="range-track" role="img" aria-label={`Ranges from ${flag.name}: ${others.map((s) => `${s.name} at ${rules.ranges.find((r) => r.id === s.range)?.name ?? 'unknown'}`).join(', ') || 'no other ships'}`}>
      <div className="range-own">
        <Icon name="ship" size={14} />
        <span>{flag.name}</span>
      </div>
      {rules.ranges.map((r) => (
        <div key={r.id} className={cx('range-band', r.dogfight && 'dogfight')}>
          <span className="range-name">{r.name}</span>
          <span className="range-dist">{r.distance}</span>
          <div className="range-ships">
            {others
              .filter((s) => s.range === r.id && !s.out)
              .map((s) => (
                <span key={s.id} className={cx('range-ship', s.side, turn === s.id && 'is-turn', s.hidden && 'is-hidden')} title={`${s.name}: ${r.name}`}>
                  {s.name}
                </span>
              ))}
          </div>
          <span className="range-thrust" title="Thrust needed to move one band from here">
            {r.thrust} Thrust
          </span>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────────── the crew's plan ─────────────────────────────

interface PlanProps {
  battle: Battle;
  rules: SpaceRules;
  planShip: BattleShip;
  ship?: Ship;
  flag?: BattleShip;
  plan: CrewAction[];
  /** Stations this viewer can act from. */
  stations: Station[];
  /** The GM can queue any action without a station. */
  freeHand: boolean;
  ahead: boolean;
  setAhead: (v: boolean) => void;
  me: Id;
}

function CrewPlan({ battle, rules, planShip, ship, flag, plan, stations, freeHand, ahead, setAhead, me }: PlanProps) {
  const pack = useRules();
  const gm = useIsGm();
  const ents = useApp((s) => s.ents);
  const mounts = useMemo(() => mountsOf(ship, pack.ships), [ship, pack.ships]);
  const [busy, setBusy] = useState(false);
  const send = (op: string, extra: Record<string, unknown>) => run('battle.plan', { id: battle.id, battleShipId: planShip.id, op, ...extra });
  const myTurn = battle.turn === planShip.id;
  const stepName = (id: string) => rules.steps.find((s) => s.id === id)?.name ?? (id === 'reaction' ? 'Reaction' : id);

  // What can be queued: by station for crew, everything for the GM running another ship.
  const offers = useMemo(() => {
    const list: { def: SpaceAction; station?: Station }[] = [];
    const wanted = (def: SpaceAction) => ahead || def.step === battle.step || def.step === 'reaction';
    if (stations.length === 0 && freeHand) {
      for (const def of rules.actions) if (wanted(def) && def.duty !== 'any') list.push({ def });
    } else {
      for (const station of stations) {
        for (const def of rules.actions) if (wanted(def) && (def.duty === station.duty || def.duty === 'any')) list.push({ def, station });
      }
    }
    return list;
  }, [stations, freeHand, rules, battle.step, ahead]);

  const others = battle.ships.filter((s) => s.id !== planShip.id);
  const rangeTo = (targetId: Id | undefined): string | undefined => {
    const target = battle.ships.find((s) => s.id === targetId);
    if (!target) return undefined;
    return planShip.id === flag?.id ? target.range : target.id === flag?.id ? planShip.range : undefined;
  };

  const add = (def: SpaceAction, station?: Station, index?: number) => {
    const mount = def.weapon ? (mounts.find((m) => m.id === station?.mount) ?? mounts.find((m) => m.weapons.length > 0) ?? mounts[0]) : undefined;
    const first = mount?.weapons[0];
    const action: CrewAction = {
      id: newId('cra'),
      step: def.step,
      action: def.id,
      duty: station?.duty ?? def.duty,
      label: def.name,
      by: me,
      ...(station ? { characterId: station.characterId } : {}),
      ...(mount ? { mount: mount.id } : {}),
      ...(first ? { weapon: first.name, weapons: mount!.weapons.filter((w) => w.id === first.id).length } : {}),
      ...(def.thrust ? { thrust: 1, closing: true } : {}),
      ...(def.target && others.length === 1 ? { targetId: others[0].id } : {}),
    };
    void send('add', { action, ...(index !== undefined ? { index } : {}) });
  };
  useDropZone('crewplan', {
    accepts: (p) => p.kind === 'crew-action',
    drop: (p) => {
      const offer = offers.find((o) => o.def.id === p.action && (o.station?.characterId ?? '') === (p.characterId ?? ''));
      if (offer) add(offer.def, offer.station);
    },
  });

  const shown = plan.filter((a) => ahead || a.step === battle.step || a.step === 'reaction');
  const later = plan.length - shown.length;
  const publish = async () => {
    setBusy(true);
    try {
      await act('battle.publish', { id: battle.id, battleShipId: planShip.id });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="actionbar crewbar" aria-label={`Plan for ${planShip.name}`}>
      <div className="actionbar-who">
        <span className="upper tiny faint">{stepName(battle.step)} step</span>
        <b>{planShip.name}</b>
        <span className="small dim">{myTurn ? 'Your ship acts now.' : `Waiting for ${battle.ships.find((s) => s.id === battle.turn)?.name ?? 'another ship'}. You can queue actions meanwhile.`}</span>
        <label className="check small">
          <input type="checkbox" checked={ahead} onChange={(e) => setAhead(e.target.checked)} />
          <span>Show every step</span>
        </label>
      </div>

      <div className="actionbar-palette" aria-label="Actions for your station">
        {offers.length === 0 && <span className="small dim">{stations.length === 0 ? 'Take a station on the ship’s status board to get its actions.' : 'Your station has nothing to do in this step.'}</span>}
        {(stations.length ? stations : [undefined]).map((station) => {
          const mine = offers.filter((o) => o.station?.characterId === station?.characterId);
          if (mine.length === 0) return null;
          return (
            <div key={station?.characterId ?? 'gm'} className="palette-group">
              <span className="upper tiny faint">{station ? `${station.name} · ${rules.duties.find((d) => d.id === station.duty)?.name ?? station.duty}` : 'Any action'}</span>
              <div className="palette-chips">
                {mine.map(({ def }) => (
                  <button
                    key={def.id}
                    className={cx('action-chip', def.step === battle.step ? 'significant' : def.step === 'reaction' ? 'minor' : '')}
                    title={`${def.note}${def.step !== battle.step && def.step !== 'reaction' ? ` (${stepName(def.step)} step)` : ''}`}
                    onPointerDown={(e) => beginDrag(e, { kind: 'crew-action', action: def.id, characterId: station?.characterId ?? '' }, def.name)}
                    onClick={() => add(def, station)}
                  >
                    {def.name}
                    {def.step === 'reaction' ? ' ↺' : ''}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="actionbar-plan" data-drop="crewplan">
        {shown.length === 0 && <div className="plan-empty">The ship's actions for this step collect here: everyone aboard adds what their station does.</div>}
        {shown.map((a) => (
          <CrewCard key={a.id} a={a} battle={battle} rules={rules} planShip={planShip} mounts={mounts} others={others} rangeTo={rangeTo} ship={ship} editable={gm || a.by === me || (!!a.characterId && (ents[a.characterId] as Character | undefined)?.ownerId === me)} who={a.characterId ? ((ents[a.characterId] as Character | undefined)?.name ?? 'Crew') : gm ? 'GM' : 'Crew'} onChange={(next) => void send('update', { action: next })} onRemove={() => void send('remove', { actionId: a.id })} stepName={stepName} />
        ))}
      </div>

      <div className="actionbar-go">
        {later > 0 && <span className="small dim">{later} queued for later steps</span>}
        <button className="btn primary" disabled={busy || (!myTurn && !gm)} onClick={() => void publish()} title={`Carry out everything queued for the ${stepName(battle.step).toLowerCase()} step and pass play on`}>
          <Icon name="send" size={14} /> Carry out step
        </button>
        {!myTurn && gm && <span className="tiny faint">Not this ship's turn: publishing anyway is a GM override.</span>}
      </div>
    </div>
  );
}

function IntField({ value, onCommit, label, width = 66, placeholder, disabled }: { value: number | undefined; onCommit: (n: number | undefined) => void; label: string; width?: number; placeholder?: string; disabled?: boolean }) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    const n = draft.trim() === '' ? undefined : Math.round(Number(draft));
    if (n !== undefined && !Number.isFinite(n)) return setDraft(value === undefined ? '' : String(value));
    if (n !== value) onCommit(n);
  };
  return <input className="input mono" style={{ width }} type="number" inputMode="numeric" aria-label={label} placeholder={placeholder} disabled={disabled} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}

function CrewCard({ a, battle, rules, planShip, mounts, others, rangeTo, ship, editable, who, onChange, onRemove, stepName }: { a: CrewAction; battle: Battle; rules: SpaceRules; planShip: BattleShip; mounts: ReturnType<typeof mountsOf>; others: BattleShip[]; rangeTo: (id: Id | undefined) => string | undefined; ship?: Ship; editable: boolean; who: string; onChange: (next: CrewAction) => void; onRemove: () => void; stepName: (id: string) => string }) {
  const pack = useRules();
  const def = rules.actions.find((d) => d.id === a.action);
  const off = !editable;
  const set = (change: Partial<CrewAction>) => onChange({ ...a, ...change });
  const needed = a.roll?.target ?? def?.check?.target ?? rules.attack.target;
  const effect = a.roll ? a.roll.total - needed : undefined;
  const ok = effect !== undefined && effect >= 0;
  const range = rangeTo(a.targetId);
  const band = rules.ranges.find((r) => r.id === range);
  const target = battle.ships.find((s) => s.id === a.targetId);
  const mount = mounts.find((m) => m.id === a.mount);
  const weaponDef = mount?.weapons.find((w) => w.name === a.weapon) ?? pack.ships?.weapons.find((w) => w.name === a.weapon);
  const targetTons = target?.seen?.tons ?? target?.quick?.tons ?? (target?.shipId ? getEntity<Ship>(target.shipId)?.tons : undefined);
  const situational = def?.weapon ? attackDm(rules, { range, weapons: weaponDef ? [weaponDef.id] : [], targetTons, lock: planShip.locks?.includes(a.targetId ?? '') ?? false, pilotFiring: a.action === 'pilotFire', calledShot: !!a.location }) : undefined;
  const isMissile = /missile/i.test(a.weapon ?? '');
  const salvos = battle.salvos.filter((s) => !s.done && (def?.weapon ? s.fromId === planShip.id && s.impactRound <= battle.round : s.toId === planShip.id));
  const damaged = Object.keys(ship?.crits ?? {}).filter((l) => (ship?.crits?.[l] ?? 0) > 0);
  const reachable = !weaponDef || !band || rangeIndex(rules, range) <= Math.max(rangeIndex(rules, rules.ranges.find((r) => r.name === weaponDef.range)?.id), weaponDef.range === 'Special' ? 99 : -1) || weaponDef.range === 'Special';

  const rollIt = async () => {
    if (!a.characterId || !def?.check) return;
    try {
      const res = await act<{ id: Id; total: number }>('character.check', { id: a.characterId, skill: def.check.skill, char: def.check.char, dm: situational?.dm ?? 0, target: needed, label: `${def.name}${a.weapon ? `: ${a.weapon}` : ''}` });
      flashRoll(res.id);
      set({ roll: { total: res.total, target: needed, rollId: res.id }, done: true });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className={cx('step', a.step === battle.step ? 'significant' : '', a.done && 'is-done')}>
      <div className="step-head">
        <label className="check" title="Tick when this has been resolved at the table">
          <input type="checkbox" checked={!!a.done} disabled={off} onChange={(e) => set({ done: e.target.checked })} aria-label={`${a.label} done`} />
        </label>
        <b className="grow">{a.label}</b>
        <span className="step-type">{a.step === battle.step ? who : `${who} · ${stepName(a.step)}`}</span>
        {editable && (
          <button className="btn ghost icon sm" aria-label={`Remove ${a.label}`} onClick={onRemove}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      <div className="step-body">
        {def?.target && (
          <div className="step-row">
            <select className="select" aria-label="Target ship" disabled={off} value={a.targetId ?? ''} onChange={(e) => set({ targetId: e.target.value || undefined })}>
              <option value="">Which ship…</option>
              {others.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.out ? ' (out)' : ''}
                </option>
              ))}
            </select>
            {band && <span className="small dim nowrap">{band.name}</span>}
          </div>
        )}
        {def?.thrust && (
          <div className="step-row">
            <span className="small dim">Thrust</span>
            <IntField label="Thrust spent" value={a.thrust} disabled={off} onCommit={(thrust) => set({ thrust: Math.max(0, thrust ?? 0) })} />
            <select className="select" aria-label="Close or open the range" disabled={off} value={a.closing === false ? 'open' : 'close'} onChange={(e) => set({ closing: e.target.value === 'close' })}>
              <option value="close">to close</option>
              <option value="open">to open</option>
            </select>
            {band && <span className="small dim nowrap">{band.thrust} for a band</span>}
          </div>
        )}
        {def?.weapon && (
          <>
            <div className="step-row">
              {mounts.length > 0 ? (
                <select
                  className="select"
                  aria-label="Turret"
                  disabled={off}
                  value={a.mount ?? ''}
                  onChange={(e) => {
                    const m = mounts.find((x) => x.id === e.target.value);
                    const w = m?.weapons[0];
                    set({ mount: e.target.value || undefined, weapon: w?.name, weapons: w ? m!.weapons.filter((x) => x.id === w.id).length : undefined });
                  }}
                >
                  <option value="">Turret…</option>
                  {mounts.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              ) : (
                <select className="select" aria-label="Weapon" disabled={off} value={pack.ships?.weapons.find((w) => w.name === a.weapon)?.id ?? ''} onChange={(e) => set({ weapon: pack.ships?.weapons.find((w) => w.id === e.target.value)?.name })}>
                  <option value="">Weapon…</option>
                  {(pack.ships?.weapons ?? []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} · {w.damage}
                    </option>
                  ))}
                </select>
              )}
              {mount && mount.weapons.length > 1 && new Set(mount.weapons.map((w) => w.id)).size > 1 && (
                <select className="select" aria-label="Weapon fired" disabled={off} value={a.weapon ?? ''} onChange={(e) => set({ weapon: e.target.value, weapons: mount.weapons.filter((w) => w.name === e.target.value).length })}>
                  {[...new Set(mount.weapons.map((w) => w.name))].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {!reachable && (
              <span className="small status warn">
                <Icon name="warning" size={12} /> Out of range: {weaponDef?.name} reaches {weaponDef?.range} only
              </span>
            )}
            {isMissile && (
              <div className="step-row">
                <span className="small dim">Missiles</span>
                <IntField label="Missiles launched" value={a.missiles ?? a.weapons ?? 1} disabled={off} onCommit={(missiles) => set({ missiles: Math.max(1, missiles ?? 1) })} />
                {salvos.length > 0 && (
                  <select className="select" aria-label="Salvo arriving" disabled={off} value={a.salvoId ?? ''} onChange={(e) => set({ salvoId: e.target.value || undefined })}>
                    <option value="">New launch</option>
                    {salvos.map((s) => (
                      <option key={s.id} value={s.id}>
                        Salvo of {s.missiles} arriving now
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </>
        )}
        {def?.salvo && salvos.length > 0 && (
          <div className="step-row">
            <select className="select" aria-label="Salvo" disabled={off} value={a.salvoId ?? ''} onChange={(e) => set({ salvoId: e.target.value || undefined })}>
              <option value="">Which salvo…</option>
              {salvos.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.missiles} missiles, round {s.impactRound}
                </option>
              ))}
            </select>
          </div>
        )}
        {def?.location && (
          <div className="step-row">
            <select className="select" aria-label="System" disabled={off} value={a.location ?? ''} onChange={(e) => set({ location: e.target.value || undefined })}>
              <option value="">Which system…</option>
              {(def.repair ? damaged : rules.criticals.locations.map((l) => l.id)).map((l) => (
                <option key={l} value={l}>
                  {locationName(rules, l)}
                  {ship?.crits?.[l] ? ` (severity ${ship.crits[l]})` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        {(def?.check || a.roll) && (
          <div className="step-row">
            <span className="small dim">{def?.check?.skill ?? 'Check'}</span>
            <IntField label="Check total" placeholder="total" value={a.roll?.total} disabled={off} onCommit={(total) => set({ roll: total === undefined ? undefined : { total, target: needed } })} />
            <span className="small dim">vs {needed}</span>
            {editable && a.characterId && def?.check && (
              <button className="btn sm" onClick={() => void rollIt()} title={`Roll ${def.check.skill}${situational?.dm ? ` with DM${situational.dm > 0 ? '+' : ''}${situational.dm} for the situation` : ''}`}>
                <Icon name="dice" size={13} />
              </button>
            )}
            {effect !== undefined && (
              <span className={cx('status small', ok ? 'ok' : 'danger')}>
                <Icon name={ok ? 'check' : 'x'} size={12} /> {ok ? `Effect ${effect}` : `Short by ${-effect}`}
              </span>
            )}
          </div>
        )}
        {situational && situational.parts.length > 0 && <span className="tiny faint">{situational.parts.map((p) => `${p.label} ${p.dm > 0 ? '+' : ''}${p.dm}`).join(' · ')}</span>}
        {def?.weapon && ok && !(isMissile && !a.salvoId && (rules.missiles.flight.find((f) => f.range === range)?.rounds ?? 0) > 0) && (
          <div className="step-row">
            <span className="small dim">Damage</span>
            <IntField label="Damage rolled" placeholder="dice" value={a.damage} disabled={off} onCommit={(damage) => set({ damage })} />
            <span className="small dim nowrap">
              {weaponDef ? `${weaponDef.damage}${(a.weapons ?? 1) > 1 ? ` +${linkedBonus(rules, weaponDef.damage, a.weapons ?? 1)}` : ''}` : ''}
              {a.damage !== undefined ? (a.salvoId ? ` · x Effect` : ` · +${effect} = ${a.damage + Math.max(0, effect ?? 0)}`) : ''}
            </span>
          </div>
        )}
        <input className="input step-note" aria-label="Note" placeholder="Note" disabled={off} defaultValue={a.note ?? ''} maxLength={300} onBlur={(e) => e.target.value !== (a.note ?? '') && set({ note: e.target.value })} />
      </div>
    </div>
  );
}

function AddBattleShipDialog({ battle, onClose }: { battle: Battle; onClose: () => void }) {
  const rules = useRules().space;
  const ships = useType('ship');
  const inBattle = new Set(battle.ships.map((s) => s.shipId));
  const available = ships.filter((s) => !inBattle.has(s.id));
  const [shipId, setShipId] = useState(available.find((s) => !s.party)?.id ?? '');
  const [name, setName] = useState('');
  const [tons, setTons] = useState(200);
  const [thrust, setThrust] = useState(2);
  const [armour, setArmour] = useState(0);
  const [pilot, setPilot] = useState(1);
  const [side, setSide] = useState<'enemy' | 'neutral' | 'party'>('enemy');
  const [range, setRange] = useState('veryLong');
  const [hidden, setHidden] = useState(false);
  const num = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
  const go = async () => {
    const res = await run('battle.addShip', shipId ? { id: battle.id, shipId, side, range, hidden } : { id: battle.id, name: name.trim(), quick: { tons, thrust, armour, pilot }, side, range, hidden });
    if (res) onClose();
  };
  return (
    <Modal
      title="Add a ship to the battle"
      icon="ship"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!shipId && !name.trim()} onClick={() => void go()}>
            <Icon name="plus" size={14} /> Add
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <Field label="Ship" hint="A ship with a record has its own plan, armour and systems. For a passing contact, a name and a few figures are enough.">
          <select className="select" value={shipId} onChange={(e) => setShipId(e.target.value)}>
            <option value="">Just a name and figures</option>
            {available.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ?? 'Unnamed'} · {s.className ?? `${s.tons ?? '?'} t`}
                {s.party ? ' (party)' : ''}
              </option>
            ))}
          </select>
        </Field>
        {!shipId && (
          <div className="npc-form">
            <Field label="Name" className="span-2">
              <input className="input" autoFocus value={name} maxLength={60} placeholder="Corsair" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Tons">
              <input className="input mono" type="number" value={tons} onChange={(e) => setTons(num(e.target.value, 1, 1000000))} />
            </Field>
            <Field label="Thrust">
              <input className="input mono" type="number" value={thrust} onChange={(e) => setThrust(num(e.target.value, 0, 20))} />
            </Field>
            <Field label="Armour">
              <input className="input mono" type="number" value={armour} onChange={(e) => setArmour(num(e.target.value, 0, 100))} />
            </Field>
            <Field label="Pilot skill">
              <input className="input mono" type="number" value={pilot} onChange={(e) => setPilot(num(e.target.value, -3, 6))} />
            </Field>
          </div>
        )}
        <div className="form-2">
          <Field label="Side">
            <select className="select" value={side} onChange={(e) => setSide(e.target.value as 'enemy' | 'neutral' | 'party')}>
              <option value="enemy">Hostile</option>
              <option value="neutral">Neutral</option>
              <option value="party">With the party</option>
            </select>
          </Field>
          <Field label="Range from the party's ship">
            <select className="select" value={range} onChange={(e) => setRange(e.target.value)}>
              {(rules?.ranges ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.distance})
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="check small">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          <span>Keep hidden from players until detected</span>
        </label>
      </div>
    </Modal>
  );
}
