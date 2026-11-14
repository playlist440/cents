// Desktop toolbar parts (≥ 1000 px), rendered by Screen:
//
//   ToolbarSearch  searches payments from any screen. On Transacties it is that screen's
//                  search (live, debounced into `q`); elsewhere Enter opens Transacties with
//                  `q`. `/` or ⌘K focuses it (shell/keys.js), Esc clears and leaves it.
//   AddButton      the global `+`: screen items first (Screen `add`), then
//                  "Bankbestand importeren" and "Uitgave toevoegen".

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { navigate, replaceQuery } from '../router.js';
import { usePage } from '../hooks.js';
import { openMenu } from './Menu.js';
import { openImport, openAddExpense } from '../shell/actions.js';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function ToolbarSearch() {
  // Each kept-alive screen has its own toolbar: use *this* page's route, not the global one.
  const page = usePage();
  const onTx = page.route?.path === '/transacties';
  const routeQ = onTx ? page.query?.q || '' : '';
  const [q, setQ] = useState(routeQ);
  const [focused, setFocused] = useState(false);
  const input = useRef(null);
  const timer = useRef(0);

  // Follow the URL on Transacties (filters cleared elsewhere, links with q).
  useEffect(() => { if (onTx && routeQ !== q.trim()) setQ(routeQ); }, [routeQ, onTx]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Text typed elsewhere is not a filter: drop it when the screen is left.
  useEffect(() => { if (!page.active && !onTx) setQ(''); }, [page.active]);

  const onInput = (e) => {
    const v = e.currentTarget.value;
    setQ(v);
    if (!onTx) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => replaceQuery({ q: v.trim() || undefined }), 260);
  };
  const submit = () => {
    const v = q.trim();
    if (onTx) { clearTimeout(timer.current); replaceQuery({ q: v || undefined }); return; }
    if (!v) return;
    navigate('/transacties', { query: { q: v } });
    setQ('');
    input.current?.blur();
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (q) { setQ(''); if (onTx) { clearTimeout(timer.current); replaceQuery({ q: undefined }); } } else input.current?.blur();
    }
  };
  const clear = () => {
    setQ('');
    if (onTx) { clearTimeout(timer.current); replaceQuery({ q: undefined }); }
    input.current?.focus();
  };

  return html`<label class=${'tb-search' + (focused ? ' is-focused' : '') + (q ? ' has-value' : '')}>
    <${Icon} name="search" size=${15} stroke=${2.2} />
    <input ref=${input} type="search" value=${q} placeholder=${onTx ? 'Zoek winkel, bedrag of tag' : 'Zoek betalingen'}
      aria-label="Zoek betalingen" autocomplete="off" autocapitalize="off" spellcheck=${false} enterkeyhint="search"
      onInput=${onInput} onKeyDown=${onKey} onFocus=${() => setFocused(true)} onBlur=${() => setFocused(false)} />
    ${q
      ? html`<button type="button" class="tb-search-clear" aria-label="Wis zoekopdracht" onPointerDown=${(e) => e.preventDefault()} onClick=${clear}>
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" /><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="var(--bg)" stroke-width="2.2" stroke-linecap="round" /></svg>
        </button>`
      : !focused && html`<kbd class="tb-kbd" aria-hidden="true">${isMac ? '⌘K' : '/'}</kbd>`}
  </label>`;
}

export function AddButton({ items = [] }) {
  const open = (e) => openMenu(e.currentTarget, [
    ...items,
    ...(items.length ? ['-'] : []),
    { label: 'Bankbestand importeren', icon: 'import', shortcut: 'I', onSelect: () => openImport() },
    { label: 'Uitgave toevoegen', icon: 'creditcard', shortcut: 'N', onSelect: () => openAddExpense() },
  ]);
  return html`<button class="navbtn tb-add" onClick=${open} aria-label="Toevoegen" aria-haspopup="menu" data-tip="Toevoegen">
    <${Icon} name="plus" size=${20} stroke=${2.1} />
  </button>`;
}

/** Focus the toolbar search of the visible screen. Returns true when there is one. */
export function focusToolbarSearch() {
  const el = document.querySelector('.page:not([hidden]):not(.is-frozen) .tb-search input');
  if (!el) return false;
  el.focus();
  el.select();
  return true;
}
