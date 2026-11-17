"""Adversarial backend review: regressions for bugs found in v4-v6 code."""

from __future__ import annotations

import sqlite3

from book import book, today  # noqa: F401  (fixtures)

from cents import db


def test_networth_last_point_matches_account_list(client, book):
    """A purchase dated after today (card statement booked ahead) shows in the list, so the
    current month's chart point must show it too."""
    card = book.account("Creditcard", "credit")
    chk = book.account("Betaal", "checking")
    book.tx(chk, "2026-03-01", 100000, "salaris", "Werk", balance=100000)
    book.tx(card, "2026-03-20", -28900, "uit-eten", "Bistro", manual=1, method="card")
    book.commit()
    nw = client.get("/api/networth").json()
    acc = {a["name"]: a for a in nw["accounts"]}
    last = nw["series"][-1]
    assert acc["Creditcard"]["balance_cents"] == -28900
    assert last["credit_cents"] == -28900
    assert last["total_cents"] == nw["total_cents"]


def _v3_database(path):
    c = sqlite3.connect(path)
    for script in db.MIGRATIONS[:3]:
        c.executescript(script)
    c.execute("PRAGMA user_version = 3")
    c.execute("INSERT INTO accounts (iban, name, type, created_at) "
              "VALUES ('NL11TEST0000000001', 'Betaal', 'checking', 'x')")
    c.execute("INSERT INTO accounts (name, type, created_at) VALUES ('Broker', 'investment', 'x')")
    c.execute("INSERT INTO transactions (account_id, dedupe_key, date, amount_cents, balance_after_cents, "
              "description, created_at, updated_at) VALUES (1, 'k1', '2026-03-01', 12345, 12345, 'salaris', 'x', 'x')")
    c.execute("INSERT INTO account_values (account_id, date, value_cents) VALUES (2, '2026-02-28', 5000)")
    c.commit()
    c.close()


def test_startup_upgrades_a_v3_database_with_data(tmp_path, today):
    from fastapi.testclient import TestClient
    from cents.main import create_app
    _v3_database(tmp_path / "cents.db")
    app = create_app(data_dir=tmp_path, frontend_dir=tmp_path / "no-frontend")
    with TestClient(app, headers={"X-Cents": "1"}) as cl:
        assert cl.post("/api/setup", json={"password": "test-wachtwoord"}).status_code == 200
        c = db.connect(tmp_path / "cents.db")
        assert c.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
        c.close()
        nw = cl.get("/api/networth").json()
        acc = {a["name"]: a for a in nw["accounts"]}
        assert acc["Betaal"]["balance_cents"] == 12345
        assert acc["Broker"]["balance_cents"] == 5000
        for path in ("/api/mortgage", "/api/assets", "/api/prices/status", "/api/overview",
                     "/api/overview?period=2026", "/api/recap", "/api/goals"):
            assert cl.get(path).status_code == 200, path
        # the new tables take data after the upgrade
        r = cl.post("/api/assets", json={"kind": "other", "name": "Auto"})
        assert r.status_code == 200, r.text


def test_mortgage_year_with_a_part_twice_is_a_422_not_a_500(client, today):
    m = client.post("/api/mortgage", json={"parts": [{"name": "Deel 1"}]}).json()
    pid = m["parts"][0]["id"]
    r = client.put("/api/mortgage/years/2025", json={"parts": [
        {"part_id": pid, "debt_end_cents": 100}, {"part_id": pid, "debt_end_cents": 200}]})
    assert r.status_code == 422, r.text


def test_mortgage_cannot_take_a_debts_payment(client, book, today):
    """One payment split by both the mortgage and a debt would lower both debts with the same
    repayment (double counted in net worth)."""
    from test_assets import _create, _household, _item, _mortgage
    today("2026-11-15")
    _household(book)
    _mortgage(client)
    did, _ = _create(client, kind="debt", name="Studieschuld", debt_kind="studieschuld")
    client.post(f"/api/assets/{did}/entries", json={
        "date": "2025-12-31", "value_cents": 1500000, "interest_cents": 5000, "repaid_cents": 15000})
    r = client.patch("/api/mortgage", json={"merchant_key": "duo"})
    assert r.status_code == 409, r.text
    # even when the setting got there some other way, the mortgage owns the split and the
    # debt is not lowered with the mortgage's repaid parts
    book.conn.execute("INSERT INTO settings (key, value) VALUES ('mortgage_merchant_key', '\"duo\"') "
                      "ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    book.commit()
    assert _item(client.get("/api/assets").json(), did)["value_cents"] == 1500000
