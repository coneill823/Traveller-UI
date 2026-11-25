import { describe, expect, it } from 'vitest';
import { applyPatch, setOps } from '../src/shared/patch';

describe('patch operations', () => {
  it('sets, deletes, pushes, pulls and increments', () => {
    const doc: any = { a: 1, list: [{ id: 'x', n: 1 }, { id: 'y', n: 2 }] };
    applyPatch(doc, [
      { op: 'set', path: ['b', 'c'], value: 5 },
      { op: 'del', path: ['a'] },
      { op: 'push', path: ['tags'], value: 't1' },
      { op: 'push', path: ['tags'], value: 't2' },
      { op: 'pull', path: ['tags'], value: 't1' },
      { op: 'inc', path: ['count'], by: 3 },
      { op: 'inc', path: ['count'], by: -1 },
    ]);
    expect(doc).toEqual({ b: { c: 5 }, list: [{ id: 'x', n: 1 }, { id: 'y', n: 2 }], tags: ['t2'], count: 2 });
  });

  it('addresses array items by id so edits survive reordering', () => {
    const doc: any = { list: [{ id: 'x', n: 1 }, { id: 'y', n: 2 }] };
    applyPatch(doc, [
      { op: 'set', path: ['list', 'y', 'n'], value: 20 },
      { op: 'del', path: ['list', 'x'] },
      { op: 'pull', path: ['list'], id: 'nope' },
    ]);
    expect(doc.list).toEqual([{ id: 'y', n: 20 }]);
  });

  it('refuses prototype pollution and malformed paths', () => {
    expect(() => applyPatch({}, [{ op: 'set', path: ['__proto__', 'x'], value: 1 }])).toThrow();
    expect(() => applyPatch({}, [{ op: 'set', path: [], value: 1 }])).toThrow();
    expect(({} as any).x).toBeUndefined();
  });

  it('builds set operations from dotted keys', () => {
    expect(setOps({ 'a.b': 1, c: undefined })).toEqual([
      { op: 'set', path: ['a', 'b'], value: 1 },
      { op: 'del', path: ['c'] },
    ]);
  });
});
