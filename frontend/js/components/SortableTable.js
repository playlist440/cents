// Sort and filter for the app's small tables (Overzicht "Waar het heen ging", Jaaroverzicht
// bakjes, Terugblik bakjes, Vaste lasten). One column definition drives the Mac column headers,
// the phone's "Sorteer" menu and the filter field; the choice is remembered per table.
//
//   const cols = [{ key: 'name', label: 'Bakje', value: (r) => r.name },
//                 { key: 'cents', label: 'Bedrag', value: (r) => r.cents, num: true, desc: true }];
//   const t = useTable('ov-where', cols, { key: 'cents', dir: -1 });
//   t.rows(list)                      // filtered and sorted
//   html`<${SortHead} t=${t} col=${cols[1]} />`      // Mac header cell
//   html`<${TableTools} t=${t} />`                    // filter field (+ Sorteer on the phone)

import { html, useState } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { openMenu } from './Menu.js';

const KEY = (id) => `cents.sort.${id}`;

function load(id, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(id)) || 'null');
    if (v && typeof v.key === 'string' && (v.dir === 1 || v.dir === -1)) return v;
  } catch { /* storage blocked: use the default */ }
  return fallback;
}

/** Sort state (remembered), filter text, and `rows()` that applies both. */
export function useTable(id, cols, initial) {
  const [sort, setSortState] = useState(() => {
    const s = load(id, initial);
    return cols.some((c) => c.key === s.key) ? s : initial;
  });
  const [filter, setFilter] = useState('');
  const setSort = (s) => {
    setSortState(s);
    try { localStorage.setItem(KEY(id), JSON.stringify(s)); } catch { /* not remembered */ }
  };
  const col = cols.find((c) => c.key === sort.key) || cols[0];
  const rows = (list) => {
    const q = filter.trim().toLowerCase();
    const shown = q ? list.filter((r) => cols.some((c) => String(c.text ? c.text(r) : c.value(r) ?? '').toLowerCase().includes(q))) : list;
    return [...shown].sort((a, b) => {
      const x = col.value(a);
      const y = col.value(b);
      const d = typeof x === 'string' || typeof y === 'string'
        ? String(x ?? '').localeCompare(String(y ?? ''), 'nl', { sensitivity: 'base' })
        : (x ?? -Infinity) - (y ?? -Infinity);
      return d * sort.dir;
    });
  };
  /** Click on a column: its natural order first (numbers high to low), again to reverse. */
  const toggle = (c) => setSort(sort.key === c.key ? { key: c.key, dir: -sort.dir } : { key: c.key, dir: c.num || c.desc ? -1 : 1 });
  return { id, cols, sort, setSort, toggle, filter, setFilter, rows, initial };
}

/** A column header that sorts (Mac tables). */
export function SortHead({ t, col, class: cls = '' }) {
  const on = t.sort.key === col.key;
  const down = t.sort.dir < 0;
  return html`<button role="columnheader" class=${'st-sort ' + cls + (col.num ? ' is-num' : '') + (on ? ' is-on' : '')}
      aria-sort=${on ? (down ? 'descending' : 'ascending') : 'none'} onClick=${() => t.toggle(col)}
      aria-label=${`Sorteer op ${col.label.toLowerCase()}`}>
    <span>${col.label}</span>${on && html`<${Icon} name=${down ? 'chevron-down' : 'chevron-up'} size=${11} stroke=${2.6} />`}
  </button>`;
}

function sortName(c, dir) {
  if (c.num) return `${c.label}: ${dir < 0 ? 'hoog naar laag' : 'laag naar hoog'}`;
  return `${c.label}: ${dir < 0 ? 'Z–A' : 'A–Z'}`;
}

/** Filter field, and on the phone (`menu`) a "Sorteer" button with every column both ways. */
export function TableTools({ t, menu = false, placeholder = 'Filter' }) {
  const openSort = (e) => openMenu(e.currentTarget, t.cols.flatMap((c) => [-1, 1].map((dir) => ({
    label: sortName(c, dir), checked: t.sort.key === c.key && t.sort.dir === dir, onSelect: () => t.setSort({ key: c.key, dir }),
  }))));
  const cur = t.cols.find((c) => c.key === t.sort.key);
  return html`<div class="st-tools">
    <label class="st-filter">
      <${Icon} name="search" size=${13} stroke=${2.4} />
      <input type="search" value=${t.filter} placeholder=${placeholder} aria-label=${placeholder}
        onInput=${(e) => t.setFilter(e.currentTarget.value)} />
    </label>
    ${menu && html`<button class="st-sortbtn" onClick=${openSort} aria-haspopup="true" aria-label=${`Sorteer, nu ${cur ? sortName(cur, t.sort.dir) : ''}`}>
      <${Icon} name="chevron-up-down" size=${13} stroke=${2.4} /><span>${cur ? sortName(cur, t.sort.dir) : 'Sorteer'}</span>
    </button>`}
  </div>`;
}
