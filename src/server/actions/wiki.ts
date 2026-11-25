/** Wiki actions: syncing, revealing page sections to players, linking pages to map entries. */
import { toggleAudience, withAudience } from '../../shared/knowledge';
import type { WikiPage } from '../../shared/types';
import type { WikiService } from '../wiki/sync';
import { checkAudience } from './core';
import { action, ActionError, asyncAction, check, requireGm, type Services } from './registry';

function wikiOf(services: Services): WikiService {
  const wiki = services.extra.wiki as WikiService | undefined;
  if (!wiki) throw new ActionError('The wiki service is not running');
  return wiki;
}

asyncAction('wiki.status', async (ctx) => {
  requireGm(ctx.me);
  return wikiOf(ctx.services).status();
});

asyncAction('wiki.sync', async (ctx) => {
  requireGm(ctx.me);
  try {
    return await wikiOf(ctx.services).sync({ force: true });
  } catch (err) {
    throw new ActionError((err as Error).message);
  }
});

asyncAction('wiki.publish', async (ctx, p) => {
  requireGm(ctx.me);
  const ids = check.arr(p.ids, 'ids', check.id, 5000);
  try {
    return await wikiOf(ctx.services).publishEntities(ids);
  } catch (err) {
    throw new ActionError((err as Error).message);
  }
});

asyncAction('wiki.link', async (ctx, p) => {
  requireGm(ctx.me);
  const pageId = check.id(p.pageId, 'pageId');
  const entityId = p.entityId === null || p.entityId === undefined ? undefined : check.id(p.entityId, 'entityId');
  try {
    await wikiOf(ctx.services).linkPage(pageId, entityId);
  } catch (err) {
    throw new ActionError((err as Error).message);
  }
});

action('wiki.reveal', (ctx, p) => {
  requireGm(ctx.me);
  const page = ctx.tx.need('wikiPage', check.id(p.pageId, 'pageId'));
  const audience = checkAudience(ctx.tx, p.audience);
  const on = check.bool(p.on, 'on');
  ctx.tx.update<WikiPage>(page.id, (draft) => {
    if (p.infobox) {
      draft.known = withAudience(draft.known, 'infobox', audience, on);
      return;
    }
    const targets = p.all ? draft.sections : draft.sections.filter((s) => s.id === p.sectionId);
    if (targets.length === 0) throw new ActionError('That section no longer exists');
    for (const section of targets) {
      if (section.locked) {
        if (p.all) continue;
        throw new ActionError('Sections under a GM heading cannot be revealed');
      }
      if (p.spoilers) section.spoilersKnown = toggleAudience(section.spoilersKnown, audience, on);
      else {
        section.known = toggleAudience(section.known, audience, on);
        // Hiding a section also withdraws its spoilers.
        if (!on) section.spoilersKnown = toggleAudience(section.spoilersKnown, audience, false);
      }
    }
  });
});
