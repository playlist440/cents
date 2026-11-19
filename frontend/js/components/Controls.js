// Small controls: Button, Chip, Segmented, Switch, SearchField.
//
//   html`<${Button} onClick=${go}>Ga verder</${Button}>`                      filled, large
//   html`<${Button} variant="tinted" size="small" icon="plus">Potje</${Button}>`
//   html`<${Chip} selected onClick=${…}>Boodschappen</${Chip}>`
//   html`<${Segmented} value=${v} onChange=${setV} options=${[['uit','Uitgaven'],['in','Inkomsten']]} />`
//   html`<${Switch} checked=${on} onChange=${setOn} label="Voor alle van Jumbo" />`
//   html`<${SearchField} value=${q} onInput=${setQ} />`

import { html, useRef, useState, useLayoutEffect } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { colorVar } from '../colors.js';
import { useId } from '../hooks.js';

/* variant: filled | tinted | gray | plain | destructive ; size: large | medium | small */
export function Button({ variant = 'filled', size = 'large', block = false, icon, onClick, disabled, type = 'button', children, class: cls = '', loading = false, ...rest }) {
  return html`<button type=${type} class=${`btn btn-${variant} btn-${size}${block ? ' btn-block' : ''}${loading ? ' is-loading' : ''} ${cls}`}
    onClick=${onClick} disabled=${disabled || loading} ...${rest}>
    ${icon && html`<${Icon} name=${icon} size=${size === 'small' ? 16 : 20} stroke=${2.1} />`}
    ${children && html`<span>${children}</span>`}
  </button>`;
}

export function Chip({ selected = false, onClick, color, emoji, children, tone, class: cls = '', removable = false, ...rest }) {
  const style = color ? { '--c': colorVar(color) } : null;
  const c = `chip${selected ? ' is-selected' : ''}${tone ? ' tone-' + tone : ''}${color ? ' is-colored' : ''} ${cls}`;
  const inner = html`${emoji && html`<span class="chip-emoji" aria-hidden="true">${emoji}</span>`}<span>${children}</span>${removable && html`<${Icon} name="xmark" size=${11} stroke=${2.6} />`}`;
  return onClick
    ? html`<button class=${c} style=${style} onClick=${onClick} aria-pressed=${selected ? 'true' : 'false'} ...${rest}>${inner}</button>`
    : html`<span class=${c} style=${style} ...${rest}>${inner}</span>`;
}

export function Segmented({ value, onChange, options: raw, label, size = 'medium' }) {
  // [value, label] pairs; {value, label} objects are accepted too (a wrong shape must never
  // take the whole sheet down)
  const options = raw.map((o) => (Array.isArray(o) ? o : [o.value, o.label]));
  // Equal columns (grid, minmax(0, 1fr)), so the thumb is placed by CSS from the index alone:
  // exact at every width, after resizes and while hidden — nothing is measured.
  const ref = useRef(null);
  const idx = Math.max(0, options.findIndex(([v]) => v === value));
  const onKey = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const n = (idx + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length;
    onChange(options[n][0]);
    ref.current.children[n + 1]?.focus();
  };
  return html`<div class=${'segmented seg-' + size} role="tablist" aria-label=${label} ref=${ref} onKeyDown=${onKey}
      style=${{ '--seg-n': options.length, '--seg-i': idx }}>
    <span class="seg-thumb" aria-hidden="true"></span>
    ${options.map(([v, text], i) => html`<button role="tab" aria-selected=${i === idx ? 'true' : 'false'} tabindex=${i === idx ? 0 : -1}
      class=${'seg-item' + (i === idx ? ' is-active' : '')} onClick=${() => onChange(v)}>${text}</button>`)}
  </div>`;
}

/** iOS switch. Uses <input type=checkbox switch> (native haptic on iOS 17.4+), styled everywhere. */
export function Switch({ checked, onChange, label, disabled = false, id }) {
  const auto = useId('sw');
  const ref = useRef(null);
  useLayoutEffect(() => { ref.current?.setAttribute('switch', ''); }, []);
  return html`<input ref=${ref} id=${id || auto} type="checkbox" role="switch" class="switch" checked=${checked}
    disabled=${disabled} aria-label=${label} onChange=${(e) => onChange(e.currentTarget.checked)} />`;
}

export function SearchField({ value, onInput, placeholder = 'Zoek', onCancel, autoFocus = false }) {
  const ref = useRef(null);
  const [focused, setFocused] = useState(false);
  return html`<div class=${'search' + (focused || value ? ' is-active' : '')}>
    <label class="search-box">
      <${Icon} name="search" size=${17} stroke=${2.2} />
      <input ref=${ref} type="search" value=${value} placeholder=${placeholder} enterkeyhint="search"
        autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck=${false} autofocus=${autoFocus}
        aria-label=${placeholder} onInput=${(e) => onInput(e.currentTarget.value)}
        onFocus=${() => setFocused(true)} onBlur=${() => setFocused(false)} />
      ${value && html`<button class="search-clear" aria-label="Wis" onPointerDown=${(e) => e.preventDefault()} onClick=${() => { onInput(''); ref.current.focus(); }}>
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" /><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="var(--bg)" stroke-width="2" stroke-linecap="round" /></svg>
      </button>`}
    </label>
    <button class="search-cancel" tabindex=${focused || value ? 0 : -1} onPointerDown=${(e) => e.preventDefault()}
      onClick=${() => { onInput(''); ref.current.blur(); onCancel?.(); }}>Annuleer</button>
  </div>`;
}
