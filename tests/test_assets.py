"""Pension, debt and other possessions (SPEC 7.3): CRUD, net worth switches, debt split and
estimate next to the mortgage, the April pension insight, outlook unaffected. Synthetic data."""

from __future__ import annotations

from book import book, today  # noqa: F401  (fixtures)

LENDER = "Venn Hypotheken"
DUO_PAY = 20000


def _household(book, months_2026: int = 11):
    chk = book.account("Betaal", "checking", "NL01TEST0000000001")
    book.account("Spaar", "savings", "NL02TEST0000000002", manual_balance=1000000,
                 manual_date="2025-01-01")
    n = 12 + months_2026
    book.monthly(chk, "2025-01-20", n, 400000, "salaris", "Werkgever")
    book.monthly(chk, "2025-01-01", n, -120000, "wonen", LENDER, method="debit")
    book.monthly(chk, "2025-01-03", n, -DUO_PAY, "leningen", "DUO", method="debit")
    book.monthly(chk, "2025-01-05", n, -20000, "boodschappen", "Supermarkt", method="card")
    book.commit()
    return chk


def _item(out, asset_id):
    return next(i for i in out["items"] if i["id"] == asset_id)


def _create(client, **body):
    r = client.post("/api/assets", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"], r.json()


def test_crud_each_type(client, book, today):
    today("2026-11-15")
    _household(book)
    assert client.get("/api/assets").json()["items"] == []
    pid, out = _create(client, kind="pension", name="Pensioenfonds werkgever")
    assert _item(out, pid)["include"] is False and _item(out, pid)["value_cents"] is None
    oid, _ = _create(client, kind="other", name="Contant")
    did, out = _create(client, kind="debt", name="Persoonlijke lening", debt_kind="lening")
    d = _item(out, did)
    assert d["include"] is True and d["debt_kind"] == "lening" and d["payment"] is None
    out = client.post(f"/api/assets/{pid}/entries", json={"date": "2026-04-01", "value_cents": 2500000,
                                                         "note": "UPO 2026", "repaid_cents": 5}).json()
    e = _item(out, pid)["entries"][0]
    assert e["note"] == "UPO 2026" and e["repaid_cents"] is None and _item(out, pid)["value_cents"] == 2500000
    out = client.patch(f"/api/assets/{oid}", json={"name": "Kinderrekening", "include": False}).json()
    assert _item(out, oid)["name"] == "Kinderrekening" and _item(out, oid)["include"] is False
    assert client.post(f"/api/assets/{oid}/entries", json={"date": "2027-01-01", "value_cents": 1}).status_code == 422
    out = client.delete(f"/api/assets/{pid}/entries/{e['id']}").json()
    assert _item(out, pid)["entries"] == []
    assert client.delete(f"/api/assets/{pid}").status_code == 200
    assert client.delete(f"/api/assets/{pid}").status_code == 404
    assert client.post("/api/assets", json={"kind": "car", "name": "x"}).status_code == 422
    assert {i["id"] for i in client.get("/api/assets").json()["items"]} == {oid, did}


def test_networth_switches_and_pension_excluded(client, book, today):
    today("2026-11-15")
    _household(book)
    base = client.get("/api/networth").json()
    assert base["assets"] == [] and base["pension_excluded_cents"] is None
    pid, _ = _create(client, kind="pension", name="Pensioen")
    oid, _ = _create(client, kind="other", name="Crypto")
    did, _ = _create(client, kind="debt", name="Autolening", debt_kind="lening")
    client.post(f"/api/assets/{pid}/entries", json={"date": "2026-04-01", "value_cents": 5000000})
    client.post(f"/api/assets/{oid}/entries", json={"date": "2026-06-10", "value_cents": 300000})
    client.post(f"/api/assets/{did}/entries", json={"date": "2026-03-01", "value_cents": 800000})
    nw = client.get("/api/networth").json()
    assert nw["pension_excluded_cents"] == 5000000
    assert nw["total_cents"] == base["total_cents"] + 300000 - 800000
    may, june = (next(p for p in nw["series"] if p["month"] == m) for m in ("2026-05", "2026-06"))
    assert may["assets_cents"] == -800000 and june["assets_cents"] == 300000 - 800000
    assert all(p["total_cents"] == sum(p[k] for k in ("checking_cents", "savings_cents", "investment_cents",
                                                     "credit_cents", "assets_cents")) for p in nw["series"])
    client.patch(f"/api/assets/{pid}", json={"include": True})
    client.patch(f"/api/assets/{oid}", json={"include": False})
    client.patch(f"/api/assets/{did}", json={"include": False})
    nw = client.get("/api/networth").json()
    assert nw["pension_excluded_cents"] is None
    assert nw["total_cents"] == base["total_cents"] + 5000000
    client.patch(f"/api/assets/{pid}", json={"include": False})
    off = client.get("/api/networth").json()
    assert off["total_cents"] == base["total_cents"] and all("assets_cents" not in p for p in off["series"])


def _mortgage(client):
    m = client.post("/api/mortgage", json={"parts": [{"name": "Deel 1"}]}).json()
    client.put("/api/mortgage/years/2025", json={"parts": [{"part_id": m["parts"][0]["id"],
               "debt_end_cents": 20000000, "interest_cents": 960000, "repaid_cents": 480000}]})


def test_debt_split_estimate_with_mortgage(client, book, today):
    today("2026-11-15")
    _household(book)
    before = client.get("/api/overview?period=2026-10").json()
    _mortgage(client)                                   # 1/3 of 120000 = 40000 repaid
    did, out = _create(client, kind="debt", name="Studieschuld", debt_kind="studieschuld")
    assert _item(out, did)["payment"]["merchant_key"] == "duo"           # auto-suggested
    out = client.post(f"/api/assets/{did}/entries", json={
        "date": "2025-12-31", "value_cents": 1500000, "interest_cents": 5000, "repaid_cents": 15000}).json()
    d = _item(out, did)
    assert d["repaid_share"] == 0.75
    # 11 payments in 2026 of 20000, 75 % repaid each
    assert d["value_cents"] == 1500000 - 11 * 15000 and d["estimated"] is True
    o = client.get("/api/overview?period=2026-10").json()
    assert o["repaid_cents"] == 40000 + 15000
    assert o["fixed_cents"] == before["fixed_cents"] - 55000
    assert o["net_cents"] == before["net_cents"]
    m = client.get("/api/mortgage").json()
    assert m["debt_cents"] == 20000000 - 11 * 40000                     # mortgage unaffected
    assert m["repaid_this_year_cents"] == 11 * 40000
    # before the first entry: first entry plus what was repaid until then
    nw = client.get("/api/networth").json()
    june25 = next(p for p in nw["series"] if p["month"] == "2025-06")
    assert june25["assets_cents"] == -(1500000 + 6 * 15000)       # Jul–Dec
    # a merchant can only belong to one loan
    assert client.patch(f"/api/assets/{did}", json={"merchant_key": LENDER.lower()}).status_code == 409
    _, out = _create(client, kind="debt", name="Tweede", debt_kind="studieschuld")
    assert all(i["payment"] is None for i in out["items"] if i["name"] == "Tweede")
    # unlinking removes the split
    client.patch(f"/api/assets/{did}", json={"merchant_key": None})
    assert client.get("/api/overview?period=2026-10").json()["repaid_cents"] == 40000
    assert _item(client.get("/api/assets").json(), did)["value_cents"] == 1500000


def test_outlook_free_unaffected(client, book, today):
    today("2026-11-15")
    _household(book)
    before = client.get("/api/overview").json()
    for kind in ("pension", "other", "debt"):
        aid, _ = _create(client, kind=kind, name=kind, include=True)
        client.post(f"/api/assets/{aid}/entries", json={"date": "2026-01-01", "value_cents": 999900})
    after = client.get("/api/overview").json()
    assert after["free"] == before["free"]


def test_pension_insight_april(client, book, today):
    today("2026-04-12")
    _household(book, months_2026=4)
    kinds = lambda: [i for i in client.get("/api/overview").json()["insights"] if i["kind"] == "pension"]  # noqa: E731
    assert kinds() == []                                                 # no pension item
    pid, _ = _create(client, kind="pension", name="Pensioen")
    client.post(f"/api/assets/{pid}/entries", json={"date": "2025-06-01", "value_cents": 100})
    assert kinds() == []                                                 # 10 months old
    client.delete(f"/api/assets/{pid}/entries/" + str(_item(client.get("/api/assets").json(), pid)["entries"][0]["id"]))
    client.post(f"/api/assets/{pid}/entries", json={"date": "2025-04-01", "value_cents": 100})
    found = kinds()
    assert found and found[0]["id"] == "pension:2026" and found[0]["href"] == "/vermogen"
    today("2026-05-12")
    assert kinds() == []
    today("2026-04-12")
    client.post("/api/insights/dismiss", json={"id": "pension:2026"})
    assert kinds() == []
