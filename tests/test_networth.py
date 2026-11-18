"""Net worth: balances, manual fallback, investments with and without values, credit card,
month-end series carried forward."""

from __future__ import annotations

from book import book, today  # noqa: F401  (fixtures)


def test_networth(client, book):
    chk = book.account("Betaal", "checking", "NL01TEST0000000001")
    book.account("Spaar", "savings", "NL02TEST0000000002", manual_balance=500000,
                 manual_date="2026-02-01")
    inv = book.account("Broker", "investment", match=["broker"])
    inv2 = book.account("Pensioen", "investment")
    card = book.account("Creditcard", "credit")
    hidden = book.account("Oud", "checking", manual_balance=999999, manual_date="2026-01-01")
    book.conn.execute("UPDATE accounts SET hidden = 1 WHERE id = ?", (hidden,))
    book.tx(chk, "2026-01-10", 100000, "salaris", "Werk", balance=100000)
    book.tx(chk, "2026-01-15", -25000, "beleggen", "Broker", kind="transfer", to=inv, balance=75000)
    book.tx(chk, "2026-02-15", -25000, "beleggen", "Broker", kind="transfer", to=inv, balance=50000)
    book.tx(chk, "2026-02-16", -10000, "beleggen", "Pensioen", kind="transfer", to=inv2, balance=40000)
    book.tx(chk, "2026-02-20", 100000, "salaris", "Werk", balance=140000)
    book.tx(card, "2026-03-02", -3000, "uit-eten", "Bistro", manual=1, method="card")
    book.commit()
    client.post(f"/api/accounts/{inv}/values", json={"date": "2026-01-31", "value_cents": 26000})

    nw = client.get("/api/networth").json()
    acc = {a["name"]: a for a in nw["accounts"]}
    assert "Oud" not in acc
    assert acc["Betaal"]["balance_cents"] == 140000 and acc["Betaal"]["as_of"] == "2026-02-20"
    assert acc["Spaar"]["balance_cents"] == 500000 and acc["Spaar"]["as_of"] == "2026-02-01"
    broker = acc["Broker"]
    assert broker["invested_cents"] == 50000
    assert broker["balance_cents"] == 26000 + 25000          # last value + money moved in since
    assert broker["result_cents"] == 1000 and broker["as_of"] == "2026-01-31"
    assert [v["value_cents"] for v in broker["values"]] == [26000]
    pension = acc["Pensioen"]                                # no value entered yet
    assert pension["balance_cents"] == 10000 and pension["invested_cents"] == 10000
    assert pension["result_cents"] is None and pension["values"] == []
    assert acc["Creditcard"]["balance_cents"] == -3000 and acc["Creditcard"]["outstanding_cents"] == 3000
    assert nw["total_cents"] == 140000 + 500000 + 51000 + 10000 - 3000

    series = {s["month"]: s for s in nw["series"]}
    assert list(series) == ["2026-01", "2026-02", "2026-03"]
    assert series["2026-01"] == {"month": "2026-01", "checking_cents": 75000, "savings_cents": 0,
                                 "investment_cents": 26000, "credit_cents": 0, "total_cents": 101000}
    assert series["2026-02"]["total_cents"] == 140000 + 500000 + 51000 + 10000
    assert series["2026-03"]["total_cents"] == nw["total_cents"]   # carried forward
    assert series["2026-03"]["credit_cents"] == -3000


def test_checking_without_data_has_no_balance(client, book):
    book.account("Leeg", "checking")
    book.commit()
    nw = client.get("/api/networth").json()
    assert nw["accounts"][0]["balance_cents"] is None and nw["total_cents"] == 0
    assert nw["series"] == []


def test_manual_savings_balance_is_a_fixed_point_moved_by_transfers(client, book):
    """A savings account fed only from checking: the manual balance anchors the line, transfers
    move it before and after, and correcting it shifts the whole history instead of showing a
    deposit this month."""
    chk = book.account("Betaal", "checking", "NL01TEST0000000001")
    sav = book.account("Spaar", "savings", "NL02TEST0000000002", manual_balance=300000,
                       manual_date="2026-02-10")
    book.tx(chk, "2026-01-05", -50000, "sparen", "Spaar", kind="transfer", to=sav, balance=50000)
    book.tx(chk, "2026-02-05", -50000, "sparen", "Spaar", kind="transfer", to=sav, balance=0)
    book.tx(chk, "2026-03-05", -20000, "sparen", "Spaar", kind="transfer", to=sav, balance=-20000)
    book.tx(chk, "2026-03-06", 5000, "sparen", "Spaar", kind="transfer", to=sav, balance=-15000)
    book.commit()

    def savings():
        nw = client.get("/api/networth").json()
        acc = {a["name"]: a for a in nw["accounts"]}
        return acc["Spaar"], {s["month"]: s["savings_cents"] for s in nw["series"]}

    acc, series = savings()
    assert acc["balance_cents"] == 300000 + 20000 - 5000 and acc["as_of"] == "2026-03-06"
    assert series == {"2026-01": 250000, "2026-02": 300000, "2026-03": 315000}

    # correct the starting balance: +100.000 everywhere, nothing extra in March
    client.patch(f"/api/accounts/{sav}", json={"manual_balance_cents": 415000,
                                                "manual_balance_date": "2026-03-15"})
    acc, series = savings()
    assert acc["balance_cents"] == 415000
    assert series == {"2026-01": 350000, "2026-02": 400000, "2026-03": 415000}


def test_locked_savings_counts_in_networth_not_in_free_money(client, book):
    chk = book.account("Betaal", "checking", "NL01TEST0000000001")
    sav = book.account("Vast", "savings", manual_balance=1000000, manual_date="2026-03-01")
    book.tx(chk, "2026-03-01", 200000, "salaris", "Werk", balance=200000)
    book.commit()
    before = client.get("/api/overview").json()
    r = client.patch(f"/api/accounts/{sav}", json={"locked": True})
    assert r.status_code == 200 and r.json()["locked"] is True
    nw = client.get("/api/networth").json()
    assert nw["total_cents"] == 1200000
    assert {a["name"]: a["locked"] for a in nw["accounts"]} == {"Betaal": False, "Vast": True}
    after = client.get("/api/overview").json()
    assert before != after          # the fixed account no longer feeds Nog te besteden / buffer
