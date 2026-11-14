// Potje detail (push from Potjes): large ring, saldo, advice sentence (catch-up variant when
// behind, never red), "Koppel je spaaropdracht" with the 5-digit code and a copy button,
// Geld toevoegen / Saldo aanpassen, history of entries, edit, archive, delete with undo.
// Reaching 100 % gets a quiet celebration.

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery, invalidate } from '../store.js';
import { openSheet, back } from '../router.js';
import { euros, money, shortDate, todayISO } from '../format.js';
import { Screen, NavButton } from '../components/Screen.js';
import { Amount } from '../components/Amount.js';
import { Card } from '../components/Card.js';
import { Section, List, ListRow } from '../components/List.js';
import { Button, Segmented } from '../components/Controls.js';
import { Skeleton, EmptyState, ProgressRing } from '../components/Feedback.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { TextField, AmountField, DateField } from '../components/Fields.js';
import { openMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { Icon } from '../icons.js';
import { reducedMotion, useLayout } from '../hooks.js';
import { goalsQuery, goalMonth, StatusChip, GoalSheet } from './potjes.js';
import { commitLater, usePending, copyText } from './_kit.js';

export function Potje({ params }) {
  const id = Number(params.id);
  const { data, error, reload } = useQuery('goals', goalsQuery);
  const pending = usePending();
  const fromList = data?.goals?.find((g) => g.id === id);
  const archived = !fromList ? data?.archived_goals?.find((g) => g.id === id) : null;
  const g = fromList || archived;
  const celebrate = useCelebration(g);
  const desk = useLayout() === 'wide';

  if (!data) {
    return html`<${Screen} title="Potje" large=${false}>
      ${error ? html`<${EmptyState} emoji="🐷" title="Potje laadt niet" subtitle=${error.message} action=${{ label: 'Probeer opnieuw', variant: 'tinted', onClick: () => reload() }} />` : html`<${DetailSkeleton} />`}
    </${Screen}>`;
  }
  if (!g || pending.has('goal:' + id)) {
    return html`<${Screen} title="Potje" large=${false}><${EmptyState} emoji="🐷" title="Potje niet gevonden" /></${Screen}>`;
  }

  const edit = () => openSheet(GoalSheet, { goal: g });
  const header = html`<header class=${'pjd-head' + (celebrate ? ' is-celebrating' : '')}>
    <div class="pjd-ring">
      <${ProgressRing} value=${g.progress} color=${g.color} size=${172} stroke=${20} emoji=${g.emoji}
        label=${`${g.name}, ${Math.round(g.progress * 100)} procent`} />
      ${g.status === 'reached' && html`<span class="pjd-badge" aria-hidden="true">🎉</span>`}
    </div>
    <h1 class="pjd-name">${g.name}</h1>
    <div class="pjd-saldo rounded"><${Amount} cents=${g.saldo_cents} whole animate negative /></div>
    <div class="pjd-target num">van ${euros(g.target_cents)}${g.target_date ? ` · ${goalMonth(g.target_date)}` : ''}${g.repeat === 'yearly' ? ' · elk jaar' : ''}</div>
    <div class="pjd-status"><${StatusChip} status=${g.status} />${archived && html`<span class="mini-chip tone-info">Gearchiveerd</span>`}</div>
    <p class="pjd-advice">${adviceSentence(g)}</p>
  </header>`;

  const actions = html`<div class="pjd-actions">
      <${Button} variant="tinted" icon="plus" onClick=${() => openSheet(MoneySheet, { goal: g })}>Geld toevoegen</${Button}>
      <${Button} variant="gray" onClick=${() => openSheet(SaldoSheet, { goal: g })}>Saldo aanpassen</${Button}>
    </div>`;
  const manage = html`<${List} class="pjd-manage">
      ${archived
        ? html`<${ListRow} icon="undo" title="Zet terug" tint onClick=${() => setArchived(g, false)} />`
        : html`<${ListRow} icon="doc" title="Archiveer" tint onClick=${() => setArchived(g, true)} />`}
      <${ListRow} title="Verwijder potje" destructive onClick=${(e) => askDelete(e, g)} />
    </${List}>`;
  const editBtn = html`<${NavButton} text="Wijzig" onClick=${edit} />`;

  // Mac: two columns — ring, numbers and actions on the left, the history on the right.
  if (desk) {
    return html`<${Screen} title=${g.name} class="pjd is-desk-split" trailing=${editBtn}>
      <div class="dk-grid pjd-grid">
        <div class="dk-col-5 dk-stack">
          <div class="dk-card pjd-left">${header}${actions}</div>
          <${CodeCard} code=${g.code} />
          ${manage}
        </div>
        <div class="dk-col-7"><${History} g=${g} desk /></div>
      </div>
    </${Screen}>`;
  }

  return html`<${Screen} title=${g.name} header=${header} class="pjd" trailing=${editBtn}>
    ${actions}
    <${CodeCard} code=${g.code} />
    <${History} g=${g} />
    ${manage}
  </${Screen}>`;
}

function adviceSentence(g) {
  const m = goalMonth(g.target_date);
  if (g.status === 'reached') return g.repeat === 'yearly' ? 'Gehaald. Na de datum begint het nieuwe jaar.' : 'Gehaald. Goed gedaan.';
  if (g.status === 'overdue') return `Datum voorbij. Nog ${euros(Math.max(0, g.target_cents - g.saldo_cents))} te gaan.`;
  if (g.status === 'behind' && g.catch_up_cents) return `Met ${euros(g.catch_up_cents)} per maand haal je het nog${m ? ` in ${m}` : ''}`;
  if (g.target_date && g.monthly_advice_cents > 0) return `Met ${euros(g.monthly_advice_cents)} per maand haal je dit in ${m}`;
  if (g.projected_date) return `In dit tempo haal je dit in ${goalMonth(g.projected_date)}`;
  if (g.avg_contribution_cents > 0) return `Je zet gemiddeld ${euros(g.avg_contribution_cents)} per maand opzij`;
  return 'Geen datum. Zet geld opzij wanneer het uitkomt.';
}

/** True for a moment when the potje crosses 100 % while this screen is open. */
function useCelebration(g) {
  const prev = useRef(null);
  const [on, setOn] = useState(false);
  const reached = g?.status === 'reached';
  useEffect(() => {
    if (!g) return;
    if (prev.current === false && reached) {
      setOn(true);
      const t = setTimeout(() => setOn(false), reducedMotion() ? 10 : 2400);
      prev.current = reached;
      return () => clearTimeout(t);
    }
    prev.current = reached;
  }, [g?.id, reached]);
  return on;
}

/* ---------- Spaaropdracht ---------- */

function CodeCard({ code }) {
  if (!code) return null;
  const copy = async () => {
    const ok = await copyText(code);
    toast(ok ? { text: `${code} gekopieerd`, icon: 'copy' } : { text: 'Kopiëren lukt hier niet, houd de code ingedrukt', icon: 'warning' });
  };
  return html`<${Card} class="pjd-code">
    <div class="pjd-code-title">Koppel je spaaropdracht</div>
    <div class="pjd-code-row">
      <span class="pjd-code-pill num" aria-label=${'Code ' + code.split('').join(' ')}>${code}</span>
      <${Button} variant="tinted" size="small" icon="copy" onClick=${copy} aria-label=${'Kopieer code ' + code}>Kopieer</${Button}>
    </div>
    <div class="pjd-code-hint">Zet dit nummer in de omschrijving van je overboeking</div>
  </${Card}>`;
}

/* ---------- History ---------- */

const KIND = { auto: 'Overboeking', manual: 'Zelf toegevoegd', adjust: 'Saldo aangepast' };

function History({ g, desk = false }) {
  const pending = usePending();
  const [all, setAll] = useState(false);
  const entries = (g.entries || []).filter((e) => !pending.has('entry:' + e.id));
  if (!entries.length) return desk ? html`<section class="dk-card"><div class="dk-card-h"><h2>Geschiedenis</h2></div><p class="quiet">Nog geen boekingen</p></section>` : null;
  const limit = desk ? 14 : 7;
  const shown = all || entries.length <= limit ? entries : entries.slice(0, limit - 1);
  const remove = (e, entry) => openMenu(e.currentTarget, [
    { label: 'Verwijder', icon: 'trash', destructive: true, onSelect: () => removeEntry(g, entry) },
  ]);
  return html`<${Section} title="Geschiedenis">
    <${List}>
      ${shown.map((e) => html`<${ListRow} key=${e.id}
        leading=${html`<span class=${'pjd-kind kind-' + e.kind} aria-hidden="true"><${Icon} name=${e.kind === 'auto' ? 'arrow' : e.kind === 'adjust' ? 'pencil' : 'plus'} size=${16} stroke=${2.2} /></span>`}
        title=${e.note || KIND[e.kind] || 'Boeking'} subtitle=${shortDate(e.date)}
        value=${html`<span class=${'num pjd-entry' + (e.amount_cents > 0 ? ' is-income' : '')}>${money(e.amount_cents, { signed: true, negative: true })}</span>`}
        onClick=${(ev) => remove(ev, e)} label=${`${KIND[e.kind] || 'Boeking'} ${shortDate(e.date)}, ${money(e.amount_cents, { negative: true })}. Opties`} />`)}
    </${List}>
    ${shown.length < entries.length && html`<button class="show-all" onClick=${() => setAll(true)}>Toon meer</button>`}
  </${Section}>`;
}

function removeEntry(g, entry) {
  const undo = commitLater('entry:' + entry.id, () => api.deleteGoalEntry(entry.id), { ms: 5300 });
  toast({ text: `${money(Math.abs(entry.amount_cents))} uit ${g.name} gehaald`, icon: 'trash', action: { label: 'Herstel', onClick: undo } });
}

/* ---------- Archive / delete ---------- */

async function setArchived(g, archived) {
  try {
    await api.updateGoal(g.id, { archived });
    invalidate();
    if (archived) {
      back('/potjes');
      toast({
        emoji: g.emoji, text: `${g.name} gearchiveerd`,
        action: { label: 'Herstel', onClick: async () => { await api.updateGoal(g.id, { archived: false }).catch(() => {}); invalidate(); } },
      });
    } else {
      toast({ emoji: g.emoji, text: `${g.name} staat weer bij je potjes` });
    }
  } catch (err) {
    toast({ text: err.message, icon: 'warning' });
  }
}

function askDelete(e, g) {
  openMenu(e.currentTarget, [
    { label: `Verwijder ${g.name}`, icon: 'trash', destructive: true, onSelect: () => {
      const undo = commitLater('goal:' + g.id, () => api.deleteGoal(g.id));
      back('/potjes');
      toast({ emoji: g.emoji, text: `${g.name} verwijderd`, action: { label: 'Herstel', onClick: undo } });
    } },
  ]);
}

/* ---------- Geld toevoegen ---------- */

/** The Sheet focuses its panel when it opens; put the caret in the amount afterwards. */
function useFocusAmount() {
  const ref = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.querySelector('.amount-input')?.focus({ preventScroll: true }), 120);
    return () => clearTimeout(t);
  }, []);
  return ref;
}

function MoneySheet({ close, goal }) {
  const [dir, setDir] = useState('in');
  const [cents, setCents] = useState(null);
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const focusRef = useFocusAmount();
  const save = async () => {
    if (!(cents > 0) || busy) return;
    setBusy(true);
    const amount = dir === 'in' ? cents : -cents;
    try {
      const res = await api.addGoalEntry(goal.id, { amount_cents: amount, date: date || undefined, note: note.trim() || undefined });
      const entryId = res?.entry?.id ?? res?.id;
      invalidate();
      close();
      const reached = goal.status !== 'reached' && res?.goal?.status === 'reached';
      toast({
        emoji: reached ? '🎉' : goal.emoji,
        text: reached ? `${goal.name} is gehaald` : dir === 'in' ? `${money(cents)} in ${goal.name}` : `${money(cents)} uit ${goal.name}`,
        action: entryId != null && { label: 'Herstel', onClick: async () => { await api.deleteGoalEntry(entryId).catch(() => {}); invalidate(); } },
      });
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };
  return html`<${Sheet} title=${dir === 'in' ? 'Geld toevoegen' : 'Geld opnemen'}
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold onClick=${save} disabled=${!(cents > 0) || busy}>Klaar</${SheetButton}>`}>
    <div class="sheet-pad pjd-sheet" ref=${focusRef}>
      <div class="pjd-seg"><${Segmented} value=${dir} onChange=${setDir} label="Erbij of eraf" options=${[['in', 'Erbij'], ['out', 'Eraf']]} /></div>
      <${AmountField} cents=${cents} onChange=${setCents} large autoFocus sign=${dir === 'out' ? '−' : ''} label="Bedrag" />
      <${List}>
        <${DateField} label="Datum" value=${date} onChange=${setDate} max=${todayISO()} />
        <${TextField} label="Notitie" value=${note} onInput=${setNote} placeholder="Optioneel" onEnter=${save} enterkeyhint="done" />
      </${List}>
    </div>
  </${Sheet}>`;
}

/* ---------- Saldo aanpassen ---------- */

function SaldoSheet({ close, goal }) {
  const [cents, setCents] = useState(goal.saldo_cents);
  const [busy, setBusy] = useState(false);
  const focusRef = useFocusAmount();
  const save = async () => {
    if (cents == null || busy) return;
    if (cents === goal.saldo_cents) { close(); return; }
    setBusy(true);
    const before = goal.saldo_cents;
    try {
      const res = await api.setGoalSaldo(goal.id, cents);
      invalidate();
      close();
      const reached = goal.status !== 'reached' && res?.goal?.status === 'reached';
      toast({
        emoji: reached ? '🎉' : goal.emoji, text: reached ? `${goal.name} is gehaald` : `Saldo ${goal.name} is ${money(cents)}`,
        action: { label: 'Herstel', onClick: async () => { await api.setGoalSaldo(goal.id, before).catch(() => {}); invalidate(); } },
      });
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };
  return html`<${Sheet} title="Saldo aanpassen"
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold onClick=${save} disabled=${cents == null || busy}>Klaar</${SheetButton}>`}>
    <div class="sheet-pad pjd-sheet" ref=${focusRef}>
      <div class="pjd-sheet-emoji" aria-hidden="true">${goal.emoji}</div>
      <${AmountField} cents=${cents} onChange=${setCents} large autoFocus label=${'Saldo ' + goal.name} />
      <p class="pjd-sheet-note num">Nu ${money(goal.saldo_cents, { negative: true })}</p>
    </div>
  </${Sheet}>`;
}

/* ---------- Skeleton ---------- */

function DetailSkeleton() {
  return html`<div class="pjd-head" aria-busy="true" aria-label="Laden">
    <${Skeleton} w=${172} h=${172} r=${86} />
    <${Skeleton} w=${140} h=${24} style=${{ marginTop: '18px' }} />
    <${Skeleton} w=${120} h=${36} r=${10} style=${{ marginTop: '10px' }} />
    <${Skeleton} w=${220} h=${16} style=${{ marginTop: '14px' }} />
  </div>`;
}
