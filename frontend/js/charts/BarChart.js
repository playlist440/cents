// Health-style bar chart, single or stacked. Rounded data ends, 2 px gaps between stacked
// segments, y labels on the right, dashed "normaal" line. Scrub with finger/mouse, arrow keys.
// On pointer devices the hovered column gets a soft band and a read-out (label + values).
// A visually hidden table carries the data for screen readers.
//
//   html`<${BarChart} data=${[{ label: 'november 2026', short: 'nov', value: 41200 }, …]}
//          average=${38000} selected=${i} onSelect=${setI} />`
//   Stacked: data=${[{ label, short, values: [vast, dagelijks, gespaard] }]} series=${[{ name: 'Vast', color: 'var(--indigo)' }, …]}
//   Per datum `partial: true` draws the bar lighter (an incomplete month; DECISIONS).
//   readout: true (default on pointer devices) | false; readoutExtra(i) adds a line.

import { html, useRef, useState } from '../vendor/preact-htm.js';
import { useWidth, niceMax, scrubHandlers, Readout } from './util.js';
import { axisMoney, euros } from '../format.js';
import { canHover } from '../hooks.js';
import { drawIn, useFirstRender, SPRING } from '../anim.js';

export function BarChart({ data, series, color = 'var(--tint)', height = 180, average = null, selected: selProp, onSelect, valueFormat = euros, label = 'Staafdiagram', highlight = null, line = null, readout, readoutExtra }) {
  const [ref, w] = useWidth();
  const [selLocal, setSelLocal] = useState(null);
  const [hover, setHover] = useState(false);
  const controlled = selProp !== undefined;
  const sel = controlled ? selProp : selLocal;
  const setSel = (i) => { if (!controlled) setSelLocal(i); onSelect?.(i); };
  const first = useFirstRender();
  const showReadout = (readout ?? canHover()) && hover;

  const stacked = !!series;
  const totals = data.map((d) => (stacked ? d.values.reduce((s, v) => s + Math.max(0, v), 0) : Math.max(0, d.value)));
  const lineVals = line ? line.values : [];
  const max = niceMax(Math.max(...totals, average || 0, ...lineVals, 1));
  const padR = 44;
  const padB = 22;
  const padT = 6;
  const plotW = Math.max(40, w - padR);
  const plotH = height - padB - padT;
  const slot = plotW / Math.max(1, data.length);
  const bw = Math.max(4, Math.min(w > 700 ? 40 : 28, slot * 0.58));
  const y = (v) => padT + plotH - (v / max) * plotH;
  const indexAt = (x) => Math.max(0, Math.min(data.length - 1, Math.floor(x / slot)));
  const handlers = scrubHandlers({ indexAt, onChange: setSel, keep: controlled });
  const onKey = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const cur = sel ?? data.length - 1;
      setSel(Math.max(0, Math.min(data.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1))));
    }
    if (e.key === 'Escape') setSel(null);
  };
  const active = sel ?? highlight;

  const grow = (i, si) => (el) => first.current && drawIn(el, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }],
    { duration: 720, delay: i * 25 + si * 40, easing: SPRING });

  const bar = (x, y0, y1, fill, roundTop, i, si = 0, partial = false) => {
    const h = Math.max(0, y0 - y1);
    if (h <= 0.5) return null;
    const r = roundTop ? Math.min(4, bw / 2, h) : 0;
    const d = r
      ? `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + bw - r}Q${x + bw},${y1} ${x + bw},${y1 + r}V${y0}Z`
      : `M${x},${y0}V${y1}H${x + bw}V${y0}Z`;
    return html`<path d=${d} fill=${fill} class=${'bar-draw' + (partial ? ' is-partial' : '')} ref=${grow(i, si)} />`;
  };

  const ticks = [0, max / 2, max];
  const linePts = line ? lineVals.map((v, i) => [i * slot + slot / 2, y(v)]) : null;
  const dimmed = (c, dim) => (dim ? `color-mix(in srgb, ${c} 35%, transparent)` : c);
  const ro = showReadout && sel != null && data[sel] ? data[sel] : null;

  return html`<div class="chart barchart" ref=${ref} onPointerEnter=${(e) => e.pointerType === 'mouse' && setHover(true)} onPointerLeave=${() => setHover(false)}>
    <svg width=${w} height=${height} role="img" aria-label=${label} tabindex="0" onKeyDown=${onKey}
      onFocus=${() => setHover(true)} onBlur=${() => setHover(false)}
      style=${{ touchAction: 'pan-y' }} ...${handlers}>
      ${showReadout && sel != null && html`<rect class="chart-band" x=${sel * slot + 2} y=${padT - 4} width=${Math.max(0, slot - 4)} height=${plotH + 4} rx="6" />`}
      ${ticks.map((t) => html`<g>
        <line x1="0" x2=${plotW} y1=${y(t)} y2=${y(t)} class=${t === 0 ? 'axis-base' : 'axis-grid'} />
        <text x=${plotW + 6} y=${y(t) + 4} class="axis-label">${axisMoney(t)}</text>
      </g>`)}
      ${data.map((d, i) => {
        const x = i * slot + (slot - bw) / 2;
        // Only a real selection dims the other bars; `highlight` alone just bolds the label.
        const dim = sel != null && sel !== i;
        if (!stacked) return html`<g>${bar(x, y(0), y(Math.max(0, d.value)), dimmed(color, dim), true, i, 0, d.partial)}</g>`;
        let acc = 0;
        const segs = [];
        const lastIdx = d.values.map((v, k) => (v > 0 ? k : -1)).filter((k) => k >= 0).at(-1);
        d.values.forEach((v, si) => {
          if (v <= 0) return;
          const y0 = y(acc) - (acc > 0 ? 1 : 0);
          acc += v;
          const y1 = y(acc) + (si === lastIdx ? 0 : 1);
          segs.push(bar(x, y0, y1, dimmed(series[si].color, dim), si === lastIdx, i, si, d.partial));
        });
        return html`<g>${segs}</g>`;
      })}
      ${average != null && average > 0 && html`<line x1="0" x2=${plotW} y1=${y(average)} y2=${y(average)} class="axis-avg" />`}
      ${linePts && linePts.slice(1).map((p, k) => {
        // A segment that touches an incomplete period is dashed (it would otherwise "dive").
        const partial = data[k]?.partial || data[k + 1]?.partial;
        return html`<line x1=${linePts[k][0]} y1=${linePts[k][1]} x2=${p[0]} y2=${p[1]} class=${'chart-line-thin' + (partial ? ' is-partial' : '')} style=${{ stroke: line.color }} />`;
      })}
      ${linePts && linePts.map((p, i) => html`<circle cx=${p[0]} cy=${p[1]} r=${active === i ? 4 : 2.5} class=${'line-dot' + (data[i]?.partial ? ' is-partial' : '')} style=${{ fill: line.color }} />`)}
      ${data.map((d, i) => (data.length <= 14 || i % 2 === 0) && html`<text x=${i * slot + slot / 2} y=${height - 5}
        class=${'axis-label is-x' + (active === i ? ' is-active' : '')} text-anchor="middle">${d.short}</text>`)}
    </svg>
    ${ro && html`<${Readout} x=${sel * slot + slot / 2} width=${plotW} top=${-8}>
      <div class="ro-title">${ro.label}${ro.partial ? html`<span class="ro-note"> · nog niet compleet</span>` : ''}</div>
      ${stacked
        ? series.map((s, k) => html`<div class="ro-row"><i style=${{ background: s.color }}></i><span>${s.name}</span><b class="num">${valueFormat(ro.values[k])}</b></div>`)
        : html`<div class="ro-row"><b class="num">${valueFormat(ro.value)}</b></div>`}
      ${line && html`<div class="ro-row"><i class="is-line" style=${{ background: line.color }}></i><span>${line.name}</span><b class="num">${valueFormat(lineVals[sel])}</b></div>`}
      ${readoutExtra?.(sel)}
    </${Readout}>`}
    <table class="vh">
      <caption>${label}</caption>
      <tbody>${data.map((d, i) => html`<tr><th scope="row">${d.label}${d.partial ? ' (nog niet compleet)' : ''}</th>
        <td>${stacked ? d.values.map((v, k) => `${series[k].name} ${valueFormat(v)}`).join(', ') : valueFormat(d.value)}</td>
        ${line && html`<td>${line.name} ${valueFormat(lineVals[i])}</td>`}</tr>`)}</tbody>
    </table>
  </div>`;
}
