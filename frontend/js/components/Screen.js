// Screen scaffold.
//
// < 1000 px: translucent nav bar + large title that collapses on scroll + content column.
// ≥ 1000 px (DESIGN §5): a Mac toolbar instead — back chevron (pushed screens), the title,
// `titleView` (e.g. the month switcher), the screen's own actions, the global search field
// and the global `+` menu. No large title (the toolbar carries it).
//
//   html`<${Screen} title="Overzicht" trailing=${html`<${NavButton} icon="plus" label="Toevoegen" />`}>…</${Screen}>`
//
// Props: title, large (default true), back (auto from the route table; false hides; or
// {label, to}), leading, trailing, titleView (replaces the centred small title), accessory
// (right of the large title), header (custom hero replacing the large title; the small title
// appears once it scrolls away), wide (no column max-width), class,
// add (desktop: items for the toolbar `+` menu, shown above "Bankbestand importeren" /
// "Uitgave toevoegen"; when given, `trailing` is not shown on desktop — it is the phone `+`),
// toolbar (desktop: extra vnode in the toolbar's action group, e.g. a bulk bar).

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { Icon } from '../icons.js';
import { back as routerBack, match } from '../router.js';
import { usePage, useLayout } from '../hooks.js';
import { ToolbarSearch, AddButton } from './Toolbar.js';

export function Screen({ title, large = true, header, back, leading, trailing, titleView, accessory, wide = false, add, toolbar, class: cls = '', children }) {
  const page = usePage();
  const layout = useLayout();
  const desk = layout === 'wide';
  const sentinel = useRef(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const bar = el.parentElement.querySelector('.navbar');
    const h = Math.max(44, bar ? bar.offsetHeight : 44);
    const io = new IntersectionObserver(([e]) => {
      // Ignore reports while the page is hidden (display:none reports "not intersecting").
      if (e.boundingClientRect.width === 0) return;
      setCollapsed(!e.isIntersecting && e.boundingClientRect.top < h + 1);
    }, { rootMargin: `-${h}px 0px 0px 0px`, threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [desk]);

  // Window title follows the visible screen ("Transacties — Cents").
  useEffect(() => {
    if (page.active && title && typeof title === 'string') document.title = `${title} — Cents`;
  }, [page.active, title]);

  const backInfo = resolveBack(back, page.route, layout);
  const showSmallTitle = (!large && !header) || collapsed;

  if (desk) {
    return html`<div class=${'screen is-desk ' + (wide ? 'is-wide-content ' : '') + cls}>
      <header class="navbar toolbar" data-collapsed=${collapsed ? '' : null}>
        <div class="toolbar-inner">
          <div class="tb-lead">
            ${backInfo && html`<button class="tb-back" onClick=${() => routerBack(backInfo.to)} aria-label=${'Terug naar ' + backInfo.label} data-tip=${'Terug naar ' + backInfo.label}>
              <${Icon} name="chevron-left" size=${18} stroke=${2.4} />
            </button>`}
            <h1 class="tb-title">${title}</h1>
            ${titleView && html`<div class="tb-view">${titleView}</div>`}
          </div>
          <div class="tb-actions">
            ${toolbar}
            ${leading}
            ${add === undefined && trailing}
            <${ToolbarSearch} />
            <${AddButton} items=${add || []} />
          </div>
        </div>
      </header>
      ${header && html`<div class="screen-header">${header}</div>`}
      <div ref=${sentinel} class="title-sentinel" aria-hidden="true"></div>
      <div class="screen-content">${children}</div>
    </div>`;
  }

  return html`<div class=${'screen ' + (wide ? 'is-wide-content ' : '') + cls}>
    <header class="navbar" data-collapsed=${collapsed ? '' : null}>
      <div class="navbar-leading">
        ${leading || (backInfo && html`<${BackButton} label=${backInfo.label} to=${backInfo.to} />`)}
      </div>
      ${titleView
        ? html`<div class="navbar-center">${titleView}</div>`
        : html`<div class=${'navbar-title' + (showSmallTitle ? '' : ' is-hidden')} aria-hidden=${large || header ? 'true' : null}>${title}</div>`}
      <div class="navbar-trailing">${trailing}</div>
    </header>
    ${header
      ? html`<div class="screen-header">${header}</div>`
      : large
        ? html`<div class="largetitle-row"><h1 class="largetitle">${title}</h1>${accessory}</div>`
        : html`<h1 class="vh">${title}</h1>`}
    <div ref=${sentinel} class="title-sentinel" aria-hidden="true"></div>
    <div class="screen-content">${children}</div>
  </div>`;
}

function resolveBack(back, route, layout) {
  if (back === false || !route) return null;
  if (back && back.to) return back;
  if (!route.parent) return null;
  if (layout === 'wide' && route.sidebarRoot) return null; // sidebar destinations are roots on wide
  const parent = match(route.parent.split('?')[0]);
  return { to: route.parent, label: parent?.route.title || 'Terug' };
}

export function BackButton({ label = 'Terug', to }) {
  return html`<button class="backbtn" onClick=${() => routerBack(to)} aria-label=${'Terug naar ' + label}>
    <${Icon} name="chevron-left" size=${22} stroke=${2.4} />
    <span>${label}</span>
  </button>`;
}

/** Icon or text button for nav bars (icon-only buttons get a tooltip on pointer devices). */
export function NavButton({ icon, label, text, onClick, bold = false, disabled = false, ...rest }) {
  return html`<button class=${'navbtn' + (text ? ' is-text' : '') + (bold ? ' is-bold' : '')} onClick=${onClick}
    aria-label=${text ? null : label} data-tip=${text ? null : label} disabled=${disabled} ...${rest}>
    ${text || html`<${Icon} name=${icon} size=${22} stroke=${2} />`}
  </button>`;
}
