// A tiny global store plus a query cache. No library: get/set/subscribe and two hooks.
//
// Global state (read with useStore(s => s.x)):
//   session    {setup_required, authenticated, version} | null while unknown
//   boot       GET /api/bootstrap result | null
//   dataVersion  bumped after every mutation; queries refetch when it changes
//   mock       true when the in-browser mock API is active

import { useState, useEffect, useRef, useCallback, useContext } from './vendor/preact-htm.js';
import { PageContext } from './context.js';

let state = { session: null, boot: null, dataVersion: 0, mock: false };
const listeners = new Set();

export const getState = () => state;

export function setState(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Select a slice of the store; re-renders only when the slice changes (shallow ===). */
export function useStore(selector = (s) => s) {
  const [value, setValue] = useState(() => selector(state));
  const sel = useRef(selector);
  sel.current = selector;
  useEffect(() => {
    const update = (s) => {
      const next = sel.current(s);
      setValue((prev) => (Object.is(prev, next) ? prev : next));
    };
    update(state); // the store may have changed between render and this effect
    return subscribe(update);
  }, []);
  return value;
}

/** Call after any mutation: refetches bootstrap and every visible query. */
export function invalidate() {
  setState((s) => ({ dataVersion: s.dataVersion + 1 }));
}

/* ---------- Lookup helpers on bootstrap data ---------- */

export function categoryById(id) {
  const cats = state.boot?.categories || [];
  return cats.find((c) => c.id === id) || null;
}
export function categoryByKey(key) {
  return (state.boot?.categories || []).find((c) => c.key === key) || null;
}
export function tagById(id) {
  return (state.boot?.tags || []).find((t) => t.id === id) || null;
}
export function accountById(id) {
  return (state.boot?.accounts || []).find((a) => a.id === id) || null;
}

/* ---------- Query cache ---------- */
// useQuery(key, fetcher): stale-while-revalidate. Cached data renders instantly when a screen
// is revisited; it refetches when dataVersion changes, but only while the page is visible.

const cache = new Map(); // key -> { data, version }

export function peekQuery(key) {
  return cache.get(key)?.data;
}
export function setQueryData(key, data) {
  cache.set(key, { data, version: state.dataVersion });
}

export function useQuery(key, fetcher, { enabled = true } = {}) {
  const page = useContext(PageContext);
  const active = page ? page.active : true;
  const version = useStore((s) => s.dataVersion);
  const entry = key ? cache.get(key) : null;
  const [, force] = useState(0);
  const [error, setError] = useState(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);

  const load = useCallback(() => {
    if (!key) return Promise.resolve();
    const my = ++seq.current;
    const v = state.dataVersion;
    return fetcherRef.current().then((data) => {
      cache.set(key, { data, version: v });
      if (my === seq.current) { setError(null); force((n) => n + 1); }
    }, (err) => {
      if (my === seq.current) { setError(err); force((n) => n + 1); }
    });
  }, [key]);

  const stale = !entry || entry.version !== version;
  useEffect(() => {
    if (enabled && active && stale) load();
  }, [key, version, active, enabled, stale]);

  return { data: entry?.data, error: entry ? null : error, loading: !entry, reload: load };
}
