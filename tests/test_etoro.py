"""eToro account statement (xlsx): positions keyed on Positie-ID, USD -> EUR, re-import."""

from __future__ import annotations

import io
import zipfile
from xml.sax.saxutils import escape

from conftest import upload
from cents import db
from cents.importers import etoro
from cents.services import investments

ASML, SIE = "NL0010273215", "DE0007236101"


def xlsx(sheets: dict[str, list[list]]) -> bytes:
    """A minimal workbook with inline strings (what eToro's export reads like)."""
    def cell(v, r, c):
        ref = f"{chr(65 + c)}{r + 1}"
        if isinstance(v, (int, float)):
            return f'<c r="{ref}"><v>{v}</v></c>'
        return f'<c r="{ref}" t="inlineStr"><is><t>{escape(str(v))}</t></is></c>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        wb, rels = [], []
        for i, (name, rows) in enumerate(sheets.items(), 1):
            wb.append(f'<sheet name="{escape(name)}" sheetId="{i}" r:id="rId{i}"/>')
            rels.append(f'<Relationship Id="rId{i}" Type="worksheet" Target="worksheets/sheet{i}.xml"/>')
            body = "".join(f'<row r="{r + 1}">' + "".join(cell(v, r, c) for c, v in enumerate(row) if v is not None)
                           + "</row>" for r, row in enumerate(rows))
            z.writestr(f"xl/worksheets/sheet{i}.xml",
                       '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                       f"<sheetData>{body}</sheetData></worksheet>")
        z.writestr("xl/workbook.xml",
                   '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                   f"<sheets>{''.join(wb)}</sheets></workbook>")
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   f"{''.join(rels)}</Relationships>")
    return buf.getvalue()


ACT = ["Datum", "Type", "Details", "Bedrag", "Eenheden", "Wijziging in gerealiseerd eigen vermogen",
       "Gerealiseerd vermogen", "Saldo", "Positie-ID", "Activatype", "NWA"]
CLOSED = ["Positie-ID", "Actie", "Long / Short", "Bedrag", "Eenheden", "Openingsdatum", "Sluitingsdatum",
          "Hefboom", "Spreadkosten (USD)", "Marktspread (USD)", "Winst (USD)", "Winst (EUR)", "Type", "ISIN"]
HOLD = ["Snapshot Date", "Asset", "Position ID", "Direction", "Open Date", "Leverage", "Open Rate", "Units",
        "Current Rate", "Value in USD", "Value in EUR", "Type", "ISIN"]


def statement(extra_activity=()):
    act = [ACT,
           ["02/01/2024 10:00:00", "Storten", "1000.00 EUR CreditCard", 1100, "-", 1100, 1100, 1100, "-", "-", 0],
           ["03/01/2024 10:00:00", "Positie openen", "ASML.NV/EUR", 550, "1.000000", 0, 1100, 550, "111", "Aandelen", 0],
           ["03/01/2024 11:00:00", "Positie openen", "SIE.de/EUR", 220, "2.000000", 0, 1100, 330, "222", "Aandelen", 0],
           ["01/03/2024 09:00:00", "Winst/verlies van handelstransactie", "SIE.de/EUR", 22, "2.000000", 22, 1122, 572, "222", "Aandelen", 0],
           ["15/03/2024 09:00:00", "Dividend", "ASML.NV/EUR", 11, "-", 11, 1133, 583, "111", "Aandelen", 0],
           ["16/03/2024 09:00:00", "Overnight-kosten", "Dagelijks", -1.1, "-", -1.1, 1132, 582, "111", "CFD", 0],
           ["01/04/2024 09:00:00", "Beginnen met kopiëren", "SomeTrader", 0, "-", 0, 1132, 582, "999", "-", 0],
           *extra_activity]
    closed = [CLOSED, ["222", "Siemens Aktiengesellschaft (SIE)", "Long", 220, 2, "03/01/2024 11:00:00",
                       "01/03/2024 09:00:00", 1, 0, 0, 22, 20, "Aandelen", SIE]]
    hold = [HOLD, [45473, "ASML Holding NV", "111", "Long", "03/01/2024 10:00:00", "X1", 500, 1, 600, 660, 600, "Stocks", ASML]]
    return xlsx({"Accountoverzicht": [["Details"]], "Holdings": hold, "Gesloten posities": closed,
                 "Accountactiviteit": act, "Dividend": [["Datum van betaling"]]})


def test_detect_and_parse():
    from cents.importers.detect import detect
    raw = statement()
    assert detect(raw) == "etoro"
    d = etoro.parse(raw)
    pos = {p["pid"]: p for p in d["positions"]}
    assert pos["222"]["cost_cents"] == 20000 and pos["222"]["proceeds_cents"] == 22000   # 220 USD @1.1, +20 EUR
    assert pos["111"]["close"] is None and pos["111"]["isin"] == ASML
    kinds = sorted(e["kind"] for e in d["events"])
    assert kinds == ["deposit", "dividend", "fee"]
    assert next(e for e in d["events"] if e["kind"] == "deposit")["amount_cents"] == 100000  # EUR from details
    assert d["prices"] == [{"isin": ASML, "date": "2024-06-30", "close_eur": 600.0, "close": 600.0}]


def test_import_creates_etoro_account_and_reimport_is_idempotent(client):
    client.post("/api/accounts", json={"name": "DEGIRO", "type": "investment"})
    f = upload(client, ("etoro.xlsx", statement()))["files"][0]
    assert f["ok"] and f["format"] == "etoro" and f["account_name"] == "eToro"
    assert f["new"] == 6                       # 3 trades + deposit, dividend, fee
    later = statement([["01/09/2024 09:00:00", "Opnameverzoek", "-", -110, "-", -110, 1022, 472, "-", "-", 0]])
    g = upload(client, ("etoro.xlsx", later))["files"][0]
    assert g["new"] == 1 and g["duplicates"] == 6
    c = db.connect(client.app.state.db_path)
    h = investments.holdings(c, f["account_id"], today="2024-07-01")
    c.close()
    asml = next(x for x in h["holdings"] if x["isin"] == ASML)
    assert asml["quantity"] == 1 and asml["value_cents"] == 60000
    assert h["invested_cents"] == 90000 and h["invested_source"] == "degiro"
