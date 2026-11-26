import { describe, expect, it } from 'vitest';
import { defaultOutlineKey, outlineByKey, OUTLINES, parseOutlineText, pathBounds } from '../src/shared/outlines';
import type { PartLine } from '../src/shared/rules/ship';
import type { ShipSpec } from '../src/shared/types';
import { allocate, CARGO, cargoIndex, cellAt, cellXY, hullOrder, insertIndex, moveInOrder, type HullGrid } from '../src/web/modules/shipyard/hullLayout';

describe('hull outlines', () => {
  it('ships a set of valid built-in silhouettes', () => {
    expect(OUTLINES.length).toBeGreaterThanOrEqual(8);
    for (const o of OUTLINES) {
      expect(o.d).toMatch(/^M/);
      expect(parseOutlineText(o.d).outline, o.key).toBeDefined();
    }
    expect(outlineByKey('nope').key).toBe(OUTLINES[0].key);
  });

  it('follows the hull configuration when no outline is chosen', () => {
    expect(defaultOutlineKey({ hull: { tons: 200, config: 'streamlined' } })).toBe('wedge');
    expect(defaultOutlineKey({ hull: { tons: 40, config: 'streamlined' } })).toBe('dart');
    expect(defaultOutlineKey({ hull: { tons: 400, config: 'dispersed' } })).toBe('lattice');
    expect(defaultOutlineKey({ hull: { tons: 800, config: 'sphere' } })).toBe('sphere');
    expect(defaultOutlineKey({ hull: { tons: 200, config: 'standard' } })).toBe('hauler');
  });

  it('reads pasted path data and works out its bounds', () => {
    const { outline } = parseOutlineText('M 10 20 L 110 20 L 110 70 L 10 70 Z', 'Box');
    expect(outline).toMatchObject({ kind: 'path', name: 'Box' });
    const [x, y, w, h] = outline!.viewBox;
    expect(x).toBeLessThanOrEqual(10);
    expect(y).toBeLessThanOrEqual(20);
    expect(x + w).toBeGreaterThanOrEqual(110);
    expect(y + h).toBeGreaterThanOrEqual(70);
    // Relative commands and arcs are followed too.
    const b = pathBounds('m 0 0 h 100 v 50 h -100 z')!;
    expect(b[2]).toBeGreaterThanOrEqual(100);
    expect(b[3]).toBeGreaterThanOrEqual(50);
  });

  it('pulls every path and the view box out of an SVG file', () => {
    const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><g><path fill="#000" d="M 20 100 L 80 30 L 380 100 Z"/><path d='M 150 10 L 190 10 L 190 190 Z'/></g></svg>`;
    const { outline } = parseOutlineText(svg);
    expect(outline?.viewBox).toEqual([0, 0, 400, 200]);
    expect(outline?.d).toBe('M 20 100 L 80 30 L 380 100 Z M 150 10 L 190 10 L 190 190 Z');
    const sized = parseOutlineText('<svg width="300" height="120"><path d="M0 0L300 60L0 120Z"/></svg>');
    expect(sized.outline?.viewBox).toEqual([0, 0, 300, 120]);
  });

  it('refuses things that are not outlines', () => {
    expect(parseOutlineText('').error).toBeDefined();
    expect(parseOutlineText('hello world').error).toMatch(/not SVG path data/);
    expect(parseOutlineText('<svg><rect width="10" height="10"/></svg>').error).toMatch(/No <path>/);
    expect(parseOutlineText('<svg><path d="M0 0 L10 10" onload="alert(1)"/><script>x</script></svg>').outline?.d).toBe('M0 0 L10 10');
    expect(parseOutlineText('M 0 0 javascript:alert(1)').error).toBeDefined();
    expect(parseOutlineText(`M 0 0 ${'L 1 1 '.repeat(5000)}`).error).toMatch(/too detailed/);
  });
});

describe('laying parts out on a hull', () => {
  // A plain 10 x 4 rectangle: 40 cells, bow at the right-hand column.
  const grid: HullGrid = (() => {
    const cols = 10;
    const rows = 4;
    const order: number[] = [];
    for (let step = 0; step < cols; step++) {
      const col = cols - 1 - step;
      for (let i = 0; i < rows; i++) order.push(col * rows + (step % 2 === 0 ? i : rows - 1 - i));
    }
    return { viewBox: [0, 0, 100, 40], size: 10, cols, rows, order };
  })();

  it('gives each part cells in proportion to its tonnage, from the bow back', () => {
    const a = allocate(grid, 200, [
      { id: 'bridge', tons: 20 },
      { id: 'cargo', tons: 100 },
      { id: 'fuel', tons: 40 },
      { id: 'drive', tons: 40 },
    ]);
    expect(a.blocks.map((b) => [b.id, b.cells.length])).toEqual([
      ['bridge', 4],
      ['cargo', 20],
      ['fuel', 8],
      ['drive', 8],
    ]);
    expect(a.overflow).toEqual([]);
    // The bridge takes the right-hand column; the drive ends at the left edge.
    expect(a.blocks[0].cells.every((c) => cellXY(grid, c).x === 90)).toBe(true);
    expect(a.blocks[3].cells.some((c) => cellXY(grid, c).x === 0)).toBe(true);
    expect(a.owner.get(cellAt(grid, 95, 5)!)).toBe('bridge');
    expect(cellAt(grid, 500, 5)).toBeUndefined();
  });

  it('always shows small parts and reports what does not fit', () => {
    const a = allocate(grid, 200, [
      { id: 'tiny', tons: 0.5 },
      { id: 'none', tons: 0 },
      { id: 'big', tons: 199.5 },
      { id: 'extra', tons: 30 },
    ]);
    expect(a.blocks.find((b) => b.id === 'tiny')?.cells.length).toBe(1);
    expect(a.blocks.find((b) => b.id === 'none')).toBeUndefined();
    expect(a.blocks.find((b) => b.id === 'big')?.cells.length).toBe(39);
    expect(a.overflow).toEqual(['extra']);
  });

  const line = (partId: string, kind: PartLine['kind'], group: string, tons = 1): PartLine => ({ partId, kind, group, label: partId, detail: '', qty: 1, tons, cost: 0, power: 0, output: 0, tl: 0, hardpoints: 0, known: true });
  const spec: ShipSpec = {
    tl: 12,
    hull: { tons: 200, config: 'standard' },
    parts: [
      { id: 'bridge', kind: 'bridge', key: 'bridge' },
      { id: 'rooms', kind: 'fitting', key: 'stateroom', qty: 4 },
      { id: 'fuel', kind: 'fuel', tons: 41 },
      { id: 'plant', kind: 'plant', key: 'fusion12', tons: 6 },
      { id: 'mdrive', kind: 'mdrive', rating: 1 },
    ],
  };
  const lines = [line('bridge', 'bridge', 'command'), line('rooms', 'fitting', 'quarters'), line('fuel', 'fuel', 'fuel'), line('plant', 'plant', 'power'), line('mdrive', 'mdrive', 'drives')];

  it('puts the hold ahead of engineering until it is moved', () => {
    expect(cargoIndex(spec, lines)).toBe(2);
    expect(hullOrder(spec, lines)).toEqual(['bridge', 'rooms', CARGO, 'fuel', 'plant', 'mdrive']);
    // Weapons go behind the bridge, systems behind the quarters, a jump drive ahead of the manoeuvre drive.
    expect(insertIndex(spec, lines, 2)).toBe(1);
    expect(insertIndex(spec, lines, 4)).toBe(2);
    expect(insertIndex(spec, lines, 9)).toBe(4);
    expect(insertIndex(spec, lines, 10)).toBe(5);
  });

  it('moves parts and the hold along the hull', () => {
    const moved = moveInOrder(spec, lines, 'fuel', 'bridge');
    expect(moved.parts.map((p) => p.id)).toEqual(['fuel', 'bridge', 'rooms', 'plant', 'mdrive']);
    expect(moved.cargoAt).toBe(3);
    const hold = moveInOrder(spec, lines, CARGO, undefined);
    expect(hold.parts.map((p) => p.id)).toEqual(spec.parts.map((p) => p.id));
    expect(hold.cargoAt).toBe(5);
    expect(hullOrder({ ...spec, ...hold }, lines).at(-1)).toBe(CARGO);
    const forward = moveInOrder(spec, lines, CARGO, 'bridge');
    expect(forward.cargoAt).toBe(0);
  });
});
