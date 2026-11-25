/** Objectives: party goals set by the GM, and personal goals each player keeps for themselves. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { PARTY, type Audience, type Id, type Objective } from '../../../shared/types';
import { act, run, setFields } from '../../net';
import { navigate, useRoute } from '../../router';
import { toast, useCampaign, useIsGm, useMe, usePlayers } from '../../store';
import { ConfirmButton, cx, Empty, Field, Modal } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { Markdown } from '../../ui/Markdown';
import { systemLabel, useMapData, type MapData } from '../map/mapData';
import { fitTo, selectSystem, setPlanner, useMap } from '../map/mapStore';
import { SystemPicker } from '../map/SystemPicker';
import { useType } from '../../store';

const STATUS: Record<Objective['status'], { label: string; chip: string }> = {
  active: { label: 'Active', chip: 'accent' },
  done: { label: 'Completed', chip: 'ok' },
  failed: { label: 'Failed', chip: 'danger' },
};

function ObjectiveEditor({ objective, data, onClose }: { objective?: Objective; data: MapData; onClose: () => void }) {
  const gm = useIsGm();
  const me = useMe();
  const players = usePlayers();
  const [title, setTitle] = useState(objective?.title ?? '');
  const [body, setBody] = useState(objective?.body ?? '');
  const [reward, setReward] = useState(objective?.reward ?? '');
  const [scope, setScope] = useState<Audience>(objective?.scope ?? (gm ? PARTY : (me?.playerId ?? PARTY)));
  const [targets, setTargets] = useState<Id[]>(objective?.targets.map((t) => t.systemId) ?? []);

  const save = async () => {
    try {
      const targetList = targets.map((systemId) => ({ systemId }));
      if (objective) {
        await act('entity.patch', {
          id: objective.id,
          ops: [
            { op: 'set', path: ['title'], value: title.trim() },
            body.trim() ? { op: 'set', path: ['body'], value: body } : { op: 'del', path: ['body'] },
            reward.trim() ? { op: 'set', path: ['reward'], value: reward.trim() } : { op: 'del', path: ['reward'] },
            { op: 'set', path: ['targets'], value: targetList },
            ...(gm ? [{ op: 'set', path: ['scope'], value: scope }] : []),
          ],
        });
      } else {
        await act('objective.create', { title: title.trim(), body: body.trim() ? body : undefined, reward: reward.trim() || undefined, scope: gm ? scope : undefined, targets: targetList });
      }
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <Modal
      title={objective ? 'Edit objective' : 'New objective'}
      icon="target"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!title.trim()} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <Field label="Title">
          <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Deliver the reactor parts to Ardent" />
        </Field>
        {gm ? (
          <Field label="For" hint={scope === PARTY ? 'Everyone in the party sees this objective.' : 'Only this player (and you) can see it.'}>
            <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value={PARTY}>The whole party</option>
              {players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} only
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <div className="notice">
            <Icon name="lock" size={14} /> This is a personal objective: only you and the GM can see it.
          </div>
        )}
        <Field label="Details" hint="Markdown is supported.">
          <textarea className="textarea" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label="Reward">
          <input className="input" value={reward} onChange={(e) => setReward(e.target.value)} placeholder="e.g. Cr20,000 and a favour" />
        </Field>
        <Field label="Where" hint="Places this objective points to. They are marked on the map and used by the route planner.">
          <div className="col gap-4">
            {targets.map((id) => (
              <div key={id} className="row">
                <span className="chip accent grow" style={{ justifyContent: 'flex-start', height: 26 }}>
                  <Icon name="pin" size={12} /> {systemLabel(data.byId.get(id))}
                </span>
                <button className="btn ghost icon sm" onClick={() => setTargets(targets.filter((t) => t !== id))} aria-label="Remove place">
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
            <SystemPicker data={data} exclude={targets} onPick={(id) => setTargets([...targets, id])} placeholder="Add a system…" />
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function ObjectiveCard({ objective, data, highlight }: { objective: Objective; data: MapData; highlight: boolean }) {
  const gm = useIsGm();
  const me = useMe();
  const players = useType('player');
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const mine = objective.createdBy === me?.playerId && objective.scope === me?.playerId;
  const canEdit = gm || mine;
  const owner = objective.scope === PARTY ? undefined : players.find((p) => p.id === objective.scope);

  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight]);

  const show = (systemId: Id) => {
    const info = data.byId.get(systemId);
    if (!info) return;
    selectSystem(systemId, { gx: info.gx, gy: info.gy });
    useMap.setState({ panel: 'info' });
    fitTo({ kind: 'system', id: systemId });
    navigate('/map');
  };

  return (
    <div ref={ref} className={cx('panel objective', objective.status !== 'active' && 'closed', highlight && 'highlight')}>
      <div className="panel-body col">
        <div className="row top">
          <Icon name="target" size={16} style={{ color: owner?.color ?? 'var(--warn)', marginTop: 2 }} />
          <div className="grow">
            <strong style={{ fontSize: 15 }}>{objective.title}</strong>
            <div className="row wrap gap-4" style={{ marginTop: 4 }}>
              <span className={`chip ${STATUS[objective.status].chip}`}>{STATUS[objective.status].label}</span>
              {owner ? (
                <span className="chip">
                  <span className="dot" style={{ background: owner.color }} /> {owner.id === me?.playerId ? 'Personal' : owner.name}
                </span>
              ) : (
                <span className="chip">
                  <Icon name="users" size={11} /> Party
                </span>
              )}
              {objective.reward && (
                <span className="chip warn">
                  <Icon name="coins" size={11} /> {objective.reward}
                </span>
              )}
            </div>
          </div>
        </div>
        {objective.body && <Markdown text={objective.body} />}
        {objective.targets.length > 0 && (
          <div className="row wrap gap-4">
            {objective.targets.map((t) => {
              const info = data.byId.get(t.systemId);
              return (
                <button key={t.systemId} className="chip accent" onClick={() => show(t.systemId)} disabled={!info} title={info ? 'Show on the map' : 'Not on your map'}>
                  <Icon name="pin" size={11} /> {info ? systemLabel(info) : 'Unknown location'}
                </button>
              );
            })}
          </div>
        )}
        {canEdit && (
          <div className="row wrap" style={{ marginTop: 2 }}>
            {objective.status === 'active' ? (
              <>
                <button className="btn sm" onClick={() => void setFields(objective.id, { status: 'done' })}>
                  <Icon name="check" size={12} /> Complete
                </button>
                <button className="btn sm ghost" onClick={() => void setFields(objective.id, { status: 'failed' })}>
                  Mark failed
                </button>
              </>
            ) : (
              <button className="btn sm ghost" onClick={() => void setFields(objective.id, { status: 'active' })}>
                Reopen
              </button>
            )}
            <div className="grow" />
            <button className="btn sm ghost" onClick={() => setEditing(true)}>
              <Icon name="edit" size={12} /> Edit
            </button>
            <ConfirmButton className="btn sm ghost" label={<Icon name="trash" size={13} />} confirm="Delete" title="Delete objective" onConfirm={() => void run('entity.delete', { id: objective.id })} />
          </div>
        )}
      </div>
      {editing && <ObjectiveEditor objective={objective} data={data} onClose={() => setEditing(false)} />}
    </div>
  );
}

export function ObjectivesPage() {
  const route = useRoute();
  const gm = useIsGm();
  const me = useMe();
  const campaign = useCampaign();
  const objectives = useType('objective');
  const players = usePlayers();
  const data = useMapData();
  const [adding, setAdding] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const highlight = route.query.get('o');

  const groups = useMemo(() => {
    const visible = objectives.filter((o) => showClosed || o.status === 'active' || o.id === highlight);
    const byScope = new Map<string, Objective[]>();
    for (const o of visible) byScope.set(o.scope, [...(byScope.get(o.scope) ?? []), o]);
    const order = [PARTY, ...(me && !gm ? [me.playerId] : []), ...players.map((p) => p.id)].filter((v, i, a) => a.indexOf(v) === i);
    return order
      .filter((scope) => byScope.has(scope) || scope === PARTY || scope === me?.playerId)
      .map((scope) => ({
        scope,
        title: scope === PARTY ? 'Party objectives' : scope === me?.playerId ? 'Your personal objectives' : `${players.find((p) => p.id === scope)?.name ?? 'Player'}'s personal objectives`,
        items: (byScope.get(scope) ?? []).sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || b.createdAt - a.createdAt),
      }));
  }, [objectives, showClosed, highlight, players, me, gm]);

  const closedCount = objectives.filter((o) => o.status !== 'active').length;
  const anyTargets = objectives.some((o) => o.status === 'active' && o.targets.length > 0);

  const tour = () => {
    setPlanner({ objectives: true, from: useMap.getState().planner.from ?? campaign?.location?.systemId });
    useMap.setState({ panel: 'planner' });
    navigate('/map');
  };

  return (
    <div className="page">
      <div className="page-narrow">
        <div className="page-head">
          <h1>Objectives</h1>
          <div className="grow" />
          {closedCount > 0 && (
            <label className="check small">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
              Show {closedCount} closed
            </label>
          )}
          {anyTargets && (
            <button className="btn" onClick={tour} title="Plan the best order to visit every active objective on the map">
              <Icon name="route" size={13} /> Plan a route
            </button>
          )}
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} /> {gm ? 'New objective' : 'New personal objective'}
          </button>
        </div>
        {objectives.length === 0 && (
          <Empty icon="target" title="No objectives yet">
            {gm ? 'Give the party something to chase, or set a goal for one player that only they can see.' : 'Party objectives from your GM appear here. You can also keep personal objectives that only you and the GM see.'}
          </Empty>
        )}
        <div className="col gap-16">
          {groups.map((g) =>
            g.items.length === 0 && objectives.length === 0 ? null : (
              <section key={g.scope} className="col">
                <h3>{g.title}</h3>
                {g.items.length === 0 ? <div className="faint small">None {showClosed ? '' : 'active'}.</div> : <div className="card-grid">{g.items.map((o) => <ObjectiveCard key={o.id} objective={o} data={data} highlight={o.id === highlight} />)}</div>}
              </section>
            ),
          )}
        </div>
      </div>
      {adding && <ObjectiveEditor data={data} onClose={() => setAdding(false)} />}
    </div>
  );
}
