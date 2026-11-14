// Stocks-style line/area chart with scrubbing (vertical rule + dot). The parent shows the
// scrubbed value in its header via onScrub(index|null). Put a Segmented range control above it.
// `axis` adds value labels on the right and a few x labels; on pointer devices the crosshair
// carries a read-out (label + value).
//
//   html`<${LineChart} points=${series.map((r) => ({ label: monthLabel(r.month), short: 'nov', value: r.total_cents }))}
//          onScrub=${setI} label="Vermogen per maand" axis />`

import { html, useRef, useState } from '../vendor/preact-htm.js';
import { useWidth, monotonePath, scrubHandlers, uid, Readout } from './util.js';
import { euros, axisMoney } from '../format.js';
import { canHover } from '../hooks.js';
import { drawIn, useFirstRender } from '../anim.js';

export function LineChart({ points, color = 'var(--tint)', height = 200, area = true, onScrub, scrub = null, label = 'Lijndiagram', valueFormat = euros, baseline = 'min', axis = false, readout }) {
  const [ref, w] = useWidth();
  const gid = useRef(uid('lg')).current;
  const first = useFirstRender();
  const [hover, setHover] = useState(false);
  const vals = points.map((p) => p.value);
  if (!vals.length) return html`<div class="chart" ref=${ref} style=${{ height: height + 'px' }}></div>`;
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (baseline === 'zero') lo = Math.min(0, lo);
  if (hi === lo) { hi += 100; lo -= 100; }
  const pad = (hi - lo) * 0.12;
  lo -= baseline === 'zero' ? 0 : pad;
  hi += pad;
  const padR = axis ? 52 : 0;
  const padT = 10;
  const padB = axis ? 26 : 10;
  const plotW = Math.max(40, w - padR);
  const x = (i) => (points.length === 1 ? plotW / 2 : 2 + (i / (points.length - 1)) * (plotW - 4));
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (height - padT - padB);
  const pts = points.map((p, i) => [x(i), y(p.value)]);
  const d = monotonePath(pts);
  const bottom = height - padB;
  const fill = `${d}L${pts.at(-1)[0]},${bottom}L${pts[0][0]},${bottom}Z`;
  const indexAt = (px) => Math.max(0, Math.min(points.length - 1, Math.round(((px - 2) / (plotW - 4)) * (points.length - 1))));
  const handlers = scrubHandlers({ indexAt, onChange: (i) => onScrub?.(i) });
  const onKey = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const cur = scrub ?? points.length - 1;
    onScrub?.(Math.max(0, Math.min(points.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1))));
  };
  const lineRef = (el) => first.current && drawIn(el, [{ strokeDasharray: '1', strokeDashoffset: 1 }, { strokeDasharray: '1', strokeDashoffset: 0 }], { duration: 800 });
  const areaRef = (el) => first.current && drawIn(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 800 });

  // Axis: three "nice" levels inside the visible range, x labels at the ends and in between.
  let yTicks = [];
  if (axis) {
    const raw = Math.max(100, (hi - lo) / 4);
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((x) => x >= raw);
    const startT = Math.ceil(lo / step) * step;
    for (let t = startT; t <= hi && yTicks.length < 5; t += step) yTicks.push(t);
  }
  const xEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 90))));
  const showRo = (readout ?? canHover()) && hover && scrub != null && pts[scrub];

  return html`<div class="chart linechart" ref=${ref} onPointerEnter=${(e) => e.pointerType === 'mouse' && setHover(true)} onPointerLeave=${() => setHover(false)}>
    <svg width=${w} height=${height} role="img" aria-label=${label} tabindex="0" onKeyDown=${onKey}
      onFocus=${() => setHover(true)} onBlur=${() => { setHover(false); onScrub?.(null); }}
      style=${{ touchAction: 'pan-y' }} ...${handlers}>
      <defs><linearGradient id=${gid} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color=${color} stop-opacity="0.22" /><stop offset="1" stop-color=${color} stop-opacity="0" />
      </linearGradient></defs>
      ${axis && yTicks.map((t) => html`<g>
        <line x1="0" x2=${plotW} y1=${y(t)} y2=${y(t)} class="axis-grid" />
        <text x=${plotW + 8} y=${y(t) + 4} class="axis-label">${axisMoney(t)}</text>
      </g>`)}
      ${axis && html`<line x1="0" x2=${plotW} y1=${bottom + 0.5} y2=${bottom + 0.5} class="axis-base" />`}
      ${axis && points.map((p, i) => (i % xEvery === 0 || i === points.length - 1) && (i === points.length - 1 || points.length - 1 - i >= xEvery / 2) && html`<text
        x=${Math.max(12, Math.min(plotW - 12, pts[i][0]))} y=${height - 7} text-anchor="middle" class=${'axis-label is-x' + (scrub === i ? ' is-active' : '')}>${p.short || p.label}</text>`)}
      ${area && html`<path d=${fill} fill=${`url(#${gid})`} ref=${areaRef} />`}
      <path d=${d} class="chart-line" pathLength="1" style=${{ stroke: color }} ref=${lineRef} />
      ${scrub != null && pts[scrub] && html`<g>
        <line x1=${pts[scrub][0]} x2=${pts[scrub][0]} y1=${axis ? padT : 0} y2=${bottom} class="scrub-rule" />
        <circle cx=${pts[scrub][0]} cy=${pts[scrub][1]} r="5" class="scrub-dot" style=${{ fill: color }} />
      </g>`}
      ${scrub == null && html`<circle cx=${pts.at(-1)[0]} cy=${pts.at(-1)[1]} r="4" class="end-dot" style=${{ fill: color }} />`}
    </svg>
    ${showRo && html`<${Readout} x=${pts[scrub][0]} width=${plotW} top=${Math.max(0, pts[scrub][1] - 64)}>
      <div class="ro-title">${points[scrub].label}</div>
      <div class="ro-row"><b class="num">${valueFormat(points[scrub].value)}</b></div>
    </${Readout}>`}
    <table class="vh"><caption>${label}</caption><tbody>
      ${points.map((p) => html`<tr><th scope="row">${p.label}</th><td>${valueFormat(p.value)}</td></tr>`)}
    </tbody></table>
  </div>`;
}
