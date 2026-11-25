/** GM tools for the shape of the universe: add and place sectors, name subsectors, bulk actions. */
import { useMemo, useState } from 'react';
import { SUBSECTOR_LETTERS, galacticDirection } from '../../../shared/hex';
import { PRESETS } from '../../../shared/knowledge';
import { PARTY, type Sector } from '../../../shared/types';
import { act, run, setFields } from '../../net';
import { toast, useType } from '../../store';
import { ConfirmButton, cx, Field, Modal } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { GenerateDialog, ImportDialog } from './ImportDialog';
import { fitTo } from './mapStore';

/** Free positions next to existing sectors (or the origin when there are none). */
export function freeSlots(sectors: Sector[]): { x: number; y: number }[] {
  if (sectors.length === 0) return [{ x: 0, y: 0 }];
  const taken = new Set(sectors.map((s) => `${s.x},${s.y}`));
  const out = new Map<string, { x: number; y: number }>();
  for (const s of sectors) {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const key = `${s.x + dx},${s.y + dy}`;
      if (!taken.has(key)) out.set(key, { x: s.x + dx, y: s.y + dy });
    }
  }
  return [...out.values()];
}

function PositionPicker({ sectors, value, onChange, moving }: { sectors: Sector[]; value: { x: number; y: number }; onChange: (p: { x: number; y: number }) => void; moving?: string }) {
  const others = sectors.filter((s) => s.id !== moving);
  const xs = [...others.map((s) => s.x), value.x];
  const ys = [...others.map((s) => s.y), value.y];
  const x0 = Math.min(...xs) - 1;
  const x1 = Math.max(...xs) + 1;
  const y0 = Math.min(...ys) - 1;
  const y1 = Math.max(...ys) + 1;
  const cells = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const sector = others.find((s) => s.x === x && s.y === y);
      const selected = value.x === x && value.y === y;
      cells.push(
        <button key={`${x},${y}`} type="button" className={cx('slot', sector && 'taken', selected && 'on')} disabled={!!sector} onClick={() => onChange({ x, y })} title={sector ? sector.name : `Position ${x}, ${y}`}>
          {sector ? sector.name : selected ? 'Here' : '+'}
        </button>,
      );
    }
  }
  return (
    <div className="col gap-4">
      <div className="slot-grid" style={{ gridTemplateColumns: `repeat(${x1 - x0 + 1}, minmax(0, 1fr))` }}>
        {cells}
      </div>
      <div className="row between tiny faint">
        <span>← Spinward</span>
        <span>Coreward ↑ · Rimward ↓</span>
        <span>Trailing →</span>
      </div>
    </div>
  );
}

export function NewSectorDialog({ at, onClose }: { at?: { x: number; y: number }; onClose: () => void }) {
  const sectors = useType('sector');
  const [name, setName] = useState('');
  const [abbr, setAbbr] = useState('');
  const [pos, setPos] = useState(at ?? freeSlots(sectors)[0]);
  const create = async () => {
    try {
      const res = await act<{ id: string }>('sector.create', { name: name.trim(), abbr: abbr.trim() || undefined, x: pos.x, y: pos.y });
      fitTo({ kind: 'sector', id: res.id });
      toast(`${name.trim()} added. Import or generate its systems from the Sectors panel.`, 'ok');
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const nearest = sectors[0];
  return (
    <Modal
      title="New sector"
      icon="hex"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>
            Create sector
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <div className="grid-2" style={{ gridTemplateColumns: '2fr 1fr' }}>
          <Field label="Sector name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kestrel Reach" autoFocus onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()} />
          </Field>
          <Field label="Abbreviation">
            <input className="input" value={abbr} onChange={(e) => setAbbr(e.target.value)} maxLength={6} placeholder="Kest" />
          </Field>
        </div>
        <Field label="Position on the universe map" hint={nearest ? `${galacticDirection(pos.x - nearest.x, pos.y - nearest.y)} of ${nearest.name}. A sector is 32 × 40 parsecs: sixteen subsectors of 8 × 10.` : 'A sector is 32 × 40 parsecs: sixteen subsectors of 8 × 10.'}>
          <PositionPicker sectors={sectors} value={pos} onChange={setPos} />
        </Field>
      </div>
    </Modal>
  );
}

function SectorCard({ sector }: { sector: Sector }) {
  const systems = useType('system');
  const sectors = useType('sector');
  const [dialog, setDialog] = useState<'import' | 'generate' | 'names' | 'move' | null>(null);
  const mine = useMemo(() => systems.filter((s) => s.sectorId === sector.id), [systems, sector.id]);
  const charted = mine.filter((s) => s.known?.survey?.includes(PARTY)).length;
  const [pos, setPos] = useState({ x: sector.x, y: sector.y });

  return (
    <div className="panel">
      <div className="panel-head">
        <input className="input" style={{ maxWidth: 240, fontFamily: 'var(--font-display)', letterSpacing: '.06em' }} defaultValue={sector.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== sector.name && void setFields(sector.id, { name: e.target.value.trim() })} aria-label="Sector name" />
        <span className="small dim grow">
          {mine.length} systems · {charted} charted for the party
        </span>
        <button className="btn ghost sm" onClick={() => fitTo({ kind: 'sector', id: sector.id })} title="Show on the map">
          <Icon name="focus" size={13} /> View
        </button>
      </div>
      <div className="panel-body col">
        <div className="row wrap">
          <button className="btn sm primary" onClick={() => setDialog('import')}>
            <Icon name="upload" size={12} /> Import data
          </button>
          <button className="btn sm" onClick={() => setDialog('generate')}>
            <Icon name="sparkles" size={12} /> Generate
          </button>
          <button className="btn sm" onClick={() => setDialog(dialog === 'names' ? null : 'names')}>
            <Icon name="edit" size={12} /> Subsector names
          </button>
          <button className="btn sm" onClick={() => void run<{ created: number }>('routes.suggest', { sectorId: sector.id }).then((r) => r && toast(r.created ? `Added ${r.created} trade routes.` : 'No new trade routes to add.', 'ok'))} title="Link worlds whose trade codes make them natural trading partners, as the rulebook suggests">
            <Icon name="route" size={12} /> Suggest trade routes
          </button>
          <button className="btn sm" onClick={() => setDialog(dialog === 'move' ? null : 'move')}>
            <Icon name="move" size={12} /> Reposition
          </button>
        </div>
        <div className="row wrap">
          <span className="label">Set party knowledge for all {mine.length} systems</span>
          {Object.entries(PRESETS).map(([id, p]) => (
            <ConfirmButton key={id} label={p.label} confirm={`Set all to ${p.label.toLowerCase()}`} className="btn sm gm" onConfirm={() => void run('reveal.preset', { ids: mine.map((s) => s.id), preset: id, audience: PARTY }, 'Party knowledge updated')} />
          ))}
        </div>
        {dialog === 'names' && (
          <div className="subsector-grid">
            {SUBSECTOR_LETTERS.split('').map((letter) => (
              <label key={letter} className="subsector-cell">
                <span className="mono faint">{letter}</span>
                <input
                  className="input"
                  defaultValue={sector.subsectors[letter] ?? ''}
                  placeholder={`Subsector ${letter}`}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next !== (sector.subsectors[letter] ?? '')) void setFields(sector.id, { [`subsectors.${letter}`]: next || undefined });
                  }}
                />
              </label>
            ))}
          </div>
        )}
        {dialog === 'move' && (
          <div className="col">
            <PositionPicker sectors={sectors} value={pos} onChange={setPos} moving={sector.id} />
            <div className="row">
              <button className="btn sm primary" disabled={pos.x === sector.x && pos.y === sector.y} onClick={() => void run('sector.move', { id: sector.id, ...pos }, 'Sector moved').then(() => setDialog(null))}>
                Move here
              </button>
            </div>
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <ConfirmButton label="Remove all systems" confirm={`Delete ${mine.length} systems`} className="btn sm danger" onConfirm={() => void run('sector.clear', { id: sector.id }, 'Sector cleared')} />
          <ConfirmButton label="Delete sector" confirm="Delete sector and everything in it" icon="trash" onConfirm={() => void run('entity.delete', { id: sector.id })} />
        </div>
      </div>
      {dialog === 'import' && <ImportDialog sector={sector} onClose={() => setDialog(null)} />}
      {dialog === 'generate' && <GenerateDialog sector={sector} onClose={() => setDialog(null)} />}
    </div>
  );
}

export function SectorManager({ onClose }: { onClose: () => void }) {
  const sectors = useType('sector');
  const [adding, setAdding] = useState(false);
  const sorted = useMemo(() => [...sectors].sort((a, b) => a.y - b.y || a.x - b.x), [sectors]);
  return (
    <Modal
      title="Sectors"
      icon="hex"
      size="wide"
      onClose={onClose}
      footer={
        <>
          <span className="grow small dim">Tip: zoom the map right out and click a dashed “+” square to add a sector next to an existing one.</span>
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} /> New sector
          </button>
        </>
      }
    >
      <div className="col gap-12">
        {sorted.length === 0 && <div className="notice">Your universe is empty. Create a sector, then import generator data, roll it randomly, or place systems by hand.</div>}
        {sorted.map((s) => (
          <SectorCard key={s.id} sector={s} />
        ))}
      </div>
      {adding && <NewSectorDialog onClose={() => setAdding(false)} />}
    </Modal>
  );
}
