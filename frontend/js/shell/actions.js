// App-wide actions any screen may call.

import { openSheet, navigate } from '../router.js';
import { sheets } from '../routes.js';
import { openMenu } from '../components/Menu.js';

/** Open the Import sheet, optionally with files already chosen or dropped. */
export function openImport(files = null) {
  openSheet(sheets.import, { files });
}

/** Open "Uitgave toevoegen". */
export function openAddExpense(props = {}) {
  openSheet(sheets.uitgave, props);
}

/** Open the transaction sheet (built by the Transacties screen owner). */
export function openTransaction(tx, props = {}) {
  openSheet(sheets.transactie, { id: tx.id ?? tx, tx: typeof tx === 'object' ? tx : null, ...props });
}

/** The `+` menu in the nav bar of Overzicht and Transacties. */
export function openAddMenu(anchor) {
  openMenu(anchor, [
    { label: 'Bankbestand importeren', icon: 'import', onSelect: () => openImport() },
    { label: 'Uitgave toevoegen', icon: 'creditcard', onSelect: () => openAddExpense() },
  ]);
}

/**
 * Follow an insight link. Accepts the backend's `href` ("/vaste-lasten", "#/potjes/3",
 * "/import") or its structured `link: {screen, params}`.
 */
export function openLink(link) {
  if (!link) return;
  const path = typeof link === 'string' ? link.replace(/^#/, '') : hrefFor(link);
  if (!path) return;
  if (path === '/import') { openImport(); return; }
  navigate(path.startsWith('/') ? path : '/' + path);
}

const SCREENS = { sort: '/sorteren', recurring: '/vaste-lasten', goals: '/potjes', import: '/import', networth: '/vermogen', trends: '/jaaroverzicht', transactions: '/transacties' };

function hrefFor({ screen, params = {} }) {
  const q = new URLSearchParams(Object.entries(params).filter(([k, v]) => v != null && k !== 'id')).toString();
  const base = screen === 'category' ? `/overzicht/bakje/${params.id}` : screen === 'goal' ? `/potjes/${params.id}` : SCREENS[screen];
  return base ? base + (q ? '?' + q : '') : null;
}
