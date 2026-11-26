/**
 * The rules reference in the library: topics of rule summaries from the installed rules packs,
 * filed under headings, with tables that can be rolled on from the shared dice.
 */
import { useEffect, useMemo, useState } from 'react';
import { onLabel, openGroups, rollPlan, rowFor, searchTopics, tableResult } from '../../../shared/reference';
import type { ReferenceTable, ReferenceTopic } from '../../../shared/rulepack';
import { act } from '../../net';
import { Link } from '../../router';
import { toast, useRules } from '../../store';
import { cx, Empty } from '../../ui/basics';
import { Icon } from '../../ui/Icon';

/** The topics of the installed packs, as headings each with its topics in order. */
export function useReference(query: string): { topics: ReferenceTopic[]; groups: { group: string; items: ReferenceTopic[] }[] } {
  const topics = useRules().reference?.topics;
  return useMemo(() => {
    const all = topics ?? [];
    const byGroup = new Map<string, ReferenceTopic[]>();
    for (const topic of searchTopics(all, query)) byGroup.set(topic.group, [...(byGroup.get(topic.group) ?? []), topic]);
    return { topics: all, groups: [...byGroup.entries()].map(([group, items]) => ({ group, items })) };
  }, [topics, query]);
}

const OPEN_KEY = 'traveller-ui.rules.open';

/** The headings this viewer left unfolded last time, if the browser kept them. */
function rememberedOpen(): string[] | undefined {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'null');
    return Array.isArray(kept) ? kept.filter((name): name is string => typeof name === 'string') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The topics under their headings. A long list starts folded, one line to a heading; a heading unfolds when
 * chosen, and the choice is remembered in this browser. A search shows every match, unfolded.
 */
export function RulesList({ groups, topicId, current, searching }: { groups: { group: string; items: ReferenceTopic[] }[]; topicId?: string; /** The heading the open topic is filed under. */ current?: string; searching?: boolean }) {
  // undefined until the viewer folds or unfolds something: until then the list decides for itself
  const [chosen, setChosen] = useState<Set<string> | undefined>(() => {
    const kept = rememberedOpen();
    return kept ? new Set(kept) : undefined;
  });
  const open = useMemo(() => chosen ?? openGroups(groups), [chosen, groups]);

  const keep = (next: Set<string>) => {
    setChosen(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
    } catch {
      // not remembered, then; the list still works
    }
  };
  // arriving at a topic unfolds its heading
  useEffect(() => {
    if (current && !open.has(current)) keep(new Set([...open, current]));
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {groups.map((g) => {
        const shown = searching || open.has(g.group);
        return (
          <div key={g.group}>
            {searching ? (
              <div className="library-folder">{g.group}</div>
            ) : (
              <button
                className="library-folder fold"
                aria-expanded={shown}
                onClick={() => keep(new Set(shown ? [...open].filter((name) => name !== g.group) : [...open, g.group]))}
              >
                <Icon name={shown ? 'chevronDown' : 'chevronRight'} size={10} />
                <span className="grow">{g.group}</span>
                <span className="count">{g.items.length}</span>
              </button>
            )}
            {shown &&
              g.items.map((topic) => (
                <Link key={topic.id} to={`/library/rules/${topic.id}`} className={cx('library-item', topic.id === topicId && 'on')}>
                  <Icon name="book" size={13} />
                  <span className="grow">{topic.title}</span>
                  {topic.optional && <span className="tiny faint">optional</span>}
                </Link>
              ))}
          </div>
        );
      })}
    </>
  );
}

function Table({ topic, table }: { topic: ReferenceTopic; table: ReferenceTable }) {
  const plan = rollPlan(table.roll);
  const [dm, setDm] = useState(0);
  const [result, setResult] = useState<{ total: number; row: number } | undefined>();
  const [busy, setBusy] = useState(false);

  const roll = async () => {
    if (!plan || busy) return;
    setBusy(true);
    try {
      // the dice are rolled where everyone can see them; a modifier in the roll itself is applied here
      const rolled = await act<{ dice: number[] }>('dice.roll', { dice: plan.dice, label: `${topic.title}${table.title ? `: ${table.title}` : ''}`, dm: plan.read === 'sum' ? plan.add + (plan.dm ? dm : 0) : 0 });
      const total = tableResult(table, plan, rolled.dice, dm);
      setResult({ total, row: rowFor(table, total) });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rules-table">
      {(table.title || plan) && (
        <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
          {table.title && <h4 style={{ margin: 0 }}>{table.title}</h4>}
          <div className="grow" />
          {plan?.dm && (
            <label className="row tiny dim" style={{ gap: 4, alignItems: 'center' }}>
              {table.dmOnFirstDie ? 'DM on the first die' : 'DM'}
              <input type="number" value={dm} onChange={(e) => setDm(Math.max(-20, Math.min(20, Math.round(Number(e.target.value) || 0))))} style={{ width: 52 }} aria-label="Modifier" />
            </label>
          )}
          {plan && (
            <button className="btn sm" disabled={busy} onClick={() => void roll()} title={`Roll ${table.roll}`}>
              <Icon name="dice" size={12} /> Roll {table.roll?.replace(/\s*\+\s*DM/i, '')}
            </button>
          )}
          {result && <span className="mono">{result.total}</span>}
        </div>
      )}
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i} className={cx(result?.row === i && 'rolled')}>
                {table.roll && <td className="mono nowrap">{onLabel(row.on)}</td>}
                {row.cells.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.note && <div className="tiny faint" style={{ marginTop: 4 }}>{table.note}</div>}
    </div>
  );
}

export function RulesTopic({ topic }: { topic: ReferenceTopic }) {
  return (
    <article className="wiki-page rules-topic">
      <header className="wiki-head">
        <div>
          <div className="eyebrow">{topic.group}</div>
          <h1>{topic.title}</h1>
          <div className="tiny faint">
            {topic.optional ? 'An optional rule' : 'Rules summary'}
            {topic.source ? ` · ${topic.source}` : ''}
          </div>
        </div>
      </header>
      {(topic.text ?? []).map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
      {(topic.tables ?? []).map((table) => (
        <Table key={table.id} topic={topic} table={table} />
      ))}
    </article>
  );
}

export function RulesEmpty({ any }: { any: boolean }) {
  return (
    <Empty icon="book" title="Rules reference">
      {any ? 'Choose a topic on the left. Tables with a roll can be rolled from here, on the shared dice.' : 'The installed rules packs carry no reference topics.'}
    </Empty>
  );
}
