"""Marked as subscription: followed exactly (name, counter account, amount, cleaned description),
shown before saving, a new price only after asking."""

from __future__ import annotations

from book import book, today  # noqa: F401  (fixtures)


def _setup(book):
    chk = book.account("Betaal", "checking", "NL01TEST0000000001")
    book.monthly(chk, "2026-01-20", 10, 300000, "salaris", "Werkgever")
    # irregular days: the automatic detection would not call this monthly
    for d in ("2026-01-03", "2026-02-19", "2026-03-04", "2026-05-28", "2026-06-02", "2026-08-30"):
        book.tx(chk, d, -1199, "abonnementen", "Speelgoedclub", method="ideal", description=f"Lid {d[5:7]} 2026 ref 77{d[8:]}")
    book.tx(chk, "2026-04-10", -1199, "abonnementen", "Speelgoedclub", method="ideal", description="Cadeaubon")
    book.tx(chk, "2026-07-11", -2500, "abonnementen", "Speelgoedclub", method="ideal", description="Lid extra ref 1")
    book.tx(chk, "2026-10-01", -1299, "abonnementen", "Speelgoedclub", method="ideal", description="Lid 10 2026 ref 7701")
    book.commit()


def test_pin_preview_create_price_unpin(client, book, today):
    today("2026-11-19")
    _setup(book)
    txs = client.get("/api/transactions", params={"merchant_key": "speelgoedclub", "limit": 50}).json()["items"]
    first = next(t for t in txs if t["date"] == "2026-08-30")
    pv = client.post("/api/recurring/pins/preview", json={"transaction_id": first["id"]}).json()
    # exactly the six "Lid" payments of € 11,99: not the gift card (other text), not the extra
    assert pv["count"] == 6 and pv["rule"]["desc_key"] == "lid ref"
    r = client.post("/api/recurring/pins", json={"transaction_id": first["id"]}).json()
    assert client.post("/api/recurring/pins", json={"transaction_id": first["id"]}).status_code == 409
    items = client.get("/api/recurring").json()["items"]
    pin = next(i for i in items if i["key"] == r["key"])
    assert pin["pinned"] and pin["count"] == 6 and pin["frequency"] == "monthly"
    assert pin["price_suggestion"]["to_cents"] == -1299          # asked, not taken over
    assert not any(i["merchant_key"] == "speelgoedclub" and not i.get("pinned") and i["amount_cents"] == -1199 for i in items)
    client.post(f"/api/recurring/pins/{r['id']}/amount", json={"amount_cents": -1299})
    pin = next(i for i in client.get("/api/recurring").json()["items"] if i["key"] == r["key"])
    assert pin["count"] == 7 and pin["amount_cents"] == -1299 and pin["price_suggestion"] is None
    assert client.delete(f"/api/recurring/pins/{r['id']}").json() == {"ok": True}
    assert not any(i["key"] == r["key"] for i in client.get("/api/recurring").json()["items"])
