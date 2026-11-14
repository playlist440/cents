// Bottom tab bar (< 1000 px). Tabs come from routes.js. Tapping another tab returns to where
// you were in it; tapping the active tab pops to its root, or scrolls to the top.
//
//   html`<${TabBar} />`

import { html } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { useRoute } from '../router.js';
import { tabs } from '../routes.js';
import { activeTab, goTab } from '../shell/tabs.js';

export function TabBar() {
  const route = useRoute();
  const active = activeTab(route);
  return html`<nav class="tabbar" aria-label="Hoofdmenu">
    <div class="tabbar-inner">
      ${tabs.map((t) => {
        const on = t.id === active;
        return html`<button class=${'tab' + (on ? ' is-active' : '')} aria-current=${on ? 'page' : null}
          onClick=${() => goTab(t.id)}>
          <span class="tab-icon">
            <${Icon} name=${on ? t.icon + '-fill' : t.icon} size=${26} stroke=${1.7} />
          </span>
          <span class="tab-label">${t.label}</span>
        </button>`;
      })}
    </div>
  </nav>`;
}
