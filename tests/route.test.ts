import { describe, expect, it } from 'vitest';
import { parseHex, toGlobal } from '../src/shared/hex';
import { DEFAULT_ROUTE_OPTIONS, planRoute, planTour, reachable, type RouteNode, type RouteOptions } from '../src/shared/route';

type Fuel = 'refined' | 'unrefined' | 'gg' | 'water' | 'none' | 'unknown';

function node(id: string, hex: string, fuel: Fuel = 'refined', zone: '' | 'A' | 'R' = ''): RouteNode {
  const h = parseHex(hex)!;
  return {
    id,
    pos: toGlobal(0, 0, h.col, h.row),
    zone,
    fuel: { refined: fuel === 'refined', unrefined: fuel === 'refined' || fuel === 'unrefined', gasGiant: fuel === 'gg', water: fuel === 'water', unknown: fuel === 'unknown' },
  };
}

const opts = (o: Partial<RouteOptions> = {}): RouteOptions => ({ ...DEFAULT_ROUTE_OPTIONS, ...o, refuel: { ...DEFAULT_ROUTE_OPTIONS.refuel, ...(o.refuel ?? {}) } });

describe('route planning', () => {
  // A line of systems one parsec apart down column 01.
  const line = ['0101', '0102', '0103', '0104', '0105', '0106', '0107'].map((hex, i) => node(`s${i}`, hex));

  it('uses the fewest jumps for the ship\'s jump rating', () => {
    expect(planRoute(line, 's0', 's6', opts({ jump: 1, range: 1 }))!.jumps).toBe(6);
    const j2 = planRoute(line, 's0', 's6', opts({ jump: 2, range: 2 }))!;
    expect(j2.jumps).toBe(3);
    expect(j2.parsecs).toBe(6);
    expect(j2.stops).toEqual(['s0', 's2', 's4', 's6']);
    expect(planRoute(line, 's0', 's6', opts({ jump: 3, range: 3 }))!.jumps).toBe(2);
    expect(planRoute(line, 's0', 's0', opts())).toMatchObject({ jumps: 0, stops: ['s0'] });
    expect(planRoute(line, 's0', 'nope', opts())).toBeNull();
  });

  it('cannot cross a gap wider than the jump rating', () => {
    const gap = [node('a', '0101'), node('b', '0105')];
    expect(planRoute(gap, 'a', 'b', opts({ jump: 2, range: 2 }))).toBeNull();
    expect(planRoute(gap, 'a', 'b', opts({ jump: 4, range: 4 }))!.jumps).toBe(1);
  });

  it('will not strand the ship where it cannot refuel', () => {
    // a -1- dry -1- c : a jump-1 ship arrives at "dry" with an empty tank and cannot go on.
    const dry = [node('a', '0101'), node('dry', '0102', 'none'), node('c', '0103')];
    expect(planRoute(dry, 'a', 'c', opts({ jump: 1, range: 1 }))).toBeNull();
    // With fuel for two parsecs it can make two jump-1 hops on one tank.
    const twoHops = planRoute(dry, 'a', 'c', opts({ jump: 1, range: 2 }))!;
    expect(twoHops.stops).toEqual(['a', 'dry', 'c']);
    expect(twoHops.legs[0]).toMatchObject({ refuel: false, fuelAfter: 1 });
    // A jump-2 ship simply goes straight there.
    expect(planRoute(dry, 'a', 'c', opts({ jump: 2, range: 2 }))!.stops).toEqual(['a', 'c']);
  });

  it('respects which fuel sources the crew will use', () => {
    const giants = [node('a', '0101'), node('gg', '0102', 'gg'), node('wet', '0103', 'water'), node('d', '0104')];
    const j1 = { jump: 1, range: 1 };
    expect(planRoute(giants, 'a', 'd', opts(j1))).toBeNull(); // water is off by default
    expect(planRoute(giants, 'a', 'd', opts({ ...j1, refuel: { ...DEFAULT_ROUTE_OPTIONS.refuel, water: true } }))!.jumps).toBe(3);
    expect(planRoute(giants, 'a', 'gg', opts({ ...j1, refuel: { ...DEFAULT_ROUTE_OPTIONS.refuel, gasGiant: false } }))!.legs[0].refuel).toBe(false);
  });

  it('treats unsurveyed systems as risky unless told otherwise', () => {
    const fog = [node('a', '0101'), node('mystery', '0102', 'unknown'), node('c', '0103')];
    const j1 = { jump: 1, range: 1 };
    expect(planRoute(fog, 'a', 'c', opts(j1))).toBeNull();
    expect(planRoute(fog, 'a', 'c', opts({ ...j1, refuel: { ...DEFAULT_ROUTE_OPTIONS.refuel, unknown: true } }))!.jumps).toBe(2);
  });

  it('routes around red zones but still lets you travel to one', () => {
    //  a(0101)  red(0102)  c(0103), with a detour through column 02.
    const map = [node('a', '0101'), node('red', '0102', 'refined', 'R'), node('c', '0103'), node('d1', '0201'), node('d2', '0202')];
    const j1 = { jump: 1, range: 1 };
    expect(planRoute(map, 'a', 'c', opts(j1))!.stops).toEqual(['a', 'd1', 'd2', 'c']);
    expect(planRoute(map, 'a', 'c', opts({ ...j1, avoidRed: false }))!.stops).toEqual(['a', 'red', 'c']);
    expect(planRoute(map, 'a', 'red', opts(j1))!.stops).toEqual(['a', 'red']);
    const amber = map.map((n) => (n.id === 'd1' ? { ...n, zone: 'A' as const } : n));
    expect(planRoute(amber, 'a', 'c', opts({ ...j1, avoidAmber: true }))).toBeNull();
  });

  it('reports how many jumps away everything is', () => {
    const r = reachable(line, 's0', opts({ jump: 2, range: 2 }));
    expect(r.get('s0')).toBe(0);
    expect(r.get('s2')).toBe(1);
    expect(r.get('s3')).toBe(2);
    expect(r.get('s6')).toBe(3);
  });

  it('orders several destinations into the shortest tour', () => {
    const tour = planTour(line, 's3', ['s6', 's0', 's5', 'ghost'], opts({ jump: 1, range: 1 }));
    // Going down first then back up (3+… ) loses to: s5, s6, then all the way to s0? Compare both.
    //   s3→s5→s6→s0 = 2+1+6 = 9 jumps;  s3→s0→s5→s6 = 3+5+1 = 9 jumps;  ties resolve to the first found.
    expect(tour.jumps).toBe(9);
    expect(tour.order).toHaveLength(3);
    expect(tour.unreachable).toEqual(['ghost']);
    expect(tour.hops.reduce((n, h) => n + h.jumps, 0)).toBe(9);
    const simple = planTour(line, 's0', ['s2', 's1'], opts({ jump: 1, range: 1 }));
    expect(simple.order).toEqual(['s1', 's2']);
    expect(simple.jumps).toBe(2);
  });
});
