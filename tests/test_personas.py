"""Seven households that are nothing like the demo family (test round 2026-11). Each goes
through every screen's endpoint; Cents must never say something silly: an unknown salary as a
payday, a percentage above 100 % of a real income, a negative day budget, a crash.

Today is 15 March 2026 (the `today` fixture) unless a persona moves it. Everything is
synthetic."""

from __future__ import annotations

import random
from datetime import date, timedelta

from book import book, today  # noqa: F401  (fixtures)

MONTHS = ["2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10",
          "2025-11", "2025-12", "2026-01", "2026-02"]


def get(client, path, **params):
    r = client.get("/api" + path, params=params)
    assert r.status_code == 200, (path, params, r.text)
    return r.json()


def sane(client) -> dict:
    """Every screen answers, and the figures make sense together."""
    ov = get(client, "/overview")
    for path, params in [("/overview", {"period": "2026-02"}), ("/overview", {"period": "2026"}),
                         ("/recap", {"period": "2026-02"}), ("/recap", {"year": "2026"}),
                         ("/trends", {"periods": "24"}), ("/goals", {}), ("/recurring", {}),
                         ("/networth", {}), ("/calendar", {"period": "2026-03"}),
                         ("/assumptions", {}), ("/recap/index", {})]:
        get(client, path, **params)
    past = get(client, "/overview", period="2026-02")
    assert past["result_cents"] == past["income_cents"] - past["fixed_cents"] - past["daily_cents"]
    f = ov["free"]
    if f:
        pay = date.fromisoformat(f["payday"])
        base = date.fromisoformat(f["as_of"]) if f["as_of"] else date(2026, 3, 15)
        assert base < pay <= base + timedelta(days=45), f["payday"]
        assert f["day_budget_cents"] is None or f["day_budget_cents"] >= 0
        assert f["daily_rate_cents"] >= 0
    h = ov["health"]
    if h:
        for k in ("housing", "fixed"):
            share = h[k]["share"]
            assert share is None or 0 <= share <= 1.5, (k, share)
        assert h["fixed"]["rest_cents"] == h["income_cents"] - h["fixed"]["cents"]
    rec = get(client, "/recurring")
    assert rec["share_of_income"] == (h["fixed"]["share"] if h else None)
    return ov


def test_renters_without_a_mortgage(client, book):
    chk = book.account("Betaal", "checking")
    for m in MONTHS:
        book.tx(chk, f"{m}-01", -125000, "wonen", "Woonstichting", method="debit")
        book.tx(chk, f"{m}-05", -14000, "energie", "Energieleverancier", method="debit")
        book.tx(chk, f"{m}-12", -45000, "boodschappen", "Supermarkt", method="card")
        book.tx(chk, f"{m}-24", 310000, "salaris", "Werkgever")
    book.tx(chk, "2026-03-01", -125000, "wonen", "Woonstichting", method="debit", balance=150000)
    book.commit()
    ov = sane(client)
    h = ov["health"]
    assert h["housing"]["share"] == round(139000 / 310000, 3)
    assert h["debts"] == {"known": False, "total_cents": 0, "items": [], "unlisted": [], "later": []}
    assert ov["free"]["payday"] == "2026-03-24" and ov["free"]["payday_source"] == "salary"


def test_self_employed_with_irregular_income(client, book):
    rnd = random.Random(7)
    chk = book.account("Zakelijk prive", "checking")
    for m in MONTHS:
        for _ in range(rnd.randint(0, 3)):            # invoices paid whenever clients pay
            book.tx(chk, f"{m}-{rnd.randint(1, 28):02d}", rnd.randint(80000, 400000), "inkomen-overig",
                    f"Klant {rnd.randint(1, 9)}")
        book.tx(chk, f"{m}-02", -98000, "wonen", "Verhuurder", method="debit")
        book.tx(chk, f"{m}-15", -52000, "boodschappen", "Supermarkt", method="card")
    book.tx(chk, "2026-03-02", -98000, "wonen", "Verhuurder", method="debit", balance=420000)
    book.commit()
    ov = sane(client)
    # no salary to wait for: Nog te besteden runs to the end of the month
    assert ov["free"]["payday_source"] == "period" and ov["free"]["payday"] == "2026-04-01"


def test_family_with_benefits(client, book):
    chk = book.account("Betaal", "checking")
    for i, m in enumerate(MONTHS):
        book.tx(chk, f"{m}-25", 260000, "salaris", "Werkgever")
        book.tx(chk, f"{m}-20", 12300, "toeslagen", "Belastingdienst")          # zorgtoeslag
        if i % 3 == 0:
            book.tx(chk, f"{m}-03", 31200, "toeslagen", "SVB")                   # kinderbijslag
        book.tx(chk, f"{m}-01", -110000, "wonen", "Hypotheekverstrekker", method="debit")
        book.tx(chk, f"{m}-08", -60000, "opvang-school", "Kinderopvang", method="debit")
        book.tx(chk, f"{m}-14", -70000, "boodschappen", "Supermarkt", method="card")
    book.tx(chk, "2026-03-08", -60000, "opvang-school", "Kinderopvang", method="debit", balance=90000)
    book.commit()
    ov = sane(client)
    # the payday is the salary, not a benefit that is smaller and comes earlier
    assert ov["free"]["payday"] == "2026-03-25"
    assert ov["free"]["fixed_until_payday_cents"] == 0


def test_four_weekly_salary(client, book):
    chk = book.account("Betaal", "checking")
    pay = date(2025, 4, 10)
    while pay <= date(2026, 3, 12):
        book.tx(chk, pay.isoformat(), 240000, "salaris", "Zorginstelling")
        pay += timedelta(days=28)
    for m in MONTHS:
        book.tx(chk, f"{m}-01", -90000, "wonen", "Verhuurder", method="debit")
        book.tx(chk, f"{m}-16", -50000, "boodschappen", "Supermarkt", method="card")
    book.tx(chk, "2026-03-14", -2000, "boodschappen", "Supermarkt", method="card", balance=200000)
    book.commit()
    items = {i["name"]: i for i in get(client, "/recurring")["items"]}
    assert items["Zorginstelling"]["frequency"] == "4-weekly"
    ov = sane(client)
    # the last salary was 12 March (10 April 2025 + 12 × 28 days): the next comes 28 days later,
    # not on the 12th of next month
    assert ov["free"]["payday"] == "2026-04-09"


def test_only_a_savings_account(client, book):
    sav = book.account("Spaar", "savings")
    for m in MONTHS:
        book.tx(sav, f"{m}-28", 300, "inkomen-overig", "Rente", method="interest")
    book.tx(sav, "2026-03-01", 300, "inkomen-overig", "Rente", method="interest", balance=1500000)
    book.commit()
    ov = sane(client)
    assert ov["free"] is None                 # no checking account: nothing to spend from
    assert ov["health"] is None               # only interest, no spending: nothing to say yet


def test_couple_with_two_checking_accounts(client, book):
    a = book.account("Betaal Sam", "checking", "NL01TEST0000000001")
    b = book.account("Betaal Robin", "checking", "NL01TEST0000000002")
    for m in MONTHS:
        book.tx(a, f"{m}-23", 280000, "salaris", "Werkgever A")
        book.tx(b, f"{m}-26", 190000, "salaris", "Werkgever B")
        book.tx(b, f"{m}-27", -80000, "intern", "Betaal Sam", kind="transfer", to=a, method="internal")
        book.tx(a, f"{m}-27", 80000, "intern", "Betaal Robin", kind="transfer", to=b, method="internal")
        book.tx(a, f"{m}-01", -140000, "wonen", "Verhuurder", method="debit")
        book.tx(a, f"{m}-10", -60000, "boodschappen", "Supermarkt", method="card")
        book.tx(b, f"{m}-12", -30000, "uit-eten", "Restaurant", method="card")
    book.tx(a, "2026-03-14", -1000, "boodschappen", "Supermarkt", method="card", balance=210000)
    book.tx(b, "2026-03-14", -1000, "uit-eten", "Restaurant", method="card", balance=60000)
    book.commit()
    ov = sane(client)
    feb = get(client, "/overview", period="2026-02")
    assert feb["income_cents"] == 280000 + 190000            # moving money between them is no income
    assert ov["free"]["balances_cents"] == 210000 + 60000
    assert ov["health"]["income_cents"] == 470000


def test_brand_new_user_with_one_month(client, book, today):
    today("2026-03-15")
    chk = book.account("Betaal", "checking")
    book.tx(chk, "2026-02-25", 300000, "salaris", "Werkgever")
    book.tx(chk, "2026-03-01", -100000, "wonen", "Verhuurder", method="debit")
    book.tx(chk, "2026-03-10", -20000, "boodschappen", "Supermarkt", method="card", balance=180000)
    book.commit()
    ov = sane(client)
    assert ov["health"] is None and ov["tempo"] is None
    assert get(client, "/goals")["room"] is None
    assert ov["free"] is not None
