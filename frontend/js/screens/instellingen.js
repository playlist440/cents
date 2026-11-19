// Instellingen (DESIGN §3): Maand begint op (day picker; refreshes everything), Geleerde regels,
// Importgeschiedenis (with a calm confirmation for "Maak ongedaan"), Back-up en export
// (download backup / CSV, restore with confirmation), Wachtwoord wijzigen, Alles wissen
// (password, destructive), Uitloggen, version. The three lists are pushed screens:
// #/instellingen/regels, #/instellingen/imports, #/instellingen/backup.

import { html, useRef, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useStore, useQuery, invalidate, setState, categoryById, tagById } from '../store.js';
import { navigate, openSheet } from '../router.js';
import { shortDate, plural, number, todayISO, parseISO, MONTHS_SHORT, euros } from '../format.js';
import { Screen } from '../components/Screen.js';
import { List, ListRow } from '../components/List.js';
import { Button, SearchField } from '../components/Controls.js';
import { Skeleton, EmptyState } from '../components/Feedback.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { TextField } from '../components/Fields.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { openMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { Icon } from '../icons.js';
import { useLayout } from '../hooks.js';
import { ConfirmSheet, commitLater, usePending, downloadFrom } from './_kit.js';
import { SettingsSplit } from '../components/SettingsSplit.js';
import { openPopover } from '../components/Menu.js';

/* ---------- Mac: System Settings layout (DESIGN §5) ---------- */

/** The section list shared by Instellingen, its sub-screens and Bakjes on wide screens. */
export function InstSplit({ active, children }) {
  const mock = useStore((s) => s.mock);
  const go = (path) => navigate(path, { direction: 'none' });
  const items = [
    { id: 'algemeen', label: 'Algemeen', icon: 'instellingen', iconColor: 'gray', onClick: () => go('/instellingen') },
    { id: 'bakjes', label: 'Bakjes', icon: 'bakjes', iconColor: 'yellow', onClick: () => go('/bakjes') },
    { id: 'uitleg', label: 'Uitleg', icon: 'info', iconColor: 'blue', onClick: () => go('/uitleg') },
    { id: 'controle', label: 'Controle', icon: 'check', iconColor: 'green', onClick: () => go('/instellingen/controle') },
    { id: 'aannames', label: 'Slimme aannames', icon: 'sparkles', iconColor: 'indigo', onClick: () => go('/instellingen/aannames') },
    { id: 'regels', label: 'Geleerde regels', icon: 'sparkles', iconColor: 'purple', onClick: () => go('/instellingen/regels') },
    { id: 'imports', label: 'Importgeschiedenis', icon: 'clock', iconColor: 'blue', onClick: () => go('/instellingen/imports') },
    { id: 'backup', label: 'Back-up en export', icon: 'doc', iconColor: 'teal', onClick: () => go('/instellingen/backup') },
    ...(mock ? ['-', { id: 'gallery', label: 'Componenten', icon: 'sparkles', iconColor: 'pink', onClick: () => navigate('/_gallery') }] : []),
  ];
  return html`<${SettingsSplit} label="Instellingen" items=${items} active=${active}>${children}</${SettingsSplit}>`;
}

/** Wrap a section's content: the split on the Mac, as-is elsewhere. */
function useInst(active) {
  const desk = useLayout() === 'wide';
  return (content) => (desk ? html`<${InstSplit} active=${active}>${content}</${InstSplit}>` : content);
}

export function Instellingen() {
  const boot = useStore((s) => s.boot);
  const session = useStore((s) => s.session);
  const mock = useStore((s) => s.mock);
  const layout = useLayout();
  const day = boot?.settings?.month_start_day || 1;
  const desk = layout === 'wide';
  const wrap = useInst('algemeen');
  const openDay = (e) => (desk
    ? openPopover(e.currentTarget, (close) => html`<${DayPicker} day=${day} close=${close} />`, { width: 320, label: 'Maand begint op' })
    : openSheet(DaySheet, { day }));
  const logout = async () => {
    try { await api.logout(); } catch { /* logged out anyway */ }
    setState((s) => ({ session: { ...(s.session || {}), authenticated: false }, boot: null }));
  };
  return html`<${Screen} title=${desk ? 'Algemeen' : 'Instellingen'} class="inst">${wrap(html`
    <${List}>
      <${ListRow} icon="calendar" iconColor="blue" title="Maand begint op" value=${`de ${day}e`} chevron onClick=${openDay} />
    </${List}>
    ${!desk && html`<${List}>
      <${ListRow} icon="check" iconColor="green" title="Controle" subtitle="Kloppen je gegevens?" chevron onClick=${() => navigate('/instellingen/controle')} />
      <${ListRow} icon="sparkles" iconColor="indigo" title="Slimme aannames" chevron onClick=${() => navigate('/instellingen/aannames')} />
      <${ListRow} icon="sparkles" iconColor="purple" title="Geleerde regels" chevron onClick=${() => navigate('/instellingen/regels')} />
      <${ListRow} icon="clock" iconColor="blue" title="Importgeschiedenis" chevron onClick=${() => navigate('/instellingen/imports')} />
      <${ListRow} icon="doc" iconColor="teal" title="Back-up en export" chevron onClick=${() => navigate('/instellingen/backup')} />
    </${List}>`}
    <${List}>
      <${ListRow} icon="key" iconColor="gray" title="Wachtwoord wijzigen" chevron onClick=${() => openSheet(PasswordSheet, {})} />
      <${ListRow} icon="logout" iconColor="gray" title="Uitloggen" onClick=${logout} />
    </${List}>
    ${mock && !desk && html`<${List}><${ListRow} icon="sparkles" iconColor="purple" title="Componenten" chevron onClick=${() => navigate('/_gallery')} /></${List}>`}
    <p class="meer-version">Cents ${session?.version || ''} · <a href="https://github.com/playlist440/cents" target="_blank" rel="noopener noreferrer">Broncode</a> · AGPL-3.0</p>
  `)}</${Screen}>`;
}

/* Short back label: the long titles of these pushed screens leave no room for "Instellingen". */
const BACK = { to: '/instellingen', label: 'Terug' };

/* ---------- Maand begint op ---------- */

function periodPreview(day) {
  if (day === 1) return 'Een maand loopt van de 1e tot het eind van de maand.';
  return `Een maand loopt van de ${day}e tot de ${day - 1}e van de volgende maand.`;
}

/** Mac: the same choice as a popover anchored to the row. */
function DayPicker({ close, day }) {
  const [sel, setSel] = useState(day);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (sel === day) { close(); return; }
    setBusy(true);
    try {
      await api.updateSettings({ month_start_day: sel });
      invalidate();
      close();
      toast({ text: `Maand begint op de ${sel}e`, icon: 'calendar', action: { label: 'Herstel', onClick: async () => { try { await api.updateSettings({ month_start_day: day }); invalidate(); } catch (err) { toast({ text: err.message, icon: 'warning' }); } } } });
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };
  return html`<div class="pop-pad inst-daypop">
    <div class="pop-title">Maand begint op</div>
    <div class="inst-days" role="radiogroup" aria-label="Dag van de maand">
      ${Array.from({ length: 28 }, (_, i) => i + 1).map((d) => html`<button role="radio" aria-checked=${d === sel ? 'true' : 'false'}
        class=${'inst-day num' + (d === sel ? ' is-selected' : '')} disabled=${busy} onClick=${() => setSel(d)} onDblClick=${() => { setSel(d); }}>${d}</button>`)}
    </div>
    <p class="inst-days-note">${periodPreview(sel)}</p>
    <div class="pop-foot">
      <${Button} variant="gray" size="small" onClick=${close}>Annuleer</${Button}>
      <${Button} size="small" onClick=${save} loading=${busy}>Bewaar</${Button}>
    </div>
  </div>`;
}

function DaySheet({ close, day }) {
  const [sel, setSel] = useState(day);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (sel === day) { close(); return; }
    setBusy(true);
    try {
      await api.updateSettings({ month_start_day: sel });
      invalidate();
      close();
      toast({ text: `Maand begint op de ${sel}e`, icon: 'calendar' });
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };
  return html`<${Sheet} title="Maand begint op"
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold onClick=${save} disabled=${busy}>Klaar</${SheetButton}>`}>
    <div class="sheet-pad">
      <div class="inst-days" role="radiogroup" aria-label="Dag van de maand">
        ${Array.from({ length: 28 }, (_, i) => i + 1).map((d) => html`<button role="radio" aria-checked=${d === sel ? 'true' : 'false'}
          class=${'inst-day num' + (d === sel ? ' is-selected' : '')} disabled=${busy} onClick=${() => setSel(d)}>${d}</button>`)}
      </div>
      <p class="inst-days-note">${periodPreview(sel)}</p>
    </div>
  </${Sheet}>`;
}

/* ---------- Wachtwoord wijzigen ---------- */

function PasswordSheet({ close }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const ok = cur && next.length >= 8 && next === again;
  const hint = next && next.length < 8 ? 'Minimaal 8 tekens' : again && next !== again ? 'De wachtwoorden zijn niet gelijk' : null;
  const save = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(cur, next);
      close();
      toast({ text: 'Wachtwoord gewijzigd', icon: 'lock' });
    } catch (err) {
      setBusy(false);
      setError(err.message);
    }
  };
  return html`<${Sheet} title="Wachtwoord"
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold onClick=${save} disabled=${!ok || busy}>Bewaar</${SheetButton}>`}>
    <form class="sheet-pad" onSubmit=${(e) => { e.preventDefault(); save(); }}>
      <input type="text" name="username" autocomplete="username" value="gezin" class="vh" tabindex="-1" aria-hidden="true" readonly />
      <${List} footer=${error || hint} class=${error ? 'inst-error' : ''}>
        <${TextField} label="Huidig" type="password" value=${cur} onInput=${setCur} autocomplete="current-password" placeholder="Verplicht" />
        <${TextField} label="Nieuw" type="password" value=${next} onInput=${setNext} autocomplete="new-password" placeholder="Minimaal 8 tekens" />
        <${TextField} label="Herhaal" type="password" value=${again} onInput=${setAgain} autocomplete="new-password" placeholder="Nog een keer" onEnter=${save} enterkeyhint="done" />
      </${List}>
    </form>
  </${Sheet}>`;
}

/* ---------- Alles wissen ---------- */

function WipeSheet({ close }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const wipe = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteData(pw);
      invalidate();
      navigate('/overzicht');
      toast({ text: 'Alles gewist', icon: 'trash' });
    } catch (err) {
      setBusy(false);
      setError(err.message);
    }
  };
  return html`<${Sheet} label="Alles wissen" class="kit-confirm" hideHeader>
    <form class="sheet-pad kit-confirm-body" onSubmit=${(e) => { e.preventDefault(); wipe(); }}>
      <div class="kit-confirm-icon is-destructive" aria-hidden="true"><${Icon} name="trash" size=${30} stroke=${1.9} /></div>
      <h2 class="kit-confirm-title">Alles wissen?</h2>
      <p class="kit-confirm-line is-plain">Alle betalingen, rekeningen, potjes, tags en regels gaan weg. Je bakjes en wachtwoord blijven.</p>
      <input type="text" name="username" autocomplete="username" value="gezin" class="vh" tabindex="-1" aria-hidden="true" readonly />
      <div class="kit-confirm-field">
        <${TextField} boxed type="password" value=${pw} onInput=${setPw} placeholder="Wachtwoord" autocomplete="current-password" invalid=${!!error} />
      </div>
      ${error && html`<p class="kit-confirm-error" role="alert">${error}</p>`}
      <div class="kit-confirm-actions">
        <${Button} type="submit" variant="destructive" block disabled=${!pw} loading=${busy}>Wis alles</${Button}>
        <${Button} variant="plain" block onClick=${close} disabled=${busy}>Annuleer</${Button}>
      </div>
    </form>
  </${Sheet}>`;
}

/* ---------- Geleerde regels (#/instellingen/regels) ---------- */

export function Regels() {
  const { data, error, reload } = useQuery('rules', () => api.rules());
  const pending = usePending();
  const [q, setQ] = useState('');
  const all = (data || []).filter((r) => !pending.has('rule:' + r.id));
  const needle = q.trim().toLowerCase();
  const rows = (needle ? all.filter((r) => (r.merchant_name || r.merchant_key).toLowerCase().includes(needle)) : all)
    .slice().sort((a, b) => (a.merchant_name || '').localeCompare(b.merchant_name || '', 'nl'));
  const forget = (e, r) => {
    const anchor = e.currentTarget;
    const hasLimit = r.below_cents != null && r.below_category_id != null;
    openMenu(anchor, [
      hasLimit && { label: 'Grens aanpassen', icon: 'pencil', onSelect: () => openPopover(anchor, (close) => html`<${LimitPicker} rule=${r} close=${close} />`, { width: 300, label: 'Grens' }) },
      hasLimit && { label: 'Grens weghalen', icon: 'xmark', onSelect: () => setLimit(r, null) },
      hasLimit && '-',
      { label: 'Vergeet deze regel', icon: 'trash', destructive: true, onSelect: () => {
        const undo = commitLater('rule:' + r.id, () => api.deleteRule(r.id));
        toast({ text: `${r.merchant_name} vergeten`, icon: 'trash', action: { label: 'Herstel', onClick: undo } });
      } },
    ].filter(Boolean));
  };
  const wrap = useInst('regels');
  const desk = useLayout() === 'wide';
  return html`<${Screen} title="Geleerde regels" back=${desk ? false : BACK} class="inst">${wrap(html`
    ${!data && !error && html`<${ListSkeleton} />`}
    ${error && !data && html`<${EmptyState} emoji="🧠" title="Regels laden niet" subtitle=${error.message} action=${{ label: 'Probeer opnieuw', variant: 'tinted', onClick: () => reload() }} />`}
    ${data && !all.length && html`<${EmptyState} emoji="🧠" title="Nog niets geleerd" />`}
    ${all.length > 8 && html`<div class="inst-search"><${SearchField} value=${q} onInput=${setQ} placeholder="Zoek winkel" /></div>`}
    ${rows.length > 0 && html`<${List} footer=${`${plural(all.length, 'regel', 'regels')}. Cents onthoudt wat je sorteert.`}>
      ${rows.map((r) => {
        const cat = r.category_id != null ? categoryById(r.category_id) : null;
        const tag = r.tag_id != null ? tagById(r.tag_id) : null;
        const to = [cat?.name, tag && `${tag.emoji ? tag.emoji + ' ' : ''}${tag.name}`].filter(Boolean).join(' · ');
        const below = r.below_cents != null && r.below_category_id != null ? categoryById(r.below_category_id) : null;
        return html`<${ListRow} key=${r.id}
          leading=${html`<${EmojiTile} emoji=${cat?.emoji || tag?.emoji || '🏷️'} color=${cat?.color || tag?.color || 'gray'} size=${32} />`}
          title=${r.merchant_name || r.merchant_key}
          subtitle=${html`<span class="inst-rule-to">${to || 'Onbekend'}</span>${below ? html`<span class="num"> · Onder ${euros(r.below_cents)}: ${below.name}</span>` : ''}${r.count ? html`<span class="num"> · ${plural(r.count, 'betaling', 'betalingen')}</span>` : ''}`}
          onClick=${(e) => forget(e, r)} label=${`${r.merchant_name} naar ${to}. Opties`} />`;
      })}
    </${List}>`}
    ${data && all.length > 0 && !rows.length && html`<p class="quiet">Geen regel voor “${q}”</p>`}
  `)}</${Screen}>`;
}

/* Amount threshold of a rule ("Onder € 15: Uit eten"): change or remove, with undo. */
const LIMIT_STEPS = [100, 200, 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000];

async function setLimit(r, cents) {
  const before = { below_cents: r.below_cents, below_category_id: r.below_category_id };
  try {
    await api.updateRule(r.id, cents == null ? { below_cents: null, below_category_id: null } : { below_cents: cents });
    invalidate();
    toast({
      text: cents == null ? `Grens voor ${r.merchant_name} weg` : `${r.merchant_name}: onder ${euros(cents)}`, icon: 'check',
      action: { label: 'Herstel', onClick: async () => { try { await api.updateRule(r.id, before); invalidate(); } catch (err) { toast({ text: err.message, icon: 'warning' }); } } },
    });
  } catch (err) { toast({ text: err.message, icon: 'warning' }); }
}

function LimitPicker({ rule, close }) {
  const [cents, setCents] = useState(rule.below_cents);
  const below = categoryById(rule.below_category_id);
  const i = LIMIT_STEPS.findIndex((x) => x >= cents);
  const move = (d) => setCents(LIMIT_STEPS[Math.max(0, Math.min(LIMIT_STEPS.length - 1, (i < 0 ? LIMIT_STEPS.length - 1 : i) + d))]);
  return html`<div class="pop-pad">
    <div class="pop-title">${rule.merchant_name}</div>
    <div class="inst-limit">
      <span>Onder</span>
      <span class="td-stepper">
        <button aria-label="Lager" onClick=${() => move(-1)}><${Icon} name="minus" size=${16} stroke=${2.4} /></button>
        <span class="td-stepper-value num">${euros(cents)}</span>
        <button aria-label="Hoger" onClick=${() => move(1)}><${Icon} name="plus" size=${16} stroke=${2.4} /></button>
      </span>
      <span class="c-2">${below?.emoji || ''} ${below?.name || ''}</span>
    </div>
    <div class="pop-foot">
      <${Button} variant="gray" size="small" onClick=${close}>Annuleer</${Button}>
      <${Button} size="small" onClick=${() => { close(); if (cents !== rule.below_cents) setLimit(rule, cents); }}>Bewaar</${Button}>
    </div>
  </div>`;
}

/* ---------- Importgeschiedenis (#/instellingen/imports) ---------- */

/** "transactie-histo…20260930.xml": keep the start and the distinctive end. */
function middleTruncate(s, n) {
  if (!s || s.length <= n) return s;
  const keep = n - 1;
  return s.slice(0, Math.ceil(keep / 2)) + '…' + s.slice(s.length - Math.floor(keep / 2));
}

const AMS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "Vandaag 14:36" / "2 nov 20:14". The backend sends UTC with an offset; show Amsterdam time. */
function importedAt(iso) {
  if (!iso) return '';
  let date = iso.slice(0, 10);
  let time = iso.length > 15 ? iso.slice(11, 16) : '';
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(iso)) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      const p = Object.fromEntries(AMS.formatToParts(d).map((x) => [x.type, x.value]));
      date = `${p.year}-${p.month}-${p.day}`;
      time = `${p.hour}:${p.minute}`;
    }
  }
  return `${date === todayISO() ? 'Vandaag' : shortDate(date)}${time ? ' ' + time : ''}`;
}

function range(a, b) {
  if (!a || !b) return '';
  const da = parseISO(a);
  const db = parseISO(b);
  const sameYear = da.getUTCFullYear() === db.getUTCFullYear();
  const left = `${da.getUTCDate()} ${MONTHS_SHORT[da.getUTCMonth()]}${sameYear ? '' : ' ' + da.getUTCFullYear()}`;
  return `${left} – ${db.getUTCDate()} ${MONTHS_SHORT[db.getUTCMonth()]} ${db.getUTCFullYear()}`;
}

export function Imports() {
  const { data, error, reload } = useQuery('imports', () => api.imports());
  const undo = (imp) => {
    const n = imp.n_transactions ?? imp.n_new;
    openSheet(ConfirmSheet, {
      icon: 'undo',
      title: 'Import ongedaan maken?',
      lines: [
        imp.filename,
        `${plural(n, 'betaling', 'betalingen')}${imp.date_from ? ` van ${range(imp.date_from, imp.date_to)}` : ''} ${n === 1 ? 'gaat' : 'gaan'} uit Cents. Je kunt het bestand later opnieuw importeren.`,
      ],
      action: 'Maak ongedaan',
      destructive: true,
      onConfirm: async () => {
        await api.deleteImport(imp.id);
        invalidate();
        toast({ text: 'Import ongedaan gemaakt', icon: 'undo' });
      },
    });
  };
  const wrap = useInst('imports');
  const desk = useLayout() === 'wide';
  return html`<${Screen} title="Importgeschiedenis" back=${desk ? false : BACK} class="inst">${wrap(html`
    ${!data && !error && html`<${ListSkeleton} two />`}
    ${error && !data && html`<${EmptyState} emoji="📄" title="Importgeschiedenis laadt niet" subtitle=${error.message} action=${{ label: 'Probeer opnieuw', variant: 'tinted', onClick: () => reload() }} />`}
    ${data && !data.length && html`<${EmptyState} emoji="📄" title="Nog niets geïmporteerd" />`}
    ${data?.length > 0 && html`<${List}>
      ${data.map((imp) => html`<li class="row-li" key=${imp.id}>
        <div class="row is-two has-lead inst-imp">
          <span class="row-lead"><span class="row-icon" style=${{ '--c': 'var(--blue)' }}><${Icon} name="doc" size=${18} stroke=${1.9} /></span></span>
          <span class="row-main">
            <span class="row-title num">${importedAt(imp.imported_at)} · ${number(imp.n_new)} nieuw${imp.n_duplicate ? ` · ${number(imp.n_duplicate)} al bekend` : ''}</span>
            <span class="row-sub inst-file" title=${imp.filename}>${middleTruncate(imp.filename, 44)}</span>
            ${(imp.account_name || imp.date_from) && html`<span class="row-sub">${[imp.account_name, range(imp.date_from, imp.date_to)].filter(Boolean).join(' · ')}</span>`}
          </span>
          <${Button} variant="gray" size="small" class="inst-undo-btn" onClick=${() => undo(imp)} aria-label=${'Import ' + imp.filename + ' terugdraaien'}>Terugdraaien</${Button}>
        </div>
      </li>`)}
    </${List}>`}
  `)}</${Screen}>`;
}

/* ---------- Back-up en export (#/instellingen/backup) ---------- */

export function Backup() {
  const file = useRef(null);
  const day = todayISO();
  const dl = async (which) => {
    try {
      if (which === 'backup') await downloadFrom(api.backupUrl(), `cents-backup-${day}.db`);
      else await downloadFrom(api.exportTransactionsUrl(), `cents-transacties-${day}.csv`);
    } catch (err) {
      toast({ text: err.message, icon: 'warning' });
    }
  };
  const chosen = (f) => {
    if (!f) return;
    openSheet(ConfirmSheet, {
      icon: 'undo',
      title: 'Back-up terugzetten?',
      lines: [f.name, 'Alles in Cents wordt vervangen door deze back-up.'],
      action: 'Zet terug',
      destructive: true,
      onConfirm: async () => {
        const res = await api.restore(f);
        invalidate();
        toast({ text: res?.transactions != null ? `Back-up teruggezet · ${plural(res.transactions, 'betaling', 'betalingen')}` : 'Back-up teruggezet', icon: 'check' });
      },
    });
  };
  const wrap = useInst('backup');
  const desk = useLayout() === 'wide';
  return html`<${Screen} title="Back-up en export" back=${desk ? false : BACK} class="inst">${wrap(html`
    <${List} footer="Een back-up bevat alles: betalingen, bakjes, potjes en instellingen.">
      <${ListRow} icon="share" iconColor="teal" title="Download back-up" onClick=${() => dl('backup')} />
      <${ListRow} icon="doc" iconColor="green" title="Download als CSV" onClick=${() => dl('csv')} />
    </${List}>
    <${List}>
      <${ListRow} icon="undo" iconColor="orange" title="Zet back-up terug" onClick=${() => file.current?.click()} />
    </${List}>
    <${List} header="Gevaarlijk" class="inst-danger">
      <${ListRow} title="Alles wissen" destructive onClick=${() => openSheet(WipeSheet, {})} />
    </${List}>
    <input ref=${file} type="file" class="vh" tabindex="-1" aria-hidden="true" accept=".db,.sqlite,.sqlite3,.backup,application/octet-stream,application/vnd.sqlite3,application/x-sqlite3"
      onChange=${(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; chosen(f); }} />
  `)}</${Screen}>`;
}

/* ---------- Skeleton ---------- */

function ListSkeleton({ two = false }) {
  return html`<div class="inset" aria-busy="true" aria-label="Laden">${[0, 1, 2, 3, 4].map(() => html`<div class=${'row has-lead' + (two ? ' is-two' : '')}>
    <span class="row-lead"><${Skeleton} w=${32} h=${32} r=${8} /></span>
    <span class="row-main"><${Skeleton} w="55%" h=${15} />${two && html`<${Skeleton} w="40%" h=${13} />`}</span></div>`)}</div>`;
}

