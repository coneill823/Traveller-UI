/**
 * Write-ups attached to an entity: quick notes kept in the app, plus the sections of any linked
 * Chronicler wiki page. The GM reveals each piece separately; players only ever receive the
 * pieces that have been revealed to them.
 */
import { useMemo, useState } from 'react';
import { PARTY, type Entity, type Note, type WikiPage, type WikiSection } from '../../shared/types';
import { run } from '../net';
import { Link } from '../router';
import { useIsGm, useType } from '../store';
import { useWikiStatus } from '../modules/library/wiki';
import { ConfirmButton, cx, Field, Modal } from './basics';
import { Icon } from './Icon';
import { AudiencePicker, NoteReveal } from './Knowledge';
import { Markdown } from './Markdown';

function NoteEditor({ entity, note, onClose }: { entity: Entity; note?: Note; onClose: () => void }) {
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [reveal, setReveal] = useState(false);
  const save = async () => {
    const ok = note
      ? await run('note.update', { entityId: entity.id, noteId: note.id, title: title || 'Note', body })
      : await run('note.add', { entityId: entity.id, title: title || 'Note', body, reveal: reveal ? PARTY : undefined });
    if (ok) onClose();
  };
  return (
    <Modal
      title={note ? 'Edit note' : 'New note'}
      icon="note"
      onClose={onClose}
      footer={
        <>
          {!note && (
            <label className="check grow">
              <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
              Reveal to the party straight away
            </label>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Rumours at the starport" />
        </Field>
        <Field label="Text" hint="Markdown is supported.">
          <textarea className="textarea" rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function WikiSectionView({ page, section, gm }: { page: WikiPage; section: WikiSection; gm: boolean }) {
  const revealed = section.known.length > 0;
  return (
    <div className={cx('writeup', gm && !revealed && 'hidden-from-players', section.locked && 'locked')}>
      <div className="writeup-head">
        <Icon name="book" size={13} />
        <strong className="grow">{section.heading || page.title}</strong>
        {gm && section.locked && (
          <span className="chip gm" title="Sections under a GM heading can never be revealed">
            <Icon name="lock" size={11} /> GM only
          </span>
        )}
      </div>
      {gm && !section.locked && (
        <div className="writeup-reveal">
          <AudiencePicker compact list={section.known} onToggle={(audience, on) => void run('wiki.reveal', { pageId: page.id, sectionId: section.id, audience, on })} />
          {/\|\|/.test(section.body) && (
            <label className="check tiny" title="Also show the ||spoiler|| text in this section to the party">
              <input
                type="checkbox"
                checked={section.spoilersKnown?.includes(PARTY) ?? false}
                onChange={(e) => void run('wiki.reveal', { pageId: page.id, sectionId: section.id, audience: PARTY, on: e.target.checked, spoilers: true })}
              />
              incl. spoilers
            </label>
          )}
        </div>
      )}
      <Markdown text={section.body} />
    </div>
  );
}

/** GM controls to give an entry a wiki page: create a new one, or attach an existing page. */
function WikiLinker({ entity, linked }: { entity: Entity; linked: WikiPage[] }) {
  const status = useWikiStatus();
  const pages = useType('wikiPage');
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  if (!status?.configured) return null;
  const candidates = pages.filter((p) => !p.entityId && (!q.trim() || p.title.toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 8);
  const publishable = entity.type === 'system' || entity.type === 'body';
  return (
    <div className="col gap-4" style={{ marginBottom: 8 }}>
      <div className="row wrap">
        {linked.length === 0 && publishable && status.canWrite && (
          <button className="btn sm" onClick={() => void run('wiki.publish', { ids: [entity.id] }, 'Wiki page created')} title="Create a page for this entry in the Chronicler wiki">
            <Icon name="book" size={12} /> Create wiki page
          </button>
        )}
        <button className={cx('btn sm', picking && 'on')} onClick={() => setPicking((v) => !v)}>
          <Icon name="link" size={12} /> Attach a page
        </button>
      </div>
      {picking && (
        <div className="col gap-4">
          <input className="input" autoFocus placeholder="Search wiki pages…" value={q} onChange={(e) => setQ(e.target.value)} />
          {candidates.map((p) => (
            <button
              key={p.id}
              className="objective-pill"
              onClick={() => {
                setPicking(false);
                void run('wiki.link', { pageId: p.id, entityId: entity.id }, 'Page attached');
              }}
            >
              <Icon name="note" size={13} />
              <span className="grow">{p.title}</span>
              <span className="tiny faint mono">{p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : ''}</span>
            </button>
          ))}
          {candidates.length === 0 && <span className="faint small">No unattached pages match.</span>}
        </div>
      )}
    </div>
  );
}

export function Notes({ entity, title = 'Write-ups' }: { entity: Entity; title?: string }) {
  const gm = useIsGm();
  const pages = useType('wikiPage');
  const linked = useMemo(() => pages.filter((p) => p.entityId === entity.id), [pages, entity.id]);
  const [editing, setEditing] = useState<Note | 'new' | null>(null);
  const notes = entity.notes ?? [];
  const nothing = notes.length === 0 && linked.every((p) => p.sections.length === 0);

  return (
    <div className="section">
      <div className="section-title">
        <h3>{title}</h3>
        {gm && (
          <button className="btn sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={12} /> Note
          </button>
        )}
      </div>
      {nothing && <div className="faint small">{gm ? 'Nothing written yet. Add a note here, or attach a wiki page to this entry.' : 'Nothing known yet.'}</div>}
      {gm && <WikiLinker entity={entity} linked={linked} />}
      <div className="col">
        {linked.map((page) => (
          <div key={page.id} className="col gap-4">
            <div className="row tiny faint">
              <Icon name="link" size={11} /> Wiki:
              <Link to={`/library/${page.id}`}>{page.title}</Link>
              {gm && (
                <button className="btn ghost sm" style={{ height: 18, padding: '0 4px' }} title="Detach this wiki page from the entry" onClick={() => void run('wiki.link', { pageId: page.id, entityId: null })}>
                  detach
                </button>
              )}
            </div>
            {page.sections
              .filter((s) => s.body.trim() !== '')
              .map((s) => (
                <WikiSectionView key={s.id} page={page} section={s} gm={gm} />
              ))}
          </div>
        ))}
        {notes.map((note) => (
          <div key={note.id} className={cx('writeup', gm && note.known.length === 0 && 'hidden-from-players')}>
            <div className="writeup-head">
              <Icon name="note" size={13} />
              <strong className="grow">{note.title}</strong>
              {gm && (
                <>
                  <button className="btn ghost icon sm" title="Edit note" onClick={() => setEditing(note)}>
                    <Icon name="edit" size={13} />
                  </button>
                  <ConfirmButton className="btn ghost icon sm" label={<Icon name="trash" size={13} />} confirm="Delete" title="Delete note" onConfirm={() => void run('note.remove', { entityId: entity.id, noteId: note.id })} />
                </>
              )}
            </div>
            {gm && (
              <div className="writeup-reveal">
                <NoteReveal entityId={entity.id} note={note} />
              </div>
            )}
            <Markdown text={note.body} />
          </div>
        ))}
      </div>
      {editing && <NoteEditor entity={entity} note={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
