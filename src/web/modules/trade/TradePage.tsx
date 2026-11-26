/**
 * Trade: the markets where the party is, markets elsewhere in the system, and whatever the party
 * has learned about markets further away. Players see only the catalogues and demands the GM has
 * shared with them.
 */
import { useMemo, useState } from 'react';
import { hexDistance } from '../../../shared/hex';
import type { TradeGood, TradeRules } from '../../../shared/rulepack';
import { skillLevel, unskilledDm } from '../../../shared/rules/character';
import { expectedPurchase, expectedSale, type TradeWorld } from '../../../shared/rules/trade';
import { systemTradeCodes } from '../../../shared/rules/world';
import type { Body, Character, GameDate, Id, Item, Market, MarketLot, Ship } from '../../../shared/types';
import { parseUwp } from '../../../shared/uwp';
import { formatCredits } from '../../../shared/util';
import { act, run } from '../../net';
import { navigate } from '../../router';
import { toast, useCampaign, useIsGm, useMe, useRules, useType } from '../../store';
import { ConfirmButton, cx, Empty, Field, Modal, Segmented, Tabs } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { AudiencePicker, KnowledgeControl } from '../../ui/Knowledge';
import { flashRoll, useRollPrefs, DiceModeSwitch } from '../characters/rolling';
import { characterName } from '../characters/Sheet';
import { cargoTons, Meter } from '../inventory/InventoryPage';
import { systemLabel, useMapData, type MapData, type SysInfo } from '../map/mapData';
import { fitTo, selectSystem, setPlanner, useMap } from '../map/mapStore';
import { SystemPicker } from '../map/SystemPicker';
import { formatDate } from '../../app/Shell';

const VENUE: Record<Market['venue'], string> = { surface: 'On the surface', orbit: 'In orbit', station: 'Station' };

function worldOf(market: Pick<Market, 'systemId' | 'bodyId'>, data: MapData, bodies: Body[]): TradeWorld | undefined {
  const info = data.byId.get(market.systemId);
  if (!info) return undefined;
  const body = market.bodyId ? bodies.find((b) => b.id === market.bodyId) : undefined;
  if (body && !body.mainworld && body.uwp) return { codes: systemTradeCodes(body.uwp, undefined, data.rules), zone: info.sys.zone ?? '', uwp: parseUwp(body.uwp) };
  return { codes: info.codes, zone: info.sys.zone ?? '', uwp: info.uwp };
}

function fmtDm(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** Who does the talking: a traveller's Broker skill, a hired local broker, or a number the GM sets. */
interface Negotiator {
  characterId?: Id;
  localBroker?: boolean;
  broker?: number;
}

function useBrokers(illegal: boolean): { list: { c: Character; level: number | null; dm: number }[]; best: number } {
  const characters = useType('character');
  const pack = useRules();
  const me = useMe();
  return useMemo(() => {
    const skill = illegal ? 'Streetwise' : 'Broker';
    const list = characters
      .filter((c) => c.kind === 'pc')
      .map((c) => {
        const level = skillLevel(c.skills, skill);
        return { c, level, dm: level ?? unskilledDm(c.skills, pack) };
      })
      .sort((a, b) => b.dm - a.dm || Number(b.c.ownerId === me?.playerId) - Number(a.c.ownerId === me?.playerId));
    return { list, best: list[0]?.dm ?? 0 };
  }, [characters, pack, illegal, me]);
}

function NegotiateDialog({ title, illegal, onRoll, onClose }: { title: string; illegal: boolean; onRoll: (who: Negotiator, dm: number, manual?: number[]) => Promise<void>; onClose: () => void }) {
  const gm = useIsGm();
  const rules = useRules().trade;
  const { list } = useBrokers(illegal);
  const table = useRollPrefs((s) => s.dice) === 'table';
  const [who, setWho] = useState<string>(list[0]?.c.id ?? 'local');
  const [manualSkill, setManualSkill] = useState(0);
  const [dm, setDm] = useState(0);
  const [dice, setDice] = useState('');
  const [busy, setBusy] = useState(false);
  const typed = dice.split('').filter((ch) => ch >= '1' && ch <= '6').map(Number);
  const needed = rules?.priceRoll.dice ?? 3;
  const go = async () => {
    setBusy(true);
    await onRoll(who === 'local' ? { localBroker: true } : who === 'manual' ? { broker: manualSkill } : { characterId: who }, dm, table ? typed : undefined);
    setBusy(false);
  };
  return (
    <Modal
      title={title}
      icon="coins"
      onClose={onClose}
      footer={
        <>
          <span className="grow">
            <DiceModeSwitch />
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || (table && typed.length !== needed)} onClick={() => void go()}>
            <Icon name="dice" size={13} /> {table ? 'Record roll' : `Roll ${needed}D for a price`}
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <Field label="Who negotiates" hint={`The price is set by ${needed}D plus the negotiator's ${illegal ? 'Streetwise' : 'Broker'} skill and the world's trade modifiers, less the other side's Broker skill.`}>
          <div className="col gap-4">
            {list.map(({ c, level, dm: skillDm }) => (
              <label key={c.id} className="check">
                <input type="radio" name="negotiator" checked={who === c.id} onChange={() => setWho(c.id)} />
                {characterName(c)}{' '}
                <span className="faint small">
                  {illegal ? 'Streetwise' : 'Broker'} {level ?? `unskilled (${fmtDm(skillDm)})`}
                </span>
              </label>
            ))}
            <label className="check">
              <input type="radio" name="negotiator" checked={who === 'local'} onChange={() => setWho('local')} />
              Hire a local broker{' '}
              <span className="faint small">
                skill {rules?.localBroker.skillDice}D÷{rules?.localBroker.skillDivisor}, {fmtDm(rules?.localBroker.negotiationDm ?? 2)} for local knowledge, takes {Math.round((illegal ? (rules?.localBroker.illegalFee ?? 0.2) : (rules?.localBroker.fee ?? 0.1)) * 100)}% of the deal
              </span>
            </label>
            {gm && (
              <label className="check" style={{ color: 'var(--gm)' }}>
                <input type="radio" name="negotiator" checked={who === 'manual'} onChange={() => setWho('manual')} />
                Set the skill by hand
                {who === 'manual' && <input className="input mono" style={{ width: 60, height: 24 }} type="number" value={manualSkill} onChange={(e) => setManualSkill(Number(e.target.value) || 0)} />}
              </label>
            )}
          </div>
        </Field>
        <Field label="Other modifiers" hint="Anything the GM allows for good roleplay, bribes, or a bad reputation.">
          <div className="stepper" style={{ alignSelf: 'flex-start' }}>
            <button type="button" onClick={() => setDm(dm - 1)}>
              −
            </button>
            <output>{fmtDm(dm)}</output>
            <button type="button" onClick={() => setDm(dm + 1)}>
              +
            </button>
          </div>
        </Field>
        {table && (
          <Field label={`Dice you rolled (${needed})`}>
            <input className="input mono" autoFocus inputMode="numeric" value={dice} placeholder="4 3 5" onChange={(e) => setDice(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && typed.length === needed && void go()} />
          </Field>
        )}
        <div className="notice">
          <Icon name="info" size={14} /> The price that comes up is the deal on the table. Walk away and that {title.startsWith('Sell') ? 'buyer' : 'supplier'} will not talk again for about a month.
        </div>
      </div>
    </Modal>
  );
}

function ShipBar({ ship, ships, onPick }: { ship: Ship | undefined; ships: Ship[]; onPick: (id: Id) => void }) {
  const items = useType('item');
  if (!ship) return null;
  const used = cargoTons(items.filter((i) => i.holderId === ship.id));
  return (
    <div className="trade-ship">
      <Icon name="ship" size={16} />
      {ships.length > 1 ? (
        <select className="select" style={{ width: 200 }} value={ship.id} onChange={(e) => onPick(e.target.value)} aria-label="Ship">
          {ships.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name ?? 'Unnamed ship'}
            </option>
          ))}
        </select>
      ) : (
        <strong>{ship.name ?? 'Unnamed ship'}</strong>
      )}
      {ship.cargo !== undefined && <Meter value={used} max={ship.cargo} unit="t hold" />}
      <span className="chip accent mono">
        <Icon name="coins" size={12} /> {formatCredits(ship.funds ?? 0)}
      </span>
    </div>
  );
}

function LotRow({ market, lot, world, ship, rules, canTrade, broker }: { market: Market; lot: MarketLot; world: TradeWorld | undefined; ship: Ship | undefined; rules: TradeRules; canTrade: boolean; broker: number }) {
  const gm = useIsGm();
  const items = useType('item');
  const [negotiating, setNegotiating] = useState(false);
  const [tons, setTons] = useState('');
  const good = rules.goods.find((g) => g.code === lot.good);
  const expect = good && world ? expectedPurchase(good, world, broker, rules) : undefined;
  const free = ship ? (ship.cargo ?? Infinity) - cargoTons(items.filter((i) => i.holderId === ship.id)) : 0;
  // Default to as much as fits in the hold and the ship's account can pay for.
  const affordable = lot.offer && ship ? Math.floor((ship.funds ?? 0) / (lot.offer.price * (1 + (lot.offer.fee ?? 0)) || 1)) : Infinity;
  const want = Math.min(lot.tons, Number(tons) || Math.max(0, Math.min(lot.tons, Math.floor(free), affordable)));
  return (
    <tr className={cx(lot.illegal && 'illegal')}>
      <td>
        <strong>{lot.name}</strong>
        {lot.illegal && <span className="chip danger" style={{ marginLeft: 6 }}>illegal</span>}
        {good?.examples && <div className="tiny faint">{good.examples}</div>}
      </td>
      <td className="num">{lot.tons} t</td>
      <td className="num">{formatCredits(lot.basePrice)}</td>
      <td className="num" title="Typical price here for your best negotiator, before the dice">
        {expect ? (
          <span className={cx(expect.pct < 100 ? 'fuel-ok' : expect.pct > 100 ? 'fuel-none' : '')}>
            {expect.pct}% <span className="faint">({fmtDm(expect.dm)})</span>
          </span>
        ) : (
          '—'
        )}
      </td>
      <td>
        {lot.offer ? (
          <div className="row wrap gap-4" style={{ justifyContent: 'flex-end' }}>
            <span className="chip accent mono" title={`${lot.offer.pct}% of the base price${lot.offer.fee ? `, plus the broker's ${Math.round(lot.offer.fee * 100)}%` : ''}`}>
              {formatCredits(lot.offer.price)}/t · {lot.offer.pct}%
            </span>
            {canTrade && ship && (
              <>
                <input className="input mono" style={{ width: 64 }} value={tons} placeholder={String(want)} onChange={(e) => setTons(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Tons to buy" />
                <button
                  className="btn primary sm"
                  disabled={want <= 0}
                  title={want <= 0 ? 'No cargo space free, or not enough credits' : `Buy ${want} tons for ${formatCredits(Math.round(want * lot.offer.price * (1 + (lot.offer.fee ?? 0))))}`}
                  onClick={() => void run<{ cost: number }>('trade.buy', { marketId: market.id, lotId: lot.id, tons: want, shipId: ship.id }).then((r) => r && (toast(`Bought ${want} t of ${lot.name} for ${formatCredits(r.cost)}`, 'ok'), setTons('')))}
                >
                  Buy {want} t
                </button>
                <ConfirmButton className="btn sm ghost" label="Walk away" confirm="No deal for a month" onConfirm={() => void run('trade.refuse', { marketId: market.id, lotId: lot.id })} />
              </>
            )}
          </div>
        ) : lot.refused ? (
          <span className="faint small">Refused on {formatDate(lot.refused)}</span>
        ) : canTrade ? (
          <button className="btn sm" style={{ float: 'right' }} onClick={() => setNegotiating(true)}>
            <Icon name="coins" size={12} /> Get a price
          </button>
        ) : null}
        {gm && (
          <button className="btn ghost icon sm" style={{ float: 'right' }} title="Remove this lot" onClick={() => void run('entity.patch', { id: market.id, ops: [{ op: 'del', path: ['lots', lot.id] }] })}>
            <Icon name="x" size={12} />
          </button>
        )}
        {negotiating && (
          <NegotiateDialog
            title={`Buy ${lot.name}`}
            illegal={!!lot.illegal}
            onClose={() => setNegotiating(false)}
            onRoll={async (who, dm, manual) => {
              try {
                const res = await act<{ rollId: Id }>('trade.quote', { marketId: market.id, lotId: lot.id, ...who, dm, manual });
                flashRoll(res.rollId);
                setNegotiating(false);
              } catch (err) {
                toast((err as Error).message, 'error');
              }
            }}
          />
        )}
      </td>
    </tr>
  );
}

function MarketCard({ market, data, bodies, ship, canTrade }: { market: Market; data: MapData; bodies: Body[]; ship: Ship | undefined; canTrade: boolean }) {
  const gm = useIsGm();
  const rules = useRules().trade;
  const info = data.byId.get(market.systemId);
  const body = market.bodyId ? bodies.find((b) => b.id === market.bodyId) : undefined;
  const world = worldOf(market, data, bodies);
  const { best } = useBrokers(!!market.blackMarket);
  const [adding, setAdding] = useState<'lot' | 'demand' | null>(null);
  const [form, setForm] = useState({ good: '', tons: '10', what: '', dm: '2', note: '' });
  const catalogueKnown = market.broker !== undefined;

  return (
    <section className={cx('panel market', market.blackMarket && 'black')}>
      <div className={cx('panel-head', gm && !(market.known?.exists?.length ?? 0) && 'gm')}>
        <div className="grow">
          <h2>{market.name ?? 'Market'}</h2>
          <div className="small dim">
            {systemLabel(info)}
            {body?.name && body.name !== info?.sys.name ? ` · ${body.name}` : ''} · {VENUE[market.venue]}
            {market.blackMarket ? ' · black market' : ''}
            {market.stocked ? ` · stock as of ${formatDate(market.stocked)}` : ''}
          </div>
        </div>
        {world && world.codes.length > 0 && (
          <div className="row gap-4 wrap">
            {world.codes.map((c) => (
              <span key={c} className="chip mono">
                {c}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="panel-body col">
        {gm && (
          <details>
            <summary className="small" style={{ color: 'var(--gm)', cursor: 'pointer' }}>
              GM: who knows about this market
            </summary>
            <div className="col" style={{ padding: '8px 0' }}>
              <KnowledgeControl entity={market} />
              <div className="row wrap">
                <button className="btn sm" onClick={() => void run('market.restock', { id: market.id }, 'Restocked')} disabled={!rules}>
                  <Icon name="refresh" size={12} /> Restock
                </button>
                <button className="btn sm" onClick={() => setAdding(adding === 'lot' ? null : 'lot')}>
                  <Icon name="plus" size={12} /> Lot
                </button>
                <button className="btn sm" onClick={() => setAdding(adding === 'demand' ? null : 'demand')}>
                  <Icon name="plus" size={12} /> Demand
                </button>
                <label className="row gap-4 small">
                  Their Broker
                  <input className="input mono" style={{ width: 56, height: 24 }} type="number" min={0} max={10} value={market.broker ?? 2} onChange={(e) => void run('entity.patch', { id: market.id, ops: [{ op: 'set', path: ['broker'], value: Number(e.target.value) || 0 }] })} />
                </label>
                <div className="grow" />
                <ConfirmButton label="Delete market" confirm="Delete" icon="trash" onConfirm={() => void run('entity.delete', { id: market.id })} />
              </div>
              {adding === 'lot' && (
                <div className="row wrap">
                  <select className="select" style={{ maxWidth: 260 }} value={form.good} onChange={(e) => setForm({ ...form, good: e.target.value })}>
                    <option value="">Choose goods…</option>
                    {(rules?.goods ?? []).filter((g) => !g.exotic).map((g) => (
                      <option key={g.code} value={g.code}>
                        {g.code} {g.name}
                      </option>
                    ))}
                  </select>
                  <input className="input mono" style={{ width: 80 }} value={form.tons} onChange={(e) => setForm({ ...form, tons: e.target.value.replace(/[^\d.]/g, '') })} aria-label="Tons" />
                  <span className="small dim">tons</span>
                  <button className="btn sm primary" disabled={!form.good} onClick={() => void run('market.addLot', { id: market.id, good: Number(form.good), tons: Number(form.tons) || 1 }).then(() => setAdding(null))}>
                    Add lot
                  </button>
                </div>
              )}
              {adding === 'demand' && (
                <div className="col">
                  <div className="row wrap">
                    <input className="input" style={{ maxWidth: 280 }} placeholder="What they want, e.g. Aluminium plating" value={form.what} onChange={(e) => setForm({ ...form, what: e.target.value })} />
                    <select className="select" style={{ maxWidth: 220 }} value={form.good} onChange={(e) => setForm({ ...form, good: e.target.value })} aria-label="Matching trade good">
                      <option value="">No matching trade good</option>
                      {(rules?.goods ?? []).filter((g) => !g.exotic).map((g) => (
                        <option key={g.code} value={g.code}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                    <label className="row gap-4 small">
                      Sale bonus
                      <input className="input mono" style={{ width: 56 }} value={form.dm} onChange={(e) => setForm({ ...form, dm: e.target.value.replace(/[^\d-]/g, '') })} />
                    </label>
                  </div>
                  <div className="row">
                    <input className="input" placeholder="Note (why, until when, who is asking)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                    <button className="btn sm primary" disabled={!form.what.trim() && !form.good} onClick={() => void run('market.demand', { id: market.id, what: form.what.trim() || undefined, good: form.good ? Number(form.good) : undefined, dm: Number(form.dm) || 0, note: form.note.trim() || undefined }).then(() => (setAdding(null), setForm({ ...form, what: '', note: '' })))}>
                      Add demand
                    </button>
                  </div>
                </div>
              )}
            </div>
          </details>
        )}

        {market.demands.length > 0 && (
          <div className="col gap-4">
            <span className="label">Wanted here</span>
            {market.demands.map((d) => (
              <div key={d.id} className={cx('demand', gm && d.known.length === 0 && 'hidden-from-players')}>
                <Icon name="flag" size={13} />
                <div className="grow">
                  <strong>{d.what}</strong>
                  {d.dm ? <span className="chip ok" style={{ marginLeft: 6 }}>{fmtDm(d.dm)} to the sale roll</span> : null}
                  {d.note && <div className="small dim">{d.note}</div>}
                </div>
                {gm && (
                  <>
                    <AudiencePicker compact list={d.known} onToggle={(audience, on) => void run('market.demand', { id: market.id, demandId: d.id, audience, on })} />
                    <button className="btn ghost icon sm" onClick={() => void run('market.demand', { id: market.id, remove: d.id })} aria-label="Remove demand">
                      <Icon name="x" size={12} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {!catalogueKnown ? (
          <div className="faint small">You know this market exists, but not what it is selling.</div>
        ) : market.lots.length === 0 ? (
          <div className="faint small">Nothing for sale at the moment.</div>
        ) : rules ? (
          <div className="scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>For sale</th>
                  <th className="num">Available</th>
                  <th className="num">Base price / t</th>
                  <th className="num">Typical here</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {market.lots.map((lot) => (
                  <LotRow key={lot.id} market={market} lot={lot} world={world} ship={ship} rules={rules} canTrade={canTrade} broker={best} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Where known worlds would pay well for a good. */
function prospects(good: TradeGood, data: MapData, from: SysInfo | undefined, broker: number, rules: TradeRules, maxParsecs: number): { info: SysInfo; parsecs: number; pct: number; price: number; dm: number }[] {
  const out = [];
  for (const info of data.systems) {
    if (!info.surveyed || !info.uwp) continue;
    const parsecs = from ? hexDistance({ gx: from.gx, gy: from.gy }, { gx: info.gx, gy: info.gy }) : 0;
    if (from && (parsecs === 0 || parsecs > maxParsecs)) continue;
    const e = expectedSale(good, { codes: info.codes, zone: info.sys.zone ?? '', uwp: info.uwp }, broker, rules);
    out.push({ info, parsecs, ...e });
  }
  return out.sort((a, b) => b.price - a.price || a.parsecs - b.parsecs);
}

function HoldTab({ ship, markets, data, here, canTrade }: { ship: Ship; markets: Market[]; data: MapData; here: SysInfo | undefined; canTrade: boolean }) {
  const rules = useRules().trade;
  const items = useType('item');
  const cargo = items.filter((i) => i.holderId === ship.id && i.category === 'cargo');
  const [marketId, setMarketId] = useState<Id | undefined>(markets[0]?.id);
  const [selling, setSelling] = useState<Item | null>(null);
  const market = markets.find((m) => m.id === marketId) ?? markets[0];
  const { best } = useBrokers(false);

  if (cargo.length === 0) {
    return (
      <Empty icon="package" title="The hold is empty">
        Buy cargo at a market, or take on freight and passengers.
      </Empty>
    );
  }
  return (
    <div className="col gap-12">
      {markets.length > 0 ? (
        <div className="row wrap">
          <span className="label">Selling at</span>
          <select className="select" style={{ maxWidth: 320 }} value={market?.id} onChange={(e) => setMarketId(e.target.value)}>
            {markets.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? 'Market'}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="notice">
          <Icon name="info" size={14} /> There is no market you can trade at here, so cargo cannot be sold right now.
        </div>
      )}
      <div className="panel scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Cargo</th>
              <th className="num">Tons</th>
              <th className="num">Paid / t</th>
              <th>Best known market</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cargo.map((item) => {
              const good = rules?.goods.find((g) => g.code === item.good);
              const top = good && rules ? prospects(good, data, here, best, rules, 12)[0] : undefined;
              const dest = item.freight?.destinationId ? data.byId.get(item.freight.destinationId) : undefined;
              const offerHere = item.saleOffer && market && item.saleOffer.marketId === market.id ? item.saleOffer : undefined;
              const atDestination = !!item.freight && (!item.freight.destinationId || ship.location?.systemId === item.freight.destinationId);
              return (
                <tr key={item.id} className={cx(item.illegal && 'illegal')}>
                  <td>
                    <strong>{item.name}</strong>
                    {item.freight && <span className="chip accent" style={{ marginLeft: 6 }}>{item.freight.kind}</span>}
                    {item.origin?.systemId && <div className="tiny faint">from {systemLabel(data.byId.get(item.origin.systemId))}</div>}
                  </td>
                  <td className="num">{item.tons}</td>
                  <td className="num">{item.paid !== undefined ? formatCredits(item.paid) : '—'}</td>
                  <td>
                    {item.freight ? (
                      <span className="small">
                        Deliver to <strong>{dest ? systemLabel(dest) : 'its destination'}</strong> for {formatCredits(item.freight.pay)}
                      </span>
                    ) : top ? (
                      <button className="chip" onClick={() => (selectSystem(top.info.sys.id, { gx: top.info.gx, gy: top.info.gy }), fitTo({ kind: 'system', id: top.info.sys.id }), navigate('/map'))} title="Show on the map">
                        {systemLabel(top.info)} · {top.parsecs} pc · about {formatCredits(top.price)}/t ({top.pct}%)
                      </button>
                    ) : (
                      <span className="faint small">—</span>
                    )}
                  </td>
                  <td>
                    <div className="row wrap gap-4" style={{ justifyContent: 'flex-end' }}>
                      {item.freight ? (
                        canTrade && (
                          <button className="btn sm primary" disabled={!atDestination} title={atDestination ? undefined : 'The ship is not at the destination'} onClick={() => void run<{ pay: number }>('trade.deliver', { itemId: item.id }).then((r) => r && toast(`Delivered: ${formatCredits(r.pay)} paid`, 'ok'))}>
                            Deliver
                          </button>
                        )
                      ) : offerHere ? (
                        <>
                          <span className="chip accent mono">
                            {formatCredits(offerHere.price)}/t · {offerHere.pct}%
                          </span>
                          {canTrade && (
                            <>
                              <button className="btn sm primary" onClick={() => void run<{ gross: number; profit: number }>('trade.sell', { itemId: item.id }).then((r) => r && toast(`Sold for ${formatCredits(r.gross)} (${r.profit >= 0 ? 'profit' : 'loss'} ${formatCredits(Math.abs(r.profit))})`, r.profit >= 0 ? 'ok' : 'error'))}>
                                Sell {item.tons} t
                              </button>
                              <button className="btn sm ghost" onClick={() => void run('trade.keep', { itemId: item.id })} title="Turn the offer down and keep the cargo">
                                Keep it
                              </button>
                            </>
                          )}
                        </>
                      ) : (
                        canTrade &&
                        market && (
                          <button className="btn sm" onClick={() => setSelling(item)}>
                            <Icon name="coins" size={12} /> Get a price
                          </button>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {selling && market && (
        <NegotiateDialog
          title={`Sell ${selling.name}`}
          illegal={!!selling.illegal}
          onClose={() => setSelling(null)}
          onRoll={async (who, dm, manual) => {
            try {
              const res = await act<{ rollId: Id }>('trade.sellQuote', { marketId: market.id, itemId: selling.id, ...who, dm, manual });
              flashRoll(res.rollId);
              setSelling(null);
            } catch (err) {
              toast((err as Error).message, 'error');
            }
          }}
        />
      )}
    </div>
  );
}

function ProspectsTab({ ship, hereMarkets, data, here, bodies }: { ship: Ship | undefined; hereMarkets: Market[]; data: MapData; here: SysInfo | undefined; bodies: Body[] }) {
  const rules = useRules().trade;
  const items = useType('item');
  const campaign = useCampaign();
  const { best } = useBrokers(false);
  const [reach, setReach] = useState(6);
  if (!rules) return <div className="notice warn">Trade tables are not installed on the server.</div>;
  if (!here) return <Empty icon="route" title="The party has no location yet">Once the GM places the party on the map, this shows where cargo is likely to sell well.</Empty>;
  const cargo = ship ? items.filter((i) => i.holderId === ship.id && i.category === 'cargo' && !i.freight && i.good) : [];
  const rows: { label: string; note: string; buy?: number; list: ReturnType<typeof prospects> }[] = [];
  for (const item of cargo) {
    const good = rules.goods.find((g) => g.code === item.good);
    if (good) rows.push({ label: `${item.name} (${item.tons} t aboard)`, note: `paid ${formatCredits(item.paid ?? 0)}/t`, buy: item.paid, list: prospects(good, data, here, best, rules, reach).slice(0, 4) });
  }
  const seen = new Set<number>();
  for (const market of hereMarkets) {
    const world = worldOf(market, data, bodies);
    for (const lot of market.lots) {
      const good = rules.goods.find((g) => g.code === lot.good);
      if (!good || !world || seen.has(good.code)) continue;
      seen.add(good.code);
      const buy = lot.offer?.price ?? expectedPurchase(good, world, best, rules).price;
      rows.push({ label: `${lot.name} (on sale here)`, note: `${lot.offer ? 'quoted' : 'about'} ${formatCredits(buy)}/t`, buy, list: prospects(good, data, here, best, rules, reach).slice(0, 4) });
    }
  }
  const go = (info: SysInfo) => {
    setPlanner({ from: campaign?.location?.systemId, to: info.sys.id, objectives: false });
    useMap.setState({ panel: 'planner' });
    selectSystem(info.sys.id, { gx: info.gx, gy: info.gy });
    navigate('/map');
  };
  return (
    <div className="col gap-12">
      <div className="row wrap">
        <span className="label">Look within</span>
        <Segmented value={String(reach)} onChange={(v) => setReach(Number(v))} options={[2, 4, 6, 10, 20].map((n) => ({ id: String(n), label: `${n} pc` }))} />
        <span className="small dim">of {systemLabel(here)}. Only worlds whose survey data you know are considered. Prices are for an average roll with your best negotiator.</span>
      </div>
      {rows.length === 0 ? (
        <Empty icon="coins" title="Nothing to compare">Cargo in the hold and goods on sale here are ranked against the worlds you know.</Empty>
      ) : (
        <div className="panel scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Goods</th>
                <th>Best places to sell</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <td>
                    <strong>{row.label}</strong>
                    <div className="tiny faint">{row.note}</div>
                  </td>
                  <td>
                    <div className="row wrap gap-4">
                      {row.list.length === 0 && <span className="faint small">No surveyed worlds in range.</span>}
                      {row.list.map((p) => {
                        const margin = row.buy !== undefined ? p.price - row.buy : undefined;
                        return (
                          <button key={p.info.sys.id} className={cx('chip', margin !== undefined && margin > 0 ? 'ok' : margin !== undefined && margin < 0 ? 'danger' : '')} onClick={() => go(p.info)} title={`Sale modifier ${fmtDm(p.dm)}. Click to plan the route.`}>
                            {systemLabel(p.info)} · {p.parsecs} pc · {formatCredits(p.price)}/t{margin !== undefined ? ` (${margin >= 0 ? '+' : '−'}${formatCredits(Math.abs(margin)).replace('Cr', 'Cr')})` : ''}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FreightTab({ ship, data, here, canTrade }: { ship: Ship | undefined; data: MapData; here: SysInfo | undefined; canTrade: boolean }) {
  const [dest, setDest] = useState<Id | undefined>();
  const [effect, setEffect] = useState(0);
  const [steward, setSteward] = useState(0);
  const [result, setResult] = useState<{ parsecs: number; passengers: Record<string, number>; fares: Record<string, number>; freight: { size: string; tons: number; pay: number }[] } | null>(null);
  const [taken, setTaken] = useState<Set<number>>(new Set());
  if (!here) return <Empty icon="package" title="The party has no location yet" />;
  const destInfo = dest ? data.byId.get(dest) : undefined;
  const look = async () => {
    const res = await run<NonNullable<typeof result>>('trade.traffic', { originId: here.sys.id, destinationId: dest, effect, steward });
    if (res) {
      setResult(res);
      setTaken(new Set());
    }
  };
  return (
    <div className="col gap-12">
      <div className="panel pad col">
        <div className="row wrap">
          <span className="label">From</span>
          <strong>{systemLabel(here)}</strong>
          <span className="label">to</span>
          {destInfo ? (
            <span className="chip accent" style={{ height: 26 }}>
              {systemLabel(destInfo)}
              <button className="chip-x" onClick={() => (setDest(undefined), setResult(null))} aria-label="Change destination">
                ×
              </button>
            </span>
          ) : (
            <div style={{ width: 260 }}>
              <SystemPicker data={data} exclude={[here.sys.id]} onPick={setDest} placeholder="Choose a destination…" />
            </div>
          )}
        </div>
        <div className="row wrap">
          <label className="row gap-4 small" title="Effect of a Broker, Carouse or Streetwise check (8+) made to drum up business">
            Effect of the search check
            <input className="input mono" style={{ width: 60 }} type="number" value={effect} onChange={(e) => setEffect(Number(e.target.value) || 0)} />
          </label>
          <label className="row gap-4 small" title="Highest Steward skill aboard, for passengers">
            Chief steward
            <input className="input mono" style={{ width: 60 }} type="number" min={0} value={steward} onChange={(e) => setSteward(Math.max(0, Number(e.target.value) || 0))} />
          </label>
          <button className="btn primary" disabled={!dest || !canTrade} onClick={() => void look()}>
            <Icon name="dice" size={13} /> See who needs a ship
          </button>
        </div>
      </div>
      {result && destInfo && (
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div className="panel">
            <div className="panel-head">
              <h3>Passengers for {systemLabel(destInfo)} ({result.parsecs} pc)</h3>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Passage</th>
                  <th className="num">Looking</th>
                  <th className="num">Fare each</th>
                </tr>
              </thead>
              <tbody>
                {(['high', 'middle', 'basic', 'low'] as const).map((cls) => (
                  <tr key={cls}>
                    <td style={{ textTransform: 'capitalize' }}>{cls}</td>
                    <td className="num">{result.passengers[cls] ?? 0}</td>
                    <td className="num">{formatCredits(result.fares[cls] ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pad tiny faint">You need a stateroom or low berth for each. Record those you take as a passenger entry in the hold from the Inventory screen, or let the GM pay out on arrival.</div>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h3>Freight lots</h3>
            </div>
            {result.freight.length === 0 ? (
              <div className="pad faint small">No freight is waiting for that destination.</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Lot</th>
                    <th className="num">Tons</th>
                    <th className="num">Pays on delivery</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {result.freight.map((f, i) => (
                    <tr key={i} style={{ opacity: taken.has(i) ? 0.45 : 1 }}>
                      <td style={{ textTransform: 'capitalize' }}>{f.size}</td>
                      <td className="num">{f.tons}</td>
                      <td className="num">{formatCredits(f.pay)}</td>
                      <td>
                        {ship && canTrade && !taken.has(i) && (
                          <button className="btn sm" style={{ float: 'right' }} onClick={() => void run('trade.takeFreight', { shipId: ship.id, destinationId: destInfo.sys.id, tons: f.tons, pay: f.pay, kind: 'freight' }, 'Freight loaded').then((ok) => ok && setTaken(new Set([...taken, i])))}>
                            Take it
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="pad tiny faint">A lot cannot be split and is paid for when it arrives.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function NewMarket({ systemId, bodies, onClose }: { systemId: Id; bodies: Body[]; onClose: () => void }) {
  const [bodyId, setBodyId] = useState(bodies.find((b) => b.mainworld)?.id ?? '');
  const [venue, setVenue] = useState<Market['venue']>('surface');
  const [name, setName] = useState('');
  const [black, setBlack] = useState(false);
  const places = bodies.filter((b) => b.kind !== 'star');
  return (
    <Modal
      title="New market"
      icon="coins"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void run('market.create', { systemId, bodyId: bodyId || undefined, venue, name: name.trim() || undefined, blackMarket: black }, 'Market created and stocked').then((ok) => ok && onClose())}>
            Create and stock
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <div className="grid-2">
          <Field label="Where">
            <select className="select" value={bodyId} onChange={(e) => setBodyId(e.target.value)}>
              <option value="">The system in general</option>
              {places.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name ?? b.kind}
                  {b.mainworld ? ' (mainworld)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Venue">
            <Segmented
              value={venue}
              onChange={setVenue}
              options={[
                { id: 'surface', label: 'Surface' },
                { id: 'orbit', label: 'Orbit' },
                { id: 'station', label: 'Station' },
              ]}
            />
          </Field>
        </div>
        <Field label="Name" hint="Leave empty for a name based on the place.">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={black} onChange={(e) => setBlack(e.target.checked)} />
          Black market (illegal goods only)
        </label>
        <p className="tiny faint">Stock is rolled from the world&apos;s trade codes and population. The market starts hidden from players: reveal it, and its catalogue, when the party finds a supplier.</p>
      </div>
    </Modal>
  );
}

export function TradePage() {
  const gm = useIsGm();
  const me = useMe();
  const campaign = useCampaign();
  const data = useMapData();
  const markets = useType('market');
  const ships = useType('ship');
  const bodies = useType('body');
  const [tab, setTab] = useState<'here' | 'system' | 'intel' | 'hold' | 'prospects' | 'freight'>('here');
  const [shipId, setShipId] = useState<Id>();
  const [creating, setCreating] = useState(false);
  const partyShips = useMemo(() => ships.filter((s) => s.party), [ships]);
  const ship = partyShips.find((s) => s.id === shipId) ?? partyShips[0];
  const here = campaign?.location?.systemId ? data.byId.get(campaign.location.systemId) : undefined;
  const hereBody = campaign?.location?.bodyId;
  const canTrade = !me?.viewAs;

  const groups = useMemo(() => {
    const inSystem = markets.filter((m) => here && m.systemId === here.sys.id);
    // "Here" is the body the party is on (or the mainworld when no body is set).
    const main = bodies.find((b) => here && b.systemId === here.sys.id && b.mainworld)?.id;
    const at = hereBody ?? main;
    const hereList = inSystem.filter((m) => !m.bodyId || m.bodyId === at);
    return { here: hereList, system: inSystem.filter((m) => !hereList.includes(m)), intel: markets.filter((m) => !here || m.systemId !== here.sys.id) };
  }, [markets, here, hereBody, bodies]);
  const tradable = [...groups.here, ...groups.system].filter((m) => m.broker !== undefined);
  const systemBodies = useMemo(() => bodies.filter((b) => here && b.systemId === here.sys.id), [bodies, here]);

  const list = tab === 'here' ? groups.here : tab === 'system' ? groups.system : groups.intel;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Trade</h1>
        {here ? (
          <span className="chip accent" style={{ height: 26 }}>
            <Icon name="pin" size={12} /> {systemLabel(here)}
            {here.sys.uwp ? ` · ${here.sys.uwp}` : ''}
          </span>
        ) : (
          <span className="chip warn">The party is not on the map yet</span>
        )}
        <div className="grow" />
        <ShipBar ship={ship} ships={partyShips} onPick={setShipId} />
        {gm && here && (
          <button className="btn gm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={13} /> Market
          </button>
        )}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'here', label: `Here (${groups.here.length})` },
          { id: 'system', label: `Elsewhere in the system (${groups.system.length})` },
          { id: 'intel', label: `Other systems (${groups.intel.length})` },
          { id: 'hold', label: 'Our cargo' },
          { id: 'prospects', label: 'Where to sell' },
          { id: 'freight', label: 'Freight & passengers' },
        ]}
      />
      <div style={{ paddingTop: 14 }} className="col gap-12">
        {!ship && tab !== 'intel' && (
          <div className="notice warn">
            <Icon name="warning" size={14} /> There is no party ship yet, so cargo has nowhere to go. {gm ? 'Add one from the Inventory screen.' : 'Ask your GM to add your ship.'}
          </div>
        )}
        {tab === 'hold' ? (
          ship ? <HoldTab ship={ship} markets={tradable} data={data} here={here} canTrade={canTrade} /> : null
        ) : tab === 'prospects' ? (
          <ProspectsTab ship={ship} hereMarkets={tradable} data={data} here={here} bodies={bodies} />
        ) : tab === 'freight' ? (
          <FreightTab ship={ship} data={data} here={here} canTrade={canTrade} />
        ) : list.length === 0 ? (
          <Empty icon="coins" title={tab === 'intel' ? 'No word from other systems' : tab === 'here' ? 'No market here that you know of' : 'No other markets known in this system'}>
            {gm
              ? tab === 'intel'
                ? 'Markets you create in other systems appear here. Reveal a market, its catalogue or a single demand to give the party intelligence.'
                : 'Create a market for this location. Players see it once you reveal it.'
              : tab === 'intel'
                ? 'When you learn what another world is buying or selling, it will be recorded here.'
                : 'Find a supplier or broker first (a Broker, Streetwise or Admin check), and the GM will open the market to you.'}
          </Empty>
        ) : (
          list.map((m) => <MarketCard key={m.id} market={m} data={data} bodies={bodies} ship={ship} canTrade={canTrade && tab !== 'intel'} />)
        )}
      </div>
      {creating && here && <NewMarket systemId={here.sys.id} bodies={systemBodies} onClose={() => setCreating(false)} />}
    </div>
  );
}

export type { GameDate };
