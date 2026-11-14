// "‹ november ›" pill. The label opens a month grid popover. `first`/`last` bound the range.
//
//   html`<${MonthSwitcher} value="2026-11" first="2025-06" last="2026-11" onChange=${setPeriod} />`

import { html } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { monthSmart, shiftPeriod, MONTHS_SHORT, monthLabel } from '../format.js';
import { openMenu } from './Menu.js';

export function MonthSwitcher({ value, first, last, onChange }) {
  const prev = shiftPeriod(value, -1);
  const next = shiftPeriod(value, 1);
  const canPrev = !first || prev >= first;
  const canNext = !last || next <= last;
  const openGrid = (e) => openMenu(e.currentTarget, {
    width: 288,
    render: (close) => html`<${MonthGrid} value=${value} first=${first} last=${last} onPick=${(p) => { close(); onChange(p); }} />`,
  });
  return html`<div class="monthswitch" role="group" aria-label="Maand">
    <button class="ms-arrow" disabled=${!canPrev} aria-label="Vorige maand" data-tip="Vorige maand (←)" onClick=${() => canPrev && onChange(prev)}>
      <${Icon} name="chevron-left" size=${17} stroke=${2.6} />
    </button>
    <button class="ms-label" onClick=${openGrid} aria-label=${'Kies maand, nu ' + monthLabel(value)}>${monthSmart(value)}</button>
    <button class="ms-arrow" disabled=${!canNext} aria-label="Volgende maand" data-tip="Volgende maand (→)" onClick=${() => canNext && onChange(next)}>
      <${Icon} name="chevron-right" size=${17} stroke=${2.6} />
    </button>
  </div>`;
}

function MonthGrid({ value, first, last, onPick }) {
  const years = [];
  const y0 = Number((first || value).slice(0, 4));
  const y1 = Number((last || value).slice(0, 4));
  for (let y = y1; y >= y0; y--) years.push(y);
  return html`<div class="month-grid">
    ${years.map((y) => html`<div class="mg-year">
      <div class="mg-year-label">${y}</div>
      <div class="mg-months">
        ${MONTHS_SHORT.map((m, i) => {
          const id = `${y}-${String(i + 1).padStart(2, '0')}`;
          const off = (first && id < first) || (last && id > last);
          return html`<button class=${'mg-month' + (id === value ? ' is-selected' : '')} disabled=${off}
            aria-label=${monthLabel(id)} onClick=${() => onPick(id)}>${m}</button>`;
        })}
      </div>
    </div>`)}
  </div>`;
}
