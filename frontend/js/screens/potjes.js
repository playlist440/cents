// Potjes (DESIGN §3): "In potjes" header with savings balance, the monthly advice row with a
// quiet "past" / "meer dan je meestal overhoudt" state, a grid of Fitness-style ring cards,
// "Nog te verdelen" (savings transfers without a potje, one-tap chips with undo), suggestions
// as dashed ghost cards, archived potjes. Also exports the "Nieuw potje" / edit sheet.

import { html, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery, invalidate } from '../store.js';
import { navigate, openSheet } from '../router.js';
import { euros, money, shortDate, monthSmart, todayISO, addDays } from '../format.js';
import { Screen, NavButton } from '../components/Screen.js';
import { Amount } from '../components/Amount.js';
import { Card } from '../components/Card.js';
import { Section, List, ListRow } from '../components/List.js';
import { Chip, Switch } from '../components/Controls.js';
import { Skeleton, EmptyState, ProgressRing } from '../components/Feedback.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { TextField, AmountField, DateField } from '../components/Fields.js';
import { EmojiPicker, ColorPicker } from '../components/Pickers.js';
import { toast } from '../components/Toast.js';
import { Icon } from '../icons.js';
import { usePending } from './_kit.js';

export const goalsQuery = () => api.goals();

/** "juli 2027" (or "juli" in the current year) for an ISO date. */
export const goalMonth = (iso) => (iso ? monthSmart(iso.slice(0, 7)) : '');

export const STATUS = {
  on_track: { text: 'Op schema', tone: 'good' },
  behind: { text: 'Loopt achter', tone: 'warn' },
  reached: { text: 'Gehaald', tone: 'good' },
  // A passed date on an unfinished potje: neutral wording, never red (DECISIONS, Goals).
  overdue: { text: 'Datum voorbij', tone: 'info' },
};

export function StatusChip({ status }) {
  const s = STATUS[status];
  if (!s) return null;
  return html`<span class=${'mini-chip tone-' + s.tone}>${status === 'reached' && html`<${Icon} name="check" size=${11} stroke=${3} />`}${s.text}</span>`;
}

export function Potjes() {
  const { data, error, reload } = useQuery('goals', goalsQuery);
  const pending = usePending();
  const add = (prefill) => openSheet(GoalSheet, { prefill, used: data?.goals?.map((g) => g.color) || [] });
  const trailing = html`<${NavButton} icon="plus" label="Nieuw potje" onClick=${() => add()} />`;

  if (error && !data) {
    return html`<${Screen} title="Potjes" trailing=${trailing} add=${[{ label: 'Nieuw potje', icon: 'potjes', onSelect: () => add() }]}>
      <${EmptyState} emoji="🐷" title="Potjes laden niet" subtitle=${error.message} action=${{ label: 'Probeer opnieuw', variant: 'tinted', onClick: () => reload() }} />
    </${Screen}>`;
  }
  if (!data) return html`<${Screen} title="Potjes" trailing=${trailing} add=${[{ label: 'Nieuw potje', icon: 'potjes', onSelect: () => add() }]}><${PotjesSkeleton} /></${Screen}>`;

  const goals = (data.goals || []).filter((g) => !pending.has('goal:' + g.id));
  const archived = (data.archived_goals || []).filter((g) => !pending.has('goal:' + g.id));
  const suggestions = data.suggestions || [];
  const empty = !goals.length;

  return html`<${Screen} title="Potjes" trailing=${trailing} add=${[{ label: 'Nieuw potje', icon: 'potjes', onSelect: () => add() }]} class="pj">
    ${!empty && html`<${Summary} data=${data} goals=${goals} />`}
    ${empty && !suggestions.length && html`<${EmptyState} emoji="🐷" title="Nog geen potjes"
      action=${{ label: 'Nieuw potje', onClick: () => add() }} />`}
    ${(goals.length > 0 || suggestions.length > 0) && html`<div class="pj-grid" role="list">
      ${goals.map((g) => html`<${GoalCard} key=${g.id} g=${g} />`)}
      ${suggestions.map((s) => html`<${SuggestionCard} key=${'s' + s.kind} s=${s} onClick=${() => add(s)} />`)}
      <${GhostCard} key="new" s=${{ name: 'Nieuw potje', emoji: '', target_cents: null, reason: '' }} onClick=${() => add()} />
    </div>`}
    <${Unassigned} items=${data.unassigned || []} goals=${goals} onNew=${(u) => add(prefillFrom(u))} />
    <${Archived} goals=${archived} />
  </${Screen}>`;
}

/* ---------- Header + advice ---------- */

function Summary({ data, goals }) {
  const inPots = goals.reduce((s, g) => s + g.saldo_cents, 0);
  const bal = data.savings_balance_cents;
  const free = data.unallocated_cents;
  const room = data.room;
  const advice = data.total_advice_cents || 0;
  return html`<section class="pj-head" aria-label="Samenvatting">
    <div class="pj-head-label">In potjes</div>
    <div class="pj-head-amount rounded"><${Amount} cents=${inPots} whole animate /></div>
    ${bal != null && html`<div class="pj-head-sub num">
      Spaarsaldo ${euros(bal)}${free != null && html` · ${free >= 0 ? html`nog vrij ${euros(free)}` : html`<span class="c-warn">${euros(-free)} meer verdeeld</span>`}`}
    </div>`}
    ${advice > 0 && html`<div class="pj-advice card">
      <span class="pj-advice-icon" aria-hidden="true"><${Icon} name="calendar" size=${20} stroke=${2} /></span>
      <span class="pj-advice-main">
        <span class="pj-advice-value num">${euros(advice)} per maand</span>
        ${room && (room.fits
          ? html`<span class="pj-advice-state is-fits"><${Icon} name="check" size=${14} stroke=${2.8} /> past</span>`
          : html`<span class="pj-advice-state is-tight">${euros(-room.difference_cents)} meer dan je meestal overhoudt</span>`)}
      </span>
    </div>`}
  </section>`;
}

/* ---------- Cards ---------- */

function cardSub(g) {
  if (g.status === 'reached') return g.target_date ? goalMonth(g.target_date) : '';
  if (g.status === 'overdue') return `nog ${euros(Math.max(0, g.target_cents - g.saldo_cents))} te gaan`;
  if (g.target_date) return `${euros(g.monthly_advice_cents)} per maand · ${goalMonth(g.target_date)}`;
  if (g.avg_contribution_cents > 0) return `${euros(g.avg_contribution_cents)} per maand`;
  return 'Geen datum';
}

function GoalCard({ g }) {
  const pct = Math.round(g.progress * 100);
  return html`<div role="listitem" class="pj-cell">
    <${Card} class=${'pj-card' + (g.status === 'reached' ? ' is-reached' : '')} onClick=${() => navigate(`/potjes/${g.id}`)}
      label=${`${g.name}, ${euros(g.saldo_cents)} van ${euros(g.target_cents)}, ${pct} procent`}>
      <span class="pj-card-top">
        <${ProgressRing} value=${g.progress} color=${g.color} size=${64} stroke=${8} emoji=${g.emoji} label=${`${pct} procent`} />
        <${StatusChip} status=${g.status} />
      </span>
      <span class="pj-card-name">${g.name}</span>
      <span class="pj-card-amount num"><b>${euros(g.saldo_cents)}</b> <span class="num">van ${euros(g.target_cents)}</span></span>
      <span class="pj-card-sub num">${cardSub(g)}</span>
    </${Card}>
  </div>`;
}

/** A suggested potje: clearly a proposal (dimmed, "Voorstel"), with one action. */
function SuggestionCard({ s, onClick }) {
  return html`<div role="listitem" class="pj-cell">
    <div class="pj-card pj-sugg card">
      <span class="pj-card-top">
        <span class="pj-ghost-ring" aria-hidden="true"><span>${s.emoji || '🎯'}</span></span>
        <span class="mini-chip tone-info">Voorstel</span>
      </span>
      <span class="pj-card-name">${s.name}</span>
      ${s.target_cents != null && html`<span class="pj-card-amount num"><b>${euros(s.target_cents)}</b></span>`}
      ${s.reason && html`<span class="pj-card-sub">${s.reason}</span>`}
      <button type="button" class="btn btn-tinted btn-small pj-sugg-btn" onClick=${onClick}
        aria-label=${`Maak potje ${s.name}${s.target_cents ? ', ' + euros(s.target_cents) : ''}`}>Maak potje</button>
    </div>
  </div>`;
}

function GhostCard({ s, onClick }) {
  return html`<div role="listitem" class="pj-cell">
    <button class=${'pj-card pj-ghost card is-pressable' + (s.emoji ? '' : ' is-blank')} onClick=${onClick} aria-label=${s.target_cents ? `Nieuw potje ${s.name}, ${euros(s.target_cents)}` : 'Nieuw potje'}>
      <span class="pj-card-top">
        <span class="pj-ghost-ring" aria-hidden="true">${s.emoji ? html`<span>${s.emoji}</span><i><${Icon} name="plus" size=${13} stroke=${3} /></i>` : html`<${Icon} name="plus" size=${26} stroke=${2.4} />`}</span>
      </span>
      <span class="pj-card-name">${s.name}</span>
      ${s.target_cents != null && html`<span class="pj-card-amount num"><b>${euros(s.target_cents)}</b></span>`}
      <span class="pj-card-sub">${s.reason || ''}</span>
    </button>
  </div>`;
}

/* ---------- Nog te verdelen ---------- */

function Unassigned({ items, goals, onNew }) {
  const [done, setDone] = useState(() => new Set());
  const [all, setAll] = useState(false);
  const open = items.filter((u) => !done.has(u.transaction_id));
  if (!open.length) return null;
  const shown = all ? open : open.slice(0, 4);
  const choose = async (u, g) => {
    setDone((s) => new Set(s).add(u.transaction_id));
    try {
      const res = await api.addGoalEntry(g.id, { transaction_id: u.transaction_id });
      const entryId = res?.entry?.id ?? res?.id;
      invalidate();
      toast({
        emoji: g.emoji,
        text: `${euros(Math.abs(u.amount_cents))} naar ${g.name}`,
        action: entryId != null && {
          label: 'Herstel',
          onClick: async () => {
            await api.deleteGoalEntry(entryId).catch((e) => toast({ text: e.message, icon: 'warning' }));
            setDone((s) => { const n = new Set(s); n.delete(u.transaction_id); return n; });
            invalidate();
          },
        },
      });
    } catch (err) {
      setDone((s) => { const n = new Set(s); n.delete(u.transaction_id); return n; });
      toast({ text: err.message, icon: 'warning' });
    }
  };
  return html`<${Section} title="Nog te verdelen" trailing=${html`<span class="section-value num">${open.length}</span>`}>
    <ul class="inset pj-ua-list">
      ${shown.map((u) => html`<li key=${u.transaction_id} class="pj-ua">
        <div class="pj-ua-top">
          <span class="pj-ua-title">${cleanDescription(u.description)}</span>
          <span class=${'pj-ua-amount num' + (u.amount_cents > 0 ? ' is-income' : '')}>${money(u.amount_cents, { signed: true, negative: true })}</span>
        </div>
        <div class="pj-ua-sub">${shortDate(u.date)}</div>
        <div class="pj-ua-chips" role="group" aria-label=${'Kies een potje voor ' + money(u.amount_cents)}>
          ${goals.map((g) => html`<${Chip} key=${g.id} emoji=${g.emoji} color=${g.color} onClick=${() => choose(u, g)}>${g.name}</${Chip}>`)}
        </div>
      </li>`)}
    </ul>
    ${shown.length < open.length && html`<button class="show-all" onClick=${() => setAll(true)}>Toon alle ${open.length}</button>`}
    <button class="show-all pj-ua-new" onClick=${() => onNew(open[0])}><${Icon} name="plus" size=${14} stroke=${2.6} /> Nieuw potje</button>
  </${Section}>`;
}

/** A new potje from a transfer: its 5-digit code (so history matches at once) or its words as name. */
function prefillFrom(u) {
  const text = cleanDescription(u.description);
  const code = (text.match(/(?:^|\D)([1-9]\d{4})(?!\d)/) || [])[1] || null;
  const words = text.replace(/[1-9]\d{4}/g, '').replace(/\b(spaardoel|sparen|naar|spaarrekening|overboeking)\b/gi, '').replace(/\s+/g, ' ').trim();
  return { name: words ? words[0].toUpperCase() + words.slice(1) : '', code, emoji: '🎯' };
}

function cleanDescription(d) {
  const s = (d || '').replace(/\s+/g, ' ').trim();
  return s || 'Naar spaarrekening';
}

/* ---------- Archived ---------- */

function Archived({ goals }) {
  const [open, setOpen] = useState(false);
  if (!goals.length) return null;
  return html`<div class="pj-archived">
    <button class="show-all" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>
      ${open ? 'Verberg gearchiveerd' : `Gearchiveerd (${goals.length})`}
    </button>
    ${open && html`<${List}>
      ${goals.map((g) => html`<${ListRow} key=${g.id} emoji=${g.emoji} color=${g.color} title=${g.name}
        value=${html`<span class="num">${euros(g.saldo_cents)}</span>`} chevron onClick=${() => navigate(`/potjes/${g.id}`)} />`)}
    </${List}>`}
  </div>`;
}

/* ---------- Nieuw potje / Wijzig potje ---------- */

const COLORS = ['teal', 'cyan', 'orange', 'pink', 'indigo', 'purple', 'mint', 'blue', 'yellow', 'green', 'brown', 'red'];

export function GoalSheet({ close, goal = null, prefill = null, used = [] }) {
  const edit = !!goal;
  const src = goal || prefill || {};
  const [emoji, setEmoji] = useState(src.emoji || '🎯');
  const [name, setName] = useState(src.name || '');
  const [target, setTarget] = useState(src.target_cents || null);
  const [date, setDate] = useState(src.target_date || null);
  const [yearly, setYearly] = useState(src.repeat === 'yearly');
  const [code, setCode] = useState(src.code || '');
  const [color, setColor] = useState(goal?.color || COLORS.find((c) => !used.includes(c)) || 'teal');
  const [busy, setBusy] = useState(false);
  const codeOk = !code || /^[1-9]\d{4}$/.test(code);
  const valid = name.trim() && target > 0 && codeOk;

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const body = { name: name.trim(), emoji, color, target_cents: target, target_date: date || null, repeat: date && yearly ? 'yearly' : 'none' };
    if (code && code !== goal?.code) body.code = code;
    try {
      if (edit) {
        await api.updateGoal(goal.id, body);
        invalidate();
        close();
      } else {
        const res = await api.createGoal(body);
        invalidate();
        const id = res?.id ?? res?.goal?.id;
        if (id != null) navigate(`/potjes/${id}`); else close();
      }
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };

  return html`<${Sheet} title=${edit ? 'Wijzig potje' : 'Nieuw potje'} detents=${['large']}
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold onClick=${save} disabled=${!valid || busy}>${edit ? 'Klaar' : 'Voeg toe'}</${SheetButton}>`}>
    <div class="sheet-pad">
      <${EmojiPicker} value=${emoji} onChange=${setEmoji} color=${color}
        suggestions=${['✈️', '🛟', '🚲', '🎄', '🏠', '🚗', '🎁', '🎓', '💍', '🛋️', '📱', '💻', '🏕️', '⛷️', '🎂', '👶', '🐶', '🦷', '🔧', '🌴', '🎸', '⚽️', '📅', '🎯']} />
      <${List}>
        <${TextField} label="Naam" value=${name} onInput=${setName} placeholder="Vakantie" enterkeyhint="next" maxLength=${60} />
        <${AmountField} label="Doelbedrag" cents=${target} onChange=${setTarget} />
      </${List}>
      <${List}>
        <${DateField} label="Datum" value=${date} onChange=${setDate} optional min=${addDays(todayISO(), 1)} />
        ${date && html`<li class="field-row">
          <label class="field-label pj-grow" for="pj-yearly">Elk jaar</label>
          <${Switch} id="pj-yearly" checked=${yearly} onChange=${setYearly} label="Elk jaar" />
        </li>`}
      </${List}>
      ${date && html`<button class="pj-clear-date" onClick=${() => { setDate(null); setYearly(false); }}>Zonder datum</button>`}
      ${(edit || src.code) && html`<${List} footer=${codeOk ? 'Het nummer in de omschrijving van je spaaropdracht.' : 'Vijf cijfers, niet beginnend met 0.'}>
        <${TextField} label="Code" value=${code} onInput=${(v) => setCode(v.replace(/\D/g, '').slice(0, 5))} inputmode="numeric" maxLength=${5} invalid=${!codeOk} placeholder="12345" />
      </${List}>`}
      ${edit && html`<${List} header="Kleur"><li class="field-row is-block"><${ColorPicker} value=${color} onChange=${setColor} /></li></${List}>`}
    </div>
  </${Sheet}>`;
}

/* ---------- Skeleton ---------- */

function PotjesSkeleton() {
  return html`<div class="pj" aria-busy="true" aria-label="Laden">
    <div class="pj-head">
      <${Skeleton} w=${90} h=${15} />
      <${Skeleton} w=${170} h=${44} r=${12} style=${{ margin: '8px 0 8px' }} />
      <${Skeleton} w=${220} h=${15} />
      <div class="pj-advice card"><${Skeleton} w=${36} h=${36} r=${10} /><${Skeleton} w="60%" h=${18} /></div>
    </div>
    <div class="pj-grid">
      ${[0, 1, 2, 3].map(() => html`<div class="pj-cell"><div class="pj-card card">
        <${Skeleton} w=${64} h=${64} r=${32} />
        <${Skeleton} w="70%" h=${16} style=${{ marginTop: '14px' }} />
        <${Skeleton} w="85%" h=${14} style=${{ marginTop: '8px' }} />
      </div></div>`)}
    </div>
  </div>`;
}

