"""Nog te besteden, tempo, buffer and the checking-account warning (SPEC 9) on a small
synthetic household.

Today is 15 March 2026. October–February are complete: salary € 3.000 on the 25th, rent
€ 1.000 on the 1st, insurance € 100 on the 20th, groceries € 600 on the 10th, € 500 to savings
on the 26th. Latest balances (14 March): checking € 2.000, savings € 5.000. Daily spending: € 600 a
month, so the median per-day rate is € 600 / 31 days (three of five months have 31 days)."""

from __future__ import annotations

from book import book, today  # noqa: F401  (fixtures)
from cents.services import insights, ledger, summary

MONTHS = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02"]
RATE = 60000 / 31                                           # median cents per day


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
    book.tx(sav, "2026-03-14", 100, "sparen", "Rente", method="interest", balance=500000)
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
    assert f["balances_cents"] == 200000                   # the checking account only
    assert f["payday"] == "2026-03-25" and f["payday_source"] == "salary"
    assert f["salary_pending"] is False
    assert f["fixed_until_payday_cents"] == 10000          # insurance on the 20th, not April rent
    assert f["fixed_overdue_cents"] == 0 and f["saving_until_payday_cents"] == 0
    assert f["card_settlement"] is None
    assert f["daily_days"] == 10                           # 15 … 24 March
    assert f["daily_until_payday_cents"] == round(10 * RATE)
    assert f["total_cents"] == 200000 - 10000 - round(10 * RATE)
    assert f["per_day_cents"] == int(f["total_cents"] / 10)
    # the day budget is the whole amount per day for daily spending: normal pace + the extra
    assert f["day_budget_cents"] == round(RATE + f["total_cents"] / 10)
    assert f["as_of"] == "2026-03-14" and f["stale"] is False
    # savings are next to it: € 5.000 minus the buffer (3 months of € 1.100 fixed costs)
    assert f["savings"]["balance_cents"] == 500000 and f["savings"]["goals_cents"] == 0
    assert f["savings"]["buffer_cents"] == 330000 and f["savings"]["free_cents"] == 170000


def test_transfer_between_own_accounts_moves_between_free_and_savings(client, book):
    chk, sav = household(book)
    f = overview(client)["free"]
    before, before_free_savings = f["total_cents"], f["savings"]["free_cents"]
    book.tx(chk, "2026-03-14", -50000, "sparen", "Spaar", kind="transfer", to=sav,
            method="internal", balance=150000)
    book.tx(sav, "2026-03-14", 50000, "intern", "Betaal", kind="transfer", to=chk,
            method="internal", balance=550000)
    book.commit()
    after = overview(client)["free"]
    assert after["balances_cents"] == 150000
    assert after["total_cents"] == before - 50000
    assert after["savings"]["free_cents"] == before_free_savings + 50000
    # and back again
    book.tx(chk, "2026-03-14", 20000, "sparen", "Spaar", kind="transfer", to=sav,
            method="internal", balance=170000)
    book.tx(sav, "2026-03-14", -20000, "intern", "Betaal", kind="transfer", to=chk,
            method="internal", balance=530000)
    book.commit()
    assert overview(client)["free"]["total_cents"] == before - 50000 + 20000


def test_potjes_and_buffer_are_savings_not_free(client, book):
    household(book)
    set_assumption(client, "buffer", {"amount_cents": 0})
    base = 200000 - 10000 - round(10 * RATE)
    assert overview(client)["free"]["total_cents"] == base
    g = client.post("/api/goals", json={"name": "Vakantie", "target_cents": 300000}).json()
    client.post(f"/api/goals/{g['id']}/saldo", json={"saldo_cents": 120000})
    set_assumption(client, "buffer", {"amount_cents": 200000})
    o = overview(client)
    assert o["free"]["total_cents"] == base                # potjes live on the savings account
    s = o["free"]["savings"]
    assert s["goals_cents"] == 120000
    # only savings that form the buffer are set aside, never the unfilled part of the target
    assert s["buffer_cents"] == 200000 and s["free_cents"] == 500000 - 120000 - 200000
    # buffer bar: savings outside potjes (€ 3.800), capped at the target
    b = o["buffer"]
    assert (b["saved_cents"], b["target_cents"], b["source"], b["target_source"]) == (
        200000, 200000, "savings", "assumption")
    assert b["months"] == round(200000 / 110000, 1) and b["target_months"] == 1.8
    # a potje named "Buffer" is the buffer, and its target is the one buffer target
    pot = client.post("/api/goals", json={"name": "Buffer", "target_cents": 500000}).json()
    client.post(f"/api/goals/{pot['id']}/saldo", json={"saldo_cents": 50000})
    o = overview(client)
    assert o["free"]["total_cents"] == base and o["free"]["savings"]["goals_cents"] == 170000
    assert o["free"]["savings"]["buffer_cents"] == 0       # already in the potje
    b = o["buffer"]
    assert (b["saved_cents"], b["source"], b["target_cents"], b["target_source"], b["goal_id"]) == (
        50000, "potje", 500000, "potje", pot["id"])
    set_assumption(client, "buffer", {"months": 3, "amount_cents": None})
    assert overview(client)["buffer"]["target_cents"] == 500000
    # a buffer potje without a target follows the assumption
    book.conn.execute("UPDATE goals SET target_cents = 0 WHERE id = ?", (pot["id"],))
    book.commit()
    b = overview(client)["buffer"]
    assert b["target_cents"] == 3 * 110000 and b["target_source"] == "assumption"


def test_buffer_insight_uses_the_buffer_definition(client, book):
    household(book)
    set_assumption(client, "buffer", {"months": 3, "amount_cents": None})
    lg = ledger.build(book.conn)
    p = lg.current()
    ov = summary.build_overview(book.conn, lg, p)
    found = {i["kind"]: i for i in insights.candidates(book.conn, lg, p, ov)}
    # savings € 5.000 outside potjes, capped at the € 3.300 target = 3 months of fixed costs
    assert ov["buffer"]["saved_cents"] == 330000
    assert found["buffer"]["title"] == "Je buffer dekt 3,0 maanden vaste lasten"
    assert found["buffer"]["tone"] == "good"
    # informational: not on the Overzicht
    assert "buffer" not in {i["kind"] for i in ov["insights"]}


def test_negative_is_not_clamped(client, book):
    chk, sav = household(book, groceries=-900000)
    book.conn.execute("UPDATE transactions SET balance_after_cents = 0 WHERE account_id = ?", (sav,))
    book.commit()
    f = overview(client)["free"]
    total = 200000 - 10000 - round(10 * 900000 / 31)
    assert total < 0 and f["total_cents"] == total
    assert f["per_day_cents"] == int(total / 10) < 0
    # € 290 a day is normal; with the shortfall € 190 a day is what reaches payday
    assert f["day_budget_cents"] == round(900000 / 31 + total / 10) == 19000


def test_payday_is_after_the_balance_date_not_today(client, book, today):
    household(book)
    today("2026-03-27")          # salary of the 25th is due but not imported yet
    f = overview(client)["free"]
    assert f["payday"] == "2026-03-25" and f["salary_pending"] is True
    assert f["fixed_until_payday_cents"] == 10000          # not a full extra month (April rent)
    assert f["daily_days"] == 10 and f["per_day_cents"] is None and f["days_left"] == 0
    assert f["stale"] is True
    set_assumption(client, "payday_day", {"day": 20})
    f = overview(client)["free"]
    assert f["payday"] == "2026-03-20" and f["salary_pending"] is True
    assert f["fixed_until_payday_cents"] == 0
    assert client.get("/api/assumptions").json()["payday"]["date"] == "2026-03-20"


def test_stale_uses_the_checking_account(client, book):
    chk, sav = household(book)
    book.conn.execute("UPDATE transactions SET date = '2026-03-01' WHERE account_id = ? "
                      "AND date = '2026-03-14'", (sav,))
    book.commit()
    f = overview(client)["free"]
    # an older savings balance does not move the window (no daily spending counted twice)
    assert f["as_of"] == "2026-03-14" and f["stale"] is False and f["daily_days"] == 10
    assert [(a["name"], a["stale"]) for a in f["accounts"]] == [("Betaal", False)]
    assert [(a["name"], a["stale"]) for a in f["savings"]["accounts"]] == [("Spaar", True)]
    # an import that covered the savings account up to 14 March makes it fresh again
    book.conn.execute("INSERT INTO imports (filename, format, imported_at, account_id, date_to) "
                      "VALUES ('x.csv', 'asn_csv', '2026-03-14T10:00:00+00:00', ?, '2026-03-14')", (sav,))
    book.commit()
    assert overview(client)["free"]["savings"]["accounts"][0]["stale"] is False
    book.conn.execute("DELETE FROM imports")
    book.conn.execute("UPDATE transactions SET date = '2026-03-01' WHERE account_id = ? "
                      "AND date = '2026-03-14'", (chk,))
    book.commit()
    f = overview(client)["free"]
    assert f["as_of"] == "2026-03-01" and f["stale"] is True
    assert f["payday"] == "2026-03-25"                     # from the checking account's date
    assert f["fixed_until_payday_cents"] == 10000          # 2 … 24 March: insurance (rent was paid)
    assert f["daily_days"] == 23


def test_expected_card_settlement(client, book):
    chk, _ = household(book)
    for m, cents in zip(MONTHS, [20000, 30000, 25000, 40000, 22000]):
        book.tx(chk, f"{m}-18", -cents, "creditcard", "Creditcard", method="debit")
    book.commit()
    f = overview(client)["free"]
    assert f["card_settlement"] == {"date": "2026-03-18", "cents": 25000}   # median of last 3
    # the settlements are not part of the daily rate
    assert f["daily_until_payday_cents"] == round(10 * RATE)
    assert f["total_cents"] == 200000 - 10000 - 25000 - round(10 * RATE)


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
    # 10 days at the median rate (€ 600 / 31 days) and the € 100 insurance
    assert w["low_cents"] == int(200000 - 10 * RATE - 10000) == 170645
    assert w["date"] == "2026-03-24"
    assert w["suggest_cents"] == 10000
    set_assumption(client, "checking_floor_cents", {"cents": 0})
    assert overview(client)["checking_warning"] is None


def test_past_period_has_no_now_figures(client, book):
    household(book)
    o = client.get("/api/overview?period=2026-01").json()
    assert o["free"] is None and o["tempo"] is None and o["checking_warning"] is None


def test_checking_warning_counts_other_income(client, book):
    chk, _ = household(book)
    set_assumption(client, "checking_floor_cents", {"cents": 180000})
    low = overview(client)["checking_warning"]["low_cents"]
    for m in MONTHS:
        book.tx(chk, f"{m}-18", 20000, "toeslagen", "Toeslagen")
    book.commit()
    assert overview(client)["checking_warning"] is None     # € 200 on the 18th lifts the low
    set_assumption(client, "checking_floor_cents", {"cents": 200000})
    w = overview(client)["checking_warning"]
    assert w["date"] == "2026-03-24" and w["low_cents"] == low + 20000


def test_result_is_one_definition(client, book):
    chk, sav = household(book)
    # February: € 400 back from savings, which is not income
    book.tx(chk, "2026-02-27", 40000, "sparen", "Spaar", kind="transfer", to=sav, method="internal")
    book.tx(sav, "2026-02-27", -40000, "intern", "Betaal", kind="transfer", to=chk, method="internal")
    book.commit()
    o = client.get("/api/overview?period=2026-02").json()
    assert o["result_cents"] == 300000 - 110000 - 60000
    t = overview(client)["tempo"]
    assert {m["period"]: m["net_cents"] for m in t["months"]}["2026-02"] == o["result_cents"]
    y = client.get("/api/overview?period=2026").json()
    assert y["months"][1]["result_cents"] == o["result_cents"]


def test_left_over_with_withdrawal_does_not_suggest_a_potje(client, book, today):
    chk, sav = household(book, groceries=-260000)
    # February covered by € 2.000 from savings: result 3000 − 1100 − 2600 < 0, no insight
    book.tx(chk, "2026-02-27", 200000, "sparen", "Spaar", kind="transfer", to=sav, method="internal")
    book.commit()
    today("2026-03-05")
    lg = ledger.build(book.conn)
    p = lg.current()
    found = {i["kind"]: i for i in insights.candidates(book.conn, lg, p,
                                                        summary.build_overview(book.conn, lg, p))}
    assert "left_over" not in found
    # a month with money over that also drew on savings: no potje suggestion
    book.conn.execute("UPDATE transactions SET amount_cents = -10000 WHERE merchant_key = 'supermarkt' "
                      "AND date = '2026-02-10'")
    book.commit()
    lg = ledger.build(book.conn)
    found = {i["kind"]: i for i in insights.candidates(book.conn, lg, p,
                                                        summary.build_overview(book.conn, lg, p))}
    title = found["left_over"]["title"]
    assert "potje" not in title and "uit je spaargeld" in title


def test_unfilled_buffer_never_makes_it_negative(client, book):
    household(book)
    set_assumption(client, "buffer", {"amount_cents": 0})
    base = overview(client)["free"]["total_cents"]
    set_assumption(client, "buffer", {"amount_cents": 100_000_000})   # far more than saved
    f = overview(client)["free"]
    assert f["total_cents"] == base                        # the buffer is savings
    assert f["savings"]["buffer_cents"] == 500000 and f["savings"]["free_cents"] == 0


def test_overdue_fixed_cost_is_kept_aside(client, book, today):
    chk, _ = household(book)
    # the insurance of the 20th did not show up; the balance is from the 22nd
    book.tx(chk, "2026-03-22", -1000, "boodschappen", "Supermarkt", method="card", balance=199000)
    book.commit()
    today("2026-03-23")
    f = overview(client)["free"]
    assert f["fixed_until_payday_cents"] == 0
    assert f["fixed_overdue"] == [{"name": "Verzekeraar", "date": "2026-03-20", "cents": 10000}]
    assert f["total_cents"] == 199000 - 10000 - round(2 * RATE)


def test_savings_transfer_before_payday_leaves_checking(client, book):
    chk, sav = household(book)
    for m in MONTHS:
        book.tx(chk, f"{m}-18", -20000, "beleggen", "Broker", kind="transfer", method="debit")
    book.commit()
    f = overview(client)["free"]
    assert f["saving_until_payday_cents"] == 20000
    assert f["total_cents"] == 200000 - 10000 - 20000 - round(10 * RATE)


def test_health_card(client, book):
    household(book)
    h = overview(client)["health"]
    assert h["months"] == 5 and h["income_cents"] == 300000
    assert h["housing"] == {"cents": 100000, "share": 0.333}            # rent
    assert h["fixed"] == {"cents": 110000, "share": 0.367, "rest_cents": 190000}
    assert h["saving"] == {"cents": 50000, "share": 0.167, "repaid_cents": 0}
    assert h["debts"] == {"known": False, "total_cents": 0, "items": []}
    b = overview(client)["buffer"]
    assert h["buffer"]["months"] == b["months"] and h["buffer"]["target_months"] == b["target_months"]
    assert client.get("/api/overview?period=2026-01").json()["health"] is None


def test_room_leaves_out_investing_and_spread_parts(client, book):
    chk, sav = household(book)
    before = client.get("/api/goals").json()["room"]["avg_over_cents"]
    assert before == 300000 - 110000 - 60000
    for m in MONTHS:
        book.tx(chk, f"{m}-27", -20000, "beleggen", "Broker", kind="transfer", method="debit")
    big = book.tx(chk, "2026-01-12", -240000, "huis-tuin", "Keukenzaak", method="debit")
    book.commit()
    client.patch(f"/api/transactions/{big}", json={"spread_months": 24})
    room = client.get("/api/goals").json()["room"]
    assert room["investing_cents"] == 20000
    assert room["avg_over_cents"] == before - 20000      # the kitchen is no monthly pattern


def test_top_merchants_cover_twelve_months(client, book):
    chk, _ = household(book)
    book.tx(chk, "2024-06-10", -900000, "huis-tuin", "Aannemer", method="debit")
    book.commit()
    t = client.get("/api/trends?periods=24").json()
    assert t["top_merchants_months"] == 12
    assert "aannemer" not in {m["merchant_key"] for m in t["top_merchants"]}
