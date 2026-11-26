/** Small pieces shared by the ship status board and the battle screen. */
import { CONDITION_LABEL } from '../../../shared/rules/space';
import { cx } from '../../ui/basics';
import { Icon } from '../../ui/Icon';
import type { ShipStatus } from './shipState';

export function HullMeter({ status }: { status: Pick<ShipStatus, 'hull' | 'hullMax' | 'condition'> }) {
  const pct = status.hullMax > 0 ? Math.max(0, Math.min(100, (status.hull / status.hullMax) * 100)) : 0;
  // Blue while intact, amber once damaged, red when under half.
  const level = status.condition === 'intact' ? 'ok' : pct >= 50 ? 'warn' : 'danger';
  return (
    <div className="gauge" role="group" aria-label="Hull">
      <div className="gauge-head">
        <span>Hull</span>
        <span className={cx('status', level)}>
          <Icon name={status.condition === 'intact' ? 'check' : 'warning'} size={12} />
          <b>{status.hull}</b> of {status.hullMax} · {CONDITION_LABEL[status.condition]}
        </span>
      </div>
      <div className={cx('meter-track', level === 'ok' ? '' : level)} aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

