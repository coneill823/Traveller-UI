/** Objectives: party goals set by the GM and personal goals any player can keep for themselves. */
import { PARTY, type Audience, type Id } from '../../shared/types';
import { checkAudience } from './core';
import { action, ActionError, check } from './registry';

function checkTargets(ctx: Parameters<Parameters<typeof action>[1]>[0], value: unknown): { systemId: Id; bodyId?: Id }[] {
  return check.arr(value ?? [], 'targets', (v, n) => {
    const t = check.obj(v, n);
    const system = ctx.tx.need('system', check.id(t.systemId, `${n}.systemId`));
    const bodyId = t.bodyId ? ctx.tx.need('body', check.id(t.bodyId, `${n}.bodyId`)).id : undefined;
    return { systemId: system.id, bodyId };
  }, 20);
}

action('objective.create', (ctx, p) => {
  let scope: Audience;
  if (ctx.me.role === 'gm') scope = p.scope === undefined ? PARTY : checkAudience(ctx.tx, p.scope, 'scope');
  else {
    // Players may only create personal objectives.
    if (p.scope !== undefined && p.scope !== ctx.me.playerId) throw new ActionError('Players can only add personal objectives');
    scope = ctx.me.playerId;
  }
  const objective = ctx.tx.create('objective', {
    title: check.str(p.title, 'title', { max: 120 }),
    body: p.body === undefined ? undefined : check.text(p.body, 'body', 20_000),
    scope,
    status: 'active',
    targets: checkTargets(ctx, p.targets),
    reward: check.optStr(p.reward, 'reward', { max: 200 }),
    createdBy: ctx.me.playerId,
  });
  return { id: objective.id };
});
