/** The rules reference: reading a table's roll, finding the row a result lands on, searching topics. */
import { describe, expect, it } from 'vitest';
import { FOLD_ABOVE, onLabel, openGroups, readDice, rollPlan, rowCovers, rowFor, searchTopics, tableResult, topicProblems } from '../src/shared/reference';
import { mergePacks, type ReferenceTopic, type RulePack } from '../src/shared/rulepack';
import { hasPack, HAS_CORE_RULES, loadPacks } from './helpers';

// made up for the test
const topics: ReferenceTopic[] = [
  {
    id: 'weather', title: 'Weather at sea', group: 'Voyages', source: 'House rules', optional: true,
    text: ['Roll each morning.', 'A storm doubles the time a crossing takes.'],
    tables: [
      { id: 'sky', title: 'The sky', roll: '2D + DM', columns: ['2D', 'Sky', 'Wind'], rows: [{ on: '4-', cells: ['Storm', 'Gale'] }, { on: '5–8', cells: ['Cloud', 'Fresh'] }, { on: '9-11', cells: ['Fair', 'Light'] }, { on: '12+', cells: ['Dead calm', 'None'] }] },
      { id: 'omens', roll: 'D66', columns: ['D66', 'Omen'], rows: [{ on: '11-36', cells: ['Gulls'] }, { on: '41-65', cells: ['Dolphins'] }, { on: '66', cells: ['A green flash'] }] },
    ],
  },
  { id: 'rations', title: 'Short rations', group: 'Voyages', text: ['Each week on half rations costs a point of Endurance.'], tables: [{ id: 'stores', columns: ['Store', 'Lasts'], rows: [{ cells: ['Biscuit', 'A year'] }, { cells: ['Fruit', 'A week'] }] }] },
  { id: 'duels', title: 'Duels', group: 'Honour', text: ['To first blood unless agreed otherwise.'] },
];

describe('the rules reference', () => {
  it('reads how a table is rolled on', () => {
    expect(rollPlan('2D')).toEqual({ dice: 2, read: 'sum', add: 0, dm: false });
    expect(rollPlan('1D + DM')).toEqual({ dice: 1, read: 'sum', add: 0, dm: true });
    expect(rollPlan('3d6-2')).toEqual({ dice: 3, read: 'sum', add: -2, dm: false });
    expect(rollPlan('D')).toEqual({ dice: 1, read: 'sum', add: 0, dm: false });
    expect(rollPlan('2D - 7 + DM')).toEqual({ dice: 2, read: 'sum', add: -7, dm: true });
    expect(rollPlan('D66')).toEqual({ dice: 2, read: 'd66', add: 0, dm: false });
    expect(rollPlan('d3 + 1')).toEqual({ dice: 1, read: 'd3', add: 1, dm: false });
    expect(rollPlan('a guess')).toBeUndefined();
    expect(rollPlan('d10')).toBeUndefined();
    expect(rollPlan(undefined)).toBeUndefined();
    expect(readDice(rollPlan('2D - 7')!, [6, 5])).toBe(4);
    expect(readDice(rollPlan('D66')!, [4, 2])).toBe(42);
    expect(readDice(rollPlan('D3')!, [1])).toBe(1);
    expect(readDice(rollPlan('D3')!, [4])).toBe(2);
    expect(readDice(rollPlan('D3 + 1')!, [6])).toBe(4);
  });

  it('finds the row a result lands on', () => {
    expect(rowCovers('7', 7)).toBe(true);
    expect(rowCovers('7', 8)).toBe(false);
    expect(rowCovers('3-4', 4)).toBe(true);
    expect(rowCovers('3–4', 5)).toBe(false);
    expect(rowCovers('11+', 14)).toBe(true);
    expect(rowCovers('2-', 0)).toBe(true);
    expect(rowCovers('2-', 3)).toBe(false);
    expect(rowCovers('-3 - -1', -2)).toBe(true);
    expect(rowCovers('2, 12', 12)).toBe(true);
    expect(rowCovers('odd', 3)).toBe(false);
    expect(rowCovers(undefined, 3)).toBe(false);
    const sky = topics[0].tables![0];
    expect([2, 4, 5, 8, 9, 11, 12, 15].map((n) => rowFor(sky, n))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(rowFor(topics[0].tables![1], 66)).toBe(2);
    expect(rowFor(topics[0].tables![1], 37)).toBe(-1);
    // the modifier is added to the total, or on a table marked for it to the first die of a D66
    expect(tableResult({}, rollPlan('2D + DM')!, [3, 4], -2)).toBe(5);
    expect(tableResult({}, rollPlan('2D')!, [3, 4], -2)).toBe(7);
    expect(tableResult({}, rollPlan('D66 + DM')!, [3, 4], 2)).toBe(36);
    expect(tableResult({ dmOnFirstDie: true }, rollPlan('D66 + DM')!, [3, 4], 2)).toBe(54);
    expect(tableResult({ dmOnFirstDie: true }, rollPlan('D66 + DM')!, [6, 1], 3)).toBe(91);
    expect(tableResult({ dmOnFirstDie: true }, rollPlan('D66 + DM')!, [2, 5], -4)).toBe(5);
    expect(tableResult({ dmOnFirstDie: true }, rollPlan('2D + DM')!, [2, 5], -4)).toBe(3);
    expect(['4-', '5–8', '9-11', '12+', '7', '2, 12', '-3 - -1', undefined].map(onLabel)).toEqual(['4 or less', '5–8', '9–11', '12+', '7', '2, 12', '-3–-1', '']);
  });

  it('searches titles, text and tables', () => {
    expect(searchTopics(topics, '').map((t) => t.id)).toEqual(['weather', 'rations', 'duels']);
    expect(searchTopics(topics, 'STORM').map((t) => t.id)).toEqual(['weather']);
    expect(searchTopics(topics, 'voyages week').map((t) => t.id)).toEqual(['rations']);
    expect(searchTopics(topics, 'dolphins').map((t) => t.id)).toEqual(['weather']);
    expect(searchTopics(topics, 'honour').map((t) => t.id)).toEqual(['duels']);
    expect(searchTopics(topics, 'kraken')).toEqual([]);
  });

  it('spots tables the dice do not fit', () => {
    expect(topicProblems(topics)).toEqual([]);
    const broken: ReferenceTopic[] = [
      { id: 'a', title: 'A', group: 'G', tables: [{ id: 'gap', roll: '1D', columns: ['1D', 'What'], rows: [{ on: '1-2', cells: ['x'] }, { on: '4+', cells: ['y'] }] }] },
      { id: 'a', title: 'Again', group: 'G', text: ['t'] },
      { id: 'b', title: 'B', group: 'G', tables: [{ id: 'twice', roll: '1D', columns: ['1D', 'What'], rows: [{ on: '1-4', cells: ['x'] }, { on: '4+', cells: ['y', 'z'] }] }, { id: 'odd', roll: 'whenever', columns: ['?'], rows: [] }] },
      { id: 'c', title: 'C', group: 'G' },
    ];
    expect(topicProblems(broken)).toEqual([
      'a/gap: a roll of 3 lands on 0 rows',
      'a: listed twice',
      'b/twice: a row of 2 cells under 2 headings',
      'b/twice: a roll of 4 lands on 2 rows',
      'b/odd: cannot read the roll "whenever"',
      'c: nothing in it',
    ]);
  });

  it('folds a long list of topics and leaves a short one open', () => {
    const short = [{ group: 'Voyages', items: [1, 2] }, { group: 'Honour', items: [3] }];
    expect([...openGroups(short)]).toEqual(['Voyages', 'Honour']);
    const long = [{ group: 'Voyages', items: Array.from({ length: FOLD_ABOVE }, (_, i) => i) }, { group: 'Honour', items: [0] }];
    expect([...openGroups(long)]).toEqual([]);
    // what the viewer left open comes back, less any heading that is no longer there
    expect([...openGroups(long, ['Honour', 'Gone'])]).toEqual(['Honour']);
    expect([...openGroups(short, [])]).toEqual([]);
  });

  it('lets one pack add topics to another', () => {
    const base = { packs: [], reference: { topics: topics.slice(0, 2) } } as RulePack;
    const more = { packs: [], reference: { topics: [topics[2], { ...topics[1], title: 'Hard tack' }] } } as RulePack;
    const merged = mergePacks(base, more).reference!.topics;
    expect(merged.map((t) => [t.id, t.title])).toEqual([['weather', 'Weather at sea'], ['rations', 'Hard tack'], ['duels', 'Duels']]);
  });
});

/** The topics of the installed packs, wherever any carry some: every table must fit its dice. */
describe.skipIf(!HAS_CORE_RULES)('the reference topics of the installed packs', () => {
  const names = ['mgt2-core', 'mgt2-companion', 'mgt2-screens'].filter((n) => n === 'mgt2-core' || hasPack(n));
  const all = HAS_CORE_RULES ? (loadPacks(...names).reference?.topics ?? []) : [];

  it('have no table the dice do not fit, and nothing empty', () => {
    expect(topicProblems(all)).toEqual([]);
    for (const topic of all) {
      expect(topic.group, topic.id).toBeTruthy();
      expect(topic.title, topic.id).toBeTruthy();
    }
  });
});
