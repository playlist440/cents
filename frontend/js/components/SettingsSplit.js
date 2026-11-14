// System Settings layout for the Mac (DESIGN §5): a narrow list of sections on the left of
// the content pane, the chosen section on the right. Used by Instellingen (+ Bakjes, regels,
// imports, back-up) and Tags.
//
//   html`<${SettingsSplit} label="Instellingen" active="regels" items=${[
//     { id: 'algemeen', label: 'Algemeen', icon: 'instellingen', iconColor: 'gray', onClick },
//     { id: 'tag-3', label: 'Vakantie', emoji: '🏖️', color: 'cyan', value: '€ 1.240', onClick },
//   ]}>…section…</${SettingsSplit}>`

import { html } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { EmojiTile } from './EmojiTile.js';
import { colorVar } from '../colors.js';

export function SettingsSplit({ items, active, label, header, footer, children }) {
  const onKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const btns = [...e.currentTarget.querySelectorAll('.ss-item')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const n = btns[Math.max(0, Math.min(btns.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    n?.focus();
    n?.click();
  };
  return html`<div class="ss">
    <nav class="ss-nav" aria-label=${label} onKeyDown=${onKey}>
      ${header}
      <ul class="ss-list">${items.map((it) => it === '-'
        ? html`<li class="ss-sep" role="separator"></li>`
        : html`<li key=${it.id}><button class=${'ss-item' + (it.id === active ? ' is-active' : '') + (it.dim ? ' is-dim' : '')}
            aria-current=${it.id === active ? 'page' : null} onClick=${it.onClick}>
          ${it.emoji != null
            ? html`<${EmojiTile} emoji=${it.emoji} color=${it.color} size=${22} />`
            : it.icon && html`<span class="ss-icon" style=${{ '--c': colorVar(it.iconColor || 'gray') }}><${Icon} name=${it.icon} size=${14} stroke=${2} /></span>`}
          <span class="ss-label">${it.label}</span>
          ${it.value != null && it.value !== '' && html`<span class="ss-value num">${it.value}</span>`}
        </button></li>`)}</ul>
      ${footer}
    </nav>
    <div class="ss-detail">${children}</div>
  </div>`;
}
