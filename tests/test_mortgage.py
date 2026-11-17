"""Mortgage (SPEC 7.2): split of the linked payment, debt estimate, overwaarde in net worth,
year sums, the April insight. Everything here is synthetic."""

from __future__ import annotations

from book import book, today  # noqa: F401  (fixtures)

PAY = 120000                      # monthly payment to the lender
LENDER = "Venn Hypotheken"


def _household(book, months_2026: int = 11):
    chk = book.account("Betaal", "checking", "NL01TEST0000000001")
    book.account("Spaar", "savings", "NL02TEST0000000002", manual_balance=1000000,
                 manual_date="2026-01-01")
    n = 12 + months_2026
    book.monthly(chk, "2025-01-20", n, 400000, "salaris", "Werkgever")
    book.monthly(chk, "2025-01-01", n, -PAY, "wonen", LENDER, method="debit")
    book.monthly(chk, "2025-01-05", n, -20000, "boodschappen", "Supermarkt", method="card")
    book.commit()
    return chk


def _setup(client, year=2025, repaid=(480000, 0), interest=(600000, 360000),
           debt=(20000000, 10000000)):
    m = client.post("/api/mortgage", json={"parts": [{"name": "Deel 1 – annuïtair"},
                                                     {"name": "Deel 2 – aflossingsvrij"}]}).json()
    ids = [p["id"] for p in m["parts"]]
    r = client.put(f"/api/mortgage/years/{year}", json={"parts": [
        {"part_id": ids[i], "debt_end_cents": debt[i], "interest_cents": interest[i],
         "repaid_cents": repaid[i]} for i in range(2)]})
    assert r.status_code == 200, r.text
    return ids, r.json()


def test_split_ratio_and_ledger(client, book, today):
    today("2026-11-15")
    _household(book)
    before = client.get("/api/overview?period=2026-10").json()
    ids, m = _setup(client)
    # 480000 / (480000 + 600000 + 360000) = 1/3, all parts summed
    assert m["repaid_share"] == round(1 / 3, 4) and m["latest_year"] == 2025
    assert m["payment"]["merchant_key"] == LENDER.lower() and m["payment"]["auto"] is True
    o = client.get("/api/overview?period=2026-10").json()
    assert o["repaid_cents"] == 40000
    assert o["fixed_cents"] == before["fixed_cents"] - 40000
    assert o["saved_cents"] == before["saved_cents"] + 40000
    assert o["result_cents"] == before["result_cents"] + 40000
    assert o["net_cents"] == before["net_cents"]               # cash out is the same
    wonen = next(c for c in client.get("/api/categories").json() if c["key"] == "wonen")["id"]
    cat = next(c for c in o["categories"] if c["category_id"] == wonen)
    assert cat["spent_cents"] == PAY - 40000                   # interest stays in Wonen


def test_free_unchanged_by_split(client, book, today):
    today("2026-11-15")
    _household(book)
    before = client.get("/api/overview").json()
    _setup(client)
    after = client.get("/api/overview").json()
    assert after["repaid_cents"] == 40000
    assert after["free"] == before["free"]
    assert after["left_cents"] == before["left_cents"]
    assert after["balance"] == before["balance"]


def test_debt_estimate_only_previous_year(client, book, today):
    """November 2026: only the 2025 statement exists; 2026 payments lower the debt."""
    today("2026-11-15")
    _household(book)
    ids, m = _setup(client)
    assert m["form_year"] == 2025 and m["missing_year"] is None
    deel1, deel2 = m["parts"]
    assert deel1["debt_cents"] == 20000000 - 11 * 40000       # 11 payments in 2026
    assert deel2["debt_cents"] == 10000000                    # aflossingsvrij: unchanged
    assert m["debt_cents"] == deel1["debt_cents"] + deel2["debt_cents"]
    assert m["repaid_this_year_cents"] == 11 * 40000
    r = client.put("/api/mortgage/years/2026", json={"parts": [
        {"part_id": ids[0], "debt_end_cents": 1}]})
    assert r.status_code == 422 and "year_not_finished" in r.text


def test_new_year_resets_and_april_insight(client, book, today):
    today("2026-11-15")
    _household(book)
    ids, _ = _setup(client)
    today("2027-04-10")
    ins = client.get("/api/overview").json()["insights"]
    assert any(i["id"] == "mortgage:2026" and i["kind"] == "mortgage" for i in ins)
    m = client.get("/api/mortgage").json()
    assert m["missing_year"] == 2026 and m["form_year"] == 2026
    m = client.put("/api/mortgage/years/2026", json={"parts": [
        {"part_id": ids[0], "debt_end_cents": 19500000, "interest_cents": 580000,
         "repaid_cents": 500000},
        {"part_id": ids[1], "debt_end_cents": 10000000, "interest_cents": 360000,
         "repaid_cents": 0}]}).json()
    assert m["debt_cents"] == 29500000                        # no payments since 31-12-2026
    assert m["latest_year"] == 2026 and m["missing_year"] is None
    ins = client.get("/api/overview").json()["insights"]
    assert not any(i["kind"] == "mortgage" for i in ins)
    # the older year stays, the ratio follows the newest year
    assert m["years"] == [2026, 2025]
    assert m["repaid_share"] == round(500000 / 1440000, 4)


def test_setup_suggestion_in_april(client, book, today):
    today("2026-04-12")
    _household(book, months_2026=4)
    ins = client.get("/api/overview").json()["insights"]
    s = [i for i in ins if i["kind"] == "mortgage"]
    assert s and s[0]["id"] == "mortgage:setup" and s[0]["href"] == "/vermogen"
    today("2026-05-12")
    assert not any(i["kind"] == "mortgage" for i in client.get("/api/overview").json()["insights"])
    today("2026-04-12")
    client.post("/api/insights/dismiss", json={"id": "mortgage:setup"})
    assert not any(i["kind"] == "mortgage" for i in client.get("/api/overview").json()["insights"])


def test_networth_overwaarde_and_switch(client, book, today):
    today("2026-11-15")
    _household(book)
    base = client.get("/api/networth").json()
    assert base["home"] is None
    _setup(client)
    client.post("/api/mortgage/home-values", json={"date": "2026-01-15", "value_cents": 45000000})
    nw = client.get("/api/networth").json()
    debt = 30000000 - 11 * 40000
    assert nw["home"] == {"home_cents": 45000000, "debt_cents": debt,
                          "equity_cents": 45000000 - debt, "included": True}
    assert nw["total_cents"] == base["total_cents"] + 45000000 - debt
    june = next(p for p in nw["series"] if p["month"] == "2026-06")
    assert june["home_cents"] == 45000000 - (30000000 - 6 * 40000)
    assert june["total_cents"] == sum(june[k] for k in ("checking_cents", "savings_cents",
                                                        "investment_cents", "credit_cents",
                                                        "home_cents"))
    # the debt goes down month by month
    homes = [p["home_cents"] for p in nw["series"] if p["month"] >= "2026-01"]
    assert homes == sorted(homes)
    client.patch("/api/mortgage", json={"include_in_networth": False})
    off = client.get("/api/networth").json()
    assert off["home"]["included"] is False and off["total_cents"] == base["total_cents"]
    assert all("home_cents" not in p for p in off["series"])


def test_year_sums_and_unlinked(client, book, today):
    today("2026-11-15")
    _household(book)
    _setup(client)
    y = client.get("/api/overview?period=2026").json()
    assert y["repaid_cents"] == sum(m["repaid_cents"] for m in y["months"]) == 11 * 40000
    assert y["saved_cents"] == sum(m["saved_cents"] for m in y["months"])
    assert y["fixed_cents"] == sum(m["fixed_cents"] for m in y["months"])
    # unlinking the payment removes the split
    m = client.patch("/api/mortgage", json={"merchant_key": ""}).json()
    assert m["payment"] is None
    assert client.get("/api/overview?period=2026").json()["repaid_cents"] == 0
    m = client.patch("/api/mortgage", json={"merchant_key": None}).json()
    assert m["payment"]["auto"] is True
    assert client.patch("/api/mortgage", json={"merchant_key": "bestaat-niet"}).status_code == 422


def test_only_interest_parts(client, book, today):
    """All parts aflossingsvrij: nothing is repaid, the full payment stays a fixed cost."""
    today("2026-11-15")
    _household(book)
    _setup(client, repaid=(0, 0))
    o = client.get("/api/overview?period=2026-10").json()
    assert o["repaid_cents"] == 0
    m = client.get("/api/mortgage").json()
    assert m["debt_cents"] == 30000000 and m["repaid_share"] == 0


def test_new_loan_keeps_principal(client, book, today):
    """A part that started during the year: restant op 1 januari 0, hoofdsom kept as given."""
    today("2026-11-17")
    m = client.post("/api/mortgage", json={"parts": [{"name": "Deel 1"}]}).json()
    pid = m["parts"][0]["id"]
    r = client.put("/api/mortgage/years/2025", json={"parts": [
        {"part_id": pid, "debt_end_cents": 23814600, "interest_cents": 300000,
         "repaid_cents": 185400, "principal_cents": 24000000}]})
    assert r.status_code == 200, r.text
    year = client.get("/api/mortgage").json()["parts"][0]["years"][0]
    assert year["principal_cents"] == 24000000 and year["repaid_cents"] == 185400
    client.put("/api/mortgage/years/2025", json={"parts": [
        {"part_id": pid, "debt_end_cents": 23814600, "interest_cents": 300000, "repaid_cents": 185400}]})
    assert client.get("/api/mortgage").json()["parts"][0]["years"][0]["principal_cents"] is None
