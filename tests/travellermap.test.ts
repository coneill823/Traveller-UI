import { describe, expect, it } from 'vitest';
import { parseUniverse, sectorsBetween, sectorUrls, universeUrl } from '../src/shared/travellermap';

// A made-up sector list in the shape the map's "universe" service sends.
const UNIVERSE = {
  Sectors: [
    { X: 3, Y: -2, Milieu: 'M1105', Abbreviation: 'Farr', Tags: 'Unofficial', Names: [{ Text: 'Far Reach' }] },
    { X: 0, Y: 0, Milieu: 'M1105', Abbreviation: 'Kest', Tags: 'Official OTU', Names: [{ Text: 'Kestrel Reach' }, { Text: 'Vorrgh', Lang: 'va' }] },
    { X: -1, Y: 0, Milieu: 'M1105', Tags: 'OTU', Names: [{ Text: ' Tolland ' }] },
    { X: 0, Y: 0, Milieu: 'M1105', Names: [{ Text: 'A second sector in the same place' }] },
    { X: 0, Y: 1, Names: [] },
    { X: 1.5, Y: 1, Names: [{ Text: 'Half a sector over' }] },
    { X: 900, Y: 0, Names: [{ Text: 'Beyond the grid' }] },
    'nonsense',
    null,
  ],
};

describe('reading the Traveller Map', () => {
  it('reads the list of sectors, nearest the centre first', () => {
    expect(parseUniverse(UNIVERSE)).toEqual([
      { x: 0, y: 0, name: 'Kestrel Reach', abbr: 'Kest', tags: ['Official', 'OTU'] },
      { x: -1, y: 0, name: 'Tolland', abbr: undefined, tags: ['OTU'] },
      { x: 3, y: -2, name: 'Far Reach', abbr: 'Farr', tags: ['Unofficial'] },
    ]);
    expect(parseUniverse(null)).toEqual([]);
    expect(parseUniverse({ Sectors: 'no' })).toEqual([]);
  });

  it('asks for a sector by its position, in the forms the importer reads', () => {
    const urls = sectorUrls(-4, 2);
    expect(urls.data).toBe('https://travellermap.com/api/sec?sx=-4&sy=2&milieu=M1105&type=SecondSurvey');
    expect(urls.metadata).toBe('https://travellermap.com/api/metadata?sx=-4&sy=2&milieu=M1105&accept=text/xml');
    expect(urls.borders).toBe('https://travellermap.com/api/msec?sx=-4&sy=2&milieu=M1105');
    expect(universeUrl()).toBe('https://travellermap.com/api/universe?requireData=1&milieu=M1105');
  });

  it('picks the block of sectors between two corners, whichever way round they are given', () => {
    const list = parseUniverse(UNIVERSE);
    expect(sectorsBetween(list, { x: 0, y: 0 }, { x: -1, y: 0 }).map((s) => s.name)).toEqual(['Kestrel Reach', 'Tolland']);
    expect(sectorsBetween(list, { x: 3, y: -2 }, { x: -1, y: 0 }).map((s) => s.name)).toEqual(['Kestrel Reach', 'Tolland', 'Far Reach']);
    expect(sectorsBetween(list, { x: 5, y: 5 }, { x: 6, y: 6 })).toEqual([]);
  });
});
