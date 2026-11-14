// Tiny trend line: no axes, last point dotted, soft fill.
//
//   html`<${Sparkline} values=${[120, 90, 140, 110]} width=${64} height=${28} label="…" />`

import { html, useRef } from '../vendor/preact-htm.js';
import { monotonePath, uid } from './util.js';

export function Sparkline({ values = [], width = 64, height = 28, color = 'var(--tint)', label, fill = true }) {
  const gid = useRef(uid('sg')).current;
  if (values.length < 2) return html`<span class="spark" style=${{ width: width + 'px', height: height + 'px' }}></span>`;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => [2 + (i / (values.length - 1)) * (width - 6), 3 + (1 - (v - lo) / span) * (height - 6)]);
  const d = monotonePath(pts);
  return html`<svg class="spark" width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`}
    role=${label ? 'img' : null} aria-label=${label || null} aria-hidden=${label ? null : 'true'}>
    <defs><linearGradient id=${gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color=${color} stop-opacity=".18" /><stop offset="1" stop-color=${color} stop-opacity="0" /></linearGradient></defs>
    ${fill && html`<path d=${`${d}L${pts.at(-1)[0]},${height}L${pts[0][0]},${height}Z`} fill=${`url(#${gid})`} />`}
    <path d=${d} fill="none" stroke=${color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx=${pts.at(-1)[0]} cy=${pts.at(-1)[1]} r="2.5" fill=${color} />
  </svg>`;
}
