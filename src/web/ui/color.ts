/** Colour helpers for the few places that take colours from outside the app. */

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * A CSS colour ("blue", "#e32", "rgb(1, 2, 3)") as #rrggbb, which is what colour inputs need.
 * Returns undefined for anything the browser does not recognise as a colour.
 */
export function cssToHex(color: string | undefined): string | undefined {
  if (!color) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  if (probe === undefined) probe = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!probe) return undefined;
  // The canvas keeps its old colour when given nonsense, so try from two different starting points.
  probe.fillStyle = '#000000';
  probe.fillStyle = color;
  const first = probe.fillStyle;
  probe.fillStyle = '#ffffff';
  probe.fillStyle = color;
  if (first !== probe.fillStyle || typeof first !== 'string') return undefined;
  if (/^#[0-9a-f]{6}$/i.test(first)) return first.toLowerCase();
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(first);
  return m ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : undefined;
}
