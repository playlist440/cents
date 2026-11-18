"""Overview, trends, bakje and tag summaries on small hand-computed households."""

from __future__ import annotations

from book import book, today  # noqa: F401  (fixtures)


def household(book):
    """Jan + Feb complete, today 15 March. Both sides of the savings transfer are imported."""
    chk = book.account("Betaal", "checking", "NL01TEST0000000001")
    sav = book.account("Spaar", "savings", "NL02TEST0000000002")
    for m in ("01", "02"):
        book.tx(chk, f"2026-{m}-01", -100000, "wonen", "Verhuurder", method="debit")
        book.tx(chk, f"2026-{m}-10", -20000, "boodschappen", "Jumbo", method="card")
        book.tx(chk, f"2026-{m}-12", 5000, "boodschappen", "Jumbo", method="card")      # refund
        book.tx(chk, f"2026-{m}-15", -3000, "unsorted", "Onbekend")
        book.tx(chk, f"2026-{m}-16", 2000, "unsorted", "p:vriend")
        book.tx(chk, f"2026-{m}-25", 300000, "salaris", "Werkgever")
        book.tx(chk, f"2026-{m}-26", -50000, "sparen", "Spaar", kind="transfer", to=sav,
                method="internal")
        book.tx(sav, f"2026-{m}-26", 50000, "intern", "Betaal", kind="transfer", to=chk,
                method="internal")
        book.tx(chk, f"2026-{m}-27", -10000, "intern", "Andere", kind="transfer", method="internal")
    book.tx(sav, "2026-01-01", 1500, "sparen", "Rente", method="interest")
    book.tx(chk, "2026-03-01", -100000, "wonen", "Verhuurder", method="debit")
    book.tx(chk, "2026-03-05", -10000, "boodschappen", "Jumbo", method="card")
    book.commit()
    return chk, sav


def test_overview_past_period_groups(client, book):
    household(book)
    o = client.get("/api/overview?period=2026-01").json()
    # income: salary + unsorted in + savings interest; the savings-side mirror never counts
    assert o["income_cents"] == 300000 + 2000 + 1500
    assert o["fixed_cents"] == 100000
    assert o["daily_cents"] == 20000 - 5000 + 3000
    assert o["saved_cents"] == 50000
    assert o["net_cents"] == 303500 - 100000 - 18000 - 50000
    assert o["left_cents"] is None and o["per_day_left_cents"] is None
    assert o["period"]["id"] == "2026-01" and o["period"]["is_current"] is False
    cats = {c["category_id"]: c for c in o["categories"]}
    ids = book.cats
    assert cats[ids["wonen"]]["spent_cents"] == 100000
    assert cats[ids["boodschappen"]]["spent_cents"] == 15000
    assert cats[ids["boodschappen"]]["count"] == 2
    assert cats[ids["unsorted"]]["spent_cents"] == 3000
    assert [c["spent_cents"] for c in o["categories"]] == sorted(
        [c["spent_cents"] for c in o["categories"]], reverse=True)
    income = {i["category_id"]: i["cents"] for i in o["income"]}
    assert income == {ids["salaris"]: 300000, ids["unsorted"]: 2000, ids["inkomen-overig"]: 1500}
    assert len(o["pace"]["days"]) == 31 and o["pace"]["actual"][-1] == 18000
    assert o["pace"]["typical"] == []     # no complete period before January


def test_overview_current_period_left(client, book):
    household(book)
    o = client.get("/api/overview").json()
    assert o["period"]["id"] == "2026-03" and o["period"]["is_current"]
    assert o["income_cents"] == 0                                # a period without income
    feb_income = 300000 + 2000
    jan_income = 300000 + 2000 + 1500
    expected = round((jan_income + feb_income) / 2)
    assert o["expected_income_cents"] == expected               # no recurring income yet
    assert o["fixed_cents"] == 100000 and o["daily_cents"] == 10000
    assert o["left_cents"] == expected - 100000 - 10000
    assert o["per_day_left_cents"] == int(o["left_cents"] / 17)  # 15..31 March
    # typical = median of January and February at each day index (two months: their mean)
    assert o["pace"]["typical"][9] == 20000                      # day 10: groceries both months
    assert o["pace"]["typical"][-1] == 18000
    assert len(o["pace"]["actual"]) == 8                         # data until 5 March + 3 days
    cats = {c["category_id"]: c for c in o["categories"]}
    assert cats[book.cats["boodschappen"]]["avg_cents"] == 15000
    assert o["balance"]["checking_cents"] == 0


def test_no_double_counting_and_trends(client, book):
    household(book)
    t = client.get("/api/trends?periods=3").json()
    assert [p["period"] for p in t["periods"]] == ["2026-01", "2026-02", "2026-03"]
    assert [p["saved_cents"] for p in t["periods"]] == [50000, 50000, 0]
    assert t["periods"][1]["net_cents"] == 302000 - 100000 - 18000 - 50000
    cats = {c["category_id"]: c["cents"] for c in t["categories"]}
    assert cats[book.cats["wonen"]] == [100000, 100000, 100000]
    top = t["top_merchants"][0]
    assert top["merchant_key"] == "verhuurder" and top["cents"] == 300000 and top["count"] == 3
    # 12 asked, only 3 periods with data
    assert len(client.get("/api/trends").json()["periods"]) == 3


def test_credit_card_settlement(client, book, today):
    chk = book.account("Betaal", "checking")
    card = book.account("Creditcard", "credit", match=["ics"])
    book.tx(card, "2026-02-03", -3000, "uit-eten", "Bistro", manual=1, method="card")
    book.tx(card, "2026-02-10", -2000, "kleding", "Winkel", manual=1, method="card")
    book.tx(chk, "2026-02-23", -8000, "creditcard", "ICS", kind="settlement", to=card, method="debit")
    book.tx(chk, "2026-02-24", -4000, "creditcard", "Andere kaart", method="debit")   # no account
    book.tx(card, "2026-03-02", -1000, "uit-eten", "Bistro", manual=1, method="card")
    book.commit()
    feb = client.get("/api/overview?period=2026-02").json()
    cats = {c["category_id"]: c["spent_cents"] for c in feb["categories"]}
    assert cats[book.cats["uit-eten"]] == 3000 and cats[book.cats["kleding"]] == 2000
    assert cats[book.cats["creditcard"]] == 3000 + 4000          # unexplained parts only
    assert feb["daily_cents"] == 3000 + 2000 + 7000
    nw = client.get("/api/networth").json()
    acc = next(a for a in nw["accounts"] if a["type"] == "credit")
    assert acc["outstanding_cents"] == 1000 and acc["balance_cents"] == -1000
    assert acc["unexplained_cents"] == 3000


def test_credit_card_without_manual_purchases(client, book):
    chk = book.account("Betaal", "checking")
    card = book.account("Creditcard", "credit", match=["ics"])
    book.tx(chk, "2026-02-23", -8000, "creditcard", "ICS", kind="settlement", to=card, method="debit")
    book.commit()
    feb = client.get("/api/overview?period=2026-02").json()
    assert feb["daily_cents"] == 8000
    acc = next(a for a in client.get("/api/networth").json()["accounts"] if a["type"] == "credit")
    assert acc["outstanding_cents"] == 0 and acc["unexplained_cents"] == 8000


def test_category_and_tag_summary(client, book):
    household(book)
    s = client.get(f"/api/categories/{book.cats['boodschappen']}/summary?period=2026-02").json()
    assert s["spent_cents"] == 15000 and s["count"] == 2 and s["avg_cents"] == 15000
    assert len(s["series"]) == 12 and s["series"][-1] == {"period": "2026-02", "cents": 15000}
    assert s["series"][-2] == {"period": "2026-01", "cents": 15000}
    assert s["merchants"] == [{"merchant_key": "jumbo", "merchant_name": "Jumbo", "cents": 15000, "count": 2}]
    assert [t["amount_cents"] for t in s["transactions"]] == [5000, -20000]
    sal = client.get(f"/api/categories/{book.cats['salaris']}/summary?period=2026-02").json()
    assert sal["spent_cents"] == 300000
    assert client.get("/api/categories/9999/summary").status_code == 404
    assert client.get(f"/api/categories/{book.cats['salaris']}/summary?period=xx").status_code == 400

    tag = client.post("/api/tags", json={"name": "Verbouwing"}).json()
    ids = [r["id"] for r in client.get("/api/transactions?merchant_key=jumbo").json()["items"]]
    client.post("/api/transactions/bulk", json={"ids": ids, "add_tag_ids": [tag["id"]]})
    t = client.get(f"/api/tags/{tag['id']}/summary").json()
    assert t["count"] == 5
    assert t["total_out_cents"] == -50000 and t["total_in_cents"] == 10000
    assert t["by_category"] == [{"category_id": book.cats["boodschappen"], "cents": 40000}]
    assert t["by_month"] == [{"month": "2026-01", "cents": 15000}, {"month": "2026-02", "cents": 15000},
                             {"month": "2026-03", "cents": 10000}]
    assert t["first_date"] == "2026-01-10" and t["last_date"] == "2026-03-05"


def test_month_start_day_24(client, book, today):
    client.patch("/api/settings", json={"month_start_day": 24})
    chk = book.account("Betaal", "checking")
    book.tx(chk, "2026-02-23", 1000, "salaris", "Werk")      # period 2026-02 (24 Jan - 23 Feb)
    book.tx(chk, "2026-02-24", 2000, "salaris", "Werk")      # period 2026-03 (24 Feb - 23 Mar)
    book.tx(chk, "2026-03-23", 4000, "salaris", "Werk")      # period 2026-03
    book.commit()
    o = client.get("/api/overview?period=2026-03").json()
    assert o["period"]["from"] == "2026-02-24" and o["period"]["to"] == "2026-03-23"
    assert o["income_cents"] == 6000 and o["period"]["is_current"]
    assert len(o["pace"]["days"]) == 28
    assert client.get("/api/overview?period=2026-02").json()["income_cents"] == 1000


def test_single_month(client, book, today):
    chk = book.account("Betaal", "checking")
    book.tx(chk, "2026-03-02", 250000, "salaris", "Werk")
    book.tx(chk, "2026-03-03", -12345, "boodschappen", "Jumbo", method="card")
    book.commit()
    o = client.get("/api/overview").json()
    assert o["income_cents"] == 250000 and o["daily_cents"] == 12345
    assert o["left_cents"] is None and o["expected_income_cents"] == 250000
    assert o["pace"]["typical"] == [] and o["balance"]["expected_end_cents"] is None
    assert len(client.get("/api/trends").json()["periods"]) == 1
    assert client.get("/api/recurring").json()["items"] == []
    assert client.get("/api/goals").status_code == 200


def test_empty_database_every_endpoint(client, today):
    o = client.get("/api/overview").json()
    assert o["income_cents"] == 0 and o["left_cents"] is None and o["pace"] is None
    assert o["categories"] == [] and o["insights"] == [] and o["upcoming"] == []
    assert o["unsorted"] == {"merchants": 0, "transactions": 0, "cents": 0}
    assert client.get("/api/overview?period=2020-01").status_code == 200
    assert client.get("/api/trends").json() == {"periods": [], "categories": [], "top_merchants": []}
    assert client.get("/api/recurring").json() == {"monthly_out_cents": 0, "monthly_in_cents": 0,
                                                   "yearly_out_cents": 0, "items": [],
                                                   "subscriptions": {"per_month_cents": 0,
                                                                     "per_year_cents": 0, "count": 0}}
    g = client.get("/api/goals").json()
    assert g["goals"] == [] and g["room"] is None and g["savings_balance_cents"] is None
    assert g["suggestions"] == [] and g["unassigned"] == []
    assert client.get("/api/networth").json() == {"total_cents": 0, "accounts": [], "series": [],
                                                  "home": None, "assets": [],
                                                  "pension_excluded_cents": None}
    cat = client.get("/api/categories").json()[0]["id"]
    s = client.get(f"/api/categories/{cat}/summary").json()
    assert s["spent_cents"] == 0 and len(s["series"]) == 12 and s["transactions"] == []
    tag = client.post("/api/tags", json={"name": "Leeg"}).json()
    assert client.get(f"/api/tags/{tag['id']}/summary").json()["count"] == 0
    assert client.get("/api/overview?period=nope").status_code == 400


def test_typical_pace_is_the_median(client, book):
    """One unusual month does not move "normaal": median per day index, not the mean."""
    chk = book.account("Betaal", "checking")
    book.tx(chk, "2025-11-20", 300000, "salaris", "Werkgever")     # data start: Dec is complete
    for m, cents in (("2025-12", 20000), ("2026-01", 20000), ("2026-02", 200000)):
        book.tx(chk, f"{m}-10", -cents, "boodschappen", "Jumbo", method="card")
    book.tx(chk, "2026-03-05", -1000, "boodschappen", "Jumbo", method="card")
    book.commit()
    o = client.get("/api/overview").json()
    assert o["pace"]["typical"][9] == 20000 and o["pace"]["typical"][-1] == 20000


def test_late_debit_counts_in_previous_month(client, book):
    """Kinderopvang came on 1 March instead of end of February: move it back one month."""
    chk, _ = household(book)
    late = book.tx(chk, "2026-03-01", -80000, "kinderen", "Kinderopvang", method="debit")
    book.commit()
    spent = lambda p: (lambda o: o["fixed_cents"] + o["daily_cents"])(client.get(f"/api/overview?period={p}").json())  # noqa: E731
    feb, mar = spent("2026-02"), spent("2026-03")
    r = client.patch(f"/api/transactions/{late}", json={"book_date": "2026-02-28"})
    assert r.status_code == 200, r.text
    assert client.get(f"/api/transactions/{late}").json()["book_date"] == "2026-02-28"
    assert spent("2026-02") == feb + 80000
    assert spent("2026-03") == mar - 80000
    client.patch(f"/api/transactions/{late}", json={"book_date": None})
    assert spent("2026-03") == mar
