#!/usr/bin/env python3
"""Does the test mode (`?mock=1`, frontend/js/mock/mock.js) show what the real backend computes?

The mock is a JavaScript approximation used for demos, screenshots and reviews. This tool loads
the mock's own demo data into a fresh backend database, asks both the same questions and lists
every figure that differs.

1. Collect the mock's data and answers. The collector serves the frontend itself; open the
   printed address and run the printed snippet in the browser console:

       uv run --python 3.12 --with-requirements requirements.txt --with-requirements requirements-dev.txt \
           python tools/mock_parity.py \
           collect /tmp/mock-dump.json

2. Compare:

       uv run --python 3.12 --with-requirements requirements.txt --with-requirements requirements-dev.txt \
           python tools/mock_parity.py \
           compare /tmp/mock-dump.json

Exit code 1 when a figure that must match differs. Known approximations of the mock are listed
in KNOWN and reported separately.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

PORT = 8799


def requests_for(today: str) -> list[list]:
    """[key, path, query] for every GET that is compared."""
    y, m = int(today[:4]), int(today[5:7])
    past = []
    for i in range(1, 7):
        mm, yy = m - i, y
        while mm < 1:
            mm, yy = mm + 12, yy - 1
        past.append(f"{yy:04d}-{mm:02d}")
    out = [["overview", "/overview", {}], ["goals", "/goals", {}], ["recurring", "/recurring", {}],
           ["checks", "/checks", {}], ["besparen", "/besparen", {}],
           ["networth", "/networth", {}], ["trends", "/trends", {"periods": "24"}],
           [f"overview:{y}", "/overview", {"period": str(y)}],
           [f"recap:y{y}", "/recap", {"year": str(y)}]]
    for p in past:
        out.append([f"overview:{p}", "/overview", {"period": p}])
    for p in past[:3]:
        out.append([f"recap:{p}", "/recap", {"period": p}])
    return out


# ---------------------------------------------------------------------------- collect

SNIPPET = """(async () => {
  const m = await import('/js/mock/mock.js');
  const today = m.debug.db.today;
  const reqs = await (await fetch('/parity/requests?today=' + today)).json();
  const dump = m.parityDump(reqs);
  await fetch('/parity/dump', { method: 'POST', body: JSON.stringify(dump) });
  return 'sent ' + Object.keys(dump.outputs).length + ' answers';
})()"""


def collect(out: Path) -> None:
    """Serve the frontend (mock mode needs no backend) on PORT, without the backend's
    Content-Security-Policy, and save what the snippet posts to /parity/dump."""
    from functools import partial
    from http.server import SimpleHTTPRequestHandler

    class Handler(SimpleHTTPRequestHandler):
        def end_headers(self) -> None:
            self.send_header("Cache-Control", "no-store")      # always the current mock
            super().end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if not self.path.startswith("/parity/requests"):
                return super().do_GET()
            today = self.path.split("today=")[-1][:10]
            body = json.dumps(requests_for(today)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            n = int(self.headers.get("Content-Length") or 0)
            out.write_bytes(self.rfile.read(n))
            self.send_response(204)
            self.end_headers()
            self.server.done = True

        def log_message(self, *a) -> None:
            pass

    srv = HTTPServer(("127.0.0.1", PORT), partial(Handler, directory=str(ROOT / "frontend")))
    srv.done = False
    print(f"Open http://127.0.0.1:{PORT}/?mock=1 and run this in its console:\n")
    print(SNIPPET)
    while not srv.done:
        srv.handle_request()
    print(f"\nSaved {out}")


# ---------------------------------------------------------------------------- load

TABLES = ["accounts", "imports", "goals", "transactions", "goal_entries", "account_values",
          "securities", "trades", "cash_events", "prices", "mortgage_parts", "mortgage_years",
          "home_values", "assets", "asset_entries"]


def _columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]


def load(conn: sqlite3.Connection, mdb: dict) -> None:
    """The mock's demo data into an empty backend database (categories mapped by key)."""
    cat_by_key = {r[1]: r[0] for r in conn.execute("SELECT id, key FROM categories")}
    cat_map = {c["id"]: cat_by_key.get(c["key"]) for c in mdb["categories"]}
    now = "2026-01-01T00:00:00"
    for table in TABLES:
        cols = _columns(conn, table)
        for i, row in enumerate(mdb.get(table) or []):
            r = dict(row)
            if table == "transactions":
                r["category_id"] = cat_map.get(r.get("category_id"))
                r.setdefault("dedupe_key", f"mock:{r['id']}")
            if table == "prices":
                r.setdefault("close", r.get("close_eur"))
                r.setdefault("currency", "EUR")
            if table == "trades":
                r.setdefault("dedupe_key", f"mock-trade:{r.get('id', i)}")
            if table == "cash_events":
                r.setdefault("dedupe_key", f"mock-cash:{r.get('id', i)}")
            for k in ("match", "keywords"):
                if isinstance(r.get(k), list):
                    r[k] = json.dumps(r[k])
            for k in ("created_at", "updated_at"):
                if k in cols and not r.get(k):
                    r[k] = now
            for k, v in list(r.items()):
                if isinstance(v, bool):
                    r[k] = int(v)
            keep = {k: v for k, v in r.items() if k in cols and not isinstance(v, (dict, list))}
            q = f"INSERT INTO {table} ({', '.join(keep)}) VALUES ({', '.join('?' * len(keep))})"
            conn.execute(q, list(keep.values()))
    for key in mdb.get("recurring_ignored") or []:
        conn.execute("INSERT OR IGNORE INTO recurring_ignored (key) VALUES (?)", (key,))
    for k in ("month_start_day",):
        if k in (mdb.get("settings") or {}):
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                         (k, json.dumps(mdb["settings"][k])))


# ---------------------------------------------------------------------------- compare

# Figures where the mock is a known approximation: reported, but not a failure.
KNOWN = {
    "recurring.items": "item details are simplified in the mock (order, price changes, key amount)",
}


def flatten(x, prefix: str = "", out: dict | None = None) -> dict:
    out = {} if out is None else out
    if isinstance(x, dict):
        for k, v in x.items():
            flatten(v, f"{prefix}.{k}" if prefix else str(k), out)
    elif isinstance(x, list):
        out[prefix + "#"] = len(x)
        for i, v in enumerate(x[:40]):
            flatten(v, f"{prefix}[{i}]", out)
    else:
        out[prefix] = x
    return out


# Which numbers to compare per answer: dotted prefixes (after flattening).
CHECK = {
    "overview": ["income_cents", "fixed_cents", "daily_cents", "saved_cents", "repaid_cents",
                 "result_cents", "free.", "buffer.", "tempo.avg_net_cents", "health.",
                 "checking_warning."],
    "overview:": ["income_cents", "fixed_cents", "daily_cents", "saved_cents", "repaid_cents",
                  "result_cents", "net_cents"],
    "recap:": ["totals.", "savings.saved_cents"],
    "trends": ["periods[", "top_merchants["],
    "goals": ["total_advice_cents", "room.", "savings_balance_cents", "unallocated_cents",
              "suggestions["],
    "recurring": ["monthly_out_cents", "monthly_in_cents", "subscriptions.", "income_cents",
                  "repaid_cents", "share_of_income", "items["],
    "networth": ["total_cents"],
    "checks": ["coverage.", "issues", "transfers.count", "accounts["],
    "besparen": ["subscriptions.per_year_cents", "price_rises.", "contracts.", "fees.", "higher.", "later."],
}

SKIP_SUFFIX = (".name", ".label", ".as_of", ".stale", ".type", ".date", ".payday_source", "_date",
               ".last_import", ".account", ".other_account", ".category_id", ".since",
               ".source", ".reason", ".emoji", ".kind", ".period", "partial", ".id", ".goal_id")


def wanted(key: str, path: str) -> bool:
    rules = CHECK.get(key) or CHECK.get(key.split(":")[0] + ":") or []
    return any(path.startswith(r) or path == r.rstrip(".") for r in rules) and not path.endswith(SKIP_SUFFIX)


def per_category(answer: dict, cats: dict[int, str], field: str = "categories") -> dict:
    out = {}
    for c in answer.get(field) or []:
        key = cats.get(c["category_id"], str(c["category_id"]))
        out[key] = c.get("spent_cents", c.get("cents"))
    return out


def compare(dump_path: Path) -> int:
    dump = json.loads(dump_path.read_text())
    mdb, mock = dump["db"], dump["outputs"]
    today = date.fromisoformat(mdb["today"])

    from fastapi.testclient import TestClient

    from cents import db as cdb
    from cents.classify.library import load_library, set_library
    from cents.main import create_app
    from cents.services import cache, periods

    periods.today = lambda: today
    set_library(load_library())
    tmp = Path(tempfile.mkdtemp(prefix="cents-parity-"))
    app = create_app(data_dir=tmp, frontend_dir=tmp / "no-frontend")
    client = TestClient(app, headers={"X-Cents": "1"})
    client.__enter__()
    assert client.post("/api/setup", json={"password": "parity-wachtwoord"}).status_code == 200
    conn = cdb.connect(app.state.db_path)
    load(conn, mdb)
    cache.bump(conn)
    conn.commit()
    cat_names = {r[0]: r[1] for r in conn.execute("SELECT id, key FROM categories")}
    mock_cat_names = {c["id"]: c["key"] for c in mdb["categories"]}

    fails, known = [], []
    for key, path, query in requests_for(mdb["today"]):
        r = client.get("/api" + path, params=query)
        back = r.json() if r.status_code == 200 else {"error": r.status_code}
        m = mock.get(key) or {}
        fb, fm = flatten(back), flatten(m)
        for p in sorted(set(fb) | set(fm)):
            if not wanted(key, p):
                continue
            vb, vm = fb.get(p), fm.get(p)
            if isinstance(vb, float) or isinstance(vm, float):
                same = vb is not None and vm is not None and abs(float(vb) - float(vm)) <= 0.0015
            elif isinstance(vb, int) and isinstance(vm, int) and not isinstance(vb, bool):
                same = abs(vb - vm) <= 1          # a cent of rounding (a median of rates)
            else:
                same = vb == vm
            if not same:
                note = next((why for k2, why in KNOWN.items() if f"{key}.{p}".startswith(k2)), None)
                (known if note else fails).append((key, p, vm, vb, note))
        if "categories" in back or "categories" in m:
            bc = per_category(back, cat_names)
            mc = per_category(m, mock_cat_names)
            for c in sorted(set(bc) | set(mc)):
                if key == "trends":
                    continue
                if (bc.get(c) or 0) != (mc.get(c) or 0):
                    fails.append((key, f"bakje {c}", mc.get(c), bc.get(c), None))

    def show(rows: list, title: str) -> None:
        print(f"\n{title}: {len(rows)}")
        for key, p, vm, vb, note in rows:
            print(f"  {key:16} {p:48} mock={vm!s:>12}  backend={vb!s:>12}" + (f"  ({note})" if note else ""))
    show(fails, "Verschillen")
    show(known, "Bekende benaderingen")
    return 1 if fails else 0


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("collect", "compare"):
        print(__doc__)
        sys.exit(2)
    if sys.argv[1] == "collect":
        collect(Path(sys.argv[2]))
    else:
        sys.exit(compare(Path(sys.argv[2])))
