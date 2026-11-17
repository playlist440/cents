# Cents — UI design

Authoritative for the frontend. `docs/research/apple-ui.md` holds the Apple design tokens,
component CSS sketches, motion curves and the iOS Safari pitfalls: **use it as the base** for
tokens and components. Where that document and this one disagree, this one wins.
`docs/research/household-insights.md` explains what families want from the app.

## 1. Feel

It must feel like an app Apple could have shipped: calm, lots of air, large clear numbers,
one accent colour, real depth only where it helps (bars and sheets are translucent, content is
flat). Nothing shouts. No explanatory paragraphs: labels of one to three words, numbers, shapes.
Every tap answers instantly (pressed state within 100 ms, optimistic updates, undo instead of
confirm dialogs — never `alert`/`confirm`).

- Font: system (`-apple-system`, SF Pro). Hero numbers and ring centres use `ui-rounded`.
  Tabular numerals for every amount.
- Accent ("Cents green"): light `#1F9D6B`, dark `#34C77B`. Income is green. **Expenses are
  never red**; they use the primary label colour. Orange is the only warning colour and is used
  sparingly. Red is reserved for destructive actions.
- Money: `Intl.NumberFormat("nl-NL", {style:"currency", currency:"EUR"})`. Expenses are shown
  without a sign, income with `+`. Whole euros on overview tiles and charts, cents in lists.
- Light and dark mode follow the system. Reduced motion is respected.
- Emoji are the icons of bakjes, potjes and tags (shown in a rounded tile tinted with the item's
  colour). Chrome icons (tab bar, buttons) are a small inline-SVG set in SF-Symbols-like line
  style, stroke 1.75, drawn by us. No icon font, no external assets.
- Words: bakje (category), potje (savings goal), vaste lasten, nog te besteden, over, normaal.
  Address the user as "je". Avoid: transactie-jargon, budget, cashflow, overschrijding.

## 2. Navigation

Hash routes (`#/overzicht`, `#/transacties`, `#/potjes`, `#/vermogen`, `#/meer`, …). Pushed
screens and sheets add a history entry so the back gesture/button closes them. The document
scrolls (not an inner div); only sheets scroll internally.

- **iPhone (< 700 px):** translucent bottom tab bar with five tabs: **Overzicht · Transacties ·
  Potjes · Vermogen · Meer**. Large title that collapses into a translucent nav bar on scroll.
  Detail screens push in from the right with a back chevron and an edge-swipe back gesture.
  Sheets rise from the bottom with a grabber, medium and large detents, drag to dismiss.
- **700–999 px:** same tab bar, content in a centred column (max 720 px).
- **≥ 1000 px (iPad landscape, Mac):** translucent sidebar (260 px): Overzicht, Transacties,
  Potjes, Vermogen, Vaste lasten, Jaaroverzicht, Tags, then at the bottom Importeren (button)
  and Instellingen. Sheets become centred cards (max 560 px). Transacties is a split view
  (list + detail). Dropping a file anywhere on the window starts an import.
- Sorteren is not a tab. It is offered by a banner on Overzicht, by the import result and by
  Meer, and opens as a full-screen flow.
- A `+` button in the nav bar (top right) on Overzicht and Transacties opens a small menu:
  "Bankbestand importeren", "Uitgave toevoegen".
- Tapping the active tab scrolls to top, or pops to the tab's root.

## 3. Screens

### Login / first run
Centred app icon, the word "Cents", one password field, one button ("Ga verder"). First run:
title "Kies een wachtwoord", two fields. A hidden username field with value `gezin` plus
correct `autocomplete` attributes so iCloud Keychain saves and fills it. Wrong password: the
field shakes. Nothing else on the screen.

### Overzicht
A month switcher pill in the nav bar ("‹ november ›"); swiping the hero left/right also changes
month. Tapping the label opens a popover with a Maand / Jaar switch above a month grid or a
list of years ("2026 · tot nu", "2025 · heel jaar"). In year mode the pill reads "‹ 2026 tot
nu ›" and ‹ › (and swipe, ←/→) step through years; the URL keeps it (`?period=2026`). A year
shows: hero "Over in 2026 tot nu" / "Tekort in 2025" with inkomen and uitgegeven as subline;
instead of the pace chart stacked bars per month (vast, dagelijks, gespaard) with inkomen as a
line and the month's result in the read-out; tiles with the year total and "€ X per maand"
(Dagelijks: "vorig jaar € X" over the same months when the data covers them); "Waar het heen
ging" compared with the same months last year. No Nog te besteden, Tempo, buffer, warning, Binnenkort or
insights for a year (they are about now). Top to bottom (month):

1. **Hero.** Label "Nog te besteden tot 27 nov", a very large count-up amount (checking +
   savings minus potjes, vaste lasten until payday, credit card, the expected card settlement
   and normal daily spending until payday; never the buffer) with "≈ € 85 per dag" beside it.
   Negative stays negative, in the warning colour. Subline always "saldo 15 nov" (the oldest
   balance date), plus "salaris nog niet verwerkt — importeer" or "saldo verouderd —
   importeer". Tapping the amount opens a popover: each account balance with its date (stale
   ones marked), each deduction, the total. Under it one row "Gemiddeld per maand over (3 mnd)"
   "+ € 420 over" / "€ 150 tekort" with a twelve-month mini bar chart, then the buffer bar
   "Buffer € X van € Y · Z maanden", then the pace chart titled "Dagelijkse uitgaven – nog
   over" with "op koers" / "€ X boven normaal" (calm wording, no pressure): what is left of a
   normal month's daily spending as a solid line (below zero in the warning colour, with a zero
   line), "normaal" (median) dotted, today a dot; without history it shows plain cumulative
   "Uitgegeven". A **betaalrekening** warning card appears under the hero only when the
   projected checking balance before payday drops below the floor. Past months show "Over" or
   "Tekort" = income − fixed − daily (saving is not spending).
2. **Four tiles** (2 × 2 on iPhone, one row on wide screens): Inkomen · Vaste lasten ·
   Uitgegeven · Gespaard. Amount, and a hairline progress bar where an expected value exists
   (income received of expected, fixed paid of expected). Each tile opens the matching list.
3. **Sort banner** when merchants wait: "14 winkels zonder bakje" with a "Sorteren" button.
4. **Waar het heen ging.** A Wallet-style stacked capsule (one segment per bakje, colours of
   the bakjes), then a ranked list: emoji tile, name, amount, a thin bar relative to the
   largest, and a small chip only when it differs clearly from normal ("€ 40 meer",
   "€ 25 minder"). No pie or donut chart. A row opens the bakje detail.
5. **Insights.** Only actionable ones (import, duplicates, price changes, large/unusual
   spending, potjes behind, negative average); informational figures stay off. At most three cards (horizontal snap-scroll on iPhone, grid on wide screens):
   emoji, one sentence, optional amount. Tapping goes to the relevant place.
6. **Binnenkort.** The next fixed payments of this month: date, name, amount. Footer link
   "Alle vaste lasten".
7. **Potjes** peek: up to four small progress rings; opens Potjes.

Empty state (no data at all): only a large, friendly drop zone — icon, "Sleep je bankbestand
hierheen", button "Kies bestand", caption "CSV of XML". On iPhone the button opens the Files
picker.

### Bakje detail (push)
Emoji tile, name, this month's amount vs normal, a 12-month bar chart (scrub with a finger to
read a month), top winkels, then the transactions of the month. Edit button: name, emoji,
colour.

### Transacties
Sticky search field. A row of filter chips (Bakje, Tag, Rekening, Periode). List grouped per
day with sticky headers ("Vandaag", "Gisteren", "ma 3 nov") and the day total on the right.
Row: emoji tile in the bakje's colour, merchant name, second line "bakje · plaats" plus tag
chips, amount on the right. Infinite scroll. "Selecteer" switches to multi-select with a bottom
bar: "Bakje", "Tag". Unsorted rows show a dashed tile.

**Transaction sheet** (tap a row): header with large emoji tile, merchant, amount, date.
- Bakje: a grid of emoji tiles, current one highlighted; switch "Voor alle van Jumbo" (on by
  default). A change saves immediately; toast "12 betalingen naar Boodschappen · Herstel".
- Tags: chips with an inline add field (autocomplete, create on the fly, emoji optional).
- Notitie: one field.
- For savings transfers: "Potje" picker.
- "Details" (collapsed): omschrijving, rekening, betaalwijze, plaats, soort winkel.
- Merchant line: "23 keer · meestal € 41 · dit jaar € 950" with a sparkline.
Manual entries also have "Verwijder".

**Uitgave toevoegen** sheet: amount (large numeric input), wat (merchant), bakje tiles, datum,
rekening (defaults to the credit card when one exists), tags.

### Sorteren (full-screen flow)
Progress at the top ("3 van 14"). One card in the centre: merchant name large,
"8 betalingen · € 312 · laatst 3 nov", one sample line in small type. Below it the suggested
bakje as a big primary button (emoji + name), then a grid of all other bakjes. Tapping a bakje
makes the card fly into that tile and the next card springs in. "Sla over" as a text button.
Undo via toast. Private persons show 👤 and are skippable in one tap. End: "Alles gesorteerd"
with a quiet celebration. Desktop keys: 1–9 choose, space skips, ⌘Z undoes.

### Potjes
Header line: "In potjes € 3.240", and when a savings account is known "Spaarsaldo € 4.100 ·
nog vrij € 860". Then the advice row: "€ 420 per maand" with a quiet state ("past" with a check,
or "€ 85 meer dan je meestal overhoudt" in orange).
Grid of potje cards: Fitness-style ring with the emoji in the centre, name,
"€ 1.250 van € 3.000", "€ 175 per maand · juli 2027", state chip (Op schema, Loopt achter in
orange, Gehaald).
"Nog te verdelen": savings transfers without a potje, each with the potjes as one-tap chips.
Suggestions as dashed ghost cards ("Buffer · € 9.300", "Jaarlijkse rekeningen · € 96 per
maand") with a `+`.
**Nieuw potje** sheet: emoji, naam, doelbedrag, datum (optional), switch "Elk jaar".
**Potje detail** (push): large ring, saldo, advice sentence ("Met € 175 per maand haal je dit
in juli 2027"; when behind "Met € 210 per maand haal je het nog"), a card "Koppel je
spaaropdracht" with the 5-digit code in a pill and a copy button and the one line "Zet dit
nummer in de omschrijving", the history of entries, and buttons "Geld toevoegen",
"Saldo aanpassen", edit, archive.

### Vermogen
Hero: total with a Stocks-style line chart, range control 6M · 1J · Alles, scrubbing.
Grouped list of accounts: Betaalrekening, Spaarrekening, Beleggingen ("inleg € 12.000 ·
resultaat + € 1.340"), Creditcard ("open € 212"). Suggestion rows on top when the app found a
likely own account ("Is NL•• 1234 je spaarrekening?" Ja / Nee).
Account sheet: name, soort; investments: "Waarde bijwerken" (amount + date) and the value
history; credit card: "Uitgave toevoegen" and open amount. `+` adds a manual account.
**Woning** (last group): one row "Overwaarde € Z" with two quiet lines "Woning € X" and
"Hypotheek − € Y"; without a mortgage a single tinted row "Hypotheek toevoegen". The overwaarde
is part of the total and the chart (switch "Meetellen in vermogen"). Tap → sheet "Woning":
overwaarde, the parts with their estimated debt, "Jaaropgave <jaar> invullen" (per part three
amount fields: schuld op 31 december, betaalde rente, afgelost; "Ander jaar" for older years),
WOZ-waarde + peildatum, the switch and "Betaling" (the linked direct debit, changeable). First
time: number of parts (1-4) and their names, then the same form. The Gespaard tile on the
Overzicht adds a line "waarvan afgelost € X" when part of the saving is mortgage repayment.

### Vaste lasten
Hero: "€ 2.140 per maand", subline "€ 25.680 per jaar", and a bar "46 % van je inkomen".
Segmented control Uitgaven · Inkomsten. List grouped per bakje: name, amount, next date, a chip
when the frequency is not monthly ("per jaar"), badges "Nieuw", "€ 2 duurder", "Gestopt?".
Item sheet: history as small bars, the payments, "Geen vaste last" (ignore).

### Jaaroverzicht
Twelve months as stacked bars (vast, dagelijks, gespaard) with income as a line; scrub to read
a month; tap a month to open it in Overzicht. Below: bakjes with sparklines and totals, top
winkels, and "zelfde maand vorig jaar" when available.

### Tags
List of tags with totals. Tag detail: total, period, capsule per bakje, bars per month,
payments. New tag: name + emoji.

### Meer (iPhone) / Instellingen
Inset grouped list: Importeren · Sorteren (with count) · Vaste lasten · Jaaroverzicht · Tags ·
Bakjes. Then Instellingen: Maand begint op (dag 1–28), Geleerde regels, Importgeschiedenis
(with "Maak ongedaan"), Back-up en export, Wachtwoord wijzigen, Uitloggen. Version at the
bottom.

### Import sheet
Drop zone / file picker (multiple files, `accept=".csv,.xml,text/csv,text/xml,application/xml"`).
Per file a row that turns into a result: "128 nieuw · 9 al bekend". A new account appears as
an inline row to name it and pick the soort. Primary button afterwards: "Sorteer 14 winkels" or
"Klaar".

## 4. Quality bar

- Works one-handed on an iPhone SE width (320 px) up to a 27-inch display.
- Safe areas respected everywhere; added to the Home Screen it runs full screen with the right
  status bar style, icon and name.
- 60 fps scrolling with 5,000 transactions (windowed or paged list).
- Every chart has an accessible text alternative; all controls have labels; focus rings on
  keyboard use; minimum tap target 44 pt.
- Loading uses skeletons shaped like the content, never spinners on a blank page.
- All numbers animate between values (count-up/down), rings and bars draw in once.

## 5. Mac first (added later — this section takes priority)

The owner's main use is the **web app on a modern MacBook** (viewport roughly 1280–1728 px
wide, 800–1100 px high, Safari and Chrome). The iPhone layout is a bonus and must keep working
exactly as designed above. Everything below applies from 1000 px upward and must feel like a
native Mac app (Stocks, Reminders, Finder, System Settings), not like a phone screen centred in
a big window.

**Space.** The content pane uses the available width: fluid up to about 1200 px of content,
margins 32–40 px. No 720 px centred column. From 1000 to 1279 px the right-hand column of a
two-column screen moves below the left one. Most of a screen's key information is visible
without scrolling at 1512 × 945.

**Window chrome.** Sidebar 240 px (translucent): Overzicht, Transacties, Potjes, Vermogen,
Vaste lasten, Jaaroverzicht, Tags, and "Sorteren" with a count badge when merchants wait; at the
bottom Importeren and Instellingen. A translucent toolbar on top of the content pane: screen
title on the left, month switcher where relevant, a search field on the right that searches
transactions from any screen, and `+`. The large in-content title is dropped on desktop (the
toolbar carries the title), which wins vertical space.

**Density.** List rows 40–44 px, body text 13–14 px (macOS sizes; keep the type scale tokens
and add a desktop density layer). Cards keep their radius but use less padding. Tables have
column headers in small caps-less secondary text and right-aligned tabular amounts.

**Screens.**
- *Overzicht* — a dashboard on a 12-column grid. Row 1: hero (7 columns) with the amount and a
  large pace chart (about 220 px high, with axis hints and hover read-out); the four tiles as a
  2 × 2 block (5 columns). The sort banner spans the full width below when present. Row 2:
  "Waar het heen ging" (7 columns: capsule plus a compact ranked table with all bakjes, amount,
  share and the "normaal" difference); on the right (5 columns) Opvallend (stacked cards),
  Binnenkort and Potjes rings.
- *Transacties* — a worksheet. Toolbar with search and filter pop-up buttons. A dense table:
  day group headers, then columns tile + winkel, bakje (chip), tags, rekening (when more than
  one), bedrag. A fixed inspector on the right (380–420 px) shows the selected payment with the
  same content as the sheet. Click selects, ⌘-click and Shift-click multi-select (the bulk bar
  appears in the toolbar), ↑/↓ move, Enter focuses the inspector, right-click opens a context
  menu (Bakje ▸, Tag ▸, Kopieer bedrag, Toon alles van deze winkel). Column for bakje can be
  changed in place through a pop-up.
- *Potjes* — header numbers on one line with the advice at the right; cards in 3–4 columns; a
  potje opens in the inspector position (right) or as a pushed screen with two columns (ring and
  advice left, history right).
- *Vermogen* — chart large on the left (8 columns, about 320 px high, hover read-out), accounts
  on the right (4 columns) as a compact grouped list; totals per group; Woning last.
- *Vaste lasten* — hero numbers and the share-of-income bar on one row; below a table: naam,
  bakje, hoe vaak, volgende, per maand, with the badges inline; item details in the inspector.
- *Jaaroverzicht* — the chart full width (about 360 px high, hover read-out per month), then
  two columns: bakjes table with sparklines, and top winkels.
- *Sorteren* — the card centred with visible key hints (1–9, spatie), bakje tiles in up to
  six columns.
- *Instellingen, Bakjes, Tags* — System-Settings style: a narrow list of sections on the left
  of the content pane and the chosen section on the right.

**Pointer and keyboard.** Hover states on every interactive row, card and button; default
cursor on rows, pointer only on links; visible focus rings; tooltips on icon-only buttons.
Pickers and small forms open as popovers anchored to their control; only real tasks (import,
new potje, new expense) use a centred sheet. Shortcuts: `/` or ⌘K search, ←/→ previous/next
month (or year) on Overzicht, N new expense, I import, Esc closes, `?` shows a small shortcut list.
Never hijack browser shortcuts. Dropping a file anywhere imports it. Text in details and
amounts is selectable.
