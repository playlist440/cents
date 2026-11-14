// Tooltips for icon-only buttons on pointer devices (macOS style: appear after a short rest,
// below the control, disappear on click, scroll or key press). Any element with `data-tip`
// gets one; NavButton, the toolbar and the month switcher set it.
//
//   html`<button aria-label="Vorige maand" data-tip="Vorige maand (←)">…</button>`

import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { canHover } from '../hooks.js';

export function TooltipHost() {
  const [tip, setTip] = useState(null);
  useEffect(() => {
    if (!canHover()) return undefined;
    let timer = 0;
    let current = null;
    let warm = 0; // after one tooltip, neighbours show faster (like macOS)
    const hide = () => { clearTimeout(timer); current = null; setTip(null); };
    const over = (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (el === current) return;
      clearTimeout(timer);
      current = el;
      if (!el) { setTip(null); return; }
      const delay = Date.now() - warm < 800 ? 80 : 650;
      timer = setTimeout(() => {
        if (!el.isConnected || el.disabled) return;
        const r = el.getBoundingClientRect();
        setTip({ text: el.dataset.tip, x: r.left + r.width / 2, y: r.bottom + 6, top: r.top });
        warm = Date.now();
      }, delay);
    };
    const out = (e) => { if (current && !current.contains(e.relatedTarget)) { if (tipShown()) warm = Date.now(); hide(); } };
    const tipShown = () => !!document.querySelector('.tooltip');
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    window.addEventListener('scroll', hide, { passive: true, capture: true });
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('scroll', hide, { capture: true });
    };
  }, []);
  if (!tip) return null;
  const below = tip.y + 30 < window.innerHeight;
  const style = { left: Math.max(8, Math.min(window.innerWidth - 8, tip.x)) + 'px', top: (below ? tip.y : tip.top - 30) + 'px' };
  return html`<div class="tooltip" role="tooltip" style=${style}>${tip.text}</div>`;
}
