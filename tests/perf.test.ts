import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, HAS_CORE_RULES, setTable, type Table } from './helpers';

/** Guards against the map becoming sluggish with a full sector's worth of data. */
describe.skipIf(!HAS_CORE_RULES)('a full sector', () => {
  let table: Table;
  beforeAll(async () => {
    table = await setTable();
  });
  afterAll(async () => {
    await table.close();
  });

  it('generates, reveals and syncs within interactive time', async () => {
    const ann = await table.join('Ann');
    const sectorId = (await table.gm.act('sector.create', { name: 'Big', x: 0, y: 0 })).id;

    let t = performance.now();
    const made = await table.gm.act('map.generate', { sectorId, seed: 7 });
    const generateMs = performance.now() - t;
    expect(made.created).toBeGreaterThan(500);
    await eventually(() => expect(table.gm.all('system')).toHaveLength(made.created), 5000);

    const ids = table.gm.all('system').map((s) => s.id);
    t = performance.now();
    await table.gm.act('reveal.preset', { ids, preset: 'charted', audience: 'party' });
    const revealMs = performance.now() - t;
    await eventually(() => expect(ann.client.all('system')).toHaveLength(made.created), 5000);
    await eventually(() => expect(ann.client.all('body').length).toBe(table.gm.all('body').length), 5000);

    t = performance.now();
    await table.gm.act('reveal.preset', { ids, preset: 'hidden', audience: 'party' });
    const hideMs = performance.now() - t;
    await eventually(() => expect(ann.client.all('system')).toHaveLength(0), 5000);
    expect(ann.client.all('body')).toHaveLength(0);

    const bytes = JSON.stringify([...table.gm.ents.values()]).length;
    console.log(`full sector: ${made.created} systems, ${table.gm.all('body').length} bodies, snapshot ${(bytes / 1024).toFixed(0)} KB; generate ${generateMs.toFixed(0)} ms, reveal all ${revealMs.toFixed(0)} ms, hide all ${hideMs.toFixed(0)} ms`);
    expect(generateMs).toBeLessThan(4000);
    expect(revealMs).toBeLessThan(4000);
  });
});
