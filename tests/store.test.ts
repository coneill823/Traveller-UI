import { describe, expect, it } from 'vitest';
import type { Entity } from '../src/shared/types';
import { applyPatch, applySnapshot, getEntity, useApp } from '../src/web/store';

const ent = (id: string, type: string, extra: Record<string, unknown> = {}): Entity => ({ id, type, rev: 1, createdAt: 0, updatedAt: 0, ...extra }) as unknown as Entity;
const ids = (type: string): string[] => (useApp.getState().byType[type as 'system'] ?? []).map((e) => e.id);

describe('client store', () => {
  it('applies an update to the lists it touches and leaves the others alone', () => {
    applySnapshot([ent('s1', 'system'), ent('s2', 'system'), ent('s3', 'system'), ent('r1', 'route'), ent('c1', 'character')]);
    const before = useApp.getState();
    const table = before.ents;
    const routes = before.byType.route;
    const characters = before.byType.character;

    applyPatch([ent('s2', 'system', { name: 'Renamed' }), ent('s4', 'system')], ['s1']);
    const after = useApp.getState();
    // Changed entries keep their places, new ones go on the end, deleted ones leave.
    expect(ids('system')).toEqual(['s2', 's3', 's4']);
    expect(getEntity('s2')).toMatchObject({ name: 'Renamed' });
    expect(getEntity('s1')).toBeUndefined();
    // The big table is changed in place; a list is replaced only when its own type changed.
    expect(after.ents).toBe(table);
    expect(after.byType.system).not.toBe(before.byType.system);
    expect(after.byType.route).toBe(routes);
    expect(after.byType.character).toBe(characters);
    // The state object itself is new, so anything watching one entry or one list is told.
    expect(after).not.toBe(before);
  });

  it('does nothing for an empty update or for deleting what it never had', () => {
    applySnapshot([ent('s1', 'system')]);
    const before = useApp.getState();
    applyPatch([], ['nope']);
    expect(useApp.getState()).toBe(before);
  });

  it('empties a list when its last entry goes, and starts one for a new type', () => {
    applySnapshot([ent('s1', 'system')]);
    applyPatch([ent('g1', 'region')], ['s1']);
    expect(ids('system')).toEqual([]);
    expect(ids('region')).toEqual(['g1']);
    expect(Object.keys(useApp.getState().ents)).toEqual(['g1']);
  });

  it('keeps up with thousands of entries without rebuilding everything', () => {
    const many: Entity[] = [];
    for (let i = 0; i < 60_000; i++) many.push(ent(`b${i}`, 'body'));
    many.push(ent('x1', 'roll'));
    applySnapshot(many);
    const bodies = useApp.getState().byType.body;
    const t = performance.now();
    for (let i = 0; i < 200; i++) applyPatch([ent(`x${i + 2}`, 'roll')], []);
    const each = (performance.now() - t) / 200;
    expect(useApp.getState().byType.body).toBe(bodies);
    expect(ids('roll')).toHaveLength(201);
    // Each small update used to copy all 60,000 entries (tens of milliseconds); now it costs a fraction of one.
    expect(each).toBeLessThan(5);
  });
});
