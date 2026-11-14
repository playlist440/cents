// Boot: choose real API or mock, start the router, render the app, check the session.

import { html, render } from './vendor/preact-htm.js';
import { api, setTransport, setUnauthorizedHandler } from './api.js';
import { setState, getState, invalidate } from './store.js';
import { initRouter } from './router.js';
import { routes } from './routes.js';
import { App } from './shell/app.js';
import { isStandalone } from './hooks.js';

const params = new URLSearchParams(location.search);

async function chooseTransport() {
  let mock = params.get('mock');
  if (mock === null) {
    try {
      const res = await fetch('/api/session', { credentials: 'same-origin' });
      if (res.status === 404) mock = '1'; // plain static file server: no backend
    } catch { /* offline: stay on the real API, it will report the error */ }
  }
  if (mock !== null) {
    const { createMockHandler } = await import('./mock/mock.js');
    setTransport(createMockHandler({ state: mock, latency: params.get('latency') }));
    setState({ mock: true });
  }
}

function environment() {
  const root = document.documentElement;
  root.dataset.standalone = String(isStandalone());
  // iOS only fires :active on elements when a touch listener exists (the CSP blocks the
  // inline ontouchstart attribute in index.html, so register one here).
  document.addEventListener('touchstart', () => {}, { passive: true });
  const theme = params.get('theme');
  if (theme === 'dark' || theme === 'light') root.dataset.theme = theme;
  // Keyboard height for sheets (iOS standalone does not resize the layout viewport).
  const vv = window.visualViewport;
  if (vv) {
    const onVV = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--kb', (kb > 60 ? kb : 0) + 'px');
    };
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
  }
  // Refetch when the app comes back after a while (another device may have imported).
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 60000 && getState().session?.authenticated) invalidate();
  });
}

async function start() {
  environment();
  await chooseTransport();
  setUnauthorizedHandler(() => setState((s) => ({ session: { ...(s.session || {}), authenticated: false }, boot: null })));
  initRouter(routes, { fallback: '/overzicht' });
  render(html`<${App} />`, document.getElementById('app'));
  try {
    setState({ session: await api.session() });
  } catch (err) {
    setState({ session: { authenticated: false, setup_required: false, version: '', error: err.message } });
  }
}

start();
