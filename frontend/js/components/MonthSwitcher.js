// "‹ november ›" pill. The label opens a month grid popover. `first`/`last` bound the range.
// With `years` the value may also be a year ("2026") and the popover gets a Maand / Jaar
// switch; ‹ › then step through years.
//
//   html`<${MonthSwitcher} value="2026-11" first="2025-06" last="2026-11" onChange=${setPeriod} />`
//   html`<${MonthSwitcher} value="2026" first="2025-06" last="2026-11" years onChange=${setPeriod} />`

import { html, useState } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { monthSmart, shiftPeriod, MONTHS_SHORT, monthLabel, todayISO } from '../format.js';
import { openMenu } from './Menu.js';
import { Segmented } from './Controls.js';

export const isYear = (id) => /^\d{4}$/.test(id || '');

/** The neighbour of a month or year id, or null outside [first, last]. */
export function stepPeriod(value, n, first, last) {
  if (isYear(value)) {
    const y = String(Number(value) + n);
    return (!first || y >= first.slice(0, 4)) && (!last || y <= last.slice(0, 4)) ? y : null;
  }
  const p = shiftPeriod(value, n);
  return (!first || p >= first) && (!last || p <= last) ? p : null;
}

/** "2026 tot nu" for the running year, "2025" for a finished one. */
export function yearLabel(y, today = todayISO()) {
  return y === today.slice(0, 4) ? `${y} tot nu` : y;
}

export function MonthSwitcher({ value, first, last, onChange, years = false }) {
  const year = isYear(value);
  const prev = stepPeriod(value, -1, first, last);
  const next = stepPeriod(value, 1, first, last);
  const unit = year ? 'jaar' : 'maand';
  const openGrid = (e) => openMenu(e.currentTarget, {
    width: 288,
    render: (close) => html`<${PeriodPicker} value=${value} first=${first} last=${last} years=${years} onPick=${(p) => { close(); onChange(p); }} />`,
  });
  const text = year ? yearLabel(value) : monthSmart(value);
  return html`<div class="monthswitch" role="group" aria-label=${year ? 'Jaar' : 'Maand'}>
    <button class="ms-arrow" disabled=${!prev} aria-label=${`Vorig${year ? '' : 'e'} ${unit}`} data-tip=${`Vorig${year ? '' : 'e'} ${unit} (←)`} onClick=${() => prev && onChange(prev)}>
      <${Icon} name="chevron-left" size=${17} stroke=${2.6} />
    </button>
    <button class="ms-label" onClick=${openGrid} aria-haspopup="dialog"
      aria-label=${(years ? 'Kies maand of jaar, nu ' : 'Kies maand, nu ') + (year ? text : monthLabel(value))}>${text}</button>
    <button class="ms-arrow" disabled=${!next} aria-label=${'Volgend' + (year ? ' ' : 'e ') + unit} data-tip=${`Volgend${year ? '' : 'e'} ${unit} (→)`} onClick=${() => next && onChange(next)}>
      <${Icon} name="chevron-right" size=${17} stroke=${2.6} />
    </button>
  </div>`;
}

function PeriodPicker({ value, first, last, years, onPick }) {
  const [mode, setMode] = useState(isYear(value) ? 'jaar' : 'maand');
  if (!years) return html`<${MonthGrid} value=${value} first=${first} last=${last} onPick=${onPick} />`;
  return html`<div class="period-picker">
    <div class="pp-seg"><${Segmented} value=${mode} onChange=${setMode} label="Maand of jaar" size="small"
      options=${[['maand', 'Maand'], ['jaar', 'Jaar']]} /></div>
    ${mode === 'maand'
      ? html`<${MonthGrid} value=${value} first=${first} last=${last} onPick=${onPick} />`
      : html`<${YearList} value=${value} first=${first} last=${last} onPick=${onPick} />`}
  </div>`;
}

function YearList({ value, first, last, onPick }) {
  const list = [];
  const y0 = Number((first || last || value).slice(0, 4));
  const y1 = Number((last || value).slice(0, 4));
  for (let y = y1; y >= y0; y--) list.push(String(y));
  const now = todayISO().slice(0, 4);
  return html`<div class="year-list" role="list">
    ${list.map((y) => html`<button key=${y} role="listitem" class=${'yl-year' + (y === value ? ' is-selected' : '')}
        aria-label=${y === now ? `${y}, tot nu` : y} aria-current=${y === value ? 'true' : undefined} onClick=${() => onPick(y)}>
      <span class="yl-name">${y}</span>
      <span class="yl-sub">${y === now ? 'tot nu' : 'heel jaar'}</span>
    </button>`)}
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
