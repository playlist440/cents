# Cents: inzichten, Nibud-defaults en slimme functies

Onderzoek november 2026. Webbronnen zijn voornamelijk secundair: de nibud.nl-pagina's waren niet direct op te halen (404). Alles met **[?]** is onzeker en moet vóór gebruik tegen nibud.nl worden gecontroleerd (BufferBerekenaar, Nibud-referentiebudgetten). Dit is geen financieel advies.

## 1. Wat huishoudens willen, gebruiken en laten liggen

**Gebruikt en geprezen**
- Overzicht van vaste lasten en abonnementen, automatisch herkend (Dyme: gratis laag toont dit al; Trustpilot/Financer waarderen vooral dit). Detectie is wel nooit volledig (gedeelde of nieuwe lasten). [Financer Dyme-review](https://financer.nl/persoonlijke-financien/dyme-app-review/)
- "Wat blijft er over deze maand?" als één getal. Grip (ABN AMRO) was populair om precies dit: uitgaven per categorie plus budgetten. [Tink case ABN AMRO](https://tink.com/blog/use-cases/abn-amro-use-case/)
- Goede automatische categorisering en rustig ontwerp (Copilot Money, vooral iOS). [Penny Hoarder](https://www.thepennyhoarder.com/budgeting/budgeting-copilot-money-review/)
- Nibud pleit zelf voor één betaaldag voor vaste lasten, omdat mensen dan weten waar ze aan toe zijn. [Banken.nl, juli 2025](https://www.banken.nl/nieuws/26298/een-betaaldag-voor-vaste-lasten-moet-beter-financieel-inzicht-geven)

**Grip gestopt**: niet door gebrek aan gebruik, maar omdat ABN AMRO de functies in de gewone bankapp onderbracht (losse app weg per 16 dec 2022; "minder apps"). Les: inzicht moet bij het dagelijkse moment zitten, geen aparte bestemming. [ABN AMRO](https://abnamro.com/en/news/merging-grip-with-the-abn-amro-app), [Financer](https://financer.nl/persoonlijke-financien/grip-app-review/)

**Waarom mensen afhaken** (overwegend blog/vendor-bronnen, indicatief)
- Achterstand: weken niet-gecategoriseerde transacties maken inhalen onoverzichtelijk, dus stoppen. [Gerald/WealthWise-type bronnen via zoekresultaat]
- Starre categorieën en rood/groen "over budget"-framing geven schuldgevoel.
- Leercurve en maandelijkse invoerplicht (YNAB). [Dev.to](https://dev.to/shahmeer/why-people-are-quietly-quitting-ynab-and-what-they-are-switching-to-1k9g)
- Bank-koppelproblemen. Voor Cents (handmatige import) is het omgekeerde risico: **vergeten te importeren**. Dus: duidelijke "laatst bijgewerkt"-melding, en alles moet ook met één import per maand al waardevol zijn.
- Cijfer uit WSJ (2020, via Inquirer): ~90% koppelde een bankrekening, slechts ~20% was na 3 maanden actief. [Inquirer](https://www.inquirer.com/business/mint-budgeting-app-shutting-down-tips-20231112.html)

**Wat genegeerd wordt**: gedetailleerde grafieken per subcategorie, handmatig budget per categorie instellen, beleggingsdashboards, "gamification"-badges. Wat blijft: één getal, een korte lijst "let op", en abonnementen.

## 2. Nibud-cijfers als defaults

| Gegeven | Waarde | Bron / zekerheid |
|---|---|---|
| Minimale buffer, paar met 2 kinderen (huurder, zonder auto) | € 12.400 | Financer, citeert Nibud; jaar niet vermeld **[?]** |
| Idem alleenstaande / paar zonder kids / paar 1 kind | € 6.400 / € 8.200 / € 9.000 | idem **[?]** |
| Gezin 2 kinderen, koopwoning, auto € 10.000 | € 28.300 of meer | idem **[?]** |
| Buffer in maanden | minimaal 3 maanden vaste lasten (absoluut minimum) | Financer noemt dit Nibud-advies **[?]** |
| Wat de buffer dekt | onverwacht: kapotte wasmachine, auto, inboedel, onderhoud woning, periode zonder werk. Doelsparen (vakantie, studie) hoort er buiten | [Financer](https://financer.nl/persoonlijke-financien/buffer-hoeveel-spaargeld-heb-ik-nodig/) |
| Spaarquote | 10% van netto inkomen als vuistregel | Bron inconsistent (Nibud of Financer) **[?]** |
| Vaste lasten | ideaal max 50% van netto inkomen; >60% is zorgelijk; modaal huishouden zat in 2019 net boven 55% | Nibud via [AVROTROS Radar](https://radar.avrotros.nl/artikelen/31502) / NOS-berichten, redelijk zeker |
| Woonquote | max ~35% van netto | rekenmachinepro (derde partij) **[?]** |
| Boodschappen, minimum, paar + 2 kinderen | ca. € 630 - 636 p/m (alleenstaande ca. € 273) | secundaire bronnen, verschillen **[?]** [Knab](https://bieb.knab.nl/inkomsten-uitgaven/boodschappen-per-maand-wat-is-normaal) |
| Werkelijk gemiddeld huishouden, boodschappen sep 2024 - aug 2025 | ca. € 585 p/m | transactie-analyse via zoekresultaat **[?]** |
| "Over"-kleurindicatie (derde partij) | > 10% van netto over = groen, 0-10% = oranje, negatief = rood | rekenmachinepro; ontwerpkeuze, geen Nibud |

**Nibud-indeling in vier groepen** (secundaire beschrijving van de minimumvoorbeeldbegrotingen juli 2025, [PDF](https://www.nvvk.nl/l/library/download/urn:uuid:a0154979-3659-4407-8462-4009aab6144c/nibud+minimumvoorbeeldbegrotingen+juli+2025%5B13%5D.pdf), niet leesbaar opgehaald):
1. **Vaste lasten**: huur/hypotheek, energie, water, telefoon/internet, verzekeringen, belastingen.
2. **Huishoudelijke uitgaven**: boodschappen, schoonmaak, verzorging; dagelijks, variabel.
3. **Reserveringsuitgaven**: kleding, inboedel, onderhoud huis/tuin; onregelmatig, dus reserveren.
4. **Sociale participatie / vrije tijd**: sport, uitjes, hobby's.

Praktisch Nibud-advies: aparte rekeningen of potjes voor vaste lasten, reserveringen/buffer en huishoudgeld (workshop-presentatie, [ASN Bank](https://asnbank.nl/downloads/presentatie-workshop-financien-in-balans.html)).

**Voor Cents (voorstel)**: map de eigen bakjes op deze vier groepen. Toon "vaste lasten" als % van inkomen met 50% als stille referentie. Gebruik bufferdoel = max(3 x gemeten vaste lasten, Nibud-tabel voor gezinstype) en laat de gebruiker dit overschrijven. Heel kleine maandelijkse bedragen niet als "norm" tonen; Nibud-bedragen zijn minima, geen gemiddelden.

## 3. Spaardoelen die werken

- **Volgorde**: eerst buffer (minimaal 1 maand vaste lasten als eerste mijlpaal, dan 3 maanden), daarna doelpotjes. Lopende doelen blijven doorlopen als buffer op 1 maand staat; geen harde blokkade.
- **Potje = doel + bedrag + datum.** Maandbedrag = (doelbedrag - gespaard) / resterende maanden, naar boven afgerond op € 5.
- **Jaarlijks terugkerend** (vakantie, verjaardagen, Sinterklaas/Kerst, APK, gemeentelijke belasting, verzekering per jaar): app leidt het bedrag af uit vorig jaar (som van de transacties in dat bakje/tag, plus ~3%), zodat het potje bijna zonder invoer ontstaat.
- **Achter op schema**: geen rood. Toon "Je loopt € 120 achter. Als je de komende 4 maanden € 30 extra opzij zet, haal je het." Alternatief tonen: datum opschuiven. Nooit het hele tekort in één maand voorstellen.
- **Voor op schema**: "Je bent op schema, niets te doen."
- **Opzij zetten zonder aparte rekening**: bij handmatige import is een potje een *virtuele* verdeling van het saldo op de spaarrekening. Een overboeking naar de spaarrekening wordt automatisch aan het potje gekoppeld (regel: tegenpartij IBAN = eigen spaarrekening). Eén overboeking, meerdere potjes: laat gebruiker verdelen, standaard gelijk naar urgentie.
- Werkt volgens Nibud-lijn: sparen voor doelen apart van de buffer ([Financer](https://financer.nl/persoonlijke-financien/buffer-hoeveel-spaargeld-heb-ik-nodig/)).

## 4. Top 12 slimme functies (gerangschikt)

Elke regel: UI-zin / rekenregel / minimum data / waarom. Alles 0-configuratie tenzij aangegeven.

1. **Wat is er over deze maand**
   - UI: "Je hebt nog € 640 over tot de volgende salaris."
   - Regel: saldo betaalrekening + verwachte inkomsten - nog verwachte vaste lasten (uit herkende terugkerende betalingen) tot volgende salarisdatum. Geen budget nodig.
   - Data: 2 maanden import, salaris herkend, terugkerende betalingen.
   - Waarom: het getal waar gezinnen om vragen; vervangt budgetten instellen. (Vergelijk "Hoeveel kan ik nog uitgeven", Grip-kern.)
2. **Vaste lasten op een rij**
   - UI: "Je vaste lasten zijn € 2.340 per maand (52% van je inkomen)."
   - Regel: terugkerende betalingen (zelfde tegenpartij, bedrag +-10%, interval 7/14/30/90/365 dagen, min. 3 keer, of 2 keer bij jaarlijks) genormaliseerd naar per maand; delen door gemiddeld netto inkomen.
   - Data: ~3 maanden. Waarom: Nibud-kerncijfer, Dyme-hoogtepunt.
3. **Abonnement veranderd of nieuw**
   - UI: "Netflix kost sinds mei € 2 meer." / "Nieuw abonnement: Disney+ € 9,99 per maand."
   - Regel: herkende reeks met bedragsverschil > 5%, of nieuwe reeks. Data: 3+ maanden. Waarom: concreet, direct bespaarbaar.
4. **Afwijking per bakje (alleen grote)**
   - UI: "Je boodschappen zijn deze maand € 85 hoger dan normaal."
   - Regel: uitgaven tot dag N van maand vs. mediaan van dezelfde periode in laatste 3-6 maanden; alleen tonen bij > € 50 én > 20%; max 2 meldingen per maand. Data: 3 maanden. Waarom: voorkomt budgetinstellen en grafiekruis.
5. **Terugkerende lasten die eraan komen**
   - UI: "Binnenkort: autoverzekering € 412 (rond 3 december)."
   - Regel: jaarlijkse/kwartaal-reeks, volgende datum = laatste + interval; toon 30 dagen vooruit. Data: 12+ maanden voor jaarlijks. Waarom: voorkomt schrik, voedt potjes.
6. **Potje-voortgang**
   - UI: "Vakantie: € 1.150 van € 2.400. Je loopt op schema."
   - Regel: zie sectie 3. Data: spaarrekening import. Waarom: sparen wordt zichtbaar.
7. **Buffer in maanden**
   - UI: "Je buffer dekt 2,4 maanden vaste lasten. Advies: minimaal 3."
   - Regel: saldo spaarrekening(en) aangemerkt als buffer / gemiddelde maandelijkse vaste lasten (+ boodschappen voor "kale levensstijl"-variant optioneel). Data: spaarsaldo + vaste lasten. Waarom: Nibud-kern, makkelijk te begrijpen.
8. **Gespaard deze maand**
   - UI: "Deze maand heb je € 300 gespaard (11% van je inkomen)."
   - Regel: som overboekingen naar eigen spaar/belegging / netto inkomen. Data: 1 maand. Waarom: spaarquote 10% als stille norm; positieve feedback.
9. **Vergelijking met vorig jaar/zelfde maand**
   - UI: "December was vorig jaar € 640 duurder dan een gewone maand."
   - Regel: maandtotaal vs. 12-maandsmediaan, voorspelling voor seizoensmaanden. Data: 12+ maanden. Waarom: voorbereiding op cadeaus, vakantie.
10. **Dubbel of vreemd**
    - UI: "Twee keer betaald aan Bol.com op 12 mei (€ 34,95). Klopt dat?"
    - Regel: zelfde tegenpartij + bedrag, ≤ 3 dagen, geen herkende reeks. Data: geen. Waarom: vertrouwen, lage ruis.
11. **Onverwacht grote uitgave**
    - UI: "Eenmalig € 1.280 bij Coolblue. Dit is geen vaste last."
    - Regel: enkele transactie > 3x mediaan van haar bakje en > € 250; vraag of er een potje of tag bij hoort. Data: 3 maanden. Waarom: voorkomt dat eenmalige pieken "afwijkingen" lijken.
12. **Import-herinnering en "klopt dit?"-stap**
    - UI: "Je laatste import is van 3 oktober. Nieuwe gegevens toevoegen?" / "12 betalingen nog zonder bakje."
    - Regel: dagen sinds laatste transactiedatum > 14; aantal ongecategoriseerde. Data: geen. Waarom: grootste afhaakrisico bij handmatige import; houdt alle andere inzichten kloppend.

Aanvullend, mits goedkoop: pinbetalingen per merchant-type (MCC) voor automatische bakjes; "Per maand voor X" i.p.v. per jaar.

### 5 dingen bewust weglaten
1. **Maandbudget per bakje instellen** (rood/groen "over budget"): veroorzaakt schuldgevoel en afhaken; vervangen door "ten opzichte van normaal".
2. **Beleggingsanalyse (rendement, allocatie)**: geen kerndoel; investeringen alleen als saldo-regel in vermogen.
3. **Gedetailleerde grafieken/trends per subcategorie en vrij rapportbouwen**: precies waar Firefly III te zwaar van werd.
4. **Contracten onderhandelen / opzegservice / commerciële aanbevelingen** (Dyme-model): verhoogt complexiteit, belangenverstrengeling, jaar-aan-jaar onderhoud.
5. **Gamification, streaks, badges, AI-chat**: ruis voor gezin zonder financiële interesse; nieuwe bronnen van privacy- en kostenrisico.

## 6. Nederlandse woordkeuze

**Gebruik**
- Toon: rustig, feitelijk, "je". Geen verwijt, geen uitroeptekens, geen vrolijke emoji's bij geld. Eén zin per inzicht, bedrag vooraan of in vet.
- "Over" of "nog over" (deze maand), "uitgegeven", "gespaard", "bijgeschreven", "afgeschreven".
- "Bakje" voor categorie: laagdrempelig en gekend (kies één woord per begrip: **bakje = uitgavencategorie, potje = spaardoel**).
- "Vaste lasten": iedereen kent het, ook Nibud-term. Houd het.
- "Abonnementen" apart van "vaste lasten" tonen waar nuttig (Netflix versus huur).
- "Buffer" of "financiële buffer" is gangbaar; leg niet uit, voeg alleen maanden toe ("2,4 maanden").
- "Normaal" in plaats van "gemiddelde/mediaan": "hoger dan normaal".
- "Rond" bij schattingen: "rond 3 december".
- Bedragen: "€ 1.234", zonder decimalen boven € 100, decimalen eronder.

**Vermijd**
- Jargon: cashflow, budgetteren, allocatie, reserveringsuitgaven (Nibud-term, vervang door "dingen die je later nodig hebt"), huishoudelijke uitgaven (liever "dagelijks"), saldo-prognose, transactie (zeg "betaling"), afschrijving versus bijschrijving mengen.
- "Je zit in de min", "overschrijding", "tekort"; gebruik "je loopt € X achter".
- Engelse labels (dashboard, insights, goals). De eigen Firefly-ervaring: UI draait in nl_NL, Engelse documentatietermen bestaan niet in het menu.

**Voorbeelden**
- Goed: "Je boodschappen zijn deze maand € 85 hoger dan normaal."
- Goed: "Vakantie: nog € 1.250 te sparen. Zet € 105 per maand opzij."
- Slecht: "Uw budget voor de categorie Boodschappen is met 14,2% overschreden."

## Bronnenlijst
- Financer, buffer 2026: https://financer.nl/persoonlijke-financien/buffer-hoeveel-spaargeld-heb-ik-nodig/
- Nibud pleit voor één betaaldag (Banken.nl): https://www.banken.nl/nieuws/26298/een-betaaldag-voor-vaste-lasten-moet-beter-financieel-inzicht-geven
- AVROTROS Radar, vaste lasten >50%: https://radar.avrotros.nl/artikelen/31502
- Nibud minimumvoorbeeldbegrotingen juli 2025: https://www.nvvk.nl/l/library/download/urn:uuid:a0154979-3659-4407-8462-4009aab6144c/nibud+minimumvoorbeeldbegrotingen+juli+2025%5B13%5D.pdf
- ABN AMRO over Grip: https://abnamro.com/en/news/merging-grip-with-the-abn-amro-app
- Grip review/alternatieven: https://financer.nl/persoonlijke-financien/grip-app-review/
- Dyme review: https://financer.nl/persoonlijke-financien/dyme-app-review/
- Copilot Money review: https://www.thepennyhoarder.com/budgeting/budgeting-copilot-money-review/
- Maandbudget gezin (derde partij): https://rekenmachinepro.nl/financien/maandbudget-gezin-nederland/
- Knab boodschappen: https://bieb.knab.nl/inkomsten-uitgaven/boodschappen-per-maand-wat-is-normaal

Niet onderzocht/niet gevonden: Buddy, Spendle/Kasboek, Emma, Monarch (detail), Apple Card-inzichten, en de officiële Nibud-BufferBerekenaar en -referentiebudget 2026. Aanbevolen vervolgstap: handmatig controleren op nibud.nl.
