"""Zelfcontrole (GET /checks): verantwoordingsmeter, missing months, balance breaks and
transfers without their other half. Everything is synthetic."""

from __future__ import annotations

from book import book, today  # noqa: F401  (fixtures)


def checks(client):
    r = client.get("/api/checks")
    assert r.status_code == 200, r.text
    return r.json()


def test_coverage_counts_what_has_no_purpose(client, book):
    chk = book.account("Betaal", "checking")
    for m in ("2025-12", "2026-01", "2026-02"):
        book.tx(chk, f"{m}-01", -100000, "wonen", "Verhuurder", method="debit")
        book.tx(chk, f"{m}-10", -20000, "boodschappen", "Supermarkt", method="card")
        book.tx(chk, f"{m}-12", -5000, "contant", "Geldautomaat", method="atm")
        book.tx(chk, f"{m}-14", -3000, "unsorted", "Kiosk", method="card")
        book.tx(chk, f"{m}-25", 300000, "salaris", "Werkgever")
    book.commit()
    c = checks(client)["coverage"]
    assert c["months"] == 3 and c["spent_cents"] == 3 * 128000
    assert c["unknown_cents"] == 3 * 8000
    assert c["share"] == round(120000 / 128000, 4)
    assert [u["key"] for u in c["unknown"]] == ["contant", "unsorted"]
    assert c["unknown"][0]["per_month_cents"] == 5000
    # the same figure on Hoe staan we ervoor
    h = client.get("/api/overview").json()["health"]
    assert h["accounted"]["share"] == c["share"]


def test_missing_month_and_balance_break(client, book):
    chk = book.account("Betaal", "checking")
    book.tx(chk, "2025-11-03", -1000, "boodschappen", "Supermarkt", balance=99000)
    book.tx(chk, "2025-11-04", -2000, "boodschappen", "Supermarkt", balance=97000)
    book.tx(chk, "2025-11-04", 500, "inkomen-overig", "Terug", balance=97500)   # same day, any order
    # December was never imported
    book.tx(chk, "2026-01-05", -1500, "boodschappen", "Supermarkt", balance=80000)   # break: 96000 expected
    book.tx(chk, "2026-01-06", -1000, "boodschappen", "Supermarkt")                  # no balance on this row
    book.tx(chk, "2026-01-07", -1000, "boodschappen", "Supermarkt", balance=78000)   # 80000 − 1000 − 1000
    book.commit()
    c = checks(client)
    acc = c["accounts"][0]
    assert acc["missing_months"] == ["2025-12"]
    assert acc["breaks_count"] == 1
    assert acc["breaks"][0] == {"date": "2026-01-05", "expected_cents": 96000, "actual_cents": 80000,
                                "difference_cents": -16000}
    assert c["issues"] == 2


def test_transfer_without_its_other_half(client, book):
    chk = book.account("Betaal", "checking")
    sav = book.account("Spaar", "savings")
    book.tx(sav, "2026-01-02", 100, "inkomen-overig", "Rente", method="interest")
    book.tx(chk, "2026-01-10", -50000, "sparen", "Spaar", kind="transfer", to=sav, method="internal")
    book.tx(sav, "2026-01-11", 50000, "intern", "Betaal", kind="transfer", to=chk, method="internal")
    book.tx(chk, "2026-02-10", -30000, "sparen", "Spaar", kind="transfer", to=sav, method="internal")
    book.tx(sav, "2026-02-28", 100, "inkomen-overig", "Rente", method="interest")
    book.tx(chk, "2026-03-01", -1000, "boodschappen", "Supermarkt")
    book.commit()
    t = checks(client)["transfers"]
    assert t["count"] == 1
    assert t["items"][0]["date"] == "2026-02-10" and t["items"][0]["other_account"] == "Spaar"
