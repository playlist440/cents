# Cents: Apple-native UI spec (iPhone PWA, iPad, Mac Safari)

Stack: Preact + htm, ES modules, hand-written CSS, SVG charts, system fonts, emoji icons, plain HTTP on a private network.
Principle: one hero per screen, grouped lists, large titles, materials, springs, almost no prose. Values below are Apple's published system colours and HIG metrics from memory of iOS 17/18/26; verify against a device before locking.

---
## 1. Navigation architecture

### Information architecture (deviation from the plan)
Seven destinations is too many for a tab bar. Proposed:

| Tab (iPhone) | Content | Notes |
|---|---|---|
| Overzicht | Screen 1 | default, hero number |
| Transacties | Screen 2 + search | search field in the large title, `Sorteren` entry as a banner on top ("12 om te sorteren") |
| Sorteren | Screen 3 | own tab with numeric badge. This is the family's daily "game", it earns a tab |
| Doelen | Screen 4 | |
| Meer | Vermogen, Vaste lasten, Import, Instellingen | grouped inset list (like Settings) |

- Vermogen and Vaste lasten are reachable from Overzicht too (tap the "Vermogen" card / "Binnenkort" section header with chevron) and live permanently in Meer. On iPad/Mac they are sidebar items.
- Import: not a tab. Entry points: Meer list row, plus a `+` / arrow.down.doc toolbar button on Transacties. Opens as a sheet.
- Instellingen: Meer list, and in the sidebar footer on wide layouts. Login screen is a full-screen view without chrome.

### Breakpoints (use container logic on `<body data-layout>` set from JS, CSS media queries mirror it)
```css
/* compact: iPhone portrait/landscape small, iPad Slide Over  */   @media (max-width: 699px)
/* regular: iPad portrait, big phones landscape */                  @media (min-width: 700px)   /* sidebar collapses to icon rail? no: use top-level sidebar from 820 */
/* wide: iPad landscape, Mac */                                      @media (min-width: 1000px)
```
- `<700`: bottom tab bar, single column, push navigation.
- `700-999`: tab bar stays at bottom (iPadOS 18 floats a top tab bar; skip it, a bottom bar is more thumb-friendly and simpler), content max-width 720, centered; sheets are centered cards.
- `>=1000`: sidebar (260px, translucent, SF-style sections) + content column (max 880) , optional inspector column for transaction detail (>=1280). Use a two-column split for Transacties: list left (380px), detail right; no modal sheet needed.
- Detect with `matchMedia('(min-width:1000px)')` in a Preact hook (`useLayout()`), never user-agent sniffing. Pointer: `(hover:hover) and (pointer:fine)` enables hover styles and keyboard shortcuts.

### Sheets
- iPhone (`compact`): bottom sheet, medium (~50%) and large (full minus 10px top gap, background content scales to 0.94 + dims) detents. Grabber 36x5, radius 3, colour `--fill-3`, 5px from top. Drag handle region = grabber + header (touch-action:none only there; content scrolls). Dismiss: swipe down (velocity or >35% travel), tap scrim, "Klaar"/"X" button. Large detent -> content scrolls; at scrollTop 0 further downward drag dismisses.
- iPad/Mac: centered sheet 540px wide, max-height 80dvh, radius 20, scrim `rgba(0,0,0,.25)`, scale-in 0.96->1 + fade. Context menus and tag pickers = popovers anchored to the trigger with arrow-less rounded 14px glass panel.
- Always: sheets are for self-contained tasks (categorise, import, goal edit). Never push-navigate for these.
- Full-screen cover (Sorteren card flow) on iPhone: no sheet; it is a tab.

### Back navigation, large titles
- Push stack inside each tab (Overzicht -> Vaste lasten, Meer -> Import...). iOS pattern: back button top-left `‹ Vorige titel` (chevron.left SVG 12x20 + label in tint), slide from right 100% with the old page moving -30% and dimming. Support edge-swipe back: Safari standalone has *no* native swipe-back, so implement a touchstart zone of 20px from left edge that drags the page (interactive pop). Needs ~60 lines JS; worth it. In Safari tab mode the native edge gesture conflicts: only enable custom gesture when `navigator.standalone`/display-mode standalone.
- Use `history.pushState` per push so the hardware/Safari back also works; sheets also push a state so back closes them.
- Large title: 34pt bold at scroll 0; collapses to 17pt semibold centred in a 44px blurred bar once scrolled ~ 52px. Implementation: IntersectionObserver on a sentinel under the large title toggles `data-collapsed`; nav bar background and hairline fade in (opacity .0->1 over 150ms), small title fades in. Do not animate font-size; cross-fade two elements.
- Tab re-tap scrolls to top (and pops to root if nested). Preserve scroll per tab (keep tab DOM alive, `hidden`).

---
## 2. Design tokens

```css
:root {
  color-scheme: light dark;
  /* Tint (one accent for the whole app) */
  --tint: #007AFF;

  /* System colours: light */
  --blue:#007AFF; --green:#34C759; --red:#FF3B30; --orange:#FF9500; --yellow:#FFCC00;
  --pink:#FF2D55; --purple:#AF52DE; --teal:#30B0C7; --indigo:#5856D6; --mint:#00C7BE;
  --cyan:#32ADE6; --brown:#A2845E;
  --gray:#8E8E93; --gray2:#AEAEB2; --gray3:#C7C7CC; --gray4:#D1D1D6; --gray5:#E5E5EA; --gray6:#F2F2F7;

  /* Backgrounds */
  --bg:#FFFFFF;            /* systemBackground */
  --bg-2:#F2F2F7;          /* secondarySystemBackground */
  --bg-3:#FFFFFF;          /* tertiarySystemBackground */
  --bg-grouped:#F2F2F7;    /* systemGroupedBackground  (page behind lists) */
  --bg-grouped-2:#FFFFFF;  /* secondarySystemGroupedBackground (cards/rows) */
  --bg-grouped-3:#F2F2F7;  /* tertiary grouped (nested) */
  --bg-elevated:#FFFFFF;   /* sheets (light = same) */

  /* Labels */
  --label:rgba(0,0,0,1);
  --label-2:rgba(60,60,67,.60);
  --label-3:rgba(60,60,67,.30);
  --label-4:rgba(60,60,67,.18);
  --placeholder:rgba(60,60,67,.30);

  /* Separators & fills */
  --sep:rgba(60,60,67,.29);      /* hairline, translucent */
  --sep-opaque:#C6C6C8;
  --fill:rgba(120,120,128,.20);  /* systemFill */
  --fill-2:rgba(120,120,128,.16);
  --fill-3:rgba(120,120,128,.12);
  --fill-4:rgba(120,120,128,.08);

  /* Semantic for money (deliberately muted, see §6) */
  --pos:var(--green);   --neg:var(--label);   /* expenses are NOT red; only warnings are */
  --warn:var(--orange); --danger:var(--red);

  /* Materials */
  --mat-bar:rgba(249,249,249,.78);        /* nav/tab bar: UIBlurEffect systemChromeMaterial */
  --mat-sheet:rgba(255,255,255,.72);
  --mat-blur:saturate(180%) blur(20px);
  --mat-thick-blur:saturate(180%) blur(30px);
  --scrim:rgba(0,0,0,.32);
  --card-shadow:0 0 0 .5px rgba(0,0,0,.04), 0 1px 2px rgba(0,0,0,.04);
  --sheet-shadow:0 -1px 0 rgba(0,0,0,.06), 0 -10px 40px rgba(0,0,0,.18);
  --pop-shadow:0 10px 40px rgba(0,0,0,.18), 0 0 0 .5px rgba(0,0,0,.08);

  /* Hairline */
  --hair:1px;
}
@media (min-resolution:2dppx){ :root{ --hair:.5px } }
@media (min-resolution:3dppx){ :root{ --hair:.33px } }  /* use .5px: .33 renders blurry on some */

@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
  --tint:#0A84FF;
  --blue:#0A84FF; --green:#30D158; --red:#FF453A; --orange:#FF9F0A; --yellow:#FFD60A;
  --pink:#FF375F; --purple:#BF5AF2; --teal:#40C8E0; --indigo:#5E5CE6; --mint:#63E6E2;
  --cyan:#64D2FF; --brown:#AC8E68;
  --gray:#8E8E93; --gray2:#636366; --gray3:#48484A; --gray4:#3A3A3C; --gray5:#2C2C2E; --gray6:#1C1C1E;
  --bg:#000000; --bg-2:#1C1C1E; --bg-3:#2C2C2E;
  --bg-grouped:#000000; --bg-grouped-2:#1C1C1E; --bg-grouped-3:#2C2C2E;
  --bg-elevated:#1C1C1E;
  --label:#FFFFFF; --label-2:rgba(235,235,245,.60); --label-3:rgba(235,235,245,.30);
  --label-4:rgba(235,235,245,.18); --placeholder:rgba(235,235,245,.30);
  --sep:rgba(84,84,88,.60); --sep-opaque:#38383A;
  --fill:rgba(120,120,128,.36); --fill-2:rgba(120,120,128,.32);
  --fill-3:rgba(120,120,128,.24); --fill-4:rgba(120,120,128,.18);
  --mat-bar:rgba(29,29,31,.72); --mat-sheet:rgba(28,28,30,.78);
  --scrim:rgba(0,0,0,.5);
  --card-shadow:none; --sheet-shadow:0 -1px 0 rgba(255,255,255,.08);
  --pop-shadow:0 10px 40px rgba(0,0,0,.6), 0 0 0 .5px rgba(255,255,255,.1);
}}
/* Optional manual override: duplicate the dark block under :root[data-theme="dark"]. Default = follow system. */
```
Dark mode notes: dark grouped background is pure `#000` with `#1C1C1E` cards (OLED, matches Wallet/Health); elevated sheets use `#1C1C1E`. Don't use shadows in dark; use lighter surface.

### Typography
System font stack: `font-family: -apple-system, "SF Pro Text", system-ui, "Helvetica Neue", sans-serif;` On macOS Safari/iOS, `-apple-system` picks SF Pro Display/Text automatically with optical sizing. Money: `font-variant-numeric: tabular-nums`, optionally `font-feature-settings:"tnum","ss01"`? skip ss01; use `"tnum"` only. Use `font-family: ui-rounded, -apple-system` for hero numbers in Fitness-style rings (SF Rounded available in Safari 15+ via `ui-rounded`); decide once, keep it for ring centres and goal %, not for body.

Scale (rem on 17px body: root stays 100% = 16px so user settings apply; sizes in rem computed /16):
```css
:root{
  --fs-largetitle:2.125rem;  /* 34 / 41, bold(700), +0.37px */
  --fs-title1:1.75rem;       /* 28 / 34, bold, +0.36px */
  --fs-title2:1.375rem;      /* 22 / 28, bold, +0.35px */
  --fs-title3:1.25rem;       /* 20 / 25, semibold(600), +0.38px */
  --fs-headline:1.0625rem;   /* 17 / 22, semibold, -0.41px */
  --fs-body:1.0625rem;       /* 17 / 22, regular, -0.41px */
  --fs-callout:1rem;         /* 16 / 21, -0.32px */
  --fs-subhead:.9375rem;     /* 15 / 20, -0.24px */
  --fs-footnote:.8125rem;    /* 13 / 18, -0.08px */
  --fs-caption1:.75rem;      /* 12 / 16, 0 */
  --fs-caption2:.6875rem;    /* 11 / 13, +0.07px */
}
.t-largetitle{font:700 var(--fs-largetitle)/1.2 var(--font);letter-spacing:.023em}
.t-body{font:400 var(--fs-body)/1.3 var(--font);letter-spacing:-.024em}
```
Hero number (Overzicht): 48-56px semibold/bold rounded, tracking -0.02em, `font-variant-numeric:tabular-nums` (not Apple text style; Apple does this in Fitness/Weather).

Dynamic Type: set `html{font:-apple-system-body; font-size:100%}`? Correct trick: `html{font:-apple-system-body}` makes Safari map to the user's Dynamic Type size (works in Safari and standalone WKWebView-based PWAs; ignored elsewhere). Then derive `--base: 1rem`-relative sizes via `rem`. Guard: `@supports (font:-apple-system-body){ html{font:-apple-system-body; font-size:calc(1em*16/17)} }` and test. Cap layout breakage with `min-width:0` and wrapping, never fixed heights on rows (use `min-height`).

### Radii (continuous-corner feel)
CSS has no squircle; approximate with slightly larger radii and `corner-shape: squircle` when available (Safari TP only; progressive enhancement).
```css
:root{ --r-xs:6px; --r-sm:10px; --r-md:12px; --r-card:20px; /* Wallet/Health cards 20-24 */
  --r-sheet:38px; /* iOS 26 sheets are large, ~38; iOS 18: 12-ish top */
  --r-btn:14px; --r-pill:999px; --r-icon:22.37%; }
@supports (corner-shape:squircle){ .card,.sheet,.btn{corner-shape:squircle; border-radius:calc(var(--r)*1.35)} }
```
Concentricity rule (iOS 26): inner radius = outer radius - padding. Card 20 with 16 padding: inner elements 12 max... use 4-8 inner radius; grouped list inset radius 12 on iOS 18, 20-26 on iOS 26 style. Pick **16 for grouped list/cards, 22 for hero cards, 12 for buttons/segmented** to land between versions.

### Spacing, targets
```css
:root{ --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:20px; --s6:24px; --s8:32px; --s10:40px;
  --gutter:16px;                 /* iPhone side margin; 20 on iPad; sidebar content 24 */
  --row-h:44px; --tap-min:44px;  /* HIG: 44x44pt minimum */
  --nav-h:44px; --tab-h:49px; }
```
Rows min 44px (single-line) / 60px (two-line merchant rows). Small icon buttons: visual 28-32, hit area expanded to 44 via `::after{inset:-8px}`.

---
## 3. Motion

Apple UI = springs with slight overshoot only on playful elements; most system transitions are critically damped. CSS `linear()` approximations (Safari 17.2+; fallback cubic-bezier):
```css
:root{
  /* iOS standard ease-out-ish for push/sheet (like UIKit default 0.35s) */
  --ease-ios:cubic-bezier(.32,.72,0,1);
  --ease-out:cubic-bezier(.22,1,.36,1);
  --ease-in-out:cubic-bezier(.4,0,.2,1);
  /* Spring, damping ~0.8, tiny overshoot (stiffness 300): */
  --spring:cubic-bezier(.34,1.3,.64,1);
  --spring-lin:linear(0,.009,.035 2.1%,.141 4.4%,.723 12.9%,.938 16.7%,1.017 20.8%,1.043 24.7%,1.034 28.9%,1.009 35.2%,.998 42%,1);
  --spring-bouncy:linear(0,.0125,.05 2.2%,.2 5%,.62 10.5%,1.05 16%,1.12 19%,1.07 24%,.99 31%,.975 35%,1.005 45%,1);
  --d-tap:120ms; --d-fast:200ms; --d-push:380ms; --d-sheet:420ms; --d-count:900ms; --d-chart:700ms;
}
@supports not (transition-timing-function:linear(0,1)){ :root{ --spring-lin:var(--spring); --spring-bouncy:var(--spring) } }
```
- Push: new page `translateX(100%)->0`, old `0 -> -30%` plus 0.15 black overlay, 380ms `--ease-ios`. Pop reversed, driven by finger when interactive.
- Sheet present: `translateY(100%)->0` 420ms `--ease-ios`; dismiss 300ms ease-in. Drag-follow with rubber banding: `y = y>0 ? y : -log-ish` (`-12*Math.sqrt(-y)`). Snap between detents uses velocity-projected `--spring-lin`.
- Tap feedback: pressed = `transform:scale(.97)` and `opacity:.85` on buttons/cards, `background:var(--fill-3)` on list rows; transition-in 0ms (instant), release 250ms spring. Don't scale list rows.
```css
@media (hover:none){ .btn:active{transform:scale(.97);opacity:.85} .row:active{background:var(--fill-3)} }
@media (hover:hover){ .row:hover{background:var(--fill-4)} }
.btn,.row{transition:transform 250ms var(--spring-lin),opacity 250ms,background-color 250ms}
.btn:active,.row:active{transition-duration:0s}
```
 iOS Safari needs `ontouchstart=""` on `<body>` (or any touch listener) for `:active` to fire reliably; do it.
- Count-up: on mount/month change, animate from previous value to new in 900ms ease-out-expo (`1-2^(-10t)`) with `requestAnimationFrame`, format each frame with `Intl.NumberFormat`; digits stay stable because of tabular-nums. Only animate hero + ring centres, never lists. Skip on first paint if user has seen it < 5 min ago.
- Chart draw-in: bars `scaleY(0->1)` from baseline, transform-origin bottom, stagger 25ms, 700ms `--spring-lin`; lines: `stroke-dasharray=len; stroke-dashoffset: len->0` 800ms ease-out; rings: `stroke-dashoffset` 900ms, ring end cap round.
- Number change in list (e.g. after categorising): cross-fade 150ms; amount "tick" is overkill.
- Haptic-like: no Vibration API on iOS Safari. Substitute with micro scale-pulse (1->1.06->1, 180ms) + toast + a checkmark morph. Note: iOS 17.4+ Safari triggers a real haptic when toggling `<input type="checkbox" switch>`; you may use that for the toggles in Instellingen (native switch look too).
- Reduced motion:
```css
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}
  .sheet,.page{transition:opacity 150ms linear!important;transform:none!important}  /* iOS replaces slides with cross-fades */
}
```
JS: skip count-up/draw-in when `matchMedia('(prefers-reduced-motion:reduce)').matches`.

---
## 4. iOS Safari / PWA specifics

```html
<!doctype html><html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<!-- no maximum-scale/user-scalable=no: it hurts a11y and iOS ignores it anyway; fix zoom via 16px inputs -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Cents">
<meta name="apple-mobile-web-app-status-bar-style" content="default">  <!-- 'black-translucent' = content under status bar; use with safe-area padding. Prefer it for a custom blurred header -->
<meta name="theme-color" content="#F2F2F7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<meta name="format-detection" content="telephone=no">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">            <!-- 180x180 -->
<link rel="apple-touch-icon" sizes="167x167" href="/icons/icon-167.png">     <!-- iPad Pro -->
<link rel="apple-touch-icon" sizes="152x152" href="/icons/icon-152.png">
<link rel="manifest" href="/manifest.webmanifest"> <!-- display:standalone, background_color:#F2F2F7, icons 192/512 for non-iOS -->
<!-- Splash: iOS auto-generates from manifest/background colour on iOS 16+; skip apple-touch-startup-image unless white flash bothers: set <html> background = var(--bg-grouped) inline in <style> to avoid flash -->
</head>
```
- Icon: 1024 master, opaque square (iOS rounds it; no transparency, no pre-rounded corners), no text.
- `black-translucent` + `viewport-fit=cover`: status bar becomes transparent over your header; the standalone status-bar text colour follows the system theme (iOS 15+). With `default` style, bar is opaque white/black. For the blurred large-title look use `black-translucent` and pad by `env(safe-area-inset-top)`. Test in both appearance modes; the page behind is yours so always set body background.
- Status-bar-style cannot be changed at runtime; theme-color media queries only affect Safari tab UI (iOS 15+).

```css
html{ -webkit-text-size-adjust:100%; height:100%; background:var(--bg-grouped) }
body{ margin:0; min-height:100dvh; background:var(--bg-grouped); color:var(--label);
  font:400 var(--fs-body)/1.3 var(--font); -webkit-font-smoothing:antialiased;
  -webkit-tap-highlight-color:transparent; -webkit-touch-callout:none;
  overscroll-behavior-y:none; }                 /* iOS 16+ honours overscroll-behavior */
#app{ height:100dvh; display:flex; flex-direction:column }
.scroll{ flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; overscroll-behavior:contain;
  padding-left:max(var(--gutter),env(safe-area-inset-left)); padding-right:max(var(--gutter),env(safe-area-inset-right)); }
.tabbar{ position:fixed; inset:auto 0 0 0; padding-bottom:env(safe-area-inset-bottom); height:calc(49px + env(safe-area-inset-bottom));
  background:var(--mat-bar); -webkit-backdrop-filter:var(--mat-blur); backdrop-filter:var(--mat-blur);
  border-top:var(--hair) solid var(--sep) }
.navbar{ position:sticky; top:0; padding-top:env(safe-area-inset-top); height:calc(44px + env(safe-area-inset-top)); z-index:10;
  background:transparent; transition:background .2s, box-shadow .2s }
.navbar[data-collapsed]{ background:var(--mat-bar); -webkit-backdrop-filter:var(--mat-blur); backdrop-filter:var(--mat-blur); box-shadow:0 var(--hair) 0 var(--sep) }
.scroll>.content{ padding-bottom:calc(49px + env(safe-area-inset-bottom) + 16px) }
```
- Always include the `-webkit-` prefix for backdrop-filter. Blur only on small fixed bars/sheets; never on scrolling lists (perf).
- Single scroll container pattern (body locked, `.scroll` scrolls) gives control of rubber-band; but then iOS status-bar tap-to-top works only if the scroller is the document. **Recommendation: let the document scroll (`html`/`body`)**, use `position:sticky/fixed` for bars. This keeps status-bar-tap-to-top, native momentum, and URL-bar collapse in Safari tab mode. Use inner scroll only inside sheets: `overscroll-behavior:contain`.
- Lock background while a sheet is open: `body{position:fixed;width:100%;top:-scrollY}` on open and restore on close (the only reliable iOS approach); or set `overflow:hidden` on `html` (works iOS 16+ mostly). Prefer the former.
- Input zoom: any input `font-size < 16px` triggers zoom. `input,textarea,select{font-size:max(16px,1rem)}`. Search field styled at 17px is fine.
- Keyboard + bottom sheets: use `visualViewport`:
```js
const vv = window.visualViewport;
vv.addEventListener('resize', () => {
  const kb = window.innerHeight - vv.height - vv.offsetTop;
  document.documentElement.style.setProperty('--kb', Math.max(0,kb)+'px');
});
// .sheet{ bottom: var(--kb,0px); max-height: calc(100dvh - var(--kb,0px) - env(safe-area-inset-top) - 10px) }
```
 In iOS standalone the layout viewport doesn't resize when the keyboard opens, so `--kb` is needed; call `el.scrollIntoView({block:'center'})` on focus. Promote the sheet to the large detent when a text field focuses (tags).
- `100vh` is wrong on iOS Safari (includes URL bar); use `100dvh`, with `100vh` fallback first.
- Selection/callout: `body{-webkit-user-select:none;user-select:none}` for chrome; re-enable with `.selectable{-webkit-user-select:text;user-select:text}` on amounts/descriptions in detail sheet, and on all `input/textarea`. Disable long-press image/link callout (`-webkit-touch-callout:none`) except where copy is useful.
- Standalone detection:
```js
export const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
document.documentElement.dataset.standalone = standalone;
```
 In Safari tab mode, show nothing about "install" unless Settings; a one-line hint with share-icon illustration in Instellingen only.
- Pull-to-refresh: PWA standalone has none; Safari tab has the native one (conflicts with `overscroll-behavior`). Provide custom PTR only on Transacties/Overzicht if data can change externally (e.g. after import): spinner at top using the iOS activity-indicator (12 spokes SVG), threshold 70px, haptic-less. Often unnecessary: refetch on `visibilitychange` and on tab re-tap. Recommend: skip PTR, refetch on visibility.
- Links/buttons: use `<button>` not `<a>` for actions; `touch-action:manipulation` on interactive elements kills the 300ms/double-tap-zoom delay. `cursor:pointer` is irrelevant on touch.
- File input (Files app):
```html
<input type="file" id="f" multiple accept=".csv,.xml,text/csv,text/xml,application/xml,text/plain,application/vnd.ms-excel">
```
 iOS needs MIME + extension; some banks serve CSV as `text/plain` or `application/octet-stream`; omitting a type is safer than excluding. Validate by extension and content in JS after. Use a visually hidden input and a `<label for>` styled as a button (don't `display:none` the input on old iOS: use `position:absolute;opacity:0;width:1px`). Drag&drop zone only when `(hover:hover) and (pointer:fine)`; on touch show just the large button. Read with `file.text()`; the ASN CSV may be Windows-1252: `new TextDecoder('windows-1252')` fallback after trying UTF-8 `fatal:true`.
- HTTP/LAN limits: no service worker, no `crypto.subtle` (insecure context: avoid it for hashing), no `navigator.clipboard` (use `execCommand('copy')` fallback), no Web Share? (needs secure context; hide button), localStorage works. Manifest still enables Add to Home Screen standalone on iOS via the meta tags above. Cookie for login: `SameSite=Lax; HttpOnly`, no `Secure`.
- Standalone quirk: external links leave the app and show no back; keep everything in-app. Don't put `target=_blank`.
- Safe-area at landscape: use `max(16px, env(safe-area-inset-left))`.
- Avoid `position:fixed` + `transform` bugs: put `will-change:transform` only on animating nodes; remove after.
- Scroll-linked effects: use passive listeners `{passive:true}` and IntersectionObserver instead of scroll handlers where possible.

---
## 5. Components (sketches)

**Grouped inset list (Settings style)**
```html
<section class="group"><h2 class="group-h">Vast</h2>
 <ul class="inset"><li><a class="row" href="#/vast"><i class="ico" style="--c:var(--orange)">🏠</i><span class="lbl">Huur</span><span class="val">€ 1.150</span><svg class="chev"/></a></li></ul>
 <p class="group-f">Alleen bij echte noodzaak voetnoot.</p></section>
```
```css
.group-h{font:400 var(--fs-footnote)/1.3 var(--font);text-transform:uppercase;color:var(--label-2);margin:24px 16px 6px;letter-spacing:-.0008em}
.inset{margin:0 var(--gutter);padding:0;list-style:none;background:var(--bg-grouped-2);border-radius:var(--r-card-sm,16px);overflow:hidden}
.row{display:flex;align-items:center;gap:12px;min-height:44px;padding:0 16px;color:inherit;text-decoration:none;position:relative}
.inset li+li .row::before{content:"";position:absolute;top:0;right:0;left:60px;height:var(--hair);background:var(--sep)}  /* separator inset to text start (icon 28+gap) */
.ico{width:30px;height:30px;border-radius:7px;display:grid;place-items:center;background:color-mix(in srgb,var(--c) 18%,transparent);font-style:normal;font-size:18px}
.val{margin-left:auto;color:var(--label-2)} .chev{width:8px;height:14px;color:var(--label-3)}
```
Category icons: emoji centred on a tinted rounded square (like Settings icons, but pastel tint at 18% so dark mode works) -> consistent and pretty. Emoji rendering is Apple Color Emoji: perfect on target devices.

**Cards (Health/Fitness)**: `background:var(--bg-grouped-2); border-radius:22px; padding:16px; box-shadow:var(--card-shadow)`. Header: small coloured label with icon (headline-ish 15px semibold in the card's colour, like Health's "Hartslag"), chevron at trailing, big value below (34 bold + small unit 15 label-2). One idea per card. Cards are tappable as a whole (pressed: scale .98).

**Segmented control** (e.g. Week/Maand/Jaar, Alle/Uitgaven/Inkomsten): 32px high, `background:var(--fill-2)`, radius 9, thumb white (`#fff`, dark `#636366`) radius 7 with `0 3px 8px rgba(0,0,0,.12),0 3px 1px rgba(0,0,0,.04)`, thumb slides via `transform` with `--spring-lin` 300ms. Use `<div role="tablist">` with buttons; font 13px semibold selected / medium.

**Search field**: 36px high, `background:var(--fill-3)`, radius 10, magnifier 15px `--label-2`, placeholder "Zoek", clear (x.circle.fill) button, and a "Annuleer" tint text button sliding in on focus (width transition). Sits under the large title and scrolls away; `enterkeyhint="search"`, `type="search"`, `autocapitalize="off" autocorrect="off"`. Apply `-webkit-appearance:none` and hide the native cancel button (`::-webkit-search-cancel-button{display:none}`). Live-filter with debounce 120ms.

**Bottom tab bar**: 49px + safe area; 5 items, icon 25px SVG (SF-like outline -> filled when active) over 10px label medium; active = `--tint`, inactive = `--gray`. Badge: red 18px pill with white 13px text. iOS 26 variant: floating capsule glass bar inset 12px from edges with 28px radius; optional. Recommend the classic full-width bar (more robust, cheaper). No emoji in tab bar; draw 5 simple SVG glyphs (1.6 stroke, round caps) to look SF-ish.

**Sidebar** (>=1000px): 260px, `background:var(--mat-bar)` blur, items 36px high radius 8, icon 20 in tint, selected = `background:color-mix(in srgb,var(--tint) 14%,transparent)` + tint text (iPadOS style) or solid tint white text (macOS). Section headers footnote caps ("Overzicht", "Beheer"). App title top, Instellingen at bottom, month switcher not here (it's in the content header).

**Sheet**
```html
<div class="scrim"></div>
<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="t">
 <div class="grab"></div>
 <header class="sheet-h"><button class="txt">Annuleer</button><h2 id="t">Boodschappen</h2><button class="txt bold">Klaar</button></header>
 <div class="sheet-body">…</div></div>
```
```css
.sheet{position:fixed;inset:auto 0 0 0;max-height:calc(100dvh - 10px - env(safe-area-inset-top));border-radius:var(--r-sheet) var(--r-sheet) 0 0;background:var(--bg-elevated);
  box-shadow:var(--sheet-shadow);padding-bottom:env(safe-area-inset-bottom);transform:translateY(var(--y,100%));will-change:transform;touch-action:none}
.grab{width:36px;height:5px;border-radius:3px;background:var(--fill);margin:5px auto 0}
.sheet-body{overflow:auto;overscroll-behavior:contain;touch-action:pan-y}
@media (min-width:700px){.sheet{inset:50% auto auto 50%;width:540px;border-radius:20px;transform:translate(-50%,-50%) scale(var(--s,.96));max-height:80dvh}}
```
Header actions: left cancel (tint), right primary bold (tint), title centred 17 semibold. Sheets use `--bg-grouped` inside (grouped lists on gray) like Apple forms.

**Context / action menu**: long-press (or `...` button, `ellipsis.circle`) -> popover list: 250px wide, radius 14, `--mat-sheet` blur 30, rows 44px with trailing SF-like icon, destructive in `--red`, separators hairline, thick 8px `--fill-4` dividers between groups. Appears with scale .9->1 from anchor corner, 200ms spring. Long-press on web: `contextmenu` event isn't fired on iOS reliably; use 400ms pointer timer + `touch-action`; but prefer visible `...` for discoverability. For category change use a bottom sheet with a grid of bakjes (emoji tiles), not a menu.

**Toast / confirmation**: iOS has no toasts; use a glass capsule at top under the island/safe area (like AirPods banner) or bottom above tab bar: 44px tall, radius 22, blur material, icon + short text ("In Boodschappen gezet" + "Ongedaan"), slides down 380ms spring, auto-dismiss 2.5s, `role="status"`. Undo beats confirm dialogs: no "Weet je het zeker?" for categorising; use Undo. Destructive (delete goal) uses action sheet with red button and "Annuleer" separate.
Success moment (sort card done): animated checkmark circle (stroke draw 400ms) in a centred 120px glass HUD (like iOS "Gekopieerd") for 1s.

**Empty states**: icon (large emoji 56px or SF-ish symbol in `--label-3`), title 20 semibold, one-line subhead 15 `--label-2`, one tinted button. No illustrations. "Alles gesorteerd" = confetti-less big check + "Klaar voor deze maand".

**Swipe actions on rows**: Worth it for Transacties (leading swipe? trailing: "Bakje" blue, maybe "Splits"), and Sorteren list; but costly and unreliable (conflicts with edge-swipe back and horizontal scroll, no haptics). Recommendation: implement ONE trailing swipe on transaction rows ("Bakje", 80px blue, full swipe triggers it) using pointer events with `touch-action:pan-y`, 8px dead zone, and rubber-band; always provide the tap->sheet path as primary. Skip leading swipes and delete-by-swipe for financial data (accidental loss); delete lives in detail sheet. Priority below sheets/large-title; v2.

**Progress ring (Fitness)**: SVG 120x120, r=52, stroke 14, round caps, track `color-mix(in srgb,var(--c) 22%,transparent)`, progress colour `--c`, rotate -90deg; overshoot beyond 100% draws second lap with darker tone (Fitness). Start cap gets a small shadow when >100%. Centre: emoji 28px, value below. Animate `stroke-dashoffset` with `pathLength="100"` so JS maps percent directly.
```html
<svg viewBox="0 0 120 120" role="img" aria-label="Vakantie, 62 procent"><circle class="trk" cx="60" cy="60" r="52" pathLength="100"/><circle class="bar" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="100" style="--p:62"/></svg>
<style>circle{fill:none;stroke-width:14;stroke-linecap:round}.trk{stroke:color-mix(in srgb,var(--c) 22%,transparent)}.bar{stroke:var(--c);stroke-dashoffset:calc(100 - var(--p));transform:rotate(-90deg);transform-origin:60px 60px;transition:stroke-dashoffset var(--d-chart) var(--spring-lin)}</style>
```
**Month switcher**: in the nav bar below title (or as the title itself): `‹  november 2026  ›` chevrons 44px hit, label tappable -> popover month grid (year header + 12 months, current tinted). Horizontal swipe on the content to change month is a nice extra, but only on Overzicht/Transacties headers (conflict with back gesture). Disable `›` beyond current month. Label lowercase Dutch via `Intl.DateTimeFormat('nl-NL',{month:'long',year:'numeric'})`.

---
## 6. Data visualisation

**Money formatting** (nl-NL): `new Intl.NumberFormat('nl-NL',{style:'currency',currency:'EUR'})` -> `€ 1.234,56` (note NBSP). In lists: show cents (`€ 12,40`); in hero/cards round to whole euros with small cents in label-2 (Apple Stocks style: `€ 1.234` + `,56` at 60% size) or drop cents. Always tabular-nums, right-aligned in lists, minus sign as real `−` (U+2212), not hyphen; negative amounts for spending shown *without* colour; income `+€ 2.400` in `--green`. Never wrap an amount (`white-space:nowrap`), `font-variant-numeric:tabular-nums`.

**Colour use**: Apple avoids red/green overload (Wallet shows spending in neutral label; Stocks uses red/green but only for change). Rules: expenses neutral label; income green (only on transactions list and in the income tile); red only for "over budget"/failure; orange for "let op" (nearly empty bakje); blue = interaction. Category colours come from a fixed 10-colour palette (blue, orange, pink, purple, teal, indigo, mint, yellow, brown, cyan) mapped to bakjes; since colours alone must not carry meaning, always with emoji + label.

**Bar chart per month (12 bars)**: Health-style: rounded-top bars (radius 4-6, width ~60% of slot), selected bar in tint, others `color-mix(tint 35%)`; baseline hairline, 3 y gridlines hairline `--sep` with labels at trailing edge in caption2 `--label-2` (Apple puts y-labels on the right). Tap/drag scrub selects bar and shows callout with amount above the title (value swaps in header: "€ 2.340 / gemiddeld per dag" like Health). Dashed average line in `--label-3`. No axis titles, no legend unless stacked.

**Category breakdown: donut vs bars**: Apple uses horizontal bars/lists for ranked data comparisons (Screen Time, Health "Highlights", Fitness stacked bars, Wallet categories are a stacked single bar + list) and donuts only for part-of-whole with <=5 slices or for goals (rings). Donuts are poor for 8+ categories and for comparing similar values. **Recommendation:** a single 12px stacked "capsule" bar (Wallet's spending bar) showing proportions across the top, directly followed by a ranked list: emoji tile, name, amount right, thin 4px progress bar under the name relative to the largest (or to budget). Tap category -> filtered Transacties. No donut for categories; rings only for doelen and one for "nog te besteden" progress.

**Sparkline**: 1.5px stroke round joins, no axes, last point 5px dot, gradient fill under 0.18 -> 0 opacity of the same colour, 32px high; colour = tint for neutral series (not red/green) except net-worth up/down dot. Use in Vermogen account rows (trailing, 64x28) and as hero background in Overzicht-"uitgaven deze maand vs. vorige".

**Net-worth chart**: line + gradient fill (Stocks), range segmented control `1M 6M 1J Alles`, scrub with vertical rule and value/date in header; smooth with monotone cubic (never overshoot).

**Accessibility**: contrast: text >=4.5:1; `--label-2` (60% alpha) passes on both backgrounds, `--label-3` is for disabled/placeholder only. Chart `<svg role="img" aria-label="Uitgaven per maand: januari 1.800 euro, februari ...">` or, better, render a visually-hidden `<table>` and `aria-hidden` the SVG; interactive bars are `<button>`s with labels "november, 2.340 euro". Ring: `role="progressbar" aria-valuenow`. Colour-blind: avoid red-vs-green only distinctions: pair with `+`/`−` signs, icons, position; selected bar distinguished by saturation + callout, not hue. Respect `prefers-contrast:more` (raise `--sep` alpha to .5, use opaque label-2 `#3C3C43` light/`#EBEBF5` dark) and `prefers-reduced-transparency` (swap mat for solid `--bg-2`). Use rem units for text and padding so Dynamic Type works; at accessibility sizes (>=1.4x) let rows wrap to two lines and stack amount under merchant (`@media (min-resolution)` can't detect; test with `font:-apple-system-body` and `clamp`). `lang="nl"`.

---
## 7. Twelve tells that it's a web app (and fixes)

1. **Pinch/double-tap zoom, 300ms delay, input zoom-in on focus**: `touch-action:manipulation`, inputs >=16px, never disable zoom via meta.
2. **Wrong bounce / white overscroll flash / body scrolls behind sheets**: html/body background = page bg, `overscroll-behavior`, body-lock for sheets.
3. **Flat page-load transitions (content just appears)**: every navigation is push/sheet/crossfade with iOS curves; use history-aware transitions; tab switches crossfade 150ms, no slide.
4. **Hover/focus artifacts & blue tap flash**: `-webkit-tap-highlight-color:transparent`, `:active` fills, hover only under `(hover:hover)`, `outline` replaced by `:focus-visible` ring only for keyboard.
5. **Text selectable everywhere, long-press callouts, magnifier on UI chrome**: `user-select:none` on chrome, `-webkit-touch-callout:none`; keep selectable on data.
6. **Non-system typography: web fonts, wrong weights, no tabular numerals, wrong letter-spacing**: system stack, text-style table, tracking values, `tnum`.
7. **Bars/headers that ignore the notch/home indicator; content hidden behind tab bar**: `viewport-fit=cover` + `env(safe-area-inset-*)` everywhere, `black-translucent` handling.
8. **Material mismatch: opaque coloured toolbars, drop-shadow cards, heavy borders**: translucent blurred bars with hairline, grouped-inset surfaces w/o borders, shadows barely visible in light, none in dark.
9. **Inconsistent corner radii and Material/Bootstrap-looking controls** (underlined inputs, raised buttons, FABs, checkboxes): use iOS controls: switch (`<input type=checkbox switch>`), segmented, text-button toolbar actions, filled tinted capsule buttons (44px high, radius 14 or pill), no FAB.
10. **No gesture parity: no swipe-back, sheets not draggable, no pull to dismiss**: implement edge-swipe back, draggable sheets with detents and rubber band, scroll-to-top on tab re-tap.
11. **Loading spinners & layout jumps**: skeleton shimmer is un-Apple; render cached data instantly (localStorage/IndexedDB), fade in numbers (count-up), reserve heights, use iOS spinner only for imports. Never a blank screen; remember the last tab and scroll.
12. **Wordy UI, dialogs (`alert`/`confirm`), dev-ish error text, English leftovers, system date/number formats**: no browser dialogs ever (own action sheets), Undo instead of confirm, Dutch microcopy of <=3 words, `Intl` with nl-NL, relative day names ("Vandaag", "Gisteren"), icons with labels only where ambiguous. Also: keyboard form `inputmode="decimal"`, `autocomplete`, `enterkeyhint`, and Return-to-next in forms.

(Honourable mentions: no status-bar tap-to-top because inner scroll container; missing dark mode; wrong `:active` on iOS without touch listener; a visible URL bar in standalone because meta tags missing; focus ring around buttons after tap.)

---
## 8. Information hierarchy

### Overzicht
Hero number for a non-financial family: **"Nog te besteden: € 640"**, framed as *vrij te besteden tot de volgende salarisdag/einde van de maand*, not as income minus costs. Everything else supports or explains it. Layout, top to bottom (iPhone):
1. Large title "Overzicht" + month switcher (small, trailing or under).
2. **Hero card**: big `€ 640` (56pt rounded bold, count-up) with label "nog te besteden" caption; under it a thick horizontal capsule (or ring) showing *uitgegeven / inkomen na vaste lasten* and a subline "€ 21 per dag voor 17 dagen" (daily allowance is the most intuitive number for non-finance people). State colours: normal tint; < 20% left orange; negative red + "Over".
3. Three small stat tiles in a row (not equal-weight cards): Inkomen · Vaste lasten · Uitgegeven. Each tile: tinted emoji, value, label. Tapping goes to the filtered list. This is the equation, ordered as income -> fixed -> spent -> left, which the hero resolves.
4. **Sorteren banner** if unsorted > 0 ("12 nieuwe betalingen · Sorteer"): this is the call to action, tinted `--blue` 12%, directly under hero because it keeps data correct.
5. Where it went: stacked capsule + top 5 bakjes list, "Alles tonen" chevron.
6. 1-3 insight cards, horizontally paged (snap, peeking 16px) e.g. "Boodschappen +18% t.o.v. vorige maand": sentence style, one number, no charts; max 3, rank by magnitude, dismissible.
7. "Binnenkort" next 3-5 vaste lasten (date chip + name + amount), chevron to Vaste lasten.
8. Optional Vermogen/Doelen peek cards at the bottom (rings row).
Do not show a net-worth or balance figure at the top; the bank balance confuses ("rekening" vs "beschikbaar"). Keep the screen to ~1.5 viewport heights.

### Sorteren (one-card-at-a-time)
- Top: progress as thin capsule + "3 van 12" caption; "Klaar" at right. No title bar clutter.
- Card (Wallet-card feel, radius 28, large): merchant name 28 bold, amount 34 semibold, date + count ("5 betalingen eerder") caption, and **suggested bakje pre-selected as a big primary button** ("Boodschappen 🛒") from the rules/LLM, with confidence implied by order, not percentages.
- Below the card: a 3-column grid of the most likely 6 bakjes as 64pt emoji tiles + "Meer…" (opens searchable sheet). One tap = categorise and the card flies off (translate+rotate, 280ms), next card scales up from 0.95 behind it (stack peek of 2 cards). Haptic-like pulse + subtle toast with Undo; "Onthoud voor alle van Albert Heijn" as a default-on switch row on the card (sets rule), not a dialog.
- Gestures: swipe left = "Sla over", swipe right = accept suggestion (optional; buttons always visible). Keyboard shortcuts on Mac (1-6, Z undo, arrows).
- End state: "Alles gesorteerd" with check HUD, then back to Overzicht updating numbers with count-up.
- Group identical merchants into a single card ("Albert Heijn · 7 betalingen") to cut the card count by 5-10x.

### Strong opinions / deviations
- Make Sorteren a tab with a badge; move Vermogen + Vaste lasten under "Meer" (and linked from Overzicht), Import/Instellingen in Meer.
- Document scrolls (not an inner container) to keep native status-bar tap-to-top, momentum and collapse behaviour.
- No donut for categories: capsule + ranked list; rings only for goals and the hero.
- Expenses are not red; one tint colour; income green only.
- Skip pull-to-refresh and (initially) swipe actions; invest in sheets, large titles, edge-swipe back, springs.
