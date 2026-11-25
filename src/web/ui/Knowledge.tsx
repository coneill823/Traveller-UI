/**
 * GM controls for "who knows what". Every reveal control in the app goes through these, so the
 * same violet/cyan language means the same thing everywhere: violet = hidden, cyan = known.
 */
import { FACETS, PRESETS, presetFor } from '../../shared/knowledge';
import { PARTY, type Audience, type Entity, type Id, type Note } from '../../shared/types';
import { run } from '../net';
import { usePlayers } from '../store';
import { cx, Segmented } from './basics';
import { Icon } from './Icon';

/** Chips for the party and each player; lit when that audience is in `list`. */
export function AudiencePicker({ list, onToggle, compact }: { list: Audience[] | undefined; onToggle: (audience: Audience, on: boolean) => void; compact?: boolean }) {
  const players = usePlayers();
  const known = new Set(list ?? []);
  const party = known.has(PARTY);
  return (
    <div className="know-who">
      <button type="button" className={cx('who', party && 'on')} onClick={() => onToggle(PARTY, !party)} title={party ? 'The whole party knows this' : 'Reveal to the whole party'}>
        <Icon name={party ? 'eye' : 'eyeOff'} size={12} /> Party
      </button>
      {players.map((p) => {
        const on = known.has(p.id);
        return (
          <button
            type="button"
            key={p.id}
            className={cx('who', on && 'on', !on && party && 'implied')}
            onClick={() => onToggle(p.id, !on)}
            title={on ? `${p.name} knows this personally` : party ? `${p.name} knows this through the party` : `Reveal to ${p.name} only`}
          >
            <span className="dot" style={{ background: p.color }} />
            {compact ? p.name.slice(0, 3) : p.name}
          </button>
        );
      })}
    </div>
  );
}

/** Full knowledge editor for an entity with facets (systems, bodies, routes…). */
export function KnowledgeControl({ entity }: { entity: Entity }) {
  const specs = FACETS[entity.type];
  if (!specs) return null;
  const preset = presetFor(entity.known, PARTY);
  const showPresets = specs.length > 1;
  return (
    <div className="know">
      {showPresets && (
        <div className="know-presets">
          <span className="label">Party knowledge</span>
          <Segmented
            gm
            value={preset === 'custom' ? undefined : preset}
            options={Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label }))}
            onChange={(id) => void run('reveal.preset', { ids: [entity.id], preset: id, audience: PARTY })}
          />
        </div>
      )}
      {specs.map((spec) => (
        <div className="know-row" key={spec.key} title={spec.hint}>
          <span className="small">{spec.label}</span>
          <AudiencePicker list={entity.known?.[spec.key]} onToggle={(audience, on) => void run('reveal.set', { ids: [entity.id], facets: [spec.key], audience, on })} />
        </div>
      ))}
    </div>
  );
}

/** One-line summary badge of what the party knows about an entity. */
export function KnowledgeBadge({ entity }: { entity: Entity }) {
  const preset = presetFor(entity.known, PARTY);
  const personal = new Set<string>();
  for (const list of Object.values(entity.known ?? {})) for (const a of list) if (a !== PARTY) personal.add(a);
  if (preset === 'hidden' && personal.size === 0) {
    return (
      <span className="chip gm" title="Players cannot see this">
        <Icon name="eyeOff" size={11} /> Hidden
      </span>
    );
  }
  return (
    <span className={cx('chip', preset === 'hidden' ? 'gm' : 'accent')} title="What the party knows">
      <Icon name="eye" size={11} /> {preset === 'hidden' ? `${personal.size} player${personal.size === 1 ? '' : 's'}` : preset === 'custom' ? 'Partly known' : PRESETS[preset].label}
    </span>
  );
}

export function NoteReveal({ entityId, note }: { entityId: Id; note: Note }) {
  return <AudiencePicker compact list={note.known} onToggle={(audience, on) => void run('note.reveal', { entityId, noteId: note.id, audience, on })} />;
}
