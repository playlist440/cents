// Vermogen (DESIGN §3): hero total with a Stocks-style line chart (6M · 1J · Alles, scrubbing),
// suggestion rows for likely own accounts (Ja creates, Nee dismisses), accounts grouped per
// soort, account sheet (name, soort, values for investments, open amount + "Uitgave
// toevoegen" for credit cards, manual balance for accounts without imported data). `+` adds a
// manual account.

import { html, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useStore, useQuery, invalidate, getState } from '../store.js';
import { openSheet } from '../router.js';
import { euros, money, monthLabel, shortDate, todayISO, longDate } from '../format.js';
import { Screen, NavButton } from '../components/Screen.js';
import { Amount } from '../components/Amount.js';
import { Card } from '../components/Card.js';
import { List, ListRow, Section } from '../components/List.js';
import { Button, Segmented } from '../components/Controls.js';
import { Skeleton, EmptyState } from '../components/Feedback.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { TextField, AmountField, DateField } from '../components/Fields.js';
import { openMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { LineChart } from '../charts/LineChart.js';
import { openAddExpense } from '../shell/actions.js';
import { commitLater, usePending } from './_kit.js';
import { useLayout } from '../hooks.js';

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
  const trailing = html`<${NavButton} icon="plus" label="Rekening toevoegen" onClick=${() => openSheet(AccountSheet, {})} />`;

  if (!data) {
    return html`<${Screen} title="Vermogen" trailing=${trailing} add=${[{ label: 'Rekening toevoegen', icon: 'wallet', onSelect: () => openSheet(AccountSheet, {}) }]}>
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

  if (desk) {
    // Mac: chart large on the left (8 columns), accounts on the right (4 columns), totals per group.
    return html`<${Screen} title="Vermogen" trailing=${trailing} add=${[{ label: 'Rekening toevoegen', icon: 'wallet', onSelect: () => openSheet(AccountSheet, {}) }]} class="vm">
      <div class="dk-grid vm-grid">
        <div class="dk-col-8 dk-card vm-chart-card"><${Hero} data=${data} desk /></div>
        <div class="dk-col-4 dk-stack vm-side">
          ${suggestions.length > 0 && html`<div class="vm-suggestions">${suggestions.map((s) => html`<${Suggestion} key=${s.key} s=${s} />`)}</div>`}
          ${!accounts.length && html`<${EmptyState} emoji="🏦" title="Nog geen rekeningen" action=${{ label: 'Rekening toevoegen', onClick: () => openSheet(AccountSheet, {}) }} />`}
          ${groups.map(({ t, list, sum }) => html`<section class="vm-group" key=${t.type}>
            <h2 class="vm-group-h"><span>${t.group}</span><span class="num">${t.type === 'credit' ? money(list.reduce((s, a) => s + (a.outstanding_cents || 0), 0)) : money(sum, { negative: true })}</span></h2>
            <${List}>${list.map((a) => html`<${AccountRow} key=${a.id} a=${a} />`)}</${List}>
          </section>`)}
        </div>
      </div>
    </${Screen}>`;
  }

  return html`<${Screen} title="Vermogen" trailing=${trailing} add=${[{ label: 'Rekening toevoegen', icon: 'wallet', onSelect: () => openSheet(AccountSheet, {}) }]} class="vm">
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
  if (a.type === 'investment') return a.invested_cents == null ? '' : `inleg ${euros(a.invested_cents)}`;
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
    ${res != null && html`<span class=${'num vm-result' + (res > 0 ? ' is-income' : '')}>${money(res, { whole: true, signed: true, negative: true })}</span>`}
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
      ${!isNew && account.type === 'investment' && type === 'investment' && html`<${InvestmentValues} account=${account} />`}
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
