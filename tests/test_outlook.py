"""Vrij geld, tempo and the checking-account warning (SPEC 9) on a small synthetic household.

Today is 15 March 2026. October–February are complete: salary € 3.000 on the 25th, rent
€ 1.000 on the 1st, insurance € 100 on the 20th, groceries € 600 on the 10th, € 500 to savings
on the 26th. Latest balances (14 March): checking € 2.000, savings € 5.000."""

from __future__ import annotations

from book import book, today  # noqa: F401  (fixtures)

MONTHS = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02"]


def household(book, groceries=-60000):
    chk = book.account("Betaal", "checking", "NL01TEST0000000001")
    sav = book.account("Spaar", "savings", "NL02TEST0000000002")
    for m in MONTHS:
        book.tx(chk, f"{m}-01", -100000, "wonen", "Verhuurder", method="debit")
        book.tx(chk, f"{m}-10", groceries, "boodschappen", "Supermarkt", method="card")
        book.tx(chk, f"{m}-20", -10000, "verzekeringen", "Verzekeraar", method="debit")
        book.tx(chk, f"{m}-25", 300000, "salaris", "Werkgever")
        book.tx(chk, f"{m}-26", -50000, "sparen", "Spaar", kind="transfer", to=sav, method="internal")
        book.tx(sav, f"{m}-26", 50000, "intern", "Betaal", kind="transfer", to=chk, method="internal")
    book.tx(chk, "2026-03-01", -100000, "wonen", "Verhuurder", method="debit")
    book.tx(chk, "2026-03-14", -1000, "boodschappen", "Supermarkt", method="card", balance=200000)
    book.tx(sav, "2026-03-01", 100, "sparen", "Rente", method="interest", balance=500000)
    book.commit()
    return chk, sav


def overview(client):
    return client.get("/api/overview").json()


def set_assumption(client, key, value):
    r = client.patch("/api/settings", json={"assumptions": {key: value}})
    assert r.status_code == 200, r.text


def test_free_breakdown_and_payday(client, book):
    household(book)
    f = overview(client)["free"]
    assert f["balances_cents"] == 700000
    assert f["payday"] == "2026-03-25" and f["payday_source"] == "salary"
    assert f["fixed_until_payday_cents"] == 10000          # insurance on the 20th, not April rent
    assert f["buffer_cents"] == 3 * 110000                 # 3 months of fixed costs
    assert f["goals_cents"] == 0
    assert f["total_cents"] == 700000 - 330000 - 10000
    assert f["as_of"] == "2026-03-14" and f["stale"] is False


def test_transfer_between_own_accounts_leaves_free_unchanged(client, book):
    chk, sav = household(book)
    before = overview(client)["free"]["total_cents"]
    book.tx(chk, "2026-03-15", -50000, "sparen", "Spaar", kind="transfer", to=sav,
            method="internal", balance=150000)
    book.tx(sav, "2026-03-15", 50000, "intern", "Betaal", kind="transfer", to=chk,
            method="internal", balance=550000)
    book.commit()
    after = overview(client)["free"]
    assert after["balances_cents"] == 700000
    assert after["total_cents"] == before
    # and back again
    book.tx(chk, "2026-03-15", 20000, "sparen", "Spaar", kind="transfer", to=sav,
            method="internal", balance=170000)
    book.tx(sav, "2026-03-15", -20000, "intern", "Betaal", kind="transfer", to=chk,
            method="internal", balance=530000)
    book.commit()
    assert overview(client)["free"]["total_cents"] == before


def test_potjes_and_buffer_subtracted(client, book):
    household(book)
    g = client.post("/api/goals", json={"name": "Vakantie", "target_cents": 300000}).json()
    client.post(f"/api/goals/{g['id']}/saldo", json={"saldo_cents": 120000})
    set_assumption(client, "buffer", {"months": 0})
    f = overview(client)["free"]
    assert f["goals_cents"] == 120000 and f["buffer_cents"] == 0
    assert f["total_cents"] == 700000 - 120000 - 10000
    set_assumption(client, "buffer", {"amount_cents": 200000})
    f = overview(client)["free"]
    assert f["buffer_cents"] == 200000
    assert f["total_cents"] == 700000 - 120000 - 200000 - 10000
    # a potje named "Buffer" already holds part of it: not counted twice
    b = client.post("/api/goals", json={"name": "Buffer", "target_cents": 500000}).json()
    client.post(f"/api/goals/{b['id']}/saldo", json={"saldo_cents": 50000})
    f = overview(client)["free"]
    assert f["goals_cents"] == 170000 and f["buffer_cents"] == 150000
    assert f["total_cents"] == 700000 - 170000 - 150000 - 10000


def test_payday_override_changes_fixed_window(client, book, today):
    household(book)
    set_assumption(client, "payday_day", {"day": 19})
    f = overview(client)["free"]
    assert f["payday"] == "2026-03-19" and f["payday_source"] == "setting"
    assert f["fixed_until_payday_cents"] == 0              # insurance on the 20th is after it
    set_assumption(client, "payday_day", {"day": 31})
    f = overview(client)["free"]
    assert f["payday"] == "2026-03-31" and f["fixed_until_payday_cents"] == 10000
    set_assumption(client, "payday_day", {"day": 10})     # already past: next month
    assert overview(client)["free"]["payday"] == "2026-04-10"
    set_assumption(client, "payday_day", {"day": None})
    assert overview(client)["free"]["payday"] == "2026-03-25"
    bad = client.patch("/api/settings", json={"assumptions": {"payday_day": {"day": 32}}})
    assert bad.status_code == 422


def test_payday_falls_back_to_period_end_without_salary(client, book):
    chk = book.account("Betaal", "checking", "NL01TEST0000000001")
    book.tx(chk, "2026-03-02", -1000, "boodschappen", "Supermarkt", balance=10000)
    book.commit()
    f = overview(client)["free"]
    assert f["payday"] == "2026-04-01" and f["payday_source"] == "period"


def test_tempo_excludes_savings_transfers_and_withdrawals(client, book):
    chk, sav = household(book)
    # money back from savings in February is not income
    book.tx(chk, "2026-02-27", 40000, "sparen", "Spaar", kind="transfer", to=sav, method="internal")
    book.tx(sav, "2026-02-27", -40000, "intern", "Betaal", kind="transfer", to=chk, method="internal")
    book.commit()
    o = overview(client)
    t = o["tempo"]
    assert t["avg_net_cents"] == 300000 - 110000 - 60000
    assert [m["period"] for m in t["months"]] == MONTHS
    assert all(m["net_cents"] == 130000 for m in t["months"])
    assert not any(i["kind"] == "tempo" for i in o["insights"])


def test_tempo_needs_two_complete_periods(client, book, today):
    household(book)
    today("2025-11-15")
    assert overview(client)["tempo"] is None


def test_tempo_negative_gives_insight(client, book):
    household(book, groceries=-260000)
    o = overview(client)
    t = o["tempo"]
    assert t["avg_net_cents"] == 300000 - 110000 - 260000
    assert t["since"] == "2025-10"                         # short every month
    ins = [i for i in o["insights"] if i["kind"] == "tempo"]
    assert len(ins) == 1 and ins[0]["id"] == "tempo:2025-10"
    assert "€ 700 per maand meer uit" in ins[0]["title"].replace(" ", " ")
    client.post("/api/insights/dismiss", json={"id": "tempo:2025-10"})
    assert not any(i["kind"] == "tempo" for i in overview(client)["insights"])


def test_checking_warning_follows_floor(client, book):
    household(book)
    assert overview(client)["checking_warning"] is None    # floor 0, lowest about € 1.700
    set_assumption(client, "checking_floor_cents", {"cents": 180000})
    w = overview(client)["checking_warning"]
    assert w is not None
    # 10 days at € 20 per day (€ 1.800 groceries over 90 days) and the € 100 insurance
    assert w["low_cents"] == 200000 - 10 * 2000 - 10000
    assert w["date"] == "2026-03-24"
    assert w["suggest_cents"] == 10000
    set_assumption(client, "checking_floor_cents", {"cents": 0})
    assert overview(client)["checking_warning"] is None


def test_past_period_has_no_now_figures(client, book):
    household(book)
    o = client.get("/api/overview?period=2026-01").json()
    assert o["free"] is None and o["tempo"] is None and o["checking_warning"] is None
