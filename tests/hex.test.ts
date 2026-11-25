import { describe, expect, it } from 'vitest';
import { formatHex, fromGlobal, hexCenter, hexDistance, hexNeighbors, hexesWithin, parseHex, pointToHex, subsectorOf, subsectorOrigin, toGlobal } from '../src/shared/hex';

const g = (hex: string, sx = 0, sy = 0) => {
  const h = parseHex(hex)!;
  return toGlobal(sx, sy, h.col, h.row);
};

describe('hex numbering', () => {
  it('parses and formats hex numbers', () => {
    expect(parseHex('0101')).toEqual({ col: 1, row: 1 });
    expect(parseHex('3240')).toEqual({ col: 32, row: 40 });
    expect(parseHex('3301')).toBeNull();
    expect(parseHex('0041')).toBeNull();
    expect(parseHex('abc')).toBeNull();
    expect(formatHex(3, 9)).toBe('0309');
  });

  it('round-trips global coordinates, including negative sectors', () => {
    for (const [sx, sy] of [[0, 0], [1, 2], [-1, -1], [-3, 4]]) {
      for (const hex of ['0101', '3240', '1620', '0840']) {
        const h = parseHex(hex)!;
        const { gx, gy } = toGlobal(sx, sy, h.col, h.row);
        expect(fromGlobal(gx, gy)).toEqual({ sx, sy, col: h.col, row: h.row });
      }
    }
  });

  it('assigns subsector letters', () => {
    expect(subsectorOf(1, 1)).toBe('A');
    expect(subsectorOf(8, 10)).toBe('A');
    expect(subsectorOf(9, 1)).toBe('B');
    expect(subsectorOf(1, 11)).toBe('E');
    expect(subsectorOf(32, 40)).toBe('P');
    expect(subsectorOrigin('F')).toEqual({ col0: 8, row0: 10 });
  });
});

describe('hex distance', () => {
  it('matches the printed map: even columns sit half a hex lower', () => {
    expect(hexDistance(g('0101'), g('0101'))).toBe(0);
    expect(hexDistance(g('0101'), g('0102'))).toBe(1);
    expect(hexDistance(g('0101'), g('0201'))).toBe(1);
    // 0201 is lower than 0101, so it also touches 0102 but 0202 does not touch 0101.
    expect(hexDistance(g('0201'), g('0102'))).toBe(1);
    expect(hexDistance(g('0101'), g('0202'))).toBe(2);
    expect(hexDistance(g('0202'), g('0302'))).toBe(1);
    expect(hexDistance(g('0202'), g('0303'))).toBe(1);
    expect(hexDistance(g('0202'), g('0301'))).toBe(2);
    expect(hexDistance(g('0101'), g('0105'))).toBe(4);
    expect(hexDistance(g('0101'), g('0501'))).toBe(4);
    expect(hexDistance(g('0101'), g('0810'))).toBe(13);
  });

  it('is continuous across sector edges', () => {
    // 3201 of one sector is next to 0101 of the sector to trailing.
    expect(hexDistance(g('3201', 0, 0), g('0101', 1, 0))).toBe(1);
    expect(hexDistance(g('0140', 0, 0), g('0101', 0, 1))).toBe(1);
    expect(hexDistance(g('0101', 0, 0), g('3201', -1, 0))).toBe(1);
  });

  it('gives six neighbours at distance one, and rings of the right size', () => {
    for (const hex of ['0505', '0605']) {
      const c = g(hex);
      const n = hexNeighbors(c.gx, c.gy);
      expect(new Set(n.map((h) => `${h.gx},${h.gy}`)).size).toBe(6);
      for (const h of n) expect(hexDistance(c, h)).toBe(1);
      expect(hexesWithin(c.gx, c.gy, 2)).toHaveLength(19);
      for (const h of hexesWithin(c.gx, c.gy, 3)) expect(hexDistance(c, h)).toBeLessThanOrEqual(3);
    }
  });
});

describe('point picking', () => {
  it('maps every hex centre back to its own hex', () => {
    for (let gx = -40; gx <= 40; gx += 3) {
      for (let gy = -45; gy <= 45; gy += 4) {
        const c = hexCenter(gx, gy);
        expect(pointToHex(c.x, c.y)).toEqual({ gx, gy });
        // Points a little off-centre still land in the same hex.
        expect(pointToHex(c.x + 0.3, c.y + 0.2)).toEqual({ gx, gy });
        expect(pointToHex(c.x - 0.3, c.y - 0.2)).toEqual({ gx, gy });
      }
    }
  });
});
