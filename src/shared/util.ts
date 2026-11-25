import { ID_PREFIX, type EntityType, type Id } from './types';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random id, e.g. "sys_k3f9x02mab". Uses crypto when available. */
export function newId(type: EntityType | string): Id {
  const prefix = (ID_PREFIX as Record<string, string>)[type] ?? type;
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${s}`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Stable, order-independent stringify so equal objects produce equal strings. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Small non-cryptographic string hash (FNV-1a), hex encoded. */
export function hashString(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Deterministic pseudo-random generator (mulberry32) so generation can be seeded and replayed. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

/** Roll `count` six-sided dice. */
export function rollDice(count: number, rng: Rng = Math.random): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(1 + Math.floor(rng() * 6));
  return out;
}

export function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function groupBy<T>(values: T[], key: (v: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const v of values) (out[key(v)] ??= []).push(v);
  return out;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Formats credits the Traveller way: Cr1,500, KCr25, MCr1.2. */
export function formatCredits(cr: number): string {
  const abs = Math.abs(cr);
  if (abs >= 1_000_000) return `MCr${trimNumber(cr / 1_000_000)}`;
  return `Cr${Math.round(cr).toLocaleString('en-GB')}`;
}

function trimNumber(n: number): string {
  return (Math.round(n * 1000) / 1000).toLocaleString('en-GB', { maximumFractionDigits: 3 });
}
