// Wallet-style stacked capsule: one segment per bakje, 2 px gaps, draws in from the left.
//
//   html`<${StackedCapsule} segments=${[{ value: 41200, color: 'green', label: 'Boodschappen' }, …]} />`

import { html } from '../vendor/preact-htm.js';
import { colorVar } from '../colors.js';
import { euros } from '../format.js';
import { useDrawIn } from '../anim.js';

export function StackedCapsule({ segments, height = 12, label = 'Verdeling' }) {
  const parts = segments.filter((s) => s.value > 0);
  const total = parts.reduce((s, x) => s + x.value, 0) || 1;
  const text = parts.map((s) => `${s.label} ${euros(s.value)}`).join(', ');
  const draw = useDrawIn([{ clipPath: 'inset(0 100% 0 0 round 999px)' }, { clipPath: 'inset(0 0% 0 0 round 999px)' }], { duration: 900 });
  return html`<div class="capsule" ref=${draw} style=${{ height: height + 'px' }} role="img" aria-label=${`${label}: ${text}`}>
    ${parts.map((s, i) => html`<span class="capsule-seg" key=${s.key ?? i}
      style=${{ flexGrow: s.value / total, background: colorVar(s.color) }}></span>`)}
  </div>`;
}
