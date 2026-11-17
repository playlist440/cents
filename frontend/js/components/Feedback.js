// Skeleton, EmptyState, DropZone, ProgressRing.
//
//   html`<${Skeleton} w="60%" h=${22} />`             a calm placeholder block
//   html`<${EmptyState} emoji="🎉" title="Alles gesorteerd" action=${{ label: 'Klaar', onClick }} />`
//   html`<${DropZone} onFiles=${(files) => openImport(files)} />`
//   html`<${ProgressRing} value=${0.62} color="cyan" size=${120} emoji="✈️" label="Vakantie, 62 procent" />`

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { Button } from './Controls.js';
import { colorVar } from '../colors.js';
import { canHover } from '../hooks.js';
import { useDrawIn } from '../anim.js';

export const ACCEPT_FILES = '.csv,.xml,.txt,text/csv,text/xml,application/xml,text/plain';

export function Skeleton({ w = '100%', h = 16, r = 6, class: cls = '', style = {} }) {
  return html`<span class=${'skeleton ' + cls} aria-hidden="true"
    style=${{ width: typeof w === 'number' ? w + 'px' : w, height: typeof h === 'number' ? h + 'px' : h, borderRadius: r + 'px', ...style }}></span>`;
}

export function EmptyState({ emoji, icon, title, subtitle, action, class: cls = '' }) {
  return html`<div class=${'empty ' + cls}>
    ${emoji ? html`<div class="empty-emoji" aria-hidden="true">${emoji}</div>` : icon && html`<div class="empty-icon"><${Icon} name=${icon} size=${48} stroke=${1.5} /></div>`}
    <h2 class="empty-title">${title}</h2>
    ${subtitle && html`<p class="empty-sub">${subtitle}</p>`}
    ${action && html`<${Button} variant=${action.variant || 'filled'} size="medium" onClick=${action.onClick}>${action.label}</${Button}>`}
  </div>`;
}

/** Visually hidden file input + button that opens the Files picker. */
export function FileButton({ onFiles, children = 'Kies bestand', variant = 'filled', size = 'large', multiple = true }) {
  const ref = useRef(null);
  return html`<span class="filebtn">
    <input ref=${ref} type="file" class="vh" multiple=${multiple} accept=${ACCEPT_FILES} tabindex="-1" aria-hidden="true"
      onChange=${(e) => { const f = [...e.currentTarget.files]; e.currentTarget.value = ''; if (f.length) onFiles(f); }} />
    <${Button} variant=${variant} size=${size} onClick=${() => ref.current.click()}>${children}</${Button}>
  </span>`;
}

export function DropZone({ onFiles, title, compact = false }) {
  const [over, setOver] = useState(false);
  const hover = canHover();
  // No stopPropagation: the shell's window-level drop overlay must see every drop to reset
  // itself. preventDefault() marks the drop as handled so the shell doesn't import it twice.
  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onFiles(files);
  };
  return html`<div class=${'dropzone' + (over ? ' is-over' : '') + (compact ? ' is-compact' : '')}
    onDragOver=${(e) => { e.preventDefault(); if (!over) setOver(true); }}
    onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }} onDrop=${onDrop}>
    <div class="dz-icon" aria-hidden="true"><${Icon} name="doc" size=${compact ? 30 : 44} stroke=${1.4} /><span class="dz-arrow"><${Icon} name="import" size=${compact ? 16 : 22} stroke=${2.2} /></span></div>
    <h2 class="dz-title">${title || (hover ? 'Sleep je bankbestand hierheen' : 'Voeg je bankbestand toe')}</h2>
    <${FileButton} onFiles=${onFiles} size=${compact ? 'medium' : 'large'} />
    <p class="dz-caption">CSV of XML</p>
  </div>`;
}

/** Fitness-style ring. value 0..1 (above 1 draws a darker second lap). */
export function ProgressRing({ value = 0, color = 'tint', size = 120, stroke, emoji, label, children, animate = true }) {
  const sw = stroke ?? Math.max(6, Math.round(size * 0.12));
  const r = (size - sw) / 2;
  // Base style = final value; the first draw animates from an empty ring (anim.js), later
  // changes use the CSS transition on stroke-dashoffset.
  const p = value;
  const draw1 = useDrawIn([{ strokeDashoffset: 100 }, {}], { duration: 1100 });
  const draw2 = useDrawIn([{ strokeDashoffset: 100 }, {}], { duration: 900, delay: 900 });
  const c = color === 'tint' ? 'var(--tint)' : colorVar(color);
  const lap1 = Math.min(1, p) * 100;
  const lap2 = Math.max(0, Math.min(1, p - 1)) * 100;
  const pct = Math.round(value * 100);
  return html`<div class="ring" style=${{ '--c': c, width: size + 'px', height: size + 'px' }}
    role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct} aria-label=${label || pct + ' procent'}>
    <svg viewBox=${`0 0 ${size} ${size}`} width=${size} height=${size} aria-hidden="true">
      <circle class="ring-track" cx=${size / 2} cy=${size / 2} r=${r} stroke-width=${sw} />
      <circle class="ring-bar" cx=${size / 2} cy=${size / 2} r=${r} stroke-width=${sw} pathLength="100"
        stroke-dasharray="100 100" ref=${animate ? draw1 : null} style=${{ strokeDashoffset: 100 - lap1, opacity: lap1 > 0 ? 1 : 0 }} />
      ${lap2 > 0 && html`<circle class="ring-bar is-lap2" cx=${size / 2} cy=${size / 2} r=${r} stroke-width=${sw} pathLength="100"
        stroke-dasharray="100 100" ref=${animate ? draw2 : null} style=${{ strokeDashoffset: 100 - lap2 }} />`}
    </svg>
    <div class="ring-center">${emoji ? html`<span class="ring-emoji" style=${{ fontSize: Math.round(size * 0.3) + 'px' }}>${emoji}</span>` : children}</div>
  </div>`;
}
