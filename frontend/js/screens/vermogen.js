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

export const TYPES = [
  { type: 'checking', label: 'Betaalrekening', group: 'Betaalrekeningen', icon: 'wallet', color: 'blue' },
  { type: 'savings', label: 'Spaarrekening', group: 'Sparen', icon: 'piggy', color: 'teal' },
  { type: 'investment', label: 'Beleggingen', group: 'Beleggingen', icon: 'arrow-up-right', color: 'indigo' },
  { type: 'credit', label: 'Creditcard', group: 'Creditcard', icon: 'creditcard', color: 'orange' },
];
const typeInfo = (t) => TYPES.find((x) => x.type === t) || TYPES[0];
// navigator.clipboard bestaat alleen op https of localhost. Via http op je eigen netwerk werkt
// alleen de oude kopieermethode, dus die eerst; de nieuwe is de terugval.
function copyText(text) {
  const done = () => toast('Rekeningnummer gekopieerd');
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;opacity:0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* terugval hieronder */ }
  ta.remove();
  if (ok) return done();
  navigator.clipboard?.writeText(text).then(done, () => toast('Kopiëren lukte niet. Selecteer het nummer met de hand.'));
}

export const maskIban = (iban) => (iban ? `${iban.slice(0, 2)}•• ${iban.slice(-4)}` : '');

const RANGES = [['6m', '6M'], ['1j', '1J'], ['all', 'Alles']];

export function Vermogen() {
  const { data, error, reload } = useQuery('networth', () => api.networth());
  const boot = useStore((s) => s.boot);
  const pending = usePending();
  const desk = useLayout() === 'wide';
  const trailing = html`<${NavButton} icon="plus" label="Rekening toevoegen" onClick=${() => openSheet(AccountSheet, {})} />`;
  const addItems = [{ label: 'Rekening toevoegen', icon: 'wallet', onSelect: () => openSheet(AccountSheet, {}) },
    ...(data?.home ? [] : [{ label: 'Hypotheek toevoegen', icon: 'vermogen', onSelect: () => openSheet(MortgageSheet, {}) }]),
    ...ASSET_KINDS.map((k) => ({ label: k.add, icon: k.icon, onSelect: () => openSheet(AssetSheet, { kind: k.kind }) }))];

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

  if (desk) {
    // Mac: chart large on the left (8 columns), accounts on the right (4 columns), totals per group.
    return html`<${Screen} title="Vermogen" trailing=${trailing} add=${addItems} class="vm">
      <div class="dk-grid vm-grid">
        <div class="dk-col-8 dk-card vm-chart-card"><${Hero} data=${data} desk /></div>
        <div class="dk-col-4 dk-stack vm-side">
          ${suggestions.length > 0 && html`<div class="vm-suggestions">${suggestions.map((s) => html`<${Suggestion} key=${s.key} s=${s} />`)}</div>`}
          ${!accounts.length && html`<${EmptyState} emoji="🏦" title="Nog geen rekeningen" action=${{ label: 'Rekening toevoegen', onClick: () => openSheet(AccountSheet, {}) }} />`}
          ${groups.map(({ t, list, sum }) => html`<section class="vm-group" key=${t.type}>
            <h2 class="vm-group-h"><span>${t.group}</span><span class="num">${t.type === 'credit' ? money(list.reduce((s, a) => s + (a.outstanding_cents || 0), 0)) : money(sum, { negative: true })}</span></h2>
            <${List}>${list.map((a) => html`<${AccountRow} key=${a.id} a=${a} />`)}</${List}>
          </section>`)}
          ${accounts.length > 0 && html`<section class="vm-group">
            <h2 class="vm-group-h"><span>Woning</span>${data.home?.equity_cents != null && html`<span class="num">${money(data.home.equity_cents, { negative: true })}</span>`}</h2>
            <${List}><${HomeRow} home=${data.home} /></${List}>
          </section>`}
          ${assetGroups.map(({ k, list, sum }) => html`<section class="vm-group" key=${k.kind}>
            <h2 class="vm-group-h"><span>${k.group}</span>${sum != null && html`<span class="num">${money(sum, { negative: true })}</span>`}</h2>
            <${List}>${list.map((a) => html`<${AssetRow} key=${a.id} a=${a} />`)}</${List}>
          </section>`)}
        </div>
      </div>
    </${Screen}>`;
  }

  return html`<${Screen} title="Vermogen" trailing=${trailing} add=${addItems} class="vm">
    <${Hero} data=${data} />
    ${suggestions.length > 0 && html`<div class="vm-suggestions">${suggestions.map((s) => html`<${Suggestion} key=${s.key} s=${s} />`)}</div>`}
    ${!accounts.length && html`<${EmptyState} emoji="🏦" title="Nog geen rekeningen" action=${{ label: 'Rekening toevoegen', onClick: () => openSheet(AccountSheet, {}) }} />`}
    ${TYPES.map((t) => {
      const list = accounts.filter((a) => a.type === t.type);
      if (!list.length) return null;
      const sum = list.reduce((s, a) => s + (a.balance_cents || 0), 0);
      return html`<${Section} key=${t.type} title=${t.group} trailing=${list.length > 1 && html`<span class="section-value num">${money(sum, { negative: true })}</span>`}>
        <${List}>${list.map((a) => html`<${AccountRow} key=${a.id} a=${a} />`)}</${List}>
      </${Section}>`;
    })}
    ${accounts.length > 0 && html`<${Section} title="Woning"><${List}><${HomeRow} home=${data.home} /></${List}></${Section}>`}
    ${assetGroups.map(({ k, list, sum }) => html`<${Section} key=${k.kind} title=${k.group} trailing=${list.length > 1 && sum != null && html`<span class="section-value num">${money(sum, { negative: true })}</span>`}>
      <${List}>${list.map((a) => html`<${AssetRow} key=${a.id} a=${a} />`)}</${List}>
    </${Section}>`)}
  </${Screen}>`;
}

/* ---------- Hero ---------- */

function Hero({ data, desk = false }) {
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
  const span = range === '6m' ? 'in 6 maanden' : range === '1j' ? 'in een jaar' : pts.length ? `sinds ${monthLabel(pts[0].month)}` : '';
  return html`<section class="vm-hero" aria-label="Vermogen">
    <div class="vm-hero-label">${sel ? `Eind ${monthLabel(sel.month)}` : 'Totaal'}</div>
    <div class="vm-hero-amount rounded">${sel
      ? html`<span class="amount num">${money(value, { whole: true, negative: true })}</span>`
      : html`<${Amount} cents=${value} whole animate negative />`}</div>
    <div class="vm-hero-sub num">${sel
      ? (scrub > 0 ? deltaText(sel.total_cents - pts[scrub - 1].total_cents, 'die maand') : ' ')
      : diff != null ? deltaText(diff, span) : ' '}</div>
    ${data.pension_excluded_cents != null && html`<div class="vm-hero-note num">Pensioen (later beschikbaar) ${euros(data.pension_excluded_cents)}</div>`}
    ${desk && points.length > 1 && html`<div class="vm-range is-top"><${Segmented} value=${range} onChange=${(r) => { setRange(r); setScrub(null); }} options=${RANGES} label="Periode" size="small" /></div>`}
    ${desk && points.length > 1 && html`<div class="vm-chart">
      <${LineChart} points=${points} scrub=${scrub} onScrub=${setScrub} height=${320} axis
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
    ? `Is ${maskIban(s.iban)} je spaarrekening?`
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
  if (a.iban) return maskIban(a.iban);
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

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      let id = account?.id;
      if (isNew) {
        const res = await api.createAccount({ name: name.trim(), type });
        id = res.id;
      } else if (name.trim() !== account.name || type !== account.type) {
        await api.updateAccount(id, { name: name.trim(), type });
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
        <div class="vm-sheet-sub">${account.type === 'credit' ? 'open' : account.as_of ? `op ${longDate(account.as_of)}` : account.iban ? maskIban(account.iban) : ''}</div>
      </div>`}
      ${!isNew && account.iban && html`<${List} footer="Tik om te kopiëren.">
        <${ListRow} title="Rekeningnummer" value=${html`<span class="num" style=${{ userSelect: 'text' }}>${account.iban.replace(/(.{4})/g, '$1 ').trim()}</span>`}
          onClick=${() => copyText(account.iban)} />
      </${List}>`}
      <${List}>
        <${TextField} label="Naam" value=${name} onInput=${setName} placeholder="Spaarrekening" maxLength=${60} enterkeyhint="done" />
      </${List}>
      <${List} header="Soort">
        ${TYPES.map((t) => html`<${ListRow} key=${t.type} icon=${t.icon} iconColor=${t.color} title=${t.label}
          selected=${type === t.type} onClick=${() => setType(t.type)} />`)}
      </${List}>
      ${canBalance && html`<${List} header="Saldo" footer=${full?.manual_balance_date ? `Laatst ingevuld ${longDate(full.manual_balance_date)}` : null}>
        <${AmountField} label="Saldo nu" cents=${touched ? balance : (full?.manual_balance_cents ?? null)} onChange=${(c) => { setBalance(c); setTouched(true); }} />
      </${List}>`}
      ${!isNew && account.type === 'investment' && type === 'investment' && (account.has_holdings
        ? html`<${HoldingsPart} account=${account} />`
        : html`<${InvestmentValues} account=${account} />
          <${List} footer="Of importeer je DEGIRO-export (Transacties, Rekeningoverzicht of Portefeuille) via Importeren.">
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
    ${home.debt_cents != null && html`<span class="vm-home-line num">Hypotheek − ${euros(home.debt_cents)}</span>`}`;
  return html`<${ListRow} class="vm-home" emoji="🏠" color="indigo" title="Overwaarde"
    subtitle=${html`${sub}${!home.included && home.home_cents != null ? html`<span class="vm-home-line">niet meegeteld</span>` : ''}`}
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
        value=${html`<span class="num">${p.debt_cents == null ? '—' : money(-p.debt_cents, { negative: true })}</span>`} />`)}
    </${List}>
    <${YearForm} m=${m} onChange=${onChange} />
    <${HomeValue} m=${m} onChange=${onChange} />
    <${List} footer=${m.repaid_share != null && m.payment ? `Van elke betaling telt ${Math.round(m.repaid_share * 100)} % als afgelost (gespaard), de rest als vaste lasten.` : null}>
      <li class="field-row"><label class="field-label sa-grow" for="vm-mg-inc">Meetellen in vermogen</label>
        <${Switch} id="vm-mg-inc" checked=${m.include_in_networth} label="Woning meetellen in vermogen"
          onChange=${(on) => api.updateMortgage({ include_in_networth: on }).then(onChange, apiFail)} /></li>
      <${ListRow} title="Betaling" value=${html`<span class="vm-mg-pay">${m.payment ? m.payment.merchant_name : 'Geen'}</span>`}
        chevron onClick=${setLink} label=${`Gekoppelde betaling: ${m.payment ? m.payment.merchant_name : 'geen'}. Wijzig`} />
    </${List}>
    <${List}><${ListRow} title="Verwijder hypotheek" destructive onClick=${remove} /></${List}>`;
}

function YearForm({ m, onChange }) {
  const [year, setYear] = useState(m.missing_year || m.form_year);
  const filled = (y) => Object.fromEntries(m.parts.map((p) => {
    const e = p.years.find((x) => x.year === y);
    const prev = p.years.find((x) => x.year === y - 1);
    const start = e ? e.debt_end_cents + (e.repaid_cents || 0) : (prev ? prev.debt_end_cents : null);
    return [p.id, { debt_start_cents: start, debt_end_cents: e?.debt_end_cents ?? null, interest_cents: e?.interest_cents ?? null }];
  }));
  const [vals, setVals] = useState(() => filled(year));
  const [busy, setBusy] = useState(false);
  const pick = (y) => { setYear(y); setVals(filled(y)); };
  const set = (pid, k, c) => setVals((v) => ({ ...v, [pid]: { ...v[pid], [k]: c } }));
  const ready = m.parts.every((p) => vals[p.id]?.debt_end_cents != null);
  // afgelost = restant begin − restant eind (bijgeleend of onbekend begin: 0)
  const repaid = (v) => (v?.debt_start_cents != null && v?.debt_end_cents != null ? Math.max(0, v.debt_start_cents - v.debt_end_cents) : 0);
  const entered = m.years.includes(year);
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await api.saveMortgageYear(year, m.parts.map((p) => ({ part_id: p.id, debt_end_cents: vals[p.id].debt_end_cents || 0,
        interest_cents: vals[p.id].interest_cents || 0, repaid_cents: repaid(vals[p.id]) })));
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
      <${AmountField} label=${`Restant op 31-12-${year}`} cents=${vals[p.id]?.debt_end_cents} onChange=${(c) => set(p.id, 'debt_end_cents', c)} />
      <${AmountField} label="Betaalde rente" cents=${vals[p.id]?.interest_cents} onChange=${(c) => set(p.id, 'interest_cents', c)} />
      <${ListRow} title="Afgelost" value=${html`<span class="num">${money(repaid(vals[p.id]))}</span>`} />
    </${List}>`)}
    <${List} footer=${`Neem de bedragen over van je jaaropgave. Afgelost rekent Cents zelf uit. De opgave over ${m.form_year + 1} komt begin ${m.form_year + 2}.`}>
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
  const value = a.value_cents == null ? '—' : money(a.signed_cents, { negative: true });
  const sub = !a.as_of ? 'nog geen bedrag' : !a.include ? 'niet meegeteld' : `bijgewerkt ${shortDate(a.as_of)}`;
  return html`<${ListRow} emoji=${k.emoji} color=${k.color} title=${a.name} subtitle=${html`<span class="num">${sub}</span>`}
    value=${html`<span class="num vm-balance">${value}</span>`} chevron
    onClick=${() => openSheet(AssetSheet, { kind: a.kind, id: a.id })} label=${`${a.name}, ${value}`} />`;
}

export function AssetSheet({ close, kind, id = null }) {
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
