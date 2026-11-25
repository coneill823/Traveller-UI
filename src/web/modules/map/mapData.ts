/** Derived, memoised map data: positions, parsed profiles and lookups built from the entity store. */
import { useMemo } from 'react';
import { globalKey, hexCenter, parseHex, toGlobal, type GlobalHex } from '../../../shared/hex';
import { presetFor } from '../../../shared/knowledge';
import type { WorldRules } from '../../../shared/rulepack';
import type { RouteNode } from '../../../shared/route';
import { fuelSources, systemTradeCodes, type FuelSources } from '../../../shared/rules/world';
import { PARTY, type Id, type Region, type RouteLine, type Sector, type StarSystem } from '../../../shared/types';
import { parsePbg, parseUwp, type Uwp } from '../../../shared/uwp';
import { useRules, useType } from '../../store';

export interface SysInfo {
  sys: StarSystem;
  sector: Sector;
  gx: number;
  gy: number;
  /** World-unit centre of the hex. */
  x: number;
  y: number;
  uwp: Uwp | null;
  codes: string[];
  fuel: FuelSources;
  gasGiants: number;
  belts: number;
  /** What the party knows (meaningful to the GM only): hidden / detected / charted / custom. */
  party: string;
  /** Whether the viewer has survey data for this system. */
  surveyed: boolean;
  color: string;
  glyph: 'world' | 'belt' | 'unknown';
  highPop: boolean;
}

export interface RouteInfo {
  route: RouteLine;
  a: SysInfo;
  b: SysInfo;
}

export interface MapData {
  sectors: Sector[];
  sectorAt: Map<string, Sector>;
  systems: SysInfo[];
  byId: Map<Id, SysInfo>;
  byHex: Map<string, SysInfo>;
  routes: RouteInfo[];
  regions: Region[];
  rules: WorldRules | undefined;
}

export const WORLD_COLORS = {
  water: '#5aa9ff',
  desert: '#d9a25c',
  vacuum: '#a9b6c4',
  exotic: '#b38cff',
  unknown: '#7f93a8',
};

function worldColor(u: Uwp | null): { color: string; glyph: SysInfo['glyph'] } {
  if (!u) return { color: WORLD_COLORS.unknown, glyph: 'unknown' };
  if (u.size === 0) return { color: WORLD_COLORS.vacuum, glyph: 'belt' };
  if (u.atm >= 10 && u.atm <= 12) return { color: WORLD_COLORS.exotic, glyph: 'world' };
  if (u.hydro >= 1 && u.atm >= 2) return { color: WORLD_COLORS.water, glyph: 'world' };
  if (u.atm <= 1) return { color: WORLD_COLORS.vacuum, glyph: 'world' };
  return { color: WORLD_COLORS.desert, glyph: 'world' };
}

export function useMapData(): MapData {
  const sectors = useType('sector');
  const systems = useType('system');
  const routes = useType('route');
  const regions = useType('region');
  const rules = useRules().world;

  return useMemo(() => {
    const sectorById = new Map(sectors.map((s) => [s.id, s]));
    const sectorAt = new Map(sectors.map((s) => [`${s.x},${s.y}`, s]));
    const infos: SysInfo[] = [];
    const byId = new Map<Id, SysInfo>();
    const byHex = new Map<string, SysInfo>();
    for (const sys of systems) {
      const sector = sectorById.get(sys.sectorId);
      const h = parseHex(sys.hex);
      if (!sector || !h) continue;
      const { gx, gy } = toGlobal(sector.x, sector.y, h.col, h.row);
      const c = hexCenter(gx, gy);
      const uwp = parseUwp(sys.uwp);
      const pbg = parsePbg(sys.pbg);
      const look = worldColor(uwp);
      const info: SysInfo = {
        sys,
        sector,
        gx,
        gy,
        x: c.x,
        y: c.y,
        uwp,
        codes: systemTradeCodes(sys.uwp, sys.remarks, rules),
        fuel: fuelSources(sys.uwp, sys.pbg, rules),
        gasGiants: pbg?.gasGiants ?? 0,
        belts: pbg?.belts ?? 0,
        party: presetFor(sys.known, PARTY),
        surveyed: sys.uwp !== undefined,
        color: look.color,
        glyph: look.glyph,
        highPop: !!uwp && uwp.pop >= 9,
      };
      infos.push(info);
      byId.set(sys.id, info);
      byHex.set(globalKey(gx, gy), info);
    }
    const routeInfos: RouteInfo[] = [];
    for (const route of routes) {
      const a = byId.get(route.a);
      const b = byId.get(route.b);
      if (a && b) routeInfos.push({ route, a, b });
    }
    return { sectors, sectorAt, systems: infos, byId, byHex, routes: routeInfos, regions, rules };
  }, [sectors, systems, routes, regions, rules]);
}

/** Converts map data into the nodes the route planner works on. */
export function routeNodes(data: MapData): RouteNode[] {
  return data.systems.map((s) => ({
    id: s.sys.id,
    pos: { gx: s.gx, gy: s.gy } as GlobalHex,
    zone: s.sys.zone ?? '',
    fuel: { refined: s.fuel.refined, unrefined: s.fuel.unrefined, gasGiant: s.fuel.gasGiant, water: s.fuel.water, unknown: !s.surveyed },
  }));
}

/** "Kestrel Reach 0103" */
export function systemLocation(info: SysInfo): string {
  return `${info.sector.name} ${info.sys.hex}`;
}

export function systemLabel(info: SysInfo | undefined): string {
  if (!info) return 'Unknown';
  return info.sys.name ?? `Unidentified system (${info.sys.hex})`;
}
