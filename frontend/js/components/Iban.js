// An account number, everywhere the same: masked ("NL•• 4417") until you tap it, then the whole
// number as selectable text in groups of four, with a copy button. Taps never reach the row
// around it.
//
//   html`<${Iban} iban=${account.iban} />`          // masked, tap to show
//   html`<${Iban} iban=${t.counterparty_iban} open />` // shown right away

import { html, useState } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { toast } from './Toast.js';
import { copyText } from '../screens/_kit.js';

export const groupIban = (iban) => (iban || '').replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
const masked = (iban) => {
  const c = (iban || '').replace(/\s+/g, '');
  return `${c.slice(0, 2)}•• ${c.slice(-4)}`;
};

export function Iban({ iban, open: startOpen = false, class: cls = '' }) {
  const [open, setOpen] = useState(startOpen);
  if (!iban) return null;
  const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
  const copy = async (e) => {
    stop(e);
    const ok = await copyText(iban.replace(/\s+/g, ''));
    toast({ text: ok === false ? 'Kopiëren lukte niet' : 'Rekeningnummer gekopieerd', icon: ok === false ? 'warning' : 'copy' });
  };
  if (!open) {
    return html`<span class=${'iban is-masked num ' + cls} role="button" tabindex="0" aria-label=${`Rekeningnummer ${masked(iban)}, toon het hele nummer`}
      onClick=${(e) => { stop(e); setOpen(true); }} onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { stop(e); setOpen(true); } }}>${masked(iban)}</span>`;
  }
  return html`<span class=${'iban is-open num ' + cls} onClick=${(e) => e.stopPropagation()}>
    <span class="iban-text">${groupIban(iban)}</span>
    <span class="iban-copy" role="button" tabindex="0" aria-label="Kopieer rekeningnummer" data-tip="Kopieer"
      onClick=${copy} onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') copy(e); }}><${Icon} name="copy" size=${13} stroke=${2.2} /></span>
  </span>`;
}
