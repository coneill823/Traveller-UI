/** Roster of travellers, and for the GM the cast of NPCs and creatures. */
import { useMemo, useState } from 'react';
import { PARTY, type Character } from '../../../shared/types';
import { act } from '../../net';
import { navigate } from '../../router';
import { toast, useIsGm, useMe, usePlayers, useRules, useType } from '../../store';
import { cx, Empty, Field, Modal, Segmented } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { KnowledgeBadge } from '../../ui/Knowledge';
import { characterName, HealthBars, Sheet } from './Sheet';

function CharacterCard({ c }: { c: Character }) {
  const gm = useIsGm();
  const players = usePlayers();
  const owner = players.find((p) => p.id === c.ownerId);
  return (
    <button className={cx('panel char-card', (c.conditions ?? []).includes('Dead') && 'dead')} onClick={() => navigate(`/characters/${c.id}`)} style={{ ['--c' as string]: owner?.color ?? 'var(--line-strong)' }}>
      <div className="portrait sm" style={c.portrait ? { backgroundImage: `url(${c.portrait})` } : undefined}>
        {!c.portrait && <Icon name={c.kind === 'creature' ? 'star' : 'user'} size={20} />}
      </div>
      <div className="grow" style={{ minWidth: 0 }}>
        <strong className="char-card-name">{characterName(c)}</strong>
        <div className="small dim char-card-sub">{[c.title, c.species].filter(Boolean).join(' · ') || (c.kind === 'creature' ? 'Creature' : '')}</div>
        <div className="row wrap gap-4" style={{ marginTop: 4 }}>
          {owner && (
            <span className="chip">
              <span className="dot" style={{ background: owner.color }} /> {owner.name}
            </span>
          )}
          {(c.conditions ?? []).map((x) => (
            <span key={x} className="chip danger">
              {x}
            </span>
          ))}
          {gm && c.kind !== 'pc' && <KnowledgeBadge entity={c} />}
        </div>
        <HealthBars c={c} />
      </div>
    </button>
  );
}

function NewCharacter({ kind, onClose }: { kind: Character['kind']; onClose: () => void }) {
  const gm = useIsGm();
  const me = useMe();
  const players = usePlayers();
  const rules = useRules().characters;
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [species, setSpecies] = useState('Human');
  const [ownerId, setOwnerId] = useState(gm ? '' : (me?.playerId ?? ''));
  const [scores, setScores] = useState<Record<string, number>>({ STR: 7, DEX: 7, END: 7, INT: 7, EDU: 7, SOC: 7 });
  const [reveal, setReveal] = useState<'hidden' | 'detected' | 'name'>('hidden');
  const def = rules?.species.find((s) => s.name === species);

  const rollScores = () => {
    const next: Record<string, number> = {};
    for (const key of Object.keys(scores)) next[key] = Math.max(1, 2 + Math.floor(Math.random() * 6) + Math.floor(Math.random() * 6) + (def?.mods[key] ?? 0));
    setScores(next);
  };

  const create = async () => {
    try {
      const res = await act<{ id: string }>('character.create', { kind, name: name.trim() || undefined, title: title.trim() || undefined, species, ownerId: kind === 'pc' && gm ? ownerId || undefined : undefined, chars: scores });
      if (kind !== 'pc' && reveal !== 'hidden') await act('reveal.set', { ids: [res.id], facets: reveal === 'name' ? ['exists', 'name'] : ['exists'], audience: PARTY, on: true });
      onClose();
      navigate(`/characters/${res.id}`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <Modal
      title={kind === 'pc' ? 'New traveller' : kind === 'npc' ? 'New NPC' : 'New creature'}
      icon="user"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void create()}>
            Create
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <div className="grid-2">
          <Field label="Name">
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
          </Field>
          <Field label={kind === 'creature' ? 'Type' : 'Role or rank'}>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'pc' ? 'e.g. Ship’s engineer' : kind === 'npc' ? 'e.g. Starport broker' : 'e.g. Pack hunter'} />
          </Field>
          {kind !== 'creature' && (
            <Field label="Species" hint={def && Object.keys(def.mods).length ? `Characteristic modifiers: ${Object.entries(def.mods).map(([k, v]) => `${k}${v >= 0 ? '+' : ''}${v}`).join(', ')}` : undefined}>
              <select className="select" value={species} onChange={(e) => setSpecies(e.target.value)}>
                {(rules?.species ?? [{ name: 'Human' }]).map((s) => (
                  <option key={s.name}>{s.name}</option>
                ))}
              </select>
            </Field>
          )}
          {kind === 'pc' && gm && (
            <Field label="Played by">
              <select className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                <option value="">Nobody yet</option>
                {players.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <Field label="Characteristics" hint="Enter the scores from your character creation, or roll 2D for each. You can change them later.">
          <div className="row wrap">
            {Object.keys(scores).map((key) => (
              <label key={key} className="col gap-4" style={{ alignItems: 'center' }}>
                <span className="label">{key}</span>
                <input className="input mono" style={{ width: 56, textAlign: 'center' }} type="number" min={0} max={30} value={scores[key]} onChange={(e) => setScores({ ...scores, [key]: Math.max(0, Number(e.target.value) || 0) })} />
              </label>
            ))}
            <button className="btn sm" style={{ alignSelf: 'flex-end' }} onClick={rollScores}>
              <Icon name="dice" size={12} /> Roll 2D each
            </button>
          </div>
        </Field>
        {kind !== 'pc' && (
          <Field label="What the party knows" hint="You can reveal more, including stats, from the sheet.">
            <Segmented
              gm
              value={reveal}
              onChange={setReveal}
              options={[
                { id: 'hidden', label: 'Nothing' },
                { id: 'detected', label: 'Seen' },
                { id: 'name', label: 'Seen & named' },
              ]}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}

export function CharactersPage({ characterId }: { characterId?: string }) {
  const gm = useIsGm();
  const me = useMe();
  const characters = useType('character');
  const [creating, setCreating] = useState<Character['kind'] | null>(null);
  const [q, setQ] = useState('');
  const current = characters.find((c) => c.id === characterId);

  const { pcs, others } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (c: Character) => !needle || `${c.name ?? ''} ${c.title ?? ''} ${c.species ?? ''}`.toLowerCase().includes(needle);
    const sorted = [...characters].sort((a, b) => characterName(a).localeCompare(characterName(b)));
    return {
      // Your own travellers first.
      pcs: sorted.filter((c) => c.kind === 'pc' && match(c)).sort((a, b) => Number(b.ownerId === me?.playerId) - Number(a.ownerId === me?.playerId)),
      others: sorted.filter((c) => c.kind !== 'pc' && match(c)),
    };
  }, [characters, q, me]);

  if (characterId) {
    if (current) return <Sheet key={current.id} c={current} />;
    return (
      <div className="page">
        <Empty icon="user" title="Character not available">
          <button className="btn" onClick={() => navigate('/characters')}>
            Back to the roster
          </button>
        </Empty>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Crew</h1>
        <input className="input" style={{ maxWidth: 220 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search characters" />
        <div className="grow" />
        {gm && (
          <>
            <button className="btn gm" onClick={() => setCreating('npc')}>
              <Icon name="plus" size={13} /> NPC
            </button>
            <button className="btn gm" onClick={() => setCreating('creature')}>
              <Icon name="plus" size={13} /> Creature
            </button>
          </>
        )}
        {!me?.viewAs && (
          <button className="btn primary" onClick={() => setCreating('pc')}>
            <Icon name="plus" size={13} /> New traveller
          </button>
        )}
      </div>
      <div className="col gap-16">
        <section className="col">
          <h3>Travellers</h3>
          {pcs.length === 0 ? (
            <Empty icon="users" title="No travellers yet">
              {gm ? 'Players can create their own characters here, or you can create them and hand them over.' : 'Create your traveller to get a sheet you can roll from.'}
            </Empty>
          ) : (
            <div className="card-grid">
              {pcs.map((c) => (
                <CharacterCard key={c.id} c={c} />
              ))}
            </div>
          )}
        </section>
        {(others.length > 0 || gm) && (
          <section className="col">
            <h3>{gm ? 'NPCs & creatures' : 'People & creatures you know of'}</h3>
            {others.length === 0 ? (
              <div className="faint small">None yet. NPCs stay hidden from players until you reveal them.</div>
            ) : (
              <div className="card-grid">
                {others.map((c) => (
                  <CharacterCard key={c.id} c={c} />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
      {creating && <NewCharacter kind={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}
