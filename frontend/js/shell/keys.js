// Global keyboard shortcuts (DESIGN §5). Never hijacks browser shortcuts: only ⌘K / Ctrl+K
// takes a modifier; everything else is a bare key and is ignored while typing in a field,
// while a sheet or menu is open, or with any modifier held.
//
//   /  or ⌘K   search payments          N   new expense        I   import
//   ← / →      previous / next month on Overzicht               ?   this list
//   Esc        closes sheets and menus (handled there), leaves the search field
// Screens add their own (Transacties: ↑/↓, Enter, ⌘A; Sorteren: 1–9, spatie, ⌘Z).

import { html } from '../vendor/preact-htm.js';
import { current, replaceQuery, hasOpenSheet, openSheet } from '../router.js';
import { getState } from '../store.js';
import { shiftPeriod } from '../format.js';
import { openImport, openAddExpense } from './actions.js';
import { focusToolbarSearch } from '../components/Toolbar.js';
import { isMenuOpen } from '../components/Menu.js';
import { Sheet } from '../components/Sheet.js';

const typing = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

export const SHORTCUTS = [
  ['Zoek betalingen', ['/', '⌘K']],
  ['Vorige / volgende maand', ['←', '→']],
  ['Uitgave toevoegen', ['N']],
  ['Bankbestand importeren', ['I']],
  ['Sluit venster of menu', ['Esc']],
  ['Deze lijst', ['?']],
];
const TX = [
  ['Vorige / volgende betaling', ['↑', '↓']],
  ['Meer kiezen', ['⌘-klik', '⇧-klik']],
  ['Alles kiezen', ['⌘A']],
  ['Naar het detail', ['↩']],
];
const SORT = [
  ['Kies bakje', ['1–9']],
  ['Sla over', ['spatie']],
  ['Herstel', ['⌘Z']],
];

export function installShortcuts() {
  const onKey = (e) => {
    if (e.defaultPrevented) return;
    const k = e.key;
    // ⌘K / Ctrl+K: search, also from inside other fields.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && k.toLowerCase() === 'k') {
      if (hasOpenSheet()) return;
      if (focusToolbarSearch()) e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing(document.activeElement) || hasOpenSheet() || isMenuOpen()) return;
    const r = current();
    if (!getState().session?.authenticated || !getState().boot) return;
    if (k === '/') { if (focusToolbarSearch()) e.preventDefault(); return; }
    if (k === '?') { e.preventDefault(); openSheet(ShortcutSheet, {}); return; }
    if (r.route.path === '/sorteren') return; // Sorteren owns the bare keys
    if (k === 'n' || k === 'N') { e.preventDefault(); openAddExpense(); return; }
    if (k === 'i' || k === 'I') { e.preventDefault(); openImport(); return; }
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && r.path === '/overzicht') {
      const { periods } = getState().boot;
      const cur = r.query.period || periods.current;
      const next = shiftPeriod(cur, k === 'ArrowLeft' ? -1 : 1);
      if (next < periods.first || next > periods.last) return;
      e.preventDefault();
      replaceQuery({ period: next === periods.current ? undefined : next });
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

function Group({ title, rows }) {
  return html`<section class="kb-group">
    <h3 class="kb-h">${title}</h3>
    <dl class="kb-list">${rows.map(([what, keys]) => html`<div class="kb-row"><dt>${what}</dt>
      <dd>${keys.map((x) => html`<kbd>${x}</kbd>`)}</dd></div>`)}</dl>
  </section>`;
}

export function ShortcutSheet() {
  return html`<${Sheet} title="Sneltoetsen" class="kb-sheet">
    <div class="sheet-pad kb">
      <${Group} title="Overal" rows=${SHORTCUTS} />
      <${Group} title="Transacties" rows=${TX} />
      <${Group} title="Sorteren" rows=${SORT} />
    </div>
  </${Sheet}>`;
}
