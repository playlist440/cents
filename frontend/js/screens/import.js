// Import sheet (DESIGN §3): drop zone / Files picker (several files), one row per file that
// shows upload progress, then "Verwerken", then the result ("128 nieuw · 9 al bekend", or
// "Alles was al bekend"), friendly per-file errors, inline naming + soort of new accounts, and
// the follow-up button ("Sorteer 14 winkels" / "Klaar").
// Files are sent one request each, in order, so every file has its own progress and result.
// Props: { files: File[] | null, close }

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { uploadWithProgress } from '../upload.js';
import { invalidate } from '../store.js';
import { navigate } from '../router.js';
import { plural, number, shortDate } from '../format.js';
import { Sheet, SheetButton, useSheet } from '../components/Sheet.js';
import { DropZone, FileButton } from '../components/Feedback.js';
import { Button } from '../components/Controls.js';
import { openMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { Icon } from '../icons.js';
import { maskIban, ACCOUNT_TYPE_LABEL } from './_tx.js';

let seq = 0;
let live = null; // add() of the open Import sheet

export function ImportSheet({ files: initial, close }) {
  const [rows, setRows] = useState([]);        // { key, file, state: queued|upload|process|done|error, progress, result, error }
  const [unsorted, setUnsorted] = useState(null);
  const queue = useRef([]);
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const update = (key, patch) => alive.current && setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const pump = async () => {
    if (running.current) return;
    running.current = true;
    while (queue.current.length) {
      const row = queue.current.shift();
      update(row.key, { state: 'upload', progress: 0 });
      try {
        const res = await uploadWithProgress('/import', [row.file], {
          onProgress: (p) => update(row.key, p >= 1 ? { state: 'process', progress: 1 } : { progress: p }),
        });
        const r = res.files?.[0] || {};
        if (r.ok === false) update(row.key, { state: 'error', error: friendly(r.error) });
        else update(row.key, { state: 'done', result: r });
        if (alive.current) setUnsorted(res.unsorted_merchants ?? null);
        invalidate();
      } catch (err) {
        update(row.key, { state: 'error', error: friendly(err.message, err.status) });
      }
    }
    running.current = false;
  };

  const add = (files) => {
    const list = [...files].map((file) => ({ key: 'f' + ++seq, file, state: 'queued', progress: 0 }));
    setRows((rs) => [...rs, ...list]);
    queue.current.push(...list);
    pump();
  };

  // Files dropped on the window while a sheet is open reach a second ImportSheet (the shell
  // opens one per drop): it hands them to the open sheet and closes without rendering.
  const ctx = useSheet();
  const [dup] = useState(() => !!(live && initial?.length));
  useEffect(() => {
    if (dup) { live(initial); close(); setTimeout(() => ctx?.onClosed?.(), 30); return; }
    if (initial?.length) add(initial);
    const mine = (files) => add(files);
    live = mine;
    return () => { if (live === mine) live = null; };
  }, []);

  const busy = rows.some((r) => r.state === 'queued' || r.state === 'upload' || r.state === 'process');
  const done = rows.length > 0 && !busy;
  const okRows = rows.filter((r) => r.state === 'done');
  const totalNew = okRows.reduce((s, r) => s + (r.result.new || 0), 0);
  const totalKnown = okRows.reduce((s, r) => s + (r.result.duplicates || 0), 0);
  const newAccounts = [];
  const seen = new Set();
  for (const r of okRows) for (const a of r.result.new_accounts || []) if (!seen.has(a.id)) { seen.add(a.id); newAccounts.push(a); }

  const sort = () => navigate('/sorteren');
  if (dup) return null;

  return html`<${Sheet} title="Importeren" detents=${['large']} class="im-sheet"
      trailing=${done ? html`<${SheetButton} bold onClick=${close}>Klaar</${SheetButton}>` : undefined}>
    <div class="sheet-pad im">
      ${rows.length === 0
        ? html`<${DropZone} compact onFiles=${add} />`
        : html`
          ${done && okRows.length > 0 && html`<${Summary} totalNew=${totalNew} totalKnown=${totalKnown} />`}
          <ul class="inset im-files" aria-label="Bestanden">
            ${rows.map((r) => html`<${FileRow} key=${r.key} row=${r} />`)}
          </ul>
          ${newAccounts.length > 0 && html`<section class="im-accounts">
            <h3 class="list-header">${newAccounts.length === 1 ? 'Nieuwe rekening' : 'Nieuwe rekeningen'}</h3>
            ${newAccounts.map((a) => html`<${AccountRow} key=${a.id} account=${a} />`)}
          </section>`}
          <div class="im-actions">
            ${done && unsorted > 0
              ? html`<${Button} block onClick=${sort}>Sorteer ${plural(unsorted, 'winkel', 'winkels')}</${Button}>`
              : html`<${Button} block variant=${done ? 'filled' : 'gray'} disabled=${!done} onClick=${close}>${done ? 'Klaar' : 'Bezig…'}</${Button}>`}
            ${done && html`<div class="im-more"><${FileButton} variant="plain" size="medium" onFiles=${add}>Nog een bestand</${FileButton}></div>`}
          </div>`}
    </div>
  </${Sheet}>`;
}

function friendly(message, status) {
  if (status === 0) return 'Geen verbinding met Cents.';
  if (status === 413) return 'Dit bestand is te groot.';
  if (!message || /^[A-Z_]+$/.test(message)) return 'Dit bestand kon ik niet lezen.';
  return message;
}

function Summary({ totalNew, totalKnown }) {
  const nothingNew = totalNew === 0;
  return html`<div class=${'im-summary' + (nothingNew ? ' is-known' : '')}>
    <span class="im-summary-icon" aria-hidden="true"><${Icon} name="check" size=${30} stroke=${3} /></span>
    <span class="im-summary-title">${nothingNew ? 'Alles was al bekend' : plural(totalNew, 'nieuwe betaling', 'nieuwe betalingen')}</span>
    ${nothingNew
      ? totalKnown > 0 && html`<span class="im-summary-sub">${plural(totalKnown, 'betaling', 'betalingen')} stond${totalKnown === 1 ? '' : 'en'} er al in</span>`
      : totalKnown > 0 && html`<span class="im-summary-sub">${number(totalKnown)} al bekend</span>`}
  </div>`;
}

function size(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} MB`;
}

function FileRow({ row }) {
  const { file, state, progress, result, error } = row;
  let sub;
  let icon = html`<${Icon} name="doc" size=${22} stroke=${1.7} />`;
  let tone = '';
  if (state === 'queued') sub = `${size(file.size)} · wacht`;
  else if (state === 'upload') sub = `${size(file.size)} · ${Math.round(progress * 100)}%`;
  else if (state === 'process') sub = 'Verwerken…';
  else if (state === 'error') { sub = error; tone = ' is-error'; icon = html`<${Icon} name="warning" size=${21} stroke=${1.9} />`; }
  else if (state === 'done') {
    tone = ' is-done';
    icon = html`<${Icon} name="check" size=${20} stroke=${2.6} />`;
    const range = result.date_from && result.date_to ? `${shortDate(result.date_from)} – ${shortDate(result.date_to)}` : null;
    sub = result.new === 0
      ? (result.duplicates > 0 ? 'Alles was al bekend' : 'Geen betalingen gevonden')
      : [`${number(result.new)} nieuw`, result.duplicates ? `${number(result.duplicates)} al bekend` : null, range].filter(Boolean).join(' · ');
  }
  const working = state === 'upload' || state === 'process';
  return html`<li class="row-li">
    <div class=${'row has-lead is-two im-file' + tone} aria-busy=${working ? 'true' : null}>
      <span class="row-lead"><span class="im-file-icon">${icon}</span></span>
      <span class="row-main">
        <span class="row-title">${file.name}</span>
        <span class="row-sub">${sub}</span>
      </span>
      ${state === 'done' && result.account_name && html`<span class="row-value im-acc">${result.account_name}</span>`}
      ${working && html`<span class=${'im-bar' + (state === 'process' ? ' is-indeterminate' : '')} role="progressbar"
          aria-label=${`${file.name} uploaden`} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${state === 'process' ? null : Math.round(progress * 100)}>
        <span style=${state === 'upload' ? { transform: `scaleX(${progress})` } : null}></span>
      </span>`}
    </div>
  </li>`;
}


function AccountRow({ account }) {
  const [name, setName] = useState(account.name);
  const [type, setType] = useState(account.type);
  const saved = useRef({ name: account.name, type: account.type });
  const save = async (patch) => {
    const before = { ...saved.current };
    saved.current = { ...saved.current, ...patch };
    try {
      await api.updateAccount(account.id, patch);
      invalidate();
    } catch (err) {
      saved.current = before;
      setName(before.name); setType(before.type);
      toast({ text: err.message, icon: 'warning' });
    }
  };
  const setT = (t) => {
    setType(t);
    const auto = Object.values(ACCOUNT_TYPE_LABEL).includes(name.replace(/\s+\d{4}$/, '')) ? ACCOUNT_TYPE_LABEL[t] + (name.match(/\s+\d{4}$/)?.[0] || '') : null;
    if (auto) setName(auto);
    save(auto ? { type: t, name: auto } : { type: t });
  };
  return html`<div class="im-account inset">
    <div class="im-account-head">
      <span class="im-account-icon" aria-hidden="true"><${Icon} name=${type === 'credit' ? 'creditcard' : type === 'savings' ? 'piggy' : type === 'investment' ? 'jaaroverzicht' : 'wallet'} size=${20} stroke=${1.9} /></span>
      <input class="im-account-name" value=${name} aria-label="Naam van de rekening" maxLength="60" enterkeyhint="done"
        onInput=${(e) => setName(e.currentTarget.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        onBlur=${() => { const n = name.trim(); if (!n) { setName(saved.current.name); return; } if (n !== saved.current.name) save({ name: n }); }} />
      ${account.iban && html`<span class="im-iban num">${maskIban(account.iban)}</span>`}
    </div>
    <button class="im-account-type" aria-haspopup="menu" onClick=${(e) => openMenu(e.currentTarget, Object.entries(ACCOUNT_TYPE_LABEL).map(([t, label]) => ({ label, checked: t === type, onSelect: () => setT(t) })))}>
      <span>Soort</span>
      <span class="im-account-type-value">${ACCOUNT_TYPE_LABEL[type] || type}<${Icon} name="chevron-up-down" size=${15} stroke=${2.2} /></span>
    </button>
  </div>`;
}
