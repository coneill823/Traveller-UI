/** Client-side helpers for the wiki: live sync status and navigating to what a page documents. */
import { useEffect, useState } from 'react';
import type { Body, Entity, Id, WikiPage } from '../../../shared/types';
import { act, onEvent } from '../../net';
import { getEntity, useIsGm } from '../../store';

export interface WikiStatus {
  configured: boolean;
  kind?: 'local' | 'github';
  label?: string;
  canWrite: boolean;
  pages: number;
  linked: number;
  syncing: boolean;
  lastSync?: number;
  lastError?: string;
  lastSummary?: { pagesRead: number; pagesChanged: number; pagesRemoved: number; entitiesUpdated: number; entitiesCreated: number; pagesWritten: number; warnings: string[] };
}

/** Wiki sync status for the GM (undefined for players, and until the first answer arrives). */
export function useWikiStatus(): WikiStatus | undefined {
  const gm = useIsGm();
  const [status, setStatus] = useState<WikiStatus>();
  useEffect(() => {
    if (!gm) return;
    let live = true;
    void act<WikiStatus>('wiki.status')
      .then((s) => live && setStatus(s))
      .catch(() => undefined);
    const off = onEvent('wiki.status', (s: WikiStatus) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, [gm]);
  return gm ? status : undefined;
}

/** In-app address of the thing a wiki page documents, if it is on the map. */
export function entityPath(entity: Entity | undefined): string | undefined {
  if (!entity) return undefined;
  if (entity.type === 'system') return `/map?sys=${entity.id}&focus=1`;
  if (entity.type === 'body') return `/map/system/${(entity as Body).systemId}?body=${entity.id}`;
  return undefined;
}

export function entityName(entity: Entity | undefined): string {
  if (!entity) return 'Unknown';
  const name = (entity as { name?: string; title?: string }).name ?? (entity as { title?: string }).title;
  return name ?? entity.type;
}

export function linkedEntity(page: WikiPage): Entity | undefined {
  return getEntity(page.entityId as Id | undefined);
}

/** hidden / partial / revealed summary of a page's sections for the party (GM view). */
export function revealState(page: WikiPage): 'hidden' | 'partial' | 'revealed' {
  const open = page.sections.filter((s) => !s.locked && s.body.trim() !== '');
  if (open.length === 0) return 'hidden';
  const shown = open.filter((s) => s.known.length > 0).length;
  return shown === 0 ? 'hidden' : shown === open.length ? 'revealed' : 'partial';
}
