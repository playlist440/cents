# eToro rekeningoverzicht (Account Statement, xlsx)

Exporteren: eToro → Instellingen/Portfolio → **Account Statement** → periode → Excel.
De taal van de tabbladen volgt de taal van eToro (Nederlands of Engels); beide worden gelezen.

| Tabblad (NL / EN) | Gebruik in Cents |
|---|---|
| Accountoverzicht / Account Summary | niet (totalen in USD) |
| Holdings | halfjaarlijkse snapshots van open posities → koers in EUR per datum (`prices.source = 'etoro'`), ISIN, aantal |
| Gesloten posities / Closed Positions | per Positie-ID: bedrag (USD), eenheden, open/sluitdatum, winst USD en EUR → koop + verkoop |
| Accountactiviteit / Account Activity | Storten → deposit (EUR uit Details), Opnameverzoek → withdrawal, Opnamekosten/Overnight-kosten → fee, Dividend → dividend; Positie openen → inleg per open positie. Kopiëren, Stop Loss, corp action worden overgeslagen |
| Dividend, Financieel overzicht, Glossary | niet |

- Datums zijn dag-eerst: `31/12/2024 14:05:09`; Snapshot Date is een Excel-datum.
- De rekening is in USD. Omrekening naar EUR met de koers die het bestand zelf geeft, het dichtst
  bij die dag: Winst (USD)/Winst (EUR), Value in USD/Value in EUR, storting USD/EUR.
- Een gesloten positie: koop = Bedrag / koers bij openen, verkoop = koop + Winst (EUR). Dat klopt
  ook met hefboom (CFD).
- Eenheden komen uit Gesloten posities of de laatste Holdings-snapshot, zodat een split al verwerkt is.
- Dedupe: trades op `etoro|rekening|Positie-ID|open/close`, boekingen op datum+tijd+soort+ID+bedrag.
  Een positie zonder ISIN (crypto, CFD) krijgt `ETORO-<ticker>`; komt de ISIN later mee, dan
  wordt die bijgewerkt.
- Bekende grenzen: open posities met hefboom of short worden gewaardeerd als gewone aandelen;
  de laatste koers is die van de laatste snapshot (eind juni/december) tenzij koersen ophalen aan staat.
