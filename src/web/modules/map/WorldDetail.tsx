/**
 * A world, moon or belt in detail, as a full survey records it: what it is made of, its air and
 * water, its days and climate, its geology, anything living there, and what it is worth.
 */
import type { ReactNode } from 'react';
import type { Body, BodyDetail } from '../../../shared/types';
import { SettlementRows } from './SocietyView';

const num = (n: number, digits = 3) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-GB') : String(Number(n.toPrecision(digits))));
const kelvin = (k: number) => `${Math.round(k).toLocaleString('en-GB')} K (${Math.round(k - 273).toLocaleString('en-GB')} °C)`;

/** A span of hours in the unit that reads best. */
function hoursText(hours: number): string {
  const h = Math.abs(hours);
  if (h < 100) return `${num(h)} hours`;
  const days = h / 24;
  if (days < 1000) return `${num(days)} days`;
  return `${num(days / 365.25)} years`;
}

const LOCK_TEXT: Record<string, string> = {
  star: 'Keeps one face to its sun: no day or night',
  planet: 'Keeps one face to its world',
  moon: 'Turns in step with its moon',
};

function Rows({ title, rows }: { title: string; rows: [string, ReactNode][] }) {
  if (rows.length === 0) return null;
  return (
    <div className="section">
      <h3>{title}</h3>
      <dl className="kv">
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function WorldDetail({ body, detail }: { body: Body; detail: BodyDetail }) {
  const d = detail;
  const world: [string, ReactNode][] = [];
  if (d.sah && !body.mainworld) world.push(['Profile', <span key="sah" title="Size, atmosphere and hydrographics">{d.sah}</span>]);
  if (d.km) world.push(['Diameter', `${d.km.toLocaleString('en-GB')} km`]);
  if (d.composition) world.push(['Made of', `${d.composition}${d.density !== undefined ? ` · ${d.density} of Earth's density` : ''}`]);
  if (d.gravity !== undefined) world.push(['Gravity', `${d.gravity} G`]);
  if (d.mass !== undefined && body.kind !== 'gasGiant') world.push(['Mass', `${num(d.mass)} Earths`]);
  if (d.escape !== undefined) world.push(['Escape velocity', `${d.escape} km/s`]);
  if (d.moon) {
    world.push(['Circles at', `${d.moon.pd} planetary diameters · ${d.moon.km.toLocaleString('en-GB')} km`]);
    world.push(['Once round', `${hoursText(d.moon.hours)}${d.moon.retro ? ', backwards' : ''}${d.moon.ecc ? ` · eccentricity ${d.moon.ecc}` : ''}`]);
  }
  if (d.ringSpans?.length) world.push([d.ringSpans.length === 1 ? 'Ring' : 'Rings', d.ringSpans.map((r) => `${num(r.centre - r.span / 2)}–${num(r.centre + r.span / 2)}`).join(', ') + ' planetary diameters out']);

  const air: [string, ReactNode][] = [];
  if (d.atm && body.kind !== 'gasGiant') {
    const a = d.atm;
    air.push(['Atmosphere', `${a.name}${a.subName ? ` · ${a.subName.toLowerCase()}` : ''}`]);
    if (a.bar !== undefined) air.push(['Pressure', `${num(a.bar)} bar${a.scale ? ` · thins by two thirds every ${a.scale} km up` : ''}`]);
    if (a.ppo !== undefined && a.bar) air.push(['Oxygen', `${a.ppo} bar (${Math.round((a.ppo / a.bar) * 100)}%)${a.oxygen === 'low' ? ' · too little to breathe' : a.oxygen === 'high' ? ' · too much to breathe for long' : ''}`]);
    if (a.gases?.length && a.ppo === undefined) air.push(['Mostly', a.gases.map((g) => `${g.gas.toLowerCase()} ${g.pct}%`).join(', ')]);
    for (const [i, t] of (a.taints ?? []).entries()) air.push([i === 0 ? (a.ppo !== undefined ? 'Taint' : 'Irritant') : ' '.repeat(i), `${t.name}${t.severityName ? ` · ${t.severityName.toLowerCase()}` : ''}${t.persistenceName ? `, ${t.persistenceName.toLowerCase()}` : ''}`]);
    if (a.hazard) air.push(['Hazard', a.hazardName ?? a.hazard]);
    if (a.runaway) air.push(['History', 'Its seas boiled away into the air']);
    if (a.gear) air.push(['Needed', a.gear]);
  }

  const water: [string, ReactNode][] = [];
  if (d.hydro && (d.hydro.code > 0 || d.hydro.pct > 0)) {
    // water freezes at 273 K and boils at 373 K: outside that, with no other liquid named, it is ice or something unknown
    const what = d.hydro.liquid ? d.hydro.liquid.toLowerCase() : !d.temp ? 'water' : (d.temp.high ?? d.temp.mean) < 273 ? 'ice' : d.temp.mean > 373 ? 'liquid of some kind' : 'water';
    water.push(['Surface', `${d.hydro.pct}% ${what}`]);
    if (d.hydro.surface) water.push(['Lie of the land', d.hydro.surface]);
  }

  const days: [string, ReactNode][] = [];
  if (d.day) {
    const locked = d.day.lock ? (LOCK_TEXT[d.day.lock] ?? `Turns ${d.day.lock} with its orbit`) : undefined;
    days.push(['Day', `${hoursText(d.day.hours)}${d.day.hours < 0 ? ', turning backwards' : ''}`]);
    if (d.day.solar !== undefined && Math.abs(d.day.solar - Math.abs(d.day.hours)) / Math.abs(d.day.hours) > 0.005) days.push(['Noon to noon', hoursText(d.day.solar)]);
    if (locked) days.push(['Held', locked]);
    days.push(['Axial tilt', `${d.day.tilt}°`]);
  }
  if (d.tide !== undefined && d.tide >= 0.05) days.push(['Tides', `${num(d.tide, 2)} m on open water`]);

  const climate: [string, ReactNode][] = [];
  if (d.temp) {
    climate.push(['Mean', kelvin(d.temp.mean)]);
    if (d.temp.low !== undefined && d.temp.high !== undefined && d.temp.high - d.temp.low >= 2) climate.push(['Range', `${Math.round(d.temp.low - 273).toLocaleString('en-GB')} to ${Math.round(d.temp.high - 273).toLocaleString('en-GB')} °C`]);
    if (d.temp.albedo !== undefined) climate.push(['Reflects', `${Math.round(d.temp.albedo * 100)}% of its light${d.temp.greenhouse ? ` · greenhouse factor ${d.temp.greenhouse}` : ''}`]);
  }

  const ground: [string, ReactNode][] = [];
  if (d.seismic) {
    ground.push(['Activity', `${d.seismic.activity ? `${d.seismic.activity} · ` : ''}stress ${num(d.seismic.total)}`]);
    if (d.seismic.heating >= 1) ground.push(['Tidal heating', num(d.seismic.heating)]);
    if (d.seismic.plates) ground.push(['Plates', `${d.seismic.plates} major plates`]);
  }

  const life: [string, ReactNode][] = [];
  if (d.life) {
    life.push(['Biomass', String(d.life.biomass)]);
    life.push(['Complexity', `${d.life.complexity}${d.life.complexityName ? ` · ${d.life.complexityName.toLowerCase()}` : ''}`]);
    life.push(['Diversity', String(d.life.diversity)]);
    life.push(['Compatibility', `${d.life.compatibility}${d.life.compatibility === 0 ? ' · nothing here can be eaten' : ''}`]);
    if (d.life.sophonts) life.push(['Sophonts', d.life.sophonts === 'living' ? 'A native people lives here' : 'A native people once lived here']);
  }

  const worth: [string, ReactNode][] = [];
  if (d.resources !== undefined && !d.belt) worth.push(['Resources', String(d.resources)]);
  if (d.habitability !== undefined) worth.push(['Habitability', String(d.habitability)]);

  const belt: [string, ReactNode][] = [];
  if (d.belt) {
    const b = d.belt;
    belt.push(['Width', `${b.span} orbit numbers`]);
    belt.push(['Bodies', [`${b.m}% metallic`, `${b.s}% stony`, `${b.c}% icy`, ...(b.other ? [`${b.other}% other`] : [])].join(', ')]);
    belt.push(['Bulk', String(b.bulk)]);
    belt.push(['Resources', String(b.resources)]);
    belt.push(['Largest bodies', `${b.size1} of size 1, ${b.sizeS} smaller dwarf worlds`]);
  }

  return (
    <>
      <Rows title={body.kind === 'belt' ? 'The belt' : 'The world'} rows={[...world, ...belt]} />
      <Rows title="Air" rows={air} />
      <Rows title="Water" rows={water} />
      <Rows title="Days" rows={days} />
      <Rows title="Climate" rows={climate} />
      <Rows title="Ground" rows={ground} />
      <Rows title="Life" rows={life} />
      <Rows title="Worth" rows={worth} />
      {d.settlement && <SettlementRows settlement={d.settlement} />}
    </>
  );
}
