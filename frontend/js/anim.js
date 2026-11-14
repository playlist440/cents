// Draw-in animations that can never leave a screen in a wrong state.
//
// Principle (DESIGN §4/§5 review fix): the element's *base style is the end state*; the
// animation only runs *from* a start state. When animations are throttled (background tab,
// busy main thread, screenshots) or reduced, the final state is still correct:
//   - reduced motion or a hidden document: no animation at all;
//   - otherwise a Web Animation with fill "backwards" plus a timer that finishes it shortly
//     after its planned end, even when frames are not being produced.
//
//   drawIn(el, [{ transform: 'scaleX(0)' }, {}], { duration: 800, delay: 40 })
//   html`<span ref=${useDrawIn([{ opacity: 0 }, {}])} />`       // once per mount

import { useRef, useEffect } from './vendor/preact-htm.js';
import { reducedMotion } from './hooks.js';

export const EASE_OUT = 'cubic-bezier(.22, 1, .36, 1)';
export const SPRING = 'cubic-bezier(.34, 1.3, .64, 1)';

export function canAnimate() {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && !reducedMotion();
}

/** Animate `el` from the first keyframe to its own (final) style. Returns the Animation or null. */
export function drawIn(el, keyframes, { duration = 800, delay = 0, easing = EASE_OUT } = {}) {
  if (!el || typeof el.animate !== 'function' || !canAnimate()) return null;
  let a;
  try {
    a = el.animate(keyframes, { duration, delay, easing, fill: 'backwards' });
  } catch {
    return null;
  }
  const settle = () => { try { if (a.playState !== 'finished') a.finish(); } catch { /* detached */ } };
  const t = setTimeout(settle, delay + duration + 250);
  const onHide = () => { if (document.visibilityState !== 'visible') settle(); };
  document.addEventListener('visibilitychange', onHide);
  a.addEventListener?.('finish', () => { clearTimeout(t); document.removeEventListener('visibilitychange', onHide); });
  a.addEventListener?.('cancel', () => { clearTimeout(t); document.removeEventListener('visibilitychange', onHide); });
  return a;
}

/** Ref callback that runs drawIn once for the lifetime of the component. */
export function useDrawIn(keyframes, opts) {
  const done = useRef(false);
  const cb = useRef(null);
  if (!cb.current) {
    cb.current = (el) => {
      if (!el || done.current) return;
      done.current = true;
      drawIn(el, keyframes, opts);
    };
  }
  return cb.current;
}

/**
 * For lists of animated parts: `const first = useFirstRender();` then
 * `ref=${(el) => first.current && drawIn(el, …)}` animates only on the first commit.
 */
export function useFirstRender() {
  const first = useRef(true);
  useEffect(() => { first.current = false; });
  return first;
}
