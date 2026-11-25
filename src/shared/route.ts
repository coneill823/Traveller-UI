/**
 * Jump route planning over the systems a viewer knows about.
 *
 * A ship can jump up to its jump rating in parsecs, and carries fuel for `range` parsecs in
 * total. It refuels wherever the chosen fuel sources are available; anywhere else it must still
 * have fuel in the tank to jump onward. The planner minimises the number of jumps (each is about
 * a week), then the total distance.
 */
import { globalKey, hexDistance, hexesWithin, type GlobalHex } from './hex';
import type { Id } from './types';

export interface RouteNode {
  id: Id;
  pos: GlobalHex;
  /** Fuel available here. `unknown` is true when the viewer has no survey data for the system. */
  fuel: { refined: boolean; unrefined: boolean; gasGiant: boolean; water: boolean; unknown: boolean };
  zone: '' | 'A' | 'R';
}

export interface RouteOptions {
  /** Jump rating: maximum parsecs per jump. */
  jump: number;
  /** Parsecs of jump fuel carried when full. Usually equal to `jump`. */
  range: number;
  /** Which fuel sources the crew is willing and able to use. */
  refuel: { refined: boolean; unrefined: boolean; gasGiant: boolean; water: boolean; unknown: boolean };
  avoidRed: boolean;
  avoidAmber: boolean;
}

export const DEFAULT_ROUTE_OPTIONS: RouteOptions = {
  jump: 2,
  range: 2,
  refuel: { refined: true, unrefined: true, gasGiant: true, water: false, unknown: false },
  avoidRed: true,
  avoidAmber: false,
};

export interface RouteLeg {
  from: Id;
  to: Id;
  parsecs: number;
  /** Whether the ship can refuel on arrival with the chosen fuel sources. */
  refuel: boolean;
  /** Fuel (in parsecs) left in the tank on arrival, after refuelling if possible. */
  fuelAfter: number;
}

export interface RoutePlan {
  legs: RouteLeg[];
  jumps: number;
  parsecs: number;
  /** Systems visited in order, including the start. */
  stops: Id[];
}

export function canRefuel(node: RouteNode, opts: RouteOptions): boolean {
  const f = node.fuel;
  const r = opts.refuel;
  return (r.refined && f.refined) || (r.unrefined && f.unrefined) || (r.gasGiant && f.gasGiant) || (r.water && f.water) || (r.unknown && f.unknown);
}

/** Describes the best fuel available at a node, for display. */
export function fuelLabel(node: RouteNode): string {
  if (node.fuel.unknown) return 'Unknown';
  const parts: string[] = [];
  if (node.fuel.refined) parts.push('Refined');
  else if (node.fuel.unrefined) parts.push('Unrefined');
  if (node.fuel.gasGiant) parts.push('Gas giant');
  if (node.fuel.water) parts.push('Water');
  return parts.length ? parts.join(', ') : 'None';
}

class Grid {
  private cells = new Map<string, RouteNode>();
  constructor(nodes: RouteNode[]) {
    for (const n of nodes) this.cells.set(globalKey(n.pos.gx, n.pos.gy), n);
  }
  near(pos: GlobalHex, radius: number): RouteNode[] {
    const out: RouteNode[] = [];
    for (const h of hexesWithin(pos.gx, pos.gy, radius)) {
      const n = this.cells.get(globalKey(h.gx, h.gy));
      if (n) out.push(n);
    }
    return out;
  }
}

/** Minimal binary heap keyed on a numeric priority. */
class Heap<T> {
  private items: { p: number; v: T }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(p: number, v: T): void {
    const a = this.items;
    a.push({ p, v });
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent].p <= a[i].p) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0].v;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].p < a[m].p) m = l;
        if (r < a.length && a[r].p < a[m].p) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

interface SearchState {
  id: Id;
  fuel: number;
}

function blocked(node: RouteNode, opts: RouteOptions): boolean {
  return (opts.avoidRed && node.zone === 'R') || (opts.avoidAmber && node.zone === 'A');
}

function search(nodes: RouteNode[], from: Id, opts: RouteOptions, to?: Id): { cost: Map<string, number>; prev: Map<string, string>; goal?: string } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const grid = new Grid(nodes);
  const range = Math.max(opts.range, opts.jump);
  const key = (s: SearchState) => `${s.id}|${s.fuel}`;
  const cost = new Map<string, number>();
  const prev = new Map<string, string>();
  const heap = new Heap<SearchState>();
  const start: SearchState = { id: from, fuel: range };
  if (!byId.has(from)) return { cost, prev };
  cost.set(key(start), 0);
  heap.push(0, start);
  while (heap.size) {
    const cur = heap.pop()!;
    const curKey = key(cur);
    const curCost = cost.get(curKey)!;
    if (to && cur.id === to) return { cost, prev, goal: curKey };
    const node = byId.get(cur.id)!;
    for (const next of grid.near(node.pos, Math.min(opts.jump, cur.fuel))) {
      if (next.id === cur.id) continue;
      // The destination itself may be in a restricted zone; only waypoints are avoided.
      if (blocked(next, opts) && next.id !== to) continue;
      const d = hexDistance(node.pos, next.pos);
      const fuel = canRefuel(next, opts) ? range : cur.fuel - d;
      const state: SearchState = { id: next.id, fuel };
      // One jump costs 1000, one parsec 1: fewest jumps first, then shortest.
      const c = curCost + 1000 + d;
      const k = key(state);
      if (c < (cost.get(k) ?? Infinity)) {
        cost.set(k, c);
        prev.set(k, curKey);
        heap.push(c, state);
      }
    }
  }
  return { cost, prev };
}

/** Best route between two systems, or null when none exists with these options. */
export function planRoute(nodes: RouteNode[], from: Id, to: Id, opts: RouteOptions): RoutePlan | null {
  if (from === to) return { legs: [], jumps: 0, parsecs: 0, stops: [from] };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(from) || !byId.has(to)) return null;
  const { prev, goal } = search(nodes, from, opts, to);
  if (!goal) return null;
  const chain: string[] = [goal];
  while (prev.has(chain[0])) chain.unshift(prev.get(chain[0])!);
  const legs: RouteLeg[] = [];
  let parsecs = 0;
  for (let i = 1; i < chain.length; i++) {
    const [a] = chain[i - 1].split('|');
    const [b, fuel] = chain[i].split('|');
    const d = hexDistance(byId.get(a)!.pos, byId.get(b)!.pos);
    parsecs += d;
    legs.push({ from: a, to: b, parsecs: d, refuel: canRefuel(byId.get(b)!, opts), fuelAfter: Number(fuel) });
  }
  return { legs, jumps: legs.length, parsecs, stops: [from, ...legs.map((l) => l.to)] };
}

/** Number of jumps needed to reach every reachable system from `from`. */
export function reachable(nodes: RouteNode[], from: Id, opts: RouteOptions): Map<Id, number> {
  const { cost } = search(nodes, from, opts);
  const out = new Map<Id, number>();
  for (const [k, c] of cost) {
    const id = k.split('|')[0];
    const jumps = Math.floor(c / 1000);
    if (jumps < (out.get(id) ?? Infinity)) out.set(id, jumps);
  }
  return out;
}

export interface TourPlan {
  /** Targets in the order they should be visited. */
  order: Id[];
  /** One plan per hop: start → first target → … */
  hops: RoutePlan[];
  jumps: number;
  parsecs: number;
  /** Targets that cannot be reached with these options. */
  unreachable: Id[];
}

/**
 * Best order in which to visit several targets from a starting system. Exact for up to eight
 * targets; beyond that it visits the nearest remaining target each time.
 */
export function planTour(nodes: RouteNode[], from: Id, targets: Id[], opts: RouteOptions): TourPlan {
  const unique = [...new Set(targets)].filter((t) => t !== from);
  const points = [from, ...unique];
  const plans = new Map<string, RoutePlan | null>();
  const hop = (a: Id, b: Id) => {
    const k = `${a}>${b}`;
    if (!plans.has(k)) plans.set(k, planRoute(nodes, a, b, opts));
    return plans.get(k)!;
  };
  const reachableTargets = unique.filter((t) => hop(from, t) !== null);
  const unreachable = unique.filter((t) => !reachableTargets.includes(t));
  const weight = (p: RoutePlan | null) => (p ? p.jumps * 1000 + p.parsecs : Infinity);

  let best: Id[] = [];
  let bestCost = Infinity;
  if (reachableTargets.length <= 8) {
    const permute = (rest: Id[], acc: Id[], at: Id, cost: number) => {
      if (cost >= bestCost) return;
      if (rest.length === 0) {
        best = acc;
        bestCost = cost;
        return;
      }
      for (const t of rest) permute(rest.filter((x) => x !== t), [...acc, t], t, cost + weight(hop(at, t)));
    };
    permute(reachableTargets, [], from, 0);
  } else {
    const rest = new Set(reachableTargets);
    let at = from;
    while (rest.size) {
      let pick: Id | undefined;
      let pickCost = Infinity;
      for (const t of rest) {
        const c = weight(hop(at, t));
        if (c < pickCost) {
          pickCost = c;
          pick = t;
        }
      }
      if (!pick) break;
      best.push(pick);
      rest.delete(pick);
      at = pick;
    }
  }
  void points;

  const hops: RoutePlan[] = [];
  let at = from;
  for (const t of best) {
    const p = hop(at, t);
    if (!p) break;
    hops.push(p);
    at = t;
  }
  return {
    order: best,
    hops,
    jumps: hops.reduce((n, p) => n + p.jumps, 0),
    parsecs: hops.reduce((n, p) => n + p.parsecs, 0),
    unreachable,
  };
}
