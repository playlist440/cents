"""End to end: the synthetic demo household from tools/make_demo_data.py, imported through the
real API with the real library. Asserts invariants, not exact numbers."""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cents import db
from cents.classify.library import load_library, set_library
from cents.main import create_app
from cents.services import insights, ledger, periods, summary

ROOT = Path(__file__).resolve().parents[1]
TODAY = "2026-11-14"


def generate(out: Path) -> list[Path]:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    subprocess.run([sys.executable, str(ROOT / "tools" / "make_demo_data.py"), str(out),
                    "--seed", "42", "--months", "18", "--today", TODAY],
                   check=True, capture_output=True, env=env)
    return sorted(out.iterdir())


def open_client(data_dir: Path) -> TestClient:
    app = create_app(data_dir=data_dir, frontend_dir=data_dir / "no-frontend")
    client = TestClient(app, headers={"X-Cents": "1"})
    client.__enter__()
    assert client.post("/api/setup", json={"password": "demo-wachtwoord"}).status_code == 200
    return client


def upload(client: TestClient, files: list[Path]) -> dict:
    payload = [("files", (f.name, f.read_bytes(), "text/plain")) for f in files]
    r = client.post("/api/import", files=payload)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def real_library():
    set_library(load_library())
    yield


@pytest.fixture
def frozen(monkeypatch):
    state = {"day": date.fromisoformat(TODAY)}
    monkeypatch.setattr(periods, "today", lambda: state["day"])
    return state


def test_demo_household(tmp_path, real_library, frozen):
    files = generate(tmp_path / "demo")
    client = open_client(tmp_path / "data")
    try:
        ibans = sorted({f.name.split("_")[1] for f in files})
        # checking files first: the month totals must not change when the savings side arrives
        acc_files = {iban: [f for f in files if f.name.split("_")[1] == iban] for iban in ibans}
        sizes = {iban: sum(f.stat().st_size for f in fs) for iban, fs in acc_files.items()}
        chk_iban = max(sizes, key=sizes.get)
        sav_iban = min(sizes, key=sizes.get)
        upload(client, acc_files[chk_iban])
        client.post("/api/accounts", json={"name": "Spaarrekening", "type": "savings", "iban": sav_iban})
        before = client.get("/api/overview?period=2026-09").json()
        upload(client, acc_files[sav_iban])
        after = client.get("/api/overview?period=2026-09").json()
        for field in ("income_cents", "fixed_cents", "daily_cents", "saved_cents", "net_cents"):
            assert before[field] == after[field], field
        assert after["saved_cents"] > 0

        # every endpoint answers
        for path in ("/api/bootstrap", "/api/overview", "/api/trends", "/api/recurring", "/api/goals",
                     "/api/networth", "/api/sort/queue"):
            assert client.get(path).status_code == 200, path

        # income ~ two salaries + allowances; trends has 12 periods
        trends = client.get("/api/trends").json()
        assert len(trends["periods"]) == 12
        for p in trends["periods"][:-1]:
            assert 550000 <= p["income_cents"] <= 1000000, p
            assert 250000 <= p["fixed_cents"] <= 350000, p
        # recurring: fixed costs, the price increase, the new subscription
        rec = client.get("/api/recurring").json()
        by_key = {i["merchant_key"]: i for i in rec["items"]}
        for key in ("obvion", "partou", "eneco", "ziggo", "zilveren-kruis", "netflix", "videoland"):
            assert key in by_key, key
        assert by_key["netflix"]["change"]["from_cents"] == -1399
        assert by_key["netflix"]["change"]["to_cents"] == -1599
        assert by_key["disney-plus"]["status"] == "new"
        assert 250000 <= rec["monthly_out_cents"] <= 400000
        assert 550000 <= rec["monthly_in_cents"] <= 700000

        ov = client.get("/api/overview").json()
        assert ov["left_cents"] is not None
        assert -ov["expected_income_cents"] < ov["left_cents"] < ov["expected_income_cents"]
        assert ov["expected_income_cents"] >= 550000
        assert ov["fixed_upcoming_cents"] > 0 and ov["saving_upcoming_cents"] > 0
        kinds = {i["kind"] for i in ov["insights"]}
        assert {"duplicate", "new_recurring"} <= kinds and len(ov["insights"]) <= 5

        # goals by code and by name; a withdrawal subtracts
        code = client.post("/api/goals", json={"name": "Auto", "target_cents": 1500000,
                                               "code": "41827"}).json()
        vak = client.post("/api/goals", json={"name": "Vakantie", "target_cents": 300000,
                                              "target_date": "2027-07-15", "repeat": "yearly"}).json()
        assert code["saldo_cents"] == 17 * 50000          # June 2025 - October 2026
        assert any(e["amount_cents"] < 0 for e in vak["entries"])
        assert 0 < vak["saldo_cents"] < 17 * 25000

        # calendar, recap and trends agree
        fixed_keys = {i["key"] for i in rec["items"]
                      if i["category_id"] in {c["id"] for c in client.get("/api/categories").json()
                                              if c["grp"] == "fixed"}}
        cal = client.get("/api/calendar").json()
        cal_items = [i for d in cal["days"] for i in d["items"]]
        assert sum(-i["amount_cents"] for i in cal_items
                   if i["key"] in fixed_keys and i["status"] != "paid") == ov["fixed_upcoming_cents"]
        assert cal["in"]["expected_cents"] + ov["income_cents"] >= ov["expected_income_cents"] - 1
        oct_cal = client.get("/api/calendar?period=2026-10").json()
        assert oct_cal["out"]["expected_cents"] == 0 and oct_cal["out"]["missed_cents"] == 0
        assert oct_cal["out"]["paid_cents"] <= trends["periods"][-2]["fixed_cents"] + trends["periods"][-2]["saved_cents"]
        by_period = {p["period"]: p for p in trends["periods"]}
        for pid in ("2026-06", "2026-10"):
            r = client.get(f"/api/recap?period={pid}").json()
            for key, val in r["totals"].items():
                assert val == by_period[pid][key], (pid, key)
            assert 3 <= len(r["highlights"]) <= 6
        y = client.get("/api/recap?year=2026").json()
        for key, val in y["totals"].items():
            assert val == sum(m[key] for m in y["months"]) == sum(
                p[key] for p in trends["periods"] if p["period"].startswith("2026")), key
        assert client.get("/api/recap/index").json()["years"] == [2026, 2025]

        nw = client.get("/api/networth").json()
        series = nw["series"]
        assert len(series) == 18 and series[-1]["total_cents"] == nw["total_cents"]
        for a, b in zip(series, series[1:]):
            assert abs(b["total_cents"] - a["total_cents"]) < 0.25 * a["total_cents"], (a, b)
        assert series[-1]["savings_cents"] > series[0]["savings_cents"]
    finally:
        client.__exit__(None, None, None)


def test_demo_household_as_of_june(tmp_path, real_library, frozen):
    """The same family seen on 20 June 2026: Spotify has just stopped, Netflix's price change is
    recent."""
    frozen["day"] = date(2026, 6, 20)
    out = tmp_path / "cut"
    out.mkdir()
    for f in generate(tmp_path / "demo"):
        if f.suffix != ".csv":
            continue
        lines = f.read_text(encoding="utf-8").splitlines()
        keep = [lines[0]] + [ln for ln in lines[1:]
                             if date(*reversed([int(x) for x in ln[:10].split("-")])) <= frozen["day"]]
        if len(keep) > 1:
            (out / f.name).write_text("\n".join(keep) + "\n", encoding="utf-8")
    client = open_client(tmp_path / "data")
    try:
        upload(client, sorted(out.iterdir()))
        rec = {i["merchant_key"]: i for i in client.get("/api/recurring").json()["items"]}
        assert rec["spotify"]["status"] == "ended"
        conn = db.connect(tmp_path / "data" / "cents.db")
        lg = ledger.build(conn)
        p = lg.current()
        found = {i["kind"]: i for i in insights.candidates(conn, lg, p, summary.build_overview(conn, lg, p))}
        conn.close()
        assert found["ended_recurring"]["title"] == "Spotify is sinds april niet meer betaald"
        assert found["price_change"]["title"] == "Netflix is € 2 duurder geworden"
    finally:
        client.__exit__(None, None, None)
