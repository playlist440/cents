// Inline SVG icons in an SF-Symbols-like line style: 24×24 grid, stroke 1.75, round caps.
// Usage: html`<${Icon} name="plus" size=${22} />`. Tab icons have a "-fill" variant.

import { html } from './vendor/preact-htm.js';

// Factories, not shared vnodes: Preact mutates vnodes, so each render needs fresh ones.
const S = (d) => () => html`<path d=${d} />`;

function gearPath() {
  // 8 rounded teeth around a ring
  const pts = [];
  const teeth = 8;
  for (let i = 0; i < teeth * 4; i++) {
    const a = (i / (teeth * 4)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 4 === 0 || i % 4 === 1 ? 9 : 7;
    pts.push([12 + r * Math.cos(a + Math.PI / (teeth * 4)), 12 + r * Math.sin(a + Math.PI / (teeth * 4))]);
  }
  return 'M' + pts.map((p) => p.map((n) => n.toFixed(2)).join(' ')).join('L') + 'Z';
}
const GEAR = gearPath();

const ICONS = {
  'chevron-left': S('M15 4.5 7.5 12l7.5 7.5'),
  'chevron-right': S('M9 4.5 16.5 12 9 19.5'),
  'chevron-down': S('M5 9l7 7 7-7'),
  'chevron-up': S('M5 15l7-7 7 7'),
  'chevron-up-down': S('M8 9.5l4-4 4 4M8 14.5l4 4 4-4'),
  plus: S('M12 5v14M5 12h14'),
  minus: S('M5 12h14'),
  xmark: S('M6.5 6.5l11 11M17.5 6.5l-11 11'),
  check: S('M5 12.5l4.5 4.5L19 7.5'),
  search: () => html`<circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.4 15.4 20 20" />`,
  ellipsis: () => html`<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none" />`,

  /* Tabs and sidebar */
  overzicht: () => html`<rect x="3.5" y="3.5" width="7.3" height="7.3" rx="2.2" /><rect x="13.2" y="3.5" width="7.3" height="7.3" rx="2.2" /><rect x="3.5" y="13.2" width="7.3" height="7.3" rx="2.2" /><rect x="13.2" y="13.2" width="7.3" height="7.3" rx="2.2" />`,
  'overzicht-fill': () => html`<g fill="currentColor" stroke="none"><rect x="3" y="3" width="8.2" height="8.2" rx="2.4" /><rect x="12.8" y="3" width="8.2" height="8.2" rx="2.4" /><rect x="3" y="12.8" width="8.2" height="8.2" rx="2.4" /><rect x="12.8" y="12.8" width="8.2" height="8.2" rx="2.4" /></g>`,
  transacties: () => html`<rect x="3.5" y="4" width="17" height="16" rx="3.5" /><path d="M7.5 9h9M7.5 12.5h9M7.5 16h5.5" />`,
  'transacties-fill': () => html`<defs><mask id="m-tx"><rect width="24" height="24" fill="#fff" /><path d="M7.5 9h9M7.5 12.5h9M7.5 16h5.5" stroke="#000" stroke-width="1.9" stroke-linecap="round" /></mask></defs><rect x="2.8" y="3.3" width="18.4" height="17.4" rx="4" fill="currentColor" stroke="none" mask="url(#m-tx)" />`,
  potjes: () => html`<rect x="6.5" y="2.8" width="11" height="3.4" rx="1.3" /><path d="M8 6.2C6.2 7.4 5 9.4 5 11.8v4.7A3.7 3.7 0 0 0 8.7 20.2h6.6a3.7 3.7 0 0 0 3.7-3.7v-4.7c0-2.4-1.2-4.4-3-5.6" /><path d="M5.2 12.6c2.3-1 4.6.9 6.8 0s4.6-1 6.8 0" />`,
  'potjes-fill': () => html`<rect x="6.2" y="2.4" width="11.6" height="3.6" rx="1.4" fill="currentColor" stroke="none" /><path d="M8 6.2C6.2 7.4 5 9.4 5 11.8v4.7A3.7 3.7 0 0 0 8.7 20.2h6.6a3.7 3.7 0 0 0 3.7-3.7v-4.7c0-2.4-1.2-4.4-3-5.6" /><path d="M5 12.8c2.3-1 4.6.9 7 0s4.7-1 7 0v3.7a3.7 3.7 0 0 1-3.7 3.7H8.7A3.7 3.7 0 0 1 5 16.5z" fill="currentColor" />`,
  vermogen: () => html`<path d="M3.5 9.2 12 4l8.5 5.2z" /><path d="M6 11.5v5.5M10 11.5v5.5M14 11.5v5.5M18 11.5v5.5M3.5 20h17" />`,
  'vermogen-fill': () => html`<path d="M2.9 9.6 12 3.6l9.1 6z" fill="currentColor" /><path d="M6 11.6v5.4M10 11.6v5.4M14 11.6v5.4M18 11.6v5.4" stroke-width="2.3" /><path d="M3 20h18" stroke-width="2.3" />`,
  meer: () => html`<circle cx="12" cy="12" r="8.75" /><circle cx="7.9" cy="12" r="1.15" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" /><circle cx="16.1" cy="12" r="1.15" fill="currentColor" stroke="none" />`,
  'meer-fill': () => html`<defs><mask id="m-meer"><rect width="24" height="24" fill="#fff" /><circle cx="7.9" cy="12" r="1.35" fill="#000" /><circle cx="12" cy="12" r="1.35" fill="#000" /><circle cx="16.1" cy="12" r="1.35" fill="#000" /></mask></defs><circle cx="12" cy="12" r="9.6" fill="currentColor" stroke="none" mask="url(#m-meer)" />`,
  'vaste-lasten': () => html`<rect x="3.5" y="5" width="17" height="15" rx="3.2" /><path d="M3.5 9.8h17M8 3v4M16 3v4" /><path d="M9.2 14.6a2.8 2.8 0 1 0 2.8-2.8h-.5" /><path d="m10.7 10.8 1 1-1 1" />`,
  'vaste-lasten-fill': () => html`<defs><mask id="m-vl"><rect width="24" height="24" fill="#fff" /><path d="M9.2 14.6a2.8 2.8 0 1 0 2.8-2.8h-.5M10.7 10.8l1 1-1 1" stroke="#000" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" /></mask></defs><path d="M8 3v4M16 3v4" /><rect x="3" y="5" width="18" height="15.6" rx="3.4" fill="currentColor" stroke="none" mask="url(#m-vl)" />`,
  jaaroverzicht: () => html`<rect x="4" y="12" width="3.6" height="8" rx="1.2" /><rect x="10.2" y="5" width="3.6" height="15" rx="1.2" /><rect x="16.4" y="9" width="3.6" height="11" rx="1.2" />`,
  'jaaroverzicht-fill': () => html`<g fill="currentColor"><rect x="4" y="12" width="3.6" height="8" rx="1.2" /><rect x="10.2" y="5" width="3.6" height="15" rx="1.2" /><rect x="16.4" y="9" width="3.6" height="11" rx="1.2" /></g>`,
  tag: () => html`<path d="M3.5 12V5.2c0-.95.75-1.7 1.7-1.7H12c.45 0 .88.18 1.2.5l7.1 7.1c.66.66.66 1.74 0 2.4l-6.8 6.8c-.66.66-1.74.66-2.4 0l-7.1-7.1c-.32-.32-.5-.75-.5-1.2z" /><circle cx="8.2" cy="8.2" r="1.4" />`,
  'tag-fill': () => html`<defs><mask id="m-tag"><rect width="24" height="24" fill="#fff" /><circle cx="8.2" cy="8.2" r="1.6" fill="#000" /></mask></defs><path d="M3.5 12V5.2c0-.95.75-1.7 1.7-1.7H12c.45 0 .88.18 1.2.5l7.1 7.1c.66.66.66 1.74 0 2.4l-6.8 6.8c-.66.66-1.74.66-2.4 0l-7.1-7.1c-.32-.32-.5-.75-.5-1.2z" fill="currentColor" mask="url(#m-tag)" />`,
  instellingen: () => html`<path d=${GEAR} /><circle cx="12" cy="12" r="3" />`,
  'instellingen-fill': () => html`<defs><mask id="m-gear"><rect width="24" height="24" fill="#fff" /><circle cx="12" cy="12" r="3.1" fill="#000" /></mask></defs><path d=${GEAR} fill="currentColor" mask="url(#m-gear)" />`,
  sorteren: () => html`<rect x="3.5" y="8" width="17" height="12.5" rx="3" /><path d="M6.5 5h11M8.5 2.5h7" />`,
  'sorteren-fill': () => html`<rect x="3" y="7.6" width="18" height="13.2" rx="3.2" fill="currentColor" stroke="none" /><path d="M6.5 4.8h11M8.5 2.3h7" />`,
  import: () => html`<path d="M12 3.5v10.5M7.8 9.8 12 14l4.2-4.2" /><path d="M4 13.5v2.8A3.7 3.7 0 0 0 7.7 20h8.6a3.7 3.7 0 0 0 3.7-3.7v-2.8" />`,
  bakjes: () => html`<path d="M4 9.5h16l-1.3 8.2a2.6 2.6 0 0 1-2.6 2.3H7.9a2.6 2.6 0 0 1-2.6-2.3z" /><path d="M8 9.5 10 4M16 9.5 14 4" />`,

  /* Actions and objects */
  trash: () => html`<path d="M4.5 6.5h15M9.5 6.5V4.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3v1.7M6.5 6.5l.9 12a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8l.9-12" />`,
  pencil: () => html`<path d="M15.6 4.6a2 2 0 0 1 2.8 0l1 1a2 2 0 0 1 0 2.8L9 18.8 4.5 19.5l.7-4.5z" /><path d="m14 6.2 3.8 3.8" />`,
  undo: () => html`<path d="M9 14 4.5 9.5 9 5" /><path d="M4.5 9.5h10a5 5 0 0 1 0 10h-3" />`,
  copy: () => html`<rect x="8.5" y="8.5" width="12" height="12" rx="2.6" /><path d="M15.5 8.5V6.1a2.6 2.6 0 0 0-2.6-2.6H6.1a2.6 2.6 0 0 0-2.6 2.6v6.8a2.6 2.6 0 0 0 2.6 2.6h2.4" />`,
  doc: () => html`<path d="M6 3.5h7.5L19 9v9.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z" /><path d="M13.5 3.5V9H19" />`,
  person: () => html`<circle cx="12" cy="8" r="3.8" /><path d="M4.5 20c.8-3.6 3.8-5.8 7.5-5.8s6.7 2.2 7.5 5.8" />`,
  sparkles: () => html`<path d="M10 3.5c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6z" /><path d="M18 14.5c.3 1.6 1 2.3 2.5 2.5-1.6.3-2.3 1-2.5 2.5-.3-1.6-1-2.3-2.5-2.5 1.6-.3 2.3-1 2.5-2.5z" />`,
  lock: () => html`<rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />`,
  creditcard: () => html`<rect x="3" y="5.5" width="18" height="13" rx="2.8" /><path d="M3 10h18M6.5 15h4" />`,
  wallet: () => html`<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" /><path d="M20 10h-4.2a2 2 0 0 0 0 4H20" />`,
  arrow: () => html`<path d="M5 12h14M13 6l6 6-6 6" />`,
  'arrow-up-right': () => html`<path d="M7 17 17 7M8.5 7H17v8.5" />`,
  info: () => html`<circle cx="12" cy="12" r="8.75" /><path d="M12 11v5.5" /><circle cx="12" cy="7.8" r="1.05" fill="currentColor" stroke="none" />`,
  warning: () => html`<path d="M10.3 4.5a2 2 0 0 1 3.4 0l7 12.1a2 2 0 0 1-1.7 3H5a2 2 0 0 1-1.7-3z" /><path d="M12 9.5v4" /><circle cx="12" cy="16.6" r="1" fill="currentColor" stroke="none" />`,
  logout: () => html`<path d="M14.5 4.5h-7a2.5 2.5 0 0 0-2.5 2.5v10a2.5 2.5 0 0 0 2.5 2.5h7" /><path d="M10.5 12H20M16.5 8.5 20 12l-3.5 3.5" />`,
  filter: () => html`<path d="M4 7h16M7 12h10M10 17h4" />`,
  calendar: () => html`<rect x="3.5" y="5" width="17" height="15" rx="3.2" /><path d="M3.5 9.8h17M8 3v4M16 3v4" />`,
  euro: () => html`<path d="M17.5 6.4A6.5 6.5 0 1 0 17.5 17.6M4.5 10.2h8.5M4.5 13.8h8.5" />`,
  piggy: () => html`<path d="M5.5 11.5c0-3.3 3-6 6.8-6 1.2 0 2.3.2 3.3.7l2.4-1.2-.6 2.7c.9.9 1.5 2 1.7 3.2h1.4v3.4h-1.6c-.5 1.1-1.3 2-2.3 2.7V20h-2.8v-1.9c-.5.1-1 .1-1.5.1s-1.1 0-1.6-.1V20H6v-3.1c-.3-.3-.6-.6-.8-1H3.5v-3.6h2.1z" />`,
  key: () => html`<circle cx="8" cy="15" r="4" /><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2" />`,
  clock: () => html`<circle cx="12" cy="12" r="8.75" /><path d="M12 7.5V12l3 2" />`,
  sidebar: () => html`<rect x="3" y="4.5" width="18" height="15" rx="3" /><path d="M9.5 4.5v15M5.5 8.5h1.5M5.5 11.5h1.5" />`,
  share: () => html`<path d="M12 14.5V3.5M8 7.5l4-4 4 4" /><path d="M8 10.5H7a2.5 2.5 0 0 0-2.5 2.5v5A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-5a2.5 2.5 0 0 0-2.5-2.5h-1" />`,
};

export const iconNames = Object.keys(ICONS);

export function Icon({ name, size = 24, stroke = 1.75, class: cls = '', label }) {
  const body = (ICONS[name] || ICONS.info)();
  return html`<svg class=${'icon ' + cls} width=${size} height=${size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width=${stroke} stroke-linecap="round" stroke-linejoin="round"
    role=${label ? 'img' : null} aria-label=${label || null} aria-hidden=${label ? null : 'true'} focusable="false">${body}</svg>`;
}
