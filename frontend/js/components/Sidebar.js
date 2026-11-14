// Translucent sidebar (≥ 1000 px, DESIGN §5): destinations from routes.js — including
// Sorteren with a count badge while merchants wait — and Importeren / Instellingen at the
// bottom.
//
//   html`<${Sidebar} />`

import { html } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { useRoute } from '../router.js';
import { sidebar } from '../routes.js';
import { activeTab, goTab } from '../shell/tabs.js';
import { openImport } from '../shell/actions.js';
import { useStore } from '../store.js';
import { navigate } from '../router.js';

// Terugblik (#/terugblik) is registered in routes.js by the Terugblik work; the sidebar shows
// it below Jaaroverzicht even while routes.js does not list it yet.
const TERUGBLIK = { id: 'terugblik', label: 'Terugblik', icon: 'clock', path: '/terugblik', noFill: true };

export function Sidebar() {
  const route = useRoute();
  const active = activeTab(route);
  const name = useStore((s) => s.boot?.settings?.household_name);
  const unsorted = useStore((s) => s.boot?.unsorted_merchants || 0);
  const list = sidebar.some((s) => s.id === 'terugblik') ? sidebar : sidebar.flatMap((s) => (s.id === 'jaaroverzicht' ? [s, TERUGBLIK] : [s]));
  const main = list.filter((s) => !s.bottom && (s.badge !== 'unsorted' || unsorted > 0 || s.id === active));
  const bottom = sidebar.filter((s) => s.bottom);
  const item = (s) => {
    const on = s.id === active || (s.id === 'terugblik' && route.path.startsWith('/terugblik'));
    const go = () => (sidebar.some((x) => x.id === s.id) ? goTab(s.id) : navigate(s.path, { direction: 'tab' }));
    const n = s.badge === 'unsorted' ? unsorted : 0;
    return html`<li><button class=${'side-item' + (on ? ' is-active' : '')} aria-current=${on ? 'page' : null} onClick=${go}
        aria-label=${n ? `${s.label}, ${n} winkels zonder bakje` : null}>
      <${Icon} name=${on && !s.noFill ? s.icon + '-fill' : s.icon} size=${18} stroke=${1.8} />
      <span class="side-label">${s.label}</span>
      ${n > 0 && html`<span class="side-badge num" aria-hidden="true">${n}</span>`}
    </button></li>`;
  };
  return html`<nav class="sidebar" aria-label="Hoofdmenu">
    <div class="side-head">
      <img class="side-logo" src="icons/icon.svg" alt="" width="26" height="26" />
      <div class="side-title">Cents${name && html`<span class="side-sub">${name}</span>`}</div>
    </div>
    <ul class="side-list">${main.map(item)}</ul>
    <div class="side-foot">
      <ul class="side-list">
        <li><button class="side-item side-import" onClick=${() => openImport()}>
          <${Icon} name="import" size=${18} stroke=${1.9} /><span class="side-label">Importeren</span>
        </button></li>
        ${bottom.map(item)}
      </ul>
    </div>
  </nav>`;
}
