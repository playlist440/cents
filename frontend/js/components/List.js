// Inset grouped list (Settings style).
//
//   html`<${List} header="Instellingen" footer="…">
//     <${ListRow} emoji="🛒" color="green" title="Boodschappen" value="€ 412" chevron onClick=${…} />
//     <${ListRow} icon="import" title="Importeren" onClick=${…} />
//   </${List}>`
//
// ListRow props: title, subtitle, value (string|vnode), emoji+color | icon | leading (vnode),
// chevron, onClick (renders a <button>), destructive, accessory (trailing vnode), multiline.

import { html } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { EmojiTile } from './EmojiTile.js';
import { colorVar } from '../colors.js';

export function List({ header, footer, children, class: cls = '', plain = false }) {
  return html`<section class=${'list-group ' + cls}>
    ${header && html`<h3 class="list-header">${header}</h3>`}
    <ul class=${plain ? 'list-plain' : 'inset'}>${children}</ul>
    ${footer && html`<p class="list-footer">${footer}</p>`}
  </section>`;
}

export function ListRow({ title, subtitle, value, emoji, color, icon, iconColor, leading, chevron = false, onClick, destructive = false, accessory, class: cls = '', tint = false, label, selected = false }) {
  const lead = leading
    || (emoji && html`<${EmojiTile} emoji=${emoji} color=${color} size=${32} />`)
    || (icon && html`<span class="row-icon" style=${{ '--c': iconColor ? colorVar(iconColor) : 'var(--tint)' }}><${Icon} name=${icon} size=${20} stroke=${1.9} /></span>`);
  const inner = html`
    ${lead && html`<span class="row-lead">${lead}</span>`}
    <span class="row-main">
      <span class=${'row-title' + (destructive ? ' c-danger' : tint ? ' c-tint' : '')}>${title}</span>
      ${subtitle && html`<span class="row-sub">${subtitle}</span>`}
    </span>
    ${value != null && value !== '' && html`<span class="row-value">${value}</span>`}
    ${accessory}
    ${selected && html`<span class="row-check c-tint"><${Icon} name="check" size=${18} stroke=${2.4} /></span>`}
    ${chevron && html`<span class="row-chev"><${Icon} name="chevron-right" size=${14} stroke=${2.6} /></span>`}`;
  const c = 'row' + (lead ? ' has-lead' : '') + (subtitle ? ' is-two' : '') + (cls ? ' ' + cls : '');
  return html`<li class="row-li">${onClick
    ? html`<button class=${c + ' is-button'} onClick=${onClick} aria-label=${label || null}>${inner}</button>`
    : html`<div class=${c}>${inner}</div>`}</li>`;
}

/** Screen section with a bold header and optional trailing link/value (Health style).
 *  html`<${Section} title="Binnenkort" link=${{ label: 'Alles', onClick }}>…</${Section}>` */
export function Section({ title, link, trailing, children, class: cls = '', id }) {
  return html`<section class=${'section ' + cls} aria-labelledby=${id || null}>
    <div class="section-h">
      <h2 id=${id || null}>${title}</h2>
      ${trailing}
      ${link && html`<button class="section-link" onClick=${link.onClick}>${link.label}</button>`}
    </div>
    ${children}
  </section>`;
}
