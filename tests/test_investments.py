"""DEGIRO imports, holdings, value/result, prices (mocked; no network), net worth."""

from __future__ import annotations

from book import book, today  # noqa: F401,E402  (fixtures)

from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from conftest import upload
from cents import db
from cents.importers import degiro
from cents.services import investments, prices

FIX = Path(__file__).parent / "fixtures"
VWRL, IWDA, VTI = "IE00B3RBWM25", "IE00B4L5Y983", "US9229087690"


def fixture(name: str) -> bytes:
    return (FIX / name).read_bytes()


def conn_of(client):
    return db.connect(client.app.state.db_path)


def test_parse_numbers():
    assert degiro.number("1.234,56") == 1234.56
    assert degiro.number("1,234.56") == 1234.56
    assert degiro.number("-75,12") == -75.12
    assert degiro.number("75.12") == 75.12
    assert degiro.number("") is None


def test_detect_formats():
    from cents.importers.detect import detect
    assert detect(fixture("degiro_transacties_nl.csv")) == "degiro_transactions"
    assert detect(fixture("degiro_transactions_en.csv")) == "degiro_transactions"
    assert detect(fixture("degiro_account_nl.csv")) == "degiro_account"
    assert detect(fixture("degiro_portfolio_nl.csv")) == "degiro_portfolio"


def test_parse_transactions_nl_and_en():
    kind, header, rows = degiro.read(fixture("degiro_transacties_nl.csv"))
    tx = degiro.parse_transactions(header, rows)
    assert len(tx) == 4
    vti = next(t for t in tx if t["isin"] == VTI)
    assert vti["currency"] == "USD" and vti["fx_rate"] == 1.08 and vti["price"] == 250
    assert vti["value_eur_cents"] == -46296 and vti["fees_cents"] == 100
    assert vti["date"] == "2026-03-05" and vti["order_id"].endswith("0003")
    _, header, rows = degiro.read(fixture("degiro_transactions_en.csv"))
    en = degiro.parse_transactions(header, rows)
    sell = en[0]
    assert sell["quantity"] == -3 and sell["value_eur_cents"] == 36000 and sell["fees_cents"] == 200


def test_semicolon_and_cp1252():
    text = ("Datum;Tijd;Product;ISIN;Beurs;Uitvoeringsplaats;Aantal;Koers;;Lokale waarde;;Waarde;;"
            "Wisselkoers;Transactiekosten en/of;;Totaal;;Order ID\n"
            "06-01-2026;10:12;FONDS É;IE00B3RBWM25;EAM;XAMS;1;1.110,00;EUR;-1.110,00;EUR;-1.110,00;EUR;;0,00;EUR;-1.110,00;EUR;x1\n")
    _, header, rows = degiro.read(text.encode("cp1252"))
    t = degiro.parse_transactions(header, rows)[0]
    assert t["value_eur_cents"] == -111000 and t["name"] == "FONDS É"


def test_import_creates_degiro_account_and_dedupes_partial_fills(client):
    res = upload(client, ("Transacties.csv", fixture("degiro_transacties_nl.csv")))
    f = res["files"][0]
    assert f["ok"] and f["format"] == "degiro_transactions"
    assert f["new"] == 4 and f["duplicates"] == 0          # two partial fills of one order stay two
    assert f["new_accounts"][0]["name"] == "DEGIRO" and f["account_name"] == "DEGIRO"
    again = upload(client, ("Transacties.csv", fixture("degiro_transacties_nl.csv")))["files"][0]
    assert again["new"] == 0 and again["duplicates"] == 4
    # the EN file overlaps with one fill (same order, isin, date, quantity) and adds a sell
    en = upload(client, ("Transactions.csv", fixture("degiro_transactions_en.csv")))["files"][0]
    assert en["new"] == 1 and en["duplicates"] == 1
    c = conn_of(client)
    assert db.value(c, "SELECT COUNT(*) FROM trades") == 5
    assert db.value(c, "SELECT COUNT(*) FROM accounts WHERE type = 'investment'") == 1
    assert db.value(c, "SELECT COUNT(*) FROM transactions") == 0     # never spending
    c.close()


def test_choose_account_when_several(client):
    a = client.post("/api/accounts", json={"name": "Broker A", "type": "investment"}).json()
    client.post("/api/accounts", json={"name": "Broker B", "type": "investment"})
    f = upload(client, ("Transacties.csv", fixture("degiro_transacties_nl.csv")))["files"][0]
    assert not f["ok"] and f["error_code"] == "choose_account" and len(f["choices"]) == 2
    c = conn_of(client)
    assert db.value(c, "SELECT COUNT(*) FROM trades") == 0 and db.value(c, "SELECT COUNT(*) FROM imports") == 0
    c.close()
    r = client.post(f"/api/import?investment_account_id={a['id']}",
                    files=[("files", ("T.csv", fixture("degiro_transacties_nl.csv"), "text/csv"))]).json()
    assert r["files"][0]["ok"] and r["files"][0]["account_id"] == a["id"]


def test_account_statement_keeps_dividend_tax_and_fees_only(client):
    upload(client, ("Transacties.csv", fixture("degiro_transacties_nl.csv")))
    f = upload(client, ("Account.csv", fixture("degiro_account_nl.csv")))["files"][0]
    assert f["ok"] and f["new"] == 3
    again = upload(client, ("Account.csv", fixture("degiro_account_nl.csv")))["files"][0]
    assert again["new"] == 0 and again["duplicates"] == 3
    c = conn_of(client)
    kinds = sorted((r["kind"], r["amount_cents"]) for r in db.rows(c, "SELECT * FROM cash_events"))
    assert kinds == [("dividend", 840), ("dividend_tax", -126), ("fee", -250)]
    c.close()


def test_delete_import_removes_trades(client):
    f = upload(client, ("Transacties.csv", fixture("degiro_transacties_nl.csv")))["files"][0]
    assert client.delete(f"/api/imports/{f['import_id']}").status_code == 200
    c = conn_of(client)
    assert db.value(c, "SELECT COUNT(*) FROM trades") == 0
    c.close()


def test_value_and_result_with_portfolio_prices(client):
    upload(client, ("Transacties.csv", fixture("degiro_transacties_nl.csv")))
    upload(client, ("Account.csv", fixture("degiro_account_nl.csv")))
    pf = upload(client, ("Portfolio.csv", fixture("degiro_portfolio_nl.csv")))["files"][0]
    assert pf["ok"] and pf["format"] == "degiro_portfolio"
    mismatch = pf["investment"]["mismatch"]
    assert [(m["isin"], m["quantity"], m["file_quantity"]) for m in mismatch] == [(VTI, 2, 3)]
    acc = pf["account_id"]
    h = client.get(f"/api/accounts/{acc}/holdings").json()
    by = {x["isin"]: x for x in h["holdings"]}
    assert by[VWRL]["value_cents"] == 125000 and by[VWRL]["price_source"] == "degiro_portfolio"
    assert by[VWRL]["avg_price_cents"] == 11020                  # (1100 + 2 fee) / 10
    assert by[IWDA]["value_cents"] == 52000
    assert by[VTI]["price_cents"] == 25000 and by[VTI]["value_cents"] == 50000   # 750 EUR / 3 units
    market = 125000 + 52000 + 50000
    assert h["market_value_cents"] == market
    cost_ex = 110000 + 50000 + 46296
    assert h["price_result_cents"] == market - cost_ex
    assert h["dividends_cents"] == 840 - 126 and h["costs_cents"] == 400 + 250
    assert h["result_cents"] == market - cost_ex + 714 - 650
    assert h["invested_source"] == "trades" and h["cash_cents"] == 0
    assert h["chart"] and h["chart"][-1]["value_cents"] == market


def test_sell_realises_result(client):
    upload(client, ("Transacties.csv", fixture("degiro_transacties_nl.csv")))
    f = upload(client, ("Transactions.csv", fixture("degiro_transactions_en.csv")))["files"][0]
    h = client.get(f"/api/accounts/{f['account_id']}/holdings").json()
    v = next(x for x in h["holdings"] if x["isin"] == VWRL)
    assert v["quantity"] == 7
    # cost 1102 for 10, 3 sold for 360 - 2 fee: realised = 358 - 330.60
    assert v["realised_cents"] == 35800 - 33060
    # price falls back to the last trade price (120) when nothing else is known
    assert v["price_source"] == "trade" and v["value_cents"] == 84000


def test_manual_trade_and_sell_limit(client):
    acc = client.post("/api/accounts", json={"name": "DEGIRO", "type": "investment"}).json()
    r = client.post(f"/api/accounts/{acc['id']}/trades", json={
        "date": "2026-01-10", "isin": VWRL, "name": "Vanguard FTSE All-World", "quantity": 2,
        "price_cents": 10000, "fees_cents": 100})
    assert r.status_code == 200
    bad = client.post(f"/api/accounts/{acc['id']}/trades", json={
        "date": "2026-01-11", "isin": VWRL, "side": "sell", "quantity": 5, "price_cents": 10000})
    assert bad.status_code == 422
    h = client.get(f"/api/accounts/{acc['id']}/holdings").json()
    assert h["holdings"][0]["quantity"] == 2 and h["holdings"][0]["avg_price_cents"] == 10050
    assert client.get("/api/securities?q=vang").json()[0]["isin"] == VWRL
    assert client.delete(f"/api/trades/{r.json()['id']}").status_code == 200


class FakeProvider:
    name = "yahoo"
    label = "Test"

    def __init__(self):
        self.calls = []

    def lookup(self, isin, exchange, currency, symbol, name=None):
        self.calls.append(("lookup", isin))
        return {VWRL: "VWRL.AS", IWDA: "IWDA.AS", VTI: "VTI"}[isin]

    def history(self, symbol, start):
        self.calls.append(("history", symbol))
        if symbol == "VTI":
            return "USD", [("2026-03-05", 250.0), ("2026-11-13", 300.0)]
        return "EUR", [("2026-01-06", 110.0), ("2026-11-13", 130.0 if symbol == "VWRL.AS" else 105.0)]


def prices_on(client):
    r = client.patch("/api/settings", json={"assumptions": {"prices_auto": {"enabled": True}}})
    assert r.status_code == 200, r.text


def test_prices_off_by_default(client):
    assert client.get("/api/settings").json()["assumptions"]["prices_auto"]["enabled"] is False


def test_offline_env_blocks_every_request(monkeypatch):
    from cents.services import prices
    monkeypatch.setenv("CENTS_OFFLINE", "1")
    called = []
    monkeypatch.setattr(prices.urllib.request, "urlopen", lambda *a, **k: called.append(a))
    import pytest
    with pytest.raises(prices.OfflineError):
        prices.http_get("https://example.invalid/")
    assert called == []


def test_refresh_with_fx(client):
    prices_on(client)
    upload(client, ("Transacties.csv", fixture("degiro_transacties_nl.csv")))
    fake = FakeProvider()
    prices.set_provider(fake)
    prices.FX_SOURCE = lambda start: {"USD": [("2026-03-05", 1.08), ("2026-11-13", 1.2)]}
    res = prices.refresh(client.app.state.db_path)
    assert res["ok"] and res["updated"] == 6
    sent = {c[1] for c in fake.calls}
    assert sent <= {VWRL, IWDA, VTI, "VWRL.AS", "IWDA.AS", "VTI"}      # only ISINs/symbols
    c = conn_of(client)
    vti = db.row(c, "SELECT * FROM prices WHERE isin = ? AND date = '2026-11-13'", (VTI,))
    assert vti["currency"] == "USD" and abs(vti["close_eur"] - 250.0) < 1e-9
    acc = db.value(c, "SELECT id FROM accounts WHERE type = 'investment'")
    c.close()
    h = client.get(f"/api/accounts/{acc}/holdings").json()
    by = {x["isin"]: x for x in h["holdings"]}
    assert by[VTI]["value_cents"] == 50000 and by[VWRL]["value_cents"] == 130000
    assert by[VWRL]["price_source"] == "yahoo"
    st = client.get("/api/prices/status").json()
    assert st["last_ok"] and st["error"] is None and st["source"] == "Test"


def test_network_failure_is_harmless(client):
    prices_on(client)
    upload(client, ("Transacties.csv", fixture("degiro_transacties_nl.csv")))
    res = prices.refresh(client.app.state.db_path)          # offline provider from conftest
    assert not res["ok"] and res["updated"] == 0
    st = client.get("/api/prices/status").json()
    assert st["error"] and st["last_ok"] is None
    r = client.post("/api/prices/refresh")
    assert r.status_code == 200 and r.json()["result"]["ok"] is False
    assert client.get("/api/networth").status_code == 200
    assert client.get("/api/healthz").json() == {"ok": True}


def test_setting_off_means_no_fetch(client):
    upload(client, ("Transacties.csv", fixture("degiro_transacties_nl.csv")))
    fake = FakeProvider()
    prices.set_provider(fake)
    r = client.patch("/api/settings", json={"assumptions": {"prices_auto": {"enabled": False}}})
    assert r.json()["assumptions"]["prices_auto"]["enabled"] is False
    assert prices.refresh(client.app.state.db_path)["error"] == "disabled"
    assert client.post("/api/prices/refresh").status_code == 409
    c = conn_of(client)
    assert not prices.due(c)
    c.close()
    assert fake.calls == []


def test_due_after_1830_amsterdam(client):
    prices_on(client)
    upload(client, ("Transacties.csv", fixture("degiro_transacties_nl.csv")))
    c = conn_of(client)
    morning = datetime(2026, 11, 16, 8, 0, tzinfo=timezone.utc)
    assert prices.due(c, morning)                       # never fetched: run at startup
    db.set_setting(c, prices.STATUS_KEY, {"last_ok": "2026-11-15T18:00:00+00:00",
                                         "last_run": "2026-11-15T18:00:00+00:00"})
    assert not prices.due(c, morning)                   # yesterday after 18:30 Amsterdam
    assert prices.due(c, datetime(2026, 11, 16, 18, 0, tzinfo=timezone.utc))   # 19:00 local
    c.close()


def test_networth_uses_real_value(client):
    from book import Book
    upload(client, ("Transacties.csv", fixture("degiro_transacties_nl.csv")))
    upload(client, ("Portfolio.csv", fixture("degiro_portfolio_nl.csv")))
    b = Book(Path(client.app.state.db_path))
    inv = db.value(b.conn, "SELECT id FROM accounts WHERE type = 'investment'")
    chk = b.account("Betaal", "checking", "NL01TEST0000000001")
    b.tx(chk, "2026-01-05", 250000, "salaris", "Werk", balance=200000)
    b.tx(chk, "2026-01-05", -220000, "beleggen", "DEGIRO", kind="transfer", to=inv, balance=30000)
    b.commit()
    nw = client.get("/api/networth").json()
    a = next(x for x in nw["accounts"] if x["type"] == "investment")
    market = 125000 + 52000 + 50000
    net_bought = 110200 + 50100 + 46396
    assert a["has_holdings"] and a["invested_cents"] == 220000
    assert a["market_value_cents"] == market and a["cash_cents"] == 220000 - net_bought
    assert a["balance_cents"] == market + 220000 - net_bought
    assert nw["total_cents"] == 30000 + a["balance_cents"]
    assert nw["series"][-1]["investment_cents"] == a["balance_cents"]
    # vrij geld ignores investments
    ov = client.get("/api/overview").json()
    if ov.get("free"):
        assert ov["free"]["balances_cents"] <= 30000


def test_bond_quoted_in_percent_is_rescaled(client, book):
    """A bond bought at 98.50 % for 1.000 nominal costs 985; a quote of 99.00 (percent) must
    value it at 990, not 99.000."""
    from cents.services import investments
    acc = book.account("DEGIRO", "investment")
    book.conn.execute("INSERT INTO securities (isin, name, currency) VALUES "
                      "('NL0000000001', 'NL2.5%DSL15JUL2035F', 'EUR')")
    book.conn.execute("""INSERT INTO trades (account_id, date, isin, quantity, price, currency,
                         value_eur_cents, fees_cents, manual, created_at)
                         VALUES (?, '2026-01-10', 'NL0000000001', 1000, 98.5, 'EUR', -98500, 0, 1, 'x')""", (acc,))
    book.conn.execute("""INSERT INTO prices (isin, date, source, close, currency, close_eur)
                         VALUES ('NL0000000001', '2026-03-10', 'yahoo', 99.0, 'EUR', 99.0)""")
    book.commit()
    h = investments.holdings(book.conn, acc, "2026-03-15")
    assert h["holdings"][0]["value_cents"] == 99000
    assert h["result_cents"] == 500
