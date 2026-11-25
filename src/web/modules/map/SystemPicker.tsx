/** Type-ahead picker for a system the viewer knows about. Used wherever a place must be chosen. */
import { useMemo, useState } from 'react';
import type { Id } from '../../../shared/types';
import { Icon } from '../../ui/Icon';
import { systemLabel, type MapData } from './mapData';

export function SystemPicker({ data, onPick, placeholder = 'Search for a system…', exclude = [] }: { data: MapData; onPick: (id: Id) => void; placeholder?: string; exclude?: Id[] }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pool = data.systems.filter((s) => !exclude.includes(s.sys.id));
    const hits = needle ? pool.filter((s) => systemLabel(s).toLowerCase().includes(needle) || s.sys.hex === needle) : pool;
    return hits.slice(0, 8);
  }, [q, data.systems, exclude]);
  const pick = (id: Id) => {
    onPick(id);
    setQ('');
    setOpen(false);
  };
  return (
    <div className="picker">
      <div className="row">
        <Icon name="search" size={14} className="faint" />
        <input className="input" value={q} placeholder={placeholder} onChange={(e) => (setQ(e.target.value), setOpen(true))} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={(e) => e.key === 'Enter' && matches[0] && (e.preventDefault(), pick(matches[0].sys.id))} />
      </div>
      {open && matches.length > 0 && (
        <div className="picker-results">
          {matches.map((s) => (
            <button key={s.sys.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s.sys.id)}>
              <strong>{systemLabel(s)}</strong>
              <span className="mono tiny faint">
                {s.sector.name} {s.sys.hex} {s.sys.uwp ?? ''}
              </span>
            </button>
          ))}
        </div>
      )}
      {open && q.trim() && matches.length === 0 && <div className="picker-results"><div className="pad faint small">No known system matches.</div></div>}
    </div>
  );
}
