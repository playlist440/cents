// Jaaroverzicht (DESIGN §3): twelve periods as stacked bars (vast, dagelijks, gespaard) with
// income as a line; scrub to read a month, then open it in Overzicht. Bakjes with sparklines and
// totals, top winkels, and "zelfde maand vorig jaar" when the data reaches back far enough.

import { html, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery, categoryById } from '../store.js';
import { navigate } from '../router.js';
import { euros, monthLabel, monthSmart, shiftPeriod, plural, capitalize, number } from '../format.js';
import { Screen } from '../components/Screen.js';
import { Card } from '../components/Card.js';
import { Section, List, ListRow } from '../components/List.js';
import { Skeleton, EmptyState } from '../components/Feedback.js';
import { Icon } from '../icons.js';
import { useMedia, useLayout } from '../hooks.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { BarChart } from '../charts/BarChart.js';
import { Sparkline } from '../charts/Sparkline.js';
import { colorVar } from '../colors.js';
import { drawIn, useFirstRender } from '../anim.js';

const SERIES = [
  { key: 'fixed_cents', name: 'Vast', color: 'var(--chart-fixed)' },
  { key: 'daily_cents', name: 'Dagelijks', color: 'var(--chart-daily)' },
  { key: 'saved_cents', name: 'Gespaard', color: 'var(--chart-saved)' },
];
const INCOME = { name: 'Inkomen', color: 'var(--green)' };

export function Jaaroverzicht() {
  // 24 months for "zelfde maand vorig jaar"; the chart, the bakjes and top winkels show 12
  const { data, error, reload } = useQuery('trends:24', () => api.trends(24));
  const [sel, setSel] = useState(null);
  const desk = useLayout() === 'wide';

  if (!data) {
    return html`<${Screen} title="Jaaroverzicht">
      ${error ? html`<${EmptyState} emoji="📊" title="Jaaroverzicht laadt niet" subtitle=${error.message} action=${{ label: 'Probeer opnieuw', variant: 'tinted', onClick: () => reload() }} />` : html`<${JOSkeleton} />`}
    </${Screen}>`;
  }
  const all = data.periods || [];
  if (!all.length) return html`<${Screen} title="Jaaroverzicht"><${EmptyState} emoji="📊" title="Nog geen gegevens" /></${Screen}>`;
  const periods = all.slice(-12);
  const offset = all.length - periods.length;
  const byId = new Map(all.map((p) => [p.period, p]));

  if (desk) {
    // Mac: the chart full width, then bakjes (with sparklines) and the comparisons side by side.
    return html`<${Screen} title="Jaaroverzicht" class="jo">
      <${ChartCard} periods=${periods} sel=${sel} setSel=${setSel} desk />
      <div class="dk-grid jo-grid">
        <div class="dk-col-7"><${BakjesTable} cats=${data.categories || []} offset=${offset} n=${periods.length} periods=${periods} /></div>
        <div class="dk-col-5 dk-stack">
          <${LastYear} periods=${periods} byId=${byId} sel=${sel} desk />
          <${TopMerchants} items=${data.top_merchants || []} months=${data.top_merchants_months} desk />
        </div>
      </div>
    </${Screen}>`;
  }

  return html`<${Screen} title="Jaaroverzicht" class="jo">
    <${ChartCard} periods=${periods} sel=${sel} setSel=${setSel} />
    <${LastYear} periods=${periods} byId=${byId} sel=${sel} />
    <${Bakjes} cats=${data.categories || []} offset=${offset} n=${periods.length} />
    <${TopMerchants} items=${data.top_merchants || []} months=${data.top_merchants_months} />
  </${Screen}>`;
}

/* ---------- Chart ---------- */

function ChartCard({ periods, sel, setSel, desk = false }) {
  const narrow = useMedia('(max-width: 420px)');
  const p = sel != null ? periods[sel] : null;
  const sum = (k) => periods.reduce((s, x) => s + (x[k] || 0), 0);
  const v = p
    ? { income: p.income_cents, spent: p.fixed_cents + p.daily_cents, fixed: p.fixed_cents, daily: p.daily_cents, saved: p.saved_cents }
    : { income: sum('income_cents'), spent: sum('fixed_cents') + sum('daily_cents'), fixed: sum('fixed_cents'), daily: sum('daily_cents'), saved: sum('saved_cents') };
  const title = p ? capitalize(monthSmart(p.period)) : periods.length >= 12 ? 'Afgelopen 12 maanden' : `Afgelopen ${plural(periods.length, 'maand', 'maanden')}`;
  // over / tekort: the same result as the Overzicht and the Terugblik (saving is not spending)
  const result = v.income - v.spent;
  const data = periods.map((x) => ({
    label: monthLabel(x.period),
    short: narrow ? monthLabel(x.period, { year: false }).slice(0, 1) : monthLabel(x.period, { short: true, year: false }),
    values: SERIES.map((s) => Math.max(0, x[s.key] || 0)),
    partial: !!x.partial,
  }));
  return html`<${Card} class="jo-chart">
    <div class="jo-chart-head">
      <div class="jo-title-wrap">
        <div class="jo-title">${title}</div>
        <div class=${'jo-result num' + (result < 0 ? ' is-short' : '')}>${euros(Math.abs(result))} ${result < 0 ? 'tekort' : 'over'}</div>
      </div>
      ${p && html`<button class="jo-open" onClick=${() => navigate('/overzicht', { query: { period: p.period } })}>
        Open<${Icon} name="chevron-right" size=${13} stroke=${2.6} /></button>`}
    </div>
    <div class="jo-stats">
      <${Stat} color="var(--green)" label="Inkomen" cents=${v.income} />
      <${Stat} color="var(--chart-fixed)" label="Vast" cents=${v.fixed} />
      <${Stat} color="var(--chart-daily)" label="Dagelijks" cents=${v.daily} />
      <${Stat} color="var(--chart-saved)" label="Gespaard" cents=${v.saved} />
    </div>
    <${BarChart} data=${data} series=${SERIES} height=${desk ? 360 : 200} selected=${sel} onSelect=${setSel}
      line=${{ ...INCOME, values: periods.map((x) => x.income_cents) }} highlight=${periods.length - 1}
      label="Uitgaven, sparen en inkomen per maand" />
  </${Card}>`;
}

function Stat({ color, label, cents }) {
  return html`<div class="jo-stat">
    <span class="jo-stat-label"><i style=${{ background: color }}></i>${label}</span>
    <span class="jo-stat-value num">${euros(cents)}</span>
  </div>`;
}

/* ---------- Same month last year ---------- */

function LastYear({ periods, byId, sel, desk = false }) {
  const first = useFirstRender();
  // Default: the last complete month; when scrubbing: the scrubbed month. Periods marked
  // `partial` (current month, first month, import gaps) are never compared.
  const complete = periods.filter((x) => !x.partial);
  const cur = periods[periods.length - 1];
  const fallback = complete.length ? complete[complete.length - 1] : null;
  const p = sel != null ? periods[sel] : (cur && !cur.partial && !('partial' in cur) && periods.length > 1 ? periods[periods.length - 2] : fallback);
  const prev = p && byId.get(shiftPeriod(p.period, -12));
  if (!p || !prev || p.partial || prev.partial) return null;
  const spentNow = p.fixed_cents + p.daily_cents;
  const spentThen = prev.fixed_cents + prev.daily_cents;
  const rows = [
    { label: 'Uitgegeven', now: spentNow, then: spentThen, color: 'var(--chart-daily)' },
    { label: 'Inkomen', now: p.income_cents, then: prev.income_cents, color: 'var(--green)' },
    { label: 'Gespaard', now: Math.max(0, p.saved_cents), then: Math.max(0, prev.saved_cents), color: 'var(--chart-saved)' },
  ];
  const max = Math.max(1, ...rows.flatMap((r) => [r.now, r.then]));
  const grow = (el) => first.current && drawIn(el, [{ transform: 'scaleX(0)' }, {}], { duration: 800 });
  const d = spentNow - spentThen;
  const Wrap = desk ? DeskCard : Section;
  return html`<${Wrap} title="Zelfde maand vorig jaar">
    <${Card} class="jo-ly">
      <div class="jo-ly-head">
        <span>${capitalize(monthLabel(p.period))}</span>
        ${Math.abs(d) >= 1000 && html`<span class=${'mini-chip tone-' + (d > 0 ? 'more' : 'less')}>${euros(Math.abs(d))} ${d > 0 ? 'meer' : 'minder'} uitgegeven</span>`}
      </div>
      ${rows.map((r) => html`<div class="jo-ly-row">
        <div class="jo-ly-label">${r.label}</div>
        <div class="jo-ly-bars">
          <div class="jo-ly-bar"><span ref=${grow} style=${{ width: `${(r.now / max) * 100}%`, background: r.color }}></span><b class="num">${euros(r.now)}</b></div>
          <div class="jo-ly-bar is-then"><span ref=${grow} style=${{ width: `${(r.then / max) * 100}%` }}></span><b class="num">${euros(r.then)}</b></div>
        </div>
      </div>`)}
      <div class="jo-ly-legend"><span><i class="is-now"></i>${monthLabel(p.period)}</span><span><i></i>${monthLabel(prev.period)}</span></div>
    </${Card}>
  </${Wrap}>`;
}

/* ---------- Bakjes ---------- */

function Bakjes({ cats, offset, n }) {
  const [all, setAll] = useState(false);
  const rows = cats.map((c) => {
    const values = (c.cents || []).slice(offset, offset + n);
    return { c, cat: categoryById(c.category_id), values, total: values.reduce((s, x) => s + x, 0) };
  }).filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
  if (!rows.length) return null;
  const shown = all || rows.length <= 9 ? rows : rows.slice(0, 8);
  return html`<${Section} title="Bakjes" trailing=${html`<span class="section-value num">${euros(rows.reduce((s, r) => s + r.total, 0))}</span>`}>
    <${List}>
      ${shown.map(({ c, cat, values, total }) => {
        const k = cat || { name: 'Onbekend', emoji: '❔', color: 'gray', key: 'unsorted' };
        return html`<${ListRow} key=${c.category_id} emoji=${k.key === 'unsorted' ? null : k.emoji} color=${k.color}
          leading=${k.key === 'unsorted' ? html`<span class="etile is-dashed" style=${{ '--size': '32px' }} aria-hidden="true"></span>` : null}
          title=${k.name}
          subtitle=${html`<span class="jo-spark"><${Sparkline} values=${values} width=${96} height=${20} color=${colorVar(k.color)} /></span>`}
          value=${html`<span class="num jo-total">${euros(total)}</span>`}
          chevron onClick=${cat ? () => navigate(`/overzicht/bakje/${c.category_id}`) : undefined}
          label=${`${k.name}, ${euros(total)} in ${plural(n, 'maand', 'maanden')}`} />`;
      })}
    </${List}>
    ${shown.length < rows.length && html`<button class="show-all" onClick=${() => setAll(true)}>Toon alle ${rows.length}</button>`}
  </${Section}>`;
}

/* ---------- Top winkels ---------- */

function TopMerchants({ items, months, desk = false }) {
  if (!items.length) return null;
  const Wrap = desk ? DeskCard : Section;
  const n = months || 12;
  return html`<${Wrap} title="Top winkels">
    <${List} footer=${`Afgelopen ${plural(n, 'maand', 'maanden')}`}>
      ${items.slice(0, 8).map((m, i) => {
        const cat = categoryById(m.category_id);
        return html`<${ListRow} key=${m.merchant_key}
          leading=${html`<span class="jo-rank num" aria-hidden="true">${i + 1}</span>`}
          title=${m.merchant_name} subtitle=${[cat?.name, `${number(m.count)}×`].filter(Boolean).join(' · ')}
          value=${html`<span class="num jo-total">${euros(m.cents)}</span>`}
          chevron onClick=${() => navigate('/transacties', { query: { merchant_key: m.merchant_key } })} />`;
      })}
    </${List}>
  </${Wrap}>`;
}

/* ---------- Desktop pieces ---------- */

function DeskCard({ title, children }) {
  return html`<section class="dk-card jo-card"><div class="dk-card-h"><h2>${title}</h2></div>${children}</section>`;
}

function BakjesTable({ cats, offset, n, periods }) {
  const rows = cats.map((c) => {
    const values = (c.cents || []).slice(offset, offset + n);
    // Averages leave out incomplete months (they would pull "normal" down).
    const complete = values.filter((_, i) => !periods[i]?.partial);
    return { c, cat: categoryById(c.category_id), values, total: values.reduce((s, x) => s + x, 0), avg: complete.length ? complete.reduce((s, x) => s + x, 0) / complete.length : 0 };
  }).filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
  if (!rows.length) return null;
  return html`<section class="dk-card jo-card" aria-labelledby="jo-bk-h">
    <div class="dk-card-h"><h2 id="jo-bk-h">Bakjes</h2><span class="section-value num">${euros(rows.reduce((s, r) => s + r.total, 0))}</span></div>
    <div class="dt jo-dt" role="table" aria-label="Bakjes per maand">
      <div class="dt-head" role="row"><span role="columnheader">Bakje</span><span role="columnheader">Verloop</span>
        <span role="columnheader" class="is-num">Per maand</span><span role="columnheader" class="is-num">Totaal</span></div>
      ${rows.map(({ c, cat, values, total, avg }) => {
        const k = cat || { name: 'Onbekend', emoji: '❔', color: 'gray', key: 'unsorted' };
        return html`<button class="dt-row" role="row" key=${c.category_id} disabled=${!cat}
            onClick=${() => cat && navigate(`/overzicht/bakje/${c.category_id}`)} aria-label=${`${k.name}, ${euros(total)} in ${plural(n, 'maand', 'maanden')}`}>
          <span class="dt-cell jo-dt-name" role="cell"><${EmojiTile} emoji=${k.emoji} color=${k.color} dashed=${k.key === 'unsorted'} size=${24} /><span>${k.name}</span></span>
          <span class="dt-cell jo-dt-spark" role="cell"><${Sparkline} values=${values} width=${140} height=${22} color=${colorVar(k.color)} /></span>
          <span class="dt-cell is-num num c-2" role="cell">${euros(avg)}</span>
          <span class="dt-cell is-num num" role="cell">${euros(total)}</span>
        </button>`;
      })}
    </div>
  </section>`;
}

/* ---------- Skeleton ---------- */

function JOSkeleton() {
  return html`<div aria-busy="true" aria-label="Laden">
    <div class="card jo-chart">
      <${Skeleton} w=${180} h=${20} />
      <div class="jo-stats">${[0, 1, 2, 3].map(() => html`<div class="jo-stat"><${Skeleton} w="70%" h=${12} /><${Skeleton} w="85%" h=${18} style=${{ marginTop: '6px' }} /></div>`)}</div>
      <${Skeleton} h=${200} r=${10} />
    </div>
    <div class="section"><${Skeleton} w=${100} h=${22} />
      <div class="inset" style=${{ marginTop: '10px' }}>${[0, 1, 2, 3].map(() => html`<div class="row has-lead"><span class="row-lead"><${Skeleton} w=${32} h=${32} r=${9} /></span><span class="row-main"><${Skeleton} w="45%" h=${15} /></span></div>`)}</div>
    </div>
  </div>`;
}
