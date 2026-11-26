/**
 * Drag and drop on pointer events, so it behaves the same with a mouse, a pen or a finger.
 *
 * A draggable calls `beginDrag` from its pointerdown handler. Drop zones are elements carrying
 * `data-drop="<name>"`; whoever owns a zone registers a handler for that name with `useDropZone`.
 * Nothing happens until the pointer has moved a few pixels, so a plain click still clicks.
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

export interface DragPayload {
  kind: string;
  [key: string]: unknown;
}

export interface DropPoint {
  x: number;
  y: number;
  /** The element carrying the data-drop attribute. */
  zone: HTMLElement;
}

export interface DropHandler {
  accepts?: (payload: DragPayload) => boolean;
  /** Called as the pointer moves over the zone, and with nulls when it leaves or the drag ends. */
  over?: (payload: DragPayload | null, point: DropPoint | null) => void;
  drop: (payload: DragPayload, point: DropPoint) => void;
}

const zones = new Map<string, DropHandler>();
const THRESHOLD = 6;

export function useDropZone(name: string, handler: DropHandler): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const proxy: DropHandler = {
      accepts: (p) => latest.current.accepts?.(p) ?? true,
      over: (p, pt) => latest.current.over?.(p, pt),
      drop: (p, pt) => latest.current.drop(p, pt),
    };
    zones.set(name, proxy);
    return () => {
      if (zones.get(name) === proxy) zones.delete(name);
    };
  }, [name]);
}

function zoneAt(x: number, y: number, payload: DragPayload): { name: string; el: HTMLElement } | null {
  let el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop]') ?? null;
  while (el) {
    const name = el.dataset.drop!;
    const handler = zones.get(name);
    if (handler && (handler.accepts?.(payload) ?? true)) return { name, el };
    el = el.parentElement?.closest<HTMLElement>('[data-drop]') ?? null;
  }
  return null;
}

export function beginDrag(e: ReactPointerEvent, payload: DragPayload, label: string): void {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  const startX = e.clientX;
  const startY = e.clientY;
  const pointerId = e.pointerId;
  let ghost: HTMLDivElement | null = null;
  let current: { name: string; el: HTMLElement } | null = null;

  const leave = () => {
    if (!current) return;
    current.el.classList.remove('drop-over');
    zones.get(current.name)?.over?.(null, null);
    current = null;
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    if (!ghost) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = label;
      document.body.appendChild(ghost);
      document.body.classList.add('is-dragging');
      document.body.dataset.dragging = payload.kind;
    }
    ev.preventDefault();
    ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 14}px)`;
    const next = zoneAt(ev.clientX, ev.clientY, payload);
    if (next?.el !== current?.el) {
      leave();
      current = next;
      current?.el.classList.add('drop-over');
    }
    if (current) zones.get(current.name)?.over?.(payload, { x: ev.clientX, y: ev.clientY, zone: current.el });
  };
  const finish = (ev: PointerEvent, cancelled: boolean) => {
    if (ev.pointerId !== pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    const dragged = ghost !== null;
    const target = current;
    leave();
    ghost?.remove();
    document.body.classList.remove('is-dragging');
    delete document.body.dataset.dragging;
    if (!dragged) return;
    // The click that follows a drag is not a click.
    const swallow = (c: MouseEvent) => {
      c.stopPropagation();
      c.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 80);
    if (!cancelled && target) zones.get(target.name)?.drop(payload, { x: ev.clientX, y: ev.clientY, zone: target.el });
  };
  const up = (ev: PointerEvent) => finish(ev, false);
  const cancel = (ev: PointerEvent) => finish(ev, true);
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}
