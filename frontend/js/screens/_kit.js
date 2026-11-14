// Small helpers shared by Potjes, Vermogen, Vaste lasten and Instellingen.
//
//   commitLater(key, commit)   run a mutation after the undo toast has gone (for endpoints that
//                              have no inverse: delete goal/account/rule, ignore recurring).
//                              Returns undo(); usePending() lists keys still waiting, so lists
//                              can hide those items right away.
//   ConfirmSheet               a calm confirmation sheet for things that cannot be undone
//                              (undo an import, restore a backup). Not alert/confirm.
//   copyText(text)             clipboard with a fallback for plain-HTTP (no navigator.clipboard).
//   downloadFrom(urlPromise)   start a download from api.backupUrl()/exportTransactionsUrl().

import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { Sheet } from '../components/Sheet.js';
import { Button } from '../components/Controls.js';
import { Icon } from '../icons.js';
import { invalidate } from '../store.js';
import { toast } from '../components/Toast.js';

/* ---------- Deferred commits with undo ---------- */

const pending = new Map(); // key -> { timer, commit }
const subs = new Set();
const emit = () => subs.forEach((fn) => fn());

async function run(key) {
  const p = pending.get(key);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(key);
  try {
    await p.commit();
  } catch (err) {
    toast({ text: err.message, icon: 'warning' });
  }
  emit();
  invalidate();
}

/** Schedule `commit` (async) in `ms`; returns an undo function that cancels it. */
export function commitLater(key, commit, { ms = 5300 } = {}) {
  if (pending.has(key)) run(key);
  pending.set(key, { commit, timer: setTimeout(() => run(key), ms) });
  emit();
  return () => {
    const p = pending.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(key);
    emit();
  };
}

/** Commit everything now (used when the page is hidden, so nothing is lost). */
export function flushPending() {
  [...pending.keys()].forEach(run);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPending(); });
}

/** Set of keys waiting to be committed; re-renders when it changes. */
export function usePending() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    subs.add(fn);
    return () => subs.delete(fn);
  }, []);
  return new Set(pending.keys());
}

/* ---------- Confirmation sheet ---------- */

/**
 * openSheet(ConfirmSheet, { icon: 'undo', title: 'Import ongedaan maken?', lines: ['…'],
 *   action: 'Maak ongedaan', destructive: true, onConfirm: async () => {…} })
 * onConfirm may throw: the message is shown in the sheet and it stays open.
 */
export function ConfirmSheet({ close, icon = 'warning', emoji, title, lines = [], action, destructive = false, onConfirm, children }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      close();
    } catch (err) {
      setBusy(false);
      setError(err.message);
    }
  };
  return html`<${Sheet} label=${title} trailing=${null} hideHeader class="kit-confirm">
    <div class="sheet-pad kit-confirm-body">
      <div class=${'kit-confirm-icon' + (destructive ? ' is-destructive' : '')} aria-hidden="true">
        ${emoji ? html`<span>${emoji}</span>` : html`<${Icon} name=${icon} size=${30} stroke=${1.9} />`}
      </div>
      <h2 class="kit-confirm-title">${title}</h2>
      ${lines.filter(Boolean).map((l) => html`<p class="kit-confirm-line">${l}</p>`)}
      ${children}
      ${error && html`<p class="kit-confirm-error" role="alert">${error}</p>`}
      <div class="kit-confirm-actions">
        <${Button} variant=${destructive ? 'destructive' : 'filled'} block loading=${busy} onClick=${go}>${action}</${Button}>
        <${Button} variant="plain" block onClick=${close} disabled=${busy}>Annuleer</${Button}>
      </div>
    </div>
  </${Sheet}>`;
}

/* ---------- Clipboard ---------- */

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;pointer-events:none';
  document.body.appendChild(ta);
  const sel = document.getSelection();
  const prev = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  ta.focus({ preventScroll: true });
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (prev && sel) { sel.removeAllRanges(); sel.addRange(prev); }
  return ok;
}

/* ---------- Downloads ---------- */

export async function downloadFrom(urlPromise, filename) {
  const url = await urlPromise;
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 4000);
}
