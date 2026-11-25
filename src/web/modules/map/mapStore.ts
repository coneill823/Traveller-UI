/** UI state for the map: where the view is, what is selected, which tool and overlays are active. */
import { create } from 'zustand';
import type { GlobalHex } from '../../../shared/hex';
import { DEFAULT_ROUTE_OPTIONS, type RouteOptions } from '../../../shared/route';
import type { Id, RouteKind } from '../../../shared/types';

export interface MapView {
  /** World-unit point at the centre of the canvas. */
  cx: number;
  cy: number;
  /** Pixels per world unit (one hex column). */
  scale: number;
}

export type MapTool = 'select' | 'add' | 'route' | 'reveal';
export type SidePanel = 'info' | 'planner' | 'none';

export interface Layers {
  grid: boolean;
  names: boolean;
  routes: boolean;
  regions: boolean;
  /** GM only: mark systems the party does not (fully) know. */
  knowledge: boolean;
  objectives: boolean;
}

export type FitTarget = { kind: 'all' } | { kind: 'sector'; id: Id } | { kind: 'subsector'; id: Id; letter: string } | { kind: 'system'; id: Id };

interface MapState {
  view: MapView | null;
  selected?: Id;
  selectedHex?: GlobalHex;
  /** Extra systems selected with shift-click, for bulk actions. */
  multi: Id[];
  tool: MapTool;
  routeKind: RouteKind;
  /** First system clicked with the route tool. */
  routeFrom?: Id;
  revealPreset: 'hidden' | 'detected' | 'charted';
  layers: Layers;
  /** Shade hexes within this many parsecs of the selected system (0 = off). */
  jumpRange: number;
  panel: SidePanel;
  planner: {
    from?: Id;
    to?: Id;
    /** Which end the next map click sets. */
    picking?: 'from' | 'to';
    options: RouteOptions;
    /** Show routes to objectives instead of a single destination. */
    objectives: boolean;
  };
  /** Bumped to ask the canvas to move the view. */
  fit?: { target: FitTarget; nonce: number };
}

export const useMap = create<MapState>(() => ({
  view: null,
  multi: [],
  tool: 'select',
  routeKind: 'comm',
  revealPreset: 'charted',
  layers: { grid: true, names: true, routes: true, regions: true, knowledge: true, objectives: true },
  jumpRange: 0,
  panel: 'info',
  planner: { options: DEFAULT_ROUTE_OPTIONS, objectives: false },
}));

let nonce = 1;

export function fitTo(target: FitTarget): void {
  useMap.setState({ fit: { target, nonce: nonce++ } });
}

export function selectSystem(id: Id | undefined, hex?: GlobalHex): void {
  useMap.setState({ selected: id, selectedHex: hex, multi: [] });
}

export function setPlanner(patch: Partial<MapState['planner']>): void {
  useMap.setState((s) => ({ planner: { ...s.planner, ...patch } }));
}

export function setPlannerOptions(patch: Partial<RouteOptions>): void {
  useMap.setState((s) => ({ planner: { ...s.planner, options: { ...s.planner.options, ...patch } } }));
}

/**
 * Level-of-detail thresholds, in pixels per hex column. On a typical screen a whole sector fits
 * at about 17 and a whole subsector at about 70, so the bands sit between those.
 */
export const LOD = {
  /** Below this the map shows whole sectors; clicking drills into a sector. */
  sector: 9,
  /** From here the hex grid is drawn. */
  grid: 12,
  /** Below this it shows subsectors; clicking drills into a subsector. From here hexes can be picked. */
  subsector: 24,
  /** From here names are drawn. */
  names: 24,
  /** From here each hex shows its full classic contents. */
  detail: 30,
  /** From here the world profile is printed in the hex. */
  profile: 62,
  min: 0.5,
  max: 150,
};
