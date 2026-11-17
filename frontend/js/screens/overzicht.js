// Overzicht (DESIGN §3): hero "Vrij geld" (breakdown popover) with Tempo and the pace chart,
// a betaalrekening warning when relevant, four tiles, sort banner, "Waar het heen ging",
// insights, Binnenkort, Potjes peek. Empty state: one drop zone.
// A year ("?period=2026") shows the year's sums instead: hero Over / Tekort, a bar chart per
// month in place of the pace chart, tiles with per-month figures (SPEC §9 "Jaar").

import { html, useRef, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useStore, useQuery, categoryById } from '../store.js';
import { navigate, replaceQuery } from '../router.js';
import { euros, money, plural, monthLabel, monthSmart, relativeDays, parseISO, MONTHS_SHORT, MONTHS, todayISO, addDays, dayLabel, percent, shortDate } from '../format.js';
import { useLayout } from '../hooks.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { Icon } from '../icons.js';
import { Screen, NavButton } from '../components/Screen.js';
import { MonthSwitcher, isYear, yearLabel } from '../components/MonthSwitcher.js';
import { Amount } from '../components/Amount.js';
import { Tile, Card } from '../components/Card.js';
import { Section, List, ListRow } from '../components/List.js';
import { Button } from '../components/Controls.js';
import { Skeleton, DropZone, ProgressRing } from '../components/Feedback.js';
import { PaceChart } from '../charts/PaceChart.js';
import { BarChart } from '../charts/BarChart.js';
import { StackedCapsule } from '../charts/StackedCapsule.js';
import { RankedBars } from '../charts/RankedBars.js';
import { colorVar } from '../colors.js';
import { openAddMenu, openImport, openLink } from '../shell/actions.js';
import { openMenu, openContextMenu, openPopover } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { invalidate } from '../store.js';
import { commitLater, usePending } from './_kit.js';

export function Overzicht({ query }) {
  const boot = useStore((s) => s.boot);
  const periods = boot.periods;
  const period = validPeriod(query.period, periods);
  const hasData = boot.has_data;
  const ov = useQuery(hasData ? 'overview:' + period : null, () => api.overview(period));
  const goals = useQuery(hasData ? 'goals' : null, () => api.goals());
  const last = useRef(null);
  if (ov.data) last.current = ov.data;
  const data = ov.data || last.current;
  const stale = !ov.data && !!last.current;
  const desk = useLayout() === 'wide';

  const setPeriod = (p) => replaceQuery({ period: p === periods.current ? undefined : p });

  const titleView = hasData && html`<${MonthSwitcher} value=${period} first=${periods.first} last=${periods.last} years onChange=${setPeriod} />`;
  const trailing = html`<${NavButton} icon="plus" label="Toevoegen" onClick=${(e) => openAddMenu(e.currentTarget)} />`;

  if (!hasData) {
    return html`<${Screen} title="Overzicht" trailing=${trailing} add=${[]}>
      <div class="ov-empty"><${DropZone} onFiles=${(f) => openImport(f)} /></div>
    </${Screen}>`;
  }

  return html`<${Screen} title="Overzicht" titleView=${titleView} trailing=${trailing} add=${[]} class="ov">
    ${!data ? html`<${OverzichtSkeleton} desk=${desk} />` : desk ? html`<${Dashboard} o=${data} goals=${goals.data?.goals} stale=${stale}
        canPrev=${canPrev(data.period, periods)} canNext=${canNext(data.period, periods)} setPeriod=${setPeriod} />`
    : html`<div class=${'ov-body' + (stale ? ' is-stale' : '')}>
      <${Hero} o=${data} canPrev=${canPrev(data.period, periods)} canNext=${canNext(data.period, periods)} setPeriod=${setPeriod} />
      <${CheckingWarning} o=${data} />
      <${Tiles} o=${data} />
      ${data.unsorted.merchants > 0 && html`<${SortBanner} n=${data.unsorted.merchants} />`}
      <${WhereItWent} o=${data} />
      <${Insights} o=${data} />
      <${Upcoming} o=${data} />
      <${PotjesPeek} goals=${goals.data?.goals} />
    </div>`}
  </${Screen}>`;
}

/** The `period` query: a month id up to the last one, or a year id from the first year up to
 *  the current one; anything else means the current month. */
function validPeriod(q, periods) {
  if (isYear(q)) return q >= periods.first.slice(0, 4) && q <= periods.current.slice(0, 4) ? q : periods.current;
  return q && q <= periods.last ? q : periods.current;
}

const canPrev = (p, periods) => (p.kind === 'year' ? !!p.prev : !!p.prev && p.prev >= periods.first);
const canNext = (p, periods) => (p.kind === 'year' ? !!p.next : p.id < periods.last);

/* ---------- Hero ---------- */

/** Turn cumulative spending into "what is left of a normal month": both lines start at the
 *  normal month's total and run down to zero, so the chart falls as the month goes on. */
function leftPace(pace) {
  if (!pace || !pace.typical?.length) return pace;
  const budget = pace.typical.at(-1) || 0;
  const left = (v) => Math.max(0, budget - v);
  return { ...pace, actual: pace.actual.map(left), typical: pace.typical.map(left) };
}


function heroModel(o) {
  const p = o.period;
  if (p.kind === 'year') {
    const over = o.net_cents >= 0;
    return {
      label: `${over ? 'Over' : 'Tekort'} in ${yearLabel(p.id)}`,
      cents: Math.abs(o.net_cents),
      warn: !over,
      sub: `${euros(o.income_cents)} inkomen · ${euros(o.fixed_cents + o.daily_cents)} uitgegeven`,
    };
  }
  const daysLeft = p.days_total - p.day_index + 1;
  if (p.is_current && o.free) {
    const f = o.free;
    const sub = [`tot ${shortDate(f.payday)}`];
    if (f.stale && f.as_of) sub.push(`saldo van ${shortDate(f.as_of)}`);
    if (f.total_cents < 0) sub.unshift(`${euros(-f.total_cents)} te weinig voor buffer en vaste lasten`);
    else if (o.saved_cents < 0) sub.unshift(`${euros(-o.saved_cents)} spaargeld gebruikt deze maand`);
    return { label: 'Vrij geld', cents: Math.max(0, f.total_cents), warn: f.total_cents < 0, sub: sub.join(' · '), free: f };
  }
  if (p.is_current) {
    return { label: 'Uitgegeven', cents: o.fixed_cents + o.daily_cents, sub: daysLeft === 1 ? 'laatste dag' : `nog ${daysLeft} dagen` };
  }
  const over = o.net_cents >= 0;
  return {
    label: over ? 'Over' : 'Tekort',
    cents: Math.abs(o.net_cents),
    warn: !over,
    sub: `${euros(o.income_cents)} inkomen · ${euros(o.fixed_cents + o.daily_cents)} uitgegeven`,
  };
}

/** Breakdown of Vrij geld: saldi − potjes − buffer − vaste lasten tot salaris (− creditcard). */
function FreeBreakdown({ f }) {
  const rows = [
    ...(f.accounts?.length ? f.accounts.map((a) => [a.name, a.balance_cents, a.as_of ? `saldo ${shortDate(a.as_of)}` : 'handmatig saldo']) : [['Saldi', f.balances_cents, 'betaal + spaar']]),
    ['Potjes', -f.goals_cents],
    ['Buffer', -f.buffer_cents],
    [`Vaste lasten tot ${shortDate(f.payday)}`, -f.fixed_until_payday_cents],
    f.credit_cents > 0 && ['Creditcard', -f.credit_cents],
  ].filter(Boolean);
  return html`<div class="free-pop">
    <dl class="free-rows">
      ${rows.map(([label, cents, note]) => html`<div class="free-row" key=${label}>
        <dt>${label}${note && html`<span class="free-note">${note}</span>`}</dt>
        <dd class="num">${money(cents, { whole: true, negative: true })}</dd>
      </div>`)}
      <div class="free-row is-total"><dt>Vrij</dt><dd class="num">${money(Math.max(0, f.total_cents), { whole: true })}</dd></div>
      ${f.total_cents < 0 && html`<div class="free-row"><dt>Tekort<span class="free-note">saldi dekken buffer, potjes en vaste lasten niet</span></dt><dd class="num is-warn">${money(-f.total_cents, { whole: true })}</dd></div>`}
    </dl>
    ${f.as_of && html`<p class="free-foot">Saldo van ${shortDate(f.as_of)}${f.payday_source === 'period' ? ' · salaris niet herkend' : ''}</p>`}
    <button class="dk-link free-link" onClick=${() => navigate('/instellingen/aannames')}>Aannames aanpassen</button>
  </div>`;
}

const openFree = (e, f) => openPopover(e.currentTarget, () => html`<${FreeBreakdown} f=${f} />`, { width: 300, label: 'Opbouw vrij geld' });

/** Tempo: mean monthly result of the last three months + a 12-month mini bar chart. */
function Tempo({ t }) {
  if (!t) return html`<div class="tempo is-quiet">Tempo volgt na twee volle maanden</div>`;
  const over = t.avg_net_cents >= 0;
  const text = over ? `+ ${euros(t.avg_net_cents)} per maand over` : `${euros(-t.avg_net_cents)} per maand tekort`;
  return html`<div class="tempo">
    <span class="tempo-main">
      <span class="tempo-label">Tempo</span>
      <span class=${'tempo-value num' + (over ? '' : ' is-warn')}>${text}</span>
      <span class="tempo-sub">gemiddeld, laatste ${t.periods} maanden</span>
    </span>
    <${NetBars} months=${t.months} />
  </div>`;
}

function NetBars({ months }) {
  const w = 132;
  const h = 36;
  const n = months.length;
  const max = Math.max(1, ...months.map((m) => Math.abs(m.net_cents)));
  const hasNeg = months.some((m) => m.net_cents < 0);
  const hasPos = months.some((m) => m.net_cents > 0);
  const zero = hasNeg && hasPos ? h / 2 : hasNeg ? 1 : h - 1;
  const span = hasNeg && hasPos ? h / 2 - 1 : h - 2;
  const slot = w / Math.max(n, 1);
  const bw = Math.max(3, Math.min(8, slot - 3));
  const label = 'Resultaat per maand: ' + months.map((m) => `${MONTHS[Number(m.period.slice(5)) - 1]} ${money(m.net_cents, { whole: true, negative: true })}`).join(', ');
  return html`<svg class="netbars" width=${w} height=${h} viewBox=${`0 0 ${w} ${h}`} role="img" aria-label=${label}>
    <line x1="0" x2=${w} y1=${zero} y2=${zero} class="netbars-zero" />
    ${months.map((m, i) => {
      const len = Math.max(1.5, (Math.abs(m.net_cents) / max) * span);
      const x = i * slot + (slot - bw) / 2;
      const y = m.net_cents >= 0 ? zero - len : zero;
      return html`<rect key=${m.period} x=${x} y=${y} width=${bw} height=${len} rx="1.5" class=${m.net_cents >= 0 ? 'is-pos' : 'is-neg'} />`;
    })}
  </svg>`;
}

/** Only when the checking account is expected to drop below the floor before payday. */
function CheckingWarning({ o, desk = false }) {
  const w = o.checking_warning;
  if (!o.period.is_current || !w) return null;
  const low = money(w.low_cents, { whole: true, negative: true });
  return html`<div class=${'chk-warn card' + (desk ? ' dk-card' : '')} role="status">
    <span class="chk-warn-icon" aria-hidden="true"><${Icon} name="warning" size=${18} stroke=${2.1} /></span>
    <span class="chk-warn-text">
      <span class="chk-warn-title">Rond ${shortDate(w.date)} staat de betaalrekening naar verwachting op ${low}.</span>
      ${w.suggest_cents
        ? html`<span class="chk-warn-sub">Zet ${euros(w.suggest_cents)} terug van de spaarrekening.</span>`
        : html`<span class="chk-warn-sub">Er staat niet genoeg op de spaarrekening om het aan te vullen.</span>`}
    </span>
  </div>`;
}

function Hero({ o, canPrev, canNext, setPeriod, desk = false }) {
  const m = heroModel(o);
  const ref = useRef(null);
  const g = useRef(null);
  const p = o.period;
  const pace = leftPace(o.pace);
  const paceLabel = pace
    ? `Over van een normale maand ${monthLabel(p.id)}: ${euros(pace.actual.at(-1) || 0)} ${p.is_current ? 'nu' : 'aan het eind'}, normaal ${euros(pace.typical[pace.actual.length - 1] || 0)}`
    : '';

  // Horizontal swipe on the hero changes the month.
  const down = (e) => { if (e.pointerType !== 'mouse') g.current = { x: e.clientX, y: e.clientY, dx: 0, lock: null }; };
  const move = (e) => {
    const s = g.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.lock && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) s.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (s.lock !== 'x') return;
    const blocked = (dx > 0 && !canPrev) || (dx < 0 && !canNext);
    s.dx = dx;
    ref.current.style.transition = 'none';
    ref.current.style.transform = `translateX(${blocked ? dx * 0.15 : dx * 0.45}px)`;
    ref.current.style.opacity = String(1 - Math.min(0.5, Math.abs(dx) / 400));
  };
  const up = () => {
    const s = g.current;
    g.current = null;
    if (!s || s.lock !== 'x') return;
    ref.current.style.transition = 'transform 380ms var(--spring-lin), opacity 200ms linear';
    ref.current.style.transform = '';
    ref.current.style.opacity = '';
    if (s.dx < -60 && canNext) setPeriod(p.next);
    if (s.dx > 60 && canPrev) setPeriod(p.prev);
  };

  return html`<section class="hero" aria-label=${m.label} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}>
    <div class="hero-inner" ref=${ref}>
      <div class="hero-label">${m.label}</div>
      ${m.free
        ? html`<button class=${'hero-amount rounded is-button' + (m.warn ? ' is-warn' : '')} aria-haspopup="dialog"
            aria-label=${`Vrij geld ${money(m.cents, { whole: true })}. ${m.sub}. Toon opbouw`} onClick=${(e) => openFree(e, m.free)}>
            <${Amount} key=${p.id} cents=${m.cents} whole animate negative />
            <span class="hero-info" aria-hidden="true"><${Icon} name="info" size=${18} stroke=${2} /></span>
          </button>`
        : html`<div class=${'hero-amount rounded' + (m.warn ? ' is-warn' : '')}>
            <${Amount} key=${p.id} cents=${m.cents} whole animate negative />
          </div>`}
      <div class="hero-sub num">${m.sub}</div>
      ${p.is_current && m.free && html`<${Tempo} t=${o.tempo} />`}
      ${p.kind === 'year' && o.months?.length > 0 && html`<${YearBars} o=${o} desk=${desk} />`}
      ${pace && html`<div class="hero-pace">
        ${desk
          ? html`<${PaceChart} actual=${pace.actual} typical=${pace.typical} label=${paceLabel} showToday=${p.is_current} actualLabel="Nog over"
              height=${220} axis interactive dayLabel=${(i, long) => paceDay(p, i, long)} />`
          : html`<${PaceChart} actual=${pace.actual} typical=${pace.typical} label=${paceLabel} showToday=${p.is_current} actualLabel="Nog over" />`}
        <div class="pace-legend" aria-hidden="true">
          <span><i class="lg-solid"></i>${monthSmart(p.id)}</span>
          <span><i class="lg-dot"></i>normaal</span>
        </div>
      </div>`}
    </div>
  </section>`;
}

const YEAR_SERIES = [
  { key: 'fixed_cents', name: 'Vast', color: 'var(--chart-fixed, var(--indigo))' },
  { key: 'daily_cents', name: 'Dagelijks', color: 'var(--chart-daily, var(--blue))' },
  { key: 'saved_cents', name: 'Gespaard', color: 'var(--chart-saved, var(--teal))' },
];

/** A year: vast, dagelijks and gespaard per month as stacked bars, inkomen as a line; the
 *  read-out adds the month's result (over / tekort). */
function YearBars({ o, desk }) {
  // Months before the first import are left out (a year whose data starts in June).
  const empty = (m) => !m.income_cents && !m.fixed_cents && !m.daily_cents && !m.saved_cents;
  const start = o.months.findIndex((m) => !empty(m));
  const months = start < 0 ? o.months : o.months.slice(start);
  const data = months.map((m) => ({
    label: monthLabel(m.period), short: monthLabel(m.period, { short: true, year: false }),
    values: YEAR_SERIES.map((s) => Math.max(0, m[s.key] || 0)), partial: m.partial,
  }));
  const extra = (i) => {
    const n = months[i]?.net_cents ?? 0;
    return html`<div class="ro-row"><span>${n >= 0 ? 'Over' : 'Tekort'}</span><b class=${'num' + (n < 0 ? ' is-warn' : '')}>${euros(Math.abs(n))}</b></div>`;
  };
  return html`<div class="hero-pace hero-year">
    <${BarChart} data=${data} series=${YEAR_SERIES} height=${desk ? 220 : 150}
      line=${{ name: 'Inkomen', color: 'var(--green)', values: months.map((m) => m.income_cents) }}
      readoutExtra=${extra} label=${`Per maand in ${yearLabel(o.period.id)}: vast, dagelijks en gespaard, met inkomen als lijn`} />
    <div class="pace-legend" aria-hidden="true">
      ${YEAR_SERIES.map((s) => html`<span key=${s.key}><i style=${{ background: s.color }}></i>${s.name}</span>`)}
      <span><i style=${{ background: 'var(--green)' }}></i>Inkomen</span>
    </div>
  </div>`;
}

/** Day i of the period: "3 nov" on the axis, "ma 3 november" in the read-out. */
function paceDay(p, i, long = false) {
  if (!p.from) return String(i + 1);
  const iso = addDays(p.from, i);
  if (long) return dayLabel(iso, { long: true });
  const d = parseISO(iso);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/* ---------- Desktop dashboard (DESIGN §5): 12 columns ---------- */

function Dashboard({ o, goals, stale, canPrev, canNext, setPeriod }) {
  return html`<div class=${'ov-body ov-dash dk-grid' + (stale ? ' is-stale' : '')}>
    <div class="dk-col-7 ov-hero-card dk-card"><${Hero} o=${o} canPrev=${canPrev} canNext=${canNext} setPeriod=${setPeriod} desk /></div>
    <div class="dk-col-5 ov-tiles-col dk-stack"><${CheckingWarning} o=${o} desk /><${Tiles} o=${o} /></div>
    ${o.unsorted.merchants > 0 && html`<div class="dk-col-12"><${SortBanner} n=${o.unsorted.merchants} /></div>`}
    <div class="dk-col-7"><${WhereTable} o=${o} /></div>
    <div class="dk-col-5 dk-stack ov-side">
      <${Insights} o=${o} desk />
      <${Upcoming} o=${o} desk />
      <${PotjesPeek} goals=${goals} desk />
    </div>
  </div>`;
}

function WhereTable({ o }) {
  const p = o.period;
  const rows = o.categories
    .filter((c) => c.spent_cents > 0)
    .map((c) => {
      const cat = categoryById(c.category_id) || { name: 'Onbekend', emoji: '❔', color: 'gray', key: 'unsorted' };
      return { c, cat, chip: chipFor(c, cat, p) };
    });
  if (!rows.length) return html`<section class="dk-card ov-where"><div class="dk-card-h"><h2>Waar het heen ging</h2></div><p class="quiet">Nog niets uitgegeven</p></section>`;
  const total = rows.reduce((s, r) => s + r.c.spent_cents, 0);
  const max = Math.max(...rows.map((r) => r.c.spent_cents));
  const open = (r) => navigate(`/overzicht/bakje/${r.c.category_id}`, { query: bakjeQuery(p) });
  return html`<section class="dk-card ov-where" aria-labelledby="ov-where-h">
    <div class="dk-card-h"><h2 id="ov-where-h">Waar het heen ging</h2><span class="section-value num"><span class="ov-total-lbl">alles samen</span> ${euros(total)}</span></div>
    <div class="capsule-wrap"><${StackedCapsule} segments=${rows.map((r) => ({ key: r.c.category_id, value: r.c.spent_cents, color: r.cat.color, label: r.cat.name }))} label="Uitgaven per bakje" /></div>
    <div class="dt ov-wt" role="table" aria-label="Uitgaven per bakje">
      <div class="dt-head" role="row">
        <span role="columnheader">Bakje</span>
        <span role="columnheader" class="is-num">Bedrag</span>
        <span role="columnheader" class="is-num">Aandeel</span>
        <span role="columnheader" class="is-num">${p.kind === 'year' ? 't.o.v. vorig jaar' : 't.o.v. normaal'}</span>
      </div>
      ${rows.map((r) => html`<button class="dt-row" role="row" key=${r.c.category_id} onClick=${() => open(r)}
          aria-label=${`${r.cat.name}, ${euros(r.c.spent_cents)}${r.chip ? ', ' + r.chip.text : ''}`}>
        <span class="dt-cell ov-wt-name" role="cell">
          <${EmojiTile} emoji=${r.cat.emoji} color=${r.cat.color} dashed=${r.cat.key === 'unsorted'} size=${24} />
          <span class="ov-wt-label">${r.cat.name}</span>
          <span class="ov-wt-track" aria-hidden="true"><span style=${{ width: `${Math.max(2, (r.c.spent_cents / max) * 100)}%`, background: colorVar(r.cat.color) }}></span></span>
        </span>
        <span class="dt-cell is-num num" role="cell">${euros(r.c.spent_cents)}</span>
        <span class="dt-cell is-num num c-2" role="cell">${percent(r.c.spent_cents / total)}</span>
        <span class="dt-cell is-num" role="cell">${r.chip
          ? html`<span class=${'mini-chip tone-' + r.chip.tone}>${r.chip.text}</span>`
          : null}</span>
      </button>`)}
    </div>
  </section>`;
}

/* ---------- Tiles ---------- */

/** A bakje opened from a year shows the year's last month (bakje is per month). */
const bakjeQuery = (p) => (p.kind === 'year' ? (p.is_current ? {} : { period: p.last_period }) : p.is_current ? {} : { period: p.id });

function YearTiles({ o }) {
  const p = o.period;
  const pm = o.per_month || {};
  const py = o.previous_year;
  // Same months a year earlier; for the running year scaled to the days seen so far.
  const scale = p.ytd && p.days_total ? p.day_index / p.days_total : 1;
  const perMonth = (c) => `${euros(c)} per maand`;
  return html`<div class="tiles">
    <${Tile} label="Inkomen" icon="euro" color="green" cents=${o.income_cents} sub=${perMonth(pm.income_cents || 0)} />
    <${Tile} label="Vaste lasten" icon="vaste-lasten" color="indigo" cents=${o.fixed_cents} sub=${perMonth(pm.fixed_cents || 0)}
      onClick=${() => navigate('/vaste-lasten')} />
    <${Tile} label="Dagelijks" icon="creditcard" color="blue" cents=${o.daily_cents}
      sub=${py ? `vorig jaar ${euros(Math.round(py.daily_cents * scale))}` : perMonth(pm.daily_cents || 0)} />
    <${Tile} label="Gespaard" icon="piggy" color="teal" cents=${o.saved_cents} sub=${perMonth(pm.saved_cents || 0)}
      onClick=${() => navigate('/potjes')} />
  </div>`;
}

function Tiles({ o }) {
  const p = o.period;
  if (p.kind === 'year') return html`<${YearTiles} o=${o} />`;
  const exp = o.expected_income_cents;
  const fixedTotal = o.fixed_cents + (o.fixed_upcoming_cents || 0);
  const savedTotal = o.saved_cents + (o.saving_upcoming_cents || 0);
  return html`<div class="tiles">
    <${Tile} label="Inkomen" icon="euro" color="green" cents=${o.income_cents}
      progress=${p.is_current && exp ? o.income_cents / exp : null}
      sub=${p.is_current && exp ? `van ${euros(Math.max(exp, o.income_cents))}` : ''}
      onClick=${() => navigate('/transacties', { query: { period: p.id, flow: 'in' } })} />
    <${Tile} label="Vaste lasten" icon="vaste-lasten" color="indigo" cents=${o.fixed_cents}
      progress=${p.is_current && fixedTotal ? o.fixed_cents / fixedTotal : null}
      sub=${p.is_current ? (o.fixed_upcoming_cents > 0 ? `nog ${euros(o.fixed_upcoming_cents)}` : 'alles betaald') : ''}
      onClick=${() => navigate('/vaste-lasten')} />
    <${Tile} label="Dagelijks" icon="creditcard" color="blue" cents=${o.daily_cents}
      sub=${o.pace ? `normaal ${euros(p.is_current ? o.pace.typical[o.pace.actual.length - 1] || 0 : o.pace.typical.at(-1) || 0)}` : ''}
      onClick=${() => navigate('/transacties', { query: { period: p.id, flow: 'out' } })} />
    <${Tile} label="Gespaard" icon="piggy" color="teal" cents=${o.saved_cents}
      progress=${p.is_current && o.saving_upcoming_cents > 0 ? o.saved_cents / savedTotal : null}
      sub=${p.is_current && o.saving_upcoming_cents > 0 ? `nog ${euros(o.saving_upcoming_cents)}` : ''}
      onClick=${() => navigate('/potjes')} />
  </div>`;
}

function SortBanner({ n }) {
  return html`<div class="sort-banner">
    <span class="sort-banner-icon" aria-hidden="true">🗂️</span>
    <span class="sort-banner-text">${plural(n, 'winkel', 'winkels')} zonder bakje</span>
    <${Button} size="small" onClick=${() => navigate('/sorteren')}>Sorteren</${Button}>
  </div>`;
}

/* ---------- Waar het heen ging ---------- */

function chipFor(c, cat, p) {
  if (!c.avg_cents || !cat || cat.key === 'unsorted') return null;
  const daily = cat.grp === 'daily';
  if (p.is_current && !daily) return null;
  const normal = p.is_current ? c.avg_cents * (p.day_index / p.days_total) : c.avg_cents;
  const diff = c.spent_cents - normal;
  const clear = Math.abs(diff) >= Math.max(2500, normal * 0.2);
  if (!clear) return null;
  if (diff > 0) return { text: `${euros(diff)} meer`, tone: 'more' };
  if (p.is_current) return null; // "minder" mid-month just means the month is not over
  return { text: `${euros(-diff)} minder`, tone: 'less' };
}

function WhereItWent({ o }) {
  const [all, setAll] = useState(false);
  const p = o.period;
  const rows = o.categories
    .filter((c) => c.spent_cents > 0)
    .map((c) => {
      const cat = categoryById(c.category_id) || { name: 'Onbekend', emoji: '❔', color: 'gray', key: 'unsorted' };
      return {
        key: c.category_id,
        emoji: cat.emoji,
        color: cat.color,
        dashed: cat.key === 'unsorted',
        label: cat.name,
        value: c.spent_cents,
        chip: chipFor(c, cat, p),
        onClick: () => navigate(`/overzicht/bakje/${c.category_id}`, { query: bakjeQuery(p) }),
      };
    });
  if (!rows.length) return null;
  const total = rows.reduce((s, r) => s + r.value, 0);
  const shown = all || rows.length <= 7 ? rows : rows.slice(0, 6);
  return html`<${Section} title="Waar het heen ging" trailing=${html`<span class="section-value num"><span class="ov-total-lbl">alles samen</span> ${euros(total)}</span>`}>
    <div class="capsule-wrap"><${StackedCapsule} segments=${rows} label="Uitgaven per bakje" /></div>
    <${RankedBars} rows=${shown} />
    ${shown.length < rows.length && html`<button class="show-all" onClick=${() => setAll(true)}>
      Toon alle ${rows.length}</button>`}
  </${Section}>`;
}

/* ---------- Insights ---------- */

/** "…" / right-click menu of an insight: hide this one (undo), or switch the kind off. */
function insightMenu(i, e, context = false) {
  const items = [
    { label: 'Niet meer tonen', icon: 'xmark', onSelect: () => {
      const undo = commitLater('insight:' + i.id, () => api.dismissInsight(i.id));
      toast({ text: 'Melding verborgen', icon: 'check', action: { label: 'Herstel', onClick: undo } });
    } },
    i.kind && { label: 'Dit soort meldingen uitzetten', icon: 'minus', onSelect: async () => {
      try {
        await api.muteInsight(i.kind, true);
        invalidate();
        toast({ text: 'Dit soort meldingen staat uit', icon: 'check', action: { label: 'Herstel', onClick: async () => {
          try { await api.muteInsight(i.kind, false); invalidate(); } catch (err) { toast({ text: err.message, icon: 'warning' }); }
        } } });
      } catch (err) { toast({ text: err.message, icon: 'warning' }); }
    } },
  ].filter(Boolean);
  if (context) openContextMenu(e, items); else openMenu(e.currentTarget, items);
}

function Insights({ o, desk = false }) {
  const pending = usePending();
  const items = o.insights.filter((i) => !(i.kind === 'unsorted' && o.unsorted.merchants > 0) && !pending.has('insight:' + i.id)).slice(0, 3);
  if (!items.length) return null;
  const more = (i) => html`<button class="insight-more" aria-label="Opties voor deze melding" data-tip="Opties" aria-haspopup="menu"
    onClick=${(e) => { e.stopPropagation(); insightMenu(i, e); }}><${Icon} name="ellipsis" size=${16} stroke=${2.2} /></button>`;
  if (desk) {
    return html`<section class="dk-card ov-ins" aria-labelledby="ov-ins-h">
      <div class="dk-card-h"><h2 id="ov-ins-h">Opvallend</h2></div>
      <ul class="ov-ins-list">${items.map((i) => html`<li key=${i.id} class="ov-ins-li" onContextMenu=${(e) => insightMenu(i, e, true)}>
        <button class=${'ov-ins-row tone-' + i.tone} onClick=${() => openLink(i.href || i.link)}>
          <span class="ov-ins-emoji" aria-hidden="true">${i.emoji}</span>
          <span class="ov-ins-title">${i.title}</span>
        </button>
        ${more(i)}
      </li>`)}</ul>
    </section>`;
  }
  return html`<${Section} title="Opvallend" class="insights-section">
    <div class="insights" role="list">
      ${items.map((i) => html`<div role="listitem" class="insight-wrap" key=${i.id} onContextMenu=${(e) => insightMenu(i, e, true)}>
        <button class=${'insight card is-pressable tone-' + i.tone} onClick=${() => openLink(i.href || i.link)}>
          <span class="insight-emoji" aria-hidden="true">${i.emoji}</span>
          <span class="insight-title">${i.title}</span>
        </button>
        ${more(i)}
      </div>`)}
    </div>
  </${Section}>`;
}

/* ---------- Binnenkort ---------- */

function DateBadge({ iso }) {
  const d = parseISO(iso);
  return html`<span class="datebadge" aria-hidden="true">
    <span class="db-month">${MONTHS_SHORT[d.getUTCMonth()]}</span>
    <span class="db-day">${d.getUTCDate()}</span>
  </span>`;
}

function Upcoming({ o, desk = false }) {
  // Savings transfers are not vaste lasten: Binnenkort lists fixed costs (and income) only.
  const list = (o.upcoming || []).filter((u) => categoryById(u.category_id)?.grp !== 'saving');
  if (!o.period.is_current || !list.length) return null;
  const items = list.slice(0, 5);
  const today = todayISO();
  if (desk) {
    return html`<section class="dk-card ov-up" aria-labelledby="ov-up-h">
      <div class="dk-card-h"><h2 id="ov-up-h">Binnenkort</h2><button class="dk-link" onClick=${() => navigate('/vaste-lasten')}>Alle vaste lasten</button></div>
      <ul class="ov-up-list">${items.map((u) => {
        const cat = categoryById(u.category_id);
        return html`<li class="ov-up-row" key=${u.key}>
          <${DateBadge} iso=${u.date} />
          <span class="ov-up-main"><span class="ov-up-name">${u.name}</span><span class="ov-up-sub">${cat ? cat.name : relativeDays(u.date, today)}</span></span>
          <span class="num ov-up-amt">${money(u.amount_cents)}</span>
        </li>`;
      })}</ul>
    </section>`;
  }
  return html`<${Section} title="Binnenkort">
    <${List}>
      ${items.map((u) => {
        const cat = categoryById(u.category_id);
        return html`<${ListRow} key=${u.key} leading=${html`<${DateBadge} iso=${u.date} />`} title=${u.name}
          subtitle=${cat ? cat.name : relativeDays(u.date, today)}
          value=${html`<span class="num">${money(u.amount_cents)}</span>`} />`;
      })}
      <${ListRow} title="Alle vaste lasten" tint chevron onClick=${() => navigate('/vaste-lasten')} />
    </${List}>
  </${Section}>`;
}

/* ---------- Potjes ---------- */

function PotjesPeek({ goals, desk = false }) {
  if (!goals?.length) return null;
  const items = goals.slice(0, 4);
  if (desk) {
    return html`<section class="dk-card ov-pots" aria-labelledby="ov-pots-h">
      <div class="dk-card-h"><h2 id="ov-pots-h">Potjes</h2><button class="dk-link" onClick=${() => navigate('/potjes')}>Alle potjes</button></div>
      <div class="ov-pots-grid">${items.map((g) => html`<button class="peek-item" key=${g.id} onClick=${() => navigate(`/potjes/${g.id}`)}
          aria-label=${`${g.name}, ${euros(g.saldo_cents)}, ${Math.round(g.progress * 100)} procent`}>
        <${ProgressRing} value=${g.progress} color=${g.color} size=${60} stroke=${7} emoji=${g.emoji} label=${`${g.name}, ${Math.round(g.progress * 100)} procent`} />
        <span class="peek-name">${g.name}</span>
        <span class="peek-sub num">${euros(g.saldo_cents)}</span>
      </button>`)}</div>
    </section>`;
  }
  return html`<${Section} title="Potjes" link=${{ label: 'Alle', onClick: () => navigate('/potjes') }}>
    <${Card} class="potjes-peek" onClick=${() => navigate('/potjes')} label="Open potjes">
      ${items.map((g) => html`<span class="peek-item" key=${g.id}>
        <${ProgressRing} value=${g.progress} color=${g.color} size=${68} stroke=${8} emoji=${g.emoji}
          label=${`${g.name}, ${Math.round(g.progress * 100)} procent`} />
        <span class="peek-name">${g.name}</span>
        <span class="peek-sub num">${euros(g.saldo_cents)}</span>
      </span>`)}
    </${Card}>
  </${Section}>`;
}

/* ---------- Skeleton ---------- */

function OverzichtSkeleton({ desk = false }) {
  if (desk) {
    return html`<div class="ov-body ov-dash dk-grid ov-skeleton" aria-busy="true" aria-label="Laden">
      <div class="dk-col-7 dk-card ov-hero-card">
        <${Skeleton} w=${120} h=${14} /><${Skeleton} w=${220} h=${48} r=${10} style=${{ margin: '10px 0' }} />
        <${Skeleton} w=${180} h=${14} /><${Skeleton} h=${220} r=${10} style=${{ marginTop: '18px' }} />
      </div>
      <div class="dk-col-5 ov-tiles-col"><div class="tiles">${[0, 1, 2, 3].map(() => html`<div class="tile card"><${Skeleton} w="55%" h=${13} /><${Skeleton} w="70%" h=${24} style=${{ marginTop: '10px' }} /></div>`)}</div></div>
      <div class="dk-col-7 dk-card"><${Skeleton} w=${180} h=${20} /><${Skeleton} h=${12} style=${{ margin: '16px 0' }} />${[0, 1, 2, 3, 4, 5].map(() => html`<${Skeleton} h=${18} style=${{ margin: '14px 0' }} />`)}</div>
      <div class="dk-col-5 dk-card"><${Skeleton} w=${120} h=${20} />${[0, 1, 2].map(() => html`<${Skeleton} h=${40} r=${10} style=${{ marginTop: '12px' }} />`)}</div>
    </div>`;
  }
  return html`<div class="ov-body ov-skeleton" aria-busy="true" aria-label="Laden">
    <div class="hero"><div class="hero-inner">
      <${Skeleton} w=${120} h=${15} />
      <${Skeleton} w=${200} h=${52} r=${12} style=${{ margin: '10px 0 10px' }} />
      <${Skeleton} w=${170} h=${15} />
      <${Skeleton} h=${64} r=${10} style=${{ marginTop: '18px' }} />
    </div></div>
    <div class="tiles">${[0, 1, 2, 3].map(() => html`<div class="tile card"><${Skeleton} w="55%" h=${14} /><${Skeleton} w="70%" h=${24} style=${{ marginTop: '10px' }} /></div>`)}</div>
    <div class="section"><${Skeleton} w=${180} h=${22} /><${Skeleton} h=${12} r=${6} style=${{ margin: '16px 0' }} />
      <div class="inset">${[0, 1, 2, 3, 4].map(() => html`<div class="row has-lead"><span class="row-lead"><${Skeleton} w=${36} h=${36} r=${9} /></span><span class="row-main"><${Skeleton} w="50%" h=${15} /></span></div>`)}</div>
    </div>
  </div>`;
}
