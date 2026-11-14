// One payment in a list: emoji tile in the bakje colour (dashed when unsorted), merchant,
// "bakje · plaats" + tag chips, amount (cents; income green with +, expenses unsigned).
//
//   html`<ul class="inset">${items.map((tx) => html`<${TxRow} key=${tx.id} tx=${tx} onClick=${() => open(tx)} />`)}</ul>`
//   Props: tx (SPEC Tx), onClick, sub (override second line), hideCategory, date (show date in line 2),
//   selected (highlight), selectable (multi-select: leading check circle, aria-pressed = selected)

import { html } from '../vendor/preact-htm.js';
import { EmojiTile } from './EmojiTile.js';
import { categoryById, tagById } from '../store.js';
import { money, shortDate } from '../format.js';
import { colorVar } from '../colors.js';

export function TxRow({ tx, onClick, sub, hideCategory = false, date = false, selected = false, selectable = false }) {
  const cat = categoryById(tx.category_id);
  const unsorted = !cat || cat.key === 'unsorted';
  const tags = (tx.tag_ids || []).map(tagById).filter(Boolean);
  const income = tx.amount_cents > 0;
  const line2 = sub ?? [
    date ? shortDate(tx.date) : null,
    hideCategory ? null : unsorted ? 'Nog geen bakje' : cat.name,
    tx.city,
  ].filter(Boolean).join(' · ');
  const inner = html`
    ${selectable && html`<span class=${'row-select' + (selected ? ' is-on' : '')} aria-hidden="true"></span>`}
    <span class="row-lead"><${EmojiTile} emoji=${cat?.emoji} color=${cat?.color} dashed=${unsorted} size=${38} /></span>
    <span class="row-main">
      <span class="row-title">${tx.merchant_name}</span>
      <span class="row-sub">
        ${line2}
        ${tags.map((t) => html`<span class="tag-mini" style=${{ '--c': colorVar(t.color) }}>${t.emoji ? t.emoji + ' ' : ''}${t.name}</span>`)}
      </span>
    </span>
    <span class=${'row-amount num' + (income && tx.kind === 'normal' ? ' is-income' : '')}>${money(tx.amount_cents, { signed: true })}</span>`;
  return html`<li class="row-li">${onClick
    ? html`<button class=${'row has-lead is-two is-tx is-button' + (selected ? ' is-selected' : '') + (selectable ? ' is-selectable' : '')}
        aria-pressed=${selectable ? (selected ? 'true' : 'false') : null} onClick=${onClick}>${inner}</button>`
    : html`<div class="row has-lead is-two is-tx">${inner}</div>`}</li>`;
}
