/**
 * The library: the campaign wiki as seen from the app. The GM sees every page and decides which
 * sections players may read; players see only what has been revealed to them.
 */
import { useMemo, useState } from 'react';
import { PARTY, type WikiPage, type WikiSection } from '../../../shared/types';
import { run } from '../../net';
import { Link, navigate } from '../../router';
import { useIsGm, useType } from '../../store';
import { cx, Empty } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { AudiencePicker } from '../../ui/Knowledge';
import { Markdown } from '../../ui/Markdown';
import { entityName, entityPath, linkedEntity, revealState, useWikiStatus } from './wiki';

const HIDDEN_KEYS = new Set(['ref', 'layout', 'image', 'tags', 'players', 'title', 'subtitle', 'infobox']);

function Infobox({ page }: { page: WikiPage }) {
  const gm = useIsGm();
  const rows = Object.entries(page.frontmatter).filter(([key, value]) => !HIDDEN_KEYS.has(key) && value !== null && value !== '' && typeof value !== 'object');
  const lists = Object.entries(page.frontmatter).filter(([key, value]) => !HIDDEN_KEYS.has(key) && Array.isArray(value));
  if (rows.length === 0 && lists.length === 0 && page.tags.length === 0) return null;
  const shown = page.known?.infobox ?? [];
  return (
    <aside className={cx('infobox panel', gm && shown.length === 0 && 'gm-hidden')}>
      <div className={cx('panel-head', gm && shown.length === 0 && 'gm')}>
        <h3 className="grow">{typeof page.frontmatter.infobox === 'string' ? page.frontmatter.infobox : 'Infobox'}</h3>
      </div>
      <div className="panel-body col">
        {gm && (
          <div className="writeup-reveal" title="Whether players can see this infobox">
            <AudiencePicker compact list={shown} onToggle={(audience, on) => void run('wiki.reveal', { pageId: page.id, infobox: true, audience, on })} />
          </div>
        )}
        {typeof page.frontmatter.subtitle === 'string' && <div className="dim small">{page.frontmatter.subtitle}</div>}
        <dl className="kv">
          {[...rows, ...lists].map(([key, value]) => (
            <div key={key} style={{ display: 'contents' }}>
              <dt>{key.replace(/_/g, ' ')}</dt>
              <dd>
                <Markdown text={Array.isArray(value) ? value.map(String).join(', ') : String(value)} />
              </dd>
            </div>
          ))}
        </dl>
        {page.tags.length > 0 && (
          <div className="row wrap gap-4">
            {page.tags.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function Section({ page, section }: { page: WikiPage; section: WikiSection }) {
  const gm = useIsGm();
  const Heading = (`h${Math.min(4, Math.max(2, section.level || 2))}` as 'h2' | 'h3' | 'h4');
  const hidden = gm && section.known.length === 0;
  return (
    <section className={cx('wiki-section', hidden && 'gm-hidden', section.locked && 'locked')}>
      {(section.heading || gm) && (
        <div className="wiki-section-head">
          {section.heading ? <Heading className="grow">{section.heading}</Heading> : <span className="grow label">Introduction</span>}
          {gm && section.locked && (
            <span className="chip gm" title="Sections under a heading that starts with GM, Referee or Secret can never be revealed">
              <Icon name="lock" size={11} /> GM only
            </span>
          )}
          {gm && !section.locked && (
            <div className="row">
              {/\|\|/.test(section.body) && (
                <label className="check tiny" title="Also show the ||spoiler|| text in this section to the party">
                  <input type="checkbox" checked={section.spoilersKnown?.includes(PARTY) ?? false} onChange={(e) => void run('wiki.reveal', { pageId: page.id, sectionId: section.id, audience: PARTY, on: e.target.checked, spoilers: true })} />
                  spoilers
                </label>
              )}
              <AudiencePicker compact list={section.known} onToggle={(audience, on) => void run('wiki.reveal', { pageId: page.id, sectionId: section.id, audience, on })} />
            </div>
          )}
        </div>
      )}
      <Markdown text={section.body} />
    </section>
  );
}

function PageView({ page }: { page: WikiPage }) {
  const gm = useIsGm();
  const entity = linkedEntity(page);
  const target = entityPath(entity);
  const state = revealState(page);
  const sections = page.sections.filter((s) => s.body.trim() !== '' || s.heading);
  return (
    <article className="wiki-page">
      <header className="wiki-head">
        <div className="grow">
          <h1>{page.title}</h1>
          {gm && page.path && <div className="mono tiny faint">{page.path}</div>}
        </div>
        {entity && target && (
          <button className="btn sm" onClick={() => navigate(target)} title="Show on the map">
            <Icon name="pin" size={12} /> {entityName(entity)}
          </button>
        )}
        {gm && (
          <>
            <span className={cx('chip', state === 'hidden' ? 'gm' : 'accent')}>
              <Icon name={state === 'hidden' ? 'eyeOff' : 'eye'} size={11} /> {state === 'hidden' ? 'Hidden from players' : state === 'partial' ? 'Partly revealed' : 'Revealed'}
            </span>
            <button className="btn sm gm" onClick={() => void run('wiki.reveal', { pageId: page.id, all: true, audience: PARTY, on: state !== 'revealed' })}>
              {state === 'revealed' ? 'Hide all' : 'Reveal all to party'}
            </button>
          </>
        )}
      </header>
      {gm && page.warnings && page.warnings.length > 0 && (
        <div className="notice warn col gap-4" style={{ marginBottom: 12 }}>
          {page.warnings.map((w, i) => (
            <div key={i}>
              <Icon name="warning" size={13} /> {w}
            </div>
          ))}
        </div>
      )}
      <div className="wiki-body">
        <div className="wiki-text">
          {sections.length === 0 ? <div className="faint">This page has no text yet. Write in Chronicler and it will appear here.</div> : sections.map((s) => <Section key={s.id} page={page} section={s} />)}
        </div>
        <Infobox page={page} />
      </div>
    </article>
  );
}

export function LibraryPage({ pageId }: { pageId?: string }) {
  const gm = useIsGm();
  const pages = useType('wikiPage');
  const status = useWikiStatus();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'hidden' | 'revealed'>('all');

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = pages
      .filter((p) => !needle || p.title.toLowerCase().includes(needle) || p.tags.some((t) => t.toLowerCase().includes(needle)) || p.sections.some((s) => s.body.toLowerCase().includes(needle)))
      .filter((p) => !gm || filter === 'all' || (filter === 'hidden' ? revealState(p) === 'hidden' : revealState(p) !== 'hidden'));
    // The GM browses by vault folder; players get one alphabetical list (folder names can give things away).
    const byFolder = new Map<string, WikiPage[]>();
    for (const p of list) {
      const folder = gm && p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '';
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), p]);
    }
    return [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([folder, items]) => ({ folder, items: items.sort((a, b) => a.title.localeCompare(b.title)) }));
  }, [pages, q, gm, filter]);

  const current = pages.find((p) => p.id === pageId);

  return (
    <div className="library">
      <aside className="library-list">
        <div className="library-search">
          <Icon name="search" size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the library…" aria-label="Search the library" />
        </div>
        {gm && (
          <div className="segmented gm" style={{ display: 'flex', margin: '0 10px 8px' }}>
            {(['all', 'hidden', 'revealed'] as const).map((f) => (
              <button key={f} className={cx(filter === f && 'on')} style={{ flex: 1 }} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
          </div>
        )}
        <div className="library-pages">
          {groups.map((g) => (
            <div key={g.folder}>
              {g.folder && <div className="library-folder">{g.folder}</div>}
              {g.items.map((p) => {
                const state = gm ? revealState(p) : 'revealed';
                return (
                  <Link key={p.id} to={`/library/${p.id}`} className={cx('library-item', p.id === pageId && 'on')}>
                    <Icon name={p.entityId ? 'pin' : 'note'} size={13} />
                    <span className="grow">{p.title}</span>
                    {gm && state !== 'revealed' && <Icon name={state === 'hidden' ? 'eyeOff' : 'eye'} size={12} style={{ color: 'var(--gm)', opacity: state === 'hidden' ? 1 : 0.6 }} />}
                  </Link>
                );
              })}
            </div>
          ))}
          {pages.length === 0 && <div className="pad faint small">{gm ? 'No wiki pages yet.' : 'Nothing has been shared with you yet.'}</div>}
          {pages.length > 0 && groups.length === 0 && <div className="pad faint small">No pages match.</div>}
        </div>
        {gm && status && (
          <div className="library-status">
            {status.configured ? (
              <>
                <span className={cx('dot', !status.lastError && 'on')} />
                <span className="grow tiny dim" title={status.label}>
                  {status.syncing ? 'Syncing…' : status.lastError ? 'Sync problem' : `${status.pages} pages`}
                </span>
                <button className="btn sm ghost" disabled={status.syncing} onClick={() => void run('wiki.sync', {}, 'Wiki synced')}>
                  <Icon name="sync" size={12} /> Sync
                </button>
              </>
            ) : (
              <span className="tiny faint">No wiki connected. See the Control room.</span>
            )}
          </div>
        )}
      </aside>
      <div className="library-main">
        {current ? (
          <PageView page={current} />
        ) : (
          <Empty icon="book" title={pageId ? 'That page is not available' : 'Library'}>
            {gm
              ? 'Pages from your Chronicler wiki appear here. Choose one to decide what the players may read.'
              : pages.length
                ? 'Choose a page on the left.'
                : 'When your GM shares wiki pages with you, they will appear here.'}
          </Empty>
        )}
      </div>
    </div>
  );
}
