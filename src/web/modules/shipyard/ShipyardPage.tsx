/** The shipyard: designs on file, stock designs to start from, and the drawing board. */
import { useMemo, useState } from 'react';
import type { ShipRules, StockDesign } from '../../../shared/rulepack';
import { canBuildAnything, evaluateDesign, formatMCr, formatTons, specFromStock, yardIssues } from '../../../shared/rules/ship';
import type { ShipDesign } from '../../../shared/types';
import { run } from '../../net';
import { navigate } from '../../router';
import { useEntity, useIsGm, useMe, useRules, useType } from '../../store';
import { cx, Empty, Field, Modal, Tabs } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import { DesignEditor, StatusChip, useYard, YardBadge } from './DesignEditor';
import { HullView } from './HullView';

export function ShipyardPage({ designId }: { designId?: string }) {
  const rules = useRules().ships;
  const design = useEntity<ShipDesign>(designId);
  if (!rules) {
    return (
      <div className="page page-narrow">
        <Empty icon="wrench" title="No ship construction rules loaded">
          The shipyard needs a rules pack with a ships section. Ask the GM to add one to the server's rulepacks folder.
        </Empty>
      </div>
    );
  }
  if (designId && design?.type === 'design') return <DesignEditor key={design.id} design={design} />;
  return <YardHome rules={rules} missing={!!designId} />;
}

function YardHome({ rules, missing }: { rules: ShipRules; missing: boolean }) {
  const designs = useType('design');
  const ships = useType('ship').filter((s) => s.party);
  const players = useType('player');
  const me = useMe();
  const gm = useIsGm();
  const { system, yard } = useYard(rules);
  const [creating, setCreating] = useState(false);
  const sorted = useMemo(() => [...designs].sort((a, b) => b.updatedAt - a.updatedAt), [designs]);
  const open = sorted.filter((d) => d.status !== 'built');
  const built = sorted.filter((d) => d.status === 'built');

  const refit = async (shipId: string) => {
    const res = await run<{ id: string }>('design.create', { refitOf: shipId });
    if (res?.id) navigate(`/shipyard/${res.id}`);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Shipyard</h1>
          <div className="small dim">Draw up a ship, show it to the party, and have it built.</div>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> New design
        </button>
      </div>
      <YardBadge system={system} yard={yard} />
      {missing && <div className="notice warn small">That design is no longer on file, or has not been shared with you.</div>}

      <h3 className="yard-section">On the drawing board</h3>
      {open.length === 0 ? (
        <Empty icon="ship" title="No designs yet">
          Start from one of the stock designs or from a bare hull.
        </Empty>
      ) : (
        <div className="design-grid">
          {open.map((d) => (
            <DesignCard key={d.id} design={d} rules={rules} owner={players.find((p) => p.id === d.ownerId)?.name} mine={d.ownerId === me?.playerId} />
          ))}
        </div>
      )}

      {ships.length > 0 && (
        <>
          <h3 className="yard-section">Ships in service</h3>
          <div className="design-grid">
            {ships.map((s) => (
              <div key={s.id} className="design-card static">
                <div className="design-card-head">
                  <div className="grow">
                    <b>{s.name ?? 'Unnamed ship'}</b>
                    <div className="small dim">{s.className ?? 'Ship'}</div>
                  </div>
                  {s.construction && (
                    <span className="chip warn" title="Still in the yard">
                      <Icon name="clock" size={11} /> Ready {String(s.construction.readyDay).padStart(3, '0')}-{s.construction.readyYear}
                    </span>
                  )}
                </div>
                {s.spec ? <HullView spec={s.spec} report={evaluateDesign(rules, s.spec)} onSelect={() => undefined} editable={false} compact /> : <p className="small faint">No design on file for this ship.</p>}
                <div className="row gap-4 wrap">
                  <span className="small dim grow">
                    {formatTons(s.tons ?? 0)} t · J-{s.jump ?? 0} · {s.thrust ?? 0}G
                  </span>
                  {s.spec && (
                    <button className="btn sm" onClick={() => void refit(s.id)}>
                      <Icon name="wrench" size={13} /> Plan a refit
                    </button>
                  )}
                  {gm && s.construction && (
                    <button className="btn sm gm" onClick={() => void run('ship.update', { id: s.id, ops: [{ op: 'del', path: ['construction'] }] }, 'Released from the yard')}>
                      Release now
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {built.length > 0 && (
        <>
          <h3 className="yard-section">Built</h3>
          <div className="design-grid">
            {built.map((d) => (
              <DesignCard key={d.id} design={d} rules={rules} owner={players.find((p) => p.id === d.ownerId)?.name} mine={d.ownerId === me?.playerId} />
            ))}
          </div>
        </>
      )}
      {creating && <NewDesignDialog rules={rules} onClose={() => setCreating(false)} />}
    </div>
  );
}

function DesignCard({ design, rules, owner, mine }: { design: ShipDesign; rules: ShipRules; owner?: string; mine: boolean }) {
  const report = useMemo(() => evaluateDesign(rules, design.spec), [rules, design.spec]);
  const errors = report.issues.filter((i) => i.level === 'error').length;
  return (
    <button className="design-card" onClick={() => navigate(`/shipyard/${design.id}`)}>
      <div className="design-card-head">
        <div className="grow">
          <b>{design.name}</b>
          <div className="small dim">
            {design.className ?? 'Original design'} · {mine ? 'yours' : `by ${owner ?? 'someone'}`}
          </div>
        </div>
        <StatusChip status={design.status} />
      </div>
      <HullView spec={design.spec} report={report} onSelect={() => undefined} editable={false} compact />
      <div className="row gap-4 wrap small dim">
        <span>{formatTons(report.hullTons)} t</span>
        <span>· J-{report.jump}</span>
        <span>· {report.thrust}G</span>
        <span>· {formatTons(Math.max(0, report.cargo))} t cargo</span>
        <span className="grow" />
        <b className="design-price">{formatMCr(report.purchase)}</b>
      </div>
      {design.status === 'draft' && !design.shared && (
        <span className="small faint">
          <Icon name="lock" size={11} /> Private draft
        </span>
      )}
      {errors > 0 && design.status !== 'built' && (
        <span className="small status danger">
          <Icon name="warning" size={12} /> {errors} thing{errors === 1 ? '' : 's'} to fix
        </span>
      )}
    </button>
  );
}

function NewDesignDialog({ rules, onClose }: { rules: ShipRules; onClose: () => void }) {
  const [tab, setTab] = useState<'stock' | 'scratch'>('stock');
  const [tons, setTons] = useState(200);
  const [tl, setTl] = useState(12);
  const [config, setConfig] = useState(rules.hull.configurations[0]?.id ?? 'standard');
  const [busy, setBusy] = useState(false);
  const { system, yard } = useYard(rules);
  const here = system && canBuildAnything(yard);

  const rows = useMemo(
    () =>
      rules.designs.map((d) => {
        const report = evaluateDesign(rules, specFromStock(d));
        return { design: d, report, blocked: here ? yardIssues(report, yard) : [] };
      }),
    [rules, here, yard],
  );
  const create = async (p: Record<string, unknown>) => {
    setBusy(true);
    const res = await run<{ id: string }>('design.create', p);
    setBusy(false);
    if (res?.id) {
      onClose();
      navigate(`/shipyard/${res.id}`);
    }
  };
  const group = (small: boolean) => rows.filter((r) => r.report.smallCraft === small);
  const Row = ({ design, report, blocked }: { design: StockDesign; report: ReturnType<typeof evaluateDesign>; blocked: ReturnType<typeof yardIssues> }) => (
    <button className="stock-row" disabled={busy} onClick={() => void create({ stock: design.id })}>
      <span className="stock-name">
        <b>{design.name}</b>
        <span className="small dim">{design.type}</span>
      </span>
      <span className="stock-text small dim">{design.summary}</span>
      <span className="stock-figs small">
        <span>
          {formatTons(design.hull.tons)} t · TL{design.tl}
        </span>
        <span>
          {report.jump > 0 ? `J-${report.jump} · ` : ''}
          {report.thrust}G · {formatTons(Math.max(0, report.cargo))} t cargo
        </span>
        <b>{formatMCr(report.purchase)}</b>
        {here &&
          (blocked.length === 0 ? (
            <span className="status ok">
              <Icon name="check" size={11} /> Can be built here
            </span>
          ) : (
            <span className="status warn" title={blocked.map((b) => b.text).join('\n')}>
              <Icon name="warning" size={11} /> Not at this yard
            </span>
          ))}
      </span>
    </button>
  );

  return (
    <Modal title="New design" icon="ship" size="xwide" onClose={onClose}>
      <Tabs
        tabs={[
          { id: 'stock', label: 'Start from a stock design' },
          { id: 'scratch', label: 'Start from a bare hull' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'stock' ? (
        <div className="stock-list">
          <p className="small dim">Stock designs are ten per cent cheaper as long as they are built unchanged. Pick one to open it on the drawing board; you can alter anything from there.</p>
          <h4>Ships</h4>
          {group(false).map((r) => (
            <Row key={r.design.id} {...r} />
          ))}
          <h4>Small craft</h4>
          {group(true).map((r) => (
            <Row key={r.design.id} {...r} />
          ))}
        </div>
      ) : (
        <div className="col gap-12" style={{ maxWidth: 460, paddingTop: 12 }}>
          <Field label="Hull size" hint="Under 100 tons is a small craft: no jump drive, and firmpoints instead of hardpoints.">
            <div className="row wrap gap-4">
              {rules.hull.sizes.map((s) => (
                <button key={s} className={cx('btn sm', tons === s && 'on')} onClick={() => setTons(s)}>
                  {s.toLocaleString('en-GB')}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Configuration" hint={rules.hull.configurations.find((c) => c.id === config)?.note}>
            <select className="select" value={config} onChange={(e) => setConfig(e.target.value)}>
              {rules.hull.configurations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tech level" hint={here && yard.tl !== undefined ? `The yard here works at TL${yard.tl}.` : undefined}>
            <div className="row wrap gap-4">
              {[9, 10, 11, 12, 13, 14, 15].map((n) => (
                <button key={n} className={cx('btn sm', tl === n && 'on')} onClick={() => setTl(n)}>
                  {n}
                </button>
              ))}
            </div>
          </Field>
          <div>
            <button className="btn primary" disabled={busy} onClick={() => void create({ tons, tl, config })}>
              <Icon name="plus" size={14} /> Open the drawing board
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
