// The app shell: login gate, responsive chrome (tab bar / sidebar), outlet, sheet/menu/toast
// hosts and the whole-window file-drop overlay.

import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { useStore, setState, getState } from '../store.js';
import { api } from '../api.js';
import { useLayout, canHover } from '../hooks.js';
import { useRoute } from '../router.js';
import { Outlet } from './outlet.js';
import { TabBar } from '../components/TabBar.js';
import { Sidebar } from '../components/Sidebar.js';
import { SheetHost } from '../components/Sheet.js';
import { MenuHost } from '../components/Menu.js';
import { ToastHost } from '../components/Toast.js';
import { Icon } from '../icons.js';
import { Login } from '../screens/login.js';
import { openImport } from './actions.js';
import { installEdgeSwipe } from './edgeswipe.js';
import { installShortcuts } from './keys.js';
import { TooltipHost } from '../components/Tooltip.js';

export async function loadBoot() {
  const boot = await api.bootstrap();
  setState({ boot });
  return boot;
}

export function App() {
  const session = useStore((s) => s.session);
  const boot = useStore((s) => s.boot);
  const version = useStore((s) => s.dataVersion);

  useEffect(() => {
    if (session?.authenticated) loadBoot().catch(() => {});
  }, [session?.authenticated, version]);

  if (!session) return null; // index.html already paints the background; this lasts ~1 frame
  if (!session.authenticated) return html`<${Login} setup=${session.setup_required} />`;
  if (!boot) return html`<div class="boot-wait" aria-busy="true"></div>`;
  return html`<${Shell} />`;
}

function Shell() {
  const layout = useLayout();
  const route = useRoute();
  const wide = layout === 'wide';
  const cover = route.route.presentation === 'cover' && !wide; // on desktop Sorteren keeps the sidebar
  const showTabs = !wide && !cover;

  useEffect(() => { installEdgeSwipe(); return installShortcuts(); }, []);

  // Files dropped anywhere, or chosen from an empty state, go to the Import sheet.
  useEffect(() => {
    const on = (e) => openImport(e.detail.files);
    window.addEventListener('cents:import-files', on);
    return () => window.removeEventListener('cents:import-files', on);
  }, []);

  const chrome = cover ? 'has-nochrome' : wide ? 'has-sidebar' : 'has-tabbar';
  const skip = () => {
    const h = document.querySelector('.page:not([hidden]) h1');
    const target = h || document.getElementById('main');
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus();
  };
  return html`<div class=${'shell ' + chrome}>
    <button type="button" class="skip-link" onClick=${skip}>Naar de inhoud</button>
    ${wide && !cover && html`<${Sidebar} />`}
    <main class="main" id="main" tabindex="-1">
      <${Outlet} />
    </main>
    ${showTabs && html`<${TabBar} />`}
    <${SheetHost} />
    <${MenuHost} />
    <${ToastHost} />
    <${TooltipHost} />
    <${DropOverlay} />
  </div>`;
}

/** Whole-window drop target on devices with a pointer. Emits `cents:import-files`. */
function DropOverlay() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!canHover()) return;
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const reset = () => { depth = 0; setOver(false); };
    const enter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setOver(true); };
    // Safari reports relatedTarget null for every dragleave, Chrome only when the pointer
    // leaves the window; counting depth alone can get stuck, so null + outside the viewport resets.
    const leave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      const out = !e.relatedTarget && (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight);
      if (!depth || out) reset();
    };
    const overH = (e) => { if (!hasFiles(e)) return; e.preventDefault(); setOver(true); };
    const drop = (e) => {
      reset(); // always, also when a DropZone already handled it (defaultPrevented)
      if (!hasFiles(e)) return;
      const handled = e.defaultPrevented;
      e.preventDefault();
      if (handled) return;
      const files = [...e.dataTransfer.files];
      if (files.length && getState().session?.authenticated) {
        window.dispatchEvent(new CustomEvent('cents:import-files', { detail: { files } }));
      }
    };
    const vis = () => { if (document.hidden) reset(); };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overH);
    window.addEventListener('drop', drop);
    window.addEventListener('dragend', reset);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', vis);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overH);
      window.removeEventListener('drop', drop);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);
  if (!over) return null;
  return html`<div class="drop-overlay" aria-hidden="true">
    <div class="drop-card">
      <span class="drop-icon"><${Icon} name="import" size=${34} stroke=${1.8} /></span>
      <span class="drop-title">Laat los om te importeren</span>
    </div>
  </div>`;
}
