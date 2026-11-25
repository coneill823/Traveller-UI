/**
 * Universal World Profile parsing. This file only knows the *shape* of a profile
 * (starport + seven extended-hex digits); what each value means comes from the rules pack.
 */

/** Extended hex: 0-9, then A-Z skipping I and O. */
export const EHEX = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function ehexValue(ch: string | undefined): number {
  if (!ch) return -1;
  return EHEX.indexOf(ch.toUpperCase());
}

export function ehexChar(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  return EHEX[Math.min(Math.floor(n), EHEX.length - 1)];
}

export interface Uwp {
  starport: string;
  size: number;
  atm: number;
  hydro: number;
  pop: number;
  gov: number;
  law: number;
  tl: number;
}

/** Matches a UWP anywhere in a line, e.g. "CA6A643-9". '?' stands for an unknown digit. */
export const UWP_PATTERN = /[A-HXY?][0-9A-HJ-NP-Z?]{6}-[0-9A-HJ-NP-Z?]/;
const UWP_EXACT = /^([A-HXY?])([0-9A-HJ-NP-Z?])([0-9A-HJ-NP-Z?])([0-9A-HJ-NP-Z?])([0-9A-HJ-NP-Z?])([0-9A-HJ-NP-Z?])([0-9A-HJ-NP-Z?])-([0-9A-HJ-NP-Z?])$/;

export function parseUwp(text: string | undefined | null): Uwp | null {
  if (!text) return null;
  const m = UWP_EXACT.exec(text.trim().toUpperCase());
  if (!m) return null;
  return {
    starport: m[1],
    size: ehexValue(m[2]),
    atm: ehexValue(m[3]),
    hydro: ehexValue(m[4]),
    pop: ehexValue(m[5]),
    gov: ehexValue(m[6]),
    law: ehexValue(m[7]),
    tl: ehexValue(m[8]),
  };
}

export function formatUwp(u: Uwp): string {
  const d = (n: number) => (n < 0 ? '?' : ehexChar(n));
  return `${u.starport}${d(u.size)}${d(u.atm)}${d(u.hydro)}${d(u.pop)}${d(u.gov)}${d(u.law)}-${d(u.tl)}`;
}

export function isValidUwp(text: string | undefined | null): boolean {
  return parseUwp(text) !== null;
}

/** Population multiplier / belts / gas giants digits, e.g. "703". */
export interface Pbg {
  popMultiplier: number;
  belts: number;
  gasGiants: number;
}

export function parsePbg(text: string | undefined | null): Pbg | null {
  if (!text) return null;
  const m = /^([0-9A-Z])([0-9A-Z])([0-9A-Z])$/.exec(text.trim().toUpperCase());
  if (!m) return null;
  return { popMultiplier: ehexValue(m[1]), belts: ehexValue(m[2]), gasGiants: ehexValue(m[3]) };
}

export function formatPbg(p: Pbg): string {
  return `${ehexChar(p.popMultiplier)}${ehexChar(p.belts)}${ehexChar(p.gasGiants)}`;
}
