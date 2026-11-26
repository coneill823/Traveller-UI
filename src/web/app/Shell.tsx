/** The application frame: navigation rail, top bar with campaign status, content area, dice dock. */
import { useEffect, useState } from 'react';
import { PARTY_VIEWER_ID } from '../../shared/knowledge';
import type { StarSystem } from '../../shared/types';
import { CharactersPage } from '../modules/characters/CharactersPage';
import { RollFlash } from '../modules/characters/rolling';
import { ControlRoom } from '../modules/control/ControlRoom';
import { DiceDock } from '../modules/dice/DiceDock';
import { InventoryPage } from '../modules/inventory/InventoryPage';
import { TradePage } from '../modules/trade/TradePage';
import { ShipyardPage } from '../modules/shipyard/ShipyardPage';
import { LibraryPage } from '../modules/library/LibraryPage';
import { MapPage } from '../modules/map/MapPage';
import { ObjectivesPage } from '../modules/objectives/ObjectivesPage';
import { run, setFields, setViewAs, signOut } from '../net';
import { Link, navigate, useRoute } from '../router';
import { useApp, useCampaign, useEntity, useIsGm, useMe, usePlayers, useType } from '../store';
import { cx, Modal } from '../ui/basics';
import { Icon, type IconName } from '../ui/Icon';

interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  gm?: boolean;
}

const NAV: NavItem[] = [
  { id: 'map', label: 'Map', icon: 'map' },
  { id: 'characters', label: 'Crew', icon: 'users' },
  { id: 'inventory', label: 'Cargo', icon: 'package' },
  { id: 'trade', label: 'Trade', icon: 'coins' },
  { id: 'shipyard', label: 'Yard', icon: 'wrench' },
  { id: 'objectives', label: 'Goals', icon: 'target' },
  { id: 'library', label: 'Library', icon: 'book' },
  { id: 'control', label: 'Control', icon: 'settings', gm: true },
];

export function formatDate(date: { day: number; year: number } | undefined): string {
  if (!date) return '—';
  return `${String(date.day).padStart(3, '0')}-${date.year}`;
}

function DateControl() {
  const campaign = useCampaign();
  const gm = useIsGm();
  const [open, setOpen] = useState(false);
  if (!campaign) return null;
  const advance = (days: number) => {
    let day = campaign.date.day + days;
    let year = campaign.date.year;
    while (day > 365) {
      day -= 365;
      year++;
    }
    while (day < 1) {
      day += 365;
      year--;
    }
    void setFields(campaign.id, { date: { day, year } });
  };
  return (
    <>
      <button className="status-item" disabled={!gm} onClick={() => setOpen(true)} title={gm ? 'Change the in-game date' : 'In-game date (day-year)'}>
        <Icon name="clock" size={14} />
        <span className="mono">{formatDate(campaign.date)}</span>
      </button>
      {open && (
        <Modal title="In-game date" icon="clock" onClose={() => setOpen(false)}>
          <div className="col gap-12">
            <div className="row gap-12">
              <label className="field">
                <span className="label">Day (1–365)</span>
                <input className="input mono" type="number" min={1} max={365} value={campaign.date.day} onChange={(e) => void setFields(campaign.id, { date: { ...campaign.date, day: Math.max(1, Math.min(365, Number(e.target.value) || 1)) } })} />
              </label>
              <label className="field">
                <span className="label">Year</span>
                <input className="input mono" type="number" value={campaign.date.year} onChange={(e) => void setFields(campaign.id, { date: { ...campaign.date, year: Number(e.target.value) || 0 } })} />
              </label>
            </div>
            <div className="row wrap">
              <span className="label">Advance</span>
              <button className="btn sm" onClick={() => advance(1)}>
                +1 day
              </button>
              <button className="btn sm" onClick={() => advance(7)} title="One week: a jump, or a week in port">
                +1 week
              </button>
              <button className="btn sm" onClick={() => advance(14)}>
                +2 weeks
              </button>
              <button className="btn sm" onClick={() => advance(-1)}>
                −1 day
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function LocationStatus() {
  const campaign = useCampaign();
  const system = useEntity<StarSystem>(campaign?.location?.systemId);
  if (!campaign?.location?.systemId) return null;
  return (
    <button className="status-item" onClick={() => navigate(`/map?sys=${campaign.location!.systemId}&focus=1`)} title="Where the party is now">
      <Icon name="pin" size={14} />
      <span>{system?.name ?? 'Unknown system'}</span>
    </button>
  );
}

function ViewSwitch() {
  const me = useMe();
  const players = usePlayers();
  const [open, setOpen] = useState(false);
  if (me?.role !== 'gm') return null;
  const viewing = me.viewAs;
  const viewingName = viewing === PARTY_VIEWER_ID ? 'the party' : players.find((p) => p.id === viewing)?.name;
  return (
    <div className="view-switch">
      <div className="segmented gm">
        <button className={cx(!viewing && 'on')} onClick={() => void setViewAs(undefined)} title="Full data and editing tools">
          <Icon name="edit" size={12} /> Creator
        </button>
        <button className={cx(viewing && 'on')} onClick={() => setOpen((v) => !v)} title="Preview exactly what players see">
          <Icon name="eye" size={12} /> {viewing ? `As ${viewingName}` : 'Player view'} <Icon name="chevronDown" size={11} />
        </button>
      </div>
      {open && (
        <div className="menu" onMouseLeave={() => setOpen(false)}>
          <div className="menu-title">Preview as</div>
          <button
            className={cx('menu-item', viewing === PARTY_VIEWER_ID && 'on')}
            onClick={() => {
              setOpen(false);
              void setViewAs(PARTY_VIEWER_ID);
            }}
          >
            <Icon name="users" size={14} /> The party <span className="faint tiny">shared knowledge only</span>
          </button>
          {players.map((p) => (
            <button
              key={p.id}
              className={cx('menu-item', viewing === p.id && 'on')}
              onClick={() => {
                setOpen(false);
                void setViewAs(p.id);
              }}
            >
              <span className="dot" style={{ background: p.color }} /> {p.name}
            </button>
          ))}
          {players.length === 0 && <div className="menu-note">Add players in the Control room to preview their personal views.</div>}
        </div>
      )}
    </div>
  );
}

function Presence() {
  const players = useType('player');
  const online = useApp((s) => s.online);
  return (
    <div className="presence" title="Who is connected">
      {players.map((p) => (
        <span key={p.id} className={cx('presence-pip', online.includes(p.id) && 'on')} style={{ ['--c' as string]: p.color }} title={`${p.name}${p.role === 'gm' ? ' (GM)' : ''} — ${online.includes(p.id) ? 'online' : 'offline'}`}>
          {p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
    </div>
  );
}

export function Shell() {
  const route = useRoute();
  const me = useMe();
  const gm = useIsGm();
  const campaign = useCampaign();
  const connected = useApp((s) => s.connected);
  const diceOpen = useApp((s) => s.diceOpen);
  const players = useType('player');
  const myName = players.find((p) => p.id === me?.playerId)?.name;
  const section = route.parts[0] ?? 'map';

  useEffect(() => {
    if (route.parts.length === 0 || route.parts[0] === 'join') navigate('/map', { replace: true });
  }, [route.parts]);

  // The control room is for the GM in creator mode only.
  const visibleNav = NAV.filter((n) => !n.gm || gm);

  let content;
  switch (section) {
    case 'characters':
      content = <CharactersPage characterId={route.parts[1]} />;
      break;
    case 'inventory':
      content = <InventoryPage />;
      break;
    case 'trade':
      content = <TradePage />;
      break;
    case 'shipyard':
      content = <ShipyardPage designId={route.parts[1]} />;
      break;
    case 'objectives':
      content = <ObjectivesPage />;
      break;
    case 'library':
      content = <LibraryPage pageId={route.parts[1]} />;
      break;
    case 'control':
      content = gm ? <ControlRoom /> : <MapPage />;
      break;
    default:
      content = <MapPage />;
  }

  return (
    <div className={cx('shell', diceOpen && 'dice-open')}>
      <nav className="rail" aria-label="Sections">
        <Link to="/map" className="rail-brand" title={campaign?.name}>
          <div className="brand-mark" />
        </Link>
        {visibleNav.map((n) => (
          <Link key={n.id} to={`/${n.id}`} className={cx('rail-item', section === n.id && 'on', n.gm && 'gm')} title={n.label}>
            <Icon name={n.icon} size={20} />
            <span>{n.label}</span>
          </Link>
        ))}
        <div className="grow" />
        <button className={cx('rail-item', diceOpen && 'on')} onClick={() => useApp.setState({ diceOpen: !diceOpen })} title="Dice and roll log">
          <Icon name="dice" size={20} />
          <span>Dice</span>
        </button>
      </nav>

      <header className="topbar">
        <div className="topbar-title">
          <span className="brand-word">TRAVELLER</span>
          <span className="topbar-sep" />
          <span className="topbar-campaign">{campaign?.name}</span>
        </div>
        <DateControl />
        <LocationStatus />
        <div className="grow" />
        {!connected && (
          <span className="chip warn">
            <Icon name="refresh" size={11} /> Reconnecting
          </span>
        )}
        <ViewSwitch />
        <Presence />
        <button className="status-item" onClick={() => signOut()} title={`Signed in as ${myName ?? ''}. Click to sign out.`}>
          <span className="small">{myName}</span>
          <Icon name="logout" size={14} />
        </button>
      </header>

      {me?.viewAs && (
        <div className="preview-banner">
          <Icon name="eye" size={14} />
          Player view: you are seeing exactly what {me.viewAs === PARTY_VIEWER_ID ? 'the party as a whole' : (players.find((p) => p.id === me.viewAs)?.name ?? 'this player')} can see. Editing tools are off.
          <button className="btn sm gm" onClick={() => void setViewAs(undefined)}>
            Back to creator mode
          </button>
        </div>
      )}

      <main className="content">{content}</main>
      {diceOpen && <DiceDock />}
      <RollFlash />
    </div>
  );
}

/** GM helper: make every player's screen open the current view. */
export function PushViewButton({ path, label = 'Show players' }: { path: string; label?: string }) {
  const gm = useIsGm();
  if (!gm) return null;
  return (
    <button className="btn sm gm" title="Open this view on every player's screen" onClick={() => void run('ui.push', { path }, 'Sent to players')}>
      <Icon name="send" size={12} /> {label}
    </button>
  );
}
