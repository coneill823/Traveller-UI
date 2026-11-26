/**
 * The rules reference: topics of rule summaries and tables that a rules pack may carry, for the
 * table to look up and roll on. This file reads a table's roll ("2D", "D66", "1D + DM") and finds
 * the row a result lands on ("7", "3-4", "11+", "2-").
 */
import type { ReferenceTable, ReferenceTopic } from './rulepack';

/** How a table is rolled on: so many six-sided dice, read as a sum, as tens and units, or halved. */
export interface RollPlan {
  dice: number;
  /** 'sum' adds the dice; 'd66' reads two as tens and units; 'd3' halves one die. */
  read: 'sum' | 'd66' | 'd3';
  /** A fixed modifier in the roll itself. */
  add: number;
  /** The roll takes a modifier from the situation. */
  dm: boolean;
}

/** Reads a table's roll. Nothing comes back for text that is not a roll on six-sided dice. */
export function rollPlan(formula: string | undefined): RollPlan | undefined {
  if (!formula) return undefined;
  const m = /^\s*(?:(d66)|(d3)|(\d*)d6?)\s*((?:[+-]\s*(?:\d+|dm)\s*)*)$/i.exec(formula);
  if (!m) return undefined;
  const plan: RollPlan = { dice: m[1] ? 2 : m[2] ? 1 : Number(m[3] || 1), read: m[1] ? 'd66' : m[2] ? 'd3' : 'sum', add: 0, dm: false };
  if (plan.dice < 1 || plan.dice > 20) return undefined;
  for (const part of m[4].matchAll(/([+-])\s*(\d+|dm)/gi)) {
    if (/dm/i.test(part[2])) plan.dm = true;
    else plan.add += (part[1] === '-' ? -1 : 1) * Number(part[2]);
  }
  return plan;
}

/** What the dice come to under a plan, before any modifier from the situation. */
export function readDice(plan: RollPlan, dice: number[]): number {
  if (plan.read === 'd66') return (dice[0] ?? 1) * 10 + (dice[1] ?? 1) + plan.add;
  if (plan.read === 'd3') return Math.ceil((dice[0] ?? 1) / 2) + plan.add;
  return dice.reduce((n, d) => n + d, 0) + plan.add;
}

/**
 * The result of a roll on a table, with the modifier from the situation. As a rule the modifier is simply
 * added; on a D66 table marked for it, it goes on the first die, which cannot fall below 0.
 */
export function tableResult(table: Pick<ReferenceTable, 'dmOnFirstDie'>, plan: RollPlan, dice: number[], dm: number): number {
  if (!plan.dm) return readDice(plan, dice);
  if (table.dmOnFirstDie && plan.read === 'd66') return readDice(plan, [Math.max(0, (dice[0] ?? 1) + dm), dice[1] ?? 1]);
  return readDice(plan, dice) + dm;
}

/** Whether a row's "on" covers a result: "7", "3-4" (or with a dash of any kind), "11+", "2-", or several separated by commas. */
export function rowCovers(on: string | undefined, total: number): boolean {
  if (!on) return false;
  return on.split(',').some((piece) => {
    const text = piece.trim().replace(/[–—−]/g, '-');
    let m = /^(-?\d+)\s*\+$/.exec(text);
    if (m) return total >= Number(m[1]);
    m = /^(-?\d+)\s*-$/.exec(text);
    if (m) return total <= Number(m[1]);
    m = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(text);
    if (m) return total >= Number(m[1]) && total <= Number(m[2]);
    m = /^(-?\d+)$/.exec(text);
    return !!m && total === Number(m[1]);
  });
}

/** A row's "on" as a reader would say it: "1-" is "1 or less", and ranges take a proper dash. */
export function onLabel(on: string | undefined): string {
  if (!on) return '';
  return on
    .split(',')
    .map((piece) => {
      const text = piece.trim().replace(/[–—−]/g, '-');
      let m = /^(-?\d+)\s*-$/.exec(text);
      if (m) return `${m[1]} or less`;
      m = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(text);
      if (m) return `${m[1]}–${m[2]}`;
      return text;
    })
    .join(', ');
}

/** The row of a table that a result lands on. */
export function rowFor(table: ReferenceTable, total: number): number {
  return table.rows.findIndex((row) => rowCovers(row.on, total));
}

/** Topics that mention every word of a search, in their title, group, text or tables. */
export function searchTopics(topics: ReferenceTopic[], query: string): ReferenceTopic[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return topics;
  return topics.filter((topic) => {
    const hay = [topic.title, topic.group, topic.source ?? '', ...(topic.text ?? []), ...(topic.tables ?? []).flatMap((t) => [t.title ?? '', ...t.columns, ...t.rows.flatMap((r) => r.cells)])].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A list with more topics than this opens folded: one heading to a group, unfolded when chosen. */
export const FOLD_ABOVE = 30;

/**
 * The groups of the topic list that are unfolded: those remembered from last time, or, with nothing
 * remembered, all of them for a short list and none for a long one.
 */
export function openGroups(groups: { group: string; items: unknown[] }[], remembered?: string[]): Set<string> {
  if (remembered) return new Set(remembered.filter((name) => groups.some((g) => g.group === name)));
  const topics = groups.reduce((n, g) => n + g.items.length, 0);
  return new Set(topics > FOLD_ABOVE ? [] : groups.map((g) => g.group));
}

/** Problems with a pack's topics that would trip the reference screen up: rows that no roll reaches, clashes, short rows. */
export function topicProblems(topics: ReferenceTopic[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const topic of topics) {
    if (seen.has(topic.id)) problems.push(`${topic.id}: listed twice`);
    seen.add(topic.id);
    if (!topic.text?.length && !topic.tables?.length) problems.push(`${topic.id}: nothing in it`);
    for (const table of topic.tables ?? []) {
      const where = `${topic.id}/${table.id}`;
      for (const row of table.rows) if (row.cells.length !== table.columns.length - (table.roll ? 1 : 0)) problems.push(`${where}: a row of ${row.cells.length} cells under ${table.columns.length} headings`);
      if (!table.roll) continue;
      const plan = rollPlan(table.roll);
      if (!plan) {
        problems.push(`${where}: cannot read the roll "${table.roll}"`);
        continue;
      }
      // every result the dice alone can give lands on exactly one row
      const results: number[] = [];
      if (plan.read === 'd66') for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) results.push(a * 10 + b + plan.add);
      else if (plan.read === 'd3') results.push(1 + plan.add, 2 + plan.add, 3 + plan.add);
      else for (let n = plan.dice; n <= plan.dice * 6; n++) results.push(n + plan.add);
      for (const result of results) {
        const hits = table.rows.filter((row) => rowCovers(row.on, result)).length;
        if (hits !== 1) problems.push(`${where}: a roll of ${result} lands on ${hits} rows`);
      }
    }
  }
  return problems;
}
