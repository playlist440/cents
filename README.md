# Cents

Inzicht in het huishoudgeld van één gezin. Je importeert af en toe een bestand van je bank,
Cents sorteert alles in bakjes en laat zien wat er binnenkomt, wat vast is, wat je uitgeeft
en hoe je potjes ervoor staan.

- Import van ASN-exports (CSV) en CAMT.053 (XML). Dubbele transacties worden herkend, ook als
  je dezelfde periode in het andere formaat importeert.
- Een bibliotheek met Nederlandse winkels, incassanten en winkelcodes zet de meeste betalingen
  vanzelf in het goede bakje. Wat je zelf sorteert, onthoudt de app voor die winkel.
- Vaste lasten en abonnementen worden herkend, inclusief prijsstijgingen, met een
  betaalkalender en de kosten per jaar.
- Potjes met een doelbedrag en een advies per maand.
- Een terugblik per maand en per jaar, ook om af te drukken.
- Elke aanname van de app is zichtbaar en aan te passen onder Instellingen → Slimme aannames.
- Alle gegevens staan in één bestand op je eigen server. De app haalt niets van internet.

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

Ontwerp en afspraken staan in [`SPEC.md`](SPEC.md) en [`docs/`](docs/).
