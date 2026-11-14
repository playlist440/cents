// Glass capsule toast with an optional undo action. One at a time; a new one replaces it.
//
//   toast({ text: '12 betalingen naar Boodschappen', action: { label: 'Herstel', onClick: undo } })
//   toast({ text: 'Gekopieerd', icon: 'check' })

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';

let push = () => {};

export function toast(spec) {
  push({ ...(typeof spec === 'string' ? { text: spec } : spec), key: Date.now() + Math.random() });
}

export function ToastHost() {
  const [t, setT] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef(null);
  push = (spec) => { setLeaving(false); setT(spec); };

  // Undo toasts for more than one payment stay ≥ 10 s; any toast pauses while hovered or
  // focused and resumes (with at least 3 s) when the pointer or focus leaves.
  const lengthOf = (x) => x.duration ?? (x.action ? (/\b([2-9]|\d{2,}) betalingen\b/.test(x.text) ? 10000 : 6000) : 2600);
  const start = (ms) => { clearTimeout(timer.current); timer.current = setTimeout(() => dismiss(), ms); };
  useEffect(() => {
    if (!t) return;
    start(lengthOf(t));
    return () => clearTimeout(timer.current);
  }, [t]);
  const pause = () => clearTimeout(timer.current);
  const resume = () => { if (t) start(Math.max(3000, Math.round(lengthOf(t) / 2))); };

  const dismiss = () => {
    setLeaving(true);
    setTimeout(() => { setT(null); setLeaving(false); }, 260);
  };

  return html`<div class="toast-host" role="status" aria-live="polite">
    ${t && html`<div key=${t.key} class=${'toast' + (leaving ? ' is-leaving' : '')}
        onPointerEnter=${pause} onPointerLeave=${resume} onFocusIn=${pause} onFocusOut=${resume}>
      ${t.emoji ? html`<span class="toast-emoji" aria-hidden="true">${t.emoji}</span>`
        : t.icon !== null && html`<span class="toast-icon"><${Icon} name=${t.icon || 'check'} size=${18} stroke=${2.4} /></span>`}
      <span class="toast-text">${t.text}</span>
      ${t.action && html`<button class="toast-action" onClick=${() => { t.action.onClick(); dismiss(); }}>${t.action.label}</button>`}
    </div>`}
  </div>`;
}
