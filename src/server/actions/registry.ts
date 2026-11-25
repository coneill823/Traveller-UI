/**
 * Actions are the only way clients change the campaign. Each one checks who is asking, validates
 * its input and edits state inside a transaction; the hub then fans the result out to viewers.
 */
import type { Viewer } from '../../shared/knowledge';
import type { Id } from '../../shared/types';
import type { Auth } from '../auth';
import type { Config } from '../config';
import type { RulesService } from '../rules';
import { ActionError, type State, type Tx } from '../state';

export interface Emitter {
  /** Sends an ephemeral event to connected viewers (optionally only those matching `to`). */
  emit(ev: string, d: unknown, to?: (v: Viewer) => boolean): void;
}

export interface Services {
  state: State;
  auth: Auth;
  config: Config;
  rules: RulesService;
  events: Emitter;
  /** Optional services registered by later modules (wiki sync, etc.). */
  extra: Record<string, unknown>;
}

export interface ActionCtx {
  tx: Tx;
  /** The real identity of the caller (never the GM's "view as" preview identity). */
  me: Viewer;
  services: Services;
  /** Queue an event to send once the transaction has committed. */
  emit(ev: string, d: unknown, to?: (v: Viewer) => boolean): void;
  /** Queue work to run after the transaction has committed (I/O, follow-up sync). */
  after(fn: () => void | Promise<void>): void;
}

export interface AsyncActionCtx {
  me: Viewer;
  services: Services;
  state: State;
}

export type Handler = (ctx: ActionCtx, p: any) => unknown;
export type AsyncHandler = (ctx: AsyncActionCtx, p: any) => Promise<unknown>;

const handlers = new Map<string, { kind: 'sync'; fn: Handler } | { kind: 'async'; fn: AsyncHandler }>();

export function action(name: string, fn: Handler): void {
  if (handlers.has(name)) throw new Error(`Duplicate action "${name}"`);
  handlers.set(name, { kind: 'sync', fn });
}

export function asyncAction(name: string, fn: AsyncHandler): void {
  if (handlers.has(name)) throw new Error(`Duplicate action "${name}"`);
  handlers.set(name, { kind: 'async', fn });
}

export function actionNames(): string[] {
  return [...handlers.keys()].sort();
}

export async function runAction(services: Services, me: Viewer, name: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(name);
  if (!handler) throw new ActionError(`Unknown action "${name}"`);
  const p = payload ?? {};
  if (handler.kind === 'async') return handler.fn({ me, services, state: services.state }, p);

  const events: { ev: string; d: unknown; to?: (v: Viewer) => boolean }[] = [];
  const afterwards: (() => void | Promise<void>)[] = [];
  const result = services.state.transact((tx) =>
    handler.fn(
      {
        tx,
        me,
        services,
        emit: (ev, d, to) => events.push({ ev, d, to }),
        after: (fn) => afterwards.push(fn),
      },
      p,
    ),
  );
  for (const e of events) services.events.emit(e.ev, e.d, e.to);
  for (const fn of afterwards) {
    try {
      await fn();
    } catch (err) {
      console.error(`[action ${name}] follow-up failed:`, err);
    }
  }
  return result;
}

// ── guards ──

export function requireGm(me: Viewer): void {
  if (me.role !== 'gm') throw new ActionError('Only the GM can do that');
}

// ── input validation ──

function fail(name: string, expected: string): never {
  throw new ActionError(`Invalid "${name}": expected ${expected}`);
}

export const check = {
  str(value: unknown, name: string, opts: { min?: number; max?: number } = {}): string {
    if (typeof value !== 'string') fail(name, 'text');
    const text = value.trim();
    const min = opts.min ?? 1;
    const max = opts.max ?? 200;
    if (text.length < min || text.length > max) fail(name, `text of ${min}–${max} characters`);
    return text;
  },
  optStr(value: unknown, name: string, opts: { max?: number } = {}): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return check.str(value, name, { min: 0, max: opts.max ?? 200 });
  },
  /** Long free text such as markdown. */
  text(value: unknown, name: string, max = 100_000): string {
    if (typeof value !== 'string') fail(name, 'text');
    if (value.length > max) fail(name, `at most ${max} characters`);
    return value;
  },
  int(value: unknown, name: string, opts: { min?: number; max?: number } = {}): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) fail(name, 'a whole number');
    if (opts.min !== undefined && value < opts.min) fail(name, `at least ${opts.min}`);
    if (opts.max !== undefined && value > opts.max) fail(name, `at most ${opts.max}`);
    return value;
  },
  num(value: unknown, name: string, opts: { min?: number; max?: number } = {}): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(name, 'a number');
    if (opts.min !== undefined && value < opts.min) fail(name, `at least ${opts.min}`);
    if (opts.max !== undefined && value > opts.max) fail(name, `at most ${opts.max}`);
    return value;
  },
  bool(value: unknown, name: string): boolean {
    if (typeof value !== 'boolean') fail(name, 'true or false');
    return value;
  },
  id(value: unknown, name: string): Id {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_:-]{1,80}$/.test(value)) fail(name, 'an id');
    return value;
  },
  oneOf<T extends string>(value: unknown, name: string, options: readonly T[]): T {
    if (typeof value !== 'string' || !options.includes(value as T)) fail(name, `one of ${options.join(', ')}`);
    return value as T;
  },
  arr<T>(value: unknown, name: string, item: (v: unknown, name: string) => T, max = 10_000): T[] {
    if (!Array.isArray(value)) fail(name, 'a list');
    if (value.length > max) fail(name, `at most ${max} items`);
    return value.map((v, i) => item(v, `${name}[${i}]`));
  },
  obj(value: unknown, name: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(name, 'an object');
    return value as Record<string, unknown>;
  },
};

export { ActionError };
