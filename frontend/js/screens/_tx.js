// Shared pieces of the Transacties family (list, transaction sheet, Uitgave toevoegen,
// Sorteren, bulk actions, tags): bakje ordering and tile grid, tag editor, tag creation,
// labels, and a tiny change channel so lists update optimistically before the refetch.

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { getState, tagById, categoryById, invalidate } from '../store.js';
import { COLOR_NAMES, colorVar } from '../colors.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { Icon } from '../icons.js';
import { toast } from '../components/Toast.js';

/* ---------- Labels ---------- */

export const METHOD_LABEL = {
  card: 'Pinpas', ideal: 'iDEAL', debit: 'Incasso', transfer: 'Overboeking', atm: 'Geldautomaat',
  internal: 'Eigen rekening', fee: 'Kosten', interest: 'Rente', other: 'Overig',
};

export const ACCOUNT_TYPE_LABEL = {
  checking: 'Betaalrekening', savings: 'Spaarrekening', credit: 'Creditcard', investment: 'Beleggingen',
};

/** "NL•• 1234" */
export function maskIban(iban) {
  if (!iban) return '';
  const clean = iban.replace(/\s+/g, '');
  return `${clean.slice(0, 2)}•• ${clean.slice(-4)}`;
}

/* ---------- Bakjes ---------- */

const GROUP_ORDER = {
  out: ['daily', 'fixed', 'saving', 'income', 'internal'],
  in: ['income', 'daily', 'fixed', 'saving', 'internal'],
};

/**
 * Visible bakjes in a sensible order for money going `sign` ('out' | 'in').
 * `unsorted` is never offered; `internal` only when `withInternal`.
 */
export function orderedCategories(sign = 'out', { withInternal = false, first = [] } = {}) {
  const cats = (getState().boot?.categories || []).filter((c) => !c.hidden && c.key !== 'unsorted' && (withInternal || c.grp !== 'internal'));
  // One stable order for money in and out, so a tile never moves between payments.
  const order = GROUP_ORDER.out;
  const rank = (c) => {
    const i = first.indexOf(c.id);
    if (i >= 0) return i - 100;
    return order.indexOf(c.grp) * 1000 + (c.sort ?? c.id);
  };
  return [...cats].sort((a, b) => rank(a) - rank(b));
}

export const isUnsorted = (catId) => {
  const c = categoryById(catId);
  return !c || c.key === 'unsorted';
};

/** Grid of emoji tiles. value = selected category id. */
export function BakjeGrid({ value, onPick, sign = 'out', withInternal, first, exclude = [], hints = false, size = 44, label = 'Bakje', tileRef }) {
  const cats = orderedCategories(sign, { withInternal: withInternal ?? isInternal(value), first }).filter((c) => !exclude.includes(c.id));
  return html`<div class="bk-grid" role="radiogroup" aria-label=${label}>
    ${cats.map((c, i) => html`<button key=${c.id} type="button" role="radio" aria-checked=${c.id === value ? 'true' : 'false'}
        class=${'bk-tile' + (c.id === value ? ' is-selected' : '')} style=${{ '--c': colorVar(c.color) }}
        data-cat=${c.id} ref=${tileRef ? (el) => tileRef(c.id, el) : null} onClick=${(e) => onPick(c, e.currentTarget)}>
      <${EmojiTile} emoji=${c.emoji} color=${c.color} size=${size} />
      <span class="bk-name">${c.name}</span>
      ${hints && i < 8 && html`<kbd class="bk-key" aria-hidden="true">${i + 2}</kbd>`}
    </button>`)}
  </div>`;
}

function isInternal(id) {
  return categoryById(id)?.grp === 'internal';
}

/* ---------- Tags ---------- */

const createdTags = new Map(); // tags created in this session, until bootstrap catches up

export function tagLookup(id) {
  return tagById(id) || createdTags.get(id) || null;
}

export function allTags() {
  const boot = getState().boot?.tags || [];
  const ids = new Set(boot.map((t) => t.id));
  return [...boot, ...[...createdTags.values()].filter((t) => !ids.has(t.id))].filter((t) => !t.archived);
}

/** "🇮🇹 Vakantie Italië" -> { emoji: '🇮🇹', name: 'Vakantie Italië' } */
export function splitEmoji(text) {
  const s = (text || '').trim();
  if (!s) return { emoji: null, name: '' };
  let first = '';
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    for (const { segment } of new Intl.Segmenter('nl', { granularity: 'grapheme' }).segment(s)) { first = segment; break; }
  } else first = Array.from(s)[0];
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(first)) {
    return { emoji: first, name: s.slice(first.length).trim() };
  }
  return { emoji: null, name: s };
}

export function nextTagColor() {
  const palette = COLOR_NAMES.filter((c) => c !== 'gray');
  return palette[allTags().length % palette.length];
}

export async function createTag(text, extra = {}) {
  const { emoji, name } = splitEmoji(text);
  if (!name) throw new Error('Geef de tag een naam.');
  const tag = await api.createTag({ name, emoji: emoji || extra.emoji || '🏷️', color: extra.color || nextTagColor() });
  createdTags.set(tag.id, tag);
  invalidate();
  return tag;
}

/** Selected tags as chips + an inline add field with autocomplete and create-on-the-fly. */
export function TagEditor({ tagIds = [], onChange, label = 'Tags' }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  useEffect(() => { if (adding) input.current?.focus(); }, [adding]);

  const chosen = tagIds.map(tagLookup).filter(Boolean);
  const q = splitEmoji(text).name.toLowerCase();
  const pool = allTags().filter((t) => !tagIds.includes(t.id));
  const matches = (q ? pool.filter((t) => t.name.toLowerCase().includes(q)) : pool).slice(0, 8);
  const exact = pool.find((t) => t.name.toLowerCase() === q) || chosen.find((t) => t.name.toLowerCase() === q);

  const add = (tag) => { onChange([...tagIds, tag.id], tag); setText(''); input.current?.focus(); };
  const commit = async () => {
    if (!q) { setAdding(false); return; }
    if (exact) { if (!tagIds.includes(exact.id)) add(exact); else setText(''); return; }
    setBusy(true);
    try { add(await createTag(text)); } catch (err) { toast({ text: err.message, icon: 'warning' }); }
    setBusy(false);
  };
  const close = () => { setAdding(false); setText(''); };

  return html`<div class="tg-editor">
    <div class="tg-chips" role="list" aria-label=${label}>
      ${chosen.map((t) => html`<button key=${t.id} role="listitem" class="tg-chip" style=${{ '--c': colorVar(t.color) }}
          aria-label=${`Haal tag ${t.name} weg`} onClick=${() => onChange(tagIds.filter((x) => x !== t.id), null)}>
        ${t.emoji && html`<span aria-hidden="true">${t.emoji}</span>`}<span class="tg-chip-name">${t.name}</span>
        <${Icon} name="xmark" size=${11} stroke=${2.6} />
      </button>`)}
      ${!adding && html`<button class="tg-add" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${15} stroke=${2.4} /><span>Tag</span></button>`}
    </div>
    ${adding && html`<div class="tg-field">
      <span class="tg-field-icon"><${Icon} name="tag" size=${18} stroke=${1.9} /></span>
      <input ref=${input} class="tg-input" type="text" value=${text} placeholder="Nieuwe of bestaande tag" aria-label="Tag zoeken of maken"
        enterkeyhint="done" autocomplete="off" autocapitalize="sentences" maxLength="60" disabled=${busy}
        onInput=${(e) => setText(e.currentTarget.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
        onBlur=${() => setTimeout(() => { if (!input.current || document.activeElement !== input.current) { if (!text) close(); } }, 150)} />
      <button class="tg-done" onPointerDown=${(e) => e.preventDefault()} onClick=${q ? commit : close}>${q ? (exact ? 'Voeg toe' : 'Maak') : 'Klaar'}</button>
    </div>
    ${(matches.length > 0 || (q && !exact)) && html`<div class="tg-suggest" role="listbox" aria-label="Tags">
      ${matches.map((t) => html`<button key=${t.id} role="option" aria-selected="false" class="tg-chip is-suggest" style=${{ '--c': colorVar(t.color) }}
          onPointerDown=${(e) => e.preventDefault()} onClick=${() => add(t)}>
        ${t.emoji && html`<span aria-hidden="true">${t.emoji}</span>`}<span class="tg-chip-name">${t.name}</span>
      </button>`)}
      ${q && !exact && html`<button role="option" aria-selected="false" class="tg-chip is-create" onPointerDown=${(e) => e.preventDefault()} onClick=${commit}>
        <${Icon} name="plus" size=${13} stroke=${2.6} /><span class="tg-chip-name">Maak „${text.trim()}”</span>
      </button>`}
    </div>`}`}
  </div>`;
}

/* ---------- Change channel ---------- */
// Lists subscribe so an edit shows immediately, before invalidate()'s refetch lands.
// change = { ids?: number[], merchant_key?: string, set: { category_id?, tag_ids?, note?, goal_id? }, removed?: true }

const txListeners = new Set();
export function emitTxChange(change) { txListeners.forEach((fn) => fn(change)); }
export function onTxChange(fn) { txListeners.add(fn); return () => txListeners.delete(fn); }

/** Apply a change to a list of transactions (returns a new array, or the same when untouched). */
export function applyTxChange(items, change) {
  let touched = false;
  const ids = change.ids ? new Set(change.ids) : null;
  const out = [];
  for (const t of items) {
    const hit = (ids && ids.has(t.id)) || (change.merchant_key && t.merchant_key === change.merchant_key && t.category_source !== 'user' && t.kind === 'normal');
    if (!hit) { out.push(t); continue; }
    touched = true;
    if (change.removed) continue;
    const set = typeof change.set === 'function' ? change.set(t) : change.set;
    out.push({ ...t, ...set });
  }
  return touched ? out : items;
}
