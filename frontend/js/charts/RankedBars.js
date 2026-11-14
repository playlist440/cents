// Ranked list with thin bars relative to the largest row (instead of a pie/donut).
//
//   html`<${RankedBars} rows=${[{ key, emoji: '🛒', color: 'green', label: 'Boodschappen', value: 41200, chip: { text: '€ 40 meer', tone: 'more' }, onClick }]} />`

import { html } from '../vendor/preact-htm.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { Icon } from '../icons.js';
import { colorVar } from '../colors.js';
import { euros } from '../format.js';
import { drawIn, useFirstRender } from '../anim.js';

export function RankedBars({ rows, valueFormat = euros }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const first = useFirstRender();
  return html`<ul class="inset ranked">
    ${rows.map((r, i) => {
      const inner = html`
        <span class="row-lead"><${EmojiTile} emoji=${r.emoji} color=${r.color} dashed=${r.dashed} size=${36} /></span>
        <span class="ranked-main">
          <span class="ranked-top">
            <span class="ranked-label">${r.label}</span>
            ${r.chip && html`<span class=${'mini-chip tone-' + r.chip.tone}>${r.chip.text}</span>`}
            <span class="ranked-value num">${valueFormat(r.value)}</span>
          </span>
          <span class="ranked-track" aria-hidden="true">
            <span class="ranked-bar" ref=${(el) => first.current && drawIn(el, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 800, delay: i * 30 })}
              style=${{ width: `${Math.max(1.5, (r.value / max) * 100)}%`, background: colorVar(r.color) }}></span>
          </span>
        </span>
        ${r.onClick && html`<span class="row-chev"><${Icon} name="chevron-right" size=${14} stroke=${2.6} /></span>`}`;
      return html`<li class="row-li" key=${r.key ?? i}>${r.onClick
        ? html`<button class="row has-lead ranked-row is-button" onClick=${r.onClick}
            aria-label=${`${r.label}, ${valueFormat(r.value)}${r.chip ? ', ' + r.chip.text : ''}`}>${inner}</button>`
        : html`<div class="row has-lead ranked-row">${inner}</div>`}</li>`;
    })}
  </ul>`;
}
