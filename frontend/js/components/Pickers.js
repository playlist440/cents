// EmojiPicker and ColorPicker.
//
//   html`<${EmojiPicker} value=${emoji} onChange=${setEmoji} color=${color} />`
//   html`<${ColorPicker} value=${color} onChange=${setColor} />`

import { html } from '../vendor/preact-htm.js';
import { COLOR_NAMES, DUTCH_COLOR, colorVar } from '../colors.js';
import { EmojiTile } from './EmojiTile.js';
import { Icon } from '../icons.js';

const SUGGESTED = ['🛒', '🍽️', '🚗', '🏠', '🎁', '✈️', '🧸', '🐾', '💊', '👕', '🎟️', '🛠️', '📚', '⚽️', '🎵', '☕️', '🍕', '🌱', '💡', '🐷', '🎯', '🛟', '🚲', '🎄', '💼', '📦'];

/** First grapheme of a string, so pasting "🛒 Boodschappen" yields 🛒. */
function firstGrapheme(s) {
  if (!s) return '';
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    for (const { segment } of new Intl.Segmenter('nl', { granularity: 'grapheme' }).segment(s)) return segment;
  }
  return Array.from(s)[0] || '';
}

export function EmojiPicker({ value, onChange, color = 'gray', suggestions = SUGGESTED }) {
  return html`<div class="emoji-picker">
    <label class="emoji-current">
      <${EmojiTile} emoji=${value || '❔'} color=${color} size=${64} />
      <input class="emoji-input" type="text" value="" aria-label="Kies een emoji met het toetsenbord"
        autocomplete="off" autocorrect="off" spellcheck=${false} enterkeyhint="done"
        onInput=${(e) => { const g = firstGrapheme(e.currentTarget.value.trim()); if (g) onChange(g); e.currentTarget.value = ''; }} />
    </label>
    <div class="emoji-grid" role="radiogroup" aria-label="Emoji">
      ${suggestions.map((em) => html`<button role="radio" aria-checked=${em === value ? 'true' : 'false'}
        class=${'emoji-opt' + (em === value ? ' is-selected' : '')} onClick=${() => onChange(em)}>${em}</button>`)}
    </div>
  </div>`;
}

export function ColorPicker({ value, onChange, colors = COLOR_NAMES }) {
  return html`<div class="color-picker" role="radiogroup" aria-label="Kleur">
    ${colors.map((c) => html`<button role="radio" aria-checked=${c === value ? 'true' : 'false'} aria-label=${DUTCH_COLOR[c]}
      class=${'color-opt' + (c === value ? ' is-selected' : '')} style=${{ '--c': colorVar(c) }} onClick=${() => onChange(c)}>
      ${c === value && html`<${Icon} name="check" size=${16} stroke=${3} />`}
    </button>`)}
  </div>`;
}
