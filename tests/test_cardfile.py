"""Creditcard-invulbestand: download, fill in, import; the settlement does not count twice."""

from __future__ import annotations

import io
import zipfile

from book import book, today  # noqa: F401  (fixtures)
from cents.importers import card_xlsx
from cents.importers.etoro import read_workbook


def filled(rows: list[list]) -> bytes:
    """The real template with rows written into the Creditcard sheet."""
    raw = card_xlsx.template(["Boodschappen", "Uit eten & bezorgen"])
    zin = zipfile.ZipFile(io.BytesIO(raw))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zout:
        for name in zin.namelist():
            data = zin.read(name).decode()
            if name == "xl/worksheets/sheet1.xml":
                body = "".join(
                    f'<row r="{i}">' + "".join(
                        (f'<c r="{"ABCD"[j]}{i}"><v>{v}</v></c>' if isinstance(v, (int, float))
                         else f'<c r="{"ABCD"[j]}{i}" t="inlineStr"><is><t>{v}</t></is></c>')
                        for j, v in enumerate(row) if v is not None) + "</row>"
                    for i, row in enumerate(rows, start=2))
                head_end = data.index("</row>", data.index("<sheetData>")) + len("</row>")
                data = data[:head_end] + body + data[data.index("</sheetData>"):]
            zout.writestr(name, data)
    return out.getvalue()


def upload(client, content: bytes):
    r = client.post("/api/import", files=[("files", ("creditcard.xlsx", content, "application/octet-stream"))])
    assert r.status_code == 200, r.text
    return r.json()["files"][0]


def test_template_downloads_and_reads_back(client):
    r = client.get("/api/creditcard/template")
    assert r.status_code == 200 and r.content[:2] == b"PK"
    book = read_workbook(r.content)
    assert card_xlsx.looks_like(book) and "uitleg" in book and "bakjes" in book


def test_import_counts_once_with_the_settlement(client, book):
    chk = book.account("Betaal", "checking")
    for m in ("2026-01", "2026-02"):
        book.tx(chk, f"{m}-25", 300000, "salaris", "Werkgever")
    # the monthly card bill on the checking account, sorted as Creditcard (as the library does)
    book.tx(chk, "2026-02-24", -8000, "creditcard", "International Card Services", method="debit")
    book.commit()
    res = upload(client, filled([
        ["03-02-2026", "Bol.com", 50, "Boodschappen"],      # date as text, amount as number
        [46063, "Restaurant De Kade", "30,00", None],         # Excel date serial (09-02-2026)
    ]))
    assert res["ok"] and res["new"] == 2 and res["format"] == "card_xlsx"
    accounts = client.get("/api/accounts").json()
    card = next(a for a in accounts if a["type"] == "credit")
    feb = client.get("/api/overview?period=2026-02").json()
    cats = {c["category_id"]: c["spent_cents"] for c in feb["categories"]}
    ids = {c["key"]: c["id"] for c in client.get("/api/categories").json()}
    assert cats[ids["boodschappen"]] == 5000
    assert cats.get(ids["creditcard"], 0) == 0                 # the € 80 bill is fully explained
    assert feb["daily_cents"] == 8000                         # 50 + 30, not 160
    txs = client.get("/api/transactions", params={"account_id": card["id"]}).json()["items"]
    assert {t["merchant_name"] for t in txs} >= {"Bol.com"}


def test_reimport_adds_only_new_rows_and_follows_edits(client, book):
    chk = book.account("Betaal", "checking")
    book.tx(chk, "2026-01-25", 300000, "salaris", "Werkgever")
    book.commit()
    first = upload(client, filled([["03-02-2026", "Bol.com", 50, None], ["05-02-2026", "Kiosk", 4, None]]))
    assert first["new"] == 2
    again = upload(client, filled([["03-02-2026", "Bol.com", 50, None], ["05-02-2026", "Kiosk", 4, None],
                                   ["07-02-2026", "Bol.com", 50, None]]))
    assert (again["new"], again["duplicates"], again["removed"]) == (1, 2, 0)
    edited = upload(client, filled([["03-02-2026", "Bol.com", 50, None], ["07-02-2026", "Bol.com", 50, None]]))
    assert edited["removed"] == 1                              # the kiosk row was taken out


def test_errors_name_the_row(client, book):
    res = upload(client, filled([["03-02-2026", "Bol.com", None, None]]))
    assert not res["ok"] and "Rij 2" in res["error"]
