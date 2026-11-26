/**
 * The rules reference in the library: topics of rule summaries from the installed rules packs,
 * filed under headings, with tables that can be rolled on from the shared dice.
 */
import { useMemo, useState } from 'react';
import { onLabel, readDice, rollPlan, rowFor, searchTopics } from '../../../shared/reference';
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

export function RulesList({ groups, topicId }: { groups: { group: string; items: ReferenceTopic[] }[]; topicId?: string }) {
  return (
    <>
      {groups.map((g) => (
        <div key={g.group}>
          <div className="library-folder">{g.group}</div>
          {g.items.map((topic) => (
            <Link key={topic.id} to={`/library/rules/${topic.id}`} className={cx('library-item', topic.id === topicId && 'on')}>
              <Icon name="book" size={13} />
              <span className="grow">{topic.title}</span>
              {topic.optional && <span className="tiny faint">optional</span>}
            </Link>
          ))}
        </div>
      ))}
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
      const total = readDice(plan, rolled.dice) + (plan.dm ? dm : 0);
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
              DM
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
