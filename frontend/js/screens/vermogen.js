// Vermogen (DESIGN §3): hero total with a Stocks-style line chart (6M · 1J · Alles, scrubbing),
// suggestion rows for likely own accounts (Ja creates, Nee dismisses), accounts grouped per
// soort, account sheet (name, soort, values for investments, open amount + "Uitgave
// toevoegen" for credit cards, manual balance for accounts without imported data). `+` adds a
// manual account. Woning (SPEC §7.2): overwaarde row, mortgage sheet with parts, the yearly
// statement form, home value, include switch and the linked payment. Pensioen, Schulden and
// Overig bezit (SPEC §7.3): only shown once added via `+`; one sheet per item with dated
// entries, the "Meetellen in vermogen" switch and (debt) the linked payment.

import { html, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useStore, useQuery, invalidate, getState } from '../store.js';
import { openSheet } from '../router.js';
import { euros, money, monthLabel, shortDate, todayISO, longDate } from '../format.js';
import { Screen, NavButton } from '../components/Screen.js';
import { Amount } from '../components/Amount.js';
import { Card } from '../components/Card.js';
import { List, ListRow, Section } from '../components/List.js';
import { Button, Segmented, Switch } from '../components/Controls.js';
import { Skeleton, EmptyState } from '../components/Feedback.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { TextField, AmountField, DateField } from '../components/Fields.js';
import { openMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { LineChart } from '../charts/LineChart.js';
import { openAddExpense } from '../shell/actions.js';
import { commitLater, usePending } from './_kit.js';
import { useLayout } from '../hooks.js';
import { HoldingsPart, TradeSheet, resultText } from './_holdings.js';
import { colorVar } from '../colors.js';
import { Icon } from '../icons.js';
import { PossessionSheet } from './_costs.js';
import { Iban } from '../components/Iban.js';

export const TYPES = [
  { type: 'checking', label: 'Betaalrekening', group: 'Betaalrekeningen', icon: 'wallet', color: 'blue' },
  { type: 'savings', label: 'Spaarrekening', group: 'Sparen', icon: 'piggy', color: 'teal' },
  { type: 'investment', label: 'Beleggingen', group: 'Beleggingen', icon: 'arrow-up-right', color: 'indigo' },
  { type: 'credit', label: 'Creditcard', group: 'Creditcard', icon: 'creditcard', color: 'orange' },
];
const typeInfo = (t) => TYPES.find((x) => x.type === t) || TYPES[0];

export const maskIban = (iban) => (iban ? `${iban.slice(0, 2)}•• ${iban.slice(-4)}` : '');

const RANGES = [['6m', '6M'], ['1j', '1J'], ['all', 'Alles']];

export function Vermogen() {
  const { data, error, reload } = useQuery('networth', () => api.networth());
  const boot = useStore((s) => s.boot);
  const pending = usePending();
  const desk = useLayout() === 'wide';
  const addItems = [{ label: 'Rekening toevoegen', icon: 'wallet', onSelect: () => openSheet(AccountSheet, {}) },
    ...(data?.home ? [] : [{ label: 'Hypotheek toevoegen', icon: 'vermogen', onSelect: () => openSheet(MortgageSheet, {}) }]),
    ...ASSET_KINDS.map((k) => ({ label: k.add, icon: k.icon, onSelect: () => openSheet(AssetSheet, { kind: k.kind }) }))];
  // the same choices as the Mac toolbar menu (rekening, hypotheek, bezitting, schuld, pensioen, …)
  const trailing = html`<${NavButton} icon="plus" label="Toevoegen" onClick=${(e) => openMenu(e.currentTarget, addItems)} />`;

  if (!data) {
    return html`<${Screen} title="Vermogen" trailing=${trailing} add=${addItems}>
      ${error ? html`<${EmptyState} emoji="📈" title="Vermogen laadt niet" subtitle=${error.message} action=${{ label: 'Probeer opnieuw', variant: 'tinted', onClick: () => reload() }} />` : html`<${VermogenSkeleton} />`}
    </${Screen}>`;
  }
  const accounts = data.accounts.filter((a) => !pending.has('account:' + a.id));
  const suggestions = (boot?.suggestions?.accounts || []).filter((s) => !pending.has('sugg:' + s.key));

  const groups = TYPES.map((t) => {
    const list = accounts.filter((a) => a.type === t.type);
    if (!list.length) return null;
    const sum = list.reduce((s, a) => s + (a.balance_cents || 0), 0);
    return { t, list, sum };
  }).filter(Boolean);

  const assetGroups = ASSET_KINDS.map((k) => {
    const list = (data.assets || []).filter((a) => a.kind === k.kind && !pending.has('asset:' + a.id));
    if (!list.length) return null;
    const known = list.filter((a) => a.value_cents != null);
    return { k, list, sum: known.length ? known.reduce((s, a) => s + a.signed_cents, 0) : null };
  }).filter(Boolean);

  const assetSections = assetGroups.map(({ k, list, sum }) => html`<${Section} key=${k.kind} title=${k.group} trailing=${list.length > 1 && sum != null && html`<span class="section-value num">${money(sum, { negative: true })}</span>`}>
      <${List}>${list.map((a) => html`<${AssetRow} key=${a.id} a=${a} />`)}</${List}>
    </${Section}>`);
  const sugg = suggestions.length > 0 && html`<div class="vm-suggestions">${suggestions.map((s) => html`<${Suggestion} key=${s.key} s=${s} />`)}</div>`;
  const empty = !accounts.length && html`<${EmptyState} emoji="🏦" title="Nog geen rekeningen" action=${{ label: 'Rekening toevoegen', onClick: () => openSheet(AccountSheet, {}) }} />`;

  // Mac: brede kaart met vrij vermogen en grafiek, daaronder drie pijlers naast elkaar, dan de
  // overige bezittingen. iPhone: hetzelfde, onder elkaar.
  return html`<${Screen} title="Vermogen" trailing=${trailing} add=${addItems} class="vm">
    ${desk ? html`<div class="dk-card vm-chart-card"><${Hero} data=${data} accounts=${accounts} desk /></div>` : html`<${Hero} data=${data} accounts=${accounts} />`}
    ${sugg}
    ${empty}
    ${accounts.length > 0 && html`<${Pillars} data=${data} accounts=${accounts} />`}
    ${assetGroups.length > 0 && html`<div class="vm-assets">${assetSections}</div>`}
  </${Screen}>`;
}

/* ---------- Pillars: bank, beleggingen, vastgoed ---------- */

/** Aandelen van het vermogen per pijler (alleen positieve delen; vastgoed telt als het meetelt). */
function pillarSplit(data, accounts) {
  const sum = (types) => accounts.filter((a) => types.includes(a.type)).reduce((t, a) => t + (a.balance_cents || 0), 0);
  const bank = sum(['checking', 'savings', 'credit']);
  const locked = accounts.filter((a) => a.locked).reduce((t, a) => t + (a.balance_cents || 0), 0);
  const invest = sum(['investment']);
  const home = data.home?.equity_cents ?? null;
  return { bank, free: bank - locked, locked, invest, home, hasInvest: accounts.some((a) => a.type === 'investment') };
}

const PILLAR_COLORS = { bank: 'blue', invest: 'indigo', home: 'green' };

function Pillars({ data, accounts }) {
  const { bank, invest, home, hasInvest } = pillarSplit(data, accounts);
  const parts = [bank, hasInvest ? invest : 0, home && data.home.included ? home : 0].map((v) => Math.max(0, v || 0));
  const whole = parts.reduce((t, v) => t + v, 0);
  const share = (v) => (whole > 0 && v > 0 ? Math.round((v / whole) * 100) : null);
  return html`<div class="vm-pillars">
    <${BankPillar} accounts=${accounts} total=${bank} share=${share(bank)} />
    <${InvestPillar} accounts=${accounts} total=${invest} share=${share(invest)} />
    <${HomePillar} home=${data.home} share=${data.home?.included ? share(home) : null} />
  </div>`;
}

function PillarHead({ kind, icon, title, cents, share, note }) {
  return html`<header class="vm-p-head" style=${{ '--c': colorVar(PILLAR_COLORS[kind]) }}>
    <div class="vm-p-title"><span class="vm-p-icon"><${Icon} name=${icon} size=${16} stroke=${2} /></span>${title}
      ${share != null && html`<span class="vm-p-share num">${share}%</span>`}</div>
    <div class="vm-p-amount rounded num">${cents == null ? '—' : money(cents, { whole: true, negative: true })}</div>
    ${note && html`<div class="vm-p-note">${note}</div>`}
  </header>`;
}

/** Een regel cijfers in een pijler: label links, bedrag rechts. */
const Fact = ({ label, value, tone }) => html`<div class="vm-p-fact"><span>${label}</span><span class=${'num' + (tone ? ' ' + tone : '')}>${value}</span></div>`;

function PillarRows({ list }) {
  return html`<div class="vm-p-rows">${list.map((a) => {
    const t = typeInfo(a.type);
    const main = a.type === 'credit' ? money(-(a.outstanding_cents || 0), { negative: true })
      : a.balance_cents == null ? '—' : money(a.balance_cents, { negative: true });
    return html`<button class="vm-p-row" key=${a.id} onClick=${() => openSheet(AccountSheet, { account: a })} aria-label=${`${a.name}, ${main}. Open`}>
      <span class="vm-p-dot" style=${{ '--c': colorVar(t.color) }}><${Icon} name=${t.icon} size=${14} stroke=${2} /></span>
      <span class="vm-p-row-main"><span class="vm-p-row-name">${a.name}</span><span class="vm-p-row-sub num">${subtitleFor(a)}</span></span>
      <span class="num vm-p-row-amt">${main}</span>
      <span class="vm-p-chev"><${Icon} name="chevron-right" size=${13} stroke=${2.6} /></span>
    </button>`;
  })}</div>`;
}

function BankPillar({ accounts, total, share }) {
  const of = (type) => accounts.filter((a) => a.type === type);
  const sum = (list) => list.reduce((t, a) => t + (a.balance_cents || 0), 0);
  const checking = of('checking'), credit = of('credit');
  const savings = of('savings').filter((a) => !a.locked), fixed = of('savings').filter((a) => a.locked);
  const open = credit.reduce((t, a) => t + (a.outstanding_cents || 0), 0);
  return html`<section class="vm-pillar" aria-label="Bank">
    <${PillarHead} kind="bank" icon="wallet" title="Bank" cents=${total} share=${share} note=${fixed.length ? `waarvan ${euros(total - sum(fixed))} direct opneembaar` : 'direct opneembaar, potjes en buffer inbegrepen'} />
    <div class="vm-p-facts">
      ${checking.length > 0 && html`<${Fact} label="Betaalrekening${checking.length > 1 ? 'en' : ''}" value=${money(sum(checking), { negative: true })} />`}
      ${savings.length > 0 && html`<${Fact} label="Sparen" value=${money(sum(savings), { negative: true })} />`}
      ${fixed.length > 0 && html`<${Fact} label="Vast (niet vrij)" value=${money(sum(fixed), { negative: true })} />`}
      ${credit.length > 0 && html`<${Fact} label="Creditcard open" value=${money(-open, { negative: true })} />`}
    </div>
    <${PillarRows} list=${[...checking, ...savings, ...fixed, ...credit]} />
  </section>`;
}

function InvestPillar({ accounts, total, share }) {
  const list = accounts.filter((a) => a.type === 'investment');
  if (!list.length) {
    return html`<section class="vm-pillar is-empty" aria-label="Beleggingen">
      <${PillarHead} kind="invest" icon="arrow-up-right" title="Beleggingen" cents=${null} />
      <p class="vm-p-empty">Voeg een beleggingsrekening toe of importeer je DEGIRO- of eToro-export.</p>
      <button class="section-link" onClick=${() => openSheet(AccountSheet, {})}>Rekening toevoegen</button>
    </section>`;
  }
  const invested = list.reduce((t, a) => t + (a.invested_cents || 0), 0);
  const known = list.filter((a) => a.result_cents != null);
  const result = known.reduce((t, a) => t + a.result_cents, 0);
  const pct = invested > 0 && known.length ? result / invested : null;
  const tone = result > 0 ? 'is-income' : result < 0 ? 'is-expense' : '';
  return html`<section class="vm-pillar" aria-label="Beleggingen">
    <${PillarHead} kind="invest" icon="arrow-up-right" title="Beleggingen" cents=${total} share=${share} />
    <div class="vm-p-facts">
      ${(() => {
        const withH = list.filter((a) => a.has_holdings);
        const bonds = withH.reduce((t, a) => t + (a.bonds_cents || 0), 0);
        const stocks = withH.reduce((t, a) => t + (a.stocks_cents || 0), 0);
        const cash = withH.reduce((t, a) => t + (a.cash_cents || 0), 0);
        const other = list.filter((a) => !a.has_holdings).reduce((t, a) => t + (a.balance_cents || 0), 0);
        if (!bonds || !withH.length) return null;
        const all = stocks + bonds + cash + other;
        const pct = (v) => (all > 0 ? ` · ${Math.round(v / all * 100)}%` : '');
        return html`<div class="vm-p-split">
          <${Fact} label="Aandelen" value=${money(stocks + other, { whole: true }) + pct(stocks + other)} />
          <${Fact} label="Obligaties" value=${money(bonds, { whole: true }) + pct(bonds)} />
          ${cash > 0 && html`<${Fact} label="Geld bij de broker" value=${money(cash, { whole: true }) + pct(cash)} />`}
        </div>`;
      })()}
      <${Fact} label="Ingelegd" value=${money(invested)} />
      ${known.length > 0 && html`<${Fact} label="Resultaat" tone=${tone}
        value=${`${money(result, { signed: true, negative: true })}${pct != null ? ` · ${(pct * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1, signDisplay: 'exceptZero' })}%` : ''}`} />`}
    </div>
    ${known.length > 0 && Math.abs(invested + result - total) >= 100 && html`<p class="vm-p-note num">Ingelegd + resultaat is ${money(invested + result, { whole: true })}: het verschil met de waarde is dividend dat al op je bankrekening staat of kosten die apart zijn betaald.</p>`}
    ${invested > 0 && known.length > 0 && html`<${Meter} value=${Math.max(0, total)} of=${Math.max(total, invested)} mark=${invested}
      label=${result >= 0 ? `${money(result, { whole: true })} boven je inleg · het streepje is wat je inlegde` : `${money(-result, { whole: true })} onder je inleg · het streepje is wat je inlegde`} kind="invest" />`}
    <${PillarRows} list=${list} />
  </section>`;
}

function HomePillar({ home, share }) {
  if (!home) {
    return html`<section class="vm-pillar is-empty" aria-label="Vastgoed">
      <${PillarHead} kind="home" icon="vermogen" title="Vastgoed" cents=${null} />
      <p class="vm-p-empty">Woning en hypotheek in je vermogen, met hoe ver je bent met aflossen.</p>
      <button class="section-link" onClick=${() => openSheet(MortgageSheet, {})}>Hypotheek toevoegen</button>
    </section>`;
  }
  const pct = home.repaid_pct;
  const repaid = home.original_cents != null && home.debt_cents != null ? Math.max(0, home.original_cents - home.debt_cents) : null;
  return html`<section class="vm-pillar" aria-label="Vastgoed">
    <${PillarHead} kind="home" icon="vermogen" title="Vastgoed" cents=${home.equity_cents} share=${share}
      note=${home.home_cents == null ? 'WOZ-waarde nog invullen' : home.included ? 'overwaarde' : 'overwaarde · niet in totaal'} />
    <div class="vm-p-facts">
      ${home.home_cents != null && html`<${Fact} label="Woning" value=${money(home.home_cents, { whole: true })} />`}
      ${home.debt_cents != null && html`<${Fact} label="Openstaande schuld" value=${money(-home.debt_cents, { whole: true, negative: true })} />`}
      ${repaid != null && html`<${Fact} label="Afgelost" value=${money(repaid, { whole: true })} />`}
    </div>
    ${pct != null && html`<${Meter} value=${repaid} of=${home.original_cents} kind="home"
      label=${`${(pct * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}% afgelost van ${euros(home.original_cents)}`} />`}
    ${home.home_cents != null && home.debt_cents != null && html`<${Meter} value=${Math.max(0, home.equity_cents)} of=${home.home_cents} kind="home" soft
      label=${`${Math.round(Math.max(0, home.equity_cents) / home.home_cents * 100)}% van de woning is van jullie`} />`}
    <button class="vm-p-row is-link" onClick=${() => openSheet(MortgageSheet, {})}>
      <span class="vm-p-row-main"><span class="vm-p-row-name">Hypotheek en jaaropgaven</span></span>
      <span class="vm-p-chev"><${Icon} name="chevron-right" size=${13} stroke=${2.6} /></span>
    </button>
  </section>`;
}

function Meter({ value, of, mark = null, label, kind, soft = false }) {
  const w = of > 0 ? Math.min(100, Math.max(0, (value / of) * 100)) : 0;
  const m = mark != null && of > 0 ? Math.min(100, (mark / of) * 100) : null;
  return html`<div class=${'vm-meter' + (soft ? ' is-soft' : '')} style=${{ '--c': colorVar(PILLAR_COLORS[kind]) }}>
    <div class="vm-meter-bar" role="img" aria-label=${label}><span style=${{ width: `${w}%` }}></span>${m != null && html`<i style=${{ left: `${m}%` }}></i>`}</div>
    <div class="vm-meter-label num">${label}</div>
  </div>`;
}

/* ---------- Hero ---------- */

function Hero({ data, accounts, desk = false }) {
  const [range, setRange] = useState('1j');
  const [scrub, setScrub] = useState(null);
  const series = data.series || [];
  const n = range === '6m' ? 7 : range === '1j' ? 13 : series.length;
  const pts = series.slice(-n);
  const points = pts.map((p) => ({ label: `Eind ${monthLabel(p.month)}`, short: monthLabel(p.month, { short: true, year: false }), value: p.total_cents }));
  const sel = scrub != null ? pts[scrub] : null;
  const value = sel ? sel.total_cents : data.total_cents;
  const first = pts[0]?.total_cents;
  const diff = pts.length > 1 ? data.total_cents - first : null;
  // vermogensgroei apart: the home's value is not money you put aside
  const homeDiff = pts.length > 1 && pts.at(-1).home_cents != null && pts[0].home_cents != null ? pts.at(-1).home_cents - pts[0].home_cents : null;
  const span = range === '6m' ? 'in 6 maanden' : range === '1j' ? 'in een jaar' : pts.length ? `sinds ${monthLabel(pts[0].month)}` : '';
  // Vrij vermogen = geld op de bank (betaal- en spaarrekeningen, min wat open staat op de
  // creditcard). De balk eronder toont hoe het hele vermogen over de drie pijlers verdeeld is.
  const { bank, free, invest, home, hasInvest } = pillarSplit(data, accounts || data.accounts || []);
  const segs = [['bank', 'Bank', bank], hasInvest && ['invest', 'Beleggingen', invest],
    home != null && data.home?.included && ['home', 'Vastgoed', home]].filter(Boolean).map(([k, l, v]) => [k, l, Math.max(0, v || 0)]);
  const whole = segs.reduce((t, [, , v]) => t + v, 0);
  return html`<section class="vm-hero" aria-label="Vermogen">
    <div class="vm-hero-label">Geld op de bank</div>
    <div class="vm-hero-amount rounded"><${Amount} cents=${free} whole animate negative /></div>
    <div class="vm-hero-sub">${free !== bank ? 'betaal- en spaarrekeningen, zonder vaste rekeningen' : 'betaal- en spaarrekeningen, potjes en buffer inbegrepen'}</div>
    ${segs.length > 1 && whole > 0 && html`<div class="vm-mix" role="img" aria-label=${'Verdeling: ' + segs.map(([, l, v]) => `${l} ${Math.round(v / whole * 100)}%`).join(', ')}>
      <div class="vm-mix-bar">${segs.map(([k, , v]) => v > 0 && html`<span key=${k} style=${{ flexGrow: v, '--c': colorVar(PILLAR_COLORS[k]) }}></span>`)}</div>
      <div class="vm-mix-legend">${segs.map(([k, l, v]) => html`<span key=${k} style=${{ '--c': colorVar(PILLAR_COLORS[k]) }}><i></i>${l} <b class="num">${Math.round(v / whole * 100)}%</b></span>`)}</div>
    </div>`}
    <div class="vm-total">
      <span class="vm-total-label">${sel ? `Totaal eind ${monthLabel(sel.month)}` : 'Totaal vermogen'}</span>
      <span class="vm-total-amount num">${money(value, { whole: true, negative: true })}</span>
    </div>
    <div class="vm-hero-sub num">${sel
      ? (scrub > 0 ? deltaText(sel.total_cents - pts[scrub - 1].total_cents, 'die maand') : ' ')
      : diff != null ? deltaText(diff, span) : ' '}</div>
    ${!sel && diff != null && homeDiff != null && Math.abs(homeDiff) >= 100 && html`<div class="vm-hero-note num">waarvan ${money(homeDiff, { whole: true, signed: true })} in je huis (waardestijging en aflossing), ${money(diff - homeDiff, { whole: true, signed: true })} op je rekeningen en beleggingen</div>`}
    ${data.pension_excluded_cents != null && html`<div class="vm-hero-note num">Pensioen (later beschikbaar) ${euros(data.pension_excluded_cents)}</div>`}
    ${desk && points.length > 1 && html`<div class="vm-range is-top"><${Segmented} value=${range} onChange=${(r) => { setRange(r); setScrub(null); }} options=${RANGES} label="Periode" size="small" /></div>`}
    ${desk && points.length > 1 && html`<div class="vm-chart">
      <${LineChart} points=${points} scrub=${scrub} onScrub=${setScrub} height=${240} axis
        label=${`Vermogen per maand, nu ${euros(data.total_cents)}`} />
    </div>`}
    ${!desk && points.length > 1 && html`<div class="vm-chart">
      <${LineChart} points=${points} scrub=${scrub} onScrub=${setScrub} height=${170}
        label=${`Vermogen per maand, nu ${euros(data.total_cents)}`} />
      <div class="vm-axis" aria-hidden="true"><span>${monthLabel(pts[0].month, { short: true })}</span><span>${monthLabel(pts[pts.length - 1].month, { short: true })}</span></div>
      <div class="vm-range"><${Segmented} value=${range} onChange=${(r) => { setRange(r); setScrub(null); }} options=${RANGES} label="Periode" size="small" /></div>
    </div>`}
  </section>`;
}

function deltaText(d, span) {
  if (!d) return `gelijk ${span}`;
  return html`<span class=${d > 0 ? 'is-income' : ''}>${money(d, { whole: true, signed: true, negative: true })}</span> ${span}`;
}

/* ---------- Suggestions ---------- */

function Suggestion({ s }) {
  const [busy, setBusy] = useState(false);
  const question = s.type === 'savings'
    ? html`Is <${Iban} iban=${s.iban} /> je spaarrekening?`
    : `Beleg je bij ${s.name || s.counterparty_name}?`;
  const yes = async () => {
    setBusy(true);
    try {
      await api.createAccount({ name: s.type === 'savings' ? (s.name || 'Spaarrekening') : (s.name || 'Beleggingen'), type: s.type, iban: s.iban || undefined, match: s.match?.length ? s.match : undefined });
      invalidate();
      toast({ text: s.type === 'savings' ? 'Spaarrekening toegevoegd' : 'Beleggingsrekening toegevoegd' });
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };
  const no = () => {
    const undo = commitLater('sugg:' + s.key, () => {
      const cur = getState().boot?.settings?.dismissed_suggestions || [];
      return api.updateSettings({ dismissed_suggestions: [...new Set([...cur, s.key])] });
    });
    toast({ text: 'Verborgen', icon: 'check', action: { label: 'Herstel', onClick: undo } });
  };
  return html`<${Card} class="vm-sugg">
    <span class=${'row-icon vm-sugg-icon'} style=${{ '--c': `var(--${typeInfo(s.type).color})` }} aria-hidden="true">
      ${s.type === 'savings' ? '🐷' : '📈'}
    </span>
    <span class="vm-sugg-main">
      <span class="vm-sugg-q">${question}</span>
      ${s.counterparty_name && s.type === 'savings' && html`<span class="vm-sugg-sub">${s.counterparty_name}</span>`}
    </span>
    <span class="vm-sugg-actions">
      <${Button} size="small" variant="gray" onClick=${no} disabled=${busy}>Nee</${Button}>
      <${Button} size="small" onClick=${yes} loading=${busy}>Ja</${Button}>
    </span>
  </${Card}>`;
}

/* ---------- Account rows ---------- */

function subtitleFor(a) {
  if (a.type === 'investment') {
    if (a.invested_cents == null) return '';
    const stale = a.has_holdings && a.price_stale && a.as_of ? ` · koers van ${shortDate(a.as_of)}` : '';
    return `inleg ${euros(a.invested_cents)}${stale}`;
  }
  if (a.type === 'credit') return a.outstanding_cents > 0 ? 'open' : 'niets open';
  if (a.iban) return html`<${Iban} iban=${a.iban} />`;
  return a.as_of ? `bijgewerkt ${shortDate(a.as_of)}` : 'handmatig';
}

function AccountRow({ a }) {
  const t = typeInfo(a.type);
  const main = a.type === 'credit'
    ? money(a.outstanding_cents || 0)
    : a.balance_cents == null ? '—' : money(a.balance_cents, { negative: true });
  const res = a.type === 'investment' ? a.result_cents : null;
  const value = html`<span class="vm-value">
    <span class="num vm-balance">${main}</span>
    ${res != null && html`<span class=${'num vm-result' + (res > 0 ? ' is-income' : '')}>${a.has_holdings ? resultText(res, a.result_pct) : money(res, { whole: true, signed: true, negative: true })}</span>`}
  </span>`;
  const label = `${a.name}, ${main}${res != null ? `, resultaat ${money(res, { whole: true, negative: true })}` : ''}`;
  return html`<${ListRow} icon=${t.icon} iconColor=${t.color} title=${a.name} subtitle=${html`<span class="num">${subtitleFor(a)}</span>`}
    value=${value} chevron onClick=${() => openSheet(AccountSheet, { account: a })} label=${label} />`;
}

/* ---------- Account sheet ---------- */

export function AccountSheet({ close, account = null }) {
  const isNew = !account;
  const meta = useQuery(isNew ? null : 'accounts', () => api.accounts());
  const full = meta.data?.find((x) => x.id === account?.id);
  const imported = full ? (full.n_imported ?? 0) > 0 : !!account?.as_of && !!account?.iban;
  const [name, setName] = useState(account?.name || '');
  const [type, setType] = useState(account?.type || 'checking');
  const [balance, setBalance] = useState(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const canBalance = (type === 'checking' || type === 'savings') && !imported;
  // Rekeningnummer zelf invullen kan bij een rekening zonder eigen afschriften (DEGIRO, een
  // spaarrekening): betalingen naar dat nummer zijn dan altijd een overboeking naar deze rekening.
  const canIban = type !== 'credit' && !imported;
  const [iban, setIban] = useState(account?.iban || '');
  const cleanIban = (v) => v.replace(/\s+/g, '').toUpperCase();

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      let id = account?.id;
      if (isNew) {
        const res = await api.createAccount({ name: name.trim(), type, iban: canIban && iban.trim() ? cleanIban(iban) : undefined });
        id = res.id;
      } else if (name.trim() !== account.name || type !== account.type) {
        await api.updateAccount(id, { name: name.trim(), type });
      }
      if (!isNew && canIban && cleanIban(iban) !== (account.iban || '')) {
        await api.updateAccount(id, { iban: cleanIban(iban) || null });
      }
      if (canBalance && touched && balance != null) {
        await api.updateAccount(id, { manual_balance_cents: balance, manual_balance_date: todayISO() });
      }
      invalidate();
      close();
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };

  const remove = (e) => openMenu(e.currentTarget, [{
    label: `Verwijder ${account.name}`, icon: 'trash', destructive: true, onSelect: () => {
      const undo = commitLater('account:' + account.id, () => api.deleteAccount(account.id));
      close();
      toast({ text: `${account.name} verwijderd`, icon: 'trash', action: { label: 'Herstel', onClick: undo } });
    },
  }]);

  return html`<${Sheet} title=${isNew ? 'Nieuwe rekening' : account.name} detents=${['large']}
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold onClick=${save} disabled=${!name.trim() || busy}>${isNew ? 'Voeg toe' : 'Klaar'}</${SheetButton}>`}>
    <div class="sheet-pad">
      ${!isNew && html`<div class="vm-sheet-head">
        <div class="vm-sheet-amount rounded num">${account.type === 'credit' ? money(account.outstanding_cents || 0) : account.balance_cents == null ? '—' : money(account.balance_cents, { negative: true })}</div>
        <div class="vm-sheet-sub">${account.type === 'credit' ? 'open' : account.as_of ? `op ${longDate(account.as_of)}` : ''}</div>
        ${account.iban && html`<div class="vm-sheet-sub"><${Iban} iban=${account.iban} open /></div>`}
      </div>`}
      ${canIban && html`<${List} footer=${type === 'investment' ? 'Het rekeningnummer waar je naar overmaakt, bij DEGIRO je persoonlijke stortingsrekening. Zo herkent Cents elke inleg, ook als die op dezelfde naam staat als je andere overboekingen.' : 'Optioneel. Betalingen naar dit nummer telt Cents als overboeking naar deze rekening.'}>
        <${TextField} label="Rekeningnummer" value=${iban} onInput=${setIban} placeholder="NL00 BANK 0000 0000 00" maxLength=${40} />
      </${List}>`}

      <${List}>
        <${TextField} label="Naam" value=${name} onInput=${setName} placeholder="Spaarrekening" maxLength=${60} enterkeyhint="done" />
      </${List}>
      <${List} header="Soort">
        ${TYPES.map((t) => html`<${ListRow} key=${t.type} icon=${t.icon} iconColor=${t.color} title=${t.label}
          selected=${type === t.type} onClick=${() => setType(t.type)} />`)}
      </${List}>
      ${!isNew && type === 'savings' && html`<${List} footer="Een vaste rekening (deposito, termijnrekening) telt mee in je vermogen, maar niet als vrij geld: niet in vrij vermogen, nog te besteden en de buffer.">
        <li class="field-row"><label class="field-label sa-grow" for="vm-locked">Vaste rekening</label>
          <${Switch} id="vm-locked" checked=${!!(full?.locked ?? account.locked)} label="Vaste rekening"
            onChange=${(on) => api.updateAccount(account.id, { locked: on }).then(() => invalidate(), apiFail)} /></li>
      </${List}>`}
      ${canBalance && html`<${List} header="Saldo" footer=${full?.manual_balance_date ? `Laatst ingevuld ${longDate(full.manual_balance_date)}` : null}>
        <${AmountField} label="Saldo nu" cents=${touched ? balance : (full?.manual_balance_cents ?? null)} onChange=${(c) => { setBalance(c); setTouched(true); }} />
      </${List}>`}
      ${!isNew && account.type === 'investment' && type === 'investment' && (account.has_holdings
        ? html`<${HoldingsPart} account=${account} />`
        : html`<${InvestmentValues} account=${account} />
          <${List} footer="Of importeer je DEGIRO-export (Transacties, Rekeningoverzicht of Portefeuille) of je eToro-rekeningoverzicht (Excel) via Importeren.">
            <${ListRow} icon="plus" title="Aankoop toevoegen" tint onClick=${() => openSheet(TradeSheet, { account })} />
          </${List}>`)}
      ${!isNew && account.type === 'credit' && type === 'credit' && html`<${CreditPart} account=${account} close=${close} />`}
      ${!isNew && !imported && html`<${List}><${ListRow} title="Verwijder rekening" destructive onClick=${remove} /></${List}>`}
    </div>
  </${Sheet}>`;
}

function InvestmentValues({ account }) {
  const pending = usePending();
  const [cents, setCents] = useState(null);
  const [date, setDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState([]);
  const values = [...(account.values || []), ...added].filter((v) => !pending.has('value:' + v.id))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  const add = async () => {
    if (!(cents > 0) || busy) return;
    setBusy(true);
    try {
      const v = await api.addAccountValue(account.id, { date: date || todayISO(), value_cents: cents });
      setAdded((x) => [...x, v]);
      setCents(null);
      invalidate();
      toast({ text: `Waarde ${money(v.value_cents)} bewaard` });
    } catch (err) {
      toast({ text: err.message, icon: 'warning' });
    }
    setBusy(false);
  };
  const remove = (e, v) => openMenu(e.currentTarget, [{
    label: 'Verwijder', icon: 'trash', destructive: true, onSelect: () => {
      const undo = commitLater('value:' + v.id, () => api.deleteAccountValue(v.id));
      toast({ text: `Waarde van ${shortDate(v.date)} verwijderd`, icon: 'trash', action: { label: 'Herstel', onClick: undo } });
    },
  }]);
  return html`
    <${List} header="Waarde bijwerken">
      <${AmountField} label="Waarde" cents=${cents} onChange=${setCents} />
      <${DateField} label="Datum" value=${date} onChange=${setDate} max=${todayISO()} />
      <li class="field-row vm-add-row"><${Button} variant="tinted" size="medium" block onClick=${add} disabled=${!(cents > 0)} loading=${busy}>Bewaar waarde</${Button}></li>
    </${List}>
    ${values.length > 0 && html`<${List} header="Eerdere waarden">
      ${values.map((v) => html`<${ListRow} key=${v.id} title=${longDate(v.date)} value=${html`<span class="num">${money(v.value_cents)}</span>`}
        onClick=${(e) => remove(e, v)} label=${`${longDate(v.date)}, ${money(v.value_cents)}. Opties`} />`)}
    </${List}>`}`;
}

function CreditPart({ account, close }) {
  return html`<${List} header="Creditcard" footer=${account.unexplained_cents > 0 ? `${euros(account.unexplained_cents)} van de laatste afschrijving staat nog niet als uitgave in Cents` : null}>
    <${ListRow} title="Open" value=${html`<span class="num">${money(account.outstanding_cents || 0)}</span>`} />
    <${ListRow} icon="plus" title="Uitgave toevoegen" tint onClick=${() => { close(); setTimeout(() => openAddExpense({ account_id: account.id }), 320); }} />
  </${List}>`;
}

/* ---------- Woning (SPEC §7.2) ---------- */

function HomeRow({ home }) {
  if (!home) {
    return html`<${ListRow} emoji="🏠" color="indigo" title="Hypotheek toevoegen" subtitle="Woning en schuld in je vermogen"
      tint onClick=${() => openSheet(MortgageSheet, {})} />`;
  }
  const value = home.equity_cents != null ? money(home.equity_cents, { negative: true }) : '—';
  const sub = home.home_cents == null ? html`<span class="vm-home-line">WOZ-waarde nog invullen</span>` : html`
    <span class="vm-home-line num">Woning ${euros(home.home_cents)}</span>
    ${home.debt_cents != null && html`<span class="vm-home-line num">Openstaande schuld − ${euros(home.debt_cents)}</span>`}`;
  const pct = home.repaid_pct;
  const progress = pct != null && html`<span class="vm-home-line">
    <span class="vm-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(pct * 100)}
      aria-label=${`${Math.round(pct * 100)} procent afgelost`}><span style=${{ width: `${Math.min(100, pct * 100)}%` }}></span></span>
    <span class="num">${(pct * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}% afgelost van ${euros(home.original_cents)}</span>
  </span>`;
  return html`<${ListRow} class="vm-home" emoji="🏠" color="indigo" title="Overwaarde"
    subtitle=${html`${sub}${progress || ''}${!home.included && home.home_cents != null ? html`<span class="vm-home-line">niet meegeteld</span>` : ''}`}
    value=${html`<span class="num vm-balance">${value}</span>`} chevron
    onClick=${() => openSheet(MortgageSheet, {})} label=${`Woning, overwaarde ${value}`} />`;
}

/** Rejected mutation from a menu or switch: show the API message (e.g. 409 merchant_linked). */
const apiFail = (err) => toast({ text: err.message, icon: 'warning' });

export function MortgageSheet({ close }) {
  const { data: m, reload } = useQuery('mortgage', () => api.mortgage());
  const done = () => { invalidate(); reload?.(); };
  return html`<${Sheet} title="Woning" detents=${['large']}
      trailing=${html`<${SheetButton} bold onClick=${close}>Klaar</${SheetButton}>`}>
    <div class="sheet-pad">
      ${!m ? html`<${Skeleton} h=${120} r=${12} />`
        : !m.exists ? html`<${MortgageSetup} onDone=${done} />`
        : html`<${MortgageDetail} m=${m} onChange=${done} close=${close} />`}
    </div>
  </${Sheet}>`;
}

function MortgageSetup({ onDone }) {
  const [n, setN] = useState(1);
  const [names, setNames] = useState(['Deel 1', 'Deel 2', 'Deel 3', 'Deel 4']);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      await api.createMortgage(names.slice(0, n).map((x, i) => ({ name: x.trim() || `Deel ${i + 1}` })));
      onDone();
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };
  return html`
    <p class="vm-mg-intro">Je jaaropgave van de hypotheek noemt per leningdeel de schuld, de betaalde rente en wat je hebt afgelost.</p>
    <${List} header="Leningdelen">
      <li class="field-row"><span class="field-label">Aantal</span>
        <${Segmented} value=${n} onChange=${setN} options=${[[1, '1'], [2, '2'], [3, '3'], [4, '4']]} label="Aantal leningdelen" size="small" /></li>
      ${names.slice(0, n).map((x, i) => html`<${TextField} key=${i} label=${`Naam ${i + 1}`} value=${x} maxLength=${60}
        placeholder=${`Deel ${i + 1}`} onInput=${(v) => setNames((all) => all.map((y, j) => (j === i ? v : y)))} />`)}
    </${List}>
    <${List} footer="Bijvoorbeeld ‘Deel 1 – annuïtair’ of ‘Deel 2 – aflossingsvrij’.">
      <li class="field-row vm-add-row"><${Button} variant="filled" size="medium" block onClick=${create} loading=${busy}>Volgende</${Button}></li>
    </${List}>`;
}

function MortgageDetail({ m, onChange, close }) {
  const head = m.equity_cents != null ? money(m.equity_cents, { negative: true }) : money(-(m.debt_cents || 0), { negative: true });
  const setLink = (e) => openMenu(e.currentTarget, [
    ...m.candidates.map((c) => ({ label: `${c.merchant_name || c.merchant_key}${c.amount_cents ? ` · ${money(c.amount_cents)}` : ''}`,
      icon: m.payment?.merchant_key === c.merchant_key ? 'check' : undefined,
      onSelect: () => api.updateMortgage({ merchant_key: c.merchant_key }).then(onChange, apiFail) })),
    { label: 'Automatisch kiezen', onSelect: () => api.updateMortgage({ merchant_key: null }).then(onChange, apiFail) },
    { label: 'Niet koppelen', onSelect: () => api.updateMortgage({ merchant_key: '' }).then(onChange, apiFail) },
  ]);
  const remove = (e) => openMenu(e.currentTarget, [{
    label: 'Verwijder hypotheek en woning', icon: 'trash', destructive: true, onSelect: async () => {
      await api.deleteMortgage();
      invalidate();
      close();
      toast({ text: 'Hypotheek verwijderd', icon: 'trash' });
    },
  }]);
  return html`
    ${(m.equity_cents != null || m.debt_cents != null) && html`<div class="vm-sheet-head">
      <div class="vm-sheet-amount rounded num">${head}</div>
      <div class="vm-sheet-sub">${m.equity_cents != null ? 'overwaarde' : 'hypotheek'}</div>
    </div>`}
    <${List} header="Hypotheek" footer=${m.latest_year
      ? `Geschat vanaf je jaaropgave ${m.latest_year}${m.repaid_this_year_cents > 0 ? `, min ${euros(m.repaid_this_year_cents)} afgelost dit jaar` : ''}.` : 'Vul je jaaropgave in voor de schuld.'}>
      ${m.parts.map((p) => html`<${ListRow} key=${p.id} title=${p.name}
        subtitle=${p.original_cents ? `geleend ${euros(p.original_cents)}` : null}
        value=${html`<span class="num">${p.debt_cents == null ? '—' : money(-p.debt_cents, { negative: true })}</span>`} />`)}
      ${m.parts.length > 1 && m.debt_cents != null && html`<${ListRow} title=${html`<strong>Totaal</strong>`}
        subtitle=${m.original_cents ? `geleend ${euros(m.original_cents)}` : null}
        value=${html`<strong class="num">${money(-m.debt_cents, { negative: true })}</strong>`} />`}
    </${List}>
    <${MortgageSummary} m=${m} />
    <${YearForm} m=${m} onChange=${onChange} />
    <${HomeValue} m=${m} onChange=${onChange} />
    <${List} footer=${m.repaid_share != null && m.payment ? `Van elke betaling telt ${String(Math.round(m.repaid_share * 1000) / 10).replace('.', ',')} % als afgelost (gespaard), de rest als vaste lasten.` : null}>
      <li class="field-row"><label class="field-label sa-grow" for="vm-mg-inc">Meetellen in vermogen</label>
        <${Switch} id="vm-mg-inc" checked=${m.include_in_networth} label="Woning meetellen in vermogen"
          onChange=${(on) => api.updateMortgage({ include_in_networth: on }).then(onChange, apiFail)} /></li>
      <${ListRow} title="Betaling" value=${html`<span class="vm-mg-pay">${m.payment ? m.payment.merchant_name : 'Geen'}</span>`}
        chevron onClick=${setLink} label=${`Gekoppelde betaling: ${m.payment ? m.payment.merchant_name : 'geen'}. Wijzig`} />
    </${List}>
    <${List}><${ListRow} title="Verwijder hypotheek" destructive onClick=${remove} /></${List}>`;
}

// Alle leningdelen samen: woning, schuld, overwaarde, hoe ver met aflossen en het laatste jaar.
function MortgageSummary({ m }) {
  if (m.debt_cents == null) return null;
  const y = m.latest_year;
  const inYear = (k) => m.parts.reduce((t, p) => t + ((p.years.find((e) => e.year === y) || {})[k] || 0), 0);
  const pct = m.repaid_pct;
  const rows = [
    m.home_cents != null && ['Woningwaarde', money(m.home_cents)],
    ['Openstaande schuld', money(-m.debt_cents, { negative: true })],
    m.equity_cents != null && ['Overwaarde', money(m.equity_cents, { negative: true })],
    pct != null && ['Afgelost', html`<span class="vm-progress"><span style=${{ width: `${Math.min(100, pct * 100)}%` }}></span></span>
      ${(pct * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}% · ${money(Math.max(0, m.original_cents - m.debt_cents))}`],
    y && [`Rente ${y}`, money(inYear('interest_cents'))],
    y && [`Afgelost ${y}`, money(inYear('repaid_cents'))],
  ].filter(Boolean);
  return html`<${List} header="Samen">
    ${rows.map(([t, v]) => html`<${ListRow} key=${t} title=${t} value=${html`<span class="num">${v}</span>`} />`)}
  </${List}>`;
}

function YearForm({ m, onChange }) {
  const [year, setYear] = useState(m.missing_year || m.form_year);
  const filled = (y) => Object.fromEntries(m.parts.map((p) => {
    const e = p.years.find((x) => x.year === y);
    const prev = p.years.find((x) => x.year === y - 1);
    const start = e?.principal_cents != null ? 0
      : e ? e.debt_end_cents + (e.repaid_cents || 0) : (prev ? prev.debt_end_cents : null);
    return [p.id, { debt_start_cents: start, principal_cents: e?.principal_cents ?? null, debt_end_cents: e?.debt_end_cents ?? null, interest_cents: e?.interest_cents ?? null }];
  }));
  const [vals, setVals] = useState(() => filled(year));
  const [busy, setBusy] = useState(false);
  const pick = (y) => { setYear(y); setVals(filled(y)); };
  const set = (pid, k, c) => setVals((v) => ({ ...v, [pid]: { ...v[pid], [k]: c } }));
  const ready = m.parts.every((p) => vals[p.id]?.debt_end_cents != null);
  // afgelost = restant begin − restant eind (bijgeleend of onbekend begin: 0)
  // nieuwe lening in dat jaar: restant op 1 januari is 0, dan telt het bedrag bij ingang
  const begin = (v) => (v?.debt_start_cents === 0 ? v?.principal_cents : v?.debt_start_cents);
  const repaid = (v) => (begin(v) != null && v?.debt_end_cents != null ? Math.max(0, begin(v) - v.debt_end_cents) : 0);
  const entered = m.years.includes(year);
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await api.saveMortgageYear(year, m.parts.map((p) => ({ part_id: p.id, debt_end_cents: vals[p.id].debt_end_cents || 0,
        interest_cents: vals[p.id].interest_cents || 0, repaid_cents: repaid(vals[p.id]),
        principal_cents: vals[p.id].debt_start_cents === 0 ? (vals[p.id].principal_cents ?? null) : null })));
      onChange();
      toast({ text: `Jaaropgave ${year} bewaard` });
    } catch (err) {
      toast({ text: err.message, icon: 'warning' });
    }
    setBusy(false);
  };
  const other = (e) => openMenu(e.currentTarget, Array.from({ length: 6 }, (_, i) => m.form_year - i).map((y) => ({
    label: `${y}${m.years.includes(y) ? ' · ingevuld' : ''}`, icon: y === year ? 'check' : undefined, onSelect: () => pick(y),
  })));
  return html`<div class="vm-mg-year">
    <div class="vm-mg-year-h">
      <h3>Jaaropgave ${year} ${entered ? 'bijwerken' : 'invullen'}</h3>
      <button class="section-link" onClick=${other}>Ander jaar</button>
    </div>
    ${m.parts.map((p) => html`<${List} key=${p.id} header=${m.parts.length > 1 ? p.name : null}>
      <${AmountField} label=${`Restant op 01-01-${year}`} cents=${vals[p.id]?.debt_start_cents} onChange=${(c) => set(p.id, 'debt_start_cents', c)} />
      ${vals[p.id]?.debt_start_cents === 0 && html`<${AmountField} label="Bedrag bij ingang" cents=${vals[p.id]?.principal_cents} onChange=${(c) => set(p.id, 'principal_cents', c)} />`}
      <${AmountField} label=${`Restant op 31-12-${year}`} cents=${vals[p.id]?.debt_end_cents} onChange=${(c) => set(p.id, 'debt_end_cents', c)} />
      <${AmountField} label="Betaalde rente" cents=${vals[p.id]?.interest_cents} onChange=${(c) => set(p.id, 'interest_cents', c)} />
      <${ListRow} title="Afgelost" value=${html`<span class="num">${money(repaid(vals[p.id]))}</span>`} />
    </${List}>`)}
    <${List} footer=${`Neem de bedragen over van je jaaropgave. Afgelost rekent Cents zelf uit. Nieuwe lening dat jaar? Vul bij 1 januari 0 in en daarna het bedrag bij ingang. De opgave over ${m.form_year + 1} komt begin ${m.form_year + 2}.`}>
      <li class="field-row vm-add-row"><${Button} variant="tinted" size="medium" block onClick=${save} disabled=${!ready} loading=${busy}>Bewaar jaaropgave</${Button}></li>
    </${List}>
  </div>`;
}

function HomeValue({ m, onChange }) {
  const [cents, setCents] = useState(null);
  const [date, setDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!(cents > 0) || busy) return;
    setBusy(true);
    try {
      await api.addHomeValue({ date: date || todayISO(), value_cents: cents });
      setCents(null);
      onChange();
      toast({ text: `Woningwaarde ${money(cents)} bewaard` });
    } catch (err) {
      toast({ text: err.message, icon: 'warning' });
    }
    setBusy(false);
  };
  const last = m.home_values.at(-1);
  const remove = (e, v) => openMenu(e.currentTarget, [{ label: 'Verwijder', icon: 'trash', destructive: true,
    onSelect: () => api.deleteHomeValue(v.id).then(onChange, apiFail) }]);
  return html`
    <${List} header="Woningwaarde" footer=${last ? `Nu ${euros(last.value_cents)}, sinds ${longDate(last.date)}. De WOZ-waarde staat op je aanslag van de gemeente.` : 'De WOZ-waarde staat op je aanslag van de gemeente.'}>
      <${AmountField} label="WOZ-waarde" cents=${cents} onChange=${setCents} />
      <${DateField} label="Peildatum" value=${date} onChange=${setDate} max=${todayISO()} />
      <li class="field-row vm-add-row"><${Button} variant="tinted" size="medium" block onClick=${add} disabled=${!(cents > 0)} loading=${busy}>Bewaar waarde</${Button}></li>
    </${List}>
    ${m.home_values.length > 1 && html`<${List} header="Eerdere waarden">
      ${[...m.home_values].reverse().map((v) => html`<${ListRow} key=${v.id} title=${longDate(v.date)} value=${html`<span class="num">${money(v.value_cents)}</span>`}
        onClick=${(e) => remove(e, v)} label=${`${longDate(v.date)}, ${money(v.value_cents)}. Opties`} />`)}
    </${List}>`}`;
}

/* ---------- Pensioen, schulden, overig bezit (SPEC §7.3) ---------- */

const ASSET_KINDS = [
  { kind: 'possession', group: 'Bezittingen', add: 'Bezitting toevoegen', icon: 'key', emoji: '🚗', color: 'green',
    placeholder: 'Auto', valueLabel: 'Waarde', hint: null },
  { kind: 'pension', group: 'Pensioen', add: 'Pensioen toevoegen', icon: 'clock', emoji: '🧓', color: 'purple',
    placeholder: 'Pensioenfonds werkgever', valueLabel: 'Opgebouwd', hint: 'Het opgebouwde bedrag staat op mijnpensioenoverzicht.nl of je UPO.' },
  { kind: 'debt', group: 'Schulden', add: 'Schuld toevoegen', icon: 'creditcard', emoji: '🧾', color: 'orange',
    placeholder: 'Studieschuld DUO', valueLabel: 'Restschuld', hint: 'De restschuld staat in je jaaroverzicht van de lening (bij DUO: Mijn DUO).' },
  { kind: 'other', group: 'Overig bezit', add: 'Overig bezit toevoegen', icon: 'euro', emoji: '💎', color: 'teal',
    placeholder: 'Crypto, kinderrekening, contant', valueLabel: 'Waarde', hint: null },
];
const kindInfo = (k) => ASSET_KINDS.find((x) => x.kind === k);
const DEBT_KINDS = [['studieschuld', 'Studieschuld'], ['lening', 'Lening'], ['overig', 'Overig']];

function AssetRow({ a }) {
  const k = kindInfo(a.kind);
  if (a.kind === 'possession') {
    const value = money(a.value_cents ?? 0, { negative: true });
    const sub = a.sold ? `verkocht ${shortDate(a.sale_date)}` : `− ${money(a.monthly_cents)} per maand waardeverlies`;
    return html`<${ListRow} emoji=${a.emoji || k.emoji} color=${k.color} title=${a.name} subtitle=${html`<span class="num">${sub}</span>`}
      value=${html`<span class="num vm-balance">${value}</span>`} chevron
      onClick=${() => openSheet(PossessionSheet, { id: a.id })} label=${`${a.name}, ${value}`} />`;
  }
  const value = a.value_cents == null ? '—' : money(a.signed_cents, { negative: true });
  const sub = !a.as_of ? 'nog geen bedrag' : !a.include ? 'niet meegeteld' : `bijgewerkt ${shortDate(a.as_of)}`;
  return html`<${ListRow} emoji=${k.emoji} color=${k.color} title=${a.name} subtitle=${html`<span class="num">${sub}</span>`}
    value=${html`<span class="num vm-balance">${value}</span>`} chevron
    onClick=${() => openSheet(AssetSheet, { kind: a.kind, id: a.id })} label=${`${a.name}, ${value}`} />`;
}

export function AssetSheet({ close, kind, id = null }) {
  if (kind === 'possession') return html`<${PossessionSheet} close=${close} id=${id} />`;
  return html`<${OtherAssetSheet} close=${close} kind=${kind} id=${id} />`;
}

function OtherAssetSheet({ close, kind, id = null }) {
  const [itemId, setItemId] = useState(id);
  const { data, reload } = useQuery('assets', () => api.assets());
  const k = kindInfo(kind);
  const item = data?.items.find((x) => x.id === itemId);
  const done = () => { invalidate(); reload?.(); };
  return html`<${Sheet} title=${item ? item.name : k.add.replace(' toevoegen', '')} detents=${['large']}
      leading=${!itemId ? html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>` : null}
      trailing=${itemId ? html`<${SheetButton} bold onClick=${close}>Klaar</${SheetButton}>` : null}>
    <div class="sheet-pad">
      ${!itemId ? html`<${AssetSetup} k=${k} onCreated=${(newId) => { setItemId(newId); done(); }} />`
        : !item ? html`<${Skeleton} h=${120} r=${12} />`
        : html`<${AssetDetail} a=${item} k=${k} candidates=${data.candidates} onChange=${done} close=${close} />`}
    </div>
  </${Sheet}>`;
}

function AssetSetup({ k, onCreated }) {
  const [name, setName] = useState('');
  const [debtKind, setDebtKind] = useState('studieschuld');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await api.createAsset({ kind: k.kind, name: name.trim(), ...(k.kind === 'debt' ? { debt_kind: debtKind } : {}) });
      onCreated(res.id);
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };
  return html`
    <${List} footer=${k.kind === 'pension' ? 'Pensioen telt standaard niet mee in je vermogen: je kunt er pas later bij.' : null}>
      <${TextField} label="Naam" value=${name} onInput=${setName} placeholder=${k.placeholder} maxLength=${60} enterkeyhint="done"
        onEnter=${k.kind === 'debt' ? (() => document.activeElement?.blur()) : create} />
      ${k.kind === 'debt' && html`<li class="field-row"><span class="field-label">Soort</span>
        <${Segmented} value=${debtKind} onChange=${setDebtKind} options=${DEBT_KINDS} label="Soort schuld" size="small" /></li>`}
    </${List}>
    <${List}>
      <li class="field-row vm-add-row"><${Button} variant="filled" size="medium" block onClick=${create} disabled=${!name.trim()} loading=${busy}>Volgende</${Button}></li>
    </${List}>`;
}

function AssetDetail({ a, k, candidates, onChange, close }) {
  const debt = a.kind === 'debt';
  const setLink = (e) => openMenu(e.currentTarget, [
    ...candidates.map((c) => ({ label: `${c.merchant_name || c.merchant_key}${c.amount_cents ? ` · ${money(c.amount_cents)}` : ''}`,
      icon: a.payment?.merchant_key === c.merchant_key ? 'check' : undefined,
      onSelect: () => api.updateAsset(a.id, { merchant_key: c.merchant_key }).then(onChange, (err) => toast({ text: err.message, icon: 'warning' })) })),
    { label: 'Niet koppelen', onSelect: () => api.updateAsset(a.id, { merchant_key: null }).then(onChange, apiFail) },
  ]);
  const remove = (e) => openMenu(e.currentTarget, [{
    label: `Verwijder ${a.name}`, icon: 'trash', destructive: true, onSelect: async () => {
      await api.deleteAsset(a.id);
      invalidate();
      close();
      toast({ text: `${a.name} verwijderd`, icon: 'trash' });
    },
  }]);
  const sub = !a.as_of ? '' : a.estimated
    ? `geschat: ${euros(a.repaid_since_cents)} afgelost sinds ${shortDate(a.as_of)}` : `op ${longDate(a.as_of)}`;
  return html`
    ${a.value_cents != null && html`<div class="vm-sheet-head">
      <div class="vm-sheet-amount rounded num">${money(a.signed_cents, { negative: true })}</div>
      <div class="vm-sheet-sub">${sub}</div>
    </div>`}
    <${EntryForm} a=${a} k=${k} onChange=${onChange} />
    ${a.entries.length > 0 && html`<${List} header="Eerdere bedragen">
      ${a.entries.map((e) => html`<${ListRow} key=${e.id} title=${longDate(e.date)} subtitle=${e.note || null}
        value=${html`<span class="num">${money(e.value_cents)}</span>`}
        onClick=${(ev) => openMenu(ev.currentTarget, [{ label: 'Verwijder', icon: 'trash', destructive: true,
          onSelect: () => api.deleteAssetEntry(a.id, e.id).then(onChange, apiFail) }])}
        label=${`${longDate(e.date)}, ${money(e.value_cents)}. Opties`} />`)}
    </${List}>`}
    <${List} footer=${debt && a.repaid_share != null && a.payment ? `Van elke betaling telt ${Math.round(a.repaid_share * 100)} % als afgelost (gespaard), de rest als vaste lasten.`
      : debt && a.payment ? 'Vul rente en afgelost in om de betaling te splitsen.' : null}>
      <li class="field-row"><label class="field-label sa-grow" for=${'vm-as-inc-' + a.id}>Meetellen in vermogen</label>
        <${Switch} id=${'vm-as-inc-' + a.id} checked=${a.include} label="Meetellen in vermogen"
          onChange=${(on) => api.updateAsset(a.id, { include: on }).then(onChange, apiFail)} /></li>
      ${debt && html`<${ListRow} title="Betaling" value=${html`<span class="vm-mg-pay">${a.payment ? a.payment.merchant_name : 'Geen'}</span>`}
        chevron onClick=${setLink} label=${`Gekoppelde betaling: ${a.payment ? a.payment.merchant_name : 'geen'}. Wijzig`} />`}
    </${List}>
    <${List}><${ListRow} title="Verwijder" destructive onClick=${remove} /></${List}>`;
}

function EntryForm({ a, k, onChange }) {
  const debt = a.kind === 'debt';
  const [cents, setCents] = useState(null);
  const [date, setDate] = useState(todayISO());
  const [interest, setInterest] = useState(null);
  const [repaid, setRepaid] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = cents != null && cents >= 0;
  const add = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      await api.addAssetEntry(a.id, { date: date || todayISO(), value_cents: cents, note: note.trim() || null,
        ...(debt ? { interest_cents: interest, repaid_cents: repaid } : {}) });
      setCents(null); setInterest(null); setRepaid(null); setNote('');
      onChange();
      toast({ text: `${k.valueLabel} ${money(cents)} bewaard` });
    } catch (err) {
      toast({ text: err.message, icon: 'warning' });
    }
    setBusy(false);
  };
  return html`<${List} header=${a.entries.length ? 'Bijwerken' : 'Bedrag invullen'} footer=${debt ? 'Rente en afgelost over het afgelopen jaar zijn optioneel. ' + (k.hint || '') : k.hint}>
    <${AmountField} label=${k.valueLabel} cents=${cents} onChange=${setCents} />
    <${DateField} label="Datum" value=${date} onChange=${setDate} max=${todayISO()} />
    ${debt && html`<${AmountField} label="Betaalde rente" cents=${interest} onChange=${setInterest} />
      <${AmountField} label="Afgelost" cents=${repaid} onChange=${setRepaid} />`}
    <${TextField} label="Notitie" value=${note} onInput=${setNote} placeholder="Optioneel" maxLength=${200} />
    <li class="field-row vm-add-row"><${Button} variant="tinted" size="medium" block onClick=${add} disabled=${!ok} loading=${busy}>Bewaar</${Button}></li>
  </${List}>`;
}

/* ---------- Skeleton ---------- */

function VermogenSkeleton() {
  return html`<div aria-busy="true" aria-label="Laden">
    <div class="vm-hero">
      <${Skeleton} w=${70} h=${15} />
      <${Skeleton} w=${200} h=${48} r=${12} style=${{ margin: '8px 0' }} />
      <${Skeleton} w=${150} h=${15} />
      <${Skeleton} h=${170} r=${12} style=${{ marginTop: '16px' }} />
    </div>
    <div class="section"><${Skeleton} w=${160} h=${22} />
      <div class="inset" style=${{ marginTop: '10px' }}>${[0, 1, 2].map(() => html`<div class="row has-lead is-two"><span class="row-lead"><${Skeleton} w=${30} h=${30} r=${7} /></span><span class="row-main"><${Skeleton} w="50%" h=${15} /><${Skeleton} w="30%" h=${13} /></span></div>`)}</div>
    </div>
  </div>`;
}
