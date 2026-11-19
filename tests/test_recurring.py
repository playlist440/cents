"""Recurring detection: frequencies, clusters, status, change, next date, ignore, lookup."""

from __future__ import annotations

from datetime import date, timedelta

from book import book, today  # noqa: F401  (fixtures)
from cents.services import recurring

_ids = iter(range(1, 100000))


def rows(merchant: str, dates: list[str], amounts: list[int] | int, category_id: int = 1) -> list[dict]:
    if isinstance(amounts, int):
        amounts = [amounts] * len(dates)
    return [{"id": next(_ids), "date": d, "amount_cents": a, "merchant_key": merchant,
             "merchant_name": merchant.title(), "category_id": category_id}
            for d, a in zip(dates, amounts)]


def months(first: str, n: int) -> list[str]:
    y, m, d = (int(x) for x in first.split("-"))
    out = []
    for i in range(n):
        yy, mm = divmod(m - 1 + i, 12)
        out.append(date(y + yy, mm + 1, d).isoformat())
    return out


TODAY = date(2026, 3, 15)


def test_monthly_with_price_change():
    r = rows("netflix", months("2025-09-09", 7), [-1399] * 4 + [-1599] * 3)
    [item] = recurring.detect(r, TODAY)
    assert item["frequency"] == "monthly" and item["status"] == "active"
    assert item["amount_cents"] == -1599 and item["per_month_cents"] == -1599
    assert item["change"] == {"from_cents": -1399, "to_cents": -1599, "date": "2026-01-09"}
    assert item["next_date"] == "2026-04-09" and item["last_date"] == "2026-03-09"
    assert item["key"] == "netflix|out|monthly|14" and item["direction"] == "out" and item["count"] == 7
    assert item["variable"] is False


def test_small_differences_are_no_change():
    r = rows("odido", months("2025-10-18", 5), [-2200, -2200, -2210, -2200, -2215])
    [item] = recurring.detect(r, TODAY)
    assert item["change"] is None


def test_new_and_ended_status():
    new = rows("disney", months("2026-01-03", 3), -1099)
    ended = rows("spotify", months("2025-06-14", 6), -1299)        # last 2025-11-14
    gone = rows("oldgym", months("2025-01-05", 4), -2500)          # ended long ago
    items = {i["merchant_key"]: i for i in recurring.detect(new + ended + gone, TODAY)}
    assert items["disney"]["status"] == "new"
    assert items["spotify"]["status"] == "ended"       # overdue 121 days > 1.6 x 30
    assert "oldgym" not in items                       # ended more than ~3 periods ago


def test_frequencies_and_yearly_pair():
    weekly = rows("oppas", [(date(2026, 1, 3) + timedelta(days=7 * i)).isoformat() for i in range(10)], -3000)
    quarterly = rows("mrb", ["2025-04-15", "2025-07-15", "2025-10-15", "2026-01-15"], -11800)
    yearly = rows("anwb", ["2025-04-12", "2026-04-11"], -9450)
    items = {i["merchant_key"]: i for i in recurring.detect(weekly + quarterly + yearly, date(2026, 4, 20))}
    assert items["oppas"]["frequency"] == "weekly"
    assert items["oppas"]["per_month_cents"] == round(-3000 * 52 / 12)
    assert items["mrb"]["frequency"] == "quarterly" and items["mrb"]["next_date"] == "2026-04-17"
    assert items["anwb"]["frequency"] == "yearly" and items["anwb"]["per_month_cents"] == round(-9450 / 12)


def test_two_payments_only_count_for_yearly():
    assert recurring.detect(rows("x", ["2026-01-01", "2026-02-01"], -500), TODAY) == []


def test_yearly_pair_at_a_busy_shop_is_coincidence():
    r = rows("hema", ["2025-03-01", "2025-06-10", "2025-09-02", "2026-02-27"], [-1086, -500, -3000, -1090])
    assert recurring.detect(r, TODAY) == []


def test_clusters_split_two_policies():
    a = rows("insurer", months("2025-10-01", 6), -4812)
    b = rows("insurer", months("2025-10-01", 6), -1735)
    items = recurring.detect(a + b, TODAY)
    assert sorted(i["amount_cents"] for i in items) == [-4812, -1735]
    assert {i["key"] for i in items} == {"insurer|out|monthly|48", "insurer|out|monthly|17"}


def test_variable_monthly_debit_needs_four():
    energy = rows("eneco", months("2025-10-20", 5), [-11000, -13800, -12000, -12500, -11500])
    [item] = recurring.detect(energy, TODAY)
    assert item["variable"] is True and item["amount_cents"] == -12000      # median of the last 6
    assert item["change"] is None
    assert recurring.detect(energy[:3], TODAY) == []


def test_irregular_gaps_are_not_recurring():
    r = rows("bol", ["2025-10-01", "2025-10-05", "2025-12-20", "2026-01-02", "2026-03-01"], -2500)
    assert recurring.detect(r, TODAY) == []


def test_monthly_next_date_keeps_usual_day():
    r = rows("rent", ["2025-11-01", "2025-12-01", "2026-01-02", "2026-01-30"], -100000)
    [item] = recurring.detect(r, TODAY)
    assert item["next_date"] == "2026-03-01"      # paid early on 30 Jan for February


def test_income_and_api(client, book, today):
    chk = book.account("Betaal", "checking")
    sav = book.account("Spaar", "savings")
    book.monthly(chk, "2025-09-24", 6, 300000, "salaris", "Werkgever")
    book.monthly(chk, "2025-10-09", 6, -1399, "abonnementen", "Netflix", method="card")
    book.monthly(chk, "2025-09-25", 6, -50000, "sparen", "Spaar", kind="transfer", to=sav)
    book.monthly(chk, "2025-10-02", 6, -5000, "contant", "Geldautomaat", method="atm")
    book.commit()
    data = client.get("/api/recurring").json()
    names = {i["name"]: i for i in data["items"]}
    assert set(names) == {"Werkgever", "Netflix", "Spaar"}       # cash withdrawals are no bills
    assert names["Werkgever"]["direction"] == "in"
    assert data["monthly_in_cents"] == 300000
    assert data["monthly_out_cents"] == 1399                     # savings are not a fixed cost
    assert data["yearly_out_cents"] == 1399 * 12

    tx = client.get("/api/transactions?merchant_key=netflix").json()["items"][0]
    detail = client.get(f"/api/transactions/{tx['id']}").json()
    assert detail["merchant"]["recurring"]["key"] == "netflix|out|monthly|14"

    assert client.post("/api/recurring/ignore", json={"key": "netflix|out|monthly|14"}).json() == {"ok": True}
    data = client.get("/api/recurring").json()
    assert "Netflix" not in {i["name"] for i in data["items"]}
    assert data["monthly_out_cents"] == 0
    assert client.get(f"/api/transactions/{tx['id']}").json()["merchant"]["recurring"] is None


# ---------------------------------------------------------------- review fixes

NOV = date(2026, 11, 20)


def test_price_rise_above_15_percent_continues_the_item():
    netflix = rows("netflix", months("2026-01-09", 11), [-1299] * 7 + [-1599] * 4)
    eneco = rows("eneco", months("2026-01-20", 10), [-10000] * 6 + [-14000] * 4)
    items = {i["merchant_key"]: i for i in recurring.detect(netflix + eneco, NOV)}
    assert len(items) == 2
    n = items["netflix"]
    assert n["status"] == "active" and n["count"] == 11 and n["amount_cents"] == -1599
    assert n["change"] == {"from_cents": -1299, "to_cents": -1599, "date": "2026-08-09"}
    e = items["eneco"]
    assert e["status"] == "active" and e["change"]["from_cents"] == -10000 and e["change"]["to_cents"] == -14000


def test_price_rise_visible_from_the_first_new_payment():
    netflix = rows("netflix", months("2026-04-09", 8), [-1299] * 7 + [-1599])
    [item] = recurring.detect(netflix, NOV)
    assert item["amount_cents"] == -1599 and item["change"]["date"] == "2026-11-09"


def test_two_policies_with_close_amounts_on_different_days():
    a = rows("insurer", months("2026-01-01", 10), -1000)
    b = rows("insurer", months("2026-01-05", 10), -1100)
    items = recurring.detect(a + b, NOV)
    assert sorted(i["amount_cents"] for i in items) == [-1100, -1000]
    assert all(i["frequency"] == "monthly" for i in items)
    assert len({i["key"] for i in items}) == 2


def test_four_weekly_and_two_weekly():
    four = rows("loon", [(date(2026, 6, 5) + timedelta(days=28 * i)).isoformat() for i in range(6)], 150000)
    two = rows("oppasclub", [(date(2026, 9, 4) + timedelta(days=14 * i)).isoformat() for i in range(6)], -2500)
    items = {i["merchant_key"]: i for i in recurring.detect(four + two, NOV)}
    f = items["loon"]
    assert f["frequency"] == "4-weekly" and f["per_month_cents"] == round(150000 * 13 / 12)
    assert f["next_date"] == (date(2026, 6, 5) + timedelta(days=28 * 6)).isoformat()
    t = items["oppasclub"]
    assert t["frequency"] == "2-weekly" and t["per_month_cents"] == round(-2500 * 26 / 12)
    assert t["next_date"] == (date(2026, 9, 4) + timedelta(days=14 * 6)).isoformat()


def test_daily_bakjes_are_no_fixed_costs():
    def daily(merchant, dates, amounts, key="boodschappen"):
        out = rows(merchant, dates, amounts)
        for r in out:
            r["grp"], r["category_key"] = "daily", key
        return out
    weekly_shop = daily("lidl", [(date(2026, 8, 1) + timedelta(days=7 * i)).isoformat() for i in range(15)],
                        [-5000, -5200, -4900, -5100, -5050] * 3)
    fuel = daily("shell", months("2026-03-12", 8), [-6000, -6500, -6200, -6800, -6100, -6600, -6300, -6400],
                 "vervoer")
    gym = daily("basic-fit", months("2026-03-28", 8), -2999, "vrije-tijd")
    unsorted = daily("p:vriend", months("2026-03-02", 8), -2000, "unsorted")
    found = {i["merchant_key"] for i in recurring.detect(weekly_shop + fuel + gym + unsorted, NOV)}
    assert found == {"basic-fit", "p:vriend"}       # only stable, monthly-or-longer series


def test_new_only_with_history_before_it():
    rent = rows("rent", months("2026-09-05", 3), -100000)
    for r in rent:
        r["account_id"] = 1
    [item] = recurring.detect(rent, date(2026, 11, 15))
    assert item["status"] == "active"                # the data simply starts there
    old = rows("bank", months("2026-01-02", 11), -295)
    for r in old:
        r["account_id"] = 1
    items = {i["merchant_key"]: i for i in recurring.detect(rent + old, date(2026, 11, 15))}
    assert items["rent"]["status"] == "new"


def test_ignore_survives_a_price_change():
    first = rows("netflix", months("2026-01-09", 5), -1299)
    [item] = recurring.detect(first, date(2026, 5, 20))
    more = first + rows("netflix", months("2026-06-09", 3), -1599)
    assert recurring.detect(more, date(2026, 8, 20), {item["key"]}) == []
    assert isinstance(item["key"], str)


def test_api_totals_count_fixed_bakjes_only(client, book, today):
    chk = book.account("Betaal", "checking")
    book.monthly(chk, "2025-09-01", 6, -100000, "wonen", "Verhuurder", method="debit")
    book.monthly(chk, "2025-09-28", 6, -2999, "vrije-tijd", "Basic-Fit", method="debit")
    book.monthly(chk, "2025-09-24", 6, 300000, "salaris", "Werkgever")
    for i in range(20):
        book.tx(chk, (date(2025, 10, 4) + timedelta(days=7 * i)).isoformat(), -5000 - (i % 3) * 100,
                "boodschappen", "Lidl", method="card")
    book.commit()
    data = client.get("/api/recurring").json()
    assert {i["name"] for i in data["items"]} == {"Verhuurder", "Basic-Fit", "Werkgever"}
    assert data["monthly_out_cents"] == 100000 and data["monthly_in_cents"] == 300000
    o = client.get("/api/overview").json()
    assert [u["name"] for u in o["upcoming"]] == ["Verhuurder"]
    # rent was expected on 1 March and has not shown up: overdue, not still to come
    assert o["fixed_upcoming_cents"] == 0 and o["fixed_overdue_cents"] == 100000


def test_daily_series_must_be_the_merchants_only_activity():
    def daily(merchant, dates, amounts):
        out = rows(merchant, dates, amounts)
        for r in out:
            r["grp"], r["category_key"] = "daily", "uit-eten"
        return out
    visits = daily("brasserie", ["2025-12-05", "2026-06-04", "2026-12-03"], -3614)
    other = daily("brasserie", ["2026-02-01", "2026-03-15", "2026-08-08"], [-2000, -5100, -7600])
    assert recurring.detect(visits + other, date(2026, 12, 20)) == []
    sitter = daily("p:oppas", months("2026-01-02", 6), [-3500] * 3 + [-3000] * 3)
    for r in sitter:
        r["category_key"] = "unsorted"
    assert recurring.detect(sitter, date(2026, 6, 20)) == []      # linked prices are no subscription


def test_services_every_two_or_four_weeks_are_recurring(client, book):
    """A window cleaner every two weeks and a cleaner every four weeks, paid by transfer in a
    daily bakje, are fixed costs; a weekly-ish card habit is not (mock parity, 2026-11)."""
    chk = book.account("Betaal", "checking")
    day = date(2026, 1, 7)
    for i in range(12):
        book.tx(chk, (day + timedelta(days=14 * i)).isoformat(), -2250, "huis-tuin", "Glazenwasser",
                method="transfer")
    for i in range(6):
        book.tx(chk, (day + timedelta(days=28 * i)).isoformat(), -8400, "huis-tuin", "Schoonmaakhulp",
                method="transfer")
        book.tx(chk, (day + timedelta(days=14 * i)).isoformat(), -450, "uit-eten", "Koffiebar",
                method="card")
    book.commit()
    items = {i["name"]: i for i in client.get("/api/recurring").json()["items"]}
    assert items["Glazenwasser"]["frequency"] == "2-weekly"
    assert items["Schoonmaakhulp"]["frequency"] == "4-weekly"
    assert "Koffiebar" not in items


def test_yearly_card_pair_in_a_daily_bakje_is_a_coincidence(client, book):
    chk = book.account("Betaal", "checking")
    book.tx(chk, "2025-07-22", -4143, "vakantie", "Tankstation", method="card")
    book.tx(chk, "2026-07-22", -4102, "vakantie", "Tankstation", method="card")
    book.tx(chk, "2025-07-02", -124900, "vakantie", "Camping", method="ideal")
    book.tx(chk, "2026-07-02", -124900, "vakantie", "Camping", method="ideal")
    book.commit()
    names = {i["name"] for i in client.get("/api/recurring").json()["items"]}
    assert "Camping" in names and "Tankstation" not in names


def test_unsorted_fortnightly_transfers_are_not_fixed_costs(client, book):
    chk = book.account("Betaal", "checking")
    day = date(2026, 1, 7)
    for i in range(10):
        book.tx(chk, (day + timedelta(days=14 * i)).isoformat(), -2000, "unsorted", "p:kind",
                method="transfer")
    book.commit()
    assert not client.get("/api/recurring").json()["items"]


def test_one_name_two_accounts_are_two_items(client, book):
    """Transfers in your own name to a pocket-money account and an investment account are two
    fixed items, not one summed one (2026-11)."""
    chk = book.account("Betaal", "checking")
    for i in range(6):
        day = date(2026, 1, 1) + timedelta(days=31 * i)
        for iban in ("NL11BANK0000000001", "NL22BANK0000000002"):
            tid = book.tx(chk, day.replace(day=5).isoformat(), -10000, "sparen", "p:test gezin", method="transfer")
            book.conn.execute("UPDATE transactions SET counterparty_iban = ? WHERE id = ?", (iban, tid))
    book.commit()
    items = [i for i in client.get("/api/recurring").json()["items"] if i["merchant_key"] == "p:test gezin"]
    assert len(items) == 2
    assert {i["amount_cents"] for i in items} == {-10000}
    assert len({i["key"] for i in items}) == 2 and all("••" in i["name"] for i in items)


def test_potjes_on_one_day_and_two_accounts_in_one_name(client, book):
    """Several savings orders on one day (one per potje) are separate items, as are transfers
    in one name to an investment and a pocket-money account (2026-11)."""
    chk = book.account("Betaal", "checking")
    sav = book.account("Spaar", "savings", "NL33BANK0000000003")
    for i in range(6):
        d = (date(2026, 1, 5) + timedelta(days=31 * i)).replace(day=5).isoformat()
        for amt, what in ((-5000, "Vakantie"), (-5500, "Buffer"), (-10000, "Auto")):
            tid = book.tx(chk, d, amt, "sparen", "Spaar", kind="transfer", to=sav, method="internal", description=what)
            book.conn.execute("UPDATE transactions SET counterparty_iban = 'NL33BANK0000000003' WHERE id = ?", (tid,))
        for iban, amt in (("NL44BANK0000000004", -20000), ("NL55BANK0000000005", -20000)):
            tid = book.tx(chk, d, amt, "beleggen", "Test Gezin", method="transfer")
            book.conn.execute("UPDATE transactions SET counterparty_iban = ? WHERE id = ?", (iban, tid))
    book.commit()
    items = client.get("/api/recurring").json()["items"]
    pots = [i for i in items if i["merchant_key"] == "spaar"]
    assert len(pots) == 3 and all(i["change"] is None for i in pots)
    assert {i["amount_cents"] for i in pots} == {-5000, -5500, -10000}
    names = [i for i in items if i["merchant_key"] == "test gezin"]
    assert len(names) == 2


def test_potjes_names_codes_and_changing_descriptions(client, book):
    chk = book.account("Betaal", "checking")
    sav = book.account("Spaarrekening", "savings", "NL33BANK0000000003")
    book.commit()
    r = client.post("/api/goals", json={"name": "Nieuwe auto", "target_cents": 1000000, "code": "41827"})
    assert r.status_code in (200, 201), r.text
    goal = {"code": "41827"}
    months = ["januari", "februari", "maart", "april", "mei", "juni"]
    for i in range(6):
        d = (date(2026, 1, 5) + timedelta(days=31 * i)).replace(day=5).isoformat()
        rows = [(-5000, f"Spaardoel {goal['code']}"), (-5000, f"vakantie {months[i]} 2026"),
                (-3000, f"Opdracht {i + 1}: {months[i]}")]
        for amt, what in rows:
            book.tx(chk, d, amt, "sparen", "Spaarrekening", kind="transfer", to=sav, method="internal",
                    description=what)
    book.commit()
    names = sorted(i["name"] for i in client.get("/api/recurring").json()["items"] if i["merchant_key"] == "spaarrekening")
    # potje code -> the potje's name; a month in the text does not break the series; the
    # opdracht whose text has nothing stable left still counts (as "Spaarrekening · Opdracht")
    assert "Spaarrekening · Nieuwe auto" in names
    assert "Spaarrekening · Vakantie" in names and "Spaarrekening · Opdracht" in names
    assert len(names) == 3
    # each item lists exactly its own six payments, none shared (the detail screen shows these)
    items = [i for i in client.get("/api/recurring").json()["items"] if i["merchant_key"] == "spaarrekening"]
    ids = [set(i["tx_ids"]) for i in items]
    assert all(len(x) == 6 for x in ids) and not (ids[0] & ids[1]) and not (ids[1] & ids[2])


def test_transaction_shows_the_item_it_belongs_to(client, book):
    chk = book.account("Betaal", "checking")
    sav = book.account("Spaarrekening", "savings", "NL33BANK0000000003")
    ids = {}
    for i in range(6):
        d = (date(2026, 1, 5) + timedelta(days=31 * i)).replace(day=5).isoformat()
        for amt, what in ((-5000, "Vakantie"), (-3000, "Buffer")):
            ids.setdefault(what, []).append(book.tx(chk, d, amt, "sparen", "Spaarrekening", kind="transfer",
                                                    to=sav, method="internal", description=what))
    one_off = book.tx(chk, "2026-03-20", -77700, "sparen", "Spaarrekening", kind="transfer", to=sav,
                      method="internal", description="Extra")
    book.commit()
    buf = client.get(f"/api/transactions/{ids['Buffer'][-1]}").json()["merchant"]["recurring"]
    assert buf["name"] == "Spaarrekening · Buffer" and buf["amount_cents"] == -3000
    assert client.get(f"/api/transactions/{one_off}").json()["merchant"]["recurring"] is None
    listed = {i["key"] for i in client.get("/api/recurring").json()["items"]}
    assert buf["key"] in listed


def test_one_off_transfer_elsewhere_keeps_the_key(client, book):
    """A single transfer in the same name to another account does not rename or rekey the
    existing item, so "Geen vaste last" keeps working (review 1.0)."""
    chk = book.account("Betaal", "checking")
    for i in range(6):
        d = (date(2026, 1, 5) + timedelta(days=31 * i)).replace(day=5).isoformat()
        tid = book.tx(chk, d, -10000, "beleggen", "Test Gezin", method="transfer")
        book.conn.execute("UPDATE transactions SET counterparty_iban = 'NL11BANK0000000001' WHERE id = ?", (tid,))
    book.commit()
    before = [i["key"] for i in client.get("/api/recurring").json()["items"]]
    tid = book.tx(chk, "2026-06-20", -2500, "beleggen", "Test Gezin", method="transfer")
    book.conn.execute("UPDATE transactions SET counterparty_iban = 'NL99BANK0000000099' WHERE id = ?", (tid,))
    book.commit()
    assert [i["key"] for i in client.get("/api/recurring").json()["items"]] == before


def test_end_of_month_payment_stays_at_month_end():
    item = {"status": "active", "frequency": "monthly", "next_date": "2026-01-31", "day_of_month": 31}
    days = recurring.occurrences(item, date(2026, 1, 1), date(2026, 5, 1))
    assert [d.isoformat() for d in days] == ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]


def test_own_account_return_is_never_income():
    """A monthly top-up of a boodschappen potje on the savings account, paid back every week:
    both are own-account transfers, not income or a fixed cost."""
    from cents.services import recurring as rec
    from datetime import date, timedelta
    rows = []
    d = date(2026, 1, 5)
    for n in range(40):
        rows.append({"id": n + 1, "date": d.isoformat(), "amount_cents": 10000, "merchant_key": "p:eigen", "merchant_name": "Eigen spaar",
                     "account_id": 1, "account_type": "checking", "transfer_account_id": 2, "transfer_account_name": "Spaar",
                     "counterparty_iban": "NL00TEST0000000002", "method": "transfer", "kind": "transfer",
                     "description": "Boodschappen", "category_id": None, "grp": "saving"})
        d += timedelta(days=7)
    found = rec.detect_full(rows, date(2026, 10, 20))
    assert found and all(i["own_account"] for i in found)


def test_outlook_saves_minus_withdrawals():
    """Sparen min opnemen: a monthly top-up out and weekly returns in net out in Nog te besteden."""
    from datetime import date
    from cents.services import outlook
    out = {"own_account": True, "direction": "out", "amount_cents": -40000, "frequency": "monthly",
           "next_date": "2026-11-25", "status": "active", "day_of_month": 25, "interval_days": 30}
    back = {"own_account": True, "direction": "in", "amount_cents": 10000, "frequency": "weekly",
            "next_date": "2026-11-20", "status": "active", "interval_days": 7}
    moves = outlook._own_moves([out, back], date(2026, 11, 19), date(2026, 11, 30))
    assert -sum(i["amount_cents"] for i, _ in moves) == 40000 - 2 * 10000
