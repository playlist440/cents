// Hash router with history integration.
//
// - Every screen change is a history entry (#/path?query); history.state = { idx, path, sheet? }.
// - Sheets are history entries too (same URL, state.sheet = id), so the browser back button,
//   the iOS back gesture and Escape all close the top sheet first.
// - The outlet (shell/outlet.js) listens and animates: 'push' | 'pop' | 'tab' | 'cover' |
//   'uncover' | 'none'.
//
// Public API: navigate(to, opts), back(fallback), replaceQuery(patch), openSheet(Comp, props),
// closeSheet(id), closeAllSheets(), useRoute(), useSheets(), current().

import { useState, useEffect } from './vendor/preact-htm.js';
import { scrollY } from './scroll.js';

let routes = [];
let cur = null;           // { full, path, query, route, params, idx, direction }
const entries = [];       // idx -> full path, for "is the previous entry my parent?"
const listeners = new Set();
let sheets = [];          // [{ id, Component, props, entryIdx, closing }]
const sheetListeners = new Set();
let sheetSeq = 0;
let pending = null;       // navigation waiting for sheet entries to be popped
let silentPop = false;    // interactive edge swipe already animated the pop
let awaitingPops = 0;     // history.back() calls made by closeSheet that popstate has not reported yet
export const scrollMemory = new Map(); // page key -> scrollY

/* ---------- Parsing and matching ---------- */

function compile(pattern) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  return { re, keys };
}

export function parse(full) {
  const clean = (full || '').replace(/^#/, '') || '/';
  const [path, qs = ''] = clean.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs));
  return { full: clean.startsWith('/') ? clean : '/' + clean, path: path.startsWith('/') ? path : '/' + path, query };
}

export function match(path) {
  for (const r of routes) {
    const m = path.match(r._c.re);
    if (m) {
      const params = {};
      r._c.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
  }
  return null;
}

function resolve(full) {
  const p = parse(full);
  const m = match(p.path);
  if (!m) return null;
  return { ...p, ...m };
}

/** Build "/path?query" from a path and a query object (empty values dropped). */
export function href(path, query = {}) {
  const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const s = q.toString();
  return '#' + path + (s ? '?' + s : '');
}

/* ---------- State ---------- */

function emit() { listeners.forEach((fn) => fn(cur)); }
function emitSheets() { sheetListeners.forEach((fn) => fn(sheets)); }

function setCurrent(full, idx, direction) {
  let r = resolve(full);
  if (!r) r = resolve(defaultPath);
  if (cur) scrollMemory.set(cur.path, scrollY());
  cur = { ...r, idx, direction };
  entries[idx] = r.full;
  emit();
}

let defaultPath = '/overzicht';
const isWideNow = () => matchMedia('(min-width: 1000px)').matches;

export function initRouter(routeTable, { fallback = '/overzicht' } = {}) {
  routes = routeTable.map((r) => ({ ...r, _c: compile(r.path) }));
  defaultPath = fallback;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const start = resolve(location.hash) ? parse(location.hash).full : fallback;
  // A reload must not resurrect a sheet entry: rewrite it to a plain route entry.
  const idx = history.state?.idx ?? 0;
  history.replaceState({ idx, path: start }, '', '#' + start);
  cur = { ...resolve(start), idx, direction: 'none' };
  entries[idx] = start;
  window.addEventListener('popstate', onPop);
  window.addEventListener('hashchange', onHashChange);
}

function onPop(e) {
  const st = e.state;
  if (!st || st.idx == null) return; // hashchange handles manual edits
  if (awaitingPops > 0) awaitingPops--;
  // Close sheets whose history entry is gone. New objects and a new array, so subscribers
  // (useSheets → Sheet's closing effect) see the change.
  if (sheets.some((s) => !s.closing && s.entryIdx > st.idx)) {
    sheets = sheets.map((s) => (!s.closing && s.entryIdx > st.idx ? { ...s, closing: true } : s));
    emitSheets();
  }
  if (st.sheet && !sheets.some((s) => s.id === st.sheet && !s.closing)) {
    // Forward into a sheet entry whose sheet no longer exists: skip it.
    history.back();
    return;
  }
  if (st.path !== cur.full || st.idx !== cur.idx) {
    if (st.path !== cur.full) {
      const dir = silentPop ? 'none' : st.idx < cur.idx ? 'pop' : 'push';
      silentPop = false;
      setCurrent(st.path, st.idx, inferDirection(resolve(st.path), dir));
    } else {
      cur = { ...cur, idx: st.idx };
    }
  }
  if (pendingQuery && awaitingPops === 0) { const q = pendingQuery; pendingQuery = null; replaceQuery(q); }
  if (pending && !sheets.some((s) => !s.closing) && awaitingPops === 0) {
    const p = pending;
    pending = null;
    navigate(p.to, p.opts);
  }
}

function onHashChange() {
  // Only fires for manual edits / plain links; our own pushState does not trigger it.
  const p = parse(location.hash);
  if (p.full === cur.full) return;
  const idx = cur.idx + 1;
  history.replaceState({ idx, path: p.full }, '', '#' + p.full);
  setCurrent(p.full, idx, inferDirection(resolve(p.full), 'push'));
}

function inferDirection(target, fallback) {
  if (!target || !cur) return 'none';
  if (fallback === 'none') return 'none';
  if (target.path === cur.path) return 'none';
  const tr = target.route;
  const cr = cur.route;
  if (fallback === 'push') {
    if (tr.presentation === 'cover') return isWideNow() ? 'tab' : 'cover';
    if (!tr.parent || tr.sidebarRoot && isWideNow()) return 'tab';
    if (tr.tab && cr.tab && tr.tab !== cr.tab) return 'tab';
    return 'push';
  }
  // pop
  if (cr.presentation === 'cover') return isWideNow() ? 'tab' : 'uncover';
  if (!cr.parent && !tr.parent) return 'tab';
  return 'pop';
}

/**
 * navigate('/potjes/3'), navigate('/overzicht', { query: {period}, replace: true })
 * opts.direction overrides the inferred animation.
 */
export function navigate(to, opts = {}) {
  let full = parse(to.replace(/^#/, '')).full;
  if (opts.query) {
    const p = parse(full);
    full = href(p.path, { ...p.query, ...opts.query }).slice(1);
  }
  const open = sheets.filter((s) => !s.closing);
  if (open.length || awaitingPops > 0) {
    // Wait until the sheet entries are off the history stack, then navigate (onPop).
    pending = { to: full, opts };
    if (open.length) {
      const depth = cur.idx - Math.min(...open.map((s) => s.entryIdx)) + 1;
      awaitingPops++;
      history.go(-depth);
    }
    return;
  }
  const target = resolve(full);
  if (!target) return;
  if (target.full === cur.full && !opts.replace) return;
  const idx = opts.replace ? cur.idx : cur.idx + 1;
  const state = { idx, path: target.full };
  if (opts.replace) history.replaceState(state, '', '#' + target.full);
  else history.pushState(state, '', '#' + target.full);
  entries.length = idx + 1;
  const dir = opts.direction || inferDirection(target, opts.replace ? 'none' : 'push');
  setCurrent(target.full, idx, dir);
}

/** Change query params of the current screen without a new history entry. */
let pendingQuery = null;  // replaceQuery while a sheet's history.back() is in flight
export function replaceQuery(patch) {
  if (awaitingPops > 0) { pendingQuery = { ...(pendingQuery || {}), ...patch }; return; }
  const q = { ...cur.query, ...patch };
  const full = href(cur.path, q).slice(1);
  history.replaceState({ ...history.state, path: full }, '', '#' + full);
  cur = { ...cur, ...resolve(full), direction: 'none' };
  entries[cur.idx] = full;
  emit();
}

/**
 * Go back. If the previous history entry is `parent` (or no parent given), use history.back();
 * otherwise replace the current entry with the parent and animate a pop.
 */
export function back(parent, { silent = false } = {}) {
  const prev = entries[cur.idx - 1];
  const prevPath = prev ? parse(prev).path : null;
  if (cur.idx > 0 && prev && (!parent || prevPath === parse(parent).path)) {
    silentPop = silent;
    history.back();
    return;
  }
  navigate(parent || defaultPath, { replace: true, direction: silent ? 'none' : cur.route.presentation === 'cover' ? (isWideNow() ? 'tab' : 'uncover') : 'pop' });
}

/** The full path of the entry below the current one, if it is still in history. */
export function previousEntry() {
  return cur.idx > 0 ? entries[cur.idx - 1] || null : null;
}

export const current = () => cur;

export function onRouteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useRoute() {
  const [r, setR] = useState(cur);
  useEffect(() => { setR(cur); return onRouteChange(setR); }, []);
  return r;
}

/* ---------- Sheets ---------- */

/** Open a sheet component. Returns its id. The component receives props + { close }. */
export function openSheet(Component, props = {}) {
  const id = 's' + ++sheetSeq;
  const entryIdx = cur.idx + 1;
  history.pushState({ idx: entryIdx, path: cur.full, sheet: id }, '', '#' + cur.full);
  cur = { ...cur, idx: entryIdx };
  entries[entryIdx] = cur.full;
  sheets = [...sheets, { id, Component, props, entryIdx, closing: false }];
  emitSheets();
  return id;
}

/** Close a sheet (animates out). Uses history.back() when it is the top history entry. */
export function closeSheet(id) {
  const s = sheets.find((x) => x.id === id);
  if (!s || s.closing) return;
  sheets = sheets.map((x) => (x.id === id ? { ...x, closing: true } : x));
  emitSheets();
  if (history.state?.sheet === id) { awaitingPops++; history.back(); }
}

export function closeAllSheets() {
  const open = sheets.filter((s) => !s.closing);
  if (!open.length) return;
  const depth = cur.idx - Math.min(...open.map((s) => s.entryIdx)) + 1;
  sheets = sheets.map((s) => (s.closing ? s : { ...s, closing: true }));
  emitSheets();
  awaitingPops++;
  history.go(-depth);
}

/** Called by the sheet host when the close animation has finished. */
export function removeSheet(id) {
  sheets = sheets.filter((s) => s.id !== id);
  emitSheets();
}

export function useSheets() {
  const [s, setS] = useState(sheets);
  useEffect(() => {
    const fn = (x) => setS(x);
    setS(sheets);
    sheetListeners.add(fn);
    return () => sheetListeners.delete(fn);
  }, []);
  return s;
}

export const hasOpenSheet = () => sheets.some((s) => !s.closing);
