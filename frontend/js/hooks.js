// Small shared hooks: media queries, layout class, reduced motion, page activity.

import { useState, useEffect, useContext, useRef } from './vendor/preact-htm.js';
import { PageContext } from './context.js';

export function useMedia(query) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    on();
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** 'compact' (< 700), 'regular' (700–999) or 'wide' (≥ 1000). */
export function useLayout() {
  const regular = useMedia('(min-width: 700px)');
  const wide = useMedia('(min-width: 1000px)');
  return wide ? 'wide' : regular ? 'regular' : 'compact';
}

export const isWide = () => matchMedia('(min-width: 1000px)').matches;
export const canHover = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/** Page context: { key, active, route, params, query } for the screen being rendered. */
export function usePage() {
  return useContext(PageContext) || { active: true, params: {}, query: {} };
}

/** Remember the previous value of something (for count-up animations). */
export function usePrevious(value) {
  const ref = useRef();
  useEffect(() => { ref.current = value; });
  return ref.current;
}

/** Stable unique id for aria attributes. */
let idSeq = 0;
export function useId(prefix = 'c') {
  const ref = useRef(null);
  if (ref.current == null) ref.current = `${prefix}${++idSeq}`;
  return ref.current;
}
