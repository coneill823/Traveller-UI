/**
 * The hull diagram colours parts by what they are for, in three zones. Three hues are as many as
 * stay distinguishable when any block can end up beside any other (checked for colour-blind
 * viewers too), so a part's identity is always carried by its label, tooltip and manifest row as well.
 */
import type { PartLine } from '../../../shared/rules/ship';

export type ZoneId = 'eng' | 'crew' | 'mission' | 'other';

export const ZONES: { id: ZoneId; label: string; hint: string; color: string }[] = [
  { id: 'eng', label: 'Engineering', hint: 'Drives, power plant and fuel', color: '#e76624' },
  { id: 'crew', label: 'Crew and command', hint: 'Bridge, electronics and quarters', color: '#338ced' },
  { id: 'mission', label: 'Mission systems', hint: 'Weapons, craft, drones and fittings', color: '#00a888' },
  { id: 'other', label: 'Structure and other', hint: 'Armour and custom parts', color: '#74849a' },
];

const GROUP_ZONE: Record<string, ZoneId> = {
  drives: 'eng',
  power: 'eng',
  fuel: 'eng',
  command: 'crew',
  quarters: 'crew',
  software: 'crew',
  weapons: 'mission',
  craft: 'mission',
  drones: 'mission',
  cargo: 'mission',
  systems: 'mission',
  hull: 'other',
  custom: 'other',
};

export function zoneOf(line: Pick<PartLine, 'group'>): ZoneId {
  return GROUP_ZONE[line.group] ?? 'other';
}

export function zoneColor(id: ZoneId): string {
  return ZONES.find((z) => z.id === id)!.color;
}

export function shortLabel(line: PartLine): string {
  switch (line.kind) {
    case 'mdrive':
      return 'M-drive';
    case 'jdrive':
      return 'J-drive';
    case 'plant':
      return 'Power';
    case 'fuel':
      return 'Fuel';
    case 'armour':
      return 'Armour';
    default:
      return line.label.replace(/ x\d+$/, '');
  }
}
