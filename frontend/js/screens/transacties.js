// Transacties (DESIGN §3): sticky search + filter chips (Bakje, Tag, Rekening, Periode), a
// day-grouped list with sticky day headers and day totals, cursor paging with a windowed
// renderer (only the day groups near the viewport are in the DOM), multi-select with a bulk
// action bar, and a split view with the transaction detail inline at ≥ 1000 px.
//
// Filters live in the URL query (shareable, and Overzicht links here):
//   q, category_id, tag_id, account_id, period, merchant_key, unsorted=1, flow=in|out
// `flow` is a UI filter: the list then holds the period's cash-flow rows that make up
// Overzicht's Inkomen / Uitgegeven tile (fetched completely, filtered here).

import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useStore, getState, categoryById, tagById, accountById, invalidate } from '../store.js';
import { replaceQuery, openSheet, hasOpenSheet } from '../router.js';
import { usePage, useLayout } from '../hooks.js';
import { money, plural, dayLabel, monthLabel, monthSmart, MONTHS_SHORT, todayISO } from '../format.js';
import { Screen, NavButton } from '../components/Screen.js';
import { SearchField, Chip, Button } from '../components/Controls.js';
import { TxRow } from '../components/TxRow.js';
import { Skeleton, EmptyState, DropZone } from '../components/Feedback.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { openMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { Icon } from '../icons.js';
import { colorVar } from '../colors.js';
import { openAddMenu, openImport, openTransaction } from '../shell/actions.js';
import { TransactieDetail } from './transactie.js';
import { BakjeGrid, allTags, createTag, onTxChange, applyTxChange } from './_tx.js';
import { TxTableRow, openRowMenu, openBakjePopover, openTagPopover, setTxBakje, bulkSetBakje, bulkAddTag, BulkTools, MultiInspector } from './_txdesk.js';

const PAGE = 150;
const FILTER_KEYS = ['q', 'category_id', 'tag_id', 'account_id', 'period', 'merchant_key', 'unsorted', 'flow', 'sort', 'sign', 'min'];

/** Sort orders (GET /transactions `sort`); '' = newest first. */
export const TX_SORTS = [
  { v: '', label: 'Nieuwste eerst' },
  { v: 'date', label: 'Oudste eerst' },
  { v: 'amount', label: 'Grootste uitgaven eerst' },
  { v: '-amount', label: 'Grootste inkomsten eerst' },
  { v: 'merchant', label: 'Winkel A–Z' },
  { v: '-merchant', label: 'Winkel Z–A' },
  { v: 'category', label: 'Bakje A–Z' },
  { v: '-category', label: 'Bakje Z–A' },
  { v: 'account', label: 'Rekening A–Z' },
];
const sortLabel = (v) => TX_SORTS.find((s) => s.v === (v || ''))?.label || 'Nieuwste eerst';
const MIN_STEPS = [2500, 5000, 10000, 25000, 50000, 100000];

/* ======================================================================================
   Data: cursor pages + flow mode, cached per filter key
   ====================================================================================== */

const listCache = new Map(); // key -> state snapshot

function apiParams(f) {
  const p = {};
  for (const k of ['q', 'category_id', 'tag_id', 'account_id', 'period', 'merchant_key']) if (f[k]) p[k] = f[k];
  if (f.unsorted) p.unsorted = 1;
  if (f.flow && !p.period) p.period = getState().boot.periods.current;
  if (f.sort && TX_SORTS.some((s) => s.v === f.sort)) p.sort = f.sort;
  if (f.sign === 'in' || f.sign === 'out') p.sign = f.sign;
  if (Number(f.min) > 0) p.min_cents = Math.round(Number(f.min));
  return p;
}

function inFlow(t, flow) {
  const cat = categoryById(t.category_id);
  const acc = accountById(t.account_id);
  const cash = acc ? acc.type === 'checking' || (acc.type === 'credit' && t.manual) : true;
  if (!cash) return false;
  // A card settlement counts as daily spending when no credit-card account explains it
  // (docs/DECISIONS.md, Analytics "Credit card"); with a card account its purchases are listed.
  if (t.kind === 'settlement' || cat?.key === 'creditcard') return flow === 'out' && !getState().boot.accounts.some((a) => a.type === 'credit');
  if (t.kind !== 'normal') return false;
  const unsorted = !cat || cat.key === 'unsorted';
  if (flow === 'in') return cat?.grp === 'income' || (unsorted && t.amount_cents > 0);
  return cat?.grp === 'daily' && !(unsorted && t.amount_cents > 0);
}

async function fetchAll(params, max = 6000) {
  let items = [];
  let cursor = null;
  do {
    const res = await api.transactions({ ...params, limit: 1000, cursor });
    items = items.concat(res.items);
    cursor = res.next_cursor;
  } while (cursor && items.length < max);
  return items;
}

function summarize(items) {
  let sumIn = 0;
  let sumOut = 0;
  for (const t of items) { if (t.amount_cents > 0) sumIn += t.amount_cents; else sumOut += t.amount_cents; }
  return { count: items.length, sumIn, sumOut };
}

function useTxList(filters, active) {
  const key = JSON.stringify(apiParams(filters)) + '|' + (filters.flow || '');
  const version = useStore((s) => s.dataVersion);
  const [st, setSt] = useState(() => listCache.get(key) || null);
  const cur = useRef({ key, st });
  cur.current.key = key;
  const busy = useRef(false);
  const seq = useRef(0);

  const commit = (k, next) => {
    listCache.set(k, next);
    if (cur.current.key === k) { cur.current.st = next; setSt(next); }
  };

  const load = async (k, keepCount = 0) => {
    const my = ++seq.current;
    const params = apiParams(filters);
    try {
      let next;
      if (filters.flow) {
        const items = (await fetchAll(params)).filter((t) => inFlow(t, filters.flow));
        const s = summarize(items);
        next = { items, next: null, count: s.count, sumIn: s.sumIn, sumOut: s.sumOut, version: getState().dataVersion, error: null };
      } else {
        let items = [];
        let cursor = null;
        let res;
        const want = Math.max(PAGE, keepCount);
        do {
          res = await api.transactions({ ...params, limit: Math.min(1000, want - items.length), cursor });
          items = items.concat(res.items);
          cursor = res.next_cursor;
        } while (cursor && items.length < want);
        next = { items, next: cursor, count: res.count, sumIn: res.sum_in_cents, sumOut: res.sum_out_cents, version: getState().dataVersion, error: null };
      }
      if (my === seq.current) commit(k, next);
    } catch (err) {
      if (my === seq.current) commit(k, { ...(listCache.get(k) || { items: [], next: null, count: 0, sumIn: 0, sumOut: 0 }), error: err, version: getState().dataVersion });
    }
  };

  // Filter change: show the cached result (or keep the old list dimmed) and fetch.
  useEffect(() => {
    const cached = listCache.get(key);
    cur.current.st = cached || null;
    setSt(cached || null);
    if (!cached || cached.version !== getState().dataVersion) load(key, cached?.items.length || 0);
  }, [key]);

  // Data changed elsewhere: refetch as many rows as are loaded, when visible.
  useEffect(() => {
    const s = cur.current.st;
    if (active && s && s.version !== version) load(key, s.items.length);
  }, [version, active]);

  // Optimistic edits from the transaction sheet / bulk actions.
  useEffect(() => onTxChange((change) => {
    for (const [k, s] of listCache) {
      const items = applyTxChange(s.items, change);
      if (items !== s.items) {
        const next = { ...s, items };
        listCache.set(k, next);
        if (k === cur.current.key) { cur.current.st = next; setSt(next); }
      }
    }
  }), []);

  const loadMore = async () => {
    const s = cur.current.st;
    if (!s?.next || busy.current) return;
    busy.current = true;
    const k = key;
    try {
      const res = await api.transactions({ ...apiParams(filters), limit: PAGE, cursor: s.next });
      const latest = listCache.get(k) || s;
      const seen = new Set(latest.items.map((t) => t.id));
      commit(k, { ...latest, items: latest.items.concat(res.items.filter((t) => !seen.has(t.id))), next: res.next_cursor });
    } catch (err) {
      toast({ text: err.message, icon: 'warning' });
    } finally { busy.current = false; }
  };

  return { st, loadMore, key };
}

/* ======================================================================================
   Screen
   ====================================================================================== */

export function Transacties({ query }) {
  const boot = useStore((s) => s.boot);
  const page = usePage();
  const layout = useLayout();
  const wide = layout === 'wide';
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, query[k] || '']));
  const [qText, setQText] = useState(filters.q);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [activeId, setActiveId] = useState(null);
  const lastShown = useRef(null);

  // Search: debounce into the URL.
  const qRef = useRef(qText);
  qRef.current = qText;
  useEffect(() => { if ((query.q || '') !== qRef.current.trim()) setQText(query.q || ''); }, [query.q]);
  // a new search or filter starts at the top of the list
  useEffect(() => { document.querySelectorAll('.screen-content, .td-list, .tx-table-wrap').forEach((el) => { if (el.scrollTop) el.scrollTop = 0; }); if (window.scrollY) window.scrollTo(0, 0); }, [query.q, query.cat, query.account, query.tag]);
  useEffect(() => {
    if ((qText.trim() || '') === (filters.q || '')) return;
    const t = setTimeout(() => { if (page.active) replaceQuery({ q: qText.trim() || undefined }); }, 260);
    return () => clearTimeout(t);
  }, [qText]);

  const { st, loadMore } = useTxList(filters, page.active);
  if (st) lastShown.current = st;
  const data = st || lastShown.current;
  const stale = !st && !!lastShown.current;
  const items = data?.items || [];

  const active = Object.entries(filters).some(([k, v]) => v && k !== 'q');
  const searching = !!filters.q;
  const clearAll = () => { setQText(''); replaceQuery(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined]))); };

  // Selection
  const toggleSel = (tx) => setSelected((s) => { const n = new Set(s); n.has(tx.id) ? n.delete(tx.id) : n.add(tx.id); return n; });
  const endSelect = () => { setSelecting(false); setSelected(new Set()); };
  useEffect(() => { if (!page.active && selecting) endSelect(); }, [page.active]);

  const onRow = (tx) => {
    if (selecting) { toggleSel(tx); return; }
    if (wide) { setActiveId(tx.id); setSelected(new Set([tx.id])); anchor.current = tx.id; base.current = new Set(); }
    else openTransaction(tx);
  };

  // Worksheet (≥ 1000 px): click selects, ⌘-click toggles, ⇧-click selects a range; the
  // inspector shows the active payment, or a summary when several are chosen.
  const anchor = useRef(null);
  const base = useRef(new Set());   // selection before the current ⇧-range (Finder: ⇧ adds to ⌘-picks)
  const byId = useMemo(() => new Map(items.map((t) => [t.id, t])), [items]);
  const selIds = wide ? [...selected].filter((id) => byId.has(id)) : [];
  const multi = wide && selIds.length > 1;
  const activeTx = wide && !multi ? items.find((t) => t.id === activeId) || null : null;
  const indexOf = (id) => items.findIndex((t) => t.id === id);
  const selectRow = (tx, e) => {
    if (e && (e.metaKey || e.ctrlKey)) {
      setSelected((s) => { const n = new Set(s); if (n.has(tx.id) && n.size > 1) n.delete(tx.id); else n.add(tx.id); base.current = new Set(n); return n; });
      setActiveId(tx.id);
      anchor.current = tx.id;
      return;
    }
    if (e && e.shiftKey && anchor.current != null && indexOf(anchor.current) >= 0) {
      const a = indexOf(anchor.current);
      const b = indexOf(tx.id);
      setSelected(new Set([...base.current, ...items.slice(Math.min(a, b), Math.max(a, b) + 1).map((t) => t.id)]));
      setActiveId(tx.id);
      return;
    }
    onRow(tx);
  };
  const clearMulti = () => { if (activeId != null) setSelected(new Set([activeId])); else setSelected(new Set()); };
  const onRowContext = (tx, e) => {
    let targets = selIds.includes(tx.id) && selIds.length > 1 ? selIds.map((id) => byId.get(id)) : [tx];
    if (targets.length === 1) onRow(tx);
    openRowMenu(e, tx, targets, byId);
  };
  const onRowBakje = (tx, el) => {
    if (selIds.length > 1 && selIds.includes(tx.id)) {
      openBakjePopover(el, { sign: tx.amount_cents > 0 ? 'in' : 'out', onPick: (c) => bulkSetBakje(selIds, byId, c), title: plural(selIds.length, 'betaling', 'betalingen') });
      return;
    }
    const canAll = !!tx.merchant_key && !tx.merchant_key.startsWith('via:') && !tx.manual && tx.kind === 'normal';
    openBakjePopover(el, { value: tx.category_id, sign: tx.amount_cents > 0 ? 'in' : 'out', merchant: canAll ? tx.merchant_name : null,
      onPick: (c, scope) => setTxBakje(tx, c, scope || 'one') });
  };

  useEffect(() => {
    if (!wide || !page.active) return;
    const onKey = (e) => {
      if (e.defaultPrevented || hasOpenSheet() || document.querySelector('.menu') || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.activeElement?.closest?.('.tx-pane')) return; // the inspector has its own controls
      if (e.key === 'Escape' && selIds.length > 1) { e.preventDefault(); clearMulti(); return; }
      if (e.key === 'Escape' && activeTx && matchMedia('(max-width: 1099px)').matches) { e.preventDefault(); setActiveId(null); setSelected(new Set()); return; }
      if (e.key === 'Enter' && activeTx) {
        e.preventDefault();
        document.querySelector('.page:not([hidden]) .tx-pane button, .page:not([hidden]) .tx-pane textarea')?.focus();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const i = indexOf(activeId);
      const n = i < 0 ? 0 : e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      const tx = items[n];
      if (!tx) return;
      e.preventDefault();
      if (e.shiftKey && anchor.current != null) selectRow(tx, { shiftKey: true });
      else onRow(tx);
      requestAnimationFrame(() => document.querySelector(`.page:not([hidden]) .txt-row[data-id="${tx.id}"]`)?.scrollIntoView({ block: 'nearest' }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wide, page.active, items, activeId, selIds.join(',')]);

  const canSelect = boot.has_data && items.length > 0 && !wide;
  const trailing = selecting
    ? html`<${NavButton} text="Klaar" bold onClick=${endSelect} />`
    : html`<${NavButton} icon="plus" label="Toevoegen" onClick=${(e) => openAddMenu(e.currentTarget)} />`;
  const leading = selecting
    ? html`<${NavButton} text=${selected.size === items.length && items.length ? 'Geen' : 'Alles'}
        onClick=${() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((t) => t.id)))} />`
    : canSelect ? html`<${NavButton} text="Selecteer" onClick=${() => setSelecting(true)} />` : null;

  if (!boot.has_data) {
    return html`<${Screen} title="Transacties" trailing=${trailing} add=${[]} class="tx-screen">
      <div class="tx-empty-data"><${DropZone} onFiles=${(f) => openImport(f)} /></div>
    </${Screen}>`;
  }

  // Columns only when they carry information: Tags when a loaded row has tags, Rekening when
  // the rows come from more than one account. Winkel always gets the flexible width.
  const showAccount = wide && new Set(items.map((t) => t.account_id)).size > 1;
  const showTags = wide && items.some((t) => t.tag_ids?.length);
  const txtCols = ['minmax(200px, 1fr)', 'minmax(130px, 180px)', showTags && 'minmax(90px, 200px)', showAccount && 'minmax(96px, 150px)', '100px'].filter(Boolean).join(' ');
  const list = html`<div class="tx-main">
    <${Toolbar} qText=${qText} setQText=${setQText} filters=${filters} desk=${wide} showAccount=${showAccount} showTags=${showTags}
      summary=${data && (active || searching) && items.length > 0 && html`<${Summary} data=${data} filters=${filters} />`} />
    ${!wide && data && (active || searching) && items.length > 0 && html`<${Summary} data=${data} filters=${filters} />`}
    ${!data
      ? html`<${ListSkeleton} />`
      : data.error && !items.length
        ? html`<${EmptyState} emoji="📡" title="Niet geladen" subtitle=${data.error.message} action=${{ label: 'Opnieuw', variant: 'tinted', onClick: () => invalidate() }} />`
        : !items.length
          ? (active || searching
            ? html`<${EmptyState} emoji="🔍" title="Niets gevonden" action=${{ label: 'Wis filters', variant: 'tinted', onClick: clearAll }} />`
            : html`<${EmptyState} emoji="🧾" title="Nog geen betalingen" />`)
          : html`<div class=${'tx-list' + (stale ? ' is-stale' : '') + (selecting ? ' is-selecting' : '')}>
              <${DayList} items=${items} sort=${filters.sort} hasMore=${!!data.next} loadMore=${loadMore} active=${page.active}
                selecting=${selecting} selected=${selected} activeId=${wide && !selecting ? activeId : null} onRow=${onRow}
                table=${wide} showAccount=${showAccount} showTags=${showTags} onSelectRow=${selectRow} onRowContext=${onRowContext} onRowBakje=${onRowBakje} />
            </div>`}
  </div>`;

  return html`<${Screen} title="Transacties" trailing=${trailing} leading=${leading} wide=${wide} add=${wide ? [] : undefined}
      toolbar=${multi && html`<${BulkTools} ids=${selIds} byId=${byId} onClear=${clearMulti} />`}
      class=${'tx-screen' + (wide ? ' is-split' : '')}>
    ${wide
      ? html`<div class=${'tx-split' + (multi || activeTx ? ' has-selection' : '')} style=${{ '--txt-cols': txtCols }}>
          ${list}
          <aside class="tx-pane" aria-label=${multi ? 'Selectie' : 'Betaling'}>
            ${(multi || activeTx) && html`<button type="button" class="tx-pane-close navbtn" aria-label="Sluit detail" data-tip="Sluit (Esc)"
              onClick=${() => { setActiveId(null); setSelected(new Set()); }}><${Icon} name="xmark" size=${16} stroke=${2.4} /></button>`}
            ${multi
              ? html`<${MultiInspector} ids=${selIds} byId=${byId} onClear=${clearMulti} />`
              : activeTx
                ? html`<${TransactieDetail} key=${activeTx.id} id=${activeTx.id} tx=${activeTx} inline onDone=${() => { setActiveId(null); setSelected(new Set()); }} />`
                : html`<div class="tx-pane-empty"><${Icon} name="transacties" size=${40} stroke=${1.4} /><span>Kies een betaling</span><span class="tx-pane-hint">↑ ↓ om te bladeren · ⌘-klik voor meer</span></div>`}
          </aside>
        </div>`
      : list}
    ${selecting && html`<${BulkBar} ids=${[...selected]} items=${items} onDone=${endSelect} />`}
  </${Screen}>`;
}

/* ======================================================================================
   Toolbar: search + filter chips (sticky under the nav bar)
   ====================================================================================== */

function Toolbar({ qText, setQText, filters, desk = false, showAccount = false, showTags = false, summary = null }) {
  const ref = useRef(null);
  const sentinel = useRef(null);
  const [stuck, setStuck] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    const setH = () => el.closest('.screen')?.style.setProperty('--tx-bar-h', el.offsetHeight + 'px');
    setH();
    const ro = new ResizeObserver(setH);
    ro.observe(el);
    const nav = el.closest('.screen').querySelector('.navbar');
    const io = new IntersectionObserver(([e]) => {
      if (e.boundingClientRect.width === 0) return;
      setStuck(!e.isIntersecting && e.boundingClientRect.top < 200);
    }, { rootMargin: `-${(nav?.offsetHeight || 44) + 1}px 0px 0px 0px` });
    io.observe(sentinel.current);
    return () => { ro.disconnect(); io.disconnect(); };
  }, []);
  return html`
    <div ref=${sentinel} class="tx-bar-sentinel" aria-hidden="true"></div>
    <div ref=${ref} class=${'tx-bar' + (stuck ? ' is-stuck' : '') + (desk ? ' is-desk' : '')}>
      ${desk
        ? html`<div class="tx-filterbar"><${FilterChips} filters=${filters} desk />${summary}</div>
          <div class="txt-head" role="row">
            <${SortHead} label="Winkel" by="merchant" sort=${filters.sort} /><${SortHead} label="Bakje" by="category" sort=${filters.sort} />${showTags && html`<span role="columnheader">Tags</span>`}
            ${showAccount && html`<${SortHead} label="Rekening" by="account" sort=${filters.sort} />`}<${SortHead} label="Bedrag" by="amount" sort=${filters.sort} num />
          </div>`
        : html`<${SearchField} value=${qText} onInput=${setQText} placeholder="Zoek winkel, bedrag of tag" />
          <${FilterChips} filters=${filters} />`}
    </div>`;
}

/** A column header that sorts: first click in its natural order, again to reverse, a third
 *  time back to newest first. */
function SortHead({ label, by, sort, num = false }) {
  const cur = (sort || '').replace(/^-/, '');
  const on = cur === by;
  const desc = on && sort.startsWith('-');
  const next = !on ? by : !desc ? '-' + by : undefined;
  return html`<button role="columnheader" class=${'txt-sort' + (num ? ' is-num' : '') + (on ? ' is-on' : '')}
      aria-sort=${on ? (desc ? 'descending' : 'ascending') : 'none'} onClick=${() => replaceQuery({ sort: next })}
      aria-label=${`Sorteer op ${label.toLowerCase()}`}>
    <span>${label}</span>${on && html`<${Icon} name=${desc ? 'chevron-down' : 'chevron-up'} size=${11} stroke=${2.6} />`}
  </button>`;
}

function amountLabel(f) {
  const parts = [f.sign === 'out' ? 'Uitgaven' : f.sign === 'in' ? 'Inkomsten' : null, Number(f.min) > 0 ? `vanaf ${money(Number(f.min), { whole: true })}` : null].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

function FilterChips({ filters: f, desk = false }) {
  const boot = useStore((s) => s.boot);
  const set = (patch) => replaceQuery(patch);
  const cat = f.category_id ? categoryById(Number(f.category_id)) : null;
  const tag = f.tag_id ? tagById(Number(f.tag_id)) : null;
  const acc = f.account_id ? accountById(Number(f.account_id)) : null;
  const accounts = boot.accounts.filter((a) => !a.hidden);

  const chip = (label, value, onOpen, onClear, extra = {}) => html`<span class=${'tx-chip' + (value ? ' is-set' : '')} style=${extra.color ? { '--c': colorVar(extra.color) } : null}>
    <button class="tx-chip-main" onClick=${onOpen} aria-haspopup="true" aria-label=${value ? `${label}: ${value}` : `Filter op ${label.toLowerCase()}`}>
      ${extra.emoji && html`<span aria-hidden="true">${extra.emoji}</span>`}
      <span class="tx-chip-text">${value || label}</span>
      ${!value && html`<${Icon} name="chevron-down" size=${12} stroke=${2.6} />`}
    </button>
    ${value && html`<button class="tx-chip-x" onClick=${onClear} aria-label=${`${label}-filter weg`}><${Icon} name="xmark" size=${11} stroke=${2.8} /></button>`}
  </span>`;

  const merchantName = f.merchant_key ? (listMerchantName(f.merchant_key) || 'Winkel') : null;
  return html`<div class="tx-chips" role="toolbar" aria-label="Filters">
    ${f.flow && chip('Soort', f.flow === 'in' ? 'Inkomsten' : 'Uitgaven', () => set({ flow: f.flow === 'in' ? 'out' : 'in' }), () => set({ flow: undefined }))}
    ${f.merchant_key && chip('Winkel', merchantName, () => {}, () => set({ merchant_key: undefined }))}
    ${f.unsorted && chip('Bakje', 'Zonder bakje', () => set({ unsorted: undefined }), () => set({ unsorted: undefined }), { emoji: '❔' })}
    ${!f.unsorted && chip('Bakje', cat?.name, (e) => (desk
      ? openBakjePopover(e.currentTarget, { value: cat?.id, onPick: (c) => set({ category_id: c.id, unsorted: undefined }), onUnsorted: () => set({ unsorted: '1', category_id: undefined }) })
      : openSheet(PickBakjeSheet, { value: cat?.id, onPick: (c) => set({ category_id: c.id, unsorted: undefined }), onUnsorted: () => set({ unsorted: '1', category_id: undefined }) })),
      () => set({ category_id: undefined }), { emoji: cat?.emoji, color: cat?.color })}
    ${chip('Periode', f.period ? monthSmart(f.period) : null, (e) => openPeriodMenu(e.currentTarget, f.period, (p) => set({ period: p || undefined })), () => set({ period: undefined }))}
    ${chip('Tag', tag?.name, (e) => (desk
      ? openTagPopover(e.currentTarget, { value: tag?.id, onPick: (t) => set({ tag_id: t.id }) })
      : openSheet(PickTagSheet, { value: tag?.id, onPick: (t) => set({ tag_id: t.id }) })), () => set({ tag_id: undefined }), { emoji: tag?.emoji, color: tag?.color })}
    ${!f.flow && chip('Bedrag', amountLabel(f), (e) => openMenu(e.currentTarget, [
      { label: 'Uitgaven en inkomsten', checked: !f.sign, onSelect: () => set({ sign: undefined }) },
      { label: 'Alleen uitgaven', checked: f.sign === 'out', onSelect: () => set({ sign: 'out' }) },
      { label: 'Alleen inkomsten', checked: f.sign === 'in', onSelect: () => set({ sign: 'in' }) },
      '-',
      { label: 'Elk bedrag', checked: !(Number(f.min) > 0), onSelect: () => set({ min: undefined }) },
      ...MIN_STEPS.map((c) => ({ label: `Vanaf ${money(c, { whole: true })}`, checked: Number(f.min) === c, onSelect: () => set({ min: c }) })),
    ]), () => set({ sign: undefined, min: undefined }))}
    ${(!desk || f.sort) && chip('Sorteer', f.sort ? sortLabel(f.sort) : null, (e) => openMenu(e.currentTarget,
      TX_SORTS.map((s) => ({ label: s.label, checked: (f.sort || '') === s.v, onSelect: () => set({ sort: s.v || undefined }) }))), () => set({ sort: undefined }))}
    ${accounts.length > 1 && chip('Rekening', acc?.name, (e) => openMenu(e.currentTarget, [
      ...accounts.map((a) => ({ label: a.name, checked: a.id === acc?.id, onSelect: () => set({ account_id: a.id }) })),
      '-', { label: 'Alle rekeningen', checked: !acc, onSelect: () => set({ account_id: undefined }) },
    ]), () => set({ account_id: undefined }))}
  </div>`;
}

function listMerchantName(key) {
  for (const s of listCache.values()) {
    const t = s.items.find((x) => x.merchant_key === key);
    if (t) return t.merchant_name;
  }
  return null;
}

function openPeriodMenu(anchor, value, onPick) {
  const { first, last } = getState().boot.periods;
  openMenu(anchor, {
    width: 300,
    render: (close) => {
      const years = [];
      for (let y = Number(last.slice(0, 4)); y >= Number(first.slice(0, 4)); y--) years.push(y);
      return html`<div class="month-grid tx-period">
        <button class=${'tx-period-all' + (!value ? ' is-selected' : '')} onClick=${() => { close(); onPick(null); }}>Alle maanden</button>
        ${years.map((y) => html`<div class="mg-year" key=${y}>
          <div class="mg-year-label">${y}</div>
          <div class="mg-months">
            ${MONTHS_SHORT.map((m, i) => {
              const id = `${y}-${String(i + 1).padStart(2, '0')}`;
              return html`<button class=${'mg-month' + (id === value ? ' is-selected' : '')} disabled=${id < first || id > last}
                aria-label=${monthLabel(id)} onClick=${() => { close(); onPick(id); }}>${m}</button>`;
            })}
          </div>
        </div>`)}
      </div>`;
    },
  });
}

/* ---------- Summary line for filtered views ---------- */

function Summary({ data, filters }) {
  if (filters.flow) {
    const cents = filters.flow === 'in' ? data.sumIn + data.sumOut : -(data.sumIn + data.sumOut);
    return html`<div class="tx-sum is-flow">
      <span class="tx-sum-label">${filters.flow === 'in' ? 'Inkomen' : 'Dagelijks'} · ${monthSmart(filters.period || getState().boot.periods.current)}</span>
      <span class=${'tx-sum-big rounded num' + (filters.flow === 'in' ? ' is-income' : '')}>${money(cents, { whole: true, signed: filters.flow === 'in' })}</span>
      <span class="tx-sum-sub">${plural(data.count, 'betaling', 'betalingen')}</span>
    </div>`;
  }
  return html`<div class="tx-sum">
    <span class="tx-sum-count">${plural(data.count, 'betaling', 'betalingen')}</span>
    <span class="tx-sum-vals num">
      ${data.sumOut < 0 && html`<span>${money(data.sumOut)} uit</span>`}
      ${data.sumIn > 0 && html`<span class="is-income">${money(data.sumIn, { signed: true })} in</span>`}
    </span>
  </div>`;
}

/* ======================================================================================
   Windowed, day-grouped list
   ====================================================================================== */

const OVERSCAN = 1400;

const CHUNK = 40;

/** Day groups when sorted by date; otherwise chunks in the chosen order (the first one titled
 *  with that order), and every row shows its date. */
function groupByDay(items, sort) {
  if (sort && sort !== 'date') {
    const out = [];
    for (let i = 0; i < items.length; i += CHUNK) {
      const part = items.slice(i, i + CHUNK);
      out.push({ key: 's' + i, label: i === 0 ? sortLabel(sort) : null, items: part,
        out: part.reduce((s, t) => s + Math.min(0, t.amount_cents), 0), in: part.reduce((s, t) => s + Math.max(0, t.amount_cents), 0) });
    }
    return out;
  }
  const groups = [];
  let g = null;
  for (const t of items) {
    if (!g || g.date !== t.date) { g = { key: t.date, date: t.date, items: [], out: 0, in: 0 }; groups.push(g); }
    g.items.push(t);
    if (t.amount_cents < 0) g.out += t.amount_cents; else g.in += t.amount_cents;
  }
  return groups;
}

function DayList({ items, hasMore, loadMore, active, selecting, selected, activeId, onRow, table = false, showAccount = false, showTags = false, onSelectRow, onRowContext, onRowBakje, sort = '' }) {
  const groups = useMemo(() => groupByDay(items, sort), [items, sort]);
  const dated = !!sort && sort !== 'date';
  const root = useRef(null);
  const sizes = useRef(new Map());       // `${date}:${n}` -> measured height
  const metrics = useRef({ head: 40, row: 62.5, gap: 20 });
  const [range, setRange] = useState([0, 14]);
  const [, bump] = useState(0);
  const today = todayISO();

  const heightOf = (g) => sizes.current.get(g.key + ':' + g.items.length)
    ?? metrics.current.head + g.items.length * metrics.current.row + metrics.current.gap;
  const offsets = [0];
  for (const g of groups) offsets.push(offsets[offsets.length - 1] + heightOf(g));
  const total = offsets[offsets.length - 1];

  const update = () => {
    const el = root.current;
    if (!el || !active) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    const start = -r.top - OVERSCAN;
    const end = -r.top + window.innerHeight + OVERSCAN;
    let a = 0;
    while (a < groups.length - 1 && offsets[a + 1] < start) a++;
    let b = a;
    while (b < groups.length - 1 && offsets[b + 1] < end) b++;
    setRange((cur) => (cur[0] === a && cur[1] === b ? cur : [a, b]));
    if (hasMore && end > total - 600) loadMore();
  };
  const upd = useRef(update);
  upd.current = update;

  useEffect(() => {
    // rAF for smoothness, a timer as a fallback when frames are throttled.
    let raf = 0;
    let timer = 0;
    const run = () => { cancelAnimationFrame(raf); clearTimeout(timer); raf = 0; timer = 0; upd.current(); };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(run);
      if (!timer) timer = setTimeout(run, 100);
    };
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => { window.removeEventListener('scroll', on); window.removeEventListener('resize', on); cancelAnimationFrame(raf); clearTimeout(timer); };
  }, []);
  useEffect(() => { update(); }, [groups, active, hasMore]);

  // Measure rendered groups so spacers are exact (rows are equal height, so one sample is enough).
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    let changed = false;
    for (const node of el.querySelectorAll(':scope > .tx-day')) {
      const g = groups[Number(node.dataset.i)];
      if (!g) continue;
      const h = node.offsetHeight;
      if (!h) continue;
      const k = g.key + ':' + g.items.length;
      if (sizes.current.get(k) !== h) { sizes.current.set(k, h); changed = true; }
      const head = node.firstElementChild?.offsetHeight;
      const row = node.querySelector('.row-li, .txt-row')?.offsetHeight;
      if (head && row) {
        const m = metrics.current;
        m.head = head; m.row = row; m.gap = Math.max(0, h - head - row * g.items.length);
      }
    }
    if (changed) bump((n) => n + 1);
  });

  const [a, b] = [Math.min(range[0], groups.length - 1), Math.min(range[1], groups.length - 1)];
  const shown = groups.slice(Math.max(0, a), b + 1);
  return html`<div class=${'tx-days' + (table ? ' is-table' : '')} ref=${root} role=${table ? 'grid' : null} aria-multiselectable=${table ? 'true' : null} style=${{ paddingTop: offsets[Math.max(0, a)] + 'px', paddingBottom: (total - offsets[b + 1]) + 'px' }}>
    ${shown.map((g, j) => html`<section class="tx-day" key=${g.key} data-i=${a + j} aria-label=${g.date ? dayLabel(g.date, { today, long: true }) : (g.label || 'Vervolg')}>
      ${g.date ? html`<h3 class="tx-day-h">
        <span class="tx-day-label">${dayLabel(g.date, { today })}</span>
        <span class=${'tx-day-total num' + (g.out === 0 && g.in > 0 ? ' is-income' : '')}>${g.out < 0 ? `${money(g.out)} uit` : `${money(g.in, { signed: true })} in`}</span>
      </h3>` : g.label && html`<h3 class="tx-day-h"><span class="tx-day-label">${g.label}</span></h3>`}
      ${table
        ? html`<div class="txt-group" role="rowgroup">
            ${g.items.map((t) => html`<${TxTableRow} key=${t.id} tx=${t} date=${dated} selected=${selected.has(t.id)} active=${t.id === activeId}
              showAccount=${showAccount} showTags=${showTags} onSelect=${onSelectRow} onContext=${onRowContext} onBakje=${onRowBakje} />`)}
          </div>`
        : html`<ul class="inset">
            ${g.items.map((t) => html`<${TxKeyed} key=${t.id} tx=${t} date=${dated} onRow=${onRow} selectable=${selecting}
              selected=${selecting ? selected.has(t.id) : t.id === activeId} />`)}
          </ul>`}
    </section>`)}
    ${hasMore && b >= groups.length - 1 && html`<div class="tx-more" aria-hidden="true"><span class="tx-more-dot"></span><span class="tx-more-dot"></span><span class="tx-more-dot"></span></div>`}
  </div>`;
}

function TxKeyed({ tx, onRow, selectable, selected, date = false }) {
  return html`<${TxRow} tx=${tx} date=${date} onClick=${() => onRow(tx)} selectable=${selectable} selected=${selected} />`;
}

function ListSkeleton() {
  return html`<div class="tx-days" aria-busy="true" aria-label="Laden">
    ${[5, 3, 4].map((n, i) => html`<section class="tx-day" key=${i}>
      <h3 class="tx-day-h"><${Skeleton} w=${90} h=${15} /><${Skeleton} w=${60} h=${15} /></h3>
      <div class="inset">${Array.from({ length: n }, (_, j) => html`<div class="row has-lead is-two is-tx" key=${j}>
        <span class="row-lead"><${Skeleton} w=${38} h=${38} r=${11} /></span>
        <span class="row-main"><${Skeleton} w="48%" h=${15} /><${Skeleton} w="30%" h=${13} style=${{ marginTop: '6px' }} /></span>
        <${Skeleton} w=${56} h=${15} />
      </div>`)}</div>
    </section>`)}
  </div>`;
}

/* ======================================================================================
   Pickers (sheets) for the Bakje and Tag filters
   ====================================================================================== */

const GROUPS = [['daily', 'Dagelijks'], ['fixed', 'Vaste lasten'], ['income', 'Inkomen'], ['saving', 'Sparen'], ['internal', 'Intern']];

export function PickBakjeSheet({ value, onPick, onUnsorted, close, title = 'Bakje' }) {
  const cats = (useStore((s) => s.boot).categories || []).filter((c) => !c.hidden && c.key !== 'unsorted');
  const pick = (c) => { close(); onPick(c); };
  return html`<${Sheet} title=${title} detents=${['medium', 'large']}>
    <div class="sheet-pad">
      ${onUnsorted && html`<ul class="inset tx-pick-top"><li class="row-li"><button class="row has-lead is-button" onClick=${() => { close(); onUnsorted(); }}>
        <span class="row-lead"><${EmojiTile} dashed size=${30} /></span><span class="row-main"><span class="row-title">Zonder bakje</span></span>
      </button></li></ul>`}
      ${GROUPS.map(([grp, label]) => {
        const list = cats.filter((c) => c.grp === grp);
        if (!list.length) return null;
        return html`<section class="list-group" key=${grp}>
          <h3 class="list-header">${label}</h3>
          <ul class="inset">${list.map((c) => html`<li class="row-li" key=${c.id}>
            <button class="row has-lead is-button" onClick=${() => pick(c)} aria-pressed=${c.id === value ? 'true' : 'false'}>
              <span class="row-lead"><${EmojiTile} emoji=${c.emoji} color=${c.color} size=${30} /></span>
              <span class="row-main"><span class="row-title">${c.name}</span></span>
              ${c.id === value && html`<span class="row-check c-tint"><${Icon} name="check" size=${18} stroke=${2.4} /></span>`}
            </button>
          </li>`)}</ul>
        </section>`;
      })}
    </div>
  </${Sheet}>`;
}

export function PickTagSheet({ value, onPick, close, title = 'Tag', allowCreate = false }) {
  useStore((s) => s.boot);
  const [q, setQ] = useState('');
  const tags = allTags().filter((t) => !q || t.name.toLowerCase().includes(q.trim().toLowerCase()));
  const pick = (t) => { close(); onPick(t); };
  const create = async () => {
    try { pick(await createTag(q)); } catch (err) { toast({ text: err.message, icon: 'warning' }); }
  };
  const exact = allTags().some((t) => t.name.toLowerCase() === q.trim().toLowerCase());
  return html`<${Sheet} title=${title} detents=${['medium', 'large']}>
    <div class="sheet-pad">
      <div class="tx-pick-search"><${SearchField} value=${q} onInput=${setQ} placeholder=${allowCreate ? 'Zoek of maak een tag' : 'Zoek tag'} /></div>
      ${tags.length > 0 && html`<ul class="inset">${tags.map((t) => html`<li class="row-li" key=${t.id}>
        <button class="row has-lead is-button" onClick=${() => pick(t)} aria-pressed=${t.id === value ? 'true' : 'false'}>
          <span class="row-lead"><${EmojiTile} emoji=${t.emoji || '🏷️'} color=${t.color} size=${30} /></span>
          <span class="row-main"><span class="row-title">${t.name}</span></span>
          ${t.id === value && html`<span class="row-check c-tint"><${Icon} name="check" size=${18} stroke=${2.4} /></span>`}
        </button>
      </li>`)}</ul>`}
      ${allowCreate && q.trim() && !exact && html`<ul class="inset tx-pick-create"><li class="row-li"><button class="row has-lead is-button" onClick=${create}>
        <span class="row-lead"><span class="row-icon" style=${{ '--c': 'var(--tint)' }}><${Icon} name="plus" size=${18} stroke=${2.2} /></span></span>
        <span class="row-main"><span class="row-title c-tint">Maak „${q.trim()}”</span></span>
      </button></li></ul>`}
      ${!tags.length && !(allowCreate && q.trim()) && html`<p class="quiet">${q ? 'Geen tag gevonden' : 'Nog geen tags'}</p>`}
    </div>
  </${Sheet}>`;
}

/* ======================================================================================
   Bulk actions
   ====================================================================================== */

function BulkBar({ ids, items, onDone }) {
  const n = ids.length;
  const none = n === 0;
  const byId = new Map(items.map((t) => [t.id, t]));

  const setBakje = () => openSheet(BulkBakjeSheet, {
    count: n,
    onPick: (c) => { onDone(); bulkSetBakje(ids, byId, c); },
  });

  const addTag = () => openSheet(PickTagSheet, {
    title: 'Tag toevoegen',
    allowCreate: true,
    onPick: (tag) => { onDone(); bulkAddTag(ids, byId, tag); },
  });

  return html`<div class="tx-bulk" role="toolbar" aria-label="Acties voor selectie">
    <span class="tx-bulk-count" aria-live="polite">${none ? 'Kies betalingen' : plural(n, 'gekozen', 'gekozen')}</span>
    <${Button} variant="tinted" size="medium" icon="bakjes" disabled=${none} onClick=${setBakje}>Bakje</${Button}>
    <${Button} variant="tinted" size="medium" icon="tag" disabled=${none} onClick=${addTag}>Tag</${Button}>
  </div>`;
}

function BulkBakjeSheet({ count, onPick, close }) {
  return html`<${Sheet} title=${plural(count, 'betaling', 'betalingen')} detents=${['medium', 'large']}
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`} trailing=${null}>
    <div class="sheet-pad">
      <div class="td-card"><${BakjeGrid} onPick=${(c) => { close(); onPick(c); }} withInternal=${false} /></div>
    </div>
  </${Sheet}>`;
}

