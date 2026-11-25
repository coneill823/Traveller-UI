/** Route planning panel: jump routes between known systems, and tours of objective locations. */
import { useMemo } from 'react';
import { canRefuel, fuelLabel, planRoute, planTour, type RouteNode, type RoutePlan, type TourPlan } from '../../../shared/route';
import { PARTY, type Id, type Objective } from '../../../shared/types';
import { useCampaign, useMe, useType } from '../../store';
import { cx, Empty, Field } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { routeNodes, systemLabel, type MapData } from './mapData';
import { fitTo, selectSystem, setPlanner, setPlannerOptions, useMap } from './mapStore';

export interface PlannerResult {
  nodes: Map<Id, RouteNode>;
  /** Single route from → to. */
  plan: RoutePlan | null;
  /** Tour of objective locations. */
  tour: TourPlan | null;
  /** Objectives included in the tour, by target system. */
  objectivesBySystem: Map<Id, Objective[]>;
  /** Lines for the map overlay. */
  lines: { stops: Id[]; color: string }[];
}

/** Active objectives visible to this viewer that point at a place on the map. */
export function useObjectiveTargets(): Map<Id, Objective[]> {
  const objectives = useType('objective');
  return useMemo(() => {
    const out = new Map<Id, Objective[]>();
    for (const o of objectives) {
      if (o.status !== 'active') continue;
      for (const t of o.targets) out.set(t.systemId, [...(out.get(t.systemId) ?? []), o]);
    }
    return out;
  }, [objectives]);
}

export function usePlanner(data: MapData): PlannerResult {
  const planner = useMap((s) => s.planner);
  const panel = useMap((s) => s.panel);
  const objectivesBySystem = useObjectiveTargets();
  return useMemo(() => {
    const list = routeNodes(data);
    const nodes = new Map(list.map((n) => [n.id, n]));
    let plan: RoutePlan | null = null;
    let tour: TourPlan | null = null;
    const lines: { stops: Id[]; color: string }[] = [];
    if (panel === 'planner' && planner.from) {
      if (planner.objectives) {
        const targets = [...objectivesBySystem.keys()].filter((id) => nodes.has(id));
        tour = planTour(list, planner.from, targets, planner.options);
        tour.hops.forEach((hop, i) => lines.push({ stops: hop.stops, color: i % 2 === 0 ? '#ffb347' : '#ffd08a' }));
      } else if (planner.to) {
        plan = planRoute(list, planner.from, planner.to, planner.options);
        if (plan && plan.stops.length > 1) lines.push({ stops: plan.stops, color: '#4de3ff' });
      }
    }
    return { nodes, plan, tour, objectivesBySystem, lines };
  }, [data, planner, panel, objectivesBySystem]);
}

function Endpoint({ label, id, which, data }: { label: string; id: Id | undefined; which: 'from' | 'to'; data: MapData }) {
  const picking = useMap((s) => s.planner.picking);
  const campaign = useCampaign();
  const info = id ? data.byId.get(id) : undefined;
  return (
    <Field label={label}>
      <div className="row">
        <button className={cx('endpoint grow', picking === which && 'picking')} onClick={() => info && fitTo({ kind: 'system', id: info.sys.id })} title={info ? 'Show on the map' : undefined}>
          {picking === which ? 'Click a system on the map…' : info ? systemLabel(info) : <span className="faint">Not set</span>}
          {info && <span className="mono tiny faint">{info.sys.hex}</span>}
        </button>
        <button className={cx('btn icon', picking === which && 'on')} title="Pick on the map" onClick={() => setPlanner({ picking: picking === which ? undefined : which })}>
          <Icon name="crosshair" size={14} />
        </button>
        {which === 'from' && campaign?.location?.systemId && (
          <button className="btn icon" title="Use the party's location" onClick={() => setPlanner({ from: campaign.location!.systemId, picking: undefined })}>
            <Icon name="pin" size={14} />
          </button>
        )}
      </div>
    </Field>
  );
}

function Legs({ plan, data, nodes, first = 1 }: { plan: RoutePlan; data: MapData; nodes: Map<Id, RouteNode>; first?: number }) {
  const options = useMap((s) => s.planner.options);
  return (
    <ol className="legs">
      {plan.legs.map((leg, i) => {
        const to = data.byId.get(leg.to);
        const node = nodes.get(leg.to);
        const last = i === plan.legs.length - 1;
        const refuel = node ? canRefuel(node, options) : false;
        return (
          <li key={i} className="leg">
            <span className="leg-n">{first + i}</span>
            <button className="leg-main" onClick={() => to && selectSystem(to.sys.id, { gx: to.gx, gy: to.gy })}>
              <strong>{systemLabel(to)}</strong>
              <span className="mono tiny faint">{to?.sys.hex}</span>
              {to?.sys.zone === 'A' && <span className="chip warn">Amber</span>}
              {to?.sys.zone === 'R' && <span className="chip danger">Red</span>}
            </button>
            <span className="leg-meta">
              <span className="mono">J-{leg.parsecs}</span>
              {node && (
                <span className={cx('tiny', refuel ? 'fuel-ok' : last ? 'faint' : 'fuel-none')} title={`Fuel here: ${fuelLabel(node)}`}>
                  <Icon name="fuel" size={11} /> {refuel ? fuelLabel(node) : last ? fuelLabel(node) : `no refuel · ${leg.fuelAfter} pc left`}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Summary({ jumps, parsecs }: { jumps: number; parsecs: number }) {
  return (
    <div className="route-summary">
      <div>
        <span className="big">{jumps}</span> jump{jumps === 1 ? '' : 's'}
      </div>
      <div>
        <span className="big">{parsecs}</span> parsecs
      </div>
      <div title="Each jump takes about a week, not counting time in port">
        ≈ <span className="big">{jumps}</span> week{jumps === 1 ? '' : 's'}
      </div>
    </div>
  );
}

export function RoutePlanner({ data, result }: { data: MapData; result: PlannerResult }) {
  const planner = useMap((s) => s.planner);
  const me = useMe();
  const players = useType('player');
  const o = planner.options;
  const hasObjectives = result.objectivesBySystem.size > 0;

  const scopeLabel = (obj: Objective) => (obj.scope === PARTY ? 'Party' : obj.scope === me?.playerId ? 'Yours' : (players.find((p) => p.id === obj.scope)?.name ?? 'Personal'));

  return (
    <div className="side-scroll">
      <div className="section col gap-12">
        <div className="segmented" style={{ display: 'flex' }}>
          <button className={cx(!planner.objectives && 'on')} style={{ flex: 1 }} onClick={() => setPlanner({ objectives: false })}>
            A to B
          </button>
          <button className={cx(planner.objectives && 'on')} style={{ flex: 1 }} onClick={() => setPlanner({ objectives: true })} title="Best order to visit every active objective you can see">
            Objectives tour
          </button>
        </div>
        <Endpoint label="From" id={planner.from} which="from" data={data} />
        {!planner.objectives && <Endpoint label="To" id={planner.to} which="to" data={data} />}
      </div>

      <div className="section col gap-12">
        <h3>Ship</h3>
        <div className="grid-2">
          <Field label="Jump rating">
            <select className="select" value={o.jump} onChange={(e) => setPlannerOptions({ jump: Number(e.target.value), range: Math.max(Number(e.target.value), o.range === o.jump ? Number(e.target.value) : o.range) })}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  Jump-{n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Fuel carried" hint="Parsecs of jumping on a full tank">
            <select className="select" value={o.range} onChange={(e) => setPlannerOptions({ range: Number(e.target.value) })}>
              {Array.from({ length: 12 - o.jump + 1 }, (_, i) => o.jump + i).map((n) => (
                <option key={n} value={n}>
                  {n} pc{n === o.jump ? ' · one full jump' : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="col gap-4">
          <span className="label">Refuel at</span>
          {(
            [
              ['refined', 'Starports with refined fuel'],
              ['unrefined', 'Starports with unrefined fuel'],
              ['gasGiant', 'Gas giants (skimming)'],
              ['water', 'Worlds with water'],
              ['unknown', 'Unsurveyed systems (a gamble)'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="check small">
              <input type="checkbox" checked={o.refuel[key]} onChange={(e) => setPlannerOptions({ refuel: { ...o.refuel, [key]: e.target.checked } })} />
              {label}
            </label>
          ))}
        </div>
        <div className="row wrap">
          <span className="label">Avoid</span>
          <label className="check small">
            <input type="checkbox" checked={o.avoidRed} onChange={(e) => setPlannerOptions({ avoidRed: e.target.checked })} />
            Red zones
          </label>
          <label className="check small">
            <input type="checkbox" checked={o.avoidAmber} onChange={(e) => setPlannerOptions({ avoidAmber: e.target.checked })} />
            Amber zones
          </label>
        </div>
      </div>

      <div className="section">
        <h3>{planner.objectives ? 'Tour' : 'Route'}</h3>
        {!planner.from ? (
          <Empty icon="route" title="Choose a starting system">
            Use the crosshair to pick one on the map.
          </Empty>
        ) : planner.objectives ? (
          !hasObjectives ? (
            <Empty icon="target" title="No objectives on the map">
              Objectives with a location will be routed here.
            </Empty>
          ) : result.tour && result.tour.order.length > 0 ? (
            <div className="col">
              <Summary jumps={result.tour.jumps} parsecs={result.tour.parsecs} />
              {result.tour.hops.map((hop, i) => {
                const target = result.tour!.order[i];
                const before = result.tour!.hops.slice(0, i).reduce((n, h) => n + h.jumps, 0);
                return (
                  <div key={target} className="tour-stop">
                    <div className="tour-goal">
                      <Icon name="target" size={13} />
                      <div className="grow">
                        {(result.objectivesBySystem.get(target) ?? []).map((obj) => (
                          <div key={obj.id}>
                            {obj.title} <span className="tiny faint">· {scopeLabel(obj)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {hop.legs.length > 0 ? <Legs plan={hop} data={data} nodes={result.nodes} first={before + 1} /> : <div className="tiny faint">Already here.</div>}
                  </div>
                );
              })}
              {result.tour.unreachable.length > 0 && (
                <div className="notice warn">
                  <Icon name="warning" size={14} />
                  <div>
                    No route with these settings to: {result.tour.unreachable.map((id) => systemLabel(data.byId.get(id))).join(', ')}.
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="notice warn">
              <Icon name="warning" size={14} /> None of the objective locations can be reached with these settings.
            </div>
          )
        ) : !planner.to ? (
          <Empty icon="route" title="Choose a destination">
            Pick one on the map, or use “Route here” on a system.
          </Empty>
        ) : result.plan ? (
          result.plan.legs.length === 0 ? (
            <div className="faint small">You are already there.</div>
          ) : (
            <div className="col">
              <Summary jumps={result.plan.jumps} parsecs={result.plan.parsecs} />
              <Legs plan={result.plan} data={data} nodes={result.nodes} />
            </div>
          )
        ) : (
          <div className="notice warn">
            <Icon name="warning" size={14} />
            <div>No route with these settings. Try a higher jump rating, more fuel, or allowing more places to refuel. Routes only use systems you know about.</div>
          </div>
        )}
      </div>
    </div>
  );
}
