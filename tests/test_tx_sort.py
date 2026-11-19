"""GET /transactions: sort on every column, filter on direction and amount (2026-11)."""

from __future__ import annotations

from book import book, today  # noqa: F401  (fixtures)


def test_sort_and_filter(client, book):
    a = book.account("Betaal", "checking")
    b = book.account("Gezamenlijk", "checking")
    book.tx(a, "2026-02-01", -5000, "boodschappen", "Jumbo")
    book.tx(a, "2026-02-02", -120000, "wonen", "Verhuurder")
    book.tx(b, "2026-02-03", 300000, "salaris", "Werkgever")
    book.tx(b, "2026-02-04", -2500, "uit-eten", "Café")
    book.commit()
    names = lambda r: [t["merchant_name"] for t in r["items"]]  # noqa: E731
    get = lambda **p: client.get("/api/transactions", params=p).json()  # noqa: E731
    assert names(get()) == ["Café", "Werkgever", "Verhuurder", "Jumbo"]
    assert names(get(sort="date")) == ["Jumbo", "Verhuurder", "Werkgever", "Café"]
    assert names(get(sort="amount")) == ["Verhuurder", "Jumbo", "Café", "Werkgever"]   # biggest out first
    assert names(get(sort="-amount"))[0] == "Werkgever"
    assert names(get(sort="merchant")) == ["Café", "Jumbo", "Verhuurder", "Werkgever"]
    assert names(get(sort="account"))[:2] == ["Verhuurder", "Jumbo"]                  # Betaal, newest first
    assert names(get(sign="out", min_cents=3000)) == ["Verhuurder", "Jumbo"]
    page = get(sort="merchant", limit=3)
    assert page["next_cursor"] == "o:3" and page["count"] == 4
    assert names(get(sort="merchant", limit=3, cursor="o:3")) == ["Werkgever"]
    assert client.get("/api/transactions", params={"sort": "id; drop"}).status_code == 422
