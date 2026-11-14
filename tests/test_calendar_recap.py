"""Payment calendar, yearly cost, bank/fx insights and the recap (SPEC 14)."""

from __future__ import annotations

from datetime import date, timedelta

from book import book, today  # noqa: F401  (fixtures)
from cents.services import insights, ledger, recurring, summary

E = "€ "


def months(first: str, n: int) -> list[str]:
    y, m, d = (int(x) for x in first.split("-"))
    out = []
    for i in range(n):
        yy, mm = divmod(m - 1 + i, 12)
        out.append(date(y + yy, mm + 1, d).isoformat())
    return out


def items_by_day(cal):
    return {(d["date"], i["name"]): i for d in cal["days"] for i in d["items"]}


# ---------------------------------------------------------------------------- calendar

def calendar_household(book):
    """Today 15 March 2026; imported data until 11 March (data today = 14 March)."""
    chk = book.account("Betaal", "checking")
    sav = book.account("Spaar", "savings")
    for d in months("2025-10-01", 6):
        book.tx(chk, d, -100000, "wonen", "Huur", method="debit")
    for d in months("2025-10-25", 5):
        book.tx(chk, d, 300000, "salaris", "Werkgever")
    for d in months("2025-10-05", 5):                       # March missing
        book.tx(chk, d, -4000, "verzekeringen", "Polis", method="debit")
    for d in months("2025-10-10", 6):
        book.tx(chk, d, -2500, "telecom", "Telefoon", method="debit")
    book.tx(chk, "2026-03-11", -2500, "telecom", "Telefoon", method="debit")   # charged twice
    for d in months("2025-10-26", 5):
        book.tx(chk, d, -50000, "sparen", "Spaar", kind="transfer", to=sav)
    for i in range(5):                                       # every 14 days from 5 January
        book.tx(chk, (date(2026, 1, 5) + timedelta(days=14 * i)).isoformat(), -20000,
                "opvang-school", "Opvang", method="debit")
    for d in ("2025-04-15", "2025-07-15", "2025-10-15", "2026-01-15"):
        book.tx(chk, d, -11800, "belastingen", "Wegenbelasting", method="debit")
    book.commit()
    return chk


def test_calendar_current_period(client, book):
    calendar_household(book)
    cal = client.get("/api/calendar").json()
    assert cal["period"]["id"] == "2026-03"
    got = {(d, n): (i["status"], i["amount_cents"]) for (d, n), i in items_by_day(cal).items()}
    assert got == {
        ("2026-03-01", "Huur"): ("paid", -100000),
        ("2026-03-02", "Opvang"): ("paid", -20000),
        ("2026-03-05", "Polis"): ("missed", -4000),
        ("2026-03-10", "Telefoon"): ("paid", -2500),          # one paid, the duplicate is not shown
        ("2026-03-16", "Opvang"): ("expected", -20000),
        ("2026-03-25", "Werkgever"): ("expected", 300000),
        ("2026-03-26", "Spaar"): ("expected", -50000),
        ("2026-03-30", "Opvang"): ("expected", -20000),
    }
    assert cal["out"] == {"paid_cents": 122500, "expected_cents": 90000, "missed_cents": 4000}
    assert cal["in"] == {"paid_cents": 0, "expected_cents": 300000}
    paid = items_by_day(cal)[("2026-03-01", "Huur")]
    assert paid["transaction_id"] and paid["direction"] == "out" and paid["key"].startswith("huur|out|monthly")
    assert items_by_day(cal)[("2026-03-16", "Opvang")]["transaction_id"] is None
    # consistent with the overview: what is still to come of the fixed costs
    o = client.get("/api/overview").json()
    fixed_left = sum(-i["amount_cents"] for (d, n), i in items_by_day(cal).items()
                     if i["status"] != "paid" and n in ("Polis", "Opvang"))
    assert fixed_left == 44000 == o["fixed_upcoming_cents"]


def test_calendar_past_and_future(client, book):
    calendar_household(book)
    feb = client.get("/api/calendar?period=2026-02").json()
    assert all(i["status"] == "paid" for d in feb["days"] for i in d["items"])
    assert feb["out"]["paid_cents"] == 100000 + 4000 + 2500 + 50000 + 2 * 20000
    assert feb["in"]["paid_cents"] == 300000
    apr = client.get("/api/calendar?period=2026-04").json()
    got = {(d, n): i["status"] for (d, n), i in items_by_day(apr).items()}
    assert set(got.values()) == {"expected"}
    assert ("2026-04-15", "Wegenbelasting") in got                  # quarterly
    assert [d for d, n in got if n == "Opvang"] == ["2026-04-13", "2026-04-27"]
    assert apr["out"]["missed_cents"] == 0
    assert client.get("/api/calendar?period=2027-03").status_code == 200    # 12 ahead
    assert client.get("/api/calendar?period=2027-04").status_code == 400
    assert client.get("/api/calendar?period=0001-01").status_code == 400
    old = client.get("/api/calendar?period=2024-01").json()
    assert old["days"] == [] and old["out"]["paid_cents"] == 0


def test_calendar_start_day_24(client, book, today):
    client.patch("/api/settings", json={"month_start_day": 24})
    chk = book.account("Betaal", "checking")
    for d in months("2025-10-24", 5):
        book.tx(chk, d, 250000, "salaris", "Werkgever")
    for d in months("2025-10-28", 5):
        book.tx(chk, d, -90000, "wonen", "Huur", method="debit")
    book.commit()
    cal = client.get("/api/calendar?period=2026-03").json()      # 24 Feb - 23 Mar
    got = {(d, n): i["status"] for (d, n), i in items_by_day(cal).items()}
    assert got == {("2026-02-24", "Werkgever"): "paid", ("2026-02-28", "Huur"): "paid"}
    nxt = client.get("/api/calendar?period=2026-04").json()      # 24 Mar - 23 Apr
    assert {(d, n) for d, n in items_by_day(nxt)} == {("2026-03-24", "Werkgever"), ("2026-03-28", "Huur")}


def test_calendar_empty(client, today):
    cal = client.get("/api/calendar").json()
    assert cal["days"] == [] and cal["out"] == {"paid_cents": 0, "expected_cents": 0, "missed_cents": 0}
    assert cal["in"] == {"paid_cents": 0, "expected_cents": 0}


# ---------------------------------------------------------------------------- yearly cost

def test_per_year_and_subscriptions(client, book):
    chk = book.account("Betaal", "checking")
    for d in months("2025-10-09", 6):
        book.tx(chk, d, -1599, "abonnementen", "Netflix", method="card")
    for d in months("2025-10-18", 6):
        book.tx(chk, d, -2200, "telecom", "Mobiel", method="debit")
    for d in ("2025-04-15", "2025-07-15", "2025-10-15", "2026-01-15"):
        book.tx(chk, d, -11800, "belastingen", "Wegenbelasting", method="debit")
    for i in range(10):
        book.tx(chk, (date(2026, 1, 5) + timedelta(days=7 * i)).isoformat(), -3000, "opvang-school",
                "Oppas", method="debit")
    book.commit()
    r = client.get("/api/recurring").json()
    per_year = {i["name"]: i["per_year_cents"] for i in r["items"]}
    assert per_year == {"Netflix": 1599 * 12, "Mobiel": 2200 * 12, "Wegenbelasting": 11800 * 4,
                        "Oppas": 3000 * 52}
    assert r["subscriptions"] == {"per_month_cents": 3799, "per_year_cents": 3799 * 12, "count": 2}


def test_bank_fees_and_fx_costs(client, book):
    chk = book.account("Betaal", "checking")
    for d in ("2026-01-02", "2026-02-02", "2026-03-02"):
        book.tx(chk, d, -500, "overig", "Bankkosten", method="fee", description="Kosten betaalrekening")
    book.tx(chk, "2025-12-02", -500, "overig", "Bankkosten", method="fee")                  # last year
    book.tx(chk, "2026-02-10", -2455, "boodschappen", "Tesco", method="card",
            description="TESCO >LONDON 10.02.2026 GBP 20,00 koers 1,1650 kosten EUR 1,25")
    book.tx(chk, "2026-02-11", -150, "overig", "Bankkosten", method="fee",
            description="Koersopslag betaling buitenland")
    book.tx(chk, "2026-02-12", -4500, "boodschappen", "Carrefour", method="card",
            description="CARREFOUR >PARIS 12.02.2026 MCC:5411 Apple Pay betaling   FRFRANKRIJK")
    book.commit()
    lg = ledger.build(book.conn)
    p = lg.current()
    found = {i["kind"]: i for i in insights.candidates(book.conn, lg, p, summary.build_overview(book.conn, lg, p))}
    assert found["bank_fees"]["title"] == f"Dit jaar {E}17 aan bankkosten"       # 3 x 5 + 1,50
    assert found["bank_fees"]["id"] == "bank_fees:2026"
    assert found["bank_fees"]["href"] == "/transacties?method=fee&from=2026-01-01"
    assert found["fx_costs"]["title"] == f"Dit jaar {E}3 aan wisselkoerskosten"   # 1,25 + 1,50
    assert found["fx_costs"]["value_cents"] == 275
    kinds = {k["kind"] for k in client.get("/api/settings").json()["insight_kinds"]}
    assert {"bank_fees", "fx_costs"} <= kinds


def test_plain_payments_abroad_are_no_fx_cost():
    row = {"amount_cents": -4500, "method": "card",
           "description": "CARREFOUR >PARIS 12.02.2026 MCC:5411 Apple Pay betaling   FRFRANKRIJK"}
    assert insights.fx_cost(row) == 0
    row = {"amount_cents": -2000, "method": "card", "description": "Kosten parkeren 2,50"}
    assert insights.fx_cost(row) == 0          # costs without any exchange-rate wording


# ---------------------------------------------------------------------------- recap

def recap_household(book, first="2025-12"):
    chk = book.account("Betaal", "checking")
    for m in ("2025-12", "2026-01", "2026-02"):
        if m < first:
            continue
        book.tx(chk, f"{m}-25", 300000, "salaris", "Werkgever")
        book.tx(chk, f"{m}-01" if m != "2025-12" or first == "2025-12" else f"{m}-16", -100000, "wonen",
                "Verhuurder", method="debit")
        book.tx(chk, f"{m}-26", -50000, "sparen", "Spaar")
    if first == "2025-12":
        book.tx(chk, "2025-12-10", -30000, "boodschappen", "Jumbo", method="card")
    book.tx(chk, "2026-01-10", -20000, "boodschappen", "Jumbo", method="card")
    book.tx(chk, "2026-01-20", -10000, "boodschappen", "Jumbo", method="card")
    book.tx(chk, "2026-01-12", -5000, "uit-eten", "Bistro", method="card")
    for d, a in (("2026-02-10", -15000), ("2026-02-20", -15000), ("2026-02-25", -10000)):
        book.tx(chk, d, a, "boodschappen", "Jumbo", method="card")
    book.tx(chk, "2026-02-14", -15000, "uit-eten", "Bistro", method="card")
    book.commit()
    return chk


def test_recap_period(client, book):
    recap_household(book)
    r = client.get("/api/recap?period=2026-02").json()
    assert (r["kind"], r["label"], r["from"], r["to"], r["complete"]) == (
        "period", "februari 2026", "2026-02-01", "2026-02-28", True)
    assert r["totals"] == {"income_cents": 300000, "fixed_cents": 100000, "daily_cents": 55000,
                           "saved_cents": 50000, "net_cents": 95000}
    assert r["previous"] == {"label": "januari 2026", "income_cents": 300000, "fixed_cents": 100000,
                             "daily_cents": 35000, "saved_cents": 50000, "net_cents": 115000}
    c = book.cats
    assert r["categories"] == [
        {"category_id": c["wonen"], "cents": 100000, "previous_cents": 100000, "share": 0.6452},
        {"category_id": c["boodschappen"], "cents": 40000, "previous_cents": 30000, "share": 0.2581},
        {"category_id": c["uit-eten"], "cents": 15000, "previous_cents": 5000, "share": 0.0968}]
    assert {m["category_id"] for m in r["movers"]["up"]} == {c["boodschappen"], c["uit-eten"]}
    assert r["movers"]["down"] == []
    assert r["merchants"][1] == {"merchant_key": "jumbo", "merchant_name": "Jumbo",
                                 "category_id": c["boodschappen"], "cents": 40000, "count": 3}
    assert [t["amount_cents"] for t in r["largest"]] == [-15000, -15000, -15000, -10000]  # rent is recurring
    assert r["counts"] == {"payments": 5, "merchants": 3, "days_without_spending": 24}
    assert r["recurring"]["per_month_cents"] == 100000
    assert r["savings"] == {"saved_cents": 50000, "rate": 0.1667, "goals": []}
    assert r["networth"] is None and r["months"] is None
    titles = [h["title"] for h in r["highlights"]]
    assert titles[0] == f"{E}950 over in februari"
    assert titles[1] == f"Wonen was het grootste bakje: {E}1.000 (65 %)"
    assert titles[2].endswith(f"{E}100 meer dan vorige maand")
    assert f"17 % van je inkomen gespaard ({E}500)" in titles
    assert "Het vaakst bij Jumbo: 3 keer" in titles
    assert 3 <= len(titles) <= 6
    assert not any("gemiddeld" in t for t in titles)


def test_recap_partial_previous_has_no_comparison(client, book, today):
    recap_household(book, first="2026-01")
    book.tx(1, "2025-12-16", -1000, "boodschappen", "Jumbo", method="card")    # partial December
    book.commit()
    r = client.get("/api/recap?period=2026-01").json()
    assert r["complete"] is True and r["previous"] is None
    assert r["movers"] == {"up": [], "down": []}
    assert all(c["previous_cents"] is None for c in r["categories"])
    assert not any("vorige maand" in h["title"] for h in r["highlights"])
    dec = client.get("/api/recap?period=2025-12").json()
    assert dec["complete"] is False
    assert [p["id"] for p in client.get("/api/recap/index").json()["periods"]] == ["2026-02", "2026-01"]


def test_recap_year_with_partial_months(client, book, today):
    recap_household(book)
    y = client.get("/api/recap?year=2026").json()
    assert y["kind"] == "year" and y["complete"] is False and y["from"] == "2026-01-01"
    assert [m["period"] for m in y["months"]] == ["2026-01", "2026-02", "2026-03"]
    for key in ("income_cents", "fixed_cents", "daily_cents", "saved_cents", "net_cents"):
        assert y["totals"][key] == sum(m[key] for m in y["months"])
    assert y["previous"] is None                         # 2025 has only December
    y25 = client.get("/api/recap?year=2025").json()
    assert [m["period"] for m in y25["months"]] == ["2025-12"] and y25["complete"] is False
    assert y25["totals"]["daily_cents"] == 30000
    t = {p["period"]: p for p in client.get("/api/trends").json()["periods"]}
    assert y["months"][0]["net_cents"] == t["2026-01"]["net_cents"]
    assert client.get("/api/recap/index").json()["years"] == [2026, 2025]
    assert client.get("/api/recap?year=2027").status_code == 400
    assert client.get("/api/recap?year=abc").status_code == 400
    assert client.get("/api/recap?period=2026-04").status_code == 400


def test_recap_goal_reached(client, book, today):
    recap_household(book)
    g = client.post("/api/goals", json={"name": "Fiets", "emoji": "🚲", "target_cents": 30000}).json()
    client.post(f"/api/goals/{g['id']}/entries", json={"amount_cents": 20000, "date": "2026-01-05"})
    client.post(f"/api/goals/{g['id']}/entries", json={"amount_cents": 15000, "date": "2026-02-05"})
    r = client.get("/api/recap?period=2026-02").json()
    assert r["savings"]["goals"] == [{"id": g["id"], "name": "Fiets", "emoji": "🚲", "added_cents": 15000,
                                      "saldo_cents": 35000, "target_cents": 30000, "reached": True}]
    assert "Potje Fiets gehaald" in [h["title"] for h in r["highlights"]]


def test_recap_empty(client, today):
    r = client.get("/api/recap").json()
    assert r["kind"] == "period" and r["complete"] is False and r["highlights"] == []
    assert r["totals"]["net_cents"] == 0 and r["previous"] is None and r["largest"] == []
    assert client.get("/api/recap/index").json() == {"periods": [], "years": []}
    y = client.get("/api/recap?year=2026").json()
    assert y["months"] == [] and y["totals"]["income_cents"] == 0
