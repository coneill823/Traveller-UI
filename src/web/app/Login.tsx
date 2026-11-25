import { useState, type FormEvent, type ReactNode } from 'react';
import { setupServer, signInGm, signInPlayer } from '../net';
import { useApp } from '../store';
import { Field, Segmented } from '../ui/basics';

function Frame({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode }) {
  return (
    <div className="gate">
      <div className="gate-card panel">
        <div className="gate-brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-word">TRAVELLER</div>
            <div className="tiny upper faint">Campaign console</div>
          </div>
        </div>
        <h1>{title}</h1>
        <p className="dim small">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

export function Login() {
  const campaign = useApp((s) => s.status?.campaignName);
  const [mode, setMode] = useState<'player' | 'gm'>('player');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'player') await signInPlayer(code);
      else await signInGm(password);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <Frame title={campaign ?? 'Sign in'} subtitle="Players join with the invite code from their GM. The GM signs in with the campaign passphrase.">
      <form className="col gap-12" onSubmit={(e) => void submit(e)}>
        <Segmented
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError('');
          }}
          options={[
            { id: 'player', label: 'Player' },
            { id: 'gm', label: 'Game master' },
          ]}
        />
        {mode === 'player' ? (
          <Field label="Invite code" error={error}>
            <input className="input mono" autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" autoComplete="off" spellCheck={false} />
          </Field>
        ) : (
          <Field label="GM passphrase" error={error}>
            <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
        )}
        <button className="btn primary lg" disabled={busy || (mode === 'player' ? code.trim().length < 4 : password.length === 0)}>
          {busy ? 'Signing in…' : 'Enter'}
        </button>
      </form>
    </Frame>
  );
}

export function Setup() {
  const [setupCode, setSetupCode] = useState('');
  const [campaignName, setCampaignName] = useState('');
  const [gmName, setGmName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await setupServer({ setupCode, campaignName, gmName, password });
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <Frame title="First-time setup" subtitle="This server has no campaign yet. Whoever enters the setup code printed in the server console becomes the GM.">
      <form className="col gap-12" onSubmit={(e) => void submit(e)}>
        <Field label="Setup code" hint="Shown in the terminal window where the server was started.">
          <input className="input mono" autoFocus value={setupCode} onChange={(e) => setSetupCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Campaign name">
          <input className="input" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="e.g. The Kestrel Reach" />
        </Field>
        <Field label="Your name">
          <input className="input" value={gmName} onChange={(e) => setGmName(e.target.value)} placeholder="Referee" />
        </Field>
        <Field label="GM passphrase" hint="At least 6 characters. You will use this to sign in as GM." error={error}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <button className="btn primary lg" disabled={busy || setupCode.trim().length < 8 || password.length < 6}>
          {busy ? 'Creating…' : 'Create campaign'}
        </button>
      </form>
    </Frame>
  );
}
