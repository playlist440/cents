"""Reproductions of the calculation review (insights, data today, hidden accounts, goals,
early salary). Each test failed before its fix."""

from __future__ import annotations

from datetime import date, timedelta

from book import book, today  # noqa: F401  (fixtures)
from cents.services import insights, ledger, summary

E = "€ "


def candidates(book, period=None):
    lg = ledger.build(book.conn)
    p = lg.period(period) if period else lg.current()
    ov = summary.build_overview(book.conn, lg, p)
    return insights.candidates(book.conn, lg, p, ov)


def kinds(book, period=None):
    return {i["kind"] for i in candidates(book, period)}


def months(first: str, n: int) -> list[str]:
    y, m, d = (int(x) for x in first.split("-"))
    out = []
    for i in range(n):
        yy, mm = divmod(m - 1 + i, 12)
        out.append(date(y + yy, mm + 1, d).isoformat())
    return out


# 7 ------------------------------------------------------------------------------------------

def test_quarterly_bill_is_no_spike_and_not_large(client, book, today):
    today("2026-11-15")
    chk = book.account("Betaal", "checking")
    for day in months("2025-11-01", 13):
        book.tx(chk, day, -100000, "wonen", "Verhuurder", method="debit")
        book.tx(chk, day[:8] + "10", -2000, "verzekeringen", "Kleine polis", method="debit")
        book.tx(chk, day[:8] + "25", 300000, "salaris", "Werk")
    for day in ("2025-11-15", "2026-02-15", "2026-05-15", "2026-08-15", "2026-11-15"):
        book.tx(chk, day, -64000, "verzekeringen", "Aegon", method="debit")
    book.commit()
    found = kinds(book, "2026-08")
    assert "large" not in found and "category_spike" not in found


# 8 ------------------------------------------------------------------------------------------

def test_first_partial_period_is_no_left_over(client, book, today):
    today("2025-11-05")
    chk = book.account("Betaal", "checking")
    sav = book.account("Spaar", "savings")
    book.tx(chk, "2025-10-15", 300000, "salaris", "Werk")
    book.tx(chk, "2025-10-20", -20000, "sparen", "Spaar", kind="transfer", to=sav)
    book.tx(chk, "2025-11-02", -3000, "boodschappen", "Jumbo")
    book.commit()
    assert not {"left_over", "savings_rate"} & kinds(book)
    assert not {"left_over", "savings_rate"} & kinds(book, "2025-10")
    t = client.get("/api/trends").json()["periods"]
    assert [(p["period"], p["partial"]) for p in t] == [("2025-10", True), ("2025-11", True)]


def test_trends_partial_false_for_complete_periods(client, book, today):
    chk = book.account("Betaal", "checking")
    for day in ("2026-01-01", "2026-02-01", "2026-03-01"):
        book.tx(chk, day, -1000, "wonen", "Huur")
    book.commit()
    t = client.get("/api/trends").json()["periods"]
    assert [p["partial"] for p in t] == [False, False, True]


# 9 ------------------------------------------------------------------------------------------

def test_three_identical_payments_are_one_insight(client, book, today):
    chk = book.account("Betaal", "checking")
    for day in ("2026-03-01", "2026-03-02", "2026-03-03"):
        book.tx(chk, day, -2500, "vervoer", "Q-Park", method="card")
    for name in ("Jumbo", "Lidl", "Aldi"):
        book.tx(chk, "2026-03-05", -1500, "boodschappen", name, method="card")
        book.tx(chk, "2026-03-06", -1500, "boodschappen", name, method="card")
    book.commit()
    dups = [i for i in candidates(book) if i["kind"] == "duplicate"]
    titles = [i["title"] for i in dups]
    assert f"Drie keer {E}25 bij Q-Park tussen 1 maart en 3 maart" in titles
    assert len(dups) == 2                                   # one, plus one for the rest
    assert any("3 andere betalingen" in t for t in titles)


# 10 -----------------------------------------------------------------------------------------

def test_wording(client, book, today):
    today("2026-11-15")
    chk = book.account("Betaal", "checking")
    sav = book.account("Spaar", "savings")
    book.tx(sav, "2026-05-01", 100, "inkomen-overig", "Rente", method="interest", balance=50000)
    for day in months("2026-05-01", 7):
        book.tx(chk, day, -100000, "wonen", "Verhuurder", method="debit")
        book.tx(chk, day[:8] + "25", 300000, "salaris", "Werk")
    for day in months("2026-09-03", 3):
        book.tx(chk, day, -4000, "verzekeringen", "Nieuwe Polis", method="debit")
    book.tx(chk, "2026-11-02", -1200, "unsorted", "p:j jansen")
    book.tx(chk, "2026-11-03", -1300, "unsorted", "Kiosk")
    book.commit()
    found = {i["kind"]: i for i in candidates(book)}
    assert found["new_recurring"]["title"] == f"Nieuwe vaste last: Nieuwe Polis, {E}40 per maand"
    assert found["unsorted"]["title"] == "2 winkels of personen zonder bakje"
    assert found["buffer"]["title"] == "Je buffer dekt 0,5 maanden vaste lasten"
    assert found["buffer"]["detail"] == "Doel: €\u00a03.040, 3,0 maanden"
    book.conn.execute("DELETE FROM transactions WHERE merchant_key = 'p:j jansen'")
    book.commit()
    found = {i["kind"]: i for i in candidates(book)}
    assert found["unsorted"]["title"] == "1 winkel zonder bakje"


# 11 -----------------------------------------------------------------------------------------

def test_out_of_range_period_is_400(client, today):
    for bad in ("0001-01", "9999-12", "2026-13", "abc"):
        r = client.get(f"/api/overview?period={bad}")
        assert r.status_code == 400 and r.json()["error"]["code"] == "bad_period", bad
        cat = client.get("/api/categories").json()[0]["id"]
        assert client.get(f"/api/categories/{cat}/summary?period={bad}").status_code == 400


def test_out_of_range_period_with_start_day(client, today):
    client.patch("/api/settings", json={"month_start_day": 24})
    assert client.get("/api/overview?period=0001-01").status_code == 400


# 12 -----------------------------------------------------------------------------------------

def stale_household(book):
    chk = book.account("Betaal", "checking")
    for m in ("2025-12", "2026-01", "2026-02"):
        for d in ("03", "10", "17", "24"):
            book.tx(chk, f"{m}-{d}", -10000, "boodschappen", "Jumbo", method="card")
    return chk


def test_manual_or_future_rows_do_not_move_data_today(client, book, today):
    today("2026-03-20")
    chk = stale_household(book)
    book.tx(chk, "2026-03-20", -500, "boodschappen", "Bakker", manual=1, method="card")
    book.tx(chk, "2026-04-30", -500, "wonen", "Vooruit", method="debit")       # future-dated
    book.commit()
    lg = ledger.build(book.conn)
    assert lg.data_today == date(2026, 2, 27)
    found = {i["kind"]: i for i in candidates(book)}
    assert "pace" not in found
    assert found["stale"]["title"] == "Laatste import 24 dagen geleden"


def test_recent_import_is_not_stale(client, book, today):
    today("2026-03-20")
    stale_household(book)
    book.conn.execute("INSERT INTO imports (filename, format, imported_at) VALUES ('x.csv', 'asn_csv', ?)",
                      ("2026-03-15T09:00:00+00:00",))
    book.commit()
    assert "stale" not in kinds(book)


# 13 -----------------------------------------------------------------------------------------

def test_hidden_accounts_do_not_count(client, book, today):
    chk = book.account("Betaal", "checking")
    old = book.account("Oud", "checking")
    book.conn.execute("UPDATE accounts SET hidden = 1 WHERE id = ?", (old,))
    book.tx(chk, "2026-03-02", 100000, "salaris", "Werk")
    book.tx(old, "2026-03-03", 50000, "salaris", "Werk")
    book.tx(old, "2026-03-04", -7000, "boodschappen", "Jumbo")
    book.commit()
    o = client.get("/api/overview").json()
    assert o["income_cents"] == 100000 and o["daily_cents"] == 0
    s = client.get(f"/api/categories/{book.cats['boodschappen']}/summary").json()
    assert s["transactions"] == [] and s["spent_cents"] == 0


# 14 -----------------------------------------------------------------------------------------

def test_passed_goal_is_overdue(client, book, today):
    chk = book.account("Betaal", "checking")
    book.tx(chk, "2026-03-10", -1000, "boodschappen", "Jumbo")
    book.commit()
    g = client.post("/api/goals", json={"name": "Fiets", "target_cents": 60000,
                                        "target_date": "2026-01-01"}).json()
    client.post(f"/api/goals/{g['id']}/entries", json={"amount_cents": 10000, "date": "2025-12-01"})
    g = client.get("/api/goals").json()["goals"][0]
    assert g["status"] == "overdue" and g["months_left"] == 0
    assert g["monthly_advice_cents"] == 50000 and g["catch_up_cents"] is None
    found = {i["kind"]: i for i in candidates(book)}
    assert found["goal_behind"]["title"] == f"De datum van Fiets is voorbij; nog {E}500 te gaan"


# 15 -----------------------------------------------------------------------------------------

def test_split_cannot_exceed_the_transfer(client, book, today):
    chk = book.account("Betaal", "checking")
    sav = book.account("Spaar", "savings")
    tx = book.tx(chk, "2026-03-02", -10000, "sparen", "Spaar", kind="transfer", to=sav)
    book.commit()
    a = client.post("/api/goals", json={"name": "A", "target_cents": 50000}).json()
    b = client.post("/api/goals", json={"name": "B", "target_cents": 50000}).json()
    ok = client.post(f"/api/goals/{a['id']}/entries", json={"transaction_id": tx, "amount_cents": 6000})
    assert ok.status_code == 200
    too_much = client.post(f"/api/goals/{b['id']}/entries", json={"transaction_id": tx, "amount_cents": 5000})
    assert too_much.status_code == 400
    assert client.post(f"/api/goals/{b['id']}/entries",
                       json={"transaction_id": tx, "amount_cents": 4000}).status_code == 200
    # replacing A's own share is measured without A's old share
    assert client.post(f"/api/goals/{a['id']}/entries",
                       json={"transaction_id": tx, "amount_cents": 6000}).status_code == 200
    assert client.post(f"/api/goals/{a['id']}/entries",
                       json={"transaction_id": tx, "amount_cents": -100}).status_code == 400


# early salary --------------------------------------------------------------------------------

def test_salary_a_day_early_counts_in_the_period_it_is_for(client, book, today):
    today("2026-06-10")
    client.patch("/api/settings", json={"month_start_day": 24})
    chk = book.account("Betaal", "checking")
    days = ["2025-12-24", "2026-01-23", "2026-02-24", "2026-03-24", "2026-04-22", "2026-05-25"]
    for d in days:
        book.tx(chk, d, 278000, "salaris", "Werkgever")
        book.tx(chk, (date.fromisoformat(d) + timedelta(days=2)).isoformat(), -50000, "wonen", "Huur")
    book.commit()
    t = client.get("/api/trends").json()["periods"]
    income = {p["period"]: p["income_cents"] for p in t}
    assert income == {"2026-01": 278000, "2026-02": 278000, "2026-03": 278000, "2026-04": 278000,
                      "2026-05": 278000, "2026-06": 278000}
    assert sum(income.values()) == 278000 * len(days)        # nothing lost, nothing twice
    o = client.get("/api/overview?period=2026-05").json()
    assert o["income_cents"] == 278000 and o["net_cents"] == 278000 - 50000


# owner additions: dismiss / mute ---------------------------------------------------------------

def busy_household(book):
    from test_insights import household
    return household(book)


def test_insight_ids_are_stable(client, book):
    chk, _ = busy_household(book)
    first = {i["kind"]: i["id"] for i in candidates(book)}
    assert first["price_change"] == "price_change:netflix|out|monthly|14:2026-01-09"
    assert first["duplicate"] == "duplicate:albert heijn:2026-03-10"
    assert first["category_spike"] == f"category_spike:{book.cats['boodschappen']}:2026-03"
    book.tx(chk, "2026-03-11", -700, "verzorging", "Etos", method="card")
    book.commit()
    again = {i["kind"]: i["id"] for i in candidates(book)}
    for kind in ("price_change", "duplicate", "category_spike", "new_recurring", "ended_recurring"):
        assert again[kind] == first[kind]


def test_dismiss_and_mute(client, book):
    busy_household(book)
    before = client.get("/api/overview").json()["insights"]
    assert len(before) == 5
    top = before[0]
    assert client.post("/api/insights/dismiss", json={"id": top["id"]}).json() == {"ok": True}
    after = client.get("/api/overview").json()["insights"]
    assert top["id"] not in [i["id"] for i in after] and len(after) == 5     # another takes its place
    r = client.post("/api/insights/mute", json={"kind": "price_change", "muted": True}).json()
    assert r["muted_insight_kinds"] == ["price_change"]
    assert "price_change" not in [i["kind"] for i in client.get("/api/overview").json()["insights"]]
    s = client.get("/api/settings").json()
    assert s["muted_insight_kinds"] == ["price_change"]
    labels = {k["kind"]: k["label"] for k in s["insight_kinds"]}
    assert labels["price_change"] == "Prijsstijgingen" and labels["duplicate"] == "Dubbele afschrijvingen"
    assert "_dismissed_insights" not in s and "dismissed_insights" not in s
    client.post("/api/insights/mute", json={"kind": "price_change", "muted": False})
    assert "price_change" in [i["kind"] for i in client.get("/api/overview").json()["insights"]]
    assert client.post("/api/insights/mute", json={"kind": "nope"}).status_code == 400


def test_dismissed_list_is_capped(client, book):
    for i in range(505):
        client.post("/api/insights/dismiss", json={"id": f"x:{i}"})
    from cents import db
    ids = db.get_setting(book.conn, "_dismissed_insights")
    assert len(ids) == 500 and ids[-1] == "x:504" and ids[0] == "x:5"


# owner additions: assumptions -------------------------------------------------------------------

def test_assumptions(client, book, today):
    today("2026-06-10")
    chk = book.account("Betaal", "checking")
    sav = book.account("Spaar", "savings")
    for d in ("2026-01-24", "2026-02-24", "2026-03-23", "2026-04-24", "2026-05-24"):
        book.tx(chk, d, 278000, "salaris", "Werkgever")
    for d in months("2026-01-01", 6):
        book.tx(chk, d, -2999, "abonnementen", "Netflix", method="card")
    t1 = book.tx(chk, "2026-03-02", -5000, "sparen", "Spaar", kind="transfer", to=sav,
                 description="potje fiets")
    book.tx(chk, "2026-04-02", -5000, "sparen", "Spaar", kind="transfer", to=sav, description="potje fiets")
    book.commit()
    client.post("/api/accounts", json={"name": "Creditcard", "type": "credit"})
    goal = client.post("/api/goals", json={"name": "Fiets", "target_cents": 50000}).json()
    client.patch(f"/api/transactions/{t1}", json={"goal_id": goal["id"]})
    client.post("/api/recurring/ignore", json={"key": "netflix|out|monthly|30"})

    a = client.get("/api/assumptions").json()
    assert a["salary"] == [{"merchant_key": "werkgever", "name": "Werkgever", "amount_cents": 278000,
                            "frequency": "monthly"}]
    assert [(x["name"], x["type_source"]) for x in a["accounts"]] == [
        ("Betaal", "user"), ("Spaar", "user"), ("Creditcard", "user")]   # book rows are manual=0
    assert a["recurring_ignored"] == [{"key": "netflix|out|monthly|30", "name": "Netflix"}]
    assert a["rules_count"] == 0 and a["recurring_count"] == 1
    assert a["goal_links"] == [{"goal_id": goal["id"], "goal_name": "Fiets",
                                "description": "potje fiets", "count": 1}]
    assert a["month_start_day"] == 1 and a["suggestion"] == {"month_start_day": 24}

    # remove the learned link: a new goal no longer pulls in the second transfer
    r = client.request("DELETE", "/api/goals/links", json={"goal_id": goal["id"], "description": "potje fiets"})
    assert r.json() == {"ok": True}
    assert client.get("/api/assumptions").json()["goal_links"] == []
    client.post("/api/goals", json={"name": "Iets", "target_cents": 1000})
    assert client.get("/api/goals").json()["goals"][0]["saldo_cents"] == 5000

    # un-ignore
    client.request("DELETE", "/api/recurring/ignore", json={"key": "netflix|out|monthly|30"})
    assert client.get("/api/assumptions").json()["recurring_ignored"] == []
    assert "Netflix" in {i["name"] for i in client.get("/api/recurring").json()["items"]}
