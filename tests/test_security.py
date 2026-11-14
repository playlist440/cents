"""Security review fixes: restore, CSV injection, upload guard, setup race, scrypt, bounds,
error handling, dependencies, CSP, and interest classification."""

import asyncio
import csv
import io
import json
import sqlite3
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cents import auth, db
from cents.guard import Guard
from conftest import PASSWORD, upload
from helpers import asn_csv, sample_account


def backup_bytes(client) -> bytes:
    r = client.get("/api/export/backup")
    assert r.status_code == 200
    return r.content


def restore(client, content: bytes):
    return client.post("/api/restore", files={"file": ("b.db", content, "application/octet-stream")})


def edit_backup(content: bytes, tmp_path: Path, *sql: str, page_size: int | None = None) -> bytes:
    path = tmp_path / "edit.db"
    path.write_bytes(content)
    c = sqlite3.connect(path)
    for statement in sql:
        c.executescript(statement)
    c.commit()
    if page_size:
        c.execute("PRAGMA journal_mode = DELETE")
        c.execute(f"PRAGMA page_size = {page_size}")
        c.execute("VACUUM")
    c.close()
    return path.read_bytes()


def db_path(client) -> str:
    return client.app.state.db_path


# ---------------------------------------------------------------- 1 restore keeps password + sessions

def test_restore_keeps_live_password_and_sessions(client, tmp_path):
    upload(client, ("a.csv", asn_csv(sample_account())))
    content = backup_bytes(client)
    assert client.post("/api/password", json={"current": PASSWORD, "new": "nieuw-wachtwoord"}).status_code == 200
    r = restore(client, content)
    assert r.status_code == 200 and r.json()["transactions"] == 6
    assert client.get("/api/bootstrap").status_code == 200          # this device stays logged in
    client.post("/api/logout")
    assert client.post("/api/login", json={"password": PASSWORD}).status_code == 401
    assert client.post("/api/login", json={"password": "nieuw-wachtwoord"}).status_code == 200


def test_backup_without_password_is_refused(client, tmp_path):
    content = edit_backup(backup_bytes(client), tmp_path, "DELETE FROM settings WHERE key = '_password_hash'")
    r = restore(client, content)
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_backup"
    assert client.post("/api/setup", json={"password": "overnemen123"}).status_code == 409


def test_exported_backup_has_no_sessions(client, tmp_path):
    path = tmp_path / "x.db"
    path.write_bytes(backup_bytes(client))
    c = sqlite3.connect(path)
    assert c.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    assert c.execute("SELECT COUNT(*) FROM settings WHERE key = '_password_hash'").fetchone()[0] == 1
    assert c.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    c.close()


# ---------------------------------------------------------------- 2 CSV injection

def test_csv_export_neutralises_formulas(client):
    acc = client.post("/api/accounts", json={"name": "=Rekening", "type": "credit"}).json()
    tag = client.post("/api/tags", json={"name": "@tag"}).json()
    client.post("/api/transactions", json={"account_id": acc["id"], "date": "2026-01-10", "amount_cents": -1200,
                                           "merchant_name": "=HYPERLINK(\"x\")", "note": "+31 nummer",
                                           "tag_ids": [tag["id"]]})
    r = client.get("/api/export/transactions.csv")
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig")), delimiter=";"))
    row = dict(zip(rows[0], rows[1]))
    assert row["rekening"] == "'=Rekening" and row["tags"] == "'@tag" and row["notitie"] == "'+31 nummer"
    assert row["naam"].startswith("'=") and row["omschrijving"].startswith("'=")
    assert row["bedrag"] == "-12,00"


# ---------------------------------------------------------------- 3 guard before the body

def run_guard(app, scope_extra: dict, body_chunks: list[bytes], limit: int | None = None,
              monkeypatch=None) -> tuple[int, bool, int]:
    """Call Guard directly; returns (status, inner app called, chunks read)."""
    state = {"called": False, "reads": 0}

    async def inner(scope, receive, send):
        state["called"] = True
        while True:
            message = await receive()
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    chunks = list(body_chunks)

    async def receive():
        state["reads"] += 1
        chunk = chunks.pop(0) if chunks else b""
        return {"type": "http.request", "body": chunk, "more_body": bool(chunks)}

    sent = []

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/api/import", "headers": [], "app": app}
    scope.update(scope_extra)
    asyncio.run(Guard(inner)(scope, receive, send))
    return sent[0]["status"], state["called"], state["reads"]


def test_upload_without_session_is_rejected_before_reading(client):
    status, called, reads = run_guard(client.app, {"headers": [(b"x-cents", b"1")]}, [b"x" * 100])
    assert (status, called, reads) == (401, False, 0)
    status, called, reads = run_guard(client.app, {"path": "/api/restore", "headers": [
        (b"x-cents", b"1"), (b"cookie", b"cents_session=bogus")]}, [b"x"])
    assert (status, called, reads) == (401, False, 0)
    status, called, _ = run_guard(client.app, {"headers": []}, [b"x"])
    assert (status, called) == (403, False)


def test_upload_size_limits(client, monkeypatch):
    cookie = f"cents_session={client.cookies.get('cents_session')}".encode()
    base = [(b"x-cents", b"1"), (b"cookie", cookie)]
    huge = str(2 * 1024 ** 3).encode()
    status, called, reads = run_guard(client.app, {"headers": base + [(b"content-length", huge)]}, [b"x"])
    assert (status, called, reads) == (413, False, 0)
    monkeypatch.setitem(__import__("cents.guard").guard.UPLOAD_LIMITS, "/api/import", 10)
    status, called, _ = run_guard(client.app, {"headers": base}, [b"x" * 6, b"x" * 6, b"x"])
    assert status == 413 and called
    status, _, _ = run_guard(client.app, {"headers": base}, [b"x" * 4, b"x" * 4])
    assert status == 200
    # through the real app: anonymous upload gets 401 JSON
    anon = TestClient(client.app, headers={"X-Cents": "1"})
    r = anon.post("/api/import", files=[("files", ("a.csv", b"data", "text/csv"))])
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthorized"


def test_restore_streams_raw_body_too(client):
    content = backup_bytes(client)
    r = client.post("/api/restore", content=content, headers={"content-type": "application/octet-stream"})
    assert r.status_code == 200


# ---------------------------------------------------------------- 4 restore safety

def test_restore_keeps_pre_restore_copy(client):
    content = backup_bytes(client)
    upload(client, ("a.csv", asn_csv(sample_account())))
    assert restore(client, content).status_code == 200
    pre = Path(db_path(client) + ".pre-restore")
    assert pre.exists()
    c = sqlite3.connect(pre)
    assert c.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 6     # the state before
    c.close()
    assert restore(client, content).status_code == 200
    assert len(list(pre.parent.glob("*.pre-restore*"))) == 1


@pytest.mark.parametrize("sql", [
    "CREATE TRIGGER t AFTER INSERT ON tags BEGIN DELETE FROM tags; END;",
    "CREATE VIEW v AS SELECT 1;",
    "ALTER TABLE tags ADD COLUMN extra TEXT;",
    "CREATE TABLE extra (x);",
    "DROP TABLE rules;",
    "PRAGMA user_version = 99;",
])
def test_restore_rejects_tampered_files(client, tmp_path, sql):
    upload(client, ("a.csv", asn_csv(sample_account())))
    bad = edit_backup(backup_bytes(client), tmp_path, sql)
    r = restore(client, bad)
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_backup"
    assert client.get("/api/transactions").json()["count"] == 6


def test_restore_rejects_other_page_size_and_garbage(client, tmp_path):
    big_pages = edit_backup(backup_bytes(client), tmp_path, page_size=65536)
    r = restore(client, big_pages)
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_backup"
    r = restore(client, b"SQLite format 3\x00" + b"\x00" * 200)
    assert r.status_code == 400
    assert client.get("/api/bootstrap").status_code == 200


def test_restore_upgrades_an_older_schema(client, tmp_path):
    path = tmp_path / "v1.db"
    c = sqlite3.connect(path)
    c.executescript(db.MIGRATIONS[0])
    c.execute("PRAGMA user_version = 1")
    c.execute("INSERT INTO settings (key, value) VALUES ('_password_hash', ?)",
              (json.dumps(auth.hash_password("ander-wachtwoord")),))
    c.execute("INSERT INTO accounts (iban, name, type, created_at) VALUES ('NL11TEST0000000001', 'Oud', 'checking', 'x')")
    c.commit()
    c.close()
    r = restore(client, path.read_bytes())
    assert r.status_code == 200, r.text
    accounts = client.get("/api/accounts").json()
    assert accounts[0]["type_source"] == "auto"


# ---------------------------------------------------------------- 5 setup race

def test_parallel_setup_has_one_winner(anon):
    results = []

    def go(i):
        results.append(anon.post("/api/setup", json={"password": f"wachtwoord-{i}"}).status_code)

    threads = [threading.Thread(target=go, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == [200] + [409] * 7


# ---------------------------------------------------------------- 6 scrypt cost

def test_scrypt_cost_and_rehash(client):
    assert auth.hash_password("x").startswith("scrypt$32768$8$1$")
    conn = db.connect(db_path(client))
    salt = bytes(16)
    digest = auth._scrypt(PASSWORD, salt, 2 ** 14, 8, 1, 32)
    db.set_setting(conn, auth.PASSWORD_KEY, f"scrypt${2 ** 14}$8$1${salt.hex()}${digest.hex()}")
    conn.commit()
    client.post("/api/logout")
    assert client.post("/api/login", json={"password": PASSWORD}).status_code == 200
    assert db.get_setting(conn, auth.PASSWORD_KEY).startswith("scrypt$32768$")
    conn.close()
    client.post("/api/logout")
    assert client.post("/api/login", json={"password": PASSWORD}).status_code == 200


# ---------------------------------------------------------------- 7 bounds

def test_out_of_range_numbers_are_rejected(client):
    acc = client.post("/api/accounts", json={"name": "Kaart", "type": "credit"}).json()
    big = 10 ** 30
    r = client.post("/api/transactions", json={"account_id": acc["id"], "date": "2026-01-01",
                                                "amount_cents": big, "merchant_name": "x"})
    assert r.status_code == 422 and r.json()["error"]["message"]
    assert client.post(f"/api/accounts/{acc['id']}/values", json={"date": "2026-01-01", "value_cents": big}).status_code == 422
    assert client.patch(f"/api/accounts/{acc['id']}", json={"manual_balance_cents": -big}).status_code == 422
    assert client.post("/api/goals", json={"name": "Doel", "target_cents": big}).status_code == 422
    assert client.get("/api/transactions", params={"min_cents": big}).status_code == 422
    assert client.get(f"/api/transactions/{big}").status_code in (400, 422)
    assert client.patch("/api/settings", json={"dismissed_suggestions": ["x"] * 201}).status_code == 422
    assert client.patch("/api/settings", json={"dismissed_suggestions": ["x" * 201]}).status_code == 422
    ok = client.post("/api/transactions", json={"account_id": acc["id"], "date": "2026-01-01",
                                                 "amount_cents": -10 ** 12, "merchant_name": "x"})
    assert ok.status_code == 200


# ---------------------------------------------------------------- 8 catch-all

def test_unhandled_error_returns_json(client, monkeypatch):
    from cents.api import settings as settings_api

    def boom(conn):
        raise RuntimeError("kapot")

    monkeypatch.setattr(settings_api.db, "public_settings", boom)
    r = client.get("/api/settings")
    assert r.status_code == 500
    assert r.json() == {"error": {"code": "internal", "message": "Er ging iets mis."}}
    assert "content-security-policy" in r.headers


# ---------------------------------------------------------------- 9 dependencies, 10 CSP

def test_requirements_are_pinned():
    root = Path(__file__).resolve().parents[1]
    for name in ("requirements.txt", "requirements-dev.txt"):
        lines = [l.strip() for l in (root / name).read_text().splitlines() if l.strip() and not l.startswith("#")]
        assert lines and all("==" in l for l in lines)


def test_csp_header(client):
    csp = client.get("/api/healthz").headers["content-security-policy"]
    assert "base-uri 'none'" in csp and "form-action 'self'" in csp and "frame-ancestors 'none'" in csp


# ---------------------------------------------------------------- interest beats the bank label

def test_interest_wins_over_bank_category(conn):
    from cents.classify.engine import Context, classify
    from cents.classify.library import Library
    ids = db.category_ids(conn)
    ctx = Context(lib=Library(asn_categories={"Sparen": "sparen"}), accounts=[], cat_ids=ids)
    tx = {"account_id": 1, "amount_cents": 312, "method": "interest", "bank_category": "Sparen",
          "merchant_key": "rente", "merchant_name": "Rente", "category_source": "none", "manual": 0}
    assert classify(tx, ctx).category_id == ids["inkomen-overig"]
