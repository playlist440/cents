# Cents: slimme functies bij vergelijkbare software

Onderzoek 2026-11-14. Bronnen zijn webzoekresultaten; veel productclaims komen uit reviews of marketing van concurrenten (gemarkeerd). Alles wat ik niet kon bevestigen staat onder "Niet geverifieerd". Geen functies verzonnen.
Rangorde = waarde voor een gezin / bouwinspanning, met voorkeur voor nul-configuratie. "Offline" = puur uit geimporteerde transacties, zonder bankkoppeling, cloud of LLM.

## 1. Shortlist (beste kandidaten)

### 1. Dagbedrag "nog te besteden per dag"
- Gebruiker ziet: onder "nog te besteden" ook een dagbedrag voor de resterende dagen van de maand.
- Aanbieders: Quicken Simplifi noemt een "Left this month"-cijfer plus dagelijkse toelage (zoekresultaat over Simplifi-hulppagina's, https://support.simplifi.quicken.com/en/articles/3620741-using-the-spending-plan-on-the-mobile-app). Gerelateerd: PocketGuard "safe to spend" (genoemd door Rocket Money-vergelijking, marketing: https://framer.rocketmoney.com/compare/copilot).
- Data: bestaand "nog te besteden" gedeeld door resterende dagen.
- Offline: ja. Inspanning: klein. Waarde: hoog (concreet, begrijpelijk, nul configuratie).
- NL: "Je kunt nog 23 euro per dag uitgeven tot 30 november."

### 2. Waarschuwing "saldo te laag voor komende vaste lasten"
- Gebruiker ziet: melding als het verwachte saldo vóór het einde van de maand onder nul (of onder een zelfgekozen drempel) zakt, met de datum.
- Aanbieders: Snoop waarschuwt als je niet genoeg geld hebt voor komende rekeningen (https://moneytothemasses.com/banking/snoop-app-review); Simplifi toont geprojecteerd saldo per toekomstige transactie (https://www.quicken.com/products/simplifi/v3/ via zoekresultaat).
- Data: huidig saldo + gedetecteerde vaste lasten + inkomsten met verwachte datum (Cents heeft dit al voor "verwacht eindsaldo").
- Offline: ja (accuraat tot de laatste import). Inspanning: klein. Waarde: hoog.
- NL: "Rond de 18e kom je waarschijnlijk 120 euro tekort op Betaalrekening, vóór je salaris binnenkomt."

### 3. Saldoverloop-grafiek (dag voor dag, komende 30-60 dagen)
- Gebruiker ziet: lijn van verwacht saldo, met stapjes bij elke verwachte vaste last en het salaris.
- Aanbieders: Simplifi (30-60 dagen, https://www.quicken.com/products/simplifi/v3/ en reviewbeschrijving), PocketSmith (dagelijks saldo, tot 30 jaar, https://www.pocketsmith.com/tour/cash-flow-forecasts), ING "Kijk Vooruit" 35 dagen (https://www.iculture.nl/nieuws/ing-mobiel-bankieren-toekomstige-uitgaven/), Rabobank "Voorspeld saldo" (https://www.rabobank.nl/particulieren/betalen/service/online-bankieren/geplande-voorspelde-afschrijvingen/).
- Data: zelfde als 2, plus gemiddeld variabel uitgavenpatroon per dag.
- Offline: ja. Inspanning: klein-middel (de rekenlaag bestaat al). Waarde: hoog; maakt "waarom is het eind van de maand krap" zichtbaar.
- NL: "Zo loopt je saldo de komende 5 weken: laagste punt 214 euro op 27 november."

### 4. Kalender met aankomende vaste lasten
- Gebruiker ziet: maandkalender met bedragen op de verwachte dagen; afgevinkt als de betaling is binnengekomen.
- Aanbieders: Monarch recurring-kalender met vinkje en melding 3 dagen vooraf (https://www.monarchmoney.com/whats-new/track-recurring-bills-and-subscriptions); PocketSmith behandelt budgetten als kalenderevenementen (https://www.pocketsmith.com/features/budgets-and-planning); Actual Budget "schedules" (https://actualbudget.org/docs/schedules).
- Data: bestaande terugkerende-detectie. Offline: ja. Inspanning: klein (presentatie). Waarde: middel-hoog.
- NL: "Donderdag 4 dec: Zorgverzekering 142 euro, Netflix 13,99 euro."

### 5. Jaarkosten per abonnement en totaal
- Gebruiker ziet: bij elk abonnement "per jaar" en een totaal "al je abonnementen kosten 1.840 euro per jaar", gesorteerd van duur naar goedkoop.
- Aanbieders: Emma subscriptions (https://emma-app.com/features/recurring-payments/), Rocket Money (https://www.rocketmoney.com/learn/personal-finance/does-rocket-money-work, marketing).
- Data: terugkerende detectie. Offline: ja. Inspanning: klein. Waarde: hoog (psychologisch effectief, nul configuratie).
- NL: "Je abonnementen kosten samen 1.840 euro per jaar; 4 zijn duurder geworden."

### 6. Maand- en jaarterugblik ("Wrapped")
- Gebruiker ziet: een vaste samenvattende pagina/kaarten: grootste uitgave, duurste maand, top-bakjes, besparingspercentage, vergelijking met vorig jaar; printbaar als PDF/A4.
- Aanbieders: "Year in Monzo" (https://www.trustedreviews.com/news/year-in-monzo-2019-how-see-least-fun-breakdown-your-past-year-3970012); Monarch/YNAB rapportages (zie 7).
- Data: bestaande jaaroverzicht-cijfers. Offline: ja. Inspanning: klein-middel. Waarde: middel-hoog (leuk, laag-frequent; goed bij jaarwisseling, ook handig voor belastingaangifte).
- NL: "Jouw 2026: 41.200 euro uitgegeven, 14% gespaard; duurste maand was juli."

### 7. Sankey: inkomen naar uitgaven
- Gebruiker ziet: stroomdiagram van salaris naar vaste lasten, bakjes en sparen.
- Aanbieders: Monarch Cash Flow Sankey (https://www.monarchmoney.com/visualize-your-cash-flow-like-never-before).
- Data: bestaande categorieen. Offline: ja. Inspanning: middel (SVG/D3 zonder externe request: eigen SVG renderen). Waarde: middel (mooi inzicht, geen actie).
- NL: "Van elke 100 euro inkomen gaat 38 naar vaste lasten, 24 naar boodschappen en 14 naar sparen."

### 8. Transactie splitsen over bakjes
- Gebruiker ziet: "Splitsen"-knop op een transactie (bijv. Action/Hema-bon: 20 euro kleding, 15 euro huishouden); totaal blijft kloppen.
- Aanbieders: Actual Budget (split-editor, https://actualbudget.org/docs/schedules en zoekresultaten over split-regels), Firefly III (https://docs.firefly-iii.org/explanation/firefly-iii/about/introduction/); Lunch Money noemt splitsen niet in mijn resultaten, dus niet geverifieerd.
- Data: handmatige invoer. Offline: ja. Inspanning: middel (datamodel, totalen, dubbel-tellen vermijden). Waarde: middel (bij supermarkt/warenhuizen echt nuttig, de rest zelden).
- NL: "Splits deze 48,30 euro: 30 euro boodschappen, 18,30 euro huishouden."

### 9. Doelprognose + "wat als ik 50 euro meer spaar"
- Gebruiker ziet: bij elk potje de verwachte einddatum bij het huidige tempo, en een schuifregelaar voor extra maandbedrag.
- Aanbieders: PocketSmith "what-if scenarios" (https://www.pocketsmith.com/tour/what-if-scenarios/); Firefly III piggy banks (zie 8).
- Data: bestaande potjes. Offline: ja. Inspanning: klein. Waarde: middel-hoog (motiverend; past bij bestaand "maandadvies").
- NL: "Met 50 euro extra per maand haal je 'Vakantie' in juni in plaats van oktober."

### 10. Zorgkosten en eigen risico bijhouden (NL-specifiek)
- Gebruiker ziet: voortgangsbalk "eigen risico gebruikt dit jaar" op basis van betalingen aan ziekenhuis, apotheek, huisarts, tandarts; verzekerde-uitkeringen niet zichtbaar, dus schatting.
- Aanbieders: ik vond geen concurrent die dit uit banktransacties doet; dit is een kans, geen gevalideerd patroon (zie "Niet geverifieerd"). Zorgverzekeraars tonen het in eigen app.
- Data: merchants + MCC (Cents heeft ze) + jaarlijks vast bedrag eigen risico (zelf instelbaar). Offline: gedeeltelijk (alleen wat via de bankrekening loopt; declaraties via de verzekeraar zijn niet zichtbaar).
- Inspanning: klein-middel. Waarde: middel (alleen relevant als ze zorg gebruiken; risico op onjuiste cijfers).
- NL: "Dit jaar al 212 van je 385 euro eigen risico aan zorg uitgegeven (schatting)." (controleer het actuele bedrag)

### 11. Banktarieven, valuta- en rentekosten opsporen
- Gebruiker ziet: één regel "dit jaar betaalde je 96 euro aan bankkosten en 31 euro aan valutatoeslag" met de lijst.
- Aanbieders: Snoop "avoid bank penalty fees" (https://moneytothemasses.com/banking/snoop-app-review, marketing).
- Data: omschrijvingen ("Kosten", "Rente", "Koersopslag", ASN-codes). Offline: gedeeltelijk (afhankelijk van hoe de bank het labelt; CAMT heeft transactiecodes). Inspanning: klein. Waarde: middel (bedragen zijn klein, maar het is een eenmalig "aha").
- NL: "Dit jaar betaalde je 42 euro aan kosten voor je betaalrekening en creditcard."

### 12. Regelvoorstellen en bulk herindelen
- Gebruiker ziet: "Al 5 keer heb je 'Jumbo Zwolle' naar Boodschappen gezet; ook de 14 oude transacties verplaatsen?"
- Aanbieders: Actual "Find schedules" en regels (https://actualbudget.org/docs/schedules); Firefly III regels (zie 8).
- Data: Cents leert al per merchant; dit is de bulk-actie en zichtbaarheid. Offline: ja. Inspanning: klein. Waarde: middel (vermindert Sorteren-werk).
- NL: "Alle 14 eerdere betalingen aan Albert Heijn ook naar Boodschappen?"

### 13. Gratis proefperiode en "eerste hoge afschrijving" signaleren
- Gebruiker ziet: bij een nieuw terugkerend bedrag dat opvallend hoger is dan de eerste (vaak kleine) betaling: "Proefperiode voorbij? Was 0,99 euro, nu 9,99 euro."
- Aanbieders: Rocket Money herinnert aan aflopende proefperiodes (https://apps.apple.com/app/1130616675, via zoekresultaat) — maar dit gebruikt daar bankkoppeling en eigen merchantdata; Emma/Snoop prijsstijgingen (https://emma-app.com/features/recurring-payments/).
- Data: terugkerende detectie die ook de eerste-twee-betalingen vergelijkt. Offline: gedeeltelijk (achteraf, niet vooraf: je ziet de eerste hoge afschrijving pas ná de proefperiode).
- Inspanning: klein (uitbreiding op prijswijziging). Waarde: middel.
- NL: "Spotify is van 0,99 naar 11,99 euro gegaan; proefperiode afgelopen?"

### 14. Vergelijking met Nibud-referentiebudget
- Gebruiker ziet: per bakje je uitgaven naast een gemiddelde voor een vergelijkbaar huishouden (gezinsgrootte, inkomen).
- Aanbieders: id.nl beschreef een vergelijking met Nibud-cijfers bij cashflow.nl (https://id.nl/huis-en-entertainment/computer-en-gaming/desktops-en-monitoren/vergelijk-online-uw-uitgaven-met-anderen, ongedateerd; mogelijk verouderd); Nibud publiceert jaarlijks referentiebudgetten volgens een commerciele site, niet bij Nibud zelf bevestigd.
- Data: statische tabel (jaarlijks handmatig bijwerken) + huishoudgrootte. Offline: ja, als je de tabel meelevert. Inspanning: middel (juiste cijfers, licentie, jaarlijks onderhoud, bakjes-mapping). Waarde: middel (leuk, maar gezinnen reageren soms defensief; cijfers kunnen misleiden).
- NL: "Je boodschappen liggen 18% boven het gemiddelde voor gezinnen met 2 kinderen."

## 2. Overige ideeen (lagere waarde of grotere inspanning)

| Idee | Wie heeft het | Offline? | Inspanning | Waarde | Opmerking |
|---|---|---|---|---|---|
| Weekdag-patroon / uitgaven-heatmap | niet geverifieerd bij een concurrent; wel gebruikelijk in dashboards | ja | klein | laag-middel | Leuk, geen actie |
| Afrondingen ("round-ups") als virtuele spaarsuggestie | Emma round-ups (https://emma-app.com/features/recurring-payments/ is subscriptions; round-ups via https://apps.apple.com/GB/app/id1270062373) | gedeeltelijk (zonder echte overboeking alleen "had je gespaard") | klein | laag | Echte round-up vereist bankkoppeling |
| Kosten per persoon/kind (tags per kind of "wie betaalde") | Monzo bill-splitting (bank-feature); in Cents bestaande tags | ja | klein-middel | middel | Via tag-groep ipv nieuwe structuur |
| Argwaan-score voor dubbele/onbekende afschrijving per merchant | Snoop (marketing) | ja | klein | laag | Cents heeft al dubbele-afschrijvingen |
| Zakgeld/kinderrekening | niet geverifieerd bij concurrent | ja | middel | laag-middel | Aparte potjes + handmatige invoer |
| Hypotheek-aflossing/restschuld | Fyrgo adverteert amortisatieschema (producthunt-resultaat, niet geverifieerd); Maybe: niet bevestigd | ja (met handmatige invoer) | middel | middel | Rente en looptijd zijn handmatig |
| Energie-jaarafrekening (voorschot vs. werkelijk) | niet gevonden bij concurrent | gedeeltelijk | middel | middel | Eigen hulpmiddel: som van maandtermijn + bijbetaling |
| Vakantiegeld/13e maand bij inkomstenvoorspelling | niet geverifieerd bij concurrent | ja | klein | middel | Gebruik bestaande vaste-lastendetectie voor inkomen |
| Jaaropgaaf / belastinghulp (giften, zorgkosten) | niet geverifieerd | gedeeltelijk | middel | laag-middel | Aangifte-regels veranderen jaarlijks |
| Toeslagen-tracker | niet geverifieerd | gedeeltelijk | middel | middel | Bedragen per maand van Belastingdienst-uitkering herkennen |
| Pensioen/huiswaarde | Maybe Finance (accounts als asset/liability, https://selfhosted-sh.pages.dev/maybe-personal-finance-self-hosted) | ja (handmatig) | klein | laag-middel | Net worth heeft al handmatige items |
| Ongedaan maken / wijzigingsgeschiedenis | niet geverifieerd per product | ja | middel | middel | Goed voor vertrouwen bij bulk-acties |
| Toetsenbord-sneltoetsen, CSV-/Excel-export | Standaard in desktop-tools | ja | klein | middel | Mac-eerst past |
| Bedrijfslogo's bij merchants | Copilot/Monarch (niet geverifieerd) | gedeeltelijk (alleen meegeleverde icoontjes, geen externe requests) | middel-groot | laag | Past slecht bij "geen externe requests" |
| Natuurlijke-taal zoeken zonder AI ("boodschappen vorige maand") | Starling Spending Intelligence is AI-gestuurd (https://moneyweek.com/personal-finance/savings/starling-bank-spending-intelligence-ai-tool) | ja (vaste syntax) | middel | laag-middel | Filterbalk met chips is eenvoudiger |
| Wekelijkse samenvatting (digest) | Lunch Money-nieuwsbrieven zijn product-nieuws, geen digest; niet geverifieerd | gedeeltelijk (zonder e-mail uitsturen) | klein-middel | laag | Zonder externe request alleen binnen de app |
| Kijk-vooruit "wat kost dit jaar nog" (resterende jaarlasten) | ING Kijk Vooruit (zie 3) | ja | klein | middel | Past bij bestaande "jaarrekening komt eraan" |

## 3. Bewust overslaan

- Automatisch bankkoppelen / realtime saldi (Copilot, Monarch, Simplifi, Dyme): breekt het "geen cloud, geen externe requests"-principe. Dyme werkt met ING, ABN AMRO, Rabobank, AmEx en N26 (https://financer.nl/persoonlijke-financien/dyme-app-review/).
- Abonnementen automatisch opzeggen, prijsonderhandeling (Rocket Money, Dyme): Rocket Money rekent 35-60% van de besparing volgens een review (https://www.fincomparelab.com/reviews/rocket-money-review/); Dyme stuurt een aangetekende brief (https://financer.nl/persoonlijke-financien/dyme-app-review/). Vereist een externe dienst.
- AI-chat over je uitgaven (Starling, Simplifi AI Assist https://www.quicken.com/products/simplifi-ai-assist/): LLM uitgesloten.
- Rekeningvergelijking/tarief-switch (Snoop): vereist externe prijsdata.
- Age of Money (YNAB): methodisch zwaar, past niet bij "simpel"; YNAB-uitleg https://www.ynab.com/blog/what-is-the-ideal-age-of-money.
- Dubbel-boekhouden (Beancount, GnuCash): te complex voor een gezin.
- Meervoudige valuta, beleggingsanalyse (Ghostfolio): buiten scope; handmatige beleggingen zijn genoeg.

## 4. Bronnen (zoals gebruikt)

- https://help.copilot.money/en/articles/11157550-quick-start-guide (Copilot Recurrings, uit zoekresultaat)
- https://framer.rocketmoney.com/compare/copilot (Rocket Money-vergelijking: marketing)
- https://www.monarchmoney.com/whats-new/track-recurring-bills-and-subscriptions
- https://www.monarchmoney.com/visualize-your-cash-flow-like-never-before
- https://www.quicken.com/products/simplifi/v3/
- https://support.simplifi.quicken.com/en/articles/3620741-using-the-spending-plan-on-the-mobile-app
- https://www.quicken.com/products/simplifi-ai-assist/
- https://www.pocketsmith.com/tour/cash-flow-forecasts
- https://www.pocketsmith.com/tour/what-if-scenarios/
- https://www.pocketsmith.com/features/budgets-and-planning
- https://actualbudget.org/docs/schedules
- https://docs.firefly-iii.org/explanation/firefly-iii/about/introduction/
- https://support.ynab.com/en_us/reflect-in-ynab-B1GJsrWkj
- https://www.ynab.com/blog/what-is-the-ideal-age-of-money
- https://emma-app.com/features/recurring-payments/
- https://moneytothemasses.com/banking/snoop-app-review
- https://apps.apple.com/GB/app/id1270062373 (Emma App Store)
- https://apps.apple.com/app/1130616675 (Rocket Money App Store)
- https://www.fincomparelab.com/reviews/rocket-money-review/
- https://www.iculture.nl/nieuws/ing-mobiel-bankieren-toekomstige-uitgaven/ (ING Kijk Vooruit, 2016)
- https://www.rabobank.nl/particulieren/betalen/service/online-bankieren/geplande-voorspelde-afschrijvingen/
- https://www.rabobank.nl/particulieren/online-bankieren/app/inzicht/veelgestelde-vragen
- https://www.iculture.nl/nieuws/abn-amro-grip-app-klanten-financieel-inzicht
- https://financer.nl/persoonlijke-financien/dyme-app-review/
- https://www.trustedreviews.com/news/year-in-monzo-2019-how-see-least-fun-breakdown-your-past-year-3970012
- https://moneyweek.com/personal-finance/savings/starling-bank-spending-intelligence-ai-tool
- https://id.nl/huis-en-entertainment/computer-en-gaming/desktops-en-monitoren/vergelijk-online-uw-uitgaven-met-anderen
- https://selfhosted-sh.pages.dev/maybe-personal-finance-self-hosted
- https://www.gnucash.org/features

## Niet geverifieerd

- Of Copilot een echte cashflowprognose of "safe to spend" heeft: bronnen spreken elkaar tegen; Copilot's eigen feature-request-bord vraagt er juist om.
- Of Monarch daadwerkelijk saldoprognose heeft: officiele bronnen noemen alleen recurring-kalender; prognose komt uit derde partijen.
- Niet onderzocht/niets gevonden: Lunch Money (detail), Spendee, Wallet/BudgetBakers, Toshl, Tiller, Fina, Origin, Empower, Plum, Cleo, Moneyhub, Buddy, Kasboek/Spendle, bunq, N26, Revolut-details, ezBookkeeping, Ghostfolio, Paisa, Sure, Apple Card insights. De bovenstaande lijst is dus niet volledig.
- ING Kijk Vooruit en Grip: bronnen zijn oud of ongedateerd; huidige functies niet bevestigd. ABN AMRO Grip is volgens opdracht stopgezet; dat heb ik niet zelf bevestigd.
- Nibud: geen Nibud-eigen pagina gevonden die vergelijking met vergelijkbare huishoudens bevestigt.
- Dutch-specifiek (eigen risico, toeslagen, jaaropgaaf, energie-afrekening, vakantiegeld): geen concurrent gevonden die dit uit banktransacties doet; kan betekenen dat het niet bestaat of dat ik het niet vond.
- Prijzen van producten (Dyme, Rocket Money): bronnen spreken elkaar tegen; niet gebruikt voor besluiten.
