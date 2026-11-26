/** Combat: the list of encounters, and the encounter screen with its cards, field, turn order and log. */
import { useMemo, useState } from 'react';
import { wornProtection } from '../../../shared/rules/character';
import type { Character, Combatant, CombatSide, Encounter, Id, TurnRecord, TurnStep } from '../../../shared/types';
import { act, run, upload } from '../../net';
import { Link, navigate } from '../../router';
import { toast, useEntity, useIsGm, useRules, useType } from '../../store';
import { ConfirmButton, cx, EditableText, Empty, Field, Modal, Tabs } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { HealthBars } from '../characters/Sheet';
import { ActionBar, actionDefs, newStep, usePlan } from './ActionBar';
import { Battlefield, mapOf } from './Battlefield';
import { describeStep, HEALTH_LABEL, initials, metresOn, orderOf, useAutoReplay, useCombatants, useReplay, useReplayStore, type CombatantInfo, type ReplayView } from './model';

const STATUS: Record<Encounter['status'], { label: string; cls: string }> = {
  setup: { label: 'Being set up', cls: '' },
  active: { label: 'Under way', cls: 'accent' },
  ended: { label: 'Over', cls: '' },
};

export function CombatPage({ encounterId }: { encounterId?: string }) {
  const encounter = useEntity<Encounter>(encounterId);
  if (encounterId && encounter?.type === 'encounter') return <EncounterView key={encounter.id} encounter={encounter} />;
  return <EncounterList missing={!!encounterId} />;
}

function EncounterList({ missing }: { missing: boolean }) {
  const encounters = useType('encounter');
  const gm = useIsGm();
  const [name, setName] = useState('');
  const sorted = useMemo(() => [...encounters].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.updatedAt - a.updatedAt), [encounters]);
  const create = async () => {
    const res = await run<{ id: string }>('encounter.create', { name: name.trim() || undefined });
    if (res?.id) navigate(`/combat/${res.id}`);
  };
  return (
    <div className="page page-narrow">
      <div className="page-head">
        <div className="grow">
          <h1>Combat</h1>
          <div className="small dim">Initiative, positions and turns for every fight.</div>
        </div>
        {gm && (
          <form
            className="row gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <input className="input" placeholder="Name the encounter" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Encounter name" />
            <button className="btn primary" type="submit">
              <Icon name="plus" size={14} /> New encounter
            </button>
          </form>
        )}
      </div>
      {missing && <div className="notice warn small">That encounter is not available.</div>}
      {sorted.length === 0 ? (
        <Empty icon="sword" title="No encounters">
          {gm ? 'Create one to set the field. Players see it once you open it to them or start it.' : 'When the GM starts a fight it will appear here.'}
        </Empty>
      ) : (
        <div className="enc-list">
          {sorted.map((e) => (
            <Link key={e.id} to={`/combat/${e.id}`} className={cx('enc-row', e.status)}>
              <span className="grow">
                <b>{e.name}</b>
                <span className="small dim block">
                  {e.combatants.length} on the field{e.status !== 'setup' ? ` · round ${e.round}` : ''}
                  {e.status === 'setup' && gm ? (e.open ? ' · open to players' : ' · hidden from players') : ''}
                </span>
              </span>
              <span className={cx('chip', STATUS[e.status].cls)}>{STATUS[e.status].label}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── the encounter ─────────────────────────────

function EncounterView({ encounter }: { encounter: Encounter }) {
  const gm = useIsGm();
  const rules = useRules().combat;
  const infos = useCombatants(encounter);
  const order = useMemo(() => orderOf(encounter, infos), [encounter, infos]);
  const replay = useReplay(encounter.id);
  useAutoReplay(encounter.id);
  const [selected, setSelected] = useState<Id | undefined>();
  const [focus, setFocus] = useState<Id | undefined>();
  const [dialog, setDialog] = useState<'npc' | 'map' | null>(null);
  const [actFor, setActFor] = useState<Id | undefined>();

  const active = encounter.status === 'active';
  const turnInfo = encounter.turn ? infos.get(encounter.turn) : undefined;
  // Whose turn this viewer is putting together: their own when it comes up; the GM may act for anyone.
  const actorId = active ? (gm && actFor && infos.has(actFor) ? actFor : turnInfo?.controlled ? turnInfo.combatant.id : undefined) : undefined;
  const actor = actorId ? infos.get(actorId) : undefined;
  const [steps, setSteps] = usePlan(`${encounter.id}.${actorId ?? 'none'}.${encounter.round}`);
  const squareMetres = rules?.squareMetres ?? 1.5;

  const map = mapOf(encounter);
  const metres = (a: { x?: number; y?: number }, b: { x?: number; y?: number }) => metresOn(map, a, b, squareMetres);
  const moveStep = [...steps].reverse().find((s) => s.action === 'move' && s.to);
  const plannedTo = moveStep?.to;
  const actorAt = actor ? { x: plannedTo?.x ?? actor.combatant.x, y: plannedTo?.y ?? actor.combatant.y } : undefined;
  const planMove = (to: { x: number; y: number }) => {
    const waiting = steps.find((s) => s.action === 'move' && !s.to) ?? moveStep;
    if (waiting) {
      setSteps(steps.map((s) => (s.id === waiting.id ? { ...s, to, done: true } : s)));
      return;
    }
    const def = actionDefs(rules).find((d) => d.id === 'move') ?? { id: 'move', name: 'Move', type: 'minor' as const, note: '' };
    setSteps([...steps, { ...newStep(def), to, done: true }]);
  };
  const pick = (id: Id | undefined) => {
    setSelected(id);
    // With an attack step open, clicking someone makes them its target.
    if (id && focus && actor && id !== actor.combatant.id && steps.some((s) => s.id === focus)) {
      setSteps(steps.map((s) => (s.id === focus ? { ...s, targetId: id } : s)));
    }
  };
  const focusTarget = steps.find((s) => s.id === focus)?.targetId;

  const enemies = order.filter((c) => c.side !== 'party');
  const party = order.filter((c) => c.side === 'party');
  const mineOutOfTurn = active ? order.filter((c) => infos.get(c.id)?.mine && c.id !== encounter.turn && !c.out) : [];
  const reactions = actionDefs(rules).filter((a) => a.type === 'reaction');
  const reactionList = reactions.length ? reactions : [{ id: 'dodge', name: 'Dodge', type: 'reaction' as const, note: '' }];

  return (
    <div className="combat">
      <header className="combat-head">
        <Link to="/combat" className="btn ghost sm" aria-label="Back to the list of encounters">
          <Icon name="chevronLeft" size={14} /> Combat
        </Link>
        <h1 className="grow">
          <EditableText value={encounter.name} disabled={!gm} onCommit={(name) => name.trim() && void run('encounter.update', { id: encounter.id, name })} />
        </h1>
        <span className={cx('chip', STATUS[encounter.status].cls)}>
          {STATUS[encounter.status].label}
          {active ? ` · round ${encounter.round}` : ''}
        </span>
        {gm && (
          <div className="row gap-4 wrap">
            {encounter.status === 'setup' && (
              <>
                <button className="btn sm gm" onClick={() => void run('encounter.update', { id: encounter.id, open: !encounter.open })} title={encounter.open ? 'Hide the field from players again' : 'Let players see the field and place their tokens'}>
                  <Icon name={encounter.open ? 'eyeOff' : 'eye'} size={13} /> {encounter.open ? 'Hide from players' : 'Open to players'}
                </button>
                <button className="btn sm gm" onClick={() => void run('encounter.initiative', { id: encounter.id })} title="Roll for everyone who has no initiative yet">
                  <Icon name="dice" size={13} /> Roll initiative
                </button>
                <button className="btn sm primary" onClick={() => void run('encounter.start', { id: encounter.id })}>
                  <Icon name="play" size={13} /> Start
                </button>
              </>
            )}
            {active && (
              <button className="btn sm gm" onClick={() => void run('encounter.next', { id: encounter.id })} title="Pass over whoever is acting">
                Next turn <Icon name="chevronRight" size={13} />
              </button>
            )}
            <button className="btn sm gm" onClick={() => setDialog('npc')}>
              <Icon name="plus" size={13} /> Add NPC
            </button>
            <button className="btn sm gm" onClick={() => setDialog('map')}>
              <Icon name="image" size={13} /> Battlemap
            </button>
            {active && <ConfirmButton label="End" confirm="End the encounter" className="btn sm gm" onConfirm={() => void run('encounter.end', { id: encounter.id })} />}
            {encounter.status === 'ended' && (
              <button className="btn sm gm" onClick={() => void run('encounter.end', { id: encounter.id, reopen: true })}>
                Resume
              </button>
            )}
            {encounter.status !== 'active' && (
              <ConfirmButton
                label="Delete"
                icon="trash"
                confirm="Delete this encounter"
                onConfirm={async () => {
                  await run('entity.delete', { id: encounter.id });
                  navigate('/combat');
                }}
              />
            )}
          </div>
        )}
      </header>

      <div className="combat-grid">
        <section className="combat-stage">
          <CardRow title="Opposition" list={enemies} infos={infos} encounter={encounter} replay={replay} selected={selected ?? focusTarget} onSelect={pick} onActFor={gm && active ? setActFor : undefined} actingFor={actorId} />
          <Battlefield encounter={encounter} infos={infos} replay={replay} selected={selected} onSelect={pick} planFor={actor && !replay ? actor.combatant.id : undefined} plannedTo={plannedTo} onPlanMove={planMove} targetId={focusTarget} squareMetres={squareMetres} />
          <div className="replay-strip">
            <ReplayCaption replay={replay} infos={infos} metres={metres} />
          </div>
          <CardRow title="The party" list={party} infos={infos} encounter={encounter} replay={replay} selected={selected ?? focusTarget} onSelect={pick} onActFor={gm && active ? setActFor : undefined} actingFor={actorId} />
        </section>

        <aside className="combat-side">
          <TurnOrder encounter={encounter} order={order} infos={infos} />
          <LogPanel encounter={encounter} infos={infos} metres={metres} />
        </aside>
      </div>

      {actor ? (
        <ActionBar
          encounter={encounter}
          actor={actor}
          infos={infos}
          steps={steps}
          setSteps={setSteps}
          focus={focus}
          setFocus={setFocus}
          distanceTo={(id) => {
            const t = infos.get(id)?.combatant;
            return t && actorAt ? metres(actorAt, t) : undefined;
          }}
          moveMetres={plannedTo ? metres(actor.combatant, plannedTo) : undefined}
        />
      ) : (
        <div className="actionbar idle">
          <span className="dim">
            {encounter.status === 'setup'
              ? gm
                ? 'Place the tokens, add the opposition, then start the encounter.'
                : 'The GM is setting the field. Drag your token to where you start.'
              : encounter.status === 'ended'
                ? 'This encounter is over. The log on the right can be replayed.'
                : turnInfo
                  ? `${turnInfo.name} is acting.`
                  : 'Waiting on the GM.'}
          </span>
          {mineOutOfTurn.map((c) => (
            <span key={c.id} className="row gap-4">
              <span className="small dim">{infos.get(c.id)?.name} reacts:</span>
              {reactionList.map((r) => (
                <button key={r.id} className="btn sm" title={r.note} onClick={() => void run('encounter.react', { id: encounter.id, combatantId: c.id, action: r.id, label: r.name })}>
                  {r.name}
                </button>
              ))}
            </span>
          ))}
        </div>
      )}
      {dialog === 'npc' && <AddNpcDialog encounter={encounter} onClose={() => setDialog(null)} />}
      {dialog === 'map' && <MapDialog encounter={encounter} onClose={() => setDialog(null)} />}
    </div>
  );
}

type Metres = (a: { x: number; y: number }, b: { x: number; y: number }) => number | undefined;

function ReplayCaption({ replay, infos, metres }: { replay?: ReplayView; infos: Map<Id, CombatantInfo>; metres: Metres }) {
  if (!replay) return null;
  const who = infos.get(replay.record.combatantId)?.name ?? 'Someone';
  const nameOf = (id: Id | undefined) => (id ? infos.get(id)?.name : undefined);
  return (
    <div className="replay-caption" role="status" aria-live="polite">
      <span className="upper tiny faint">
        Replay · step {Math.max(1, replay.index + 1)} of {replay.record.steps.length}
      </span>
      <span>
        <b>{who}</b> {replay.step ? describeStep(replay.step, replay.result, nameOf, metres) : replay.record.reaction ? 'reacts' : 'takes a turn'}
      </span>
      <button className="btn ghost sm" onClick={() => useReplayStore.getState().stop()}>
        Skip
      </button>
    </div>
  );
}

// ───────────────────────────── cards ─────────────────────────────

function CardRow({
  title,
  list,
  infos,
  encounter,
  replay,
  selected,
  onSelect,
  onActFor,
  actingFor,
}: {
  title: string;
  list: Combatant[];
  infos: Map<Id, CombatantInfo>;
  encounter: Encounter;
  replay?: ReplayView;
  selected?: Id;
  onSelect: (id: Id | undefined) => void;
  onActFor?: (id: Id | undefined) => void;
  actingFor?: Id;
}) {
  return (
    <div className="card-row" aria-label={title}>
      <span className="card-row-title upper tiny faint">{title}</span>
      {list.length === 0 && <span className="small faint">Nobody yet.</span>}
      {list.map((c) => {
        const info = infos.get(c.id);
        return info ? <CombatCard key={c.id} info={info} encounter={encounter} replay={replay} selected={selected === c.id} onSelect={onSelect} onActFor={onActFor} actingFor={actingFor} /> : null;
      })}
    </div>
  );
}

function CombatCard({ info, encounter, replay, selected, onSelect, onActFor, actingFor }: { info: CombatantInfo; encounter: Encounter; replay?: ReplayView; selected: boolean; onSelect: (id: Id | undefined) => void; onActFor?: (id: Id | undefined) => void; actingFor?: Id }) {
  const gm = useIsGm();
  const c = info.combatant;
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const turn = encounter.status === 'active' && encounter.turn === c.id;
  const acting = replay?.record.combatantId === c.id;
  const struck = replay?.step?.targetId === c.id && replay.step.action === 'attack';
  const hit = struck && replay?.result?.hit !== false;
  const sheet = info.character;
  const armour = sheet ? wornProtection(sheet) : undefined;
  const patch = (p: Record<string, unknown>) => void run('encounter.combatant', { id: encounter.id, combatantId: c.id, patch: p });
  return (
    <div
      className={cx('ccard', c.side, turn && 'is-turn', c.out && 'is-out', c.hidden && 'is-hidden', selected && 'is-selected', acting && 'is-acting', struck && (hit ? 'is-hit' : 'is-missed'))}
      onClick={() => onSelect(c.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onSelect(c.id)}
      aria-label={`${info.name}, initiative ${c.initiative ?? 'not rolled'}, ${HEALTH_LABEL[info.health]}${turn ? ', acting now' : ''}`}
    >
      <div className="ccard-top">
        <span className={cx('ccard-face', c.side)} style={info.portrait ? { backgroundImage: `url(${info.portrait})` } : undefined}>
          {!info.portrait && initials(info.name)}
        </span>
        <span className="ccard-name">
          <b>{info.name}</b>
          <span className="tiny dim">
            {turn ? 'Acting now' : c.out ? 'Out of the fight' : c.acted ? 'Has acted' : encounter.status === 'active' ? 'Waiting' : info.kind === 'creature' ? 'Creature' : info.kind === 'pc' ? 'Traveller' : 'NPC'}
            {c.hidden ? ' · hidden' : ''}
          </span>
        </span>
        <span className="ccard-init" title="Initiative">
          {c.initiative ?? '–'}
        </span>
      </div>
      {sheet ? (
        <HealthBars c={sheet} />
      ) : (
        <div className={cx('ccard-health', info.health)}>
          <Icon name={info.health === 'ok' ? 'check' : 'warning'} size={12} /> {HEALTH_LABEL[info.health]}
        </div>
      )}
      <div className="ccard-tags">
        {armour !== undefined && armour > 0 && (
          <span className="chip" title="Armour worn">
            <Icon name="shield" size={11} /> {armour}
          </span>
        )}
        {sheet?.weapons?.[0] && (
          <span className="chip" title={`${sheet.weapons[0].name}: ${sheet.weapons[0].damage}`}>
            {sheet.weapons[0].name} {sheet.weapons[0].damage}
          </span>
        )}
        {(c.reactions ?? 0) > 0 && (
          <span className="chip warn" title="Reactions made since their last turn">
            DM-{c.reactions}
          </span>
        )}
        {(c.conditions ?? []).map((x) => (
          <span key={x} className="chip">
            {x}
          </span>
        ))}
      </div>
      {struck && replay?.result && (
        <span key={replay.step!.id} className={cx('ccard-pop', hit ? 'hit' : 'miss')}>
          {hit ? (replay.result.dealt !== undefined ? `−${replay.result.taken ?? replay.result.dealt}` : 'Hit') : 'Miss'}
        </span>
      )}
      {(gm || info.mine) && (
        <div className="ccard-tools" onClick={(e) => e.stopPropagation()}>
          {encounter.status !== 'ended' && c.initiative === undefined && (
            <button className="btn sm" onClick={() => void run('encounter.initiative', { id: encounter.id, combatantId: c.id })}>
              <Icon name="dice" size={12} /> Initiative
            </button>
          )}
          {onActFor && !c.out && actingFor !== c.id && (
            <button className="btn sm gm" onClick={() => onActFor(c.id)} title="Put this combatant's turn together now">
              Act
            </button>
          )}
          {gm && (
            <button
              className="btn ghost icon sm"
              aria-label={`More for ${info.name}`}
              aria-expanded={!!menu}
              onClick={(e) => {
                if (menu) return setMenu(null);
                // The card rows scroll sideways, so the menu is placed against the window instead.
                const r = e.currentTarget.getBoundingClientRect();
                const top = r.bottom + 250 > window.innerHeight ? Math.max(8, r.top - 246) : r.bottom + 4;
                setMenu({ left: Math.max(8, Math.min(r.left, window.innerWidth - 216)), top });
              }}
            >
              <Icon name="menu" size={13} />
            </button>
          )}
          {menu && gm && (
            <div className="ccard-menu" style={menu} onMouseLeave={() => setMenu(null)} onClick={() => setMenu(null)}>
              <button onClick={() => patch({ hidden: !c.hidden })}>{c.hidden ? 'Reveal to players' : 'Hide from players'}</button>
              <button onClick={() => patch({ out: !c.out })}>{c.out ? 'Back in the fight' : 'Out of the fight'}</button>
              <button
                onClick={() => {
                  const v = window.prompt(`Initiative for ${info.name}`, String(c.initiative ?? ''));
                  if (v !== null && v.trim() !== '' && Number.isFinite(Number(v))) patch({ initiative: Math.round(Number(v)) });
                }}
              >
                Set initiative…
              </button>
              <button onClick={() => patch({ side: c.side === 'enemy' ? 'neutral' : c.side === 'neutral' ? 'party' : 'enemy' })}>Side: {c.side} (change)</button>
              {encounter.status === 'active' && <button onClick={() => void run('encounter.next', { id: encounter.id, combatantId: c.id })}>Give them the turn</button>}
              <button onClick={() => navigate(`/characters/${c.characterId}`)}>Open sheet</button>
              <button className="danger" onClick={() => void run('encounter.remove', { id: encounter.id, combatantId: c.id })}>
                Remove from encounter
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── side panel ─────────────────────────────

function TurnOrder({ encounter, order, infos }: { encounter: Encounter; order: Combatant[]; infos: Map<Id, CombatantInfo> }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3 className="grow">Turn order</h3>
        {encounter.status === 'active' && <span className="chip accent">Round {encounter.round}</span>}
      </div>
      <ol className="turn-list">
        {order.map((c) => {
          const info = infos.get(c.id);
          if (!info) return null;
          const turn = encounter.status === 'active' && encounter.turn === c.id;
          return (
            <li key={c.id} className={cx(c.side, turn && 'is-turn', c.out && 'is-out', c.acted && 'has-acted')}>
              <span className="turn-init mono">{c.initiative ?? '–'}</span>
              <span className={cx('turn-side', c.side)} aria-hidden="true" />
              <span className="grow">
                {info.name}
                {c.hidden && <span className="faint"> (hidden)</span>}
              </span>
              <span className="tiny dim">{turn ? 'acting' : c.out ? 'out' : c.acted ? 'done' : ''}</span>
            </li>
          );
        })}
        {order.length === 0 && <li className="faint small">Nobody on the field.</li>}
      </ol>
      {encounter.status === 'active' && !encounter.turn && <p className="small dim turn-note">Someone the party cannot see is acting.</p>}
    </div>
  );
}

function LogPanel({ encounter, infos, metres }: { encounter: Encounter; infos: Map<Id, CombatantInfo>; metres: Metres }) {
  const nameOf = (id: Id | undefined) => (id ? infos.get(id)?.name : undefined);
  const records = [...encounter.log].reverse();
  return (
    <div className="panel combat-log">
      <div className="panel-head">
        <h3 className="grow">What has happened</h3>
      </div>
      {records.length === 0 ? (
        <p className="small dim turn-note">Turns appear here as they are published.</p>
      ) : (
        <ul className="log-list">
          {records.map((r) => (
            <LogEntry key={r.id} record={r} encounterId={encounter.id} who={nameOf(r.combatantId) ?? 'Someone'} nameOf={nameOf} metres={metres} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LogEntry({ record, encounterId, who, nameOf, metres }: { record: TurnRecord; encounterId: Id; who: string; nameOf: (id: Id | undefined) => string | undefined; metres: Metres }) {
  return (
    <li>
      <div className="log-head">
        <span className="tiny faint mono">R{record.round}</span>
        <b className="grow">
          {who}
          {record.reaction ? ' (reaction)' : ''}
        </b>
        {record.steps.length > 0 && (
          <button className="btn ghost sm" onClick={() => useReplayStore.getState().play(encounterId, record)} aria-label={`Replay ${who}'s turn`}>
            <Icon name="play" size={12} /> Replay
          </button>
        )}
      </div>
      {record.steps.length === 0 ? (
        <span className="small dim">Passed.</span>
      ) : (
        <ol className="log-steps">
          {record.steps.map((s: TurnStep) => (
            <li key={s.id}>{describeStep(s, record.results.find((x) => x.stepId === s.id), nameOf, metres)}</li>
          ))}
        </ol>
      )}
    </li>
  );
}

// ───────────────────────────── GM dialogs ─────────────────────────────

function AddNpcDialog({ encounter, onClose }: { encounter: Encounter; onClose: () => void }) {
  const gear = useRules().gear;
  const characters = useType('character');
  const [tab, setTab] = useState<'quick' | 'library'>('quick');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'npc' | 'creature'>('npc');
  const [side, setSide] = useState<CombatSide>('enemy');
  const [copies, setCopies] = useState(1);
  const [hidden, setHidden] = useState(false);
  const [str, setStr] = useState(7);
  const [dex, setDex] = useState(7);
  const [end, setEnd] = useState(7);
  const [skill, setSkill] = useState(1);
  const [weapon, setWeapon] = useState('');
  const [damage, setDamage] = useState('2D');
  const [armour, setArmour] = useState(0);
  const [busy, setBusy] = useState(false);
  const inFight = new Set(encounter.combatants.map((c) => c.characterId));
  const library = characters.filter((c) => c.kind !== 'pc' || !inFight.has(c.id)).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const weaponDefs = gear?.weapons ?? [];
  const num = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

  const addQuick = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const def = weaponDefs.find((w) => w.id === weapon);
    const res = await run('encounter.addNpc', {
      id: encounter.id,
      name: name.trim(),
      kind,
      side,
      copies,
      hidden,
      chars: { STR: str, DEX: dex, END: end },
      armour,
      skills: def ? { [def.skill]: skill } : { 'Melee (unarmed)': skill },
      weapons: def ? [def.id] : [{ name: kind === 'creature' ? 'Natural weapons' : 'Unarmed', damage, range: 'melee' }],
    });
    setBusy(false);
    if (res) onClose();
  };
  const addExisting = async (c: Character) => {
    setBusy(true);
    const res = await run('encounter.add', { id: encounter.id, characterId: c.id, hidden, side: c.kind === 'pc' ? 'party' : side });
    setBusy(false);
    if (res) toast(`${c.name ?? 'Character'} joins the fight`, 'ok');
  };

  return (
    <Modal
      title="Add to the encounter"
      icon="users"
      size="wide"
      onClose={onClose}
      footer={
        tab === 'quick' ? (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void addQuick()}>
              <Icon name="plus" size={14} /> Add {copies > 1 ? `${copies} of them` : 'to the fight'}
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        )
      }
    >
      <Tabs
        tabs={[
          { id: 'quick', label: 'Make one up' },
          { id: 'library', label: 'From the cast' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="row wrap gap-12 npc-common">
        <label className="check small">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          <span>Keep hidden from players until revealed</span>
        </label>
        <span className="row gap-4 small">
          Side
          <select className="select" value={side} onChange={(e) => setSide(e.target.value as CombatSide)} aria-label="Side">
            <option value="enemy">Opposition</option>
            <option value="neutral">Neutral</option>
            <option value="party">With the party</option>
          </select>
        </span>
      </div>
      {tab === 'quick' ? (
        <div className="npc-form">
          <Field label="Name" hint="This is what players see on the card and token.">
            <input className="input" autoFocus value={name} maxLength={60} placeholder="Dock raider" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="How many">
            <input className="input mono" type="number" min={1} max={20} value={copies} onChange={(e) => setCopies(num(e.target.value, 1, 20))} />
          </Field>
          <Field label="Kind">
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value as 'npc' | 'creature')}>
              <option value="npc">Person</option>
              <option value="creature">Creature</option>
            </select>
          </Field>
          <Field label="STR">
            <input className="input mono" type="number" min={1} max={60} value={str} onChange={(e) => setStr(num(e.target.value, 1, 60))} />
          </Field>
          <Field label="DEX">
            <input className="input mono" type="number" min={1} max={60} value={dex} onChange={(e) => setDex(num(e.target.value, 1, 60))} />
          </Field>
          <Field label="END">
            <input className="input mono" type="number" min={1} max={60} value={end} onChange={(e) => setEnd(num(e.target.value, 1, 60))} />
          </Field>
          <Field label="Weapon" className="span-2">
            <select className="select" value={weapon} onChange={(e) => setWeapon(e.target.value)}>
              <option value="">{kind === 'creature' ? 'Natural weapons' : 'Unarmed / improvised'}</option>
              {weaponDefs.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.tl !== undefined ? ` (TL${w.tl})` : ''} · {w.damage}
                </option>
              ))}
            </select>
          </Field>
          {!weapon && (
            <Field label="Damage">
              <input className="input mono" value={damage} maxLength={20} onChange={(e) => setDamage(e.target.value)} />
            </Field>
          )}
          <Field label="Skill with it">
            <input className="input mono" type="number" min={0} max={6} value={skill} onChange={(e) => setSkill(num(e.target.value, 0, 6))} />
          </Field>
          <Field label="Armour">
            <input className="input mono" type="number" min={0} max={60} value={armour} onChange={(e) => setArmour(num(e.target.value, 0, 60))} />
          </Field>
        </div>
      ) : (
        <div className="npc-library">
          {library.length === 0 && <p className="small dim">No characters to add. Make NPCs and creatures on the Crew screen, or make one up here.</p>}
          {library.map((c) => (
            <div key={c.id} className="npc-lib-row">
              <span className="grow">
                <b>{c.name ?? 'Unnamed'}</b>
                <span className="small dim">
                  {' '}
                  · {c.kind === 'pc' ? 'Traveller' : c.kind === 'creature' ? 'Creature' : 'NPC'}
                  {c.title ? ` · ${c.title}` : ''}
                  {inFight.has(c.id) ? ' · already here' : ''}
                </span>
              </span>
              {c.kind !== 'pc' && inFight.has(c.id) ? (
                <button className="btn sm" disabled={busy} onClick={() => void act('encounter.add', { id: encounter.id, characterId: c.id, copies: 2, hidden, side }).then(() => toast(`Another ${c.name ?? 'one'} joins the fight`, 'ok'), (err: Error) => toast(err.message, 'error'))} title="Adds a copy with its own wounds">
                  Add another
                </button>
              ) : (
                <button className="btn sm" disabled={busy} onClick={() => void addExisting(c)}>
                  <Icon name="plus" size={12} /> Add
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function MapDialog({ encounter, onClose }: { encounter: Encounter; onClose: () => void }) {
  const [squares, setSquares] = useState(encounter.map?.squares ?? 24);
  const [showGrid, setShowGrid] = useState(encounter.map?.showGrid ?? false);
  const [busy, setBusy] = useState(false);
  const rules = useRules().combat;
  const save = (map: Record<string, unknown> | null) => run('encounter.update', { id: encounter.id, map });
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const res = await upload(file);
      const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('That image could not be read'));
        img.src = res.url;
      });
      await save({ url: res.url, ...size, squares, showGrid });
      toast('Battlemap set', 'ok');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Battlemap"
      icon="image"
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="col gap-12">
        <p className="small dim">Upload any image: a drawn map, a deck plan, a photo of the table. Tokens keep their places when the map changes.</p>
        <div className="row gap-4 wrap">
          <label className={cx('btn', busy && 'disabled')}>
            <Icon name="upload" size={14} /> {busy ? 'Uploading…' : encounter.map ? 'Replace the map' : 'Upload a map'}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={busy} onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          {encounter.map && (
            <button className="btn danger" onClick={() => void save(null)}>
              <Icon name="trash" size={14} /> Remove the map
            </button>
          )}
        </div>
        {encounter.map && (
          <>
            <Field label="Squares across the map" hint={`Each square is ${rules?.squareMetres ?? 1.5} m. This sets the scale for distances and token size.`}>
              <input
                className="input mono"
                type="number"
                min={4}
                max={200}
                value={squares}
                onChange={(e) => setSquares(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                onBlur={() => void save({ ...encounter.map, squares, showGrid })}
              />
            </Field>
            <label className="check">
              <input
                type="checkbox"
                checked={showGrid}
                onChange={(e) => {
                  setShowGrid(e.target.checked);
                  void save({ ...encounter.map, squares, showGrid: e.target.checked });
                }}
              />
              <span>Draw a grid over the map</span>
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}
