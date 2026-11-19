// Popover menus anchored to their trigger (Apple context-menu look), context menus at the
// pointer, submenus, and popovers with custom content (pickers, small forms).
//
//   onClick=${(e) => openMenu(e.currentTarget, [
//     { label: 'Bankbestand importeren', icon: 'import', shortcut: 'I', onSelect: () => openImport() },
//     '-',
//     { label: 'Bakje', emoji: '🛒', submenu: [ …items ] },            // opens to the side
//     { label: 'Verwijder', icon: 'trash', destructive: true, onSelect: remove },
//   ])}
//   onContextMenu=${(e) => openContextMenu(e, items)}                 // right-click at the pointer
//   openPopover(anchor, (close) => html`…`, { width: 300 })           // picker / small form
//   (= openMenu(anchor, { render: (close) => html`…`, width }))
//
// Dismiss: outside click, Escape (returns focus to the trigger), scroll of the page, resize.
// Keys: ↑/↓ move, → / Enter opens a submenu, ← closes it.

import { html, useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { onRouteChange } from '../router.js';

let setMenuState = () => {};

function rectOf(anchor) {
  if (anchor && typeof anchor.getBoundingClientRect === 'function') return anchor.getBoundingClientRect();
  const { x = 0, y = 0 } = anchor || {};
  return { left: x, right: x, top: y, bottom: y, width: 0, height: 0 };
}

export function openMenu(anchor, items, opts = {}) {
  const spec = Array.isArray(items) ? { items, ...opts } : { ...items, ...opts };
  const el = anchor && anchor.getBoundingClientRect ? anchor : null;
  setMenuState({ rect: rectOf(anchor), anchor: el, ...spec, key: Date.now() });
}

/** Context menu at the pointer (right-click). */
export function openContextMenu(e, items, opts = {}) {
  e.preventDefault();
  openMenu({ x: e.clientX, y: e.clientY }, items, { ...opts, at: 'point' });
}

/** Popover with custom content anchored to `anchor`. */
export function openPopover(anchor, render, opts = {}) {
  openMenu(anchor, { render, ...opts, popover: true });
}

export function closeMenu() { setMenuState(null); }
onRouteChange(() => closeMenu());
export const isMenuOpen = () => !!document.querySelector('.menu');

export function MenuHost() {
  const [menu, setMenu] = useState(null);
  setMenuState = setMenu;
  if (!menu) return null;
  return html`<${Popover} key=${menu.key} menu=${menu} onClose=${() => setMenu(null)} level=${0} />`;
}

function Popover({ menu, onClose, level, onBack }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [sub, setSub] = useState(null); // { index, rect }
  const width = Math.min(menu.width || (menu.popover ? 300 : 248), window.innerWidth - 16);

  useLayoutEffect(() => {
    const el = ref.current;
    const h = el.offsetHeight;
    const r = menu.rect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = menu.at === 'point' ? 2 : menu.side ? -4 : 8;
    let left;
    let top;
    let origin;
    if (menu.side) {
      // Submenu: to the right of the item, or to the left when there is no room.
      left = r.right + 4;
      if (left + width > vw - 8) left = r.left - width - 4;
      top = r.top - 6;
      origin = 'top left';
    } else if (menu.at === 'point') {
      left = r.left;
      if (left + width > vw - 8) left = r.left - width;
      top = r.top + gap;
      origin = 'top left';
    } else {
      const alignRight = r.left + r.width / 2 > vw / 2;
      left = alignRight ? r.right - width : r.left;
      top = r.bottom + gap;
      origin = alignRight ? 'top right' : 'top left';
    }
    left = Math.max(8, Math.min(left, vw - width - 8));
    if (top + h > vh - 8) {
      if (!menu.side && menu.at !== 'point' && r.top - gap - h > 8) { top = r.top - gap - h; origin = origin.replace('top', 'bottom'); }
      else top = Math.max(8, vh - 8 - h);
    }
    setPos({ left, top: Math.max(8, top), origin, maxH: vh - 16 });
  }, []);

  useEffect(() => {
    if (level > 0) return undefined;
    const onDown = (e) => {
      if (e.target.closest?.('.menu')) return;
      if (menu.anchor && menu.anchor.contains(e.target)) { e.stopPropagation(); onClose(); return; }
      onClose();
    };
    const onScroll = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.menu')) onClose(); };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      // Only the innermost open panel handles keys.
      if (sub) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (level > 0) onBack?.(); else { onClose(); menu.anchor?.focus?.(); }
        return;
      }
      if (menu.render) return; // custom content handles its own keys
      if (e.key === 'ArrowLeft' && level > 0) { e.preventDefault(); e.stopPropagation(); onBack?.(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const btns = [...ref.current.querySelectorAll(':scope > .menu-scroll > .menu-item:not([disabled])')];
        const i = btns.indexOf(document.activeElement);
        const n = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
        btns[n]?.focus();
        e.preventDefault();
        e.stopPropagation();
      }
      if (e.key === 'ArrowRight') {
        const el = document.activeElement;
        if (ref.current.contains(el) && el.dataset.sub != null) { e.preventDefault(); e.stopPropagation(); openSub(Number(el.dataset.sub), el); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    // Menus take focus without highlighting an item (↓ starts at the first, like macOS);
    // keyboard-opened submenus and popovers focus their first control.
    if (!menu.render) {
      if (level > 0 && menu.fromKey) ref.current.querySelector('.menu-item:not([disabled])')?.focus({ preventScroll: true });
      else ref.current.focus({ preventScroll: true });
    }
    else ref.current.querySelector('[autofocus], input')?.focus({ preventScroll: true });
    return () => document.removeEventListener('keydown', onKey, true);
  }, [sub]);

  const closeAll = () => { onClose(); };
  const select = (item) => { closeAll(); setTimeout(() => item.onSelect?.(), 0); };
  const openSub = (i, el) => setSub({ index: i, rect: el.getBoundingClientRect() });
  const hoverTimer = useRef(0);
  const style = pos
    ? { left: pos.left + 'px', top: pos.top + 'px', width: width + 'px', maxHeight: pos.maxH + 'px', transformOrigin: pos.origin }
    : { left: '-9999px', top: '0px', width: width + 'px' };

  const subItem = sub != null ? menu.items[sub.index] : null;
  const subMenu = subItem && (Array.isArray(subItem.submenu)
    ? { items: subItem.submenu, rect: sub.rect, side: true, width: subItem.width || 240 }
    : { ...subItem.submenu, rect: sub.rect, side: true });

  return html`<div class=${'menu' + (menu.popover ? ' is-popover' : '') + (pos ? ' is-open' : '') + (level ? ' is-sub' : '')} ref=${ref} style=${style} tabindex="-1"
      role=${menu.render ? 'dialog' : 'menu'} aria-label=${menu.label || null}>
    ${menu.render
      ? menu.render(closeAll)
      : html`<div class="menu-scroll">${menu.items.map((item, i) => (item === '-'
        ? html`<div class="menu-sep" key=${'s' + i} role="separator"></div>`
        : item.header
          ? html`<div class="menu-header" key=${'h' + i}>${item.header}</div>`
          : html`<button key=${i} class=${'menu-item' + (item.destructive ? ' is-destructive' : '') + (item.checked ? ' is-checked' : '') + (sub?.index === i ? ' is-open' : '')}
            role="menuitem" disabled=${item.disabled} data-sub=${item.submenu ? i : null} aria-haspopup=${item.submenu ? 'menu' : null}
            aria-expanded=${item.submenu ? (sub?.index === i ? 'true' : 'false') : null}
            onPointerEnter=${(e) => {
              clearTimeout(hoverTimer.current);
              if (e.pointerType !== 'mouse') return;
              const el = e.currentTarget;
              if (item.submenu) hoverTimer.current = setTimeout(() => openSub(i, el), 120);
              else if (sub) hoverTimer.current = setTimeout(() => setSub(null), 160);
            }}
            onClick=${(e) => (item.submenu ? openSub(i, e.currentTarget) : select(item))}>
            <span class="menu-check">${item.checked && html`<${Icon} name="check" size=${14} stroke=${2.6} />`}</span>
            ${item.emoji && html`<span class="menu-emoji" aria-hidden="true">${item.emoji}</span>`}
            <span class="menu-label">${item.label}</span>
            ${item.shortcut && html`<kbd class="menu-kbd">${item.shortcut}</kbd>`}
            ${item.submenu
              ? html`<${Icon} name="chevron-right" size=${12} stroke=${2.6} />`
              : item.icon && html`<${Icon} name=${item.icon} size=${18} stroke=${1.8} />`}
          </button>`))}</div>`}
  </div>
  ${subMenu && html`<${Popover} key=${'sub' + sub.index} menu=${subMenu} level=${level + 1}
      onClose=${closeAll} onBack=${() => { const i = sub.index; setSub(null); setTimeout(() => ref.current?.querySelector(`[data-sub="${i}"]`)?.focus(), 0); }} />`}`;
}
