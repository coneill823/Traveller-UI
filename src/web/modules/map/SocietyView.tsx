/**
 * The people of a mainworld in depth, as a survey of its society records them: how many and where,
 * how they are ruled and by which factions, what the law allows, what their technology runs to,
 * their culture, their economy and their port. Also the short entry for a lesser settlement.
 */
import type { ReactNode } from 'react';
import type { Settlement, Society } from '../../../shared/types';
import { ehexChar } from '../../../shared/uwp';
import { useRules } from '../../store';

const people = (n: number): string => {
  if (n >= 1e12) return `${Number((n / 1e12).toPrecision(3))} trillion`;
  if (n >= 1e9) return `${Number((n / 1e9).toPrecision(3))} billion`;
  if (n >= 1e6) return `${Number((n / 1e6).toPrecision(3))} million`;
  return Math.round(n).toLocaleString('en-GB');
};
const credits = (n: number): string => {
  if (Math.abs(n) >= 1e12) return `Cr${Number((n / 1e12).toPrecision(3))} trillion`;
  if (Math.abs(n) >= 1e9) return `Cr${Number((n / 1e9).toPrecision(3))} billion`;
  if (Math.abs(n) >= 1e6) return `Cr${Number((n / 1e6).toPrecision(3))} million`;
  return `Cr${Math.round(n).toLocaleString('en-GB')}`;
};

function Rows({ title, profile, rows }: { title: string; profile?: string; rows: [string, ReactNode][] }) {
  if (rows.length === 0) return null;
  return (
    <div className="section">
      <h3>
        {title}
        {profile && <span className="mono faint" style={{ marginLeft: 8, fontSize: 11, letterSpacing: 0 }}>{profile}</span>}
      </h3>
      <dl className="kv">
        {rows.map(([label, value], i) => (
          <div key={`${label}${i}`} style={{ display: 'contents' }}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A level on a scale with what it means beneath it. */
const level = (n: number, note?: string): ReactNode => (
  <>
    <span className="mono">{ehexChar(n)}</span>
    {note && <span className="small faint"> · {note}</span>}
  </>
);

function useGovernmentName(): (code: number) => string {
  const governments = useRules().world?.government;
  return (code) => governments?.find((g) => g.code === code)?.name ?? `Government ${ehexChar(code)}`;
}

export function SocietyView({ society }: { society: Society }) {
  const governmentName = useGovernmentName();
  const { people: p, government: g, law: l, tech: t, culture: c, economy: e, port } = society;

  const who: [string, ReactNode][] = [];
  if (p) {
    who.push(['Population', people(p.total)]);
    who.push(['Spread', `${p.pcrName ?? `Concentration ${p.pcr}`} · ${p.urban}% in towns`]);
    if (p.cities > 0) who.push([p.cities === 1 ? 'City' : 'Cities', p.cities === 1 ? `One, of ${people(p.cityPeople)}` : `${p.cities} major cities holding ${people(p.cityPeople)}`]);
    else who.push(['Cities', 'None of any size']);
    if (p.largest?.length && p.cities !== 1) who.push([p.cities === 0 ? 'Largest town' : 'Largest', p.largest.map(people).join(', ')]);
  }

  const rule: [string, ReactNode][] = [];
  if (g) {
    if (g.nations) rule.push(['States', `${g.nations.length}: ${g.nations.map(governmentName).join('; ')}`]);
    if (g.host !== undefined) rule.push(['By the starport', governmentName(g.host)]);
    if (g.centralisationName) rule.push(['Shape', `${g.centralisationName}${g.authorityName ? ` · ${g.authorityName === 'Balance' ? 'power is balanced' : `the ${g.authorityName.toLowerCase()} leads`}` : ''}`]);
    for (const s of g.structure ?? []) rule.push([s.functionName, s.name]);
    for (const [i, f] of (g.factions ?? []).entries()) rule.push([i === 0 ? 'Factions' : '', `${governmentName(f.government)} · ${(f.strengthName ?? '').toLowerCase()} · ${(f.relationName ?? '').toLowerCase()} with the rulers`]);
  }

  const courts: [string, ReactNode][] = [];
  if (l) {
    if (l.justiceName) courts.push(['Courts', `${l.justiceName}${l.economicCourts ? ' · trade matters go to administrative courts' : ''}`]);
    if (l.uniformityName) courts.push(['Reach', l.uniformityName]);
    courts.push(['Accused', `${l.presumption ? 'Presumed innocent' : 'Presumed guilty'} · ${l.death ? 'death penalty in use' : 'no death penalty'}`]);
    for (const part of l.parts) courts.push([part.name, level(part.level, part.note)]);
  }

  const tech: [string, ReactNode][] = [];
  if (t) {
    if (t.least) tech.push(['To live here', `TL${t.least} at least`]);
    for (const part of t.parts) tech.push([part.name, level(part.level, part.note)]);
  }

  const ways: [string, ReactNode][] = (c ?? []).map((trait) => [trait.name, level(trait.level, trait.leaning)]);

  const trade: [string, ReactNode][] = [];
  if (e) {
    trade.push(['Importance', (e.importance > 0 ? '+' : '') + e.importance]);
    trade.push(['Product', `${credits(e.gwpPerHead)} a head · ${credits(e.gwp)} in all`]);
    trade.push(['Factors', <span key="f" title="Resources, labour, infrastructure and efficiency, and the resource units they multiply to">{`R ${e.resource} · L ${e.labour} · I ${e.infrastructure} · E ${e.efficiency > 0 ? '+' : ''}${e.efficiency} · ${e.ru.toLocaleString('en-GB')} RU`}</span>]);
    trade.push(['Trade number', String(e.wtn)]);
    trade.push(['Inequality', `${e.inequality} of 100 · development ${e.development}`]);
    if (e.tariff) trade.push(['Tariffs', `${e.tariff}${e.tariffRate !== undefined ? ` · ${e.tariffRate}%` : ''}`]);
  }
  if (port) {
    trade.push(['Highport', port.highport ? 'Yes' : 'No']);
    if (port.standing) trade.push(['Shipping', `${port.standing} · about ${port.weekly?.toLocaleString('en-GB')} ships a week`]);
  }

  return (
    <>
      <Rows title="People" rows={who} />
      <Rows title="Rule" profile={g?.profile} rows={rule} />
      <Rows title="Law" profile={l?.profile} rows={courts} />
      <Rows title="Technology" profile={t?.profile} rows={tech} />
      <Rows title="Culture" rows={ways} />
      <Rows title="Economy and port" rows={trade} />
    </>
  );
}

/** The people of a lesser world of the system. */
export function SettlementRows({ settlement }: { settlement: Settlement }) {
  const governmentName = useGovernmentName();
  const s = settlement;
  const rows: [string, ReactNode][] = [
    ['Profile', <span key="p" className="mono">{s.profile}</span>],
    ['People', s.pop <= 1 ? 'A few dozen' : `About ${people(10 ** s.pop)} or more`],
    ['Run as', `${governmentName(s.gov)} · law level ${ehexChar(s.law)} · TL${s.tl}`],
    ['Spaceport', `Class ${s.port}${s.portName ? ` · ${s.portName.charAt(0).toLowerCase()}${s.portName.slice(1)}` : ''}`],
  ];
  if (s.classes?.length) rows.push(['Here for', s.classes.map((c) => c.name).join(', ')]);
  return <Rows title="Settlement" rows={rows} />;
}
