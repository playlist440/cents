// Sheets. Open one from anywhere with openSheet(Component, props) (router.js); the component
// renders <Sheet> as its root and receives `close`:
//
//   function EditSheet({ close }) {
//     return html`<${Sheet} title="Wijzig" trailing=${html`<${SheetButton} bold onClick=${close}>Klaar</${SheetButton}>`}>…</${Sheet}>`;
//   }
//
// iPhone (< 700 px): bottom sheet with grabber, detents ('fit' | ['medium','large']), drag to
// dismiss with rubber banding and velocity, keyboard avoidance (--kb). ≥ 700 px: centred card.
// The body behind is scroll-locked; Escape and the back gesture close the top sheet.

import { html, createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-htm.js';
import { useSheets, closeSheet, removeSheet } from '../router.js';
import { lockScroll, unlockScroll } from '../scroll.js';
import { useMedia, reducedMotion, useId } from '../hooks.js';
import { Icon } from '../icons.js';

const SheetCtx = createContext(null);

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]):not(.vh), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SheetHost() {
  const sheets = useSheets();
  // While a sheet is open the app behind it is inert (no focus, no clicks, hidden from AT).
  const anyOpen = sheets.some((s) => !s.closing);
  useEffect(() => {
    for (const el of document.querySelectorAll('.shell > .main, .shell > .sidebar, .shell > .tabbar, .shell > .skip-link')) {
      if (anyOpen) el.setAttribute('inert', ''); else el.removeAttribute('inert');
    }
  }, [anyOpen]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const top = [...sheets].reverse().find((s) => !s.closing);
      if (top) { e.preventDefault(); closeSheet(top.id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheets]);
  return html`<div class="sheet-host">
    ${sheets.map((s, i) => html`<${SheetCtx.Provider} key=${s.id}
        value=${{ id: s.id, closing: s.closing, depth: i, close: () => closeSheet(s.id), onClosed: () => removeSheet(s.id) }}>
      <${s.Component} ...${s.props} close=${() => closeSheet(s.id)} />
    </${SheetCtx.Provider}>`)}
  </div>`;
}

/** Text button for sheet headers ("Annuleer", bold "Klaar"). */
export function SheetButton({ bold = false, onClick, disabled, children, ...rest }) {
  return html`<button type="button" class=${'sheet-btn' + (bold ? ' is-bold' : '')} onClick=${onClick} disabled=${disabled} ...${rest}>${children}</button>`;
}

const CLOSE_MS = 280;

export function Sheet({ title, leading, trailing, detents = 'fit', children, class: cls = '', label, hideHeader = false }) {
  const ctx = useContext(SheetCtx) || { closing: false, close() {}, onClosed() {} };
  const desktop = useMedia('(min-width: 700px)');
  const mac = useMedia('(min-width: 1000px)');
  // Mac: the leading/trailing text buttons become a button pair at the bottom right.
  const footer = mac && ((leading != null && leading !== false) || (trailing != null && trailing !== false));
  const panel = useRef(null);
  const body = useRef(null);
  const scrim = useRef(null);
  const titleId = useId('sheet');
  const [detent, setDetent] = useState(Array.isArray(detents) ? detents[0] : 'fit');
  const geo = useRef({ offset: 0, H: 0 });
  const prevFocus = useRef(null);

  // Lock scroll for the lifetime of the sheet.
  useEffect(() => {
    lockScroll();
    prevFocus.current = document.activeElement;
    return () => { unlockScroll(); prevFocus.current?.focus?.({ preventScroll: true }); };
  }, []);

  const offsetFor = (d) => {
    const el = panel.current;
    if (!el || desktop) return 0;
    const H = el.offsetHeight;
    geo.current.H = H;
    if (d === 'medium') return Math.max(0, H - Math.round(window.innerHeight * 0.56));
    return 0;
  };

  const apply = (offset, animate, curve = 'var(--ease-ios)', ms = 460) => {
    const el = panel.current;
    if (!el) return;
    geo.current.offset = offset;
    el.style.transition = animate ? `transform ${ms}ms ${curve}` : 'none';
    el.style.transform = desktop ? '' : `translate3d(0, ${offset}px, 0)`;
    if (scrim.current) {
      const H = geo.current.H || 1;
      const base = offsetFor(detent);
      const o = offset <= base ? 1 : Math.max(0, 1 - (offset - base) / Math.max(1, H - base));
      scrim.current.style.transition = animate ? `opacity ${ms}ms linear` : 'none';
      scrim.current.style.opacity = String(o);
    }
  };

  // Present.
  useLayoutEffect(() => {
    const el = panel.current;
    if (desktop) {
      el.classList.add('is-presenting');
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('is-presenting')));
      scrim.current.style.opacity = '1';
    } else {
      const H = el.offsetHeight;
      geo.current.H = H;
      apply(H + 20, false);
      el.getBoundingClientRect();
      apply(offsetFor(detent), true, 'var(--ease-ios)', reducedMotion() ? 1 : 460);
    }
    // Desktop: focus the first control (a field when there is one); phone: the panel, so the
    // keyboard does not jump up uninvited.
    const first = desktop && (el.querySelector('.sheet-body input:not(.vh), .sheet-body textarea, .sheet-body select') || el.querySelector(`.sheet-body ${FOCUSABLE.split(', ').join(', .sheet-body ')}`));
    (first || el).focus({ preventScroll: true });
  }, []);

  // Keep Tab / Shift-Tab inside the sheet.
  const onKeyDown = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...panel.current.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (!items.length) { e.preventDefault(); return; }
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === panel.current)) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  };

  // Dismiss when the host marks us closing.
  useEffect(() => {
    if (!ctx.closing) return;
    const el = panel.current;
    if (desktop) {
      el.classList.add('is-dismissing');
      scrim.current.style.transition = `opacity ${CLOSE_MS}ms linear`;
      scrim.current.style.opacity = '0';
    } else {
      apply((geo.current.H || el.offsetHeight) + 30, true, 'var(--ease-in)', CLOSE_MS);
    }
    const t = setTimeout(ctx.onClosed, reducedMotion() ? 10 : CLOSE_MS);
    return () => clearTimeout(t);
  }, [ctx.closing]);

  // Re-snap when the detent changes (e.g. a text field asks for 'large').
  useEffect(() => { if (!ctx.closing) apply(offsetFor(detent), true); }, [detent, desktop]);

  // Keyboard: promote to the large detent and keep the focused field visible.
  const onFocusIn = (e) => {
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (Array.isArray(detents) && detents.includes('large')) setDetent('large');
    setTimeout(() => e.target.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 320);
  };

  /* ---------- Dragging (compact only) ---------- */
  const drag = useRef(null);
  const detentList = Array.isArray(detents) ? detents : ['fit'];

  const start = (y) => {
    drag.current = { y0: y, off0: geo.current.offset, lastY: y, lastT: performance.now(), v: 0 };
  };
  const move = (y) => {
    const d = drag.current;
    if (!d) return;
    const now = performance.now();
    d.v = (y - d.lastY) / Math.max(1, now - d.lastT);
    d.lastY = y; d.lastT = now;
    let off = d.off0 + (y - d.y0);
    if (off < 0) off = -Math.sqrt(-off) * 3; // rubber band above the top detent
    apply(off, false);
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const off = geo.current.offset;
    const projected = off + d.v * 160;
    const stops = detentList.map((x) => [x, offsetFor(x)]);
    const lowest = Math.max(...stops.map(([, o]) => o));
    const H = geo.current.H;
    if (projected > lowest + (H - lowest) * 0.35 || (d.v > 0.9 && off > lowest - 10)) { ctx.close(); return; }
    let best = stops[0];
    for (const s of stops) if (Math.abs(s[1] - projected) < Math.abs(best[1] - projected)) best = s;
    if (best[0] !== detent) setDetent(best[0]);
    apply(best[1], true, 'var(--spring-lin)', 520);
  };

  const onHeaderPointerDown = (e) => {
    if (desktop || e.button > 0 || e.target.closest('button, input, a')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start(e.clientY);
  };
  const onHeaderPointerMove = (e) => { if (drag.current) move(e.clientY); };
  const onHeaderPointerUp = () => end();

  // Body: take over the gesture when pulling down at scrollTop 0, or pulling up at medium.
  useEffect(() => {
    const el = body.current;
    if (!el || desktop) return;
    let startY = null;
    let mode = null;
    const ts = (e) => { startY = e.touches[0].clientY; mode = null; };
    const tm = (e) => {
      if (startY == null) return;
      const y = e.touches[0].clientY;
      const dy = y - startY;
      if (!mode) {
        if (Math.abs(dy) < 6) return;
        const atTop = el.scrollTop <= 0;
        const atMedium = detent === 'medium';
        mode = (dy > 0 && atTop) || (dy < 0 && atMedium) ? 'sheet' : 'scroll';
        if (mode === 'sheet') start(y);
      }
      if (mode === 'sheet') { e.preventDefault(); move(y); }
    };
    const te = () => { if (mode === 'sheet') end(); startY = null; mode = null; };
    el.addEventListener('touchstart', ts, { passive: true });
    el.addEventListener('touchmove', tm, { passive: false });
    el.addEventListener('touchend', te);
    el.addEventListener('touchcancel', te);
    return () => {
      el.removeEventListener('touchstart', ts);
      el.removeEventListener('touchmove', tm);
      el.removeEventListener('touchend', te);
      el.removeEventListener('touchcancel', te);
    };
  }, [detent, desktop]);

  const defaultTrailing = html`<button type="button" class="sheet-close" onClick=${ctx.close} aria-label="Sluit" data-tip="Sluit (Esc)">
    <${Icon} name="xmark" size=${15} stroke=${2.6} />
  </button>`;

  return html`<div class=${'sheet-layer' + (desktop ? ' is-desk' : '')} style=${{ zIndex: 100 + (ctx.depth || 0) * 2 }}>
    <div class="sheet-scrim" ref=${scrim} onClick=${ctx.close} aria-hidden="true"></div>
    <div class=${'sheet ' + cls + (detentList.includes('large') ? ' has-detents' : '') + (footer ? ' has-foot' : '')} ref=${panel} role="dialog" aria-modal="true" onKeyDown=${onKeyDown}
      aria-labelledby=${title ? titleId : null} aria-label=${title ? null : label} tabindex="-1">
      <div class="sheet-handle" onPointerDown=${onHeaderPointerDown} onPointerMove=${onHeaderPointerMove}
        onPointerUp=${onHeaderPointerUp} onPointerCancel=${onHeaderPointerUp}>
        ${!desktop && html`<div class="sheet-grabber" aria-hidden="true"></div>`}
        ${!hideHeader && html`<header class="sheet-header">
          <div class="sheet-header-side">${footer ? null : leading}</div>
          <h2 class="sheet-title" id=${titleId}>${title}</h2>
          <div class="sheet-header-side is-end">${footer ? null : trailing === undefined ? defaultTrailing : trailing}</div>
        </header>`}
      </div>
      <div class="sheet-body" ref=${body} onfocusin=${onFocusIn}>${children}</div>
      ${footer && html`<footer class="sheet-foot">${leading}${trailing === undefined ? null : trailing}</footer>`}
    </div>
  </div>`;
}

/** Hook for content inside a sheet: { close } of the enclosing sheet. */
export const useSheet = () => useContext(SheetCtx);
