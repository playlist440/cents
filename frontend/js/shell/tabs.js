// Tab and sidebar behaviour shared by TabBar and Sidebar: remembers the last screen per tab,
// pops to root or scrolls to top on re-tap.

import { navigate, onRouteChange, current, parse } from '../router.js';
import { tabs, sidebar } from '../routes.js';
import { isWide } from '../hooks.js';

const memory = new Map(); // tab id -> { path, at }: the last screen per tab
let lastTab = 'overzicht';
// A tab reopens where you were only shortly after; later it opens at its start (usability test
// 2026-11: "Meer" brought back a settings screen from long ago).
const REMEMBER_MS = 3 * 60 * 1000;

onRouteChange((r) => {
  const t = tabOf(r);
  if (t) { memory.set(t, { path: r.full, at: Date.now() }); lastTab = t; }
});

function tabOf(r) {
  if (!r) return null;
  if (isWide()) return r.route.sidebar || r.route.tab || null;
  return r.route.tab || null;
}

export function activeTab(r = current()) {
  return tabOf(r) || lastTab;
}

function rootOf(id) {
  return (tabs.find((t) => t.id === id) || sidebar.find((s) => s.id === id))?.path;
}

export function goTab(id) {
  const r = current();
  const root = rootOf(id);
  if (activeTab(r) === id && tabOf(r)) {
    if (r.path !== parse(root).path) navigate(root, { direction: 'pop' });
    else window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    return;
  }
  const m = memory.get(id);
  const remembered = m && Date.now() - m.at < REMEMBER_MS ? m.path : null;
  navigate(remembered || root, { direction: 'tab' });
}
