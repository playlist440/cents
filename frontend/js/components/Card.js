// Cards and tiles (Health/Fitness style).
//
//   html`<${Card} onClick=${open}>…</${Card}>`
//   html`<${Tile} label="Inkomen" icon="euro" color="green" cents=${540000} progress=${0.8} sub="van € 5.400" onClick=${…} />`

import { html } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { colorVar, colorTextVar } from '../colors.js';
import { euros } from '../format.js';
import { useDrawIn } from '../anim.js';

export function Card({ onClick, class: cls = '', children, label, ...rest }) {
  if (onClick) {
    return html`<button class=${'card is-pressable ' + cls} onClick=${onClick} aria-label=${label || null} ...${rest}>${children}</button>`;
  }
  return html`<div class=${'card ' + cls} ...${rest}>${children}</div>`;
}

export function Tile({ label, icon, color = 'blue', cents, value, sub, progress = null, onClick, chevron = true }) {
  const style = { '--c': colorVar(color), '--ct': colorTextVar(color) };
  const draw = useDrawIn([{ transform: 'scaleX(0)' }, {}], { duration: 900 });
  const body = html`
    <span class="tile-head">
      ${icon && html`<${Icon} name=${icon} size=${17} stroke=${2.1} />`}
      <span class="tile-label">${label}</span>
      ${chevron && onClick && html`<span class="tile-chev"><${Icon} name="chevron-right" size=${12} stroke=${2.8} /></span>`}
    </span>
    <span class="tile-value num">${value ?? euros(cents)}</span>
    ${progress != null
      ? html`<span class="tile-bar" aria-hidden="true"><span ref=${draw} style=${{ transform: `scaleX(${Math.max(0, Math.min(1, progress))})` }}></span></span>`
      : html`<span class="tile-bar is-empty" aria-hidden="true"></span>`}
    <span class="tile-sub">${sub || ' '}</span>`;
  return onClick
    ? html`<button class="tile card is-pressable" style=${style} onClick=${onClick}>${body}</button>`
    : html`<div class="tile card" style=${style}>${body}</div>`;
}
