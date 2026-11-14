# Cents frontend

Static files in `frontend/`, served as-is. No build step, no Node. Preact + hooks + htm are
vendored as one ES module (`js/vendor/preact-htm.js`, htm 3.1.1 standalone, no imports). No
other runtime dependencies. Design: `docs/DESIGN.md` (authoritative) and
`docs/research/apple-ui.md` (tokens, components, iOS pitfalls).

## Run it

```
cd frontend && python3 -m http.server 8771
open http://localhost:8771/?mock=1
```

| URL | State |
|---|---|
| `?mock=1` | logged in, 18 months of a fictitious household |
| `?mock=login` | login screen (mock password `demo1234`) |
| `?mock=setup` | first run ("Kies een wachtwoord"), then an empty household |
| `?mock=empty` | logged in, no data; importing any `.csv`/`.xml` loads the household |
| `&latency=0` | no simulated network delay (default 90–220 ms, to see skeletons) |
| `&theme=dark` / `&theme=light` | force a scheme (default follows the system) |
| `&swipe=1` | enable the edge-swipe-back gesture outside Home Screen mode |
| `#/_gallery` | every component and chart, with a light/dark switch |

Without `?mock`, the app calls the real API; if `/api/session` answers 404 (a plain static
server) it falls back to the mock automatically. The mock lives entirely in memory: reload
resets it. Inspect it from the console: `(await import('/js/mock/mock.js')).debug.db`.

Python's `http.server` lets the browser cache modules heuristically; after editing, reload
with the cache disabled (or serve with `Cache-Control: no-store`).

## Architecture

```
index.html            meta, CSS links, <script type=module src=js/main.js>; CSP-safe (no inline JS)
manifest.webmanifest
icons/                icon.svg, favicon.svg, PNGs (tools/make_icons.py)
css/tokens.css        colours (light/dark), type scale, radii, spacing, materials, motion
css/base.css          reset, document, text styles, app shell, page transitions, nav bar
css/components.css    every shared component
css/screen-<name>.css one per screen, owned by whoever builds that screen
js/main.js            boot: real API or mock, router, render, session
js/routes.js          THE route table, tab bar items, sidebar items, named sheets
js/router.js          hash router + history (screens and sheets are history entries)
js/shell/             app.js (login gate, chrome, hosts, file drop), outlet.js (keeps
                      screens alive, transitions), tabs.js, edgeswipe.js, actions.js
js/store.js           global store + query cache (useStore, useQuery, invalidate)
js/api.js             one function per SPEC §10 endpoint
js/upload.js          uploadWithProgress(path, files, {onProgress}) — XHR upload progress (mock simulates)
js/mock/              data.js (deterministic household), mock.js (the whole API)
js/format.js          money, dates, periods, plurals (nl-NL)
js/icons.js           inline SVG icons
js/colors.js          token colour names (bakjes, potjes, tags)
js/hooks.js           useMedia, useLayout, usePage, useId, reducedMotion…
js/components/        shared components (see reference below)
js/charts/            SVG charts
js/screens/           one module per screen or sheet
```

**Navigation.** Every screen change is a history entry (`#/path?query`,
`history.state = {idx, path}`); sheets push an entry with the same URL plus `sheet`, so the
browser back button, the iOS back gesture and Escape close the top sheet first. The outlet keeps
up to 8 recently visited screens mounted but hidden, so going back is instant and keeps scroll
position and state. The document scrolls (not an inner div); during a transition the leaving
screen is taken out of flow and pinned where it was. Transitions: `push`/`pop` (slide with
parallax and dim), `tab` (150 ms cross-fade), `cover`/`uncover` (Sorteren slides up, no
chrome), `none`. Tapping the active tab pops to its root, or scrolls to the top; other tabs
reopen where you left them. ≥ 1000 px shows the sidebar instead of the tab bar; routes with
`sidebarRoot` then have no back button.

**Data.** `useQuery(key, fetcher)` is stale-while-revalidate: revisiting a screen renders the
cached data immediately. After any mutation call `invalidate()`: it refetches `bootstrap` and
every *visible* query (hidden kept-alive screens refetch when they become visible).

## Adding or replacing a screen

The screens below are stubs. Build one by **replacing the contents of its module**; keep the
exported name. Nothing else needs to change.

| Route | Module (export) | CSS |
|---|---|---|
| `#/transacties` | `screens/transacties.js` (`Transacties`) | `screen-transacties.css` |
| `#/potjes`, `#/potjes/:id` | `screens/potjes.js` (`Potjes`), `screens/potje.js` (`Potje`) | `screen-potjes.css` |
| `#/vermogen` | `screens/vermogen.js` (`Vermogen`) | `screen-vermogen.css` |
| `#/meer` | `screens/meer.js` (`Meer`) | `screen-meer.css` |
| `#/sorteren` (cover) | `screens/sorteren.js` (`Sorteren`) | `screen-sorteren.css` |
| `#/vaste-lasten` | `screens/vaste-lasten.js` (`VasteLasten`) | `screen-vaste-lasten.css` |
| `#/jaaroverzicht` | `screens/jaaroverzicht.js` (`Jaaroverzicht`) | `screen-jaaroverzicht.css` |
| `#/tags`, `#/tags/:id` | `screens/tags.js` (`Tags`), `screens/tag.js` (`Tag`) | `screen-tags.css` |
| `#/terugblik`, `#/terugblik/:period`, `#/terugblik/jaar/:year` | `screens/terugblik.js` (`Terugblik`, `TerugblikPeriode`, `TerugblikJaar`; `recapHref({period}|{year})`) | `screen-terugblik.css` (incl. `@media print`) |
| `#/bakjes` | `screens/bakjes.js` (`Bakjes`) | (use `screen-meer.css`) |
| `#/instellingen` | `screens/instellingen.js` (`Instellingen`) | `screen-instellingen.css` |
| Import sheet | `screens/import.js` (`ImportSheet`, props `{files, close}`) | `screen-import.css` |
| Uitgave toevoegen sheet | `screens/uitgave.js` (`UitgaveSheet`) | `screen-transacties.css` |
| Transaction sheet | `screens/transactie.js` (`TransactieSheet`, props `{id, tx, close}`) | `screen-transacties.css` |

Every per-screen CSS file is already linked from `index.html`. A screen component receives
`{params, query}` from the route; `usePage()` gives the same plus `active`.

Skeleton of a screen:

```js
import { html } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery } from '../store.js';
import { Screen, NavButton } from '../components/Screen.js';

export function Potjes() {
  const { data } = useQuery('goals', () => api.goals());
  return html`<${Screen} title="Potjes" trailing=${html`<${NavButton} icon="plus" label="Nieuw potje" onClick=${…} />`}>
    ${data ? html`…` : html`<${PotjesSkeleton} />`}
  </${Screen}>`;
}
```

**A new route**: add one line to `routes` in `js/routes.js` (fields documented there) and a
module in `js/screens/`. **A new sheet**: write a component that renders `<Sheet>` as its root
and open it with `openSheet(Component, props)` from `js/router.js`; register it in `sheets` in
`routes.js` only when other screens need to open it by name (see `shell/actions.js`).

**Query parameters other screens rely on** (please honour them):
- `#/transacties?period=2026-11&flow=in|out` — Overzicht's Inkomen/Uitgegeven tiles. `flow` is a
  UI parameter (map it to whatever the API supports; `min_cents`/`max_cents` are absolute
  amounts in the backend). Also `category_id`, `tag_id`, `account_id`, `q`, `merchant_key`.
- `#/transacties?unsorted=1` (merchants without bakje), `#/transacties?merchant_key=…`; filters
  are kept in the URL, so any combination is a valid link.
- `#/overzicht?period=YYYY-MM` — month shown on Overzicht (absent = current month).
- `#/vaste-lasten?view=kalender&period=YYYY-MM` — Vaste lasten as payment calendar (absent
  `view` = list; absent `period` = current; up to 12 periods ahead).
- `#/terugblik/2026-10`, `#/terugblik/jaar/2025` — recap of a period or year (index at
  `#/terugblik`). Build links with `recapHref({ period })` / `recapHref({ year })`.
- `#/overzicht/bakje/:id?period=YYYY-MM` — bakje detail.
- `openTransaction(tx)` (`shell/actions.js`) opens the transaction sheet from any list (Bakje
  detail uses it); `openImport(files?)`, `openAddExpense()`, `openAddMenu(anchor)` (the `+`
  menu), `openLink(hrefOrLink)` (insight links, both `href` strings and `{screen, params}`).
- Files dropped on the window or chosen in an empty state arrive as the event
  `cents:import-files` (`detail.files`); the shell opens the Import sheet with them.

## Mac (≥ 1000 px) conventions

DESIGN §5 is the spec. All desktop CSS lives in `css/desktop.css` (one `@media (min-width:
1000px)` block, sections: density tokens, sidebar, toolbar, content grid, menus/popovers/tooltips,
shared components, screens, pointer). Phone CSS is untouched by it; check 375/320/768 after edits.

- **Density tokens** override the type scale and `--gutter`, `--col-max` (1200), `--sidebar-w`
  (240), `--nav-h` (52), `--tap`, `--row-h`, `--row-pad-x`, `--row-lead`, `--dk-gap`.
- **Grid helpers:** `.dk-grid` (12 columns) with `.dk-col-7/5/8/4/12`, `.dk-stack`, `.dk-card`
  + `.dk-card-h`. Below 1280 px the right-hand column drops below the left.
- **Data table:** `.dt` > `.dt-head` + `.dt-row` (buttons), columns from `--dt-cols`,
  `.is-num` right-aligned, `.dt-row.is-selected`.
- **Screen on desktop** renders a toolbar: `title`, `titleView`, `leading`/`trailing` (as
  actions), `toolbar` (extra vnode, e.g. a bulk bar), `add` (items for the global `+`; when set,
  `trailing` is the phone `+` and is not shown). `back` shows a chevron with a tooltip.
- **Contrast:** text colours come from tokens that pass 4.5:1 in both schemes: `--label`,
  `--label-2`, `--tint` / `--tint-text`, `--<colour>-text` (e.g. `--green-text`; `colorTextVar(name)`
  in `colors.js`), `--warn-text`, `--red-text`. `--label-3` and the plain system colours are for
  graphics and decorative hints only. Text on accent fills uses `--on-tint` (white in light, dark
  green in dark mode).
- **Sheets on desktop:** pass Annuleer/primary as `leading`/`trailing` `SheetButton`s; on ≥ 1000 px
  they render as a bottom-right button pair. Small edits use `openPopover` instead of a sheet.
- **Pointer:** hover only under `(hover: hover) and (pointer: fine)`; default cursor on rows and
  buttons; `data-tip="…"` on icon-only buttons gives a tooltip (`TooltipHost`).

**Shortcuts** (`js/shell/keys.js`; never while typing, with a sheet/menu open, or with a
modifier except ⌘K): `/` or ⌘K search · ←/→ month on Overzicht · N new expense · I import · `?`
list · Esc closes. Transacties: ↑/↓ (⇧ extends), ⌘-/⇧-click, Enter → inspector, Esc collapses a
multi-selection. Sorteren: 1–9, spatie, ⌘Z.

## Component reference

All in `js/components/` unless noted. Import from the file named in brackets.

| Component | Usage |
|---|---|
| Screen, NavButton, BackButton [Screen.js] | `<${Screen} title="Potjes" trailing=${…} header=${…} large=${false}>…</${Screen}>` — nav bar + large title that collapses; `header` = custom hero, `titleView` = centred nav-bar view, `accessory` = right of large title, back button automatic from `route.parent` |
| TabBar, Sidebar [TabBar.js, Sidebar.js] | rendered by the shell only |
| Sheet, SheetButton, SheetHost, useSheet [Sheet.js] | `<${Sheet} title="Nieuw potje" detents=${['medium','large']} leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`} trailing=${html`<${SheetButton} bold onClick=${save}>Klaar</${SheetButton}>`}>…</${Sheet}>`; default trailing is a round ✕; wrap content in `<div class="sheet-pad">` |
| openMenu, closeMenu, openContextMenu, openPopover [Menu.js] | `openMenu(e.currentTarget, [{ label, icon, emoji, shortcut, onSelect, destructive, checked, submenu }, '-', { header }, …])`; `submenu` = items or `{ render, width }` (opens to the side, ←/→ keys); `openContextMenu(e, items)` at the pointer (right-click); `openPopover(anchor, (close) => html`…`, { width })` for pickers and small forms. Outside click / Esc / scroll dismiss |
| Toolbar parts [Toolbar.js] | `ToolbarSearch`, `AddButton`, `focusToolbarSearch()` — rendered by Screen on desktop |
| TooltipHost [Tooltip.js] | rendered by the shell; any element with `data-tip` |
| SettingsSplit [SettingsSplit.js] | `<${SettingsSplit} label items=${[{ id, label, icon, iconColor | emoji, color, value, onClick }, '-']} active>…</${SettingsSplit}>` System Settings layout (desktop) |
| Worksheet kit [screens/_txdesk.js] | `TxTableRow`, `BakjePicker`/`TagPicker` + `openBakjePopover`/`openTagPopover`, `openRowMenu`, `setTxBakje(tx, cat, scope)`, `bulkSetBakje`, `bulkAddTag`, `BulkTools`, `MultiInspector` |
| drawIn, useDrawIn, useFirstRender [js/anim.js] | draw-in animations whose end state is the base style (see DECISIONS "Mac first") |
| toast [Toast.js] | `toast({ text: '12 betalingen naar Boodschappen', emoji: '🛒', action: { label: 'Herstel', onClick: undo } })` |
| List, ListRow, Section [List.js] | `<${List} header="…"><${ListRow} emoji="🛒" color="green" title="Boodschappen" value="€ 412" chevron onClick=${…} /></${List}>`; `Section` = bold Health-style section title with optional `link`/`trailing` |
| Card, Tile [Card.js] | `<${Card} onClick=${…}>…</${Card}>`; `<${Tile} label="Inkomen" icon="euro" color="green" cents=${…} progress=${0.8} sub="van € 5.400" onClick=${…} />` |
| EmojiTile [EmojiTile.js] | `<${EmojiTile} emoji="🛒" color="green" size=${36} />`, `dashed` for unsorted |
| Amount, useCountUp [Amount.js] | `<${Amount} cents=${-4120} />` → € 41,20; `whole animate` for hero/ring numbers, `signed` adds + for income |
| Button, Chip, Segmented, Switch, SearchField [Controls.js] | `<${Button} variant="filled|tinted|gray|plain|destructive" size="large|medium|small" icon="plus" block>…</${Button}>`; `<${Chip} selected emoji color onClick>`; `<${Segmented} value onChange options=${[['uit','Uitgaven'],['in','Inkomsten']]} />`; `<${Switch} checked onChange label />`; `<${SearchField} value onInput />` |
| TextField, AmountField, DateField [Fields.js] | inside a `<List>`: `<${TextField} label="Naam" value onInput />`, `<${AmountField} label="Doel" cents onChange />` (decimal keypad, comma), `<${DateField} value onChange />`; `boxed` / `large` variants |
| EmojiPicker, ColorPicker [Pickers.js] | `<${EmojiPicker} value onChange color />` (tap the tile for the system emoji keyboard); `<${ColorPicker} value onChange />` |
| MonthSwitcher [MonthSwitcher.js] | `<${MonthSwitcher} value="2026-11" first last onChange />`; label opens a month grid |
| Skeleton, EmptyState, DropZone, FileButton, ProgressRing [Feedback.js] | `<${Skeleton} w="60%" h=${22} />`; `<${EmptyState} emoji title action />`; `<${DropZone} onFiles />`; `<${ProgressRing} value=${0.62} color="cyan" size=${120} emoji="✈️" label="…" />` |
| TxRow [TxRow.js] | `<ul class="inset">${items.map((tx) => html`<${TxRow} tx=${tx} onClick=${() => openTransaction(tx)} />`)}</ul>`; `date`, `hideCategory`, `sub`, `selected`, `selectable` (multi-select check circle, `aria-pressed`) |
| StackedCapsule [charts/] | `<${StackedCapsule} segments=${[{ value, color, label }]} />` |
| RankedBars [charts/] | `<${RankedBars} rows=${[{ emoji, color, label, value, chip: { text, tone: 'more'|'less' }, onClick }]} />` |
| BarChart [charts/] | `<${BarChart} data=${[{ label, short, value, partial }]} average highlight selected onSelect />`; stacked: `data=[{label, short, values}]` + `series=[{name, color}]`, optional `line={name, color, values}`; hover band + read-out on pointer devices (`readout`, `readoutExtra(i)`); `partial` bars lighter |
| LineChart [charts/] | `<${LineChart} points=${[{ label, short, value }]} scrub=${i} onScrub=${setI} axis />` (put a `Segmented` range control above it); `axis` adds y/x labels; crosshair read-out on hover |
| PaceChart [charts/] | `<${PaceChart} actual typical label />`; desktop: `height=${220} axis interactive dayLabel=${(i, long) => …}` (mouse crosshair + read-out) |
| Readout [charts/util.js] | floating read-out clamped to the chart: `<${Readout} x width top>…</${Readout}>` |
| Sparkline [charts/] | `<${Sparkline} values width height label />` |
| Transacties kit [screens/_tx.js] | `<${BakjeGrid} value onPick=${(cat, el) => …} sign="out" first=${[ids]} exclude hints />` (emoji tile grid of bakjes, sensible order); `<${TagEditor} tagIds onChange=${(ids, addedTag) => …} />` (chips + inline add/autocomplete/create, "🇮🇹 Naam" sets the emoji); `createTag(text)`, `allTags()`, `tagLookup(id)`; `emitTxChange({ids, merchant_key, set})` / `onTxChange(fn)` for optimistic list updates; `METHOD_LABEL`, `ACCOUNT_TYPE_LABEL`, `maskIban()` |
| Pickers [screens/transacties.js] | `openSheet(PickBakjeSheet, { value, onPick, onUnsorted? })`, `openSheet(PickTagSheet, { value, onPick, allowCreate })` |
| TransactieDetail [screens/transactie.js] | the transaction sheet's content without the sheet (`{ id, tx, inline, onDone }`), used by the Transacties split view |
| Icon [js/icons.js] | `<${Icon} name="plus" size=${22} />`; names in the gallery; tab icons have `-fill` variants |

Charts: every chart has an accessible name; bar and line charts also render a visually hidden
data table. Scrubbing works with finger, mouse and arrow keys. Colours of bakjes/potjes/tags are
token names (`green`, `indigo`, …) → `colorVar(name)` in `js/colors.js`.

## CSS conventions

- Only tokens from `tokens.css` (`var(--label-2)`, `var(--fs-subhead)`, `var(--r-card)`…). No
  raw colours except inside tokens. Dark mode then works for free; check both in the gallery.
- Expenses are never red: amounts use `--label`; income `--pos` (green) with `+`. Orange
  (`--warn`) is the only warning colour. Red only for destructive actions.
- Rem for type; system font; `.num` (tabular numerals) on every amount; `.rounded` for hero
  numbers and ring centres.
- Pressed states on touch go under `@media (hover: none)` as `:active`; hover styles only under
  `(hover: hover) and (pointer: fine)`. Lists change background, buttons/cards scale.
- Safe areas: use `--sat/--sab/--sal/--sar`; screen content already gets side padding
  (`--pad-l/--pad-r`) from `.screen`.
- Inputs are ≥ 16 px (otherwise iOS zooms). Use `<button>` for actions, never `<a>` without href.
- Prefix classes per screen (`.pj-…` for potjes, …) in your own `screen-<name>.css`. Do not
  edit `tokens.css`, `base.css` or `components.css` for one screen; if a shared component
  needs a change, make it generic and note it.
- Motion: `--ease-ios` for navigation, `--spring-lin` for little things, durations from tokens.
  Everything respects `prefers-reduced-motion` (CSS and `reducedMotion()` in JS).

## Store conventions

- Global state (`js/store.js`): `session`, `boot` (GET /bootstrap), `dataVersion`, `mock`.
  Read with `useStore((s) => s.boot)`; never mutate, use `setState`.
- Lookups: `categoryById`, `categoryByKey`, `tagById`, `accountById`.
- Server data: `useQuery('goals', () => api.goals())`. Keys are strings; include every
  parameter (`'overview:2026-11'`). Mutations: call the API, then `invalidate()`. For instant
  feedback, update local state optimistically and offer undo through `toast({ action })`.
- Never `alert`/`confirm`; destructive confirmations are menus with a red item, undo via toast.

## The mock

`js/mock/data.js` generates one coherent household deterministically from a fixed seed,
anchored to today: two salaries, toeslagen, mortgage and ~20 fixed costs (some changing price,
one new, one stopped, yearly and quarterly ones), ~45 daily payments a month, a savings account
with goal codes in descriptions, an investment account with valuations, a credit card with
manual purchases and monthly settlements, 14 unsorted merchants (incl. private persons), tags,
four potjes, learned rules and an import history. `js/mock/mock.js` implements every endpoint
of SPEC §10 (plus the backend's extra read endpoints) and computes overview, pace, insights,
recurring items, goals and net worth from the in-memory data, so mutations show up everywhere.
It follows the contract literally; when the backend documents a refinement (see
`docs/DECISIONS.md`), mirror it in the mock.

## Helpers for screens (`js/screens/_kit.js`)

| Helper | Usage |
|---|---|
| `commitLater(key, commit)` + `usePending()` | Undo for endpoints without an inverse: `const undo = commitLater('goal:' + id, () => api.deleteGoal(id)); toast({ text, action: { label: 'Herstel', onClick: undo } })`; lists filter out `usePending().has(key)`. Commits after ~5 s or when the page is hidden, then `invalidate()`. |
| `ConfirmSheet` | `openSheet(ConfirmSheet, { icon, title, lines, action, destructive, onConfirm })` for the few things that cannot be undone (undo import, restore). `onConfirm` may throw; the message shows in the sheet. |
| `copyText(text)` | Clipboard with an `execCommand('copy')` fallback (plain HTTP has no `navigator.clipboard`). Returns true/false. |
| `downloadFrom(api.backupUrl(), name)` | Starts a download (real URL or mock blob). |

Routes added: `#/instellingen/regels`, `#/instellingen/imports`, `#/instellingen/backup`,
`#/instellingen/aannames` (Slimme aannames, `screens/aannames.js`).

Calendar and recap (SPEC §14): `api.getCalendar(period)`, `api.getRecap({ period } | { year })`,
`api.getRecapIndex()`; the mock computes all three from its data (same schedule/matching rules
as DECISIONS "Calendar, yearly cost, recap", simplified) plus `per_year_cents` and
`subscriptions` on `/recurring`. Print: a screen that should print well adds an
`@media print` block in its own CSS (see `screen-terugblik.css`: light tokens via
`html:root:not(...)` so it wins over dark mode, chrome hidden, `break-inside: avoid`, a fixed
footer element).

API helpers added: `api.assumptions()`, `api.unignoreRecurring(key)`,
`api.forgetGoalLink(goal_id, description)`, `api.dismissInsight(id)`, `api.muteInsight(kind,
muted)`; `freqLabel(f, 'per' | 'every')` in `format.js`. The mock implements all of them (plus
`muted_insight_kinds`, `insight_kinds`, `assumptions` in `/settings`, `partial` trends periods,
2-/4-weekly items, an `overdue` potje and a `via:tikkie` intermediary).
`.seg-item` now centres its label (generic fix in `components.css`).

## Quality checklist (before you hand over a screen)

- [ ] Looks right at 320, 375, 768 and ≥ 1280 px wide, light and dark (gallery has a switch).
- [ ] No horizontal scroll; long names ellipsize; amounts never wrap (`.num`).
- [ ] Loading shows a skeleton shaped like the content, no spinner on a blank page, no layout
      jump when data arrives; revisiting renders cached data instantly.
- [ ] Empty states: one emoji/icon, a title of ≤ 3 words, at most one button. No paragraphs.
- [ ] Every tap gives feedback < 100 ms; mutations are optimistic with undo, never confirm().
- [ ] Sheets: header with Annuleer/Klaar or ✕, content in grouped lists, keyboard keeps the
      focused field visible, back gesture/Escape closes.
- [ ] All controls have labels; icon-only buttons have `aria-label`; charts have a text
      alternative; focus rings visible on keyboard use; tap targets ≥ 44 pt.
- [ ] Dutch microcopy with "je"; words from DESIGN §1 (bakje, potje, vaste lasten, normaal).
- [ ] Expenses never red; one accent colour; income green only.
- [ ] No console errors; works against the mock *and* follows SPEC field names literally.
