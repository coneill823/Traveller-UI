/** Talking to the server: sign-in over HTTP, then one WebSocket for live state and actions. */
import type { ClientMessage, Me, NavigateEvent, PresenceEvent, ServerMessage, StatusResponse } from '../shared/protocol';
import type { PatchOp } from '../shared/patch';
import type { RulePack } from '../shared/rulepack';
import type { Id } from '../shared/types';
import { navigate } from './router';
import { applyPatch, applySnapshot, toast, useApp } from './store';

const TOKEN_KEY = 'traveller-ui.token';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}): Promise<T> {
  const token = useApp.getState().token;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined = init.raw;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body });
  } catch {
    throw new ApiError('Could not reach the server. Is it still running?', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

// ── socket ──

type EventHandler = (d: any) => void;
const eventHandlers = new Map<string, Set<EventHandler>>();

/** Subscribes to an ephemeral server event. Returns an unsubscribe function. */
export function onEvent(ev: string, handler: EventHandler): () => void {
  let set = eventHandlers.get(ev);
  if (!set) eventHandlers.set(ev, (set = new Set()));
  set.add(handler);
  return () => set!.delete(handler);
}

let ws: WebSocket | undefined;
let nextActionId = 1;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let viewAs: Id | undefined;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function send(msg: ClientMessage): void {
  ws?.send(JSON.stringify(msg));
}

function openSocket(): void {
  const token = useApp.getState().token;
  if (!token) return;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${window.location.host}/ws`);
  ws = socket;
  socket.onopen = () => {
    retry = 0;
    send({ t: 'hello', token, viewAs });
  };
  socket.onmessage = (event) => {
    if (ws !== socket) return;
    handle(JSON.parse(event.data as string) as ServerMessage);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = undefined;
    useApp.setState({ connected: false });
    for (const p of pending.values()) p.reject(new Error('Connection lost. Reconnecting…'));
    pending.clear();
    if (!useApp.getState().token) return;
    retry = Math.min(retry + 1, 6);
    retryTimer = setTimeout(openSocket, Math.min(8000, 400 * 2 ** (retry - 1)));
  };
}

function handle(msg: ServerMessage): void {
  switch (msg.t) {
    case 'welcome':
      useApp.setState({ me: msg.me });
      break;
    case 'snap':
      applySnapshot(msg.ents);
      useApp.setState({ connected: true, phase: 'ready' });
      break;
    case 'patch':
      applyPatch(msg.up, msg.del);
      break;
    case 'res': {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (!p) break;
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.err));
      break;
    }
    case 'ev':
      if (msg.ev === 'presence') useApp.setState({ online: (msg.d as PresenceEvent).online });
      if (msg.ev === 'navigate') {
        const nav = msg.d as NavigateEvent;
        toast('The GM has opened a view for you.');
        navigate(nav.path);
      }
      for (const handler of eventHandlers.get(msg.ev) ?? []) handler(msg.d);
      break;
    case 'err':
      if (msg.code === 'auth') {
        toast(msg.msg, 'error');
        signOut(false);
      }
      break;
    default:
      break;
  }
}

/** Runs an action on the server. Rejects with a readable message when it is refused. */
export function act<T = any>(type: string, p: unknown = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected to the server'));
      return;
    }
    const id = nextActionId++;
    pending.set(id, { resolve, reject });
    send({ t: 'act', id, type, p });
  });
}

/** Like `act`, but reports failures as a toast and resolves to undefined instead of throwing. */
export async function run<T = any>(type: string, p: unknown = {}, done?: string): Promise<T | undefined> {
  try {
    const result = await act<T>(type, p);
    if (done) toast(done, 'ok');
    return result ?? ({} as T);
  } catch (err) {
    toast((err as Error).message, 'error');
    return undefined;
  }
}

/** Edits fields of an entity. */
export function patch(id: Id, ops: PatchOp[]): Promise<unknown> {
  return run('entity.patch', { id, ops });
}

/** Sets top-level or dotted fields of an entity; `undefined` removes the field. */
export function setFields(id: Id, fields: Record<string, unknown>): Promise<unknown> {
  const ops: PatchOp[] = Object.entries(fields).map(([key, value]) =>
    value === undefined ? { op: 'del', path: key.split('.') } : { op: 'set', path: key.split('.'), value },
  );
  return patch(id, ops);
}

// ── session ──

async function loadRules(): Promise<void> {
  try {
    useApp.setState({ rules: await api<RulePack>('/api/rules') });
  } catch {
    /* the app still works without rule tables */
  }
}

function startSession(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  useApp.setState({ token, phase: 'connecting' });
  void loadRules();
  if (retryTimer) clearTimeout(retryTimer);
  ws?.close();
  ws = undefined;
  openSocket();
}

export async function boot(): Promise<void> {
  let status: StatusResponse;
  try {
    status = await api<StatusResponse>('/api/status');
  } catch (err) {
    toast((err as Error).message, 'error');
    setTimeout(() => void boot(), 3000);
    return;
  }
  useApp.setState({ status });
  // An invite link looks like /join/ABCD-EFGH.
  const join = /^\/join\/([A-Za-z0-9-]+)/.exec(window.location.pathname);
  if (join && !status.needsSetup) {
    try {
      await signInPlayer(join[1]);
      navigate('/map', { replace: true });
      return;
    } catch (err) {
      toast((err as Error).message, 'error');
      navigate('/', { replace: true });
    }
  }
  const token = localStorage.getItem(TOKEN_KEY);
  if (status.needsSetup) useApp.setState({ phase: 'setup' });
  else if (token) startSession(token);
  else useApp.setState({ phase: 'login' });
}

export async function setupServer(input: { setupCode: string; campaignName: string; gmName: string; password: string }): Promise<void> {
  const { token } = await api<{ token: string }>('/api/setup', { body: input });
  startSession(token);
}

export async function signInGm(password: string): Promise<void> {
  const { token } = await api<{ token: string }>('/api/login/gm', { body: { password } });
  startSession(token);
}

export async function signInPlayer(code: string): Promise<void> {
  const { token } = await api<{ token: string }>('/api/login/player', { body: { code } });
  startSession(token);
}

export function signOut(tellServer = true): void {
  if (tellServer) void api('/api/logout', { method: 'POST' }).catch(() => undefined);
  localStorage.removeItem(TOKEN_KEY);
  viewAs = undefined;
  if (retryTimer) clearTimeout(retryTimer);
  const socket = ws;
  ws = undefined;
  socket?.close();
  useApp.setState({ token: undefined, me: undefined, connected: false, ents: {}, byType: {}, phase: 'login' });
}

/** GM only: switch between the full view and a preview of what a player (or the party) sees. */
export async function setViewAs(playerId: Id | undefined): Promise<void> {
  viewAs = playerId;
  await run('view.as', { playerId });
}

export function currentMe(): Me | undefined {
  return useApp.getState().me;
}

export async function upload(file: File): Promise<{ id: Id; url: string }> {
  return api('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', raw: file, headers: { 'Content-Type': file.type } });
}
