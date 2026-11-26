/**
 * Inventory: what every traveller, ship and store is holding. Search across all of it, move
 * things between holders, and keep an eye on carrying capacity and cargo space.
 */
import { useMemo, useState } from 'react';
import { contentsVisible, type Viewer } from '../../../shared/knowledge';
import { carryLimit } from '../../../shared/rules/character';
import type { Character, Entity, Id, Item, ItemCategory, Ship, Stash } from '../../../shared/types';
import { formatCredits } from '../../../shared/util';
import { run } from '../../net';
import { setQuery, useRoute } from '../../router';
import { useIsGm, useMe, useType } from '../../store';
import { ConfirmButton, cx, Empty, Field, Modal, Segmented } from '../../ui/basics';
import { Icon, type IconName } from '../../ui/Icon';
import { KnowledgeBadge, KnowledgeControl } from '../../ui/Knowledge';
import { characterName } from '../characters/Sheet';
import { CatalogueDialog } from './Catalogue';

type Holder = Character | Ship | Stash;

const CATEGORY_LABEL: Record<ItemCategory, string> = { weapon: 'Weapons', armour: 'Armour', gear: 'Gear', consumable: 'Consumables', cargo: 'Cargo', other: 'Other' };
const CATEGORY_ICON: Record<ItemCategory, IconName> = { weapon: 'sword', armour: 'shield', gear: 'wrench', consumable: 'package', cargo: 'package', other: 'note' };

export function holderName(h: Entity | undefined): string {
  if (!h) return 'Unknown';
  if (h.type === 'character') return characterName(h as Character);
  if (h.type === 'ship') return (h as Ship).name ?? 'Unnamed ship';
  if (h.type === 'stash') return (h as Stash).name ?? 'Store';
  return h.type;
}

function holderIcon(h: Holder): IconName {
  return h.type === 'ship' ? 'ship' : h.type === 'stash' ? 'package' : 'user';
}

/** Whether this viewer may rearrange what a holder contains (mirrors the server's rule). */
export function canManageHolder(h: Entity | undefined, me: Viewer | undefined, gm: boolean): boolean {
  if (!h || !me) return false;
  if (gm) return true;
  if (h.type === 'character') return (h as Character).kind === 'pc' && (h as Character).ownerId === me.playerId;
  if (h.type === 'ship') return (h as Ship).party === true;
  if (h.type === 'stash') return contentsVisible(h, me);
  return false;
}

export function itemKg(i: Item): number {
  return (i.kg ?? 0) * i.qty;
}

export function cargoTons(items: Item[]): number {
  return Math.round(items.filter((i) => i.category === 'cargo').reduce((n, i) => n + (i.tons ?? 0) * (i.qty || 1), 0) * 100) / 100;
}

export function Meter({ value, max, unit, warnAt = 1 }: { value: number; max: number; unit: string; warnAt?: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const over = max > 0 && value > max * warnAt;
  return (
    <div className="meter" title={`${value} of ${max} ${unit}`}>
      <div className="meter-bar">
        <i style={{ width: `${pct}%` }} className={cx(over && 'over', !over && pct > 80 && 'high')} />
      </div>
      <span className="mono small">
        {Math.round(value * 10) / 10} / {max} {unit}
      </span>
    </div>
  );
}

function ItemRow({ item, holders, editable, showHolder, byId }: { item: Item; holders: Holder[]; editable: boolean; showHolder?: boolean; byId: Map<Id, Holder> }) {
  const [moving, setMoving] = useState(false);
  const [qty, setQty] = useState(String(item.qty));
  const set = (ops: unknown[]) => void run('item.update', { id: item.id, ops });
  const targets = holders.filter((h) => h.id !== item.holderId);
  return (
    <>
      <tr className={cx(item.illegal && 'illegal')}>
        <td>
          <div className="row gap-4">
            <Icon name={CATEGORY_ICON[item.category]} size={13} className="faint" />
            <strong>{item.name}</strong>
            {item.freight && <span className="chip accent">{item.freight.kind}</span>}
            {item.illegal && <span className="chip danger">illegal</span>}
          </div>
          {item.note && <div className="tiny faint">{item.note}</div>}
          {showHolder && <div className="tiny dim">with {holderName(byId.get(item.holderId))}</div>}
        </td>
        <td className="num">
          {editable && item.category !== 'cargo' ? (
            <span className="stepper">
              <button type="button" onClick={() => set([{ op: 'set', path: ['qty'], value: Math.max(0, item.qty - 1) }])} aria-label="One fewer">
                −
              </button>
              <output>{item.qty}</output>
              <button type="button" onClick={() => set([{ op: 'set', path: ['qty'], value: item.qty + 1 }])} aria-label="One more">
                +
              </button>
            </span>
          ) : (
            item.qty
          )}
        </td>
        <td className="num">{item.category === 'cargo' ? `${item.tons ?? 0} t` : item.kg !== undefined ? `${Math.round(itemKg(item) * 10) / 10} kg` : '—'}</td>
        <td className="num">{item.value !== undefined ? formatCredits(item.value * (item.category === 'cargo' ? (item.tons ?? 1) : item.qty)) : '—'}</td>
        <td>
          {editable && (
            <div className="row gap-4" style={{ justifyContent: 'flex-end' }}>
              {item.category !== 'cargo' && byId.get(item.holderId)?.type === 'character' && (
                <label className="check tiny" title="Carried items count towards what the character is hauling">
                  <input type="checkbox" checked={item.carried !== false} onChange={(e) => set([{ op: 'set', path: ['carried'], value: e.target.checked }])} />
                  carried
                </label>
              )}
              <button className={cx('btn sm', moving && 'on')} onClick={() => setMoving((v) => !v)} disabled={targets.length === 0}>
                <Icon name="move" size={12} /> Move
              </button>
              <ConfirmButton className="btn ghost icon sm" label={<Icon name="trash" size={13} />} confirm="Remove" title="Remove" onConfirm={() => void run('item.delete', { id: item.id })} />
            </div>
          )}
        </td>
      </tr>
      {moving && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--bg-2)' }}>
            <div className="row wrap">
              <span className="label">Move</span>
              {item.qty > 1 && <input className="input mono" style={{ width: 70 }} value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} aria-label="How many" />}
              <span className="label">to</span>
              {targets.map((h) => (
                <button
                  key={h.id}
                  className="btn sm"
                  onClick={() => {
                    setMoving(false);
                    void run('item.move', { id: item.id, to: h.id, qty: item.qty > 1 ? Math.max(1, Math.min(item.qty, Number(qty) || item.qty)) : undefined }, `Moved to ${holderName(h)}`);
                  }}
                >
                  <Icon name={holderIcon(h)} size={12} /> {holderName(h)}
                </button>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function NewShip({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', className: '', tons: '200', jump: '1', thrust: '1', cargo: '60', fuelCapacity: '41', funds: '0', party: true });
  const num = (v: string) => Number(v) || 0;
  const create = async () => {
    const res = await run('ship.create', { name: f.name.trim() || undefined, className: f.className.trim() || undefined, tons: num(f.tons), jump: num(f.jump), thrust: num(f.thrust), cargo: num(f.cargo), fuelCapacity: num(f.fuelCapacity), funds: num(f.funds), party: f.party });
    if (res) onClose();
  };
  const field = (key: keyof typeof f, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input className="input mono" value={String(f[key])} onChange={(e) => setF({ ...f, [key]: e.target.value.replace(/[^\d.]/g, '') })} />
    </Field>
  );
  return (
    <Modal
      title="New ship"
      icon="ship"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void create()}>
            Add ship
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <div className="grid-2">
          <Field label="Name">
            <input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Class">
            <input className="input" value={f.className} onChange={(e) => setF({ ...f, className: e.target.value })} placeholder="e.g. Far Trader" />
          </Field>
        </div>
        <div className="grid-3">
          {field('tons', 'Hull (tons)')}
          {field('jump', 'Jump rating')}
          {field('thrust', 'Thrust')}
          {field('cargo', 'Cargo (tons)')}
          {field('fuelCapacity', 'Fuel (tons)')}
          {field('funds', "Ship's funds (Cr)")}
        </div>
        <label className="check">
          <input type="checkbox" checked={f.party} onChange={(e) => setF({ ...f, party: e.target.checked })} />
          The party crews this ship (every player can see and use it)
        </label>
        <p className="tiny faint">This records the basics for cargo and travel. The ship builder fills in the full design.</p>
      </div>
    </Modal>
  );
}

export function InventoryPage() {
  const route = useRoute();
  const gm = useIsGm();
  const me = useMe();
  const viewer: Viewer | undefined = me ? { role: gm ? 'gm' : 'player', playerId: me.viewAs ?? me.playerId } : undefined;
  const characters = useType('character');
  const ships = useType('ship');
  const stashes = useType('stash');
  const items = useType('item');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<ItemCategory | 'all'>('all');
  const [dialog, setDialog] = useState<'add' | 'ship' | 'stash' | null>(null);
  const [stashName, setStashName] = useState('');

  const holders = useMemo(() => {
    const mine = (c: Character) => c.ownerId === me?.playerId;
    const pcs = characters.filter((c) => c.kind === 'pc').sort((a, b) => Number(mine(b)) - Number(mine(a)) || characterName(a).localeCompare(characterName(b)));
    const others = characters.filter((c) => c.kind !== 'pc' && (gm || (viewer && contentsVisible(c, viewer))));
    return { pcs, ships: [...ships].sort((a, b) => Number(!!b.party) - Number(!!a.party)), stashes: [...stashes], others };
  }, [characters, ships, stashes, me, gm, viewer]);
  const all: Holder[] = useMemo(() => [...holders.pcs, ...holders.ships, ...holders.stashes, ...holders.others], [holders]);
  const byId = useMemo(() => new Map(all.map((h) => [h.id, h])), [all]);
  const byHolder = useMemo(() => {
    const out = new Map<Id, Item[]>();
    for (const i of items) out.set(i.holderId, [...(out.get(i.holderId) ?? []), i]);
    return out;
  }, [items]);

  const selectedId = route.query.get('h') ?? holders.pcs.find((c) => c.ownerId === me?.playerId)?.id ?? all[0]?.id;
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const searching = q.trim().length >= 2;
  const needle = q.trim().toLowerCase();
  const pool = searching ? items.filter((i) => byId.has(i.holderId)) : selected ? (byHolder.get(selected.id) ?? []) : [];
  const shown = pool
    .filter((i) => category === 'all' || i.category === category)
    .filter((i) => !searching || `${i.name} ${i.note ?? ''} ${(i.tags ?? []).join(' ')}`.toLowerCase().includes(needle))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const moveTargets = all.filter((h) => h.type === 'character' ? (h as Character).kind === 'pc' || gm : canManageHolder(h, viewer, gm));
  const selectedItems = selected ? (byHolder.get(selected.id) ?? []) : [];
  const carriedKg = selectedItems.filter((i) => i.category !== 'cargo' && i.carried !== false).reduce((n, i) => n + itemKg(i), 0);
  const canEditSelected = !me?.viewAs && canManageHolder(selected, viewer, gm);

  const HolderButton = ({ h }: { h: Holder }) => {
    const list = byHolder.get(h.id) ?? [];
    return (
      <button className={cx('holder', !searching && selected?.id === h.id && 'on')} onClick={() => (setQ(''), setQuery({ h: h.id }, { replace: true }))}>
        <Icon name={holderIcon(h)} size={15} />
        <span className="grow">
          <strong>{holderName(h)}</strong>
          <span className="tiny faint">
            {h.type === 'ship' ? `${cargoTons(list)} / ${(h as Ship).cargo ?? '—'} t cargo · ${list.filter((i) => i.category !== 'cargo').length} in the locker` : `${list.length} item${list.length === 1 ? '' : 's'}`}
          </span>
        </span>
        {gm && (h.type === 'stash' || (h.type === 'ship' && !(h as Ship).party)) && <KnowledgeBadge entity={h} />}
      </button>
    );
  };

  return (
    <div className="inventory">
      <aside className="inventory-side">
        <div className="library-search">
          <Icon name="search" size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search everything…" aria-label="Search all inventories" />
        </div>
        <div className="side-scroll">
          <div className="library-folder">Travellers</div>
          {holders.pcs.map((h) => (
            <HolderButton key={h.id} h={h} />
          ))}
          {holders.pcs.length === 0 && <div className="pad faint small">No travellers yet. Create one under Crew.</div>}
          <div className="library-folder row between">
            Ships
            {gm && (
              <button className="btn ghost sm" onClick={() => setDialog('ship')}>
                <Icon name="plus" size={11} /> Ship
              </button>
            )}
          </div>
          {holders.ships.map((h) => (
            <HolderButton key={h.id} h={h} />
          ))}
          {holders.ships.length === 0 && <div className="pad faint small">{gm ? 'Add the party’s ship to track its hold and locker.' : 'No ship yet.'}</div>}
          {(holders.stashes.length > 0 || gm) && (
            <>
              <div className="library-folder row between">
                Stores &amp; caches
                {gm && (
                  <button className="btn ghost sm" onClick={() => setDialog('stash')}>
                    <Icon name="plus" size={11} /> Store
                  </button>
                )}
              </div>
              {holders.stashes.map((h) => (
                <HolderButton key={h.id} h={h} />
              ))}
            </>
          )}
          {holders.others.length > 0 && (
            <>
              <div className="library-folder">NPCs &amp; creatures</div>
              {holders.others.map((h) => (
                <HolderButton key={h.id} h={h} />
              ))}
            </>
          )}
        </div>
      </aside>

      <div className="inventory-main">
        {!selected && !searching ? (
          <Empty icon="package" title="Nothing to show">
            Create a traveller or a ship to start keeping track of gear and cargo.
          </Empty>
        ) : (
          <>
            <div className="page-head" style={{ marginBottom: 10 }}>
              {searching ? (
                <h1>Search: “{q.trim()}”</h1>
              ) : (
                <>
                  <Icon name={holderIcon(selected!)} size={22} style={{ color: 'var(--accent)' }} />
                  <div>
                    <h1>{holderName(selected)}</h1>
                    <div className="small dim">
                      {selected!.type === 'ship' ? ((selected as Ship).className ?? 'Ship') : selected!.type === 'stash' ? ((selected as Stash).summary ?? 'Store') : ((selected as Character).title ?? '')}
                    </div>
                  </div>
                  <div className="grow" />
                  {selected!.type === 'character' && <Meter value={carriedKg} max={carryLimit(selected as Character)} unit="kg carried" />}
                  {selected!.type === 'ship' && (selected as Ship).cargo !== undefined && <Meter value={cargoTons(selectedItems)} max={(selected as Ship).cargo!} unit="t cargo" />}
                  {selected!.type !== 'stash' && (
                    <span className="chip accent mono" title="Credits">
                      <Icon name="coins" size={12} /> {formatCredits(selected!.type === 'ship' ? ((selected as Ship).funds ?? 0) : ((selected as Character).credits ?? 0))}
                    </span>
                  )}
                  {canEditSelected && (
                    <button className="btn primary" onClick={() => setDialog('add')}>
                      <Icon name="plus" size={13} /> Add
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="row wrap" style={{ marginBottom: 10 }}>
              <Segmented value={category} onChange={setCategory} options={[{ id: 'all' as const, label: 'All' }, ...(Object.keys(CATEGORY_LABEL) as ItemCategory[]).map((c) => ({ id: c, label: CATEGORY_LABEL[c] }))]} />
              {gm && selected && !searching && (selected.type === 'stash' || (selected.type === 'ship' && !(selected as Ship).party)) && (
                <details className="grow">
                  <summary className="small" style={{ color: 'var(--gm)', cursor: 'pointer' }}>
                    Who can see this
                  </summary>
                  <div className="panel pad" style={{ marginTop: 6, maxWidth: 420 }}>
                    <KnowledgeControl entity={selected} />
                  </div>
                </details>
              )}
            </div>
            {shown.length === 0 ? (
              <Empty icon="package" title={searching ? 'No matches' : 'Empty'}>
                {searching ? 'Nothing anyone is holding matches that.' : canEditSelected ? 'Use Add to record what is here.' : ''}
              </Empty>
            ) : (
              <div className="panel scroll" style={{ flex: '1 1 auto', minHeight: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Qty</th>
                      <th className="num">Mass</th>
                      <th className="num">Value</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((i) => (
                      <ItemRow key={i.id} item={i} holders={moveTargets} byId={byId} showHolder={searching} editable={!me?.viewAs && canManageHolder(byId.get(i.holderId), viewer, gm)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {gm && selected && !searching && selected.type !== 'character' && (
              <div style={{ marginTop: 10 }}>
                <ConfirmButton label={`Delete ${selected.type === 'ship' ? 'ship' : 'store'}`} confirm="Delete with everything in it" icon="trash" onConfirm={() => void run('entity.delete', { id: selected.id })} />
              </div>
            )}
          </>
        )}
      </div>

      {dialog === 'add' && selected && <CatalogueDialog holder={selected} holderName={holderName(selected)} onClose={() => setDialog(null)} />}
      {dialog === 'ship' && <NewShip onClose={() => setDialog(null)} />}
      {dialog === 'stash' && (
        <Modal
          title="New store or cache"
          icon="package"
          onClose={() => setDialog(null)}
          footer={
            <button
              className="btn primary"
              disabled={!stashName.trim()}
              onClick={() =>
                void run('stash.create', { name: stashName.trim() }).then(() => {
                  setStashName('');
                  setDialog(null);
                })
              }
            >
              Create
            </button>
          }
        >
          <Field label="Name" hint="Hidden from players until you reveal it, e.g. when they find it.">
            <input className="input" autoFocus value={stashName} onChange={(e) => setStashName(e.target.value)} placeholder="e.g. Smuggler cache in the outer belt" />
          </Field>
        </Modal>
      )}
    </div>
  );
}
