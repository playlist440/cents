// Overzicht (DESIGN §3): hero "Nog te besteden tot <salarisdatum>" (breakdown popover) with
// the 3-month average, the buffer bar and the pace chart ("Dagelijkse uitgaven – nog over"),
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
      <${Health} h=${data.health} />
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
 *  normal month's total and run down; actual may go below zero (more than a normal month).
 *  Without a "normaal" there is nothing to be left of: cumulative spending as it is. */
function leftPace(pace) {
  if (!pace) return null;
  if (!pace.typical?.length) return { ...pace, left: false };
  const budget = pace.typical.at(-1) || 0;
  const left = (v) => budget - v;
  return { ...pace, left: true, actual: pace.actual.map(left), typical: pace.typical.map(left) };
}

/** "op koers" / "€ X boven normaal" for the daily spending so far (current month). */
function paceStatus(pace) {
  if (!pace?.typical?.length || !pace.actual.length) return null;
  const i = pace.actual.length - 1;
  const diff = pace.actual[i] - (pace.typical[i] || 0);
  const margin = Math.max(2500, 0.1 * (pace.typical[i] || 0));
  if (diff <= margin) return { text: 'op koers', warn: false };
  return { text: `${euros(diff)} boven normaal`, warn: true };
}

/** One definition of a month's result: income − fixed − daily (saving is not spending). */
const resultOf = (o) => o.result_cents ?? o.income_cents - o.fixed_cents - o.daily_cents;

function heroModel(o) {
  const p = o.period;
  if (p.kind === 'year') {
    const r = resultOf(o);
    return {
      label: `${r >= 0 ? 'Over' : 'Tekort'} in ${yearLabel(p.id)}`,
      cents: Math.abs(r),
      warn: r < 0,
      sub: `${euros(o.income_cents)} inkomen · ${euros(o.fixed_cents + o.daily_cents)} uitgegeven`,
    };
  }
  const daysLeft = p.days_total - p.day_index + 1;
  if (p.is_current && o.free) {
    const f = o.free;
    const sub = [];
    if (f.as_of) sub.push(`betaalrekening ${shortDate(f.as_of)}`);
    if (f.salary_pending) sub.push('salaris nog niet verwerkt — importeer');
    else if (f.stale) sub.push('saldo verouderd — importeer');
    if (f.savings?.free_cents > 0) sub.push(`${euros(f.savings.free_cents)} vrij spaargeld`);
    return {
      label: `Nog te besteden tot ${shortDate(f.payday)}`,
      cents: f.total_cents,
      warn: f.total_cents < 0,
      // the whole day budget for daily spending (normal pace + what is left), not the extra
      perDay: f.day_budget_cents ?? null,
      normalDay: f.daily_rate_cents,
      sub: sub.join(' · '),
      free: f,
    };
  }
  if (p.is_current) {
    return { label: 'Uitgegeven', cents: o.fixed_cents + o.daily_cents, sub: daysLeft === 1 ? 'laatste dag' : `nog ${daysLeft} dagen` };
  }
  const r = resultOf(o);
  return {
    label: r >= 0 ? 'Over' : 'Tekort',
    cents: Math.abs(r),
    warn: r < 0,
    sub: `${euros(o.income_cents)} inkomen · ${euros(o.fixed_cents + o.daily_cents)} uitgegeven`,
  };
}

/** Breakdown of Nog te besteden: the checking balance(s) with their date, every deduction, the
 *  (signed) total; then the savings next to it (minus potjes and buffer = vrij spaargeld). */
function FreeBreakdown({ f }) {
  const card = f.card_settlement;
  const rows = [
    ...f.accounts.map((a) => [a.name, a.balance_cents, a.as_of ? `saldo ${shortDate(a.as_of)}${a.stale ? ' · verouderd' : ''}` : 'handmatig saldo', a.stale]),
    ['Vaste lasten', -f.fixed_until_payday_cents, `tot ${shortDate(f.payday)}`],
    ...(f.fixed_overdue || []).map((x) => [x.name, -x.cents, `verwacht ${shortDate(x.date)}, nog niet afgeschreven`]),
    f.saving_until_payday_cents > 0 && ['Sparen en beleggen', -f.saving_until_payday_cents, 'gaat vast naar je spaar- of beleggingsrekening'],
    f.credit_cents > 0 && ['Creditcard', -f.credit_cents, 'aankopen nog niet afgerekend'],
    card && ['Creditcard-afrekening', -card.cents, `verwacht ${shortDate(card.date)}`],
    ['Dagelijkse uitgaven', -f.daily_until_payday_cents, `${plural(f.daily_days, 'dag', 'dagen')} × ${euros(f.daily_rate_cents)} normaal`],
  ].filter(Boolean);
  const s = f.savings;
  const savingRows = s && [
    ...s.accounts.map((a) => [a.name, a.balance_cents, a.as_of ? `saldo ${shortDate(a.as_of)}${a.stale ? ' · verouderd' : ''}` : 'handmatig saldo', a.stale]),
    s.goals_cents > 0 && ['Potjes', -s.goals_cents, 'staat opzij'],
    s.buffer_cents > 0 && ['Buffer', -s.buffer_cents, 'voor onverwachte uitgaven'],
  ].filter(Boolean);
  const neg = f.total_cents < 0;
  const Row = ([label, cents, note, warn]) => html`<div class="free-row" key=${label}>
    <dt>${label}${note && html`<span class=${'free-note' + (warn ? ' c-warn' : '')}>${note}</span>`}</dt>
    <dd class="num">${money(cents, { whole: true, negative: true })}</dd>
  </div>`;
  return html`<div class="free-pop">
    <dl class="free-rows">
      ${rows.map(Row)}
      <div class="free-row is-total"><dt>Nog te besteden</dt><dd class=${'num' + (neg ? ' is-warn' : '')}>${money(f.total_cents, { whole: true, negative: true })}</dd></div>
    </dl>
    ${f.day_budget_cents > 0 && html`<p class="free-foot">Tot ${shortDate(f.payday)} is dat ongeveer ${euros(f.day_budget_cents)} per dag voor dagelijkse uitgaven. Normaal geven jullie ${euros(f.daily_rate_cents)} per dag uit.</p>`}
    ${neg && html`<p class="free-foot">Bij een normaal tempo reikt het geld op de betaalrekening niet tot ${shortDate(f.payday)}.</p>`}
    ${f.salary_pending && html`<p class="free-foot c-warn">Salaris van ${shortDate(f.payday)} nog niet verwerkt — importeer.</p>`}
    ${f.payday_source === 'period' && html`<p class="free-foot">Salaris niet herkend: tot het einde van de maand.</p>`}
    ${savingRows && html`<dl class="free-rows free-savings" aria-label="Spaargeld">
      ${savingRows.map(Row)}
      <div class="free-row is-total"><dt>Vrij spaargeld<span class="free-note">telt niet mee in Nog te besteden</span></dt><dd class="num">${money(s.free_cents, { whole: true })}</dd></div>
    </dl>`}
    <button class="dk-link free-link" onClick=${() => navigate('/instellingen/aannames')}>Aannames aanpassen</button>
  </div>`;
}

const openFree = (e, f) => openPopover(e.currentTarget, () => html`<${FreeBreakdown} f=${f} />`, { width: 310, label: 'Opbouw nog te besteden' });

/** Mean monthly result (income − fixed − daily) of the last three months + 12-month mini bars. */
function Tempo({ t }) {
  if (!t) return html`<div class="tempo is-quiet">Gemiddelde per maand volgt na twee volle maanden</div>`;
  const over = t.avg_net_cents >= 0;
  const text = over ? `+ ${euros(t.avg_net_cents)} over` : `${euros(-t.avg_net_cents)} tekort`;
  return html`<div class="tempo">
    <span class="tempo-main">
      <span class="tempo-label">Gemiddeld per maand ${over ? 'over' : 'tekort'} (${t.periods} mnd)</span>
      <span class=${'tempo-value num' + (over ? '' : ' is-warn')}>${text}</span>
    </span>
    <${NetBars} months=${t.months} />
  </div>`;
}

/** "Buffer € X van € Y · Z maanden" with a thin progress bar. */
function BufferBar({ b }) {
  if (!b || !b.target_cents) return null;
  const share = Math.max(0, Math.min(1, b.saved_cents / b.target_cents));
  const months = b.months != null ? ` · ${String(b.months).replace('.', ',')} ${b.months === 1 ? 'maand' : 'maanden'}` : '';
  const label = `Buffer ${euros(b.saved_cents)} van ${euros(b.target_cents)}${months}`;
  return html`<button class="buffer" onClick=${() => navigate(b.goal_id ? `/potjes/${b.goal_id}` : b.source === 'potje' ? '/potjes' : '/instellingen/aannames')} aria-label=${label}>
    <span class="buffer-text num">${label}</span>
    <span class="buffer-track" aria-hidden="true"><span class=${'buffer-fill' + (share < 1 ? ' is-short' : '')} style=${{ width: `${Math.max(2, share * 100)}%` }}></span></span>
  </button>`;
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
  const label = 'Over of tekort per maand: ' + months.map((m) => `${MONTHS[Number(m.period.slice(5)) - 1]} ${money(m.net_cents, { whole: true, negative: true })}`).join(', ');
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
  const status = p.is_current ? paceStatus(o.pace) : null;
  const paceTitle = pace?.left ? 'Dagelijkse uitgaven – nog over' : 'Dagelijkse uitgaven';
  const actualLabel = pace?.left ? 'Nog over' : 'Uitgegeven';
  const paceLabel = !pace ? '' : pace.left
    ? `Dagelijkse uitgaven, nog over van een normale maand ${monthLabel(p.id)}: ${money(pace.actual.at(-1) || 0, { whole: true, negative: true })} ${p.is_current ? 'nu' : 'aan het eind'}, normaal ${euros(pace.typical[pace.actual.length - 1] || 0)}`
    : `Dagelijkse uitgaven ${monthLabel(p.id)}: ${euros(pace.actual.at(-1) || 0)} uitgegeven`;

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
        ? html`<div class="hero-row">
          <button class=${'hero-amount rounded is-button' + (m.warn ? ' is-warn' : '')} aria-haspopup="dialog"
            aria-label=${`${m.label}: ${money(m.cents, { whole: true, negative: true })}. ${m.sub}. Toon opbouw`} onClick=${(e) => openFree(e, m.free)}>
            <${Amount} key=${p.id} cents=${m.cents} whole animate negative />
            <span class="hero-info" aria-hidden="true"><${Icon} name="info" size=${18} stroke=${2} /></span>
          </button>
          ${m.perDay > 0 && html`<span class=${'hero-perday num' + (m.perDay < m.normalDay ? ' is-low' : '')}
            title=${`Normaal geven jullie ${euros(m.normalDay)} per dag uit`}
            aria-label=${`Ongeveer ${euros(m.perDay)} per dag voor dagelijkse uitgaven, normaal ${euros(m.normalDay)}`}>≈ ${euros(m.perDay)} per dag<span class="hero-perday-norm">normaal ${euros(m.normalDay)}</span></span>`}
        </div>`
        : html`<div class=${'hero-amount rounded' + (m.warn ? ' is-warn' : '')}>
            <${Amount} key=${p.id} cents=${m.cents} whole animate negative />
          </div>`}
      <div class="hero-sub num">${m.sub}</div>
      ${p.is_current && m.free && html`<${Tempo} t=${o.tempo} /><${BufferBar} b=${o.buffer} />`}
      ${p.kind === 'year' && o.months?.length > 0 && html`<${YearBars} o=${o} desk=${desk} />`}
      ${pace && html`<div class="hero-pace">
        <div class="pace-head">
          <span class="pace-title">${paceTitle}</span>
          ${status && html`<span class=${'pace-status' + (status.warn ? ' is-warn' : '')}>${status.text}</span>`}
        </div>
        ${desk
          ? html`<${PaceChart} actual=${pace.actual} typical=${pace.left ? pace.typical : []} label=${paceLabel} showToday=${p.is_current} actualLabel=${actualLabel}
              height=${220} axis interactive dayLabel=${(i, long) => paceDay(p, i, long)} />`
          : html`<${PaceChart} actual=${pace.actual} typical=${pace.left ? pace.typical : []} label=${paceLabel} showToday=${p.is_current} actualLabel=${actualLabel} />`}
        <div class="pace-legend" aria-hidden="true">
          <span><i class="lg-solid"></i>${monthSmart(p.id)}</span>
          ${pace.left && html`<span><i class="lg-dot"></i>normaal</span>`}
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
    const n = months[i] ? resultOf(months[i]) : 0;
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
      <${Health} h=${o.health} desk />
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
    <${Tile} label="Gespaard" icon="piggy" color="teal" cents=${o.saved_cents} sub=${withRepaid(perMonth(pm.saved_cents || 0), o)}
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
      sub=${p.is_current && !o.income_cents && o.salary_expected ? `salaris verwacht ${shortDate(o.salary_expected)}`
        : p.is_current && exp ? `van ${euros(Math.max(exp, o.income_cents))}` : ''}
      onClick=${() => navigate('/transacties', { query: { period: p.id, flow: 'in' } })} />
    <${Tile} label="Vaste lasten" icon="vaste-lasten" color="indigo" cents=${o.fixed_cents}
      progress=${p.is_current && fixedTotal ? o.fixed_cents / fixedTotal : null}
      sub=${p.is_current ? fixedSub(o) : ''}
      onClick=${() => navigate('/vaste-lasten')} />
    <${Tile} label="Dagelijks" icon="creditcard" color="blue" cents=${o.daily_cents}
      sub=${o.pace ? `normaal ${euros(p.is_current ? o.pace.typical[o.pace.actual.length - 1] || 0 : o.pace.typical.at(-1) || 0)}` : ''}
      onClick=${() => navigate('/transacties', { query: { period: p.id, flow: 'out' } })} />
    <${Tile} label="Gespaard" icon="piggy" color="teal" cents=${o.saved_cents}
      progress=${p.is_current && o.saving_upcoming_cents > 0 ? o.saved_cents / savedTotal : null}
      sub=${withRepaid(p.is_current && o.saving_upcoming_cents > 0 ? `netto · nog ${euros(o.saving_upcoming_cents)}` : 'netto gespaard', o)}
      onClick=${() => navigate('/potjes')} />
  </div>`;
}

/** Mortgage repaid counts as saved (SPEC §7.2); the Gespaard tile names it on its own line. */
const withRepaid = (sub, o) => (o.repaid_cents > 0
  ? html`${sub}<span class="tile-sub-line">waarvan afgelost ${euros(o.repaid_cents)}</span>` : sub);

/** "nog € X" counts only payments still to come; one whose date passed without showing up is
 *  "achterstallig?" (it may not be imported yet). */
function fixedSub(o) {
  const parts = [];
  if (o.fixed_upcoming_cents > 0) parts.push(`nog ${euros(o.fixed_upcoming_cents)}`);
  if (o.fixed_overdue_cents > 0) parts.push(`${euros(o.fixed_overdue_cents)} achterstallig?`);
  return parts.length ? parts.join(' · ') : 'alles betaald';
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
          <span class="ov-up-main"><span class="ov-up-name">${u.name}</span><span class=${'ov-up-sub' + (u.overdue ? ' c-warn' : '')}>${u.overdue ? 'achterstallig?' : cat ? cat.name : relativeDays(u.date, today)}</span></span>
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
          subtitle=${u.overdue ? html`<span class="c-warn">achterstallig?</span>` : cat ? cat.name : relativeDays(u.date, today)}
          value=${html`<span class="num">${money(u.amount_cents)}</span>`} />`;
      })}
      <${ListRow} title="Alle vaste lasten" tint chevron onClick=${() => navigate('/vaste-lasten')} />
    </${List}>
  </${Section}>`;
}

/* ---------- Hoe staan we ervoor ---------- */

const pctText = (x) => (x == null ? '–' : `${Math.round(x * 100)} %`);
const monthsText = (m) => `${String(m).replace('.', ',')} ${m === 1 ? 'maand' : 'maanden'}`;

/** Five calm read-outs about the household, each with one plain sentence (no traffic lights).
 *  Averages over the last up to twelve complete months (health in services/health.py). */
function healthRows(h) {
  const rows = [];
  const b = h.buffer;
  rows.push({
    key: 'buffer', emoji: '🛟', color: 'teal', title: 'Buffer',
    value: b?.months != null ? monthsText(b.months) : 'Nog geen',
    text: b?.target_months
      ? `Spaargeld voor onverwachte uitgaven, in maanden vaste lasten. Jullie doel is ${monthsText(b.target_months)}.`
      : 'Spaargeld voor onverwachte uitgaven. Veel huishoudens houden 3 maanden vaste lasten aan.',
    to: b?.source === 'potje' ? '/potjes' : '/instellingen/aannames',
  });
  if (h.income_cents > 0) {
    rows.push({
      key: 'housing', emoji: '🏠', color: 'orange', title: 'Woonlasten', value: pctText(h.housing.share),
      text: `Van je inkomen gaat ${euros(h.housing.cents)} per maand naar hypotheek of huur, energie en gemeentelijke lasten.`,
      to: '/vaste-lasten',
    });
    rows.push({
      key: 'fixed', emoji: '📌', color: 'indigo', title: 'Vaste lasten', value: pctText(h.fixed.share),
      text: h.fixed.rest_cents >= 0
        ? `Van je inkomen gaat ${euros(h.fixed.cents)} per maand naar vaste lasten. Er blijft ${euros(h.fixed.rest_cents)} over voor boodschappen, sparen en de rest.`
        : `Jullie vaste lasten zijn ${euros(-h.fixed.rest_cents)} per maand hoger dan wat er binnenkomt.`,
      to: '/vaste-lasten',
    });
    const sv = h.saving;
    const repaid = sv.repaid_cents > 0 ? ` Daarnaast lossen jullie ${euros(sv.repaid_cents)} per maand af.` : '';
    rows.push({
      key: 'saving', emoji: '🐷', color: 'pink', title: 'Sparen',
      value: sv.cents > 0 ? pctText(sv.share) : 'Niets opzij',
      text: sv.cents >= 0
        ? `Van je inkomen gaat ${euros(sv.cents)} per maand naar sparen en beleggen. Een veelgebruikte vuistregel is 10 %.${repaid}`
        : `Er ging gemiddeld ${euros(-sv.cents)} per maand meer van de spaarrekening af dan erop.${repaid}`,
      to: '/potjes',
    });
  }
  const d = h.debts;
  const others = d.items.filter((x) => x.kind !== 'mortgage');
  rows.push({
    key: 'debts', emoji: '🧾', color: 'gray', title: 'Schulden',
    value: d.known ? euros(d.total_cents) : 'Geen bekend',
    text: !d.known ? 'Een lening, studieschuld of achteraf betalen? Zet hem bij Vermogen, dan telt hij mee.'
      : others.length ? d.items.map((x) => `${x.name} ${euros(x.cents)}`).join(' · ')
        : 'Alleen de hypotheek. Een andere lening of achteraf betalen? Zet hem bij Vermogen.',
    to: '/vermogen',
  });
  return rows;
}

function Health({ h, desk = false }) {
  if (!h) return null;
  const rows = healthRows(h);
  const sub = `Gemiddeld per maand, ${h.months >= 12 ? 'afgelopen 12 maanden' : `afgelopen ${plural(h.months, 'maand', 'maanden')}`}`;
  const list = html`<ul class="inset ov-hl">${rows.map((r) => html`<${ListRow} key=${r.key} class="ov-hl-row" emoji=${r.emoji} color=${r.color}
      title=${html`<span class="ov-hl-title">${r.title}</span><span class="ov-hl-value num">${r.value}</span>`}
      subtitle=${r.text} chevron onClick=${() => navigate(r.to)} label=${`${r.title}: ${r.value}. ${r.text}`} />`)}</ul>`;
  if (desk) {
    return html`<section class="dk-card ov-health" aria-labelledby="ov-hl-h">
      <div class="dk-card-h"><h2 id="ov-hl-h">Hoe staan we ervoor</h2></div>
      <p class="ov-hl-sub">${sub}</p>
      ${list}
    </section>`;
  }
  return html`<${Section} title="Hoe staan we ervoor" id="ov-hl-h" class="ov-health">
    ${list}
    <p class="list-footer">${sub}</p>
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
