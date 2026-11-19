// Holdings of an investment account (SPEC §7.1), shown inside the account sheet: value,
// ingelegd, resultaat (€ and %, with and without dividend and costs), a chart of value vs.
// ingelegd, the funds (tap → FundSheet with its trades) and "Aankoop toevoegen" (TradeSheet).

import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery, invalidate } from '../store.js';
import { openSheet } from '../router.js';
import { money, euros, longDate, shortDate, todayISO, number } from '../format.js';
import { List, ListRow } from '../components/List.js';
import { Button, Segmented } from '../components/Controls.js';
import { Skeleton } from '../components/Feedback.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { TextField, AmountField, DateField } from '../components/Fields.js';
import { openMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { LineChart } from '../charts/LineChart.js';

const pct = (f) => (f == null ? '' : `${f > 0 ? '+' : f < 0 ? '−' : ''}${Math.abs(f * 100).toFixed(1).replace('.', ',')}%`);
const qty = (q) => number(Math.round(q * 10000) / 10000);
const SOURCE = { yahoo: 'Yahoo Finance', degiro_portfolio: 'DEGIRO-export', etoro: 'eToro-overzicht', trade: 'laatste aankoop' };

// Obligaties (een "%" in de naam) noteren in procenten van de nominale waarde: 0,985 per
// euro nominaal tonen we als 98,50 %, zoals DEGIRO.
const isBond = (f) => (f.name || '').includes('%');
const px = (f, cents) => (isBond(f)
  ? `${(cents).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`
  : money(cents));

export function resultText(cents, fraction) {
  if (cents == null) return '';
  return `${money(cents, { whole: true, signed: true, negative: true })}${fraction != null ? ` · ${pct(fraction)}` : ''}`;
}

export function HoldingsPart({ account }) {
  const q = useQuery(`holdings:${account.id}`, () => api.holdings(account.id));
  const h = q.data;
  if (!h) {
    return html`<div class="inset" aria-busy="true" aria-label="Laden">${[0, 1, 2].map(() => html`<div class="row"><span class="row-main"><${Skeleton} w="60%" h=${15} /></span></div>`)}</div>`;
  }
  const open = h.holdings.filter((x) => x.quantity > 0);
  const closed = h.holdings.filter((x) => x.quantity <= 0);
  const addTrade = () => openSheet(TradeSheet, { account });
  const priceNote = h.price_date
    ? `${h.price_stale ? 'Koers van' : 'Koersen van'} ${longDate(h.price_date)}`
    : null;
  return html`
    <${List} header="Resultaat" footer=${[h.invested_source === 'trades' ? 'Ingelegd = wat je kocht (geen overboekingen naar deze rekening gevonden).'
      : h.invested_source === 'degiro' ? 'Ingelegd = stortingen min opnames uit het rekeningoverzicht van je broker.' : null, gapNote(h)].filter(Boolean).join(' ')}>
      <${ListRow} title="Waarde fondsen" value=${html`<span class="num">${money(h.market_value_cents)}</span>`} />
      ${h.cash_cents > 0 && html`<${ListRow} title="Geld op de rekening" subtitle="geschat" value=${html`<span class="num">${money(h.cash_cents)}</span>`} />`}
      <${ListRow} title="Ingelegd" value=${html`<span class="num">${money(h.invested_cents)}</span>`} />
      <${ListRow} title="Resultaat" subtitle="met dividend en kosten"
        value=${html`<span class=${'num' + (h.result_cents > 0 ? ' is-income' : '')}>${resultText(h.result_cents, h.result_pct)}</span>`} />
      <${ListRow} title="Koersresultaat" subtitle="zonder dividend en kosten"
        value=${html`<span class="num">${resultText(h.price_result_cents, h.price_result_pct)}</span>`} />
      ${h.dividends_cents !== 0 && html`<${ListRow} title="Dividend" subtitle="na belasting" value=${html`<span class="num">${money(h.dividends_cents, { negative: true })}</span>`} />`}
      <${ListRow} title="Kosten" value=${html`<span class="num">${money(h.costs_cents)}</span>`} />
    </${List}>
    ${h.chart.length > 1 && html`<${HoldingsChart} chart=${h.chart} />`}
    <${List} header="Fondsen" footer=${priceNote && html`<span class=${h.price_stale ? 'vm-stale' : ''}>${priceNote}${h.prices?.enabled === false ? ' · automatisch ophalen staat uit' : ''}</span>`}>
      ${open.map((f) => html`<${FundRow} key=${f.isin} f=${f} account=${account} />`)}
      ${closed.length > 0 && closed.map((f) => html`<${FundRow} key=${f.isin} f=${f} account=${account} />`)}
      <${ListRow} icon="plus" title="Aankoop toevoegen" tint onClick=${addTrade} />
    </${List}>`;
}

function HoldingsChart({ chart }) {
  const [range, setRange] = useState('all');
  const [scrub, setScrub] = useState(null);
  const n = range === '1j' ? 53 : chart.length;
  const pts = chart.slice(-n);
  const sel = scrub != null ? pts[scrub] : pts[pts.length - 1];
  return html`<div class="vm-hchart">
    <div class="vm-hchart-head">
      <span class="vm-hchart-label">${scrub != null ? longDate(sel.date) : 'Waarde en inleg'}</span>
      <span class="num"><b>${money(sel.value_cents, { whole: true })}</b> <span class="vm-hchart-inv">ingelegd ${euros(sel.invested_cents)}</span></span>
    </div>
    <${LineChart} points=${pts.map((p) => ({ label: longDate(p.date), short: shortDate(p.date), value: p.value_cents }))}
      compare=${pts.map((p) => p.invested_cents)} compareLabel="Ingelegd" scrub=${scrub} onScrub=${setScrub} height=${180}
      label=${`Waarde tegen inleg, nu ${euros(sel.value_cents)}`} />
    ${chart.length > 53 && html`<div class="vm-range"><${Segmented} value=${range} onChange=${(r) => { setRange(r); setScrub(null); }} options=${[['1j', '1J'], ['all', 'Alles']]} label="Periode" size="small" /></div>`}
  </div>`;
}

function FundRow({ f, account }) {
  const res = f.result_cents;
  const value = html`<span class="vm-value">
    <span class="num vm-balance">${f.quantity > 0 ? money(f.value_cents) : 'verkocht'}</span>
    <span class=${'num vm-result' + (res > 0 ? ' is-income' : '')}>${money(res, { whole: true, signed: true, negative: true })}</span>
  </span>`;
  const sub = f.quantity > 0
    ? `${qty(f.quantity)} × ${f.price_cents != null ? px(f, f.price_cents) : '—'}${f.avg_price_cents ? ` · gem. ${px(f, f.avg_price_cents)}` : ''}`
    : `${f.trades.length} transacties`;
  return html`<${ListRow} title=${f.name} subtitle=${html`<span class="num">${sub}</span>`} value=${value} chevron
    onClick=${() => openSheet(FundSheet, { fund: f, account })} label=${`${f.name}, ${money(f.value_cents)}`} />`;
}

export function FundSheet({ close, fund: f }) {
  const [gone, setGone] = useState(new Set());
  const remove = (e, t) => openMenu(e.currentTarget, [{
    label: 'Verwijder', icon: 'trash', destructive: true, onSelect: async () => {
      try {
        await api.deleteTrade(t.id);
        setGone((g) => new Set([...g, t.id]));
        invalidate();
        toast({ text: 'Verwijderd', icon: 'trash' });
      } catch (err) { toast({ text: err.message, icon: 'warning' }); }
    },
  }]);
  const trades = f.trades.filter((t) => !gone.has(t.id));
  return html`<${Sheet} title=${f.name} detents=${['large']} trailing=${html`<${SheetButton} bold onClick=${close}>Klaar</${SheetButton}>`}>
    <div class="sheet-pad">
      <div class="vm-sheet-head">
        <div class="vm-sheet-amount rounded num">${money(f.value_cents)}</div>
        <div class="vm-sheet-sub num">${resultText(f.result_cents, f.cost_cents > 0 ? f.result_cents / f.cost_cents : null)}</div>
      </div>
      <${List} footer=${f.price_date ? `Koers van ${longDate(f.price_date)} · ${SOURCE[f.price_source] || f.price_source}` : null}>
        <${ListRow} title="Aantal" value=${html`<span class="num">${qty(f.quantity)}</span>`} />
        <${ListRow} title="Koers" value=${html`<span class="num">${f.price_cents != null ? px(f, f.price_cents) : '—'}</span>`} />
        ${f.avg_price_cents != null && html`<${ListRow} title="Gemiddelde aankoopprijs" value=${html`<span class="num">${px(f, f.avg_price_cents)}</span>`} />`}
        <${ListRow} title="Koersresultaat" value=${html`<span class="num">${money(f.price_result_cents, { signed: true, negative: true })}</span>`} />
        ${f.dividends_cents !== 0 && html`<${ListRow} title="Dividend" value=${html`<span class="num">${money(f.dividends_cents, { negative: true })}</span>`} />`}
        <${ListRow} title="Kosten" value=${html`<span class="num">${money(f.fees_cents)}</span>`} />
        <${ListRow} title="ISIN" value=${html`<span class="num">${f.isin}</span>`} />
      </${List}>
      <${List} header="Transacties">
        ${trades.map((t) => html`<${ListRow} key=${t.id} title=${`${t.quantity > 0 ? 'Koop' : 'Verkoop'} ${qty(Math.abs(t.quantity))} × ${t.currency === 'EUR' ? money(Math.round(t.price * 100)) : `${t.price.toFixed(2).replace('.', ',')} ${t.currency}`}`}
          subtitle=${`${longDate(t.date)}${t.fees_cents ? ` · kosten ${money(t.fees_cents)}` : ''}${t.manual ? ' · zelf ingevoerd' : ''}`}
          value=${html`<span class="num">${money(t.value_eur_cents, { signed: true, negative: true })}</span>`}
          onClick=${t.manual ? (e) => remove(e, t) : undefined} />`)}
      </${List}>
    </div>
  </${Sheet}>`;
}

export function TradeSheet({ close, account }) {
  const [side, setSide] = useState('buy');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState([]);
  const [fund, setFund] = useState(null);         // { isin, name }
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState(null);
  const [fees, setFees] = useState(null);
  const [date, setDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.securities(query.trim()).then((r) => live && setFound(r)).catch(() => {});
    return () => { live = false; };
  }, [query]);
  const isin = fund?.isin || (/^[A-Za-z]{2}[A-Za-z0-9]{9}\d$/.test(query.trim()) ? query.trim().toUpperCase() : null);
  const quantity = /^\s*\d+([.,]\d+)?\s*$/.test(amount) ? Number(amount.trim().replace(',', '.')) : null;
  const ready = date && isin && quantity > 0 && price > 0 && (fund || name.trim());
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await api.addTrade(account.id, { date, isin, name: fund ? undefined : name.trim(), side, quantity, price_cents: price, fees_cents: fees || 0 });
      invalidate();
      toast({ text: side === 'buy' ? 'Aankoop bewaard' : 'Verkoop bewaard' });
      close();
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };
  return html`<${Sheet} title=${side === 'buy' ? 'Aankoop toevoegen' : 'Verkoop toevoegen'} detents=${['large']}
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold onClick=${save} disabled=${!ready || busy}>Bewaar</${SheetButton}>`}>
    <div class="sheet-pad">
      <div class="vm-trade-side"><${Segmented} value=${side} onChange=${setSide} options=${[['buy', 'Koop'], ['sell', 'Verkoop']]} label="Soort" /></div>
      <${List} header="Fonds" footer=${!fund ? 'Zoek op naam of typ de ISIN (staat op je DEGIRO-overzicht).' : null}>
        ${fund
          ? html`<${ListRow} title=${fund.name} subtitle=${fund.isin} value="Wijzig" onClick=${() => { setFund(null); setQuery(''); }} />`
          : html`<${TextField} label="Zoek" value=${query} onInput=${setQuery} placeholder="Naam of ISIN" maxLength=${60} />
            ${found.slice(0, 6).map((s) => html`<${ListRow} key=${s.isin} title=${s.name} subtitle=${s.isin} onClick=${() => setFund(s)} />`)}
            ${isin && !found.some((s) => s.isin === isin) && html`<${TextField} label="Naam" value=${name} onInput=${setName} placeholder="Naam van het fonds" maxLength=${120} />`}`}
      </${List}>
      <${List}>
        <${TextField} label="Aantal" value=${amount} onInput=${setAmount} inputmode="decimal" placeholder="0" />
        <${AmountField} label="Koers" cents=${price} onChange=${setPrice} />
        <${AmountField} label="Kosten" cents=${fees} onChange=${setFees} />
        <${DateField} label="Datum" value=${date} onChange=${setDate} max=${todayISO()} />
      </${List}>
      ${quantity > 0 && price > 0 && html`<p class="vm-trade-total num">Totaal ${money(Math.round(quantity * price) + (side === 'buy' ? 1 : -1) * (fees || 0))}</p>`}
    </div>
  </${Sheet}>`;
}

/** Ingelegd + resultaat is not always the value: dividend paid out to your bank and costs
 *  paid from elsewhere are in the result, not in the account. Say so instead of leaving a sum
 *  that does not add up (usability test 2026-11). */
function gapNote(h) {
  const value = (h.market_value_cents || 0) + (h.cash_cents || 0);
  const gap = h.invested_cents + h.result_cents - value;
  if (Math.abs(gap) < 100) return null;
  return `Ingelegd + resultaat is ${money(h.invested_cents + h.result_cents)}, de waarde ${money(value)}: het verschil van ${money(Math.abs(gap))} is ${gap > 0 ? 'dividend dat al op je bankrekening staat' : 'geld dat er los op staat'} of kosten die apart zijn betaald.`;
}
