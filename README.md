# Cents

Inzicht in het huishoudgeld van één gezin. Je importeert af en toe een bestand van je bank,
Cents sorteert alles in bakjes en laat zien wat er binnenkomt, wat vast is, wat je uitgeeft
en hoe je potjes ervoor staan.

- **Hoe staan we ervoor**: buffer, woonlasten, vaste lasten, sparen en schulden in vijf rustige
  regels, elk met één zin uitleg.
- **Nog te besteden** tot je salaris komt uit je betaalrekening; vrij spaargeld staat ernaast.

- Import van ASN-exports (CSV) en CAMT.053 (XML). Dubbele transacties worden herkend, ook als
  je dezelfde periode in het andere formaat importeert.
- Een bibliotheek met Nederlandse winkels, incassanten en winkelcodes zet de meeste betalingen
  vanzelf in het goede bakje. Wat je zelf sorteert, onthoudt de app voor die winkel.
- Vaste lasten en abonnementen worden herkend, inclusief prijsstijgingen, met een
  betaalkalender en de kosten per jaar.
- Potjes met een doelbedrag en een advies per maand, getoetst aan wat je echt overhoudt.
- Een terugblik per maand en per jaar, ook om af te drukken.
- Een grote aankoop die je jaren gebruikt kun je over maanden verdelen. Iets dat je later weer
  verkoopt, zoals een auto, wordt een bezitting: de waarde staat bij Vermogen en elke maand
  telt het waardeverlies, niet de aankoop.
- Elke aanname van de app is zichtbaar en aan te passen onder Instellingen → Slimme aannames.
- **Besparen**: abonnementen per jaar, wat duurder werd, contracten om te vergelijken, bank-
  en koerskosten, bakjes boven vorig jaar en achteraf betalen, op één plek.
- **Controle** (Instellingen): hoeveel van je uitgaven verantwoord is, en of er maanden of
  overboekingen ontbreken of een saldo niet aansluit, zodat je weet welke import nog mist.
- Beleggingen bij DEGIRO: importeer de Transacties-, Rekeningoverzicht- of Portefeuille-CSV en
  Cents toont de echte waarde van je fondsen, wat je inlegde en je resultaat.
- Beleggingen bij eToro: importeer het rekeningoverzicht (Account Statement, Excel). Telkens
  opnieuw vanaf 2020 exporteren mag: Cents voegt alleen nieuwe posities en boekingen toe.
- Alle gegevens staan in één bestand op je eigen server.

### Internet: standaard uit

Cents werkt standaard volledig lokaal: er gaat niets van je server naar internet.

Wil je dat de waarde van je fondsen vanzelf wordt bijgewerkt, zet dan **Instellingen → Slimme
aannames → Koersen automatisch ophalen** aan. De server haalt dan één keer per dag na 18:30 de
slotkoersen op:

- bij **Yahoo Finance** (`query1.finance.yahoo.com`, de openbare zoek- en grafiek-adressen,
  zonder sleutel of account): alleen de ISIN of tickercode van je fondsen;
- bij de **Europese Centrale Bank** (`www.ecb.europa.eu`, de dagelijkse wisselkoersen): alleen
  als een fonds in een andere munt dan de euro noteert.

Er gaan geen bedragen, aantallen, rekeningen of andere gegevens over jou mee; de User-Agent is
"Cents". Staat het uit, dan gebruikt Cents de koersen uit je DEGIRO-portefeuille-export of de
waarde die je zelf invult.

Wil je zeker weten dat het nooit aan kan, ook niet per ongeluk in de app, zet dan in de compose
onder `cents:` de regel `environment: [CENTS_OFFLINE=1]`. Dan weigert de server elke verbinding
naar buiten, wat de instelling ook zegt.

## Installeren met Portainer

1. Ga in Portainer naar **Stacks → Add stack**, geef de stack de naam `cents`.
2. Kies **Web editor** en plak de inhoud van [`docker-compose.yml`](docker-compose.yml).
3. Klik op **Deploy the stack**.
4. Open `http://<adres-van-je-server>:8085` en kies een wachtwoord.

Er zijn geen instellingen nodig. De gegevens staan in het volume `cents_data`.

### iPhone

Open de app in Safari, tik op **Deel** en kies **Zet op beginscherm**. Cents opent daarna
schermvullend, als een gewone app.

## Bijwerken

Elke wijziging in deze repository levert automatisch een nieuwe container op. In Portainer:
open de stack en kies **Pull and redeploy** (of laat Watchtower het doen).

## Back-up

In de app onder **Instellingen → Back-up en export** download je de volledige database. Dat
bestand zet je op dezelfde plek ook weer terug.

## Ontwikkelen

Zonder Docker, met [uv](https://docs.astral.sh/uv/):

```
CENTS_DATA_DIR=~/.cache/cents-dev uv run --python 3.12 --with-requirements requirements.txt \
  uvicorn cents.main:app --app-dir backend --port 8765
```

Testen: `uv run --python 3.12 --with-requirements requirements.txt --with-requirements requirements-dev.txt pytest -q`

Een verzonnen huishouden om mee te proberen: `python3 tools/make_demo_data.py`

Rekent de testmodus (`?mock=1`) hetzelfde als de echte app? `tools/mock_parity.py` laadt de
gegevens van de testmodus in de backend en vergelijkt alle bedragen (uitleg bovenin het bestand).

Ontwerp en afspraken staan in [`SPEC.md`](SPEC.md) en [`docs/`](docs/).

## Licentie

Cents is vrije software onder de [GNU Affero General Public License v3.0](LICENSE) of later.
Je mag het gebruiken, aanpassen en verspreiden. Wie een aangepaste versie verspreidt of als
dienst aan anderen aanbiedt, moet zijn broncode onder dezelfde licentie beschikbaar stellen.
Het wordt geleverd zonder enige garantie.

Copyright © 2026 playlist440

Werk van anderen dat is meegeleverd, staat met zijn licentie in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
