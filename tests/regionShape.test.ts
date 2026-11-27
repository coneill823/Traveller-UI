import { describe, expect, it } from 'vitest';
import { regionShape, shapeOf } from '../src/web/modules/map/regionShape';

describe('region outlines', () => {
  it('gives one hex six edges and one run', () => {
    const shape = regionShape(['4,7']);
    expect([...shape.runs]).toEqual([4, 7, 7]);
    expect(shape.edges).toHaveLength(6 * 4);
  });

  it('joins hexes in a column into one run and leaves out the edge between them', () => {
    const shape = regionShape(['4,7', '4,8', '4,9', '4,11']);
    expect([...shape.runs]).toEqual([4, 7, 9, 4, 11, 11]);
    // Three joined hexes show 6 + 4 + 4 edges... less the two shared pairs: 18 - 4 = 14; the lone hex adds 6.
    expect(shape.edges).toHaveLength((14 + 6) * 4);
  });

  it('knows which hexes touch across staggered columns', () => {
    // Odd columns sit half a hex lower, so 5,7 touches 4,7 and 4,8 but not 4,6.
    expect(regionShape(['4,7', '5,7']).edges).toHaveLength(10 * 4);
    expect(regionShape(['4,8', '5,7']).edges).toHaveLength(10 * 4);
    expect(regionShape(['4,6', '5,7']).edges).toHaveLength(12 * 4);
    // The same holds left of the origin, where coordinates are negative.
    expect(regionShape(['-4,7', '-5,7']).edges).toHaveLength(10 * 4);
    expect(regionShape(['-4,8', '-5,7']).edges).toHaveLength(10 * 4);
    expect(regionShape(['-4,6', '-5,7']).edges).toHaveLength(12 * 4);
  });

  it('draws only the outside of a filled block, and boxes it', () => {
    const hexes: string[] = [];
    for (let gx = 0; gx < 32; gx++) for (let gy = 0; gy < 40; gy++) hexes.push(`${gx},${gy}`);
    const shape = regionShape(hexes);
    expect(shape.runs).toHaveLength(32 * 3);
    // A flat edge on top of and under each column, two slanted edges down each side per row, and one slanted edge for each step between neighbouring columns, top and bottom.
    expect(shape.edges.length / 4).toBe(2 * 32 + 4 * 40 + 2 * 31);
    expect(shape.box.x0).toBeCloseTo(-2 / 3);
    expect(shape.box.x1).toBeCloseTo(31 + 2 / 3);
    expect(shape.box.y0).toBeLessThan(0);
  });

  it('ignores repeats and bad keys, and keeps the shape for a list it has seen', () => {
    expect([...regionShape(['4,7', '4,7', 'nonsense', '4,8']).runs]).toEqual([4, 7, 8]);
    const list = ['1,1', '1,2'];
    expect(shapeOf(list)).toBe(shapeOf(list));
  });
});
