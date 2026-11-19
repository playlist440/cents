# Changelog

## 1.1.4 — 2026-11-19

- Vaste lasten: elke uitgaande overboeking met een rekeningnummer wordt herkend aan rekeningnummer én omschrijving, niet alleen wat Cents als persoon herkende. Inkomende overboekingen (salaris) blijven op rekeningnummer.
- Detailscherm van een vaste last: bij elke betaling staat de omschrijving uit je bankbestand, en "Toon alle betalingen" laat de hele lijst zien. Zo zie je wat Cents bij die vaste last telt.

## 1.1.3 — 2026-11-19

- Vaste lasten: de omschrijving van een overboeking aan een persoon hoeft niet precies gelijk te zijn. "Zakgeld", "Zakgeld Tim", "zakgeld tim nov 2025" en een typefout als "Zakgeldd" horen bij dezelfde vaste opdracht. Duidelijk andere omschrijvingen ("Bioscoop") blijven apart. Potjes op je eigen spaarrekening worden niet zo samengevoegd.

## 1.1.2 — 2026-11-19

- Vaste lasten: overboekingen aan een persoon worden herkend aan rekeningnummer én omschrijving. Een vaste opdracht ("Zakgeld") staat los van losse overboekingen naar dezelfde persoon, ook bij hetzelfde bedrag. Omschrijvingen die elke keer anders zijn, vallen terug op het rekeningnummer. Heeft één persoon zo meer vaste posten, dan heten ze "Naam · Omschrijving".

## 1.1.1 — 2026-11-19

- Vaste lasten: een maandelijkse overboeking aan een persoon (zakgeld) blijft een vaste last, ook als er tussendoor andere, losse overboekingen naar dezelfde persoon gaan. Die regel ("een winkel waar je ook los komt") geldt alleen nog voor winkels en restaurants.

## 1.1.0 — 2026-11-19

Financiële controle: alle adviezen van de review verwerkt. Sommige bedragen veranderen hierdoor.

- Hypotheek: bij de jaaropgave vul je "Waarvan extra afgelost" in. Extra (boetevrij) aflossen telt niet meer mee in hoe Cents elke gewone maandbetaling verdeelt over aflossing en rente, en de geschatte restschuld daalt niet meer te snel. (Database-schema v12.)
- Nog te besteden: het salaris telt nooit als "komt nog binnen", ook niet als het door een weekend vóór de ingestelde salarisdag binnenkomt.
- Geld dat binnenkomt zonder bakje (tikkie, terugbetaling, Marktplaats) maakt de dagelijkse uitgaven lager in plaats van het inkomen hoger. Vanaf € 500 telt het als inkomen tot je het sorteert.
- Vaste lasten als deel van je inkomen rekent zonder aflossing, net als Over of tekort. De buffer blijft rekenen met de hele betaling.
- Zonder vaste lasten valt Cents terug op het middelste bedrag (mediaan) van zes maanden in plaats van het gemiddelde.
- Uitleg: nieuwe of aangevulde woorden voor bestedingsbudget, sparen min opnemen, geld zonder bakje, vrij spaargeld zonder buffer-potje, rente tegenover dividend, de creditcard in je vermogen en extra aflossen.

## 1.0.3 — 2026-11-19

- Nog te besteden rekent met sparen min opnemen: wat tot je salaris nog naar je spaarrekening gaat, min wat terugkomt (zoals het wekelijks terugstorten uit een boodschappen-potje). Het blijft geen inkomen, maar het geld dat terugkomt telt wel mee.

## 1.0.2 — 2026-11-19

- Geld van en naar je eigen rekeningen (spaarrekening, potjes, wekelijks terugstorten) telt nooit als vast inkomen of als vaste last. In Vaste lasten staat het samen onder één kopje: "Sparen en potjes".
- Het salaris dat Cents voor de vooruitblik gebruikt, kan geen overboeking van je eigen spaarrekening meer zijn.

## 1.0.1 — 2026-11-19

- Hypotheek koppelen biedt geen betaling meer aan die al bij een andere schuld hoort. "Niet koppelen" krijgt een vinkje als het gekozen is.
- Schuld: eerdere bedragen staan met een minteken, net als het huidige bedrag.
- Sorteren: "Volgende" sorteert op vroegst of laatst eerst, "Hoe vaak" op vaakst eerst. Geen "Z–A" meer bij datums.
- Terugblik: "Aandeel" is een eigen sorteerkolom met het juiste label.
- Importgeschiedenis past op de iPhone: de regels lopen door en de knop heet "Terugdraaien".
- Mac: ⇧-klik voegt een reeks toe aan regels die je met ⌘ koos, zoals in de Finder.

## 1.0.0 — 2026-11-19

De eerste stabiele versie. Cents vervangt Firefly III voor een huishouden: bankbestanden importeren,
bakjes, vaste lasten, potjes, vermogen, hypotheek en inzichten, op de Mac en op de iPhone.

### Bugronde voor 1.0
- Vaste lasten: elke post is stabiel, ook als een betaling één keer naar een andere rekening ging.
  Een betaling aan het eind van de maand blijft aan het eind van de maand staan, en nummering verspringt niet meer.
- Vaste lasten via de creditcard tellen niet dubbel mee in de vooruitblik of in "te laat".
- "Te laat" wacht bij twee- en vierwekelijkse betalingen niet langer dan de helft van de periode, en negeert bedragen die sterk afwijken.
- Na een bulkwijziging laat de inspector de nieuwe bakjes zien.
- Een nieuwe zoekopdracht of filter begint bovenaan de lijst.
- Het blok Bezitting en de kostenverdeling passen binnen de inspector. Openen scrolt niet meer met de pagina mee.
- Popovers sluiten als je van scherm wisselt.
- Lange toelichtingen bij Vermogen lopen netjes af en duwen geen kaarten meer weg.
- Filters op bakje en tag blijven staan op de iPhone (het sluiten van het blad zette ze terug).
- Bedragvelden selecteren hun waarde bij een tik, zodat typen de waarde vervangt.
- Een nieuwe bezitting krijgt de naam van de winkel, niet altijd "Auto".
- Jaaroverzicht: de voetnoot loopt door op de volgende regel. Terugknoppen heten niet meer "Terug naar Terug".
- Jaaropgave: als bewaren nog niet kan, staat er wat je nog moet invullen.
- Een rooktest roept elk scherm aan na elk soort wijziging. Geen enkel antwoord mag een serverfout zijn.
- Het Docker-image krijgt ook het versielabel (`:1.0.0`) naast `:latest`.
