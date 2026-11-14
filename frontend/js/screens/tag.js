// Tag detail (DESIGN §3): total, period, capsule per bakje, bars per month, payments.
// "Wijzig" opens the tag sheet (name, emoji, colour, delete with undo).
// Uses GET /tags/{id}/summary; when that endpoint is missing it computes the same from
// GET /transactions?tag_id (fails soft).

import { html, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery, useStore, categoryById } from '../store.js';
import { navigate, back, openSheet } from '../router.js';
import { money, euros, plural, monthLabel, shortDate, shiftPeriod } from '../format.js';
import { Screen, NavButton } from '../components/Screen.js';
import { Card } from '../components/Card.js';
import { Section, List, ListRow } from '../components/List.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { TxRow } from '../components/TxRow.js';
import { Skeleton, EmptyState } from '../components/Feedback.js';
import { StackedCapsule } from '../charts/StackedCapsule.js';
import { BarChart } from '../charts/BarChart.js';
import { colorVar } from '../colors.js';
import { openTransaction } from '../shell/actions.js';
import { openTagEditor, usePendingDeletes } from './tags.js';
import { tagLookup } from './_tx.js';
import { useLayout } from '../hooks.js';
import { TagsSplit } from './tags.js';

async function summary(id) {
  try {
    return await api.tagSummary(id);
  } catch (err) {
    if (err.status !== 404 || err.code === 'not_found_tag') throw err;
    // Fallback: build it from the transaction list.
    let items = [];
    let cursor = null;
    do {
      const res = await api.transactions({ tag_id: id, limit: 1000, cursor });
      items = items.concat(res.items);
      cursor = res.next_cursor;
    } while (cursor && items.length < 5000);
    const byCat = new Map();
    const byMonth = new Map();
    for (const t of items) {
      byCat.set(t.category_id, (byCat.get(t.category_id) || 0) - t.amount_cents);
      byMonth.set(t.date.slice(0, 7), (byMonth.get(t.date.slice(0, 7)) || 0) - t.amount_cents);
    }
    return {
      total_out_cents: items.reduce((s, t) => s + Math.min(0, t.amount_cents), 0),
      total_in_cents: items.reduce((s, t) => s + Math.max(0, t.amount_cents), 0),
      count: items.length, first_date: items.at(-1)?.date || null, last_date: items[0]?.date || null,
      by_category: [...byCat].filter(([, c]) => c > 0).map(([category_id, cents]) => ({ category_id, cents })).sort((a, b) => b.cents - a.cents),
      by_month: [...byMonth].map(([month, cents]) => ({ month, cents: Math.max(0, cents) })).sort((a, b) => (a.month < b.month ? -1 : 1)),
      transactions: items,
    };
  }
}

const SHOW = 60;

export function Tag({ params }) {
  useStore((s) => s.boot);
  const id = Number(params.id);
  const tag = tagLookup(id);
  const hidden = usePendingDeletes();
  const { data, error } = useQuery(`tag:${id}`, () => summary(id));
  const [sel, setSel] = useState(null);
  const [all, setAll] = useState(false);
  const desk = useLayout() === 'wide';

  if (!tag || hidden.has(id)) {
    return html`<${Screen} title="Tag" large=${false}>
      <${EmptyState} emoji="🏷️" title="Tag weg" action=${{ label: 'Alle tags', variant: 'tinted', onClick: () => back('/tags') }} />
    </${Screen}>`;
  }

  const edit = (e) => openTagEditor(e?.currentTarget, { tag, onDeleted: () => back('/tags') });
  const header = html`<header class="tgd-head">
    <${EmojiTile} emoji=${tag.emoji || '🏷️'} color=${tag.color} size=${72} />
    <h1 class="tgd-name">${tag.name}</h1>
  </header>`;

  const months = fillMonths(data?.by_month || []);
  const scrub = sel != null ? months[sel] : null;
  const spent = data ? -data.total_out_cents : 0;
  const net = data ? spent - data.total_in_cents : 0;
  const range = data?.first_date && data?.last_date
    ? (data.first_date.slice(0, 7) === data.last_date.slice(0, 7) ? monthLabel(data.first_date.slice(0, 7)) : `${shortDate(data.first_date)} – ${shortDate(data.last_date)}`)
    : null;
  const segs = (data?.by_category || []).map((c) => {
    const cat = categoryById(c.category_id);
    return { key: c.category_id, value: c.cents, color: cat?.color || 'gray', label: cat?.name || 'Overig', emoji: cat?.emoji || '❔', dashed: !cat || cat.key === 'unsorted' };
  }).filter((s) => s.value > 0);
  const txs = data?.transactions || [];

  const body = html`
    ${error && !data ? html`<${EmptyState} emoji="📡" title="Niet geladen" subtitle=${error.message} />`
    : data && data.count === 0 ? html`<${EmptyState} icon="tag" title="Nog niets getagd"
        action=${{ label: 'Naar transacties', variant: 'tinted', onClick: () => navigate('/transacties') }} />` : html`
    <${Card} class="tgd-card" style=${{ '--c': colorVar(tag.color) }}>
      <div class="tgd-hero">
        <div class="tgd-value rounded num">${data ? euros(scrub ? scrub.cents : net) : html`<${Skeleton} w=${120} h=${32} />`}</div>
        <div class="tgd-label">${scrub ? monthLabel(scrub.month) : data
          ? [plural(data.count, 'betaling', 'betalingen'), range].filter(Boolean).join(' · ')
          : html`<${Skeleton} w=${160} h=${14} />`}</div>
        ${!scrub && data?.total_in_cents > 0 && html`<div class="tgd-in num">${money(spent, { whole: true })} uit · <span class="is-income">${money(data.total_in_cents, { whole: true, signed: true })} terug</span></div>`}
      </div>
      ${data && months.length > 1 && html`<${BarChart} height=${150} color=${colorVar(tag.color)}
        data=${months.map((m) => ({ label: monthLabel(m.month), short: monthLabel(m.month, { short: true, year: false }), value: m.cents }))}
        selected=${sel} onSelect=${setSel} label=${`${tag.name} per maand`} />`}
      ${!data && html`<${Skeleton} h=${150} r=${10} />`}
    </${Card}>

    ${segs.length > 0 && html`<${Section} title="Per bakje">
      <div class="tgd-capsule"><${StackedCapsule} segments=${segs} label=${`${tag.name} per bakje`} /></div>
      <${List}>
        ${segs.map((s) => html`<${ListRow} key=${s.key} leading=${html`<${EmojiTile} emoji=${s.emoji} color=${s.color} dashed=${s.dashed} size=${32} />`}
          title=${s.label} value=${html`<span class="num">${euros(s.value)}</span>`} />`)}
      </${List}>
    </${Section}>`}

    ${data && html`<${Section} title="Betalingen" link=${txs.length ? { label: 'In Transacties', onClick: () => navigate('/transacties', { query: { tag_id: id } }) } : null}>
      ${txs.length
        ? html`<ul class="inset">${(all ? txs : txs.slice(0, SHOW)).map((tx) => html`<${TxRow} key=${tx.id} tx=${tx} date onClick=${() => openTransaction(tx)} />`)}</ul>
          ${!all && txs.length > SHOW && html`<button class="show-all" onClick=${() => setAll(true)}>Toon alle ${txs.length}</button>`}`
        : html`<p class="quiet">Nog geen betalingen met deze tag</p>`}
    </${Section}>`}`}
  `;
  const editBtn = html`<${NavButton} text="Wijzig" onClick=${edit} />`;
  if (desk) {
    return html`<${Screen} title=${tag.name} class="tgd" back=${false} toolbar=${editBtn}
        add=${[{ label: 'Nieuwe tag', icon: 'tag', onSelect: () => openTagEditor(null, {}) }]}>
      <${TagsSplit} active=${id}>${header}${body}</${TagsSplit}>
    </${Screen}>`;
  }
  return html`<${Screen} title=${tag.name} header=${header} class="tgd" trailing=${editBtn}>${body}</${Screen}>`;
}

/** Continuous months from the first to the last (at most 24), missing ones as 0. */
function fillMonths(byMonth) {
  if (!byMonth.length) return [];
  const map = new Map(byMonth.map((m) => [m.month, Math.max(0, m.cents)]));
  const first = byMonth[0].month;
  const last = byMonth[byMonth.length - 1].month;
  const out = [];
  for (let m = first; m <= last && out.length < 60; m = shiftPeriod(m, 1)) out.push({ month: m, cents: map.get(m) || 0 });
  return out.slice(-24);
}
