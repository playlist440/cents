// Transaction sheet (DESIGN §3): hero (emoji tile, merchant, amount, date), bakje tiles with
// "Voor alle van <winkel>" (instant save, optimistic, undo toast), tags with inline add and
// "Altijd voor <winkel>", note, potje for savings transfers, the merchant line with a sparkline,
// collapsed details, and "Verwijder" for manual entries.
//
// TransactieSheet({ id, tx, close }) is opened by openTransaction(tx) (shell/actions.js).
// TransactieDetail is the same content without the sheet; Transacties shows it inline in the
// split view (≥ 1000 px).

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery, useStore, categoryById, accountById, invalidate, getState } from '../store.js';
import { freqLabel, money, euros, plural, longDate, dayLabel, addDays, todayISO, shiftPeriod } from '../format.js';
import { Sheet } from '../components/Sheet.js';
import { DateField } from '../components/Fields.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { Switch, Button, Segmented } from '../components/Controls.js';
import { Skeleton } from '../components/Feedback.js';
import { toast } from '../components/Toast.js';
import { openMenu } from '../components/Menu.js';
import { Sparkline } from '../charts/Sparkline.js';
import { Icon } from '../icons.js';
import { navigate } from '../router.js';
import { useId, useLayout } from '../hooks.js';
import { openBakjePopover } from './_txdesk.js';
import { Iban } from '../components/Iban.js';
import { BakjeGrid, TagEditor, METHOD_LABEL, maskIban, emitTxChange, isUnsorted } from './_tx.js';
import { CostSection, canSpread, canPossess, COSTS_FROM } from './_costs.js';

export function TransactieSheet({ id, tx, close }) {
  return html`<${Sheet} title="" label=${tx?.merchant_name || 'Betaling'} detents=${['medium', 'large']} class="td-sheet">
    <${TransactieDetail} id=${id} tx=${tx} onDone=${close} />
  </${Sheet}>`;
}


export function TransactieDetail({ id, tx: listTx, onDone, inline = false }) {
  useStore((s) => s.boot); // re-render when bakjes/tags change
  const detail = useQuery(id ? 'tx:' + id : null, () => api.transaction(id));
  const [over, setOver] = useState({});
  const [scopeSel, setScope] = useState(null); // null = default; 'one' | 'merchant' | 'merchant_below'
  const desk = useLayout() === 'wide';
  const [below, setBelow] = useState(null);
  const [showDetails, setShowDetails] = useState(false);
  const [forceCosts, setForceCosts] = useState(false);
  const lastAdded = useRef(null);
  useEffect(() => { setOver({}); setShowDetails(false); setScope(null); setBelow(null); setForceCosts(false); }, [id]);
  useEffect(() => {
    if (forceCosts) document.getElementById('td-costs-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [forceCosts]);
  // Server data wins once it arrives after a save.
  useEffect(() => { setOver({}); }, [detail.data]);

  const base = detail.data || listTx;
  const t = base ? { ...base, ...over } : { id, tag_ids: [] };
  // Default scope: "Alle" when the bakje came from the library / MCC / bank; "Alleen deze" when
  // the merchant already follows a rule or an own choice (changing all would undo that choice).
  const scope = scopeSel ?? (['rule', 'user'].includes(base?.category_source) ? 'one' : 'merchant');
  const cat = categoryById(t.category_id);
  const unsorted = isUnsorted(t.category_id);
  const income = t.amount_cents > 0;
  const account = accountById(t.account_id);
  const m = detail.data?.merchant;
  // `via:` keys (Tikkie and other intermediaries) are not one merchant: never "Alle van …".
  const canAll = !!t.merchant_key && !t.merchant_key.startsWith('via:') && !t.manual && t.kind === 'normal' && (!m || m.count > 1);
  const shortName = t.merchant_name || 'deze winkel';

  /* ---------- Bakje ---------- */
  const rules = useQuery(t.merchant_key && !t.manual ? 'rules' : null, () => api.rules());
  const rule = rules.data?.find?.((r) => r.merchant_key === t.merchant_key) || null;
  const threshold = rule?.below_cents != null && rule?.below_category_id != null ? rule : null;
  const belowCents = below ?? threshold?.below_cents ?? niceAbove(Math.abs(t.amount_cents || 0));
  const effScope = canAll ? scope : 'one';

  const pickCat = async (c) => {
    const mode = effScope;
    if (c.id === t.category_id && mode !== 'merchant_below') return;
    const prev = t.category_id;
    const limit = belowCents;
    const prevRule = rule ? { ...rule } : null;
    const apply = (catId, back = false) => {
      setOver((o) => ({ ...o, category_id: back ? prev : catId }));
      if (mode === 'merchant') emitTxChange({ ids: [t.id], merchant_key: t.merchant_key, set: { category_id: catId } });
      else if (mode === 'merchant_below') emitTxChange({ ids: [t.id], merchant_key: t.merchant_key, set: (x) => (Math.abs(x.amount_cents) < limit || x.id === t.id ? { category_id: catId } : {}) });
      else emitTxChange({ ids: [t.id], set: { category_id: catId, category_source: 'user' } });
    };
    apply(c.id);
    const body = mode === 'merchant_below'
      ? { category_id: c.id, apply_scope: 'merchant_below', below_cents: limit }
      : { category_id: c.id, apply_scope: mode, apply_to_merchant: mode === 'merchant' };
    try {
      const res = await api.updateTransaction(t.id, body);
      const n = res?.updated_count || 1;
      invalidate();
      const what = mode === 'merchant_below'
        ? `${t.merchant_name || 'Deze winkel'} onder ${euros(limit)} naar ${c.name}` // updated_count covers every re-applied row
        : n > 1 ? `${plural(n, 'betaling', 'betalingen')} naar ${c.name}` : `Naar ${c.name}`;
      toast({
        emoji: c.emoji,
        text: what,
        action: {
          label: 'Herstel',
          onClick: async () => {
            try {
              if (mode === 'merchant_below') {
                const id2 = prevRule?.id ?? (await api.rules()).find((r) => r.merchant_key === t.merchant_key)?.id;
                if (id2) await api.updateRule(id2, { below_cents: prevRule?.below_cents ?? null, below_category_id: prevRule?.below_category_id ?? null });
                setOver((o) => ({ ...o, category_id: prev }));
              } else {
                apply(prev);
                await api.updateTransaction(t.id, { category_id: prev, apply_scope: mode, apply_to_merchant: mode === 'merchant' });
              }
            } catch (err) { toast({ text: err.message, icon: 'warning' }); }
            invalidate();
          },
        },
      });
    } catch (err) {
      apply(prev);
      toast({ text: err.message, icon: 'warning' });
    }
  };

  const removeThreshold = async () => {
    const r = threshold;
    try {
      await api.updateRule(r.id, { below_cents: null, below_category_id: null });
      invalidate();
      if (scope === 'merchant_below') setScope('merchant');
      toast({
        icon: 'check', text: `Grens voor ${shortName} weg`,
        action: { label: 'Herstel', onClick: async () => { try { await api.updateRule(r.id, { below_cents: r.below_cents, below_category_id: r.below_category_id }); invalidate(); } catch (err) { toast({ text: err.message, icon: 'warning' }); } } },
      });
    } catch (err) { toast({ text: err.message, icon: 'warning' }); }
  };

  /* ---------- Tags ---------- */
  const always = !!rule?.tag_id && (t.tag_ids || []).includes(rule.tag_id);

  const setTags = async (ids, added) => {
    const prev = t.tag_ids || [];
    if (added) lastAdded.current = added.id;
    setOver((o) => ({ ...o, tag_ids: ids }));
    emitTxChange({ ids: [t.id], set: { tag_ids: ids } });
    try {
      await api.updateTransaction(t.id, { tag_ids: ids });
      invalidate();
    } catch (err) {
      setOver((o) => ({ ...o, tag_ids: prev }));
      toast({ text: err.message, icon: 'warning' });
    }
  };
  const setAlways = async (on) => {
    const ids = t.tag_ids || [];
    try {
      if (on) {
        const first = ids.includes(lastAdded.current) ? lastAdded.current : ids[ids.length - 1];
        const res = await api.updateTransaction(t.id, { tag_ids: [first, ...ids.filter((x) => x !== first)], tag_always: true });
        toast({ icon: 'tag', text: `Altijd voor ${shortName}` + (res?.updated_count > 1 ? ` · ${plural(res.updated_count, 'betaling', 'betalingen')}` : '') });
      } else {
        // The API forgets a merchant's tag rule when tag_always comes with no tags; then restore.
        await api.updateTransaction(t.id, { tag_ids: [], tag_always: true });
        await api.updateTransaction(t.id, { tag_ids: ids });
      }
      invalidate();
    } catch (err) { toast({ text: err.message, icon: 'warning' }); }
  };

  /* ---------- Note ---------- */
  const saveNote = async (text) => {
    const note = text.trim() || null;
    if ((note || null) === (t.note || null)) return;
    setOver((o) => ({ ...o, note }));
    emitTxChange({ ids: [t.id], set: { note } });
    try { await api.updateTransaction(t.id, { note }); invalidate(); } catch (err) { toast({ text: err.message, icon: 'warning' }); }
  };

  /* ---------- Potje ---------- */
  const isSaving = cat?.grp === 'saving' || accountById(t.transfer_account_id)?.type === 'savings';
  const goals = useQuery(isSaving ? 'goals' : null, () => api.goals());
  const goalList = goals.data?.goals || [];
  const goal = goalList.find((g) => g.id === t.goal_id);
  const pickGoal = (e) => openMenu(e.currentTarget, [
    ...goalList.map((g) => ({ label: `${g.emoji} ${g.name}`, checked: g.id === t.goal_id, onSelect: () => saveGoal(g.id) })),
    '-',
    { label: 'Geen potje', checked: !t.goal_id, onSelect: () => saveGoal(null) },
  ]);
  const saveGoal = async (goalId) => {
    const prev = t.goal_id;
    setOver((o) => ({ ...o, goal_id: goalId }));
    try { await api.updateTransaction(t.id, { goal_id: goalId }); invalidate(); } catch (err) { setOver((o) => ({ ...o, goal_id: prev })); toast({ text: err.message, icon: 'warning' }); }
  };

  /* ---------- Delete (manual) ---------- */
  const remove = async () => {
    try {
      await api.deleteTransaction(t.id);
      emitTxChange({ ids: [t.id], removed: true });
      invalidate();
      onDone?.();
      toast({
        text: 'Uitgave verwijderd',
        icon: 'trash',
        action: {
          label: 'Herstel',
          onClick: async () => {
            try {
              await api.createTransaction({ account_id: t.account_id, date: t.date, amount_cents: t.amount_cents, merchant_name: t.merchant_name, category_id: unsorted ? null : t.category_id, tag_ids: t.tag_ids || [], note: t.note });
              invalidate();
            } catch (err) { toast({ text: err.message, icon: 'warning' }); }
          },
        },
      });
    } catch (err) { toast({ text: err.message, icon: 'warning' }); }
  };

  /* ---------- Kosten over de tijd ---------- */
  const spreadable = canSpread(t, account);
  const costsEligible = spreadable || canPossess(t, account);
  const costsOpen = !!t.possession || t.spread_months > 1
    || (costsEligible && (Math.abs(t.amount_cents || 0) >= COSTS_FROM || forceCosts));
  const onCostTx = (ch) => { setOver((o) => ({ ...o, ...ch })); emitTxChange({ ids: [t.id], set: ch }); };

  if (!base) return html`<${DetailSkeleton} />`;
  return html`<div class=${'td' + (inline ? ' is-inline' : '')}>
    <header class="td-hero">
      <${EmojiTile} emoji=${cat?.emoji} color=${cat?.color} dashed=${unsorted} size=${64} />
      <h2 class="td-name selectable">${t.merchant_name}</h2>
      <div class=${'td-amount rounded num' + (income && t.kind === 'normal' ? ' is-income' : '')}>${money(t.amount_cents, { signed: true })}</div>
      <div class="td-meta">${capitalize(dayLabel(t.date, { long: true }))}${account ? ' · ' + account.name : ''}</div>
    </header>

    <section class="td-sec" aria-labelledby=${'tdb' + t.id}>
      <h3 class="list-header" id=${'tdb' + t.id}>Bakje</h3>
      <div class="td-card">
        ${desk && inline
          ? html`<button type="button" class="td-bakje-row" aria-haspopup="dialog" onClick=${(e) => openBakjePopover(e.currentTarget, { value: t.category_id, sign: income ? 'in' : 'out', onPick: (c) => pickCat(c) })}>
              <${EmojiTile} emoji=${cat?.emoji} color=${cat?.color} dashed=${unsorted} size=${28} />
              <span class="td-bakje-name">${unsorted ? 'Kies een bakje' : cat?.name}</span>
              <${Icon} name="chevron-up-down" size=${14} stroke=${2.4} />
            </button>`
          : html`<${BakjeGrid} value=${t.category_id} onPick=${pickCat} sign=${income ? 'in' : 'out'} withInternal=${t.kind !== 'normal'} />`}
        ${t.category_reason_label && html`<p class="td-reason">${t.category_reason_label}</p>`}
        ${canAll && html`<${ScopeRow} scope=${scope} setScope=${setScope} name=${shortName} count=${m?.count}
          below=${belowCents} setBelow=${setBelow} threshold=${threshold} onRemove=${removeThreshold} />`}
      </div>
    </section>

    ${costsOpen && html`<${CostSection} t=${t} info=${detail.data?.spread} account=${account} spreadable=${spreadable}
      anchor=${'td-costs-' + t.id} onTx=${onCostTx} />`}

    ${isSaving && goalList.length > 0 && html`<section class="td-sec">
      <h3 class="list-header">Potje</h3>
      <ul class="inset"><li class="row-li">
        <button class="row is-button td-goal" onClick=${pickGoal}>
          ${goal ? html`<span class="row-lead"><${EmojiTile} emoji=${goal.emoji} color=${goal.color} size=${30} /></span>` : null}
          <span class="row-main"><span class="row-title">${goal ? goal.name : 'Kies een potje'}</span></span>
          <span class="row-chev"><${Icon} name="chevron-up-down" size=${16} stroke=${2.2} /></span>
        </button>
      </li></ul>
    </section>`}

    <section class="td-sec">
      <h3 class="list-header">Tags</h3>
      <div class="td-card">
        <${TagEditor} tagIds=${t.tag_ids || []} onChange=${setTags} />
        ${(t.tag_ids || []).length > 0 && t.merchant_key && !t.manual && html`<label class="td-switch">
          <span>Altijd voor ${shortName}</span>
          <${Switch} checked=${always} onChange=${setAlways} label=${`Tags altijd voor ${shortName}`} />
        </label>`}
      </div>
    </section>

    <section class="td-sec">
      <h3 class="list-header">Notitie</h3>
      <${NoteField} key=${t.id} value=${t.note || ''} onSave=${saveNote} />
    </section>

    ${t.merchant_key && html`<${MerchantLine} t=${t} m=${m} />`}

    <section class="td-sec">
      <button class="td-disclosure" aria-expanded=${showDetails ? 'true' : 'false'} onClick=${() => setShowDetails(!showDetails)}>
        <span>Details</span><${Icon} name="chevron-right" size=${13} stroke=${2.6} />
      </button>
      ${showDetails && html`<${Details} t=${detail.data || t} account=${account}
        onCosts=${costsEligible && !costsOpen ? () => setForceCosts(true) : null} />`}
    </section>

    ${!!t.manual && html`<div class="td-sec td-delete">
      <${Button} variant="destructive" block icon="trash" onClick=${remove}>Verwijder</${Button}>
    </div>`}
  </div>`;
}

/* ---------- Scope: who follows this bakje ---------- */

const NICE = [100, 200, 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 25000, 30000, 40000, 50000, 75000, 100000, 150000, 200000, 250000, 500000];

/** The next round amount above `cents` (at least € 1). */
export function niceAbove(cents) {
  return NICE.find((n) => n > cents) || Math.ceil((cents + 1) / 100000) * 100000;
}
function step(cents, dir) {
  const i = NICE.findIndex((n) => n >= cents);
  if (i < 0) return dir > 0 ? cents + 100000 : NICE[NICE.length - 1];
  if (NICE[i] !== cents && dir < 0) return NICE[Math.max(0, i - 1)];
  return NICE[Math.max(0, Math.min(NICE.length - 1, i + dir))];
}

function ScopeRow({ scope, setScope, name, count, below, setBelow, threshold, onRemove }) {
  const options = [['one', 'Alleen deze'], ['merchant', count > 1 ? `Alle ${count}` : 'Alle'], ['merchant_below', `Onder ${euros(below)}`]];
  const tcat = threshold ? categoryById(threshold.below_category_id) : null;
  const editThreshold = (e) => openMenu(e.currentTarget, [
    { label: 'Grens aanpassen', icon: 'pencil', onSelect: () => { setBelow(threshold.below_cents); setScope('merchant_below'); } },
    { label: 'Grens weghalen', icon: 'trash', destructive: true, onSelect: onRemove },
  ]);
  return html`<div class="td-scope">
    <div class="td-scope-row td-scope-seg">
      <span class="td-scope-label">Geldt voor</span>
      <${Segmented} value=${scope} onChange=${setScope} options=${options} label=${`Geldt voor (${name})`} size="small" />
    </div>
    ${scope === 'merchant_below' && html`<div class="td-scope-row td-stepper-row">
      <span class="td-scope-label">Bedragen onder</span>
      <span class="td-stepper" role="group" aria-label="Grensbedrag">
        <button aria-label="Lager" disabled=${below <= 100} onClick=${() => setBelow(step(below, -1))}><${Icon} name="minus" size=${16} stroke=${2.4} /></button>
        <span class="td-stepper-value num" aria-live="polite">${euros(below)}</span>
        <button aria-label="Hoger" onClick=${() => setBelow(step(below, 1))}><${Icon} name="plus" size=${16} stroke=${2.4} /></button>
      </span>
    </div>`}
    ${threshold && scope !== 'merchant_below' && html`<button class="td-scope-row td-threshold" onClick=${editThreshold} aria-haspopup="menu">
      <span class="td-scope-label">Onder ${euros(threshold.below_cents)}</span>
      <span class="td-scope-value">${tcat ? `${tcat.emoji} ${tcat.name}` : '—'}<${Icon} name="ellipsis" size=${18} stroke=${2} /></span>
    </button>`}
  </div>`;
}

function NoteField({ value, onSave }) {
  const [text, setText] = useState(value);
  const fid = useId('note');
  return html`<div class="td-note">
    <label class="vh" for=${fid}>Notitie</label>
    <textarea id=${fid} class="td-note-input" rows="1" placeholder="Voeg een notitie toe" value=${text} maxLength="2000"
      onInput=${(e) => { setText(e.currentTarget.value); autosize(e.currentTarget); }}
      ref=${(el) => el && autosize(el)}
      onBlur=${() => onSave(text)} />
  </div>`;
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

/* ---------- Merchant line ---------- */

function MerchantLine({ t, m }) {
  const from = addDays(todayISO(), -370);
  const hist = useQuery('merchant-hist:' + t.merchant_key, () => api.transactions({ merchant_key: t.merchant_key, from, limit: 1000 }));
  const months = [];
  const cur = todayISO().slice(0, 7);
  for (let i = 11; i >= 0; i--) months.push(shiftPeriod(cur, -i));
  const byMonth = new Map(months.map((k) => [k, 0]));
  for (const x of hist.data?.items || []) {
    const k = x.date.slice(0, 7);
    if (byMonth.has(k)) byMonth.set(k, byMonth.get(k) + Math.abs(x.amount_cents));
  }
  const values = [...byMonth.values()];
  const year = m ? Math.abs(m.total_12m_cents) : null;
  const parts = m ? [
    m.count === 1 ? 'eerste keer' : `${m.count} keer`,
    m.typical_cents != null && m.count > 1 ? `meestal ${euros(Math.abs(m.typical_cents))}` : null,
    year && m.count > 1 ? `afgelopen jaar ${euros(year)}` : null,
  ].filter(Boolean) : null;
  const rec = m?.recurring;
  return html`<section class="td-sec">
    <h3 class="list-header">${t.merchant_name}</h3>
    <button class="td-card td-merchant is-pressable" onClick=${() => navigate('/transacties', { query: { merchant_key: t.merchant_key } })}
        aria-label=${`Alle betalingen van ${t.merchant_name}`}>
      <span class="td-merchant-text">
        <span class="td-merchant-line num">${parts ? parts.join(' · ') : html`<${Skeleton} w=${180} h=${15} />`}</span>
        ${rec && html`<span class="td-merchant-sub">Vaste last · ${freqLabel(rec.frequency, 'every') || 'terugkerend'}${rec.amount_cents ? ' · ' + euros(Math.abs(rec.amount_cents)) : ''}</span>`}
      </span>
      ${values.some((v) => v > 0) && values.filter((v) => v > 0).length > 1
        ? html`<${Sparkline} values=${values} width=${76} height=${30} label=${`${t.merchant_name} per maand, afgelopen jaar`} />`
        : null}
      <span class="row-chev"><${Icon} name="chevron-right" size=${14} stroke=${2.6} /></span>
    </button>
  </section>`;
}

/* ---------- Details ---------- */

function Details({ t, account, onCosts }) {
  const rows = [
    ['Omschrijving', t.raw_description || t.description],
    ['Rekening', account ? (account.iban ? html`${account.name} · <${Iban} iban=${account.iban} />` : account.name) : null],
    ['Betaalwijze', [METHOD_LABEL[t.method], t.wallet].filter(Boolean).join(' · ') || null],
    ['Plaats', t.city],
    ['Soort winkel', t.mcc_label],
    ['Tegenrekening', t.counterparty_iban ? html`${t.counterparty_name ? t.counterparty_name + ' · ' : ''}<${Iban} iban=${t.counterparty_iban} open />` : (t.counterparty_name || null)],
    ['Datum', longDate(t.date)],
    t.book_date && ['Boekdatum', `${longDate(t.book_date)} (telt mee in de overzichten)`],
    ['Saldo na', t.balance_after_cents != null ? money(t.balance_after_cents, { negative: true }) : null],
  ].filter((x) => x && x[1]);
  // Overboeking naar een eigen rekening zonder eigen afschriften (DEGIRO, spaarrekening): koppel
  // het rekeningnummer van deze betaling met één tik, zonder het over te typen.
  const own = getState().boot?.accounts || [];
  const known = own.some((a) => a.iban && a.iban === t.counterparty_iban);
  const free = own.filter((a) => !a.iban && a.type !== 'credit' && a.id !== t.account_id);
  const link = (e) => openMenu(e.currentTarget, free.map((a) => ({
    label: a.name, onSelect: async () => {
      try {
        await api.updateAccount(a.id, { iban: t.counterparty_iban });
        invalidate();
        toast(`Rekeningnummer gekoppeld aan ${a.name}`);
      } catch (err) { toast({ text: err.message, icon: 'warning' }); }
    } })));
  return html`<dl class="td-details inset">
    ${rows.map(([k, v]) => html`<div class=${'td-dl-row' + (typeof v !== 'string' || v.length > 34 ? ' is-long' : '')} key=${k}><dt>${k}</dt><dd class="selectable">${v}</dd></div>`)}
  </dl>
  <${BookDate} t=${t} />
  ${onCosts && html`<button class="section-link td-own-link" onClick=${onCosts}>Kosten verdelen over maanden…</button>`}
  ${t.counterparty_iban && !known && free.length > 0 && !t.manual && html`<button class="section-link td-own-link" onClick=${link}>Dit is mijn eigen rekening…</button>`}`;
}

/** Andere boekdatum: een afschrijving die te laat kwam (kinderopvang op de 1e in plaats van de
 *  31e) telt in de overzichten mee op de dag die je kiest. De echte datum blijft staan. */
function BookDate({ t }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(t.book_date || t.date);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValue(t.book_date || t.date); setOpen(false); }, [t.id, t.book_date]);
  const save = async (book) => {
    setBusy(true);
    try {
      await api.updateTransaction(t.id, { book_date: book });
      invalidate();
      toast(book && book !== t.date ? `Boekdatum ${longDate(book)}` : 'Boekdatum gelijk aan de datum');
      setOpen(false);
    } catch (err) { toast({ text: err.message, icon: 'warning' }); }
    setBusy(false);
  };
  if (!open) {
    return html`<button class="section-link td-own-link" onClick=${() => setOpen(true)}>${t.book_date ? 'Boekdatum wijzigen…' : 'Andere boekdatum…'}</button>`;
  }
  return html`<div class="td-bookdate">
    <ul class="list-group inset"><${DateField} label="Boekdatum" value=${value} onChange=${(v) => setValue(v || t.date)}
      min=${addDays(t.date, -62)} max=${addDays(t.date, 62)} /></ul>
    <p class="td-bookdate-hint">Telt in de overzichten mee op deze dag, bijvoorbeeld de laatste dag van de maand waar de betaling bij hoort. De echte datum (${longDate(t.date)}) blijft staan.</p>
    <div class="td-bookdate-actions">
      ${t.book_date && html`<${Button} variant="plain" size="small" onClick=${() => save(null)} disabled=${busy}>Gebruik de echte datum</${Button}>`}
      <${Button} variant="plain" size="small" onClick=${() => setOpen(false)} disabled=${busy}>Annuleer</${Button}>
      <${Button} variant="tinted" size="small" onClick=${() => save(value === t.date ? null : value)} loading=${busy}>Bewaar</${Button}>
    </div>
  </div>`;
}

function DetailSkeleton() {
  return html`<div class="td" aria-busy="true">
    <div class="td-hero">
      <${Skeleton} w=${64} h=${64} r=${18} />
      <${Skeleton} w=${160} h=${22} style=${{ marginTop: '6px' }} />
      <${Skeleton} w=${120} h=${36} />
    </div>
    <div class="td-card"><${Skeleton} h=${150} r=${12} /></div>
  </div>`;
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
