// Transacties on the Mac (DESIGN §5): the worksheet row, pop-up pickers (bakje, tag) as
// popovers, the right-click menu, bulk actions and the multi-selection inspector.
// Shared with the phone list where it makes sense (bulk actions are used by both).

import { html, useMemo, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { categoryById, tagById, accountById, invalidate } from '../store.js';
import { replaceQuery } from '../router.js';
import { money, plural, shortDate } from '../format.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { Switch } from '../components/Controls.js';
import { openPopover, openContextMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { Icon } from '../icons.js';
import { colorVar } from '../colors.js';
import { orderedCategories, allTags, createTag, emitTxChange, isUnsorted } from './_tx.js';
import { copyText } from './_kit.js';

/* ======================================================================================
   Mutations (optimistic, with undo)
   ====================================================================================== */

/** One payment to a bakje; scope 'merchant' (default, like the sheet) or 'one'. */
export async function setTxBakje(tx, cat, scope = 'merchant') {
  const canAll = !!tx.merchant_key && !tx.merchant_key.startsWith('via:') && !tx.manual && tx.kind === 'normal';
  const mode = canAll ? scope : 'one';
  const prev = tx.category_id;
  if (cat.id === prev && mode === 'one') return;
  const emit = (catId) => (mode === 'merchant'
    ? emitTxChange({ ids: [tx.id], merchant_key: tx.merchant_key, set: { category_id: catId } })
    : emitTxChange({ ids: [tx.id], set: { category_id: catId, category_source: 'user' } }));
  const body = (catId) => ({ category_id: catId, apply_scope: mode, apply_to_merchant: mode === 'merchant' });
  emit(cat.id);
  try {
    const res = await api.updateTransaction(tx.id, body(cat.id));
    const n = res?.updated_count || 1;
    invalidate();
    toast({
      emoji: cat.emoji,
      text: n > 1 ? `${plural(n, 'betaling', 'betalingen')} naar ${cat.name}` : `Naar ${cat.name}`,
      action: {
        label: 'Herstel',
        onClick: async () => {
          emit(prev);
          try { await api.updateTransaction(tx.id, body(prev)); } catch (err) { toast({ text: err.message, icon: 'warning' }); }
          invalidate();
        },
      },
    });
  } catch (err) {
    emit(prev);
    toast({ text: err.message, icon: 'warning' });
  }
}

/** Several payments to one bakje (bulk endpoint); undo restores each previous bakje. */
export async function bulkSetBakje(ids, byId, cat) {
  const prev = new Map();
  for (const id of ids) { const t = byId.get(id); if (t) prev.set(id, t.category_id); }
  emitTxChange({ ids, set: { category_id: cat.id, category_source: 'user' } });
  try {
    const res = await api.bulkUpdate({ ids, category_id: cat.id });
    invalidate();
    toast({
      emoji: cat.emoji,
      text: `${plural(res?.updated_count ?? ids.length, 'betaling', 'betalingen')} naar ${cat.name}`,
      action: {
        label: 'Herstel',
        onClick: async () => {
          const groups = new Map();
          for (const [id, c] of prev) { if (!groups.has(c)) groups.set(c, []); groups.get(c).push(id); }
          for (const [c, list] of groups) emitTxChange({ ids: list, set: { category_id: c } });
          try { for (const [c, list] of groups) await api.bulkUpdate({ ids: list, category_id: c }); } catch (err) { toast({ text: err.message, icon: 'warning' }); }
          invalidate();
        },
      },
    });
  } catch (err) { toast({ text: err.message, icon: 'warning' }); invalidate(); }
}

/** Add one tag to several payments; undo removes it again from those that did not have it. */
export async function bulkAddTag(ids, byId, tag) {
  const without = ids.filter((id) => !(byId.get(id)?.tag_ids || []).includes(tag.id));
  emitTxChange({ ids: without, set: (t) => ({ tag_ids: [...(t.tag_ids || []), tag.id] }) });
  try {
    await api.bulkUpdate({ ids, add_tag_ids: [tag.id] });
    invalidate();
    toast({
      emoji: tag.emoji || '🏷️',
      text: `${plural(ids.length, 'betaling', 'betalingen')} getagd met ${tag.name}`,
      action: without.length ? {
        label: 'Herstel',
        onClick: async () => {
          emitTxChange({ ids: without, set: (t) => ({ tag_ids: (t.tag_ids || []).filter((x) => x !== tag.id) }) });
          try { await api.bulkUpdate({ ids: without, remove_tag_ids: [tag.id] }); } catch (err) { toast({ text: err.message, icon: 'warning' }); }
          invalidate();
        },
      } : null,
    });
  } catch (err) { toast({ text: err.message, icon: 'warning' }); invalidate(); }
}

/* ======================================================================================
   Pop-up pickers
   ====================================================================================== */

const GROUP_LABEL = { daily: 'Dagelijks', fixed: 'Vaste lasten', income: 'Inkomen', saving: 'Sparen', internal: 'Intern' };

function useFilter(list, q, key = (x) => x.name) {
  const n = q.trim().toLowerCase();
  return n ? list.filter((x) => key(x).toLowerCase().includes(n)) : list;
}

function PopSearch({ value, onInput, placeholder, onEnter }) {
  return html`<div class="pop-search search"><label class="search-box">
    <${Icon} name="search" size=${14} stroke=${2.2} />
    <input type="search" value=${value} placeholder=${placeholder} autocomplete="off" spellcheck=${false} autofocus
      aria-label=${placeholder} onInput=${(e) => onInput(e.currentTarget.value)}
      onKeyDown=${(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onEnter?.(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.closest('.menu')?.querySelector('.pop-row')?.focus(); }
      }} />
  </label></div>`;
}

/** Arrow keys between rows of a picker. */
function onListKey(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...e.currentTarget.querySelectorAll('.pop-row')];
  const i = rows.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  if (e.key === 'ArrowUp' && i === 0) { e.currentTarget.closest('.menu')?.querySelector('input')?.focus(); return; }
  rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
}

/**
 * Bakje picker content. `merchant` adds a footer switch "Alle van <winkel>" (default on, like
 * the transaction sheet); `onUnsorted` adds "Zonder bakje" on top (filters).
 */
export function BakjePicker({ value, sign = 'out', onPick, close, merchant, onUnsorted, title }) {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(true);
  const cats = useFilter(orderedCategories(sign, { withInternal: categoryById(value)?.grp === 'internal' }), q);
  const pick = (c) => { close(); onPick(c, merchant ? (all ? 'merchant' : 'one') : undefined); };
  let lastGrp = null;
  return html`<div class="pop-pad">
    ${title && html`<div class="pop-title">${title}</div>`}
    <${PopSearch} value=${q} onInput=${setQ} placeholder="Zoek bakje" onEnter=${() => cats[0] && pick(cats[0])} />
    <div class="pop-list" role="listbox" aria-label="Bakjes" onKeyDown=${onListKey}>
      ${onUnsorted && !q && html`<button class=${'pop-row' + (value === 'unsorted' ? ' is-on' : '')} role="option" onClick=${() => { close(); onUnsorted(); }}>
        <${EmojiTile} dashed size=${22} /><span>Zonder bakje</span></button>`}
      ${cats.map((c) => {
        const head = !q && c.grp !== lastGrp ? html`<div class="pop-group" key=${'g' + c.grp}>${GROUP_LABEL[c.grp] || ''}</div>` : null;
        lastGrp = c.grp;
        return html`${head}<button key=${c.id} class=${'pop-row' + (c.id === value ? ' is-on' : '')} role="option" aria-selected=${c.id === value ? 'true' : 'false'} onClick=${() => pick(c)}>
          <${EmojiTile} emoji=${c.emoji} color=${c.color} size=${22} /><span>${c.name}</span>
          ${c.id === value && html`<span class="pop-check"><${Icon} name="check" size=${14} stroke=${2.6} /></span>`}
        </button>`;
      })}
      ${!cats.length && html`<p class="quiet">Geen bakje gevonden</p>`}
    </div>
    ${merchant && html`<label class="pop-switch"><span>Alle van ${merchant}</span><${Switch} checked=${all} onChange=${setAll} label=${'Alle van ' + merchant} /></label>`}
  </div>`;
}

/** Tag picker content; `allowCreate` offers "Maak „…”". */
export function TagPicker({ value, onPick, close, allowCreate = false, title }) {
  const [q, setQ] = useState('');
  const tags = useFilter(allTags(), q);
  const exact = allTags().some((t) => t.name.toLowerCase() === q.trim().toLowerCase());
  const pick = (t) => { close(); onPick(t); };
  const create = async () => {
    try { pick(await createTag(q)); } catch (err) { toast({ text: err.message, icon: 'warning' }); }
  };
  return html`<div class="pop-pad">
    ${title && html`<div class="pop-title">${title}</div>`}
    <${PopSearch} value=${q} onInput=${setQ} placeholder=${allowCreate ? 'Zoek of maak een tag' : 'Zoek tag'}
      onEnter=${() => (tags[0] ? pick(tags[0]) : allowCreate && q.trim() && create())} />
    <div class="pop-list" role="listbox" aria-label="Tags" onKeyDown=${onListKey}>
      ${tags.map((t) => html`<button key=${t.id} class=${'pop-row' + (t.id === value ? ' is-on' : '')} role="option" onClick=${() => pick(t)}>
        <${EmojiTile} emoji=${t.emoji || '🏷️'} color=${t.color} size=${22} /><span>${t.name}</span>
        ${t.id === value && html`<span class="pop-check"><${Icon} name="check" size=${14} stroke=${2.6} /></span>`}
      </button>`)}
      ${allowCreate && q.trim() && !exact && html`<button class="pop-row" onClick=${create}>
        <span class="row-icon" style=${{ '--c': 'var(--tint)', width: '22px', height: '22px' }}><${Icon} name="plus" size=${14} stroke=${2.4} /></span>
        <span>Maak „${q.trim()}”</span></button>`}
      ${!tags.length && !(allowCreate && q.trim()) && html`<p class="quiet">${q ? 'Geen tag gevonden' : 'Nog geen tags'}</p>`}
    </div>
  </div>`;
}

export const openBakjePopover = (anchor, props) => openPopover(anchor, (close) => html`<${BakjePicker} ...${props} close=${close} />`, { width: 280, label: 'Kies bakje' });
export const openTagPopover = (anchor, props) => openPopover(anchor, (close) => html`<${TagPicker} ...${props} close=${close} />`, { width: 260, label: 'Kies tag' });

/* ======================================================================================
   Worksheet row
   ====================================================================================== */

/**
 * One payment as a table row. Columns: winkel, bakje (pop-up), tags, rekening (optional),
 * bedrag. Click/⌘/⇧ go to onSelect(tx, event); right-click opens the context menu.
 */
export function TxTableRow({ tx, selected, active, showAccount, showTags = true, onSelect, onContext, onBakje, date = false }) {
  const cat = categoryById(tx.category_id);
  const unsorted = isUnsorted(tx.category_id);
  const tags = (tx.tag_ids || []).map(tagById).filter(Boolean);
  const acc = showAccount ? accountById(tx.account_id) : null;
  const income = tx.amount_cents > 0 && tx.kind === 'normal';
  return html`<div class=${'txt-row' + (selected ? ' is-selected' : '') + (active ? ' is-active' : '')} role="row"
      aria-selected=${selected ? 'true' : 'false'} data-id=${tx.id}
      onMouseDown=${(e) => { if (e.shiftKey) e.preventDefault(); }}
      onClick=${(e) => onSelect(tx, e)} onContextMenu=${(e) => onContext(tx, e)}>
    <span class="txt-cell txt-name" role="gridcell">
      <${EmojiTile} emoji=${cat?.emoji} color=${cat?.color} dashed=${unsorted} size=${24} />
      <span class="txt-name-text">${tx.merchant_name}</span>
      ${date ? html`<span class="txt-date num">${shortDate(tx.date)}</span>` : tx.city && html`<span class="txt-city">${tx.city}</span>`}
    </span>
    <span class="txt-cell" role="gridcell">
      <button class=${'txt-bakje' + (unsorted ? ' is-unsorted' : '')} style=${{ '--c': colorVar(cat?.color || 'gray') }}
        aria-haspopup="dialog" aria-label=${`Bakje: ${unsorted ? 'nog geen' : cat.name}. Wijzig`}
        onClick=${(e) => { e.stopPropagation(); onBakje(tx, e.currentTarget); }}>
        <span class="txt-bakje-text">${unsorted ? 'Kies bakje' : cat.name}</span>
        <${Icon} name="chevron-up-down" size=${11} stroke=${2.4} />
      </button>
    </span>
    ${showTags && html`<span class="txt-cell txt-tags" role="gridcell">${tags.map((t) => html`<span class="tag-mini" style=${{ '--c': colorVar(t.color) }}>${t.emoji ? t.emoji + ' ' : ''}${t.name}</span>`)}</span>`}
    ${showAccount && html`<span class="txt-cell txt-acc" role="gridcell">${acc?.name || ''}</span>`}
    <span class=${'txt-cell txt-amt num' + (income ? ' is-income' : '')} role="gridcell">${money(tx.amount_cents, { signed: true })}</span>
  </div>`;
}

/* ======================================================================================
   Context menu
   ====================================================================================== */

/** Right-click menu for one payment or the current selection (`targets`). */
export function openRowMenu(e, tx, targets, byId) {
  const multi = targets.length > 1;
  const sign = tx.amount_cents > 0 ? 'in' : 'out';
  const current = targets.every((t) => t.category_id === tx.category_id) ? tx.category_id : null;
  const applyBakje = (c) => (multi ? bulkSetBakje(targets.map((t) => t.id), byId, c) : setTxBakje(tx, c, 'merchant'));
  const items = [
    multi && { header: plural(targets.length, 'betaling', 'betalingen') },
    {
      label: 'Bakje',
      submenu: { render: (close) => html`<${BakjePicker} value=${current} sign=${sign} close=${close} onPick=${(c) => applyBakje(c)} />`, width: 280 },
    },
    {
      label: 'Tag',
      submenu: { render: (close) => html`<${TagPicker} close=${close} allowCreate onPick=${(t) => bulkAddTag(targets.map((x) => x.id), byId, t)} />`, width: 260 },
    },
    '-',
    !multi && { label: 'Kopieer bedrag', icon: 'copy', onSelect: async () => {
      const text = (Math.abs(tx.amount_cents) / 100).toFixed(2).replace('.', ',');
      toast((await copyText(text)) ? { text: `${text} gekopieerd`, icon: 'copy' } : { text: 'Kopiëren lukt hier niet', icon: 'warning' });
    } },
    !multi && tx.merchant_key && { label: `Toon alles van ${tx.merchant_name}`, icon: 'search', onSelect: () => replaceQuery({ merchant_key: tx.merchant_key, q: undefined, category_id: undefined, tag_id: undefined, unsorted: undefined, period: undefined, flow: undefined }) },
  ].filter(Boolean);
  openContextMenu(e, items, { width: 250 });
}

/* ======================================================================================
   Multi-selection: toolbar bulk bar and inspector summary
   ====================================================================================== */

export function BulkTools({ ids, byId, onClear }) {
  const txs = ids.map((id) => byId.get(id)).filter(Boolean);
  const sign = txs.every((t) => t.amount_cents > 0) ? 'in' : 'out';
  return html`<div class="tb-bulk" role="toolbar" aria-label="Acties voor selectie">
    <span class="tb-bulk-count num" aria-live="polite">${plural(ids.length, 'gekozen', 'gekozen')}</span>
    <button class="tb-pop" aria-haspopup="dialog" onClick=${(e) => openBakjePopover(e.currentTarget, { sign, onPick: (c) => bulkSetBakje(ids, byId, c), title: plural(ids.length, 'betaling', 'betalingen') })}>
      <${Icon} name="bakjes" size=${15} stroke=${2} /><span>Bakje</span><${Icon} name="chevron-down" size=${10} stroke=${2.8} /></button>
    <button class="tb-pop" aria-haspopup="dialog" onClick=${(e) => openTagPopover(e.currentTarget, { allowCreate: true, onPick: (t) => bulkAddTag(ids, byId, t), title: 'Tag toevoegen' })}>
      <${Icon} name="tag" size=${15} stroke=${2} /><span>Tag</span><${Icon} name="chevron-down" size=${10} stroke=${2.8} /></button>
    <button class="navbtn tb-bulk-x" aria-label="Selectie opheffen" data-tip="Selectie opheffen (Esc)" onClick=${onClear}><${Icon} name="xmark" size=${14} stroke=${2.4} /></button>
  </div>`;
}

export function MultiInspector({ ids, byId, onClear }) {
  const txs = ids.map((id) => byId.get(id)).filter(Boolean);
  const out = txs.reduce((s, t) => s + Math.min(0, t.amount_cents), 0);
  const inn = txs.reduce((s, t) => s + Math.max(0, t.amount_cents), 0);
  const cats = useMemo(() => {
    const m = new Map();
    for (const t of txs) m.set(t.category_id, (m.get(t.category_id) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [ids.join(',')]);
  const sign = txs.every((t) => t.amount_cents > 0) ? 'in' : 'out';
  return html`<div class="ti-multi">
    <div class="ti-stack" aria-hidden="true">${cats.map(([id], i) => {
      const c = categoryById(id);
      return html`<span style=${{ '--i': i }}><${EmojiTile} emoji=${c?.emoji} color=${c?.color} dashed=${isUnsorted(id)} size=${44} /></span>`;
    })}</div>
    <h2 class="ti-multi-title">${plural(txs.length, 'betaling', 'betalingen')}</h2>
    <p class="ti-multi-sum num">${out < 0 && html`<span>${money(out)} uit</span>`}${out < 0 && inn > 0 && ' · '}${inn > 0 && html`<span class="is-income">${money(inn, { signed: true })} in</span>`}</p>
    <div class="ti-multi-actions">
      <button class="btn btn-tinted btn-medium" onClick=${(e) => openBakjePopover(e.currentTarget, { sign, onPick: (c) => bulkSetBakje(ids, byId, c) })}>
        <${Icon} name="bakjes" size=${16} stroke=${2} /><span>Bakje</span></button>
      <button class="btn btn-tinted btn-medium" onClick=${(e) => openTagPopover(e.currentTarget, { allowCreate: true, onPick: (t) => bulkAddTag(ids, byId, t) })}>
        <${Icon} name="tag" size=${16} stroke=${2} /><span>Tag</span></button>
    </div>
    <ul class="ti-multi-cats">${cats.map(([id, n]) => {
      const c = categoryById(id);
      return html`<li><span>${isUnsorted(id) ? 'Nog geen bakje' : c?.name || 'Onbekend'}</span><span class="num c-2">${n}</span></li>`;
    })}</ul>
    <button class="btn btn-plain btn-small" onClick=${onClear}>Selectie opheffen</button>
  </div>`;
}
