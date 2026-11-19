// Money with tabular numerals. `animate` counts up/down from the previous value (hero numbers
// and ring centres only; lists never animate).
//
//   html`<${Amount} cents=${-4120} />`                       → € 41,20
//   html`<${Amount} cents=${64000} whole animate signed />`  → +€ 640 (counting)

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { money } from '../format.js';
import { canAnimate } from '../anim.js';

const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** Animated number: returns the value to display this frame. */
export function useCountUp(target, { duration = 900, from = null, enabled = true } = {}) {
  // Base state is the target: only count when frames are really being drawn.
  const initial = enabled && canAnimate() ? (from ?? target) : target;
  const [value, setValue] = useState(initial);
  const shown = useRef(initial);
  useEffect(() => {
    if (target == null) return;
    const start = shown.current ?? 0;
    if (!enabled || !canAnimate() || start === target) { shown.current = target; setValue(target); return; }
    let raf;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const v = Math.round(start + (target - start) * easeOutExpo(p));
      shown.current = v;
      setValue(v);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // Frames throttled (background tab, busy thread): land on the target anyway.
    const settle = setTimeout(() => { cancelAnimationFrame(raf); shown.current = target; setValue(target); }, duration + 150);
    return () => { cancelAnimationFrame(raf); clearTimeout(settle); };
  }, [target]);
  return value;
}

export function Amount({ cents, whole = false, signed = false, negative = false, animate = false, from = null, class: cls = '', income = false }) {
  const counted = useCountUp(cents, { from: animate ? from : cents, enabled: animate });
  const v = animate ? counted : cents;
  const pos = income || (signed && cents > 0);
  return html`<span class=${'amount num' + (pos ? ' is-income' : '') + (cls ? ' ' + cls : '')}
    aria-label=${animate ? money(cents, { whole, signed, negative }) : null}>${money(v, { whole, signed, negative })}</span>`;
}
