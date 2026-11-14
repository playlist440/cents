// The outlet keeps recently visited screens mounted (hidden) so going back is instant and
// keeps scroll and state, and animates between them while the document stays the scroller.
//
// Transitions: the leaving page is taken out of flow ("frozen": absolute, pinned where it was
// on screen) while the entering page sits in flow at its own scroll position.

import { html, Component, useState, useEffect, useLayoutEffect, useRef } from '../vendor/preact-htm.js';
import { useRoute, scrollMemory } from '../router.js';
import { PageContext } from '../context.js';
import { setScrollY, scrollY } from '../scroll.js';
import { reducedMotion, isWide } from '../hooks.js';

const MAX_PAGES = 8;
const els = new Map();

/** Imperative access for the edge-swipe gesture. */
export const outlet = {
  el: (key) => els.get(key) || null,
};

class PageView extends Component {
  shouldComponentUpdate(next) {
    const p = this.props;
    return next.active !== p.active || next.full !== p.full || next.cls !== p.cls || next.hidden !== p.hidden;
  }
  render({ page, active, hidden, cls }) {
    const ctx = { key: page.path, active, route: page.route, params: page.params, query: page.query, full: page.full };
    const Screen = page.route.screen;
    return html`<div class=${'page ' + cls} hidden=${hidden} data-key=${page.path}
      ref=${(el) => { if (el) els.set(page.path, el); else els.delete(page.path); }}>
      <${PageContext.Provider} value=${ctx}>
        <${Screen} params=${page.params} query=${page.query} />
      </${PageContext.Provider}>
    </div>`;
  }
}

const ANIM = {
  push: ['anim-push-in', 'anim-push-out is-dimmed', 'in'],
  pop: ['anim-pop-in is-dimmed', 'anim-pop-out is-top', 'out'],
  cover: ['anim-cover-in is-top', '', 'in'],
  uncover: ['', 'anim-cover-out is-top', 'out'],
  tab: ['anim-fade-in', null, 'in'],
};

export function Outlet() {
  const route = useRoute();
  const [st, setSt] = useState(() => ({
    pages: [toPage(route)],
    active: route.path,
    leaving: null,
    anim: null,
  }));
  const pending = useRef(null);

  // React to route changes.
  useEffect(() => {
    setSt((s) => {
      const key = route.path;
      let pages = s.pages.filter((p) => p.path !== key);
      const existing = s.pages.find((p) => p.path === key);
      const page = existing ? { ...existing, ...toPage(route) } : toPage(route);
      pages.push(page);
      if (key === s.active) return { ...s, pages: s.pages.map((p) => (p.path === key ? page : p)) };
      let type = route.direction || 'none';
      if (reducedMotion() && type !== 'none') type = 'tab';
      // Mac: no sliding pages; pushed screens cross-fade like the sidebar destinations.
      if (isWide() && (type === 'push' || type === 'pop')) type = 'tab';
      if (type === 'tab' && !ANIM.tab) type = 'none';
      // Drop a page that was popped while we are leaving it.
      const popped = type === 'pop' || type === 'uncover' || (type === 'none' && isPopLike(s.active, key));
      pending.current = { type, from: s.active, to: key, existed: !!existing, popped };
      while (pages.length > MAX_PAGES) {
        const i = pages.findIndex((p) => p.path !== key && p.path !== s.active);
        if (i < 0) break;
        pages.splice(i, 1);
      }
      return { pages, active: key, leaving: ANIM[type] && ANIM[type][1] !== null ? s.active : null, anim: type };
    });
  }, [route]);

  // Before paint: scroll the entering page into place, pin the leaving page where it was.
  useLayoutEffect(() => {
    const t = pending.current;
    if (!t) return;
    pending.current = null;
    const fromScroll = scrollMemory.get(t.from) || 0;
    const restore = t.type !== 'push' && t.type !== 'cover' && t.existed;
    const toScroll = restore ? scrollMemory.get(t.to) || 0 : 0;
    setScrollY(toScroll);
    const fromEl = els.get(t.from);
    if (fromEl && st.leaving) fromEl.style.setProperty('--freeze-top', `${scrollY() - fromScroll}px`);
    const toEl = els.get(t.to);
    const done = () => {
      setSt((s) => ({
        ...s,
        leaving: null,
        anim: null,
        pages: t.popped ? s.pages.filter((p) => p.path !== t.from || p.path === s.active) : s.pages,
      }));
      if (fromEl) fromEl.style.removeProperty('--freeze-top');
    };
    const spec = ANIM[t.type];
    if (!spec) { done(); return; }
    const watch = spec[2] === 'in' ? toEl : fromEl;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; done(); } };
    watch?.addEventListener('animationend', function onEnd(e) {
      if (e.target !== watch) return;
      watch.removeEventListener('animationend', onEnd);
      finish();
    });
    setTimeout(finish, 700);
  }, [st.active]);

  return html`<div class="outlet">
    ${st.pages.map((p) => {
      const isActive = p.path === st.active;
      const isLeaving = p.path === st.leaving;
      const spec = ANIM[st.anim];
      let cls = '';
      if (isActive && spec) cls = spec[0];
      if (isLeaving && spec) cls = 'is-frozen ' + (spec[1] || '');
      return html`<${PageView} key=${p.path} page=${p} full=${p.full} active=${isActive}
        hidden=${!isActive && !isLeaving} cls=${cls} />`;
    })}
  </div>`;
}

function toPage(route) {
  return { path: route.path, full: route.full, route: route.route, params: route.params, query: route.query };
}

// A silent pop (after the edge-swipe gesture) arrives as 'none'; still evict the popped page.
function isPopLike(from, to) {
  return from.startsWith(to + '/');
}
