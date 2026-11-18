"""Costs over time: uitsmeren (spread a payment) and bezittingen (possession with waardeverlies).
All synthetic: Jan + Feb complete, today 15 March 2026 (see book.py)."""

from __future__ import annotations

from book import book, today  # noqa: F401  (fixtures)

from cents.services import spread
from test_summary import household


def spent(client, period):
    o = client.get(f"/api/overview?period={period}").json()
    return o["fixed_cents"] + o["daily_cents"]


def test_amounts_and_schedule_edges():
    assert spread.amounts(1000, 3) == [334, 333, 333]
    assert sum(spread.amounts(2_500_000, 96, 500_000)) == 2_000_000
    assert spread.amounts(100, 4, 500) == [0, 0, 0, 0]          # residual never above the price


def test_spread_payment_counts_in_parts(client, book):
    chk, _ = household(book)
    laptop = book.tx(chk, "2026-02-14", -120000, "winkelen", "Laptopwinkel", method="card")
    book.commit()
    jan, feb, mar = spent(client, "2026-01"), spent(client, "2026-02"), spent(client, "2026-03")
    r = client.patch(f"/api/transactions/{laptop}", json={"spread_months": 12})
    assert r.status_code == 200, r.text
    tx = client.get(f"/api/transactions/{laptop}").json()
    assert tx["spread_months"] == 12
    assert tx["spread"] == {"kind": "spread", "months": 12, "monthly_cents": 10000,
                            "from": "2026-02", "to": "2027-01"}
    assert spent(client, "2026-01") == jan
    assert spent(client, "2026-02") == feb - 120000 + 10000
    assert spent(client, "2026-03") == mar + 10000
    # the bakje shows the part, not the full payment
    cat = client.get("/api/bootstrap").json()
    win = next(c for c in cat["categories"] if c["key"] == "winkelen")
    s = client.get(f"/api/categories/{win['id']}/summary?period=2026-03").json()
    assert s["spent_cents"] == 10000
    assert [p["index"] for p in s["parts"]] == [2] and s["parts"][0]["tx_id"] == laptop
    assert all(t["id"] != laptop for t in s["transactions"])
    # a month with only parts is no imported month: averages stay on real months
    o = client.get("/api/overview?period=2026-03").json()
    assert o["categories"]
    client.patch(f"/api/transactions/{laptop}", json={"spread_months": None})
    assert spent(client, "2026-02") == feb


def test_only_spending_can_be_spread(client, book):
    chk, _ = household(book)
    salary = book.tx(chk, "2026-03-10", 10000, "salaris", "Werkgever")
    book.commit()
    r = client.patch(f"/api/transactions/{salary}", json={"spread_months": 12})
    assert r.status_code == 400 and r.json()["error"]["code"] == "spread_not_spending"


def test_possession_counts_waardeverlies_not_the_purchase(client, book):
    chk, _ = household(book)
    car = book.tx(chk, "2026-02-03", -2500000, "vervoer", "Autobedrijf", method="transfer")
    book.commit()
    feb = spent(client, "2026-02")
    r = client.post("/api/assets", json={"kind": "possession", "name": "Auto", "tx_id": car,
                                         "life_months": 96, "residual_cents": 580000})
    assert r.status_code == 200, r.text
    item = next(i for i in r.json()["items"] if i["kind"] == "possession")
    assert item["emoji"] == "🚗" and item["price_cents"] == 2500000
    assert item["monthly_cents"] == 20000 and item["end_period"] == "2034-01"
    assert spent(client, "2026-02") == feb - 2500000 + 20000
    tx = client.get(f"/api/transactions/{car}").json()
    assert tx["possession"]["role"] == "purchase" and tx["spread"]["kind"] == "possession"
    # value on Vermogen: from the price down, counted in the total
    nw = client.get("/api/networth").json()
    a = next(x for x in nw["assets"] if x["kind"] == "possession")
    assert 2500000 - 40000 < a["value_cents"] < 2500000
    # cannot also spread the purchase
    r = client.patch(f"/api/transactions/{car}", json={"spread_months": 12})
    assert r.json()["error"]["code"] == "spread_possession"


def test_possession_sale_settles_the_difference(client, book, today):
    chk, _ = household(book)
    car = book.tx(chk, "2026-01-05", -1200000, "vervoer", "Autobedrijf")
    sold = book.tx(chk, "2026-03-08", 1100000, "inkomen-overig", "Koper")
    book.commit()
    aid = client.post("/api/assets", json={"kind": "possession", "name": "Auto", "tx_id": car,
                                           "life_months": 120, "residual_cents": 0}).json()["id"]
    income_before = client.get("/api/overview?period=2026-03").json()["income_cents"]
    mar_before = spent(client, "2026-03")                     # includes the March part (10000)
    r = client.patch(f"/api/assets/{aid}", json={"sale_tx_id": sold})
    assert r.status_code == 200, r.text
    o = client.get("/api/overview?period=2026-03").json()
    assert o["income_cents"] == income_before - 1100000         # the sale is no income
    # Jan + Feb parts were 2 x 10000; book value 1180000 - sold 1100000 = 80000 loss in March
    assert spent(client, "2026-03") == mar_before - 10000 + 80000
    assert spent(client, "2026-04") == 0                       # no parts after the sale
    item = next(i for i in client.get("/api/assets").json()["items"] if i["id"] == aid)
    assert item["sale"]["cents"] == 1100000 and item["value_cents"] == 0
    nw = client.get("/api/networth").json()
    assert next(x for x in nw["assets"] if x["id"] == aid)["value_cents"] == 0
    # undo the sale
    client.patch(f"/api/assets/{aid}", json={"sale_tx_id": None, "sale_date": None, "sale_cents": None})
    assert client.get("/api/overview?period=2026-03").json()["income_cents"] == income_before


def test_possession_without_payment_and_inruil(client, book):
    household(book)
    r = client.post("/api/assets", json={"kind": "possession", "name": "Oude auto", "price_cents": 960000,
                                         "start_date": "2020-03-01", "life_months": 96, "residual_cents": 0})
    assert r.status_code == 200, r.text
    aid = r.json()["id"]
    from cents import db
    from cents.services import ledger
    lg = ledger.build(db.connect(client.app.state.db_path))
    assert lg.flows_for(lg.period("2025-06")).spread_daily == 10000
    assert not lg.has_data("2025-06")                         # only parts: no imported month
    assert lg.complete_before(lg.current(), 10) == [lg.period("2026-02"), lg.period("2026-01")]
    # traded in on 1 March for 150000 while its book value was 960000 - 72 x 10000 = 240000
    client.patch(f"/api/assets/{aid}", json={"sale_date": "2026-03-01", "sale_cents": 150000})
    s = spread.amounts(960000, 96)
    assert sum(s[:72]) == 720000
    o3 = spent(client, "2026-03")
    client.patch(f"/api/assets/{aid}", json={"sale_date": None, "sale_cents": None, "sale_tx_id": None})
    assert spent(client, "2026-03") == o3 - 90000 + 10000


def test_purchase_candidates_skip_rent(client, book):
    chk, _ = household(book)
    book.tx(chk, "2026-02-03", -2500000, "vervoer", "Autobedrijf")
    book.commit()
    c = client.get("/api/assets").json()["purchase_candidates"]
    names = [x["merchant_name"] for x in c]
    assert "Autobedrijf" in names and "Verhuurder" not in names
