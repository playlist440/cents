// Emoji on a rounded square tinted with the item's colour (bakjes, potjes, tags).
//
//   html`<${EmojiTile} emoji="🛒" color="green" size=${36} />`
//   html`<${EmojiTile} dashed />`   // unsorted

import { html } from '../vendor/preact-htm.js';
import { colorVar } from '../colors.js';

export function EmojiTile({ emoji, color = 'gray', size = 32, dashed = false, label, class: cls = '' }) {
  const style = { '--c': colorVar(color), '--size': size + 'px' };
  return html`<span class=${'etile' + (dashed ? ' is-dashed' : '') + (cls ? ' ' + cls : '')} style=${style}
    role=${label ? 'img' : null} aria-label=${label || null} aria-hidden=${label ? null : 'true'}>${dashed ? '' : emoji}</span>`;
}
