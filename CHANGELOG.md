# Changelog

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
