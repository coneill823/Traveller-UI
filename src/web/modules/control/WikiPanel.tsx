/** Control room panel for the Chronicler wiki connection. */
import { useMemo } from 'react';
import { run, setFields } from '../../net';
import { useCampaign, useType } from '../../store';
import { ConfirmButton } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { useWikiStatus } from '../library/wiki';

function ago(time: number | undefined): string {
  if (!time) return 'never';
  const s = Math.round((Date.now() - time) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(time).toLocaleString();
}

export function WikiPanel() {
  const status = useWikiStatus();
  const campaign = useCampaign();
  const systems = useType('system');
  const pages = useType('wikiPage');
  const unpublished = useMemo(() => {
    const linked = new Set(pages.map((p) => p.entityId).filter(Boolean));
    return systems.filter((s) => !linked.has(s.id)).map((s) => s.id);
  }, [systems, pages]);

  return (
    <section className="panel">
      <div className="panel-head gm">
        <h2 className="grow">Chronicler wiki</h2>
        {status?.configured && (
          <button className="btn sm" disabled={status.syncing} onClick={() => void run('wiki.sync', {}, 'Wiki synced')}>
            <Icon name="sync" size={12} /> {status.syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>
      <div className="panel-body col gap-12">
        {!status ? (
          <span className="faint small">Checking…</span>
        ) : !status.configured ? (
          <div className="col">
            <div className="notice">
              <Icon name="info" size={14} />
              <div>
                No wiki is connected yet. Point the server at your Chronicler vault and restart it:
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  <li>
                    <strong>Vault folder on the server&apos;s computer:</strong> set <code>WIKI_DIR</code> to the folder Chronicler has open. Changes show up in both within a second.
                  </li>
                  <li>
                    <strong>GitHub repository:</strong> set <code>WIKI_REPO</code> (for example <code>you/Traveller-Campaign</code>) and <code>WIKI_TOKEN</code>, a fine-grained token with “Contents: read and write” on that repository.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        ) : (
          <>
            <dl className="kv">
              <dt>Connected to</dt>
              <dd>
                {status.label}
                {!status.canWrite && <span className="chip warn" style={{ marginLeft: 8 }}>read-only</span>}
              </dd>
              <dt>Pages</dt>
              <dd>
                {status.pages} <span className="faint">· {status.linked} attached to map entries</span>
              </dd>
              <dt>Last sync</dt>
              <dd>{ago(status.lastSync)}</dd>
              {status.lastSummary && (
                <>
                  <dt>Last change</dt>
                  <dd className="small dim">
                    {status.lastSummary.pagesChanged} pages read in, {status.lastSummary.pagesWritten} written, {status.lastSummary.entitiesUpdated} map entries updated, {status.lastSummary.entitiesCreated} created
                  </dd>
                </>
              )}
            </dl>
            {status.lastError && (
              <div className="notice danger">
                <Icon name="warning" size={14} /> {status.lastError}
              </div>
            )}
            {!status.canWrite && (
              <div className="notice warn">
                <Icon name="lock" size={14} /> The wiki is read-only because no <code>WIKI_TOKEN</code> is set. Pages you write in Chronicler still appear here, but systems created in the app cannot be added to the wiki.
              </div>
            )}
            {status.lastSummary && status.lastSummary.warnings.length > 0 && (
              <div className="notice warn col gap-4">
                {status.lastSummary.warnings.slice(0, 6).map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
                {status.lastSummary.warnings.length > 6 && <div>…and {status.lastSummary.warnings.length - 6} more.</div>}
              </div>
            )}
            <label className="check">
              <input type="checkbox" checked={campaign?.settings.wikiAutoPublish ?? false} onChange={(e) => void setFields('campaign', { 'settings.wikiAutoPublish': e.target.checked })} />
              Add a wiki page automatically for every system that is imported or generated
            </label>
            {unpublished.length > 0 && status.canWrite && (
              <div className="row wrap">
                <span className="small dim">
                  {unpublished.length} system{unpublished.length === 1 ? ' has' : 's have'} no wiki page.
                </span>
                <ConfirmButton
                  label="Create the missing pages"
                  confirm={`Write ${unpublished.length} pages`}
                  className="btn sm"
                  icon="upload"
                  onConfirm={() => void run<{ written: number }>('wiki.publish', { ids: unpublished }).then((r) => r && run('wiki.status'))}
                />
              </div>
            )}
            <p className="tiny faint" style={{ margin: 0 }}>
              What you write in Chronicler appears on the matching map entry, hidden from players until you reveal each section. Sections under a heading starting with “GM”, “Referee” or “Secret” can never be revealed, and <code>||spoiler||</code> text stays hidden unless you allow it. Editing a system&apos;s infobox in
              Chronicler (UWP, bases, travel zone…) updates the map.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
