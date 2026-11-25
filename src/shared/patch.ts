/**
 * Field-level edits. Clients send small path operations rather than whole documents, so two
 * people editing different fields of the same entity do not overwrite each other.
 */
import { isPlainObject } from './util';

export type Path = (string | number)[];

export type PatchOp =
  | { op: 'set'; path: Path; value: unknown }
  | { op: 'del'; path: Path }
  /** Append to an array (created if missing). */
  | { op: 'push'; path: Path; value: unknown }
  /** Remove array items whose `id` equals `id` (or that equal `value` for plain arrays). */
  | { op: 'pull'; path: Path; id?: string; value?: unknown }
  /** Add a number to a numeric field (missing counts as 0). */
  | { op: 'inc'; path: Path; by: number };

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function checkPath(path: Path): void {
  if (!Array.isArray(path) || path.length === 0) throw new Error('Patch path must be a non-empty array');
  for (const key of path) {
    if (typeof key === 'string' && FORBIDDEN_KEYS.has(key)) throw new Error(`Illegal path segment "${key}"`);
    if (typeof key !== 'string' && typeof key !== 'number') throw new Error('Path segments must be strings or numbers');
  }
}

/** Walks to the parent of the last path segment, creating containers on the way when asked. */
function parentOf(root: Record<string, unknown>, path: Path, create: boolean): { parent: any; key: string | number } | null {
  let node: any = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    let next = resolveChild(node, key);
    if (next === undefined || next === null) {
      if (!create) return null;
      next = typeof path[i + 1] === 'number' ? [] : {};
      assignChild(node, key, next);
    } else if (typeof next !== 'object') {
      if (!create) return null;
      throw new Error(`Cannot descend into non-object at "${String(key)}"`);
    }
    node = next;
  }
  return { parent: node, key: path[path.length - 1] };
}

/**
 * Arrays of objects can be addressed by item id instead of index: a string segment on an array
 * selects the item whose `id` matches. This keeps edits stable while others reorder the list.
 */
function resolveChild(node: any, key: string | number): any {
  if (Array.isArray(node) && typeof key === 'string') return node.find((item) => isPlainObject(item) && item.id === key);
  return node?.[key];
}

function assignChild(node: any, key: string | number, value: unknown): void {
  if (Array.isArray(node) && typeof key === 'string') {
    const i = node.findIndex((item) => isPlainObject(item) && item.id === key);
    if (i >= 0) node[i] = value;
    else node.push(value);
    return;
  }
  node[key] = value;
}

/** Applies operations in place and returns the same object. Throws on malformed operations. */
export function applyPatch<T extends object>(target: T, ops: PatchOp[]): T {
  const root = target as unknown as Record<string, unknown>;
  for (const op of ops) {
    checkPath(op.path);
    switch (op.op) {
      case 'set': {
        const loc = parentOf(root, op.path, true)!;
        assignChild(loc.parent, loc.key, op.value);
        break;
      }
      case 'del': {
        const loc = parentOf(root, op.path, false);
        if (!loc) break;
        if (Array.isArray(loc.parent)) {
          const i =
            typeof loc.key === 'number'
              ? loc.key
              : loc.parent.findIndex((item: unknown) => isPlainObject(item) && item.id === loc.key);
          if (i >= 0 && i < loc.parent.length) loc.parent.splice(i, 1);
        } else {
          delete loc.parent[loc.key];
        }
        break;
      }
      case 'push': {
        const loc = parentOf(root, op.path, true)!;
        const current = resolveChild(loc.parent, loc.key);
        if (current === undefined || current === null) assignChild(loc.parent, loc.key, [op.value]);
        else if (Array.isArray(current)) current.push(op.value);
        else throw new Error(`Cannot push onto non-array at "${op.path.join('.')}"`);
        break;
      }
      case 'pull': {
        const loc = parentOf(root, op.path, false);
        if (!loc) break;
        const current = resolveChild(loc.parent, loc.key);
        if (!Array.isArray(current)) break;
        const keep = current.filter((item: unknown) =>
          op.id !== undefined ? !(isPlainObject(item) && item.id === op.id) : item !== op.value,
        );
        assignChild(loc.parent, loc.key, keep);
        break;
      }
      case 'inc': {
        const loc = parentOf(root, op.path, true)!;
        const current = resolveChild(loc.parent, loc.key);
        const base = typeof current === 'number' ? current : 0;
        assignChild(loc.parent, loc.key, base + op.by);
        break;
      }
      default:
        throw new Error(`Unknown patch operation "${(op as { op: string }).op}"`);
    }
  }
  return target;
}

/** Convenience builder: turns `{ a: 1, 'b.c': 2 }` into set operations (undefined deletes). */
export function setOps(fields: Record<string, unknown>): PatchOp[] {
  return Object.entries(fields).map(([key, value]) =>
    value === undefined ? { op: 'del', path: key.split('.') } : { op: 'set', path: key.split('.'), value },
  );
}

/** Top-level field touched by an operation, used for permission checks. */
export function rootField(op: PatchOp): string {
  return String(op.path[0]);
}
