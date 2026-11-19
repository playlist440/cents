// Vaste lasten (DESIGN §3, §5; SPEC §14).
//
// Two views, chosen in the toolbar (phone: under the hero) and kept in the URL
// (`#/vaste-lasten?view=kalender&period=2026-12`):
//   Lijst     hero per month / per year + share of income + subscriptions line, then the items in
//             four sections with subtotals: Vaste lasten (fixed bakjes = the hero total), Ook elke
//             maand (recurring in daily bakjes), Sparen en beleggen, Inkomen. Mac: one sortable
//             table (Naam, Volgende, Per maand, Per jaar); the inspector opens only on selection.
//   Kalender  GET /calendar: Mac = month grid ma–zo for the period's real date range, phone = an
//             agenda. Paid ✓ muted, expected normal, missed orange "niet gezien", income green.
// Item details (history bars, payments, "Geen vaste last") in the inspector or a sheet.

import { Iban } from '../components/Iban.js';
import { useTable, SortHead, TableTools } from '../components/SortableTable.js';
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery, useStore, categoryById } from '../store.js';
import { openSheet, replaceQuery } from '../router.js';
import { euros, money, shortDate, percent, freqLabel, capitalize, addDays, daysBetween, parseISO, todayISO, dayLabel, longDate, shiftPeriod, plural, MONTHS_SHORT } from '../format.js';
import { Screen } from '../components/Screen.js';
import { Amount } from '../components/Amount.js';
import { Segmented, Button } from '../components/Controls.js';
import { Skeleton, EmptyState } from '../components/Feedback.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { Sheet } from '../components/Sheet.js';
import { List } from '../components/List.js';
import { TxRow } from '../components/TxRow.js';
import { MonthSwitcher } from '../components/MonthSwitcher.js';
import { openPopover } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { BarChart } from '../charts/BarChart.js';
import { openTransaction } from '../shell/actions.js';
import { colorVar } from '../colors.js';
import { commitLater, usePending } from './_kit.js';
import { useDrawIn } from '../anim.js';
import { useLayout, useMedia } from '../hooks.js';
import { Icon } from '../icons.js';

const VIEWS = [['lijst', 'Lijst'], ['kalender', 'Kalender']];

/** Section of an item: by bakje group and direction. */
const SECTIONS = [
  { id: 'fixed', title: 'Vaste lasten' },
  { id: 'daily', title: 'Ook regelmatig, buiten de vaste lasten' },
  { id: 'saving', title: 'Sparen en potjes' },
  { id: 'income', title: 'Vast inkomen' },
];
function sectionOf(it) {
  const g = categoryById(it.category_id)?.grp;
  // to or from your own account (savings, potjes, terugstorten): never income or a fixed cost
  if (it.own_account || g === 'saving') return 'saving';
  if (it.direction === 'in') return 'income';
  if (g === 'fixed') return 'fixed';
  return 'daily';
}
const perYear = (it) => it.per_year_cents ?? Math.abs(it.per_month_cents) * 12;
const live = (it) => it.status !== 'ended';

export function VasteLasten({ query = {} }) {
  const view = query.view === 'kalender' ? 'kalender' : 'lijst';
  const boot = useStore((s) => s.boot);
  const cur = boot?.periods?.current;
  const period = view === 'kalender' && /^\d{4}-\d{2}$/.test(query.period || '') ? query.period : cur;
  const { data, error, reload } = useQuery('recurring', () => api.recurring());
  const [sel, setSel] = useState(null); // { key, cal? }
  const pending = usePending();
  const desk = useLayout() === 'wide';
  // The inspector sits next to the table from 1400 px (room for all columns); below that it is a sheet.
  const side = useMedia('(min-width: 1400px)') && desk;

  const setView = (v) => { setSel(null); replaceQuery({ view: v === 'lijst' ? undefined : v, period: undefined }); };
  const setPeriod = (p) => { setSel(null); replaceQuery({ period: p === cur ? undefined : p }); };

  // Esc closes the inspector (Mac).
  useEffect(() => { if (!side) setSel(null); }, [side]);
  useEffect(() => {
    if (!sel || !side) return;
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.sheet-layer, .menu')) setSel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, side]);

  const seg = html`<${Segmented} value=${view} onChange=${setView} label="Weergave" options=${VIEWS} size=${desk ? 'small' : 'medium'} />`;
  const switcher = view === 'kalender' && cur && html`<${MonthSwitcher} value=${period} first=${boot.periods.first} last=${shiftPeriod(cur, 12)} onChange=${setPeriod} />`;
  const titleView = desk ? html`<div class="vl2-tbview">${seg}${switcher}</div>` : switcher || null;

  if (!data) {
    return html`<${Screen} title="Vaste lasten" titleView=${titleView} class="vl">
      ${error ? html`<${EmptyState} emoji="🔁" title="Vaste lasten laden niet" subtitle=${error.message} action=${{ label: 'Probeer opnieuw', variant: 'tinted', onClick: () => reload() }} />` : html`<${VLSkeleton} desk=${desk} />`}
    </${Screen}>`;
  }
  const items = (data.items || []).filter((i) => !pending.has('rec:' + i.key));
  const byKey = new Map(items.map((i) => [i.key, i]));
  const selItem = sel && side ? (byKey.get(sel.key) || calToItem(sel.cal)) : null;
  const choose = (key, cal = null) => {
    if (side) setSel(sel && sel.key === key && (sel.cal?.date ?? null) === (cal?.date ?? null) ? null : { key, cal });
    else openSheet(ItemSheet, { it: byKey.get(key) || calToItem(cal), cal });
  };

  const body = view === 'kalender'
    ? html`<${CalendarView} period=${period} desk=${desk} selKey=${sel?.key} selDate=${sel?.cal?.date} onPick=${(c) => choose(c.key, c)} />`
    : html`
      <${Hero} data=${data} items=${items} desk=${desk} />
      ${!desk && html`<div class="vl-seg">${seg}</div>`}
      ${items.length
        ? (desk ? html`<${VLTable} items=${items} selKey=${sel?.key} onSelect=${(it) => choose(it.key)} />` : html`<${Sections} items=${items} onPick=${(it) => choose(it.key)} />`)
        : html`<${EmptyState} emoji="🔁" title="Nog geen vaste lasten" />`}`;

  if (!desk) {
    return html`<${Screen} title="Vaste lasten" titleView=${titleView} class="vl">
      ${view === 'kalender' && html`<div class="vl-seg">${seg}</div>`}
      ${body}
    </${Screen}>`;
  }
  return html`<${Screen} title="Vaste lasten" titleView=${titleView} class="vl vl2" wide>
    <div class=${'vl2-split' + (selItem ? ' has-inspector' : '')}>
      <div class="vl2-main">${body}</div>
      ${selItem && html`<aside class="vl2-inspector" aria-label=${selItem.name}>
        <button class="vl2-insp-close" aria-label="Sluit" data-tip="Sluit (Esc)" onClick=${() => setSel(null)}><${Icon} name="xmark" size=${13} stroke=${2.6} /></button>
        <${ItemDetail} key=${selItem.key + (sel.cal?.date || '')} it=${selItem} cal=${sel.cal} close=${() => setSel(null)} inline />
      </aside>`}
    </div>
  </${Screen}>`;
}

/** A calendar item that has no recurring item any more (ignored meanwhile): enough for the detail. */
function calToItem(c) {
  if (!c) return null;
  return { key: c.key, name: c.name, merchant_key: c.merchant_key, category_id: c.category_id, direction: c.direction, amount_cents: c.amount_cents, per_month_cents: c.amount_cents, frequency: null, status: 'active', next_date: null, last_date: null };
}

/* ---------- Hero ---------- */

function Hero({ data, items, desk = false }) {
  const month = data.monthly_out_cents;
  const year = data.yearly_out_cents ?? month * 12;
  // the one "x % van je inkomen" (Hoe staan we ervoor): real income over 12 months
  const share = data.share_of_income ?? (data.monthly_in_cents > 0 ? month / data.monthly_in_cents : null);
  const subs = data.subscriptions;
  const draw = useDrawIn([{ transform: 'scaleX(0)' }, {}], { duration: 900 });
  return html`<section class=${'vl-hero' + (desk ? ' is-desk' : '')} aria-label="Vaste lasten">
    <div class="vl-hero-amount rounded"><${Amount} cents=${month} whole animate /> <span class="vl-hero-unit">per maand</span></div>
    <div class="vl-hero-sub num">${euros(year)} per jaar${data.repaid_cents > 0 ? ` · waarvan ${euros(data.repaid_cents)} per maand aflossing` : ''}</div>
    ${share != null && html`<div class=${'vl-share' + (share > 0.6 ? ' is-high' : '')}>
      <span class="vl-share-track" aria-hidden="true"><span ref=${draw} style=${{ transform: `scaleX(${Math.min(1, share)})` }}></span></span>
      <span class="vl-share-label num">${percent(share)} van je inkomen${data.income_cents ? ` (gemiddeld ${euros(data.income_cents)} per maand)` : ''}</span>
    </div>`}
    ${subs?.count > 0 && html`<p class="vl2-subs num">${plural(subs.count, 'abonnement', 'abonnementen')} · ${euros(subs.per_month_cents)} per maand · ${euros(subs.per_year_cents)} per jaar</p>`}
  </section>`;
}

/* ---------- Mac: sortable table in sections ---------- */

const FREQ_ORDER = { weekly: 1, '2-weekly': 2, '4-weekly': 3, monthly: 4, quarterly: 5, 'half-year': 6, yearly: 7 };
export const VL_COLS = [
  { key: 'name', label: 'Naam', value: (i) => i.name },
  { key: 'cat', label: 'Bakje', value: (i) => categoryById(i.category_id)?.name || '' },
  { key: 'freq', label: 'Hoe vaak', order: ['vaakst eerst', 'minst vaak eerst'], value: (i) => FREQ_ORDER[i.frequency] || 0, num: false, text: (i) => freqLabel(i.frequency) || '' },
  { key: 'next', label: 'Volgende', date: true, value: (i) => i.next_date || '9999', text: (i) => (i.next_date ? shortDate(i.next_date) : '') },
  { key: 'month', label: 'Per maand', value: (i) => Math.abs(i.per_month_cents), num: true, text: (i) => money(Math.abs(i.per_month_cents)) },
  { key: 'year', label: 'Per jaar', value: (i) => perYear(i), num: true, text: (i) => euros(perYear(i)) },
];

function VLTable({ items, selKey, onSelect }) {
  const t = useTable('vaste-lasten', VL_COLS, { key: 'month', dir: -1 });
  const ref = useRef(null);
  // live items first (stable sort keeps the chosen order within them)
  const sorted = (list) => t.rows(list).sort((a, b) => live(b) - live(a));
  const sections = SECTIONS.map((s) => ({ ...s, rows: sorted(items.filter((i) => sectionOf(i) === s.id)) })).filter((s) => s.rows.length);
  const flat = sections.flatMap((s) => s.rows);
  const head = (key) => html`<${SortHead} t=${t} col=${VL_COLS.find((c) => c.key === key)} />`;
  const onKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const i = flat.findIndex((r) => r.key === selKey);
    const n = flat[Math.max(0, Math.min(flat.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!n) return;
    e.preventDefault();
    onSelect(n);
    requestAnimationFrame(() => ref.current?.querySelector(`[data-key="${CSS.escape(n.key)}"]`)?.focus());
  };
  return html`<div class="dk-card vl2-table">
    <${TableTools} t=${t} placeholder="Filter vaste lasten" />
    <div class="dt vl2-dt" role="grid" aria-label="Vaste lasten" onKeyDown=${onKey} ref=${ref}>
      <div class="dt-head" role="row">
        ${head('name')}${head('cat')}${head('freq')}${head('next')}${head('month')}${head('year')}
      </div>
      ${sections.map((s) => {
        const act = s.rows.filter(live);
        const pm = act.reduce((t, i) => t + Math.abs(i.per_month_cents), 0);
        const py = act.reduce((t, i) => t + perYear(i), 0);
        const inc = s.id === 'income';
        return html`<div class="vl2-section" role="rowgroup" key=${s.id} aria-label=${s.title}>
          <div class="vl2-sec-h" role="row">
            <span class="vl2-sec-title" role="rowheader">${s.title}<span class="vl2-sec-n num">${act.length}</span></span>
            <span></span><span></span><span></span>
            <span class=${'is-num num' + (inc ? ' is-income' : '')}>${money(pm, { whole: true, signed: inc })}</span>
            <span class=${'is-num num' + (inc ? ' is-income' : '')}>${money(py, { whole: true, signed: inc })}</span>
          </div>
          ${s.rows.map((it) => html`<${TableRow} key=${it.key} it=${it} selected=${it.key === selKey} onSelect=${onSelect} />`)}
        </div>`;
      })}
    </div>
  </div>`;
}

function TableRow({ it, selected, onSelect }) {
  const cat = categoryById(it.category_id) || { name: 'Overig', emoji: '📦', color: 'gray' };
  const ended = !live(it);
  const inc = it.direction === 'in';
  const freq = it.frequency && it.frequency !== 'monthly' ? freqLabel(it.frequency) : '';
  return html`<button role="row" data-key=${it.key} class=${'dt-row' + (selected ? ' is-selected' : '') + (ended ? ' is-ended' : '')}
      aria-selected=${selected ? 'true' : 'false'} onClick=${() => onSelect(it)}>
    <span class="dt-cell vl2-name" role="gridcell">
      <span class="vl2-title">${it.name}${it.repaid_per_month_cents > 0 ? html` <span class="vl2-repaid num">waarvan ${euros(it.repaid_per_month_cents)} aflossing</span>` : ''}</span>
      ${badges(it).map((x) => html`<span class=${'mini-chip tone-' + x.tone}>${x.text}</span>`)}
      ${freq && html`<span class="mini-chip tone-info vl2-freq-chip">${freq}</span>`}
    </span>
    <span class="dt-cell vl2-cat" role="gridcell"><${EmojiTile} emoji=${cat.emoji} color=${cat.color} size=${20} /><span>${cat.name}</span></span>
    <span class="dt-cell vl2-dim" role="gridcell">${freq}</span>
    <span class="dt-cell vl2-dim num" role="gridcell">${ended ? `laatst ${shortDate(it.last_date)}` : it.next_date ? shortDate(it.next_date) : ''}</span>
    <span class=${'dt-cell is-num num' + (inc ? ' is-income' : '')} role="gridcell">${it.variable ? 'ca. ' : ''}${money(Math.abs(it.per_month_cents ?? it.amount_cents), { signed: inc })}</span>
    <span class=${'dt-cell is-num num vl2-year' + (inc ? ' is-income' : '')} role="gridcell">${money(perYear(it), { whole: true, signed: inc })}</span>
  </button>`;
}

/* ---------- Phone: sections ---------- */

function Sections({ items, onPick }) {
  const t = useTable('vaste-lasten', VL_COLS, { key: 'month', dir: -1 });
  return html`<${TableTools} t=${t} menu placeholder="Filter vaste lasten" />${SECTIONS.map((s) => {
    const rows = t.rows(items.filter((i) => sectionOf(i) === s.id)).sort((a, b) => live(b) - live(a));
    if (!rows.length) return null;
    const act = rows.filter(live);
    const inc = s.id === 'income';
    return html`<section class="vl-group" key=${s.id} aria-label=${s.title}>
      <h2 class="vl-group-h">
        <span class="vl-group-name">${s.title}</span>
        <span class=${'vl-group-sum num' + (inc ? ' is-income' : '')}>${money(act.reduce((t, i) => t + Math.abs(i.per_month_cents), 0), { whole: true, signed: inc })} p/m</span>
      </h2>
      <ul class="inset">${rows.map((it) => html`<${ItemRow} key=${it.key} it=${it} onClick=${() => onPick(it)} />`)}</ul>
    </section>`;
  })}`;
}

function badges(it) {
  const out = [];
  if (it.status === 'new') out.push({ text: 'Nieuw', tone: 'good' });
  if (it.status === 'ended') out.push({ text: 'Gestopt?', tone: 'info' });
  if (it.change && it.status !== 'ended') {
    const d = Math.abs(it.change.to_cents) - Math.abs(it.change.from_cents);
    const more = it.direction === 'out' ? d > 0 : d < 0;
    if (Math.abs(d) >= 50) out.push({ text: `${Math.abs(d) >= 1000 ? euros(Math.abs(d)) : money(Math.abs(d))} ${d > 0 ? (it.direction === 'out' ? 'duurder' : 'meer') : (it.direction === 'out' ? 'goedkoper' : 'minder')}`, tone: more ? 'warn' : 'good' });
  }
  return out;
}

function ItemRow({ it, onClick }) {
  const ended = !live(it);
  const b = badges(it);
  const cat = categoryById(it.category_id) || { emoji: '📦', color: 'gray' };
  const amount = Math.abs(it.per_month_cents ?? it.amount_cents);
  const freq = it.frequency && it.frequency !== 'monthly' ? freqLabel(it.frequency) : null;
  return html`<li class="row-li"><button class=${'row is-two is-button has-lead vl-row' + (ended ? ' is-ended' : '')} onClick=${onClick}>
    <span class="row-lead"><${EmojiTile} emoji=${cat.emoji} color=${cat.color} size=${32} /></span>
    <span class="row-main">
      <span class="vl-row-top">
        <span class="row-title">${it.name}</span>
        ${b.map((x) => html`<span class=${'mini-chip tone-' + x.tone}>${x.text}</span>`)}
      </span>
      <span class="row-sub">
        <span class="vl-when">${ended ? `laatst ${shortDate(it.last_date)}` : `volgende ${shortDate(it.next_date)}`}${it.repaid_per_month_cents > 0 ? ` · waarvan ${euros(it.repaid_per_month_cents)} aflossing` : ''}</span>
        ${freq && html`<span class="mini-chip tone-info">${freq}</span>`}
      </span>
    </span>
    <span class=${'row-amount num' + (it.direction === 'in' ? ' is-income' : '')}>${it.variable ? 'ca. ' : ''}${money(amount, { signed: it.direction === 'in' })}</span>
  </button></li>`;
}

/* ---------- Kalender ---------- */

const WEEKDAYS = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
const STATUS_WORD = { paid: 'betaald', expected: 'verwacht', missed: 'niet gezien' };

function CalendarView({ period, desk, selKey, selDate, onPick }) {
  const { data, error, reload } = useQuery(`calendar:${period}`, () => api.getCalendar(period));
  if (error && !data) {
    return html`<${EmptyState} emoji="🗓️" title="Kalender laadt niet" subtitle=${error.message} action=${{ label: 'Probeer opnieuw', variant: 'tinted', onClick: () => reload() }} />`;
  }
  if (!data) return html`<${CalSkeleton} desk=${desk} />`;
  const o = data.out || {};
  const summary = html`<p class="vl2-cal-sum num" aria-live="polite">
    Al afgeschreven <b>${euros(o.paid_cents || 0)}</b> · Komt nog <b>${euros(o.expected_cents || 0)}</b>
    ${o.missed_cents > 0 && html` · <span class="vl2-missed-sum">Niet gezien <b>${euros(o.missed_cents)}</b></span>`}
  </p>`;
  if (!data.days?.length) {
    return html`${summary}<p class="vl2-cal-empty">Nog te weinig gegevens om deze maand te vullen.</p>`;
  }
  return html`${summary}${desk
    ? html`<${MonthGrid} data=${data} selKey=${selKey} selDate=${selDate} onPick=${onPick} />`
    : html`<${Agenda} data=${data} onPick=${onPick} />`}`;
}

function calItemLabel(c) {
  return `${c.name}, ${money(Math.abs(c.amount_cents), { signed: c.direction === 'in' })}, ${STATUS_WORD[c.status] || ''}`;
}

function CalItem({ c, selected, onPick, compact = true }) {
  const cat = categoryById(c.category_id) || { emoji: '📦', color: 'gray' };
  const inc = c.direction === 'in';
  return html`<button class=${'vl2-ci is-' + c.status + (inc ? ' is-in' : '') + (selected ? ' is-selected' : '') + (compact ? '' : ' is-wide')}
      onClick=${(e) => { e.stopPropagation(); onPick(c); }} aria-label=${calItemLabel(c)} title=${calItemLabel(c)} tabindex="-1">
    <${EmojiTile} emoji=${cat.emoji} color=${cat.color} size=${compact ? 16 : 22} />
    <span class="vl2-ci-name">${c.name}</span>
    <span class="vl2-ci-amt num">
      ${c.status === 'paid' && html`<${Icon} name="check" size=${10} stroke=${3} />`}
      ${c.status === 'missed' && html`<i class="vl2-dot" aria-hidden="true"></i>`}
      ${money(Math.abs(c.amount_cents), { whole: true, signed: inc })}
      ${c.status === 'missed' && html`<span class="vl2-ci-miss">niet gezien</span>`}
    </span>
  </button>`;
}

function MonthGrid({ data, selKey, selDate, onPick }) {
  const p = data.period;
  const today = todayISO();
  const dowFrom = (parseISO(p.from).getUTCDay() + 6) % 7;
  const start = addDays(p.from, -dowFrom);
  const dowTo = (parseISO(p.to).getUTCDay() + 6) % 7;
  const end = addDays(p.to, 6 - dowTo);
  const n = daysBetween(start, end) + 1;
  const byDate = new Map(data.days.map((d) => [d.date, d.items]));
  const withItems = data.days.map((d) => d.date).filter((d) => d >= p.from && d <= p.to);
  const [focus, setFocus] = useState(() => withItems.find((d) => d >= today) || withItems[0] || null);
  const gridRef = useRef(null);
  const cells = [];
  for (let i = 0; i < n; i++) cells.push(addDays(start, i));

  const move = (date) => {
    if (!date) return;
    setFocus(date);
    requestAnimationFrame(() => gridRef.current?.querySelector(`[data-date="${date}"]`)?.focus());
  };
  const onKey = (e) => {
    if (!focus) return;
    const i = withItems.indexOf(focus);
    let next = null;
    if (e.key === 'ArrowRight') next = withItems[i + 1];
    else if (e.key === 'ArrowLeft') next = withItems[i - 1];
    else if (e.key === 'ArrowDown') next = withItems.find((d) => daysBetween(focus, d) >= 7) || withItems.at(-1);
    else if (e.key === 'ArrowUp') next = [...withItems].reverse().find((d) => daysBetween(d, focus) >= 7) || withItems[0];
    else if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.date) {
      e.preventDefault();
      const first = (byDate.get(focus) || [])[0];
      if (first) onPick({ ...first, date: focus });
      return;
    } else return;
    e.preventDefault();
    if (next) move(next);
  };
  const more = (e, date, list) => {
    e.stopPropagation();
    openPopover(e.currentTarget, (close) => html`<div class="vl2-more">
      <div class="vl2-more-h">${capitalize(dayLabel(date, { long: true }))}</div>
      ${list.map((c) => html`<${CalItem} c=${c} compact=${false} onPick=${(x) => { close(); onPick({ ...x, date }); }} />`)}
    </div>`, { width: 280 });
  };

  return html`<div class="dk-card vl2-cal">
    <div class="vl2-cal-head" aria-hidden="true">${WEEKDAYS.map((d) => html`<span>${d}</span>`)}</div>
    <div class="vl2-cal-grid" ref=${gridRef} onKeyDown=${onKey} role="grid" aria-label=${'Vaste lasten in ' + p.label}
        style=${{ '--weeks': Math.ceil(n / 7) }}>
      ${cells.map((date) => {
        const inside = date >= p.from && date <= p.to;
        const list = inside ? (byDate.get(date) || []) : [];
        const d = parseISO(date);
        const showMonth = date === p.from || d.getUTCDate() === 1;
        const has = list.length > 0;
        return html`<div key=${date} class=${'vl2-day' + (inside ? '' : ' is-out') + (date === today ? ' is-today' : '') + (has ? ' has-items' : '')}
            role="gridcell" data-date=${has ? date : null} tabindex=${has ? (date === focus ? 0 : -1) : null}
            aria-label=${has ? `${dayLabel(date, { long: true })}: ${list.map(calItemLabel).join('; ')}` : null}
            onFocus=${has ? () => setFocus(date) : null}>
          <span class="vl2-daynum num">${d.getUTCDate()}${showMonth && html` <small>${MONTHS_SHORT[d.getUTCMonth()]}</small>`}</span>
          ${list.slice(0, 3).map((c) => html`<${CalItem} key=${c.key + c.status} c=${c}
            selected=${c.key === selKey && date === selDate} onPick=${(x) => onPick({ ...x, date })} />`)}
          ${list.length > 3 && html`<button class="vl2-more-btn" tabindex="-1" onClick=${(e) => more(e, date, list)}
            aria-label=${`Nog ${list.length - 3} op ${dayLabel(date, { long: true })}`}>+${list.length - 3}</button>`}
        </div>`;
      })}
    </div>
  </div>`;
}

function Agenda({ data, onPick }) {
  const today = todayISO();
  const p = data.period;
  const days = data.days.filter((d) => d.date >= p.from && d.date <= p.to);
  return html`<div class="vl2-agenda">
    ${days.map((d) => html`<section class=${'vl2-ag-day' + (d.date < today ? ' is-past' : '')} key=${d.date}>
      <h2 class="vl2-ag-h">${capitalize(dayLabel(d.date, { long: true }))}</h2>
      <ul class="inset">
        ${d.items.map((c) => {
          const cat = categoryById(c.category_id) || { emoji: '📦', color: 'gray' };
          const inc = c.direction === 'in';
          return html`<li class="row-li" key=${c.key + c.status}><button class=${'row is-two is-button has-lead vl2-ag-row is-' + c.status} onClick=${() => onPick({ ...c, date: d.date })}>
            <span class="row-lead"><${EmojiTile} emoji=${cat.emoji} color=${cat.color} size=${32} /></span>
            <span class="row-main">
              <span class="row-title">${c.name}</span>
              <span class="row-sub vl2-ag-status">
                ${c.status === 'paid' && html`<${Icon} name="check" size=${13} stroke=${2.6} />`}
                ${c.status === 'missed' && html`<i class="vl2-dot" aria-hidden="true"></i>`}
                ${STATUS_WORD[c.status]}
              </span>
            </span>
            <span class=${'row-amount num' + (inc ? ' is-income' : '')}>${money(Math.abs(c.amount_cents), { signed: inc })}</span>
          </button></li>`;
        })}
      </ul>
    </section>`)}
  </div>`;
}

/* ---------- Item sheet / inspector ---------- */

function ItemSheet({ close, it, cal = null }) {
  return html`<${Sheet} label=${it.name} detents=${['medium', 'large']} class="vl-sheet">
    <div class="sheet-pad"><${ItemDetail} it=${it} cal=${cal} close=${close} /></div>
  </${Sheet}>`;
}

/** The item's details: sheet on iPhone, inspector on the Mac. `cal` = the calendar entry clicked. */
function ItemDetail({ close, it, cal = null, inline = false }) {
  const { data } = useQuery(`recurring-tx:${it.merchant_key}`, () => api.transactions({ merchant_key: it.merchant_key, limit: 1000 }));
  const cat = categoryById(it.category_id) || { emoji: '📦', color: 'gray', name: '' };
  const typ = Math.abs(it.amount_cents);
  const sign = Math.sign(it.amount_cents) || -1;
  // exactly this item's payments (one name can have several items: potjes, accounts, policies);
  // without the list (a calendar entry, an older server) the amount decides, as before
  const own = it.tx_ids ? new Set(it.tx_ids) : null;
  const payments = (data?.items || []).filter((t) => (own ? own.has(t.id)
    : Math.sign(t.amount_cents) === sign && Math.abs(t.amount_cents) >= typ * 0.6 && Math.abs(t.amount_cents) <= typ * 1.6));
  const bars = payments.slice(0, 12).reverse().map((t) => ({ label: shortDate(t.date), short: shortDate(t.date).split(' ')[1] || '', value: Math.abs(t.amount_cents) }));
  const [sel, setSel] = useState(null);
  const [all, setAll] = useState(false);
  const known = it.frequency != null;
  const ignore = () => {
    const undo = commitLater('rec:' + it.key, () => api.ignoreRecurring(it.key));
    close();
    toast({ text: `${it.name} is geen vaste last meer`, icon: 'check', action: { label: 'Herstel', onClick: undo } });
  };
  const head = sel != null && bars[sel] ? bars[sel] : null;
  const when = it.status === 'ended' ? ` · laatst ${shortDate(it.last_date)}` : it.next_date ? ` · volgende ${shortDate(it.next_date)}` : '';
  return html`<div class=${'vl-detail' + (inline ? ' is-inline' : '')}>
      <div class="vl-sheet-head">
        <${EmojiTile} emoji=${cat.emoji} color=${cat.color} size=${56} />
        <h2 class="vl-sheet-name">${it.name}</h2>
        <div class=${'vl-sheet-amount rounded num' + (it.direction === 'in' ? ' is-income' : '')}>${it.variable ? 'ca. ' : ''}${money(typ, { signed: it.direction === 'in' })}</div>
        <div class="vl-sheet-sub">${capitalize(freqLabel(it.frequency, 'every') || 'terugkerend')}${when}</div>
        ${it.per_year_cents != null && html`<div class="vl-sheet-sub num">${euros(it.per_year_cents)} per jaar</div>`}
        ${it.iban && html`<div class="vl-sheet-sub">Naar <${Iban} iban=${it.iban} /></div>`}
        ${it.repaid_per_month_cents > 0 && html`<div class="vl-sheet-sub num">${money(Math.abs(it.per_month_cents) - it.repaid_per_month_cents, { whole: true })} rente en kosten · ${euros(it.repaid_per_month_cents)} aflossing per maand. De aflossing telt als gespaard, niet in het bakje.</div>`}
        ${it.change && html`<div class="vl-sheet-change num">was ${money(Math.abs(it.change.from_cents))} tot ${shortDate(it.change.date)}</div>`}
      </div>
      ${cal && html`<${CalStatus} cal=${cal} />`}
      ${bars.length > 1 && html`<div class="card vl-sheet-chart" style=${{ '--c': colorVar(cat.color) }}>
        <div class="vl-chart-head num">${head ? html`<b>${money(head.value)}</b> · ${head.label}` : html`<b>${payments.length}</b> keer betaald`}</div>
        <${BarChart} data=${bars} height=${120} color=${colorVar(cat.color)} selected=${sel} onSelect=${setSel} highlight=${bars.length - 1}
          valueFormat=${(v) => money(v)} label=${`Betalingen aan ${it.name}`} />
      </div>`}
      ${payments.length > 0 && html`<${List} header=${payments.length > 12 && !all ? `Laatste 12 van ${payments.length} betalingen` : `${payments.length} betalingen`}
          footer="Met de omschrijving uit je bankbestand: zo zie je wat Cents bij deze vaste last telt.">
        ${(all ? payments : payments.slice(0, 12)).map((t) => html`<${TxRow} key=${t.id} tx=${t} hideCategory
          sub=${[shortDate(t.date), t.description && t.description !== t.merchant_name ? t.description : null].filter(Boolean).join(' · ')}
          onClick=${() => openTransaction(t)} />`)}
        ${payments.length > 12 && !all && html`<li class="row-li"><button class="row is-button" onClick=${() => setAll(true)}><span class="row-main"><span class="row-title" style="color: var(--tint)">Toon alle ${payments.length} betalingen</span></span></button></li>`}
      </${List}>`}
      ${!data && html`<${Skeleton} h=${150} r=${16} />`}
      ${known && html`<div class="vl-sheet-ignore"><${Button} variant="gray" block onClick=${ignore}>Geen vaste last</${Button}></div>`}
  </div>`;
}

/** What the calendar says about this occurrence; a paid one links to its payment. */
function CalStatus({ cal }) {
  const amount = money(Math.abs(cal.amount_cents), { signed: cal.direction === 'in' });
  if (cal.status === 'paid') {
    return html`<${List} class="vl2-calstat">
      <li class="row-li"><button class="row is-button has-lead" onClick=${() => openTransaction(cal.transaction_id)} disabled=${!cal.transaction_id}>
        <span class="row-lead"><span class="row-icon" style=${{ '--c': 'var(--tint)' }}><${Icon} name="check" size=${16} stroke=${2.6} /></span></span>
        <span class="row-main"><span class="row-title">Betaald op ${longDate(cal.date)}</span></span>
        <span class="row-value num">${amount}</span>
        <span class="row-chev"><${Icon} name="chevron-right" size=${14} stroke=${2.6} /></span>
      </button></li>
    </${List}>`;
  }
  const missed = cal.status === 'missed';
  return html`<${List} class="vl2-calstat">
    <li class="row-li"><div class="row has-lead">
      <span class="row-lead"><span class="row-icon" style=${{ '--c': missed ? 'var(--orange)' : 'var(--gray)' }}><${Icon} name=${missed ? 'warning' : 'clock'} size=${16} stroke=${2.2} /></span></span>
      <span class="row-main"><span class="row-title">${missed ? `Niet gezien rond ${longDate(cal.date)}` : `Verwacht op ${longDate(cal.date)}`}</span></span>
      <span class="row-value num">${amount}</span>
    </div></li>
  </${List}>`;
}

/* ---------- Skeletons ---------- */

function VLSkeleton({ desk }) {
  if (desk) {
    return html`<div aria-busy="true" aria-label="Laden">
      <div class="vl-hero is-desk"><${Skeleton} w=${260} h=${44} r=${12} /><${Skeleton} w=${140} h=${15} /></div>
      <div class="dk-card vl2-table">${Array.from({ length: 9 }, () => html`<div class="vl2-skel-row"><${Skeleton} w="30%" h=${14} /><${Skeleton} w="18%" h=${14} /><${Skeleton} w="10%" h=${14} /></div>`)}</div>
    </div>`;
  }
  return html`<div aria-busy="true" aria-label="Laden">
    <div class="vl-hero"><${Skeleton} w=${220} h=${44} r=${12} /><${Skeleton} w=${140} h=${15} style=${{ marginTop: '10px' }} /><${Skeleton} h=${8} r=${4} style=${{ marginTop: '18px' }} /></div>
    <div class="vl-seg"><${Skeleton} h=${32} r=${9} /></div>
    ${[0, 1].map(() => html`<div class="vl-group"><${Skeleton} w=${160} h=${20} style=${{ margin: '0 4px 10px' }} />
      <div class="inset">${[0, 1, 2].map(() => html`<div class="row is-two"><span class="row-main"><${Skeleton} w="55%" h=${15} /><${Skeleton} w="35%" h=${13} /></span></div>`)}</div></div>`)}
  </div>`;
}

function CalSkeleton({ desk }) {
  if (desk) return html`<div aria-busy="true" aria-label="Laden"><${Skeleton} w=${360} h=${16} style=${{ margin: '6px 0 16px' }} /><${Skeleton} h=${520} r=${14} /></div>`;
  return html`<div aria-busy="true" aria-label="Laden"><${Skeleton} w=${260} h=${15} style=${{ margin: '4px 4px 18px' }} />
    ${[0, 1, 2].map(() => html`<div class="vl-group"><${Skeleton} w=${120} h=${16} style=${{ margin: '0 4px 8px' }} /><${Skeleton} h=${60} r=${12} /></div>`)}</div>`;
}
