"""Subscriptions entered by hand (credit card, private account): listed in Vaste lasten and in
the subscriptions total, never in the budget figures."""

from __future__ import annotations

from book import book, today  # noqa: F401  (fixtures)


def test_manual_subscription_listed_not_counted(client, book, today):
    today("2026-11-19")
    chk = book.account("Betaal", "checking", "NL01TEST0000000001")
    book.monthly(chk, "2026-01-20", 10, 300000, "salaris", "Werkgever")
    book.monthly(chk, "2026-01-01", 10, -100000, "wonen", "Verhuurder", method="debit")
    book.commit()
    before = client.get("/api/recurring").json()
    ov_before = client.get("/api/overview").json()
    r = client.post("/api/subscriptions", json={"name": "Spotify", "amount_cents": 1199, "frequency": "monthly",
                                                "start_date": "2025-03-31", "paid_from": "Privérekening"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["manual"] and s["next_date"] == "2026-11-30" and s["per_year_cents"] == 1199 * 12
    for freq, nxt in (("weekly", "2026-11-23"), ("4-weekly", "2026-12-07"), ("yearly", "2027-03-31")):
        x = client.post("/api/subscriptions", json={"name": f"X {freq}", "amount_cents": 500, "frequency": freq,
                                                    "start_date": "2025-03-31"}).json()
        assert x["next_date"] == nxt, (freq, x["next_date"])
        client.delete(f"/api/subscriptions/{x['id']}")
    after = client.get("/api/recurring").json()
    assert after["monthly_out_cents"] == before["monthly_out_cents"]
    assert after["subscriptions"]["per_month_cents"] == before["subscriptions"]["per_month_cents"] + 1199
    assert any(i["key"] == f"manual:{s['id']}" for i in after["items"])
    ov = client.get("/api/overview").json()
    assert ov.get("left_cents") == ov_before.get("left_cents")
    # stop, then delete
    s2 = client.patch(f"/api/subscriptions/{s['id']}", json={"end_date": "2026-11-01"}).json()
    assert s2["status"] == "ended" and s2["next_date"] is None
    assert client.delete(f"/api/subscriptions/{s['id']}").json() == {"ok": True}
    assert client.delete(f"/api/subscriptions/{s['id']}").status_code == 404
    bad = client.post("/api/subscriptions", json={"name": "X", "amount_cents": 0, "frequency": "monthly", "start_date": "2026-01-01"})
    assert bad.status_code == 422


def test_manual_subscription_in_calendar_and_besparen(client, book, today):
    today("2026-11-19")
    chk = book.account("Betaal", "checking", "NL01TEST0000000001")
    book.monthly(chk, "2026-01-20", 10, 300000, "salaris", "Werkgever")
    book.monthly(chk, "2026-01-01", 10, -100000, "wonen", "Verhuurder", method="debit")
    book.commit()
    cal0 = client.get("/api/calendar", params={"period": "2026-11"}).json()
    s = client.post("/api/subscriptions", json={"name": "Krant", "amount_cents": 400, "frequency": "weekly",
                                                "start_date": "2026-10-05"}).json()
    cal = client.get("/api/calendar", params={"period": "2026-11"}).json()
    days = [d["date"] for d in cal["days"] for i in d["items"] if i.get("manual")]
    assert days == ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]
    assert cal["out"] == cal0["out"]                      # not in the totals
    b = client.get("/api/besparen").json()
    assert any(i.get("manual") and i["name"] == "Krant" for i in b["subscriptions"]["items"])
    client.delete(f"/api/subscriptions/{s['id']}")
