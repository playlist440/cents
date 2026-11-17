"""Year overview (GET /overview?period=YYYY): started periods of a year added up."""

from __future__ import annotations

from book import book, today  # noqa: F401  (fixtures)
from test_summary import household

KEYS = ("income_cents", "fixed_cents", "daily_cents", "saved_cents", "net_cents")


def test_year_to_date_sums_months(client, book):
    household(book)                      # Jan + Feb complete, today 15 March 2026
    y = client.get("/api/overview?period=2026").json()
    months = [client.get(f"/api/overview?period=2026-0{m}").json() for m in (1, 2, 3)]
    assert y["period"]["id"] == "2026" and y["period"]["kind"] == "year"
    assert y["period"]["ytd"] and y["period"]["is_current"] and y["period"]["months"] == 3
    assert y["period"]["from"] == "2026-01-01" and y["period"]["to"] == "2026-03-15"
    assert y["period"]["label"] == "2026 tot nu"
    for k in KEYS:
        assert y[k] == sum(m[k] for m in months), k
    assert [m["period"] for m in y["months"]] == ["2026-01", "2026-02", "2026-03"]
    assert [m["partial"] for m in y["months"]] == [False, False, True]
    assert [m["net_cents"] for m in y["months"]] == [m["net_cents"] for m in months]
    cats = {c["category_id"]: c["spent_cents"] for c in y["categories"]}
    for m in months:
        for c in m["categories"]:
            cats[c["category_id"]] -= c["spent_cents"]
    assert set(cats.values()) == {0}
    assert sum(i["cents"] for i in y["income"]) == y["income_cents"]
    # now-only figures are not given for a year
    assert y["free"] is None and y["checking_warning"] is None and y["left_cents"] is None
    assert y["pace"] is None and y["upcoming"] == []
    assert y["previous_year"] is None    # no data in 2025
    assert y["period"]["prev"] is None and y["period"]["next"] is None


def test_ytd_respects_today(client, book, today):
    household(book)
    today("2026-02-10")                  # March has not started: Jan + Feb only
    y = client.get("/api/overview?period=2026").json()
    assert y["period"]["months"] == 2 and y["period"]["to"] == "2026-02-10"
    feb_part = client.get("/api/overview?period=2026-02").json()
    jan = client.get("/api/overview?period=2026-01").json()
    assert y["income_cents"] == jan["income_cents"] + feb_part["income_cents"]
    assert client.get("/api/overview?period=2027").status_code == 400


def test_past_full_year_and_previous_year(client, book, today):
    chk = book.account("Betaal", "checking")
    for m in range(1, 13):
        book.tx(chk, f"2025-{m:02d}-05", -10000, "boodschappen", "Jumbo", method="card")
        book.tx(chk, f"2025-{m:02d}-25", 200000, "salaris", "Werk")
    for m in (1, 2, 3):
        book.tx(chk, f"2026-{m:02d}-05", -12000, "boodschappen", "Jumbo", method="card")
    book.commit()
    y25 = client.get("/api/overview?period=2025").json()
    assert not y25["period"]["ytd"] and y25["period"]["months"] == 12
    assert y25["period"]["label"] == "2025" and y25["period"]["to"] == "2025-12-31"
    assert y25["daily_cents"] == 120000 and y25["income_cents"] == 2400000
    assert y25["per_month"]["daily_cents"] == 10000
    assert y25["period"]["next"] == "2026" and y25["period"]["prev"] is None
    y26 = client.get("/api/overview?period=2026").json()
    assert y26["period"]["prev"] == "2025"
    # normaal = the same months a year earlier
    assert y26["previous_year"]["daily_cents"] == 30000
    jumbo = next(c for c in y26["categories"] if c["category_id"] == book.cats["boodschappen"])
    assert jumbo["spent_cents"] == 36000 and jumbo["avg_cents"] == 30000


def test_year_month_start_day_boundaries(client, book, today):
    client.patch("/api/settings", json={"month_start_day": 24})
    chk = book.account("Betaal", "checking")
    book.tx(chk, "2025-12-23", 1000, "salaris", "Werk")    # period 2025-12: not in 2026
    book.tx(chk, "2025-12-24", 2000, "salaris", "Werk")    # period 2026-01 (24 Dec - 23 Jan)
    book.tx(chk, "2026-03-15", 4000, "salaris", "Werk")    # period 2026-03 (current)
    book.tx(chk, "2026-03-24", 8000, "salaris", "Werk")    # future period 2026-04
    book.commit()
    y = client.get("/api/overview?period=2026").json()
    assert y["period"]["from"] == "2025-12-24" and y["period"]["months"] == 3
    assert y["income_cents"] == 6000
    assert client.get("/api/overview?period=2025").json()["income_cents"] == 1000


def test_bad_year(client, book):
    assert client.get("/api/overview?period=1900").status_code == 400
    assert client.get("/api/overview?period=20x6").status_code == 400


def test_per_month_counts_months_with_data(client, book, today):
    today("2026-11-17")
    chk = book.account("Betaal", "checking")
    for m in (6, 7, 8, 9, 10, 11):
        book.tx(chk, f"2026-{m:02d}-05", -6000, "boodschappen", "Jumbo", method="card")
    book.commit()
    y = client.get("/api/overview?period=2026").json()
    assert y["period"]["months"] == 11 and y["daily_cents"] == 36000
    assert y["per_month"]["daily_cents"] == 6000           # six months with data, not eleven
