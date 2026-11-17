// Pace chart for the Overzicht hero: this period's cumulative spending (or, as the Overzicht
// passes it, what is left of a normal month's spending) (solid line + soft
// gradient) against "normaal" (dotted), today marked with a dot. Values may go below zero:
// then a zero line is drawn and the part of the line below it uses the warning colour. On touch it is not
// scrubbable on purpose (horizontal swipes on the hero change the month); with a mouse
// (`interactive`) it shows a crosshair and a read-out. `axis` adds value labels on the right
// and day labels below (`dayLabel(i)` → text for day index i).
//
//   html`<${PaceChart} actual=${pace.actual} typical=${pace.typical} label="…" />`
//   html`<${PaceChart} … height=${220} axis interactive dayLabel=${(i) => '3 nov'} />`

import { html, useRef, useState } from '../vendor/preact-htm.js';
import { useWidth, monotonePath, uid, niceMax, Readout } from './util.js';
import { euros, money, axisMoney } from '../format.js';
import { drawIn, useFirstRender, SPRING } from '../anim.js';

export function PaceChart({ actual = [], typical = [], height = 64, color = 'var(--tint)', warnColor = 'var(--warn-text)', label, showToday = true, axis = false, interactive = false, dayLabel, actualLabel = 'Uitgegeven' }) {
  const [ref, w] = useWidth();
  const gid = useRef(uid('pg')).current;
  const drawnKey = useRef(null);
  const [hi, setHi] = useState(null);
  const n = Math.max(typical.length, actual.length, 2);
  const hiV = Math.max(1, ...actual, ...typical);
  const loV = Math.min(0, ...actual, ...typical);
  const top = axis ? niceMax(hiV) : hiV * 1.08;
  const low = loV < 0 ? (axis ? -niceMax(-loV) : loV * 1.08) : 0;
  const padR = axis ? 52 : 0;
  const padT = axis ? 10 : 6;
  const padB = axis ? 26 : 4;
  const plotW = Math.max(40, w - padR);
  const bottom = height - padB;
  const x = (i) => 3 + (i / (n - 1)) * (plotW - 6);
  const y = (v) => padT + ((top - v) / (top - low)) * (bottom - padT);
  const y0 = y(0);
  const a = actual.map((v, i) => [x(i), y(v)]);
  const t = typical.map((v, i) => [x(i), y(v)]);
  const ad = monotonePath(a);
  const td = monotonePath(t);
  const fill = a.length > 1 ? `${ad}L${a.at(-1)[0]},${y0}L${a[0][0]},${y0}Z` : '';
  const neg = low < 0;
  const lastNeg = actual.length > 0 && actual.at(-1) < 0;
  const key = actual.length + ':' + actual.at(-1);
  const animate = drawnKey.current !== key;
  drawnKey.current = key;
  const first = useFirstRender();
  const once = (fn) => (el) => { if (el && animate && (first.current || el.dataset.k !== key)) { el.dataset.k = key; fn(el); } };
  const lineRef = once((el) => drawIn(el, [{ strokeDasharray: '1', strokeDashoffset: 1 }, { strokeDasharray: '1', strokeDashoffset: 0 }], { duration: 800 }));
  const areaRef = once((el) => drawIn(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 800 }));
  const dotRef = once((el) => drawIn(el, [{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { duration: 520, delay: 650, easing: SPRING }));

  const ticks = axis ? [top / 2, top, ...(neg ? [low] : [])] : [];
  // Five evenly spaced day labels (first … last): never overprinted, also for 31-day periods.
  const xTicks = [...new Set([0, 1, 2, 3, 4].map((k) => Math.round((k * (n - 1)) / 4)))];
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - 3) / (plotW - 6)) * (n - 1));
    setHi(i < 0 || i > n - 1 ? null : i);
  };
  const events = interactive
    ? { onPointerMove: (e) => e.pointerType === 'mouse' && pick(e), onPointerLeave: () => setHi(null) }
    : {};
  const ro = hi != null ? { a: actual[hi], t: typical[hi] } : null;

  return html`<div class="chart pacechart" ref=${ref} role="img" aria-label=${label}>
    <svg width=${w} height=${height} aria-hidden="true" ...${events}>
      <defs><linearGradient id=${gid} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color=${color} stop-opacity="0.2" /><stop offset="1" stop-color=${color} stop-opacity="0" />
      </linearGradient></defs>
      ${neg && html`<defs>
        <clipPath id=${gid + 'p'}><rect x="0" y="0" width=${w} height=${y0} /></clipPath>
        <clipPath id=${gid + 'n'}><rect x="0" y=${y0} width=${w} height=${Math.max(0, height - y0)} /></clipPath>
      </defs>`}
      ${ticks.map((v) => v !== 0 && html`<g>
        <line x1="0" x2=${plotW} y1=${y(v)} y2=${y(v)} class="axis-grid" />
        <text x=${plotW + 8} y=${y(v) + 4} class="axis-label">${axisMoney(v)}</text>
      </g>`)}
      <line x1="0" x2=${plotW} y1=${bottom - 0.5} y2=${bottom - 0.5} class="axis-base" />
      ${neg && html`<line x1="0" x2=${plotW} y1=${y0} y2=${y0} class="axis-base pace-zero" />`}
      ${axis && dayLabel && xTicks.map((i, k) => html`<text
        x=${x(i)} y=${height - 7} text-anchor=${k === 0 ? 'start' : k === xTicks.length - 1 ? 'end' : 'middle'} class=${'axis-label is-x' + (hi === i ? ' is-active' : '')}>${dayLabel(i)}</text>`)}
      ${td && html`<path d=${td} class="pace-typical" />`}
      ${fill && html`<path key=${'f' + key} d=${fill} fill=${`url(#${gid})`} clip-path=${neg ? `url(#${gid}p)` : null} ref=${areaRef} />`}
      ${ad && html`<path key=${'l' + key} d=${ad} pathLength="1" class="chart-line" style=${{ stroke: color }} clip-path=${neg ? `url(#${gid}p)` : null} ref=${lineRef} />`}
      ${ad && neg && html`<path key=${'n' + key} d=${ad} pathLength="1" class="chart-line" style=${{ stroke: warnColor }} clip-path=${`url(#${gid}n)`} ref=${lineRef} />`}
      ${showToday && a.length > 0 && html`<circle key=${'d' + key} cx=${a.at(-1)[0]} cy=${a.at(-1)[1]} r="4.5" class="today-dot dot-pop" style=${{ fill: lastNeg ? warnColor : color }} ref=${dotRef} />`}
      ${hi != null && html`<g>
        <line x1=${x(hi)} x2=${x(hi)} y1=${padT} y2=${bottom} class="scrub-rule" />
        ${t[hi] && html`<circle cx=${t[hi][0]} cy=${t[hi][1]} r="3.5" class="scrub-dot is-typical" />`}
        ${a[hi] && html`<circle cx=${a[hi][0]} cy=${a[hi][1]} r="4.5" class="scrub-dot" style=${{ fill: actual[hi] < 0 ? warnColor : color }} />`}
      </g>`}
    </svg>
    ${ro && html`<${Readout} x=${x(hi)} width=${plotW} top=${Math.max(0, Math.min(a[hi]?.[1] ?? t[hi]?.[1] ?? 0, t[hi]?.[1] ?? 999) - 78)}>
      ${dayLabel && html`<div class="ro-title">${dayLabel(hi, true)}</div>`}
      ${ro.a != null && html`<div class="ro-row"><i style=${{ background: ro.a < 0 ? warnColor : color }}></i><span>${actualLabel}</span><b class=${'num' + (ro.a < 0 ? ' c-warn' : '')}>${money(ro.a, { whole: true, negative: true })}</b></div>`}
      ${ro.t != null && html`<div class="ro-row"><i class="is-dots"></i><span>Normaal</span><b class="num">${euros(ro.t)}</b></div>`}
    </${Readout}>`}
  </div>`;
}
