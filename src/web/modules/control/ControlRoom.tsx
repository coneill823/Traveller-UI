/** GM control room: players and invites, campaign settings, backups. */
import { useRef, useState } from 'react';
import { api, run, setFields } from '../../net';
import { toast, useApp, useCampaign, usePlayers } from '../../store';
import { ConfirmButton, Field } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { WikiPanel } from './WikiPanel';

function inviteLink(code: string): string {
  return `${window.location.origin}/join/${code}`;
}

function PlayersPanel() {
  const players = usePlayers();
  const online = useApp((s) => s.online);
  const [name, setName] = useState('');
  const [codes, setCodes] = useState<Record<string, string>>({});

  const add = async () => {
    if (!name.trim()) return;
    const res = await run<{ id: string; code: string }>('player.create', { name: name.trim() });
    if (res) {
      setCodes((c) => ({ ...c, [res.id]: res.code }));
      setName('');
    }
  };
  const show = async (id: string, reset = false) => {
    const res = await run<{ code: string }>('player.invite', { id, reset });
    if (res) setCodes((c) => ({ ...c, [id]: res.code }));
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard', 'ok');
    } catch {
      toast('Could not copy — select the text and copy it manually', 'error');
    }
  };

  return (
    <section className="panel">
      <div className="panel-head gm">
        <h2>Players</h2>
      </div>
      <div className="panel-body col gap-12">
        <p className="dim small">Each player gets a personal invite. They open the link (or type the code on the sign-in screen) and stay signed in on that device.</p>
        {players.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Player</th>
                <th>Invite</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div className="row">
                      <span className={online.includes(p.id) ? 'dot on' : 'dot'} title={online.includes(p.id) ? 'Online' : 'Offline'} />
                      <input type="color" value={p.color} onChange={(e) => void setFields(p.id, { color: e.target.value })} title="Player colour" style={{ width: 22, height: 22, padding: 0, border: 0, background: 'none' }} />
                      <input className="input" style={{ maxWidth: 180 }} defaultValue={p.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== p.name && void setFields(p.id, { name: e.target.value.trim() })} aria-label="Player name" />
                    </div>
                  </td>
                  <td>
                    {codes[p.id] ? (
                      <div className="col gap-4">
                        <div className="row">
                          <code className="chip mono accent">{codes[p.id]}</code>
                          <button className="btn sm" onClick={() => void copy(inviteLink(codes[p.id]))}>
                            <Icon name="copy" size={12} /> Copy link
                          </button>
                        </div>
                        <span className="tiny faint mono">{inviteLink(codes[p.id])}</span>
                      </div>
                    ) : (
                      <button className="btn sm" onClick={() => void show(p.id)}>
                        <Icon name="eye" size={12} /> Show invite
                      </button>
                    )}
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <ConfirmButton label="New code" confirm="Sign out & reset" className="btn sm" title="Signs the player out everywhere and issues a new invite" onConfirm={() => void show(p.id, true)} />
                      <ConfirmButton label="Remove" confirm="Remove player" icon="trash" onConfirm={() => void run('player.remove', { id: p.id })} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row">
          <input className="input" style={{ maxWidth: 260 }} placeholder="New player's name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
          <button className="btn primary" onClick={() => void add()} disabled={!name.trim()}>
            <Icon name="plus" size={13} /> Add player
          </button>
        </div>
      </div>
    </section>
  );
}

function CampaignPanel() {
  const campaign = useCampaign();
  const rules = useApp((s) => s.rules);
  if (!campaign) return null;
  return (
    <section className="panel">
      <div className="panel-head gm">
        <h2>Campaign</h2>
      </div>
      <div className="panel-body col gap-12">
        <div className="grid-2">
          <Field label="Campaign name">
            <input className="input" defaultValue={campaign.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== campaign.name && void setFields(campaign.id, { name: e.target.value.trim() })} />
          </Field>
          <Field label="Default jump rating" hint="Used by the route planner until a ship is chosen.">
            <select className="select" value={campaign.settings.defaultJump} onChange={(e) => void setFields(campaign.id, { 'settings.defaultJump': Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  Jump-{n}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div>
          <div className="label">Rules packs</div>
          {rules.packs.length === 0 ? (
            <div className="notice warn" style={{ marginTop: 6 }}>
              <Icon name="warning" size={14} /> No rules pack is installed on the server, so world data, trade tables and ship parts are empty. Add a pack to the server&apos;s <code>rulepacks</code> folder and restart.
            </div>
          ) : (
            <div className="row wrap" style={{ marginTop: 6 }}>
              {rules.packs.map((p) => (
                <span key={p.id} className="chip accent">
                  {p.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function BackupPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    try {
      const data = await api<object>('/api/backup');
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `traveller-campaign-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const restore = async (file: File) => {
    setBusy(true);
    try {
      const data = JSON.parse(await file.text());
      const res = await api<{ entities: number }>('/api/restore', { body: data });
      toast(`Backup restored (${res.entities} records). Reloading…`, 'ok');
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      toast(`Restore failed: ${(err as Error).message}`, 'error');
    }
    setBusy(false);
  };
  return (
    <section className="panel">
      <div className="panel-head gm">
        <h2>Backup</h2>
      </div>
      <div className="panel-body col gap-12">
        <p className="dim small">The whole campaign lives in the server&apos;s data folder. A backup is one JSON file you can keep anywhere. Restoring replaces everything except player accounts.</p>
        <div className="row">
          <button className="btn" onClick={() => void download()}>
            <Icon name="download" size={13} /> Download backup
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && void restore(e.target.files[0])} />
          <ConfirmButton label="Restore from file…" confirm="Replace the campaign" className="btn danger" icon="upload" onConfirm={() => fileRef.current?.click()} />
          {busy && <span className="faint small">Restoring…</span>}
        </div>
      </div>
    </section>
  );
}

function PassphrasePanel() {
  const [password, setPassword] = useState('');
  return (
    <section className="panel">
      <div className="panel-head gm">
        <h2>GM passphrase</h2>
      </div>
      <div className="panel-body row">
        <input className="input" type="password" style={{ maxWidth: 260 }} placeholder="New passphrase (6+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <button className="btn" disabled={password.length < 6} onClick={() => void run('gm.password', { password }, 'Passphrase changed').then(() => setPassword(''))}>
          Change
        </button>
      </div>
    </section>
  );
}

export function ControlRoom() {
  return (
    <div className="page">
      <div className="page-narrow col gap-16">
        <div className="page-head">
          <h1>Control room</h1>
          <span className="chip gm">
            <Icon name="eyeOff" size={11} /> GM only
          </span>
        </div>
        <PlayersPanel />
        <CampaignPanel />
        <WikiPanel />
        <BackupPanel />
        <PassphrasePanel />
      </div>
    </div>
  );
}
