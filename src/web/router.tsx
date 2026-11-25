/** A very small history-based router: enough for a handful of screens and shareable links. */
import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { create } from 'zustand';

interface RouteState {
  path: string;
  search: string;
}

const useRouteStore = create<RouteState>(() => ({ path: window.location.pathname, search: window.location.search }));

window.addEventListener('popstate', () => {
  useRouteStore.setState({ path: window.location.pathname, search: window.location.search });
});

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = new URL(to, window.location.origin);
  if (url.pathname === window.location.pathname && url.search === window.location.search) return;
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  useRouteStore.setState({ path: url.pathname, search: url.search });
}

export interface Route {
  path: string;
  /** Path split on "/" without empty segments. */
  parts: string[];
  query: URLSearchParams;
}

export function useRoute(): Route {
  const { path, search } = useRouteStore();
  return { path, parts: path.split('/').filter(Boolean), query: new URLSearchParams(search) };
}

export function currentPath(): string {
  const { path, search } = useRouteStore.getState();
  return path + search;
}

/** Sets or clears query parameters on the current path. */
export function setQuery(params: Record<string, string | undefined>, opts: { replace?: boolean } = {}): void {
  const { path, search } = useRouteStore.getState();
  const q = new URLSearchParams(search);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') q.delete(key);
    else q.set(key, value);
  }
  const text = q.toString();
  navigate(path + (text ? `?${text}` : ''), opts);
}

export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
