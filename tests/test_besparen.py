"""Bespaarlijst (GET /besparen), reserveren voor onregelmatige uitgaven and achteraf betalen.
Everything is synthetic; today is 15 March 2026."""

from __future__ import annotations

from datetime import date, timedelta

from book import book, today  # noqa: F401  (fixtures)

MONTHS = [f"{y}-{m:02d}" for y, m in [(2024, 9), (2024, 10), (2024, 11), (2024, 12)]
          + [(2025, m) for m in range(1, 13)] + [(2026, 1), (2026, 2)]]


def household(book):
    chk = book.account("Betaal", "checking")
    for i, m in enumerate(MONTHS):
        book.tx(chk, f"{m}-25", 300000, "salaris", "Werkgever")
        book.tx(chk, f"{m}-01", -100000, "wonen", "Verhuurder", method="debit")
        # Netflix went from € 14 to € 16 in December 2025
        book.tx(chk, f"{m}-05", -1600 if m >= "2025-12" else -1400, "abonnementen", "Netflix", method="debit")
        book.tx(chk, f"{m}-08", -12000, "energie", "Energiebedrijf", method="debit")
        book.tx(chk, f"{m}-09", -350, "overig", "Bank", method="fee")
        # eating out grew from € 100 to € 200 a month since September 2025
        book.tx(chk, f"{m}-12", -20000 if m >= "2025-09" else -10000, "uit-eten", "Restaurant", method="card")
    book.tx(chk, "2025-07-20", -180000, "vakantie", "Camping", method="ideal")
    book.tx(chk, "2025-12-10", -40000, "kleding", "Winkel", method="card")
    book.tx(chk, "2026-02-14", -12000, "winkelen", "Klarna", method="ideal")
    book.tx(chk, "2026-03-01", -100000, "wonen", "Verhuurder", method="debit", balance=150000)
    book.commit()
    return chk


def test_bespaarlijst(client, book):
    household(book)
    b = client.get("/api/besparen").json()
    subs = {i["name"]: i for i in b["subscriptions"]["items"]}
    assert subs["Netflix"]["per_year_cents"] == 1600 * 12
    rise = next(i for i in b["price_rises"]["items"] if i["name"] == "Netflix")
    assert (rise["from_cents"], rise["to_cents"], rise["extra_per_year_cents"]) == (1400, 1600, 2400)
    assert [i["name"] for i in b["contracts"]["items"]] == ["Energiebedrijf"]
    assert b["fees"]["bank_cents"] == 11 * 350          # 9 April 2025 … 9 February 2026
    higher = b["higher"]["items"]
    assert higher and higher[0]["now_cents"] == 20000 and higher[0]["then_cents"] == 10000
    assert higher[0]["extra_per_year_cents"] == 120000
    assert b["later"]["items"] == [{"name": "Klarna", "cents": 12000, "count": 1, "last_date": "2026-02-14"}]
    assert b["count"] >= 5


def test_achteraf_betalen_is_named_with_the_debts(client, book):
    household(book)
    d = client.get("/api/overview").json()["health"]["debts"]
    assert [x["name"] for x in d["later"]] == ["Klarna"]


def test_irregular_spending_gets_a_potje_suggestion(client, book):
    household(book)
    s = {x["name"]: x for x in client.get("/api/goals").json()["suggestions"] if x["kind"] == "irregular"}
    assert s["Vakantie"]["target_cents"] == 180000
    assert s["Kleding"]["target_cents"] == 40000
    # a potje with that name already exists: no suggestion
    client.post("/api/goals", json={"name": "Vakantie", "target_cents": 200000})
    s = [x["name"] for x in client.get("/api/goals").json()["suggestions"] if x["kind"] == "irregular"]
    assert "Vakantie" not in s


def test_a_car_is_no_saving_tip(client, book):
    """A big purchase or a car's waardeverlies does not make Auto & vervoer "meer dan vorig jaar"."""
    chk = household(book)
    for m in MONTHS:
        book.tx(chk, f"{m}-15", -15000, "vervoer", "Tankstation", method="card")
    car = book.tx(chk, "2025-11-20", -2500000, "vervoer", "Autobedrijf", method="debit")
    book.commit()
    higher = {x["category_id"] for x in client.get("/api/besparen").json()["higher"]["items"]}
    assert book.cats["vervoer"] not in higher                 # one purchase is no trend
    client.post("/api/assets", json={"kind": "possession", "name": "Auto", "tx_id": car})
    higher = {x["category_id"] for x in client.get("/api/besparen").json()["higher"]["items"]}
    assert book.cats["vervoer"] not in higher                 # waardeverlies is no habit either
