// Shared chart helpers: container width, nice ticks, monotone path, scrubbing.

import { html, useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-htm.js';

/** Measure an element's width (ResizeObserver). Returns [ref, width]. */
export function useWidth(initial = 320) {
  const ref = useRef(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => { const x = el.clientWidth; if (x > 0) setW(x); };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A "nice" max and 3 ticks (0, max/2, max) for money in cents. */
export function niceMax(maxCents) {
  if (maxCents <= 0) return 10000;
  const e = maxCents / 100;
  const pow = Math.pow(10, Math.floor(Math.log10(e)));
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  for (const s of steps) if (s * pow >= e) return s * pow * 100;
  return 10 * pow * 100;
}

/** Monotone cubic interpolation path (never overshoots). pts: [[x,y],...] */
export function monotonePath(pts) {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push((pts[i + 1][1] - pts[i][1]) / (dx[i] || 1));
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + h * t[i]).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - h * t[i + 1]).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

/**
 * Scrubbing with finger or mouse. indexAt(x) maps a local x to an index.
 * Touch: the selection follows the finger and clears on release (like Health/Stocks).
 * Mouse: follows hover, clears on leave. Returns handlers for the svg/container.
 */
export function scrubHandlers({ indexAt, onChange, keep = false }) {
  let down = false;
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    onChange(indexAt(e.clientX - r.left));
  };
  return {
    onPointerDown: (e) => { down = true; pick(e); },
    onPointerMove: (e) => { if (down || e.pointerType === 'mouse') pick(e); },
    onPointerUp: (e) => { down = false; if (e.pointerType !== 'mouse' && !keep) onChange(null); },
    onPointerCancel: () => { down = false; if (!keep) onChange(null); },
    onPointerLeave: (e) => { if (e.pointerType === 'mouse' && !keep) onChange(null); },
  };
}

let gradSeq = 0;
export const uid = (p) => `${p}${++gradSeq}`;

/**
 * Hover read-out: a small floating label centred on x (px inside the chart), clamped to the
 * chart width. Shown by the charts on pointer devices next to their crosshair.
 *   html`<${Readout} x=${120} width=${w}>…</${Readout}>`
 */
export function Readout({ x, width, top = 0, children }) {
  const ref = useRef(null);
  const [rw, setRw] = useState(0);
  useLayoutEffect(() => { const el = ref.current; if (el && el.offsetWidth !== rw) setRw(el.offsetWidth); });
  const left = rw ? Math.max(0, Math.min(width - rw, x - rw / 2)) : x;
  return html`<div class="chart-readout" ref=${ref} style=${{ left: left + 'px', top: top + 'px', visibility: rw ? 'visible' : 'hidden' }} aria-hidden="true">${children}</div>`;
}
