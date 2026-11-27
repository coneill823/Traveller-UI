import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fillBorder, parseSectorData, placeInSubsector, toTabDelimited } from '../src/shared/sectorFormats';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const byHex = (worlds: { hex: string }[]) => Object.fromEntries(worlds.map((w) => [w.hex, w]));

describe('sector data parsing', () => {
  it('reads Second Survey tab-delimited data', () => {
    const r = parseSectorData(fixture('sector-tab.txt'));
    expect(r.format).toBe('tab');
    expect(r.worlds).toHaveLength(4);
    const w = byHex(r.worlds) as Record<string, any>;
    expect(w['0103']).toMatchObject({ name: 'Ardent', uwp: 'A646930-D', bases: 'NS', remarks: 'Hi In Ht', zone: '', pbg: '800', allegiance: 'KcCf', stars: 'F8 V', ix: '{ 5 }', subsector: 'A' });
    expect(w['0204']).toMatchObject({ name: 'Low Harbour', zone: 'A', stars: 'M1 V M7 V' });
    expect(w['0308']).toMatchObject({ zone: 'R', uwp: 'X555423-2' });
    expect(w['0902'].name).toBe("Tolland's Rest");
    expect(r.looksLikeSubsector).toBe(false);
  });

  it('reads Second Survey column-delimited data with CRLF line endings and header comments', () => {
    const r = parseSectorData(fixture('sector-columns.txt').replace(/\n/g, '\r\n'));
    expect(r.format).toBe('columns');
    expect(r.worlds).toHaveLength(4);
    const w = byHex(r.worlds) as Record<string, any>;
    expect(w['0103']).toMatchObject({ name: 'Ardent', uwp: 'A646930-D', bases: 'NS', remarks: 'Hi In Ht', pbg: '800', allegiance: 'KcCf', stars: 'F8 V' });
    expect(w['0204']).toMatchObject({ zone: 'A', stars: 'M1 V M7 V' });
    expect(w['0204'].bases).toBeUndefined();
    expect(w['0308']).toMatchObject({ zone: 'R' });
    expect(w['0308'].nobility).toBeUndefined();
    expect(r.meta.sectorName).toBe('Kestrel Reach');
    expect(r.meta.abbreviation).toBe('Kest');
    expect(r.meta.subsectors).toEqual({ A: 'Ardent', B: 'Tolland', P: 'The Far Verge' });
  });

  it('reads legacy SEC files, including names that run straight into the hex number', () => {
    const r = parseSectorData(fixture('sector-legacy.txt'));
    expect(r.format).toBe('sec');
    expect(r.worlds).toHaveLength(4);
    const w = byHex(r.worlds) as Record<string, any>;
    // Legacy base code A means naval + scout.
    expect(w['0103']).toMatchObject({ name: 'Ardent', uwp: 'A646930-D', bases: 'NS', remarks: 'Hi In Ht', pbg: '800', allegiance: 'Kc', stars: 'F8 V' });
    expect(w['0204']).toMatchObject({ name: 'Low Harbour', zone: 'A', pbg: '210', stars: 'M1 V M7 V' });
    expect(w['0308']).toMatchObject({ zone: 'R', allegiance: 'Na' });
    expect(w['0902']).toMatchObject({ name: "Tolland's Rest", bases: 'S', remarks: 'As Na Va', pbg: '123' });
  });

  it('reads loose generator output and spots subsector-sized data', () => {
    const r = parseSectorData(fixture('subsector-loose.txt'));
    expect(r.format).toBe('loose');
    expect(r.worlds).toHaveLength(5);
    expect(r.looksLikeSubsector).toBe(true);
    const w = byHex(r.worlds) as Record<string, any>;
    expect(w['0101']).toMatchObject({ name: 'Brannoch', uwp: 'C8759A9-8', bases: 'S', remarks: 'Hi In', zone: 'A', pbg: '504', allegiance: 'Na' });
    expect(w['0103']).toMatchObject({ name: 'Quill', remarks: 'Ba Va', pbg: '013' });
    expect(w['0103'].bases).toBeUndefined();
    expect(w['0307']).toMatchObject({ name: 'St. Idris', bases: 'N', stars: 'G2 V' });
    expect(w['0508']).toMatchObject({ name: "Hask's World", uwp: 'D7A5422-6', remarks: 'Fl Ni', zone: 'R' });
    expect(w['0810']).toMatchObject({ name: 'Zzyr', bases: 'NS', remarks: 'Fl Hi Ht In', stars: 'M0 V D' });
  });

  it('does not mistake a depot base for a white dwarf', () => {
    const r = parseSectorData('0202 Bulwark   A867A74-F  D  Hi Ht   702 Na  K1 V');
    expect(r.worlds[0]).toMatchObject({ bases: 'D', remarks: 'Hi Ht', pbg: '702', stars: 'K1 V' });
  });

  it('reads JSON world lists and CSV', () => {
    const json = parseSectorData(JSON.stringify({ Worlds: [{ Hex: '0101', Name: 'Aa', UWP: 'A000000-0', Zone: 'A', PBG: '011', Stellar: 'G2 V' }, { Name: 'no hex' }] }));
    expect(json.format).toBe('json');
    expect(json.worlds).toEqual([expect.objectContaining({ hex: '0101', name: 'Aa', zone: 'A', pbg: '011', stars: 'G2 V' })]);
    expect(json.warnings.join(' ')).toMatch(/skipped/);

    const csv = parseSectorData('Hex,Name,UWP,Trade Codes\n0105,"Smith, Jones & Co",B433565-9,"Ni Po"\n');
    expect(csv.format).toBe('csv');
    expect(csv.worlds[0]).toMatchObject({ hex: '0105', name: 'Smith, Jones & Co', remarks: 'Ni Po' });
  });

  it('reads MSEC and XML metadata', () => {
    const msec = parseSectorData(fixture('sector.msec'));
    expect(msec.format).toBe('none');
    expect(msec.meta.sectorName).toBe('Kestrel Reach');
    expect(msec.meta.subsectors).toEqual({ A: 'Ardent', B: 'Tolland', P: 'The Far Verge' });
    expect(msec.meta.routes).toEqual([{ start: '0103', end: '0204' }, { start: '0204', end: '0902' }]);
    expect(msec.meta.borders).toEqual([{ name: 'Border', color: 'red', hexes: ['0101', '0102', '0201', '0202'] }]);

    const xml = parseSectorData('<Sector Abbreviation="Kest"><Name>Kestrel Reach</Name><Subsectors><Subsector Index="C">Mire</Subsector></Subsectors><Routes><Route Start="0103" End="0204" /><Route Start="0103" EndOffsetX="1" End="3201" /></Routes></Sector>');
    expect(xml.meta).toMatchObject({ sectorName: 'Kestrel Reach', abbreviation: 'Kest', subsectors: { C: 'Mire' } });
    // A route that leaves the sector says which neighbour its far end is in.
    expect(xml.meta.routes).toEqual([{ start: '0103', end: '0204' }, { start: '0103', end: '3201', endOffset: [1, 0] }]);
  });

  it('keeps the sector offsets of MSEC routes instead of drawing them inside the sector', () => {
    const r = parseSectorData('sector Kestrel Reach\nroute 0140 0 1 0101\nroute -1 0 3205 0105\nroute 0103 0204 lightgreen\n');
    expect(r.meta.routes).toEqual([
      { start: '0140', end: '0101', endOffset: [0, 1] },
      { start: '3205', end: '0105', startOffset: [-1, 0] },
      { start: '0103', end: '0204' },
    ]);
  });

  it('does not take the header row of a tab-delimited file for the name of the sector', () => {
    const r = parseSectorData('Sector\tSS\tHex\tName\tUWP\nKest\tA\t0103\tArdent\tA646930-D\nKest\tA\t0204\tLow Harbour\tC555423-7\n');
    expect(r.format).toBe('tab');
    expect(r.worlds).toHaveLength(2);
    expect(r.meta.sectorName).toBeUndefined();
    expect(r.meta.abbreviation).toBe('Kest');
    expect(r.warnings).toEqual([]);
  });

  it('names a sector whose only names carry a language tag', () => {
    expect(parseSectorData('# Name: Vorrgh (va)\n# Name: Other (zh)\n0101 One A000000-0\n').meta.sectorName).toBe('Vorrgh');
    expect(parseSectorData('# Name: Kestrel Reach\n# Name: Vorrgh (va)\n0101 One A000000-0\n').meta.sectorName).toBe('Kestrel Reach');
  });

  it('reads worlds and metadata pasted together without counting the metadata as bad rows', () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<Sector Abbreviation="Kest">',
      '  <Name>Kestrel Reach</Name>',
      '  <Credits><![CDATA[ Kestrel Reach was drawn for a test. ]]></Credits>',
      '  <Subsectors><Subsector Index="A">Ardent</Subsector></Subsectors>',
      '  <Allegiances><Allegiance Code="KcCf" Base="Kc">Kestrel Concord, Home Fleet</Allegiance><Allegiance Code="Tl">Tolland League</Allegiance></Allegiances>',
      '  <Borders>',
      '    <Border Allegiance="KcCf" LabelPosition="0102" Label="Kestrel Concord">0101 0201 0202 0102 0101</Border>',
      '    <Border Allegiance="KcCf">0505</Border>',
      '    <Border Allegiance="Tl" Color="teal">0901 0902</Border>',
      '  </Borders>',
      '  <Routes><Route Start="0103" End="0204" /><Route Start="0204" End="0101" EndOffsetY="1" Allegiance="KcCf" /></Routes>',
      '</Sector>',
    ].join('\n');
    const msec = 'sector Kestrel Reach\na Ardent\nroute 0103 0204\nroute 0204 0 1 0101\nlabel 0102 Kestrel Concord\nborder 0101 0201 0202 0102 0101 gold\nborder 0505 gold\n';
    for (const data of [fixture('sector-columns.txt'), fixture('sector-tab.txt'), fixture('sector-legacy.txt')]) {
      const alone = parseSectorData(data);
      const r = parseSectorData(`${data}\n${xml}\n${msec}`);
      expect(r.format).toBe(alone.format);
      expect(r.worlds).toEqual(alone.worlds);
      expect(r.warnings).toEqual(alone.warnings);
      expect(r.meta.subsectors.A).toBe('Ardent');
      // The same routes and borders given twice (XML and MSEC) are counted once; MSEC supplies the colours.
      expect(r.meta.routes).toEqual([{ start: '0103', end: '0204' }, { start: '0204', end: '0101', endOffset: [0, 1] }]);
      expect(r.meta.borders).toEqual([
        { name: 'Kestrel Concord', allegiance: 'KcCf', color: 'gold', hexes: ['0101', '0102', '0201', '0202'] },
        { name: 'Kestrel Concord', allegiance: 'KcCf', color: 'gold', hexes: ['0505'] },
        { name: 'Tolland League', allegiance: 'Tl', color: 'teal', hexes: ['0901', '0902'] },
      ]);
    }
  });

  it('fills a border path with the hexes it encloses', () => {
    // A ring of six hexes around 0303 encloses the hex in the middle.
    const ring = ['0302', '0402', '0403', '0304', '0203', '0202', '0302'];
    expect(fillBorder(ring).sort()).toEqual(['0202', '0203', '0302', '0303', '0304', '0402', '0403']);
    // One hex, and a path that doubles back on itself, enclose nothing more than themselves.
    expect(fillBorder(['1010'])).toEqual(['1010']);
    expect(fillBorder(['0101', '0102', '0103', '0102', '0101']).sort()).toEqual(['0101', '0102', '0103']);
    // A path that skips hexes is closed with straight runs, so nothing leaks out.
    const square = fillBorder(['0101', '0501', '0505', '0105', '0101']);
    expect(square).toContain('0303');
    expect(square).not.toContain('0606');
    // Where a state carries on next door the path runs just outside the sector, and only this sector's hexes are kept.
    const corner = fillBorder(['0000', '0100', '0200', '0300', '0301', '0302', '0303', '0203', '0103', '0003', '0002', '0001', '0000']);
    expect(corner.sort()).toEqual(['0101', '0102', '0103', '0201', '0202', '0203', '0301', '0302', '0303']);
    const whole = fillBorder(['0000', '3300', '3341', '0041', '0000']);
    expect(whole).toHaveLength(32 * 40);
    expect(fillBorder([])).toEqual([]);
  });

  it('rejects impossible hexes and duplicates with a warning', () => {
    const r = parseSectorData('0101 One A000000-0\n0101 Two A000000-0\n9999 Far A000000-0\n');
    expect(r.worlds.map((w) => w.name)).toEqual(['One']);
    expect(r.warnings).toHaveLength(2);
  });

  it('places subsector data and round-trips through tab-delimited export', () => {
    const r = parseSectorData(fixture('subsector-loose.txt'));
    const placed = placeInSubsector(r.worlds, 'F');
    expect(placed.map((w) => w.hex)).toEqual(['0911', '0913', '1117', '1318', '1620']);
    const again = parseSectorData(toTabDelimited(placed));
    expect(again.format).toBe('tab');
    expect(again.worlds.map((w) => [w.hex, w.name, w.uwp, w.zone])).toEqual(placed.map((w) => [w.hex, w.name, w.uwp, w.zone]));
  });

  it('returns nothing for unrelated text', () => {
    const r = parseSectorData('Just some notes about the session.\nNothing to see.');
    expect(r.format).toBe('none');
    expect(r.worlds).toEqual([]);
  });
});
