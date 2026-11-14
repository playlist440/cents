// Interactive edge-swipe back for pushed screens. Only in standalone (Home Screen) mode:
// in Safari tabs the browser's own edge gesture already navigates back. `?swipe=1` forces it.

import { current, previousEntry, parse, back, hasOpenSheet, scrollMemory } from '../router.js';
import { outlet } from './outlet.js';
import { isStandalone, isWide } from '../hooks.js';

export function installEdgeSwipe() {
  if (!isStandalone() && !new URLSearchParams(location.search).has('swipe')) return;
  let g = null;

  const reset = (el) => {
    if (!el) return;
    el.style.transition = '';
    el.style.transform = '';
    el.style.removeProperty('--dim-o');
    el.style.removeProperty('--freeze-top');
    el.classList.remove('is-frozen', 'is-dimmed', 'is-top');
  };

  window.addEventListener('touchstart', (e) => {
    g = null;
    if (e.touches.length !== 1 || hasOpenSheet()) return;
    const t = e.touches[0];
    if (t.clientX > 24) return;
    const r = current();
    if (!r.route.parent || r.route.presentation === 'cover' || (isWide() && r.route.sidebarRoot)) return;
    const prevFull = previousEntry();
    if (!prevFull) return;
    const prevKey = parse(prevFull).path;
    const cur = outlet.el(r.path);
    const prev = outlet.el(prevKey);
    if (!cur || !prev || prev === cur) return;
    g = { x0: t.clientX, y0: t.clientY, started: false, cur, prev, prevKey, w: window.innerWidth, lastX: t.clientX, lastT: e.timeStamp, v: 0, p: 0 };
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x0;
    const dy = t.clientY - g.y0;
    if (!g.started) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g = null; return; }
      if (dx < 8) return;
      g.started = true;
      g.prev.hidden = false;
      g.prev.classList.add('is-frozen', 'is-dimmed');
      g.prev.style.setProperty('--freeze-top', `${window.scrollY - (scrollMemory.get(g.prevKey) || 0)}px`);
      g.cur.classList.add('is-top');
    }
    e.preventDefault();
    const x = Math.max(0, dx);
    g.v = (t.clientX - g.lastX) / Math.max(1, e.timeStamp - g.lastT);
    g.lastX = t.clientX; g.lastT = e.timeStamp;
    g.p = Math.min(1, x / g.w);
    g.cur.style.transform = `translate3d(${x}px,0,0)`;
    g.prev.style.transform = `translate3d(${-30 * (1 - g.p)}%,0,0)`;
    g.prev.style.setProperty('--dim-o', String(1 - g.p));
  }, { passive: false });

  const end = () => {
    if (!g || !g.started) { g = null; return; }
    const { cur, prev, p, v } = g;
    g = null;
    const commit = p > 0.4 || v > 0.45;
    const ms = Math.round(commit ? 260 * (1 - p) + 80 : 260 * p + 80);
    const curve = 'cubic-bezier(.2,.8,.2,1)';
    cur.style.transition = `transform ${ms}ms ${curve}`;
    prev.style.transition = `transform ${ms}ms ${curve}`;
    cur.style.transform = commit ? 'translate3d(100%,0,0)' : 'translate3d(0,0,0)';
    prev.style.transform = commit ? 'translate3d(0,0,0)' : 'translate3d(-30%,0,0)';
    prev.style.setProperty('--dim-o', commit ? '0' : '1');
    setTimeout(() => {
      if (commit) {
        back(undefined, { silent: true });
        requestAnimationFrame(() => { reset(prev); reset(cur); });
      } else {
        reset(cur);
        reset(prev);
        prev.hidden = true;
      }
    }, ms);
  };
  window.addEventListener('touchend', end);
  window.addEventListener('touchcancel', end);
}
