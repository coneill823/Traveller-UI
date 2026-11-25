import { describe, expect, it } from 'vitest';
import { PARTY_VIEWER_ID, presetFor, redact, stripSpoilers, withAudience, type Viewer } from '../src/shared/knowledge';
import type { Body, Entity, Objective, Roll, StarSystem, WikiPage } from '../src/shared/types';

const base = { rev: 1, createdAt: 0, updatedAt: 0 };
const gm: Viewer = { role: 'gm', playerId: 'gm1' };
const ann: Viewer = { role: 'player', playerId: 'ann' };
const bob: Viewer = { role: 'player', playerId: 'bob' };
const party: Viewer = { role: 'player', playerId: PARTY_VIEWER_ID };

const system: StarSystem = {
  ...base,
  id: 's1',
  type: 'system',
  sectorId: 'sec1',
  hex: '0101',
  name: 'Ardent',
  uwp: 'A646930-D',
  bases: 'NS',
  zone: 'A',
  gm: { secret: 'cult HQ' },
  known: { exists: ['party'], name: ['ann'] },
  notes: [
    { id: 'n1', title: 'Public', body: 'A busy port.', known: ['party'] },
    { id: 'n2', title: 'For Bob', body: 'Your contact lives here.', known: ['bob'] },
    { id: 'n3', title: 'GM', body: 'The governor is a traitor.', known: [] },
  ],
};
const lookup = (ents: Entity[]) => (id: string) => ents.find((e) => e.id === id);

describe('redaction', () => {
  it('gives the GM the full entity', () => {
    expect(redact(system, gm, lookup([system]))).toBe(system);
  });

  it('shows players only the facets revealed to them or to the party', () => {
    const forAnn = redact(system, ann, lookup([system])) as any;
    expect(forAnn).toMatchObject({ id: 's1', hex: '0101', sectorId: 'sec1', name: 'Ardent' });
    expect(forAnn.uwp).toBeUndefined();
    expect(forAnn.gm).toBeUndefined();
    expect(forAnn.known).toBeUndefined();

    const forBob = redact(system, bob, lookup([system])) as any;
    expect(forBob.hex).toBe('0101');
    expect(forBob.name).toBeUndefined();

    const forParty = redact(system, party, lookup([system])) as any;
    expect(forParty.name).toBeUndefined();
  });

  it('filters notes per viewer and never leaks who else knows', () => {
    const titles = (v: Viewer) => ((redact(system, v, lookup([system])) as any).notes ?? []).map((n: any) => n.title);
    expect(titles(ann)).toEqual(['Public']);
    expect(titles(bob)).toEqual(['Public', 'For Bob']);
    expect((redact(system, bob, lookup([system])) as any).notes.every((n: any) => n.known.length === 0)).toBe(true);
    expect(JSON.stringify(redact(system, ann, lookup([system])))).not.toMatch(/traitor|cult|contact/);
  });

  it('hides entities whose base facet is unknown', () => {
    const hidden: StarSystem = { ...system, id: 's2', known: { name: ['party'] } };
    expect(redact(hidden, ann, lookup([hidden]))).toBeNull();
  });

  it('hides a body when its system is hidden, even if the body itself was revealed', () => {
    const body: Body = { ...base, id: 'b1', type: 'body', systemId: 's1', kind: 'planet', orbit: 1, name: 'Ardent', known: { exists: ['party'], name: ['party'] } };
    expect(redact(body, ann, lookup([system, body]))).toMatchObject({ id: 'b1', name: 'Ardent' });
    const hiddenSystem = { ...system, known: {} };
    expect(redact(body, ann, lookup([hiddenSystem, body]))).toBeNull();
  });

  it('keeps personal objectives private to their owner', () => {
    const mine: Objective = { ...base, id: 'o1', type: 'objective', title: 'Find my sister', scope: 'ann', status: 'active', targets: [], createdBy: 'ann' };
    const shared: Objective = { ...mine, id: 'o2', title: 'Deliver the cargo', scope: 'party', createdBy: 'gm1' };
    expect(redact(mine, ann, lookup([]))).toMatchObject({ title: 'Find my sister' });
    expect(redact(mine, bob, lookup([]))).toBeNull();
    expect(redact(shared, bob, lookup([]))).toMatchObject({ title: 'Deliver the cargo' });
  });

  it('shows hidden rolls only to the roller and the GM', () => {
    const roll: Roll = { ...base, id: 'r1', type: 'roll', playerId: 'ann', label: 'Stealth', dice: [3, 4], dm: 1, total: 8, to: [], at: 0 };
    expect(redact(roll, ann, lookup([]))).not.toBeNull();
    expect(redact(roll, bob, lookup([]))).toBeNull();
    expect(redact({ ...roll, to: ['party'] }, bob, lookup([]))).not.toBeNull();
  });

  it('reveals wiki pages section by section and strips spoilers', () => {
    const page: WikiPage = {
      ...base,
      id: 'w1',
      type: 'wikiPage',
      path: 'GM Secrets/Ardent.md',
      title: 'Ardent',
      frontmatter: { ruler: 'Duke Varr', secret_fleet: 12 },
      tags: ['system'],
      hash: 'x',
      sections: [
        { id: '_intro', heading: '', level: 0, body: 'A trade hub. ||The duke is dying.||', known: ['party'] },
        { id: 'history', heading: 'History', level: 2, body: 'Founded 900.', known: ['bob'], spoilersKnown: ['bob'] },
        { id: 'gm-notes', heading: 'GM Notes', level: 2, body: 'Ambush on arrival.', known: ['party'], locked: true },
      ],
    };
    const forAnn = redact(page, ann, lookup([])) as any;
    expect(forAnn.sections.map((s: any) => s.id)).toEqual(['_intro']);
    expect(forAnn.sections[0].body).toBe('A trade hub. ');
    expect(forAnn.path).toBe('');
    expect(forAnn.frontmatter).toEqual({});
    expect(JSON.stringify(forAnn)).not.toMatch(/dying|Ambush|Varr|GM Secrets/);

    const forBob = redact(page, bob, lookup([])) as any;
    expect(forBob.sections.map((s: any) => s.id)).toEqual(['_intro', 'history']);

    const nobody = redact({ ...page, sections: page.sections.map((s) => ({ ...s, known: [] })) }, ann, lookup([]));
    expect(nobody).toBeNull();
  });
});

describe('knowledge helpers', () => {
  it('adds and removes audiences', () => {
    let known = withAudience(undefined, 'exists', 'party', true);
    known = withAudience(known, 'exists', 'ann', true);
    expect(known).toEqual({ exists: ['party', 'ann'] });
    known = withAudience(known, 'exists', 'party', false);
    known = withAudience(known, 'exists', 'ann', false);
    expect(known).toEqual({});
  });

  it('names the preset an audience is at', () => {
    expect(presetFor(undefined, 'party')).toBe('hidden');
    expect(presetFor({ exists: ['party'] }, 'party')).toBe('detected');
    expect(presetFor({ exists: ['party'], name: ['party'], survey: ['party'] }, 'party')).toBe('charted');
    expect(presetFor({ exists: ['party'], name: ['party'] }, 'party')).toBe('custom');
    expect(presetFor({ exists: ['party'] }, 'ann')).toBe('hidden');
  });

  it('strips spoiler spans', () => {
    expect(stripSpoilers('a ||b|| c ||d\ne|| f')).toBe('a  c  f');
  });
});
