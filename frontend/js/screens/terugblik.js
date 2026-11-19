// Terugblik (SPEC §14 "Recap"): a calm one-page story per period or year.
//
//   #/terugblik                 index: a card per year and per complete period, newest first;
//                               the teaser (first highlight) is fetched when the card scrolls in.
//   #/terugblik/:period         e.g. #/terugblik/2026-10
//   #/terugblik/jaar/:year      e.g. #/terugblik/jaar/2025
//
// Detail: headline (over/tekort), highlights, the five totals with the difference to the previous
// period/year, bakjes (capsule + table with previous and share), movers, top winkels, grootste
// uitgaven, vaste lasten (new / stopped / price changes), sparen en potjes, vermogen, and for a
// year the 12-month chart. `complete: false` → "Nog bezig", no comparisons. "Druk af" prints an
// A4 version (print stylesheet in css/screen-terugblik.css).

import { useTable, SortHead, TableTools } from '../components/SortableTable.js';
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery, useStore, categoryById } from '../store.js';
import { navigate } from '../router.js';
import { euros, money, monthLabel, shiftPeriod, plural, capitalize, longDate, number, freqLabel, todayISO } from '../format.js';
import { Screen, NavButton } from '../components/Screen.js';
import { Card } from '../components/Card.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { Skeleton, EmptyState, ProgressRing } from '../components/Feedback.js';
import { TxRow } from '../components/TxRow.js';
import { StackedCapsule } from '../charts/StackedCapsule.js';
import { BarChart } from '../charts/BarChart.js';
import { openTransaction } from '../shell/actions.js';
import { Icon } from '../icons.js';
import { useLayout } from '../hooks.js';

export const recapHref = ({ period, year }) => (year != null ? `/terugblik/jaar/${year}` : `/terugblik/${period}`);
const recapKey = ({ period, year }) => (year != null ? `recap:y:${year}` : `recap:p:${period}`);
const fetchRecap = (q) => () => api.getRecap(q);

/* ======================================================================================
   Index
   ====================================================================================== */

export function Terugblik() {
  const { data, error, reload } = useQuery('recap-index', () => api.getRecapIndex());
  const cur = useStore((s) => s.boot?.periods?.current);
  if (!data) {
    return html`<${Screen} title="Terugblik" class="rb">
      ${error ? html`<${EmptyState} emoji="📖" title="Terugblik laadt niet" subtitle=${error.message} action=${{ label: 'Probeer opnieuw', variant: 'tinted', onClick: () => reload() }} />` : html`<${IndexSkeleton} />`}
    </${Screen}>`;
  }
  const years = data.years || [];
  const periods = data.periods || [];
  if (!years.length && !periods.length) {
    return html`<${Screen} title="Terugblik" class="rb"><${EmptyState} emoji="📖" title="Nog niets terug te blikken" /></${Screen}>`;
  }
  const byYear = new Map();
  for (const p of periods) {
    const y = p.id.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p);
  }
  return html`<${Screen} title="Terugblik" class="rb">
    ${years.length > 0 && html`<section class="rb-ix-sec" aria-labelledby="rb-years">
      <h2 class="rb-ix-h" id="rb-years">Jaren</h2>
      <div class="rb-ix-grid is-years">
        ${years.map((y) => html`<${IndexCard} key=${'y' + y} q=${{ year: y }} label=${String(y)} current=${cur && String(y) === cur.slice(0, 4)} big />`)}
      </div>
    </section>`}
    ${[...byYear.entries()].map(([y, list]) => html`<section class="rb-ix-sec" key=${y} aria-labelledby=${'rb-m' + y}>
      <h2 class="rb-ix-h" id=${'rb-m' + y}>Maanden ${y}</h2>
      <div class="rb-ix-grid">
        ${list.map((p) => html`<${IndexCard} key=${p.id} q=${{ period: p.id }} label=${capitalize(monthLabel(p.id, { year: false }))} />`)}
      </div>
    </section>`)}
  </${Screen}>`;
}

/** True once the element has been near the viewport (lazy teaser fetch). */
function useSeen() {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

function IndexCard({ q, label, current = false, big = false }) {
  const [ref, seen] = useSeen();
  const { data } = useQuery(seen ? recapKey(q) : null, fetchRecap(q));
  const h = data?.highlights?.[0];
  return html`<div ref=${ref} class="rb-ix-cell">
    <${Card} class=${'rb-ix-card' + (big ? ' is-big' : '')} onClick=${() => navigate(recapHref(q))} label=${`Terugblik ${label}${h ? ': ' + h.title : ''}`}>
      <span class="rb-ix-top">
        <span class="rb-ix-label">${label}</span>
        ${current && html`<span class="mini-chip tone-info">Nog bezig</span>`}
        <span class="rb-ix-chev" aria-hidden="true"><${Icon} name="chevron-right" size=${12} stroke=${2.6} /></span>
      </span>
      ${data
        ? html`<span class="rb-ix-teaser">${h ? html`<span class="rb-ix-emoji" aria-hidden="true">${h.emoji}</span><span>${h.title}</span>` : html`<span class="c-2">Geen betalingen</span>`}</span>`
        : html`<span class="rb-ix-teaser"><${Skeleton} w="80%" h=${14} /></span>`}
    </${Card}>
  </div>`;
}

/* ======================================================================================
   Detail
   ====================================================================================== */

export function TerugblikPeriode({ params }) {
  return html`<${Recap} q=${{ period: params.period }} />`;
}
export function TerugblikJaar({ params }) {
  return html`<${Recap} q=${{ year: Number(params.year) }} />`;
}

function neighbours(q, idx, cur) {
  if (q.year != null) {
    const ys = idx?.years || [];
    return {
      prev: ys.includes(q.year - 1) ? { year: q.year - 1, label: String(q.year - 1) } : null,
      next: ys.includes(q.year + 1) ? { year: q.year + 1, label: String(q.year + 1) } : null,
    };
  }
  const ids = new Set((idx?.periods || []).map((p) => p.id));
  const p = shiftPeriod(q.period, -1);
  const n = shiftPeriod(q.period, 1);
  return {
    prev: ids.has(p) ? { period: p, label: monthLabel(p) } : null,
    next: ids.has(n) || n === cur ? { period: n, label: monthLabel(n) } : null,
  };
}

function Recap({ q }) {
  const cur = useStore((s) => s.boot?.periods?.current);
  const desk = useLayout() === 'wide';
  const idx = useQuery('recap-index', () => api.getRecapIndex());
  const { data, error, reload } = useQuery(recapKey(q), fetchRecap(q));
  const { prev, next } = neighbours(q, idx.data, cur);
  const label = data?.label || (q.year != null ? String(q.year) : monthLabel(q.period));
  const go = (t) => t && navigate(recapHref(t), { replace: true, direction: 'none' });

  const switcher = html`<div class="monthswitch rb-switch" role="group" aria-label="Andere terugblik">
    <button class="ms-arrow" disabled=${!prev} aria-label=${prev ? 'Vorige: ' + prev.label : 'Geen vorige'} data-tip=${prev?.label} onClick=${() => go(prev)}>
      <${Icon} name="chevron-left" size=${17} stroke=${2.6} />
    </button>
    <span class="ms-label rb-switch-label">${label}</span>
    <button class="ms-arrow" disabled=${!next} aria-label=${next ? 'Volgende: ' + next.label : 'Geen volgende'} data-tip=${next?.label} onClick=${() => go(next)}>
      <${Icon} name="chevron-right" size=${17} stroke=${2.6} />
    </button>
  </div>`;
  const print = html`<${NavButton} text="Druk af" onClick=${() => window.print()} data-tip="Druk af of bewaar als pdf" />`;

  return html`<${Screen} title="Terugblik" titleView=${switcher} trailing=${desk ? print : null} class="rb rb-detail" large=${false}>
    ${!data
      ? (error ? html`<${EmptyState} emoji="📖" title="Terugblik laadt niet" subtitle=${error.message} action=${{ label: 'Probeer opnieuw', variant: 'tinted', onClick: () => reload() }} />` : html`<${DetailSkeleton} />`)
      : html`<${Story} r=${data} q=${q} desk=${desk} />
        <nav class="rb-pager" aria-label="Andere terugblik">
          ${prev ? html`<button class="rb-pager-btn" onClick=${() => go(prev)}><${Icon} name="chevron-left" size=${14} stroke=${2.6} /><span><small>Vorige</small>${capitalize(prev.label)}</span></button>` : html`<span></span>`}
          ${next ? html`<button class="rb-pager-btn is-next" onClick=${() => go(next)}><span><small>Volgende</small>${capitalize(next.label)}</span><${Icon} name="chevron-right" size=${14} stroke=${2.6} /></button>` : html`<span></span>`}
        </nav>
        <footer class="rb-print-foot" aria-hidden="true">Cents · Terugblik ${data.label}</footer>`}
  </${Screen}>`;
}

/* ---------- The story ---------- */

const TOTALS = [
  { key: 'income_cents', label: 'Inkomen', color: 'var(--green)', more: 'meer', less: 'minder' },
  { key: 'fixed_cents', label: 'Vaste lasten', color: 'var(--chart-fixed, var(--indigo))', more: 'meer', less: 'minder' },
  { key: 'daily_cents', label: 'Dagelijks', color: 'var(--chart-daily, var(--blue))', more: 'meer', less: 'minder' },
  { key: 'result_cents', label: 'Over', color: 'var(--label-2)', more: 'meer', less: 'minder' },
  { key: 'saved_cents', label: 'Gespaard', color: 'var(--chart-saved, var(--teal))', more: 'meer', less: 'minder' },
];

/** Over / tekort is the one result of the Overzicht too: income − fixed − daily. What went to
 *  savings is not spending (it is part of what was over). */
const resultOf = (t) => t.result_cents ?? t.income_cents - t.fixed_cents - t.daily_cents;

function Story({ r, q, desk }) {
  const cmp = r.complete && r.previous ? r.previous : null;
  // "dan september" / "dan 2024": the previous label without the year for a period.
  const vs = cmp ? (r.kind === 'year' ? cmp.label : cmp.label.replace(/\s\d{4}$/, '')) : '';
  const t = { ...r.totals, result_cents: resultOf(r.totals) };
  const prevT = cmp && { ...cmp, result_cents: resultOf(cmp) };
  const over = t.result_cents >= 0;
  const spent = t.fixed_cents + t.daily_cents;
  const c = r.counts || {};
  // The headline already says "€ 250 over"; leave that highlight out here (it stays the index teaser).
  const hls = (r.highlights || []).filter((h) => !/^€\s?[\d.]+ (over in |tekort in |meer uitgegeven dan er binnenkwam)/.test(h.title.replace(/\u00a0/g, ' ')));
  return html`<article class="rb-story" aria-label=${'Terugblik ' + r.label}>
    <header class="rb-head">
      <div class="rb-eyebrow">
        <span>Terugblik</span>
        ${!r.complete && html`<span class="mini-chip tone-info">${r.to >= todayISO() ? 'Nog bezig' : 'Niet compleet'}</span>`}
      </div>
      <h1 class="rb-title">${capitalize(r.label)}</h1>
      <div class=${'rb-net rounded num' + (over ? '' : ' is-short')}>${euros(Math.abs(t.result_cents))} <span>${over ? 'over' : 'tekort'}</span></div>
      <p class="rb-sub num">${euros(t.income_cents)} inkomen · ${euros(spent)} uitgegeven${t.saved_cents - (t.repaid_cents || 0) > 0 ? ` · ${euros(t.saved_cents - (t.repaid_cents || 0))} naar sparen` : ''}${t.repaid_cents > 0 ? ` · ${euros(t.repaid_cents)} afgelost` : ''}</p>
      ${c.payments > 0 && html`<p class="rb-sub is-quiet num">${plural(c.payments, 'betaling', 'betalingen')} bij ${plural(c.merchants, 'winkel', 'winkels')}${c.days_without_spending > 0 ? ` · ${plural(c.days_without_spending, 'dag', 'dagen')} zonder uitgaven` : ''} · ${longDate(r.from)} – ${longDate(r.to)}</p>`}
    </header>

    ${hls.length > 0 && html`<section class="rb-hl" aria-label="Opvallend">
      ${hls.map((h, i) => html`<div class="rb-card rb-hl-card" key=${i}>
        <span class="rb-hl-emoji" aria-hidden="true">${h.emoji}</span>
        <span class="rb-hl-text"><span class="rb-hl-title">${h.title}</span>${h.detail && html`<span class="rb-hl-detail">${h.detail}</span>`}</span>
      </div>`)}
    </section>`}

    <section class="rb-totals" aria-label="Totalen">
      ${TOTALS.map((x) => {
        const v = t[x.key];
        const isNet = x.key === 'result_cents';
        const label = isNet ? (v >= 0 ? 'Over' : 'Tekort') : x.label;
        const d = prevT ? v - prevT[x.key] : null;
        return html`<div class="rb-card rb-total" key=${x.key}>
          <span class="rb-total-label"><i style=${{ background: x.color }} aria-hidden="true"></i>${label}</span>
          <span class=${'rb-total-value num' + (isNet && v < 0 ? ' is-short' : '')}>${euros(Math.abs(v))}</span>
          ${d != null && html`<span class="rb-total-diff num">${isNet
            ? `${capitalize(vs)}: ${euros(Math.abs(prevT.result_cents))} ${prevT.result_cents >= 0 ? 'over' : 'tekort'}`
            : Math.abs(d) < 100 ? `gelijk aan ${vs}` : `${euros(Math.abs(d))} ${d > 0 ? x.more : x.less} dan ${vs}`}</span>`}
        </div>`;
      })}
    </section>

    ${r.kind === 'year' && r.months?.length > 0 && html`<${YearChart} months=${r.months} />`}

    <div class="rb-row rb-row-2">
      <${Bakjes} r=${r} cmp=${cmp} q=${q} desk=${desk} />
      ${cmp && (r.movers?.up?.length > 0 || r.movers?.down?.length > 0) && html`<${Movers} movers=${r.movers} vs=${vs} />`}
    </div>

    <div class="rb-row rb-row-even">
      ${r.merchants?.length > 0 && html`<${Merchants} list=${r.merchants} />`}
      ${r.largest?.length > 0 && html`<section class="rb-card rb-sec" aria-labelledby="rb-largest">
        <h2 class="rb-sec-h" id="rb-largest">Grootste uitgaven</h2>
        <ul class="inset rb-plain">${r.largest.map((tx) => html`<${TxRow} key=${tx.id} tx=${tx} date onClick=${() => openTransaction(tx)} />`)}</ul>
      </section>`}
    </div>

    <div class="rb-row rb-row-3">
      <${Recurring} rec=${r.recurring} />
      <${Savings} s=${r.savings} income=${t.income_cents} />
      ${r.networth && html`<${Networth} nw=${r.networth} />`}
    </div>
  </article>`;
}

/* ---------- Year chart ---------- */

const SERIES = [
  { key: 'fixed_cents', name: 'Vast', color: 'var(--chart-fixed, var(--indigo))' },
  { key: 'daily_cents', name: 'Dagelijks', color: 'var(--chart-daily, var(--blue))' },
  { key: 'saved_cents', name: 'Gespaard', color: 'var(--chart-saved, var(--teal))' },
];

function YearChart({ months }) {
  const cur = useStore((st) => st.boot?.periods?.current);
  const data = months.map((m) => ({ label: monthLabel(m.period), short: monthLabel(m.period, { short: true, year: false }), values: SERIES.map((s) => Math.max(0, m[s.key] || 0)), partial: m.period === cur }));
  return html`<section class="rb-card rb-sec rb-year" aria-labelledby="rb-yc">
    <div class="rb-sec-hrow">
      <h2 class="rb-sec-h" id="rb-yc">Per maand</h2>
      <div class="legend rb-legend" aria-hidden="true">
        ${SERIES.map((s) => html`<span><i style=${{ background: s.color }}></i>${s.name}</span>`)}
        <span><i class="is-line" style=${{ background: 'var(--green)' }}></i>Inkomen</span>
      </div>
    </div>
    <${BarChart} data=${data} series=${SERIES} height=${240} line=${{ name: 'Inkomen', color: 'var(--green)', values: months.map((m) => m.income_cents) }}
      label="Vast, dagelijks en gespaard per maand, met inkomen als lijn" />
  </section>`;
}

/* ---------- Bakjes ---------- */

const RB_COLS = [
  { key: 'name', label: 'Bakje', value: (x) => x.cat.name },
  { key: 'cents', label: 'Bedrag', value: (x) => x.cents, num: true, text: (x) => euros(x.cents) },
  { key: 'prev', label: 'Vorige keer', value: (x) => x.previous_cents, num: true, text: () => '' },
  { key: 'diff', label: 'Verschil', value: (x) => (x.previous_cents != null ? x.cents - x.previous_cents : null), num: true, text: () => '' },
];

function Bakjes({ r, cmp, q, desk }) {
  const base = (r.categories || []).map((c) => ({ ...c, cat: categoryById(c.category_id) || { name: 'Onbekend', emoji: '❔', color: 'gray', key: 'unsorted' } }));
  const [all, setAll] = useState(false);
  const cols = cmp ? RB_COLS : RB_COLS.slice(0, 2);
  const t = useTable('rb-bakjes', cols, { key: 'cents', dir: -1 });
  if (!base.length) return null;
  const rows = t.rows(base);
  const shown = all || t.filter || rows.length <= 10 ? rows : rows.slice(0, 8);
  const open = q.period ? (id) => navigate(`/overzicht/bakje/${id}`, { query: { period: q.period } }) : null;
  const total = base.reduce((s, x) => s + x.cents, 0);
  return html`<section class="rb-card rb-sec rb-bakjes" aria-labelledby="rb-bk">
    <div class="rb-sec-hrow"><h2 class="rb-sec-h" id="rb-bk">Bakjes</h2><span class="rb-sec-val num">${euros(total)}</span></div>
    <div class="rb-capsule"><${StackedCapsule} segments=${base.map((x) => ({ value: x.cents, color: x.cat.color, label: x.cat.name, key: x.category_id }))} label="Uitgaven per bakje" /></div>
    <div class="rb-noprint"><${TableTools} t=${t} menu=${!desk} placeholder="Filter bakjes" /></div>
    <div class=${'rb-table' + (cmp ? ' has-prev' : '')} role="table" aria-label="Bakjes">
      <div class="rb-tr rb-th" role="row">
        <${SortHead} t=${t} col=${RB_COLS[0]} />
        <${SortHead} t=${t} col=${RB_COLS[1]} />
        ${cmp && html`<${SortHead} t=${t} col=${RB_COLS[2]} class="rb-col-prev" />`}
        <${SortHead} t=${t} col=${{ ...RB_COLS[1], label: 'Aandeel' }} />
      </div>
      ${shown.map((x) => {
        const Tag = open ? 'button' : 'div';
        return html`<${Tag} role="row" class=${'rb-tr' + (open ? ' is-link' : '')} key=${x.category_id} onClick=${open ? () => open(x.category_id) : null}>
          <span role="cell" class="rb-td-name">
            ${x.cat.key === 'unsorted' ? html`<${EmojiTile} dashed size=${desk ? 22 : 28} />` : html`<${EmojiTile} emoji=${x.cat.emoji} color=${x.cat.color} size=${desk ? 22 : 28} />`}
            <span class="rb-td-text"><span>${x.cat.name}</span>${cmp && x.previous_cents != null && html`<small class="rb-td-prev num">vorige keer ${euros(x.previous_cents)}</small>`}</span>
          </span>
          <span role="cell" class="is-num num">${euros(x.cents)}</span>
          ${cmp && html`<span role="cell" class="is-num num rb-dim rb-col-prev">${x.previous_cents != null ? euros(x.previous_cents) : '—'}</span>`}
          <span role="cell" class="is-num num rb-dim">${Math.round(x.share * 100)} %</span>
        </${Tag}>`;
      })}
    </div>
    ${shown.length < rows.length && html`<button class="show-all" onClick=${() => setAll(true)}>Toon alle ${rows.length}</button>`}
  </section>`;
}

function Movers({ movers, vs }) {
  const row = (m, up) => {
    const cat = categoryById(m.category_id) || { name: 'Onbekend', emoji: '❔', color: 'gray' };
    const d = Math.abs(m.cents - m.previous_cents);
    return html`<li class="rb-mv" key=${m.category_id}>
      <${EmojiTile} emoji=${cat.emoji} color=${cat.color} size=${26} />
      <span class="rb-mv-main"><span class="rb-mv-name">${cat.name}</span><span class="rb-mv-sub num">${euros(m.previous_cents)} → ${euros(m.cents)}</span></span>
      <span class=${'mini-chip num tone-' + (up ? 'more' : 'less')}>${up ? '+' : '−'}${euros(d)}</span>
    </li>`;
  };
  return html`<section class="rb-card rb-sec rb-movers" aria-labelledby="rb-mv">
    <h2 class="rb-sec-h" id="rb-mv">Anders dan ${vs}</h2>
    ${movers.up?.length > 0 && html`<h3 class="rb-sub-h">Meer dan vorige keer</h3><ul class="rb-mv-list">${movers.up.map((m) => row(m, true))}</ul>`}
    ${movers.down?.length > 0 && html`<h3 class="rb-sub-h">Minder dan vorige keer</h3><ul class="rb-mv-list">${movers.down.map((m) => row(m, false))}</ul>`}
  </section>`;
}

function Merchants({ list }) {
  return html`<section class="rb-card rb-sec" aria-labelledby="rb-mer">
    <h2 class="rb-sec-h" id="rb-mer">Top winkels</h2>
    <ol class="rb-mer">
      ${list.slice(0, 10).map((m, i) => {
        const cat = categoryById(m.category_id);
        return html`<li key=${m.merchant_key}>
          <button class="rb-mer-row" onClick=${() => navigate('/transacties', { query: { merchant_key: m.merchant_key } })}>
            <span class="rb-rank num" aria-hidden="true">${i + 1}</span>
            <span class="rb-mer-main"><span class="rb-mer-name">${m.merchant_name}</span><span class="rb-mer-sub">${[cat?.name, `${number(m.count)}×`].filter(Boolean).join(' · ')}</span></span>
            <span class="num rb-mer-amt">${euros(m.cents)}</span>
          </button>
        </li>`;
      })}
    </ol>
  </section>`;
}

/* ---------- Vaste lasten, sparen, vermogen ---------- */

function Recurring({ rec }) {
  if (!rec) return null;
  const line = (it, extra) => {
    const cat = categoryById(it.category_id) || { emoji: '📦', color: 'gray' };
    return html`<li class="rb-rc" key=${it.key}>
      <${EmojiTile} emoji=${cat.emoji} color=${cat.color} size=${24} />
      <span class="rb-rc-name">${it.name}</span>
      <span class="rb-rc-val num">${extra}</span>
    </li>`;
  };
  const any = rec.new?.length || rec.ended?.length || rec.changed?.length;
  return html`<section class="rb-card rb-sec" aria-labelledby="rb-rec">
    <div class="rb-sec-hrow"><h2 class="rb-sec-h" id="rb-rec">Vaste lasten</h2><span class="rb-sec-val num">${euros(rec.per_month_cents)} per maand</span></div>
    ${!any && html`<p class="rb-quiet">Geen nieuwe, gestopte of duurdere vaste lasten.</p>`}
    ${rec.new?.length > 0 && html`<h3 class="rb-sub-h">Nieuw</h3><ul class="rb-rc-list">${rec.new.map((it) => line(it, `${money(Math.abs(it.amount_cents))} ${freqLabel(it.frequency) || ''}`))}</ul>`}
    ${rec.changed?.length > 0 && html`<h3 class="rb-sub-h">Andere prijs</h3><ul class="rb-rc-list">${rec.changed.map((it) => line(it, `${money(Math.abs(it.change.from_cents))} → ${money(Math.abs(it.change.to_cents))}`))}</ul>`}
    ${rec.ended?.length > 0 && html`<h3 class="rb-sub-h">Gestopt</h3><ul class="rb-rc-list">${rec.ended.map((it) => line(it, money(Math.abs(it.amount_cents))))}</ul>`}
  </section>`;
}

function Savings({ s, income }) {
  if (!s) return null;
  const goals = s.goals || [];
  return html`<section class="rb-card rb-sec" aria-labelledby="rb-sav">
    <div class="rb-sec-hrow"><h2 class="rb-sec-h" id="rb-sav">Sparen en potjes</h2><span class="rb-sec-val num">${euros(s.saved_cents)}</span></div>
    ${income > 0 && html`<div class="rb-rate">
      <span class="rb-rate-track" aria-hidden="true"><span style=${{ width: `${Math.max(0, Math.min(1, s.rate)) * 100}%` }}></span></span>
      <span class="rb-rate-label num">${Math.round(s.rate * 100)} % van je inkomen</span>
    </div>`}
    ${goals.length > 0 && html`<ul class="rb-goals">
      ${goals.map((g) => {
        const p = g.target_cents > 0 ? Math.max(0, Math.min(1, g.saldo_cents / g.target_cents)) : 0;
        return html`<li class=${'rb-goal' + (g.reached ? ' is-reached' : '')} key=${g.id}>
          <${ProgressRing} value=${p} color=${g.reached ? 'tint' : 'teal'} size=${40} stroke=${5} emoji=${g.emoji} label=${`${g.name}, ${Math.round(p * 100)} procent`} />
          <span class="rb-goal-main">
            <span class="rb-goal-name">${g.name}${g.reached && html` <span class="mini-chip tone-good">Gehaald 🎉</span>`}</span>
            <span class="rb-goal-sub num">${euros(g.saldo_cents)} van ${euros(g.target_cents)}</span>
          </span>
          <span class=${'num rb-goal-add' + (g.added_cents > 0 ? ' is-income' : '')}>${g.added_cents ? money(g.added_cents, { whole: true, signed: true, negative: true }) : ''}</span>
        </li>`;
      })}
    </ul>`}
    ${!goals.length && s.saved_cents <= 0 && html`<p class="rb-quiet">Deze keer niets opzij gezet.</p>`}
  </section>`;
}

function Networth({ nw }) {
  const d = nw.end_cents - nw.start_cents;
  return html`<section class="rb-card rb-sec" aria-labelledby="rb-nw">
    <h2 class="rb-sec-h" id="rb-nw">Vermogen</h2>
    <div class="rb-nw">
      <span class="rb-nw-col"><small>Begin</small><span class="num">${money(nw.start_cents, { whole: true, negative: true })}</span></span>
      <${Icon} name="chevron-right" size=${16} stroke=${2.2} />
      <span class="rb-nw-col"><small>Eind</small><span class="num rb-nw-end">${money(nw.end_cents, { whole: true, negative: true })}</span></span>
    </div>
    <p class=${'rb-nw-diff num' + (d > 0 ? ' is-income' : '')}>${d === 0 ? 'Gelijk gebleven' : `${money(d, { whole: true, signed: true, negative: true })} ${d > 0 ? 'erbij' : 'minder'}`}</p>
  </section>`;
}

/* ---------- Skeletons ---------- */

function IndexSkeleton() {
  return html`<div aria-busy="true" aria-label="Laden">
    <${Skeleton} w=${80} h=${18} style=${{ margin: '6px 4px 12px' }} />
    <div class="rb-ix-grid is-years">${[0, 1].map(() => html`<div class="card rb-ix-card is-big"><${Skeleton} w="40%" h=${22} /><${Skeleton} w="80%" h=${14} style=${{ marginTop: '12px' }} /></div>`)}</div>
    <${Skeleton} w=${120} h=${18} style=${{ margin: '24px 4px 12px' }} />
    <div class="rb-ix-grid">${[0, 1, 2, 3, 4, 5].map(() => html`<div class="card rb-ix-card"><${Skeleton} w="50%" h=${18} /><${Skeleton} w="85%" h=${14} style=${{ marginTop: '12px' }} /></div>`)}</div>
  </div>`;
}

function DetailSkeleton() {
  return html`<div class="rb-story" aria-busy="true" aria-label="Laden">
    <div class="rb-head"><${Skeleton} w=${90} h=${14} /><${Skeleton} w=${240} h=${34} style=${{ marginTop: '10px' }} /><${Skeleton} w=${200} h=${44} style=${{ marginTop: '10px' }} /><${Skeleton} w=${320} h=${15} style=${{ marginTop: '12px' }} /></div>
    <div class="rb-hl">${[0, 1, 2].map(() => html`<div class="rb-card rb-hl-card"><${Skeleton} w=${28} h=${28} r=${8} /><${Skeleton} w="70%" h=${15} /></div>`)}</div>
    <div class="rb-totals">${[0, 1, 2, 3, 4].map(() => html`<div class="rb-card rb-total"><${Skeleton} w="60%" h=${12} /><${Skeleton} w="80%" h=${22} style=${{ marginTop: '8px' }} /></div>`)}</div>
  </div>`;
}
