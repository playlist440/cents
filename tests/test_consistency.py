"""One word, one number (expert review 2026-11): every figure that appears on more than one
screen must be the same everywhere. The demo household from tools/make_demo_data.py goes
through the real import with the real library; then the answers of all endpoints that show the
same thing are compared.

Screens and the endpoints behind them:
- Overzicht (month, year): /overview?period
- Terugblik (month, year): /recap
- Jaaroverzicht: /trends
- Bakje: /categories/{id}/summary
- Vaste lasten: /recurring
- Potjes: /goals
- Hoe staan we ervoor, buffer bar, Nog te besteden: /overview (current)
"""

from __future__ import annotations

import math
from datetime import date

import pytest

from cents.classify.library import load_library, set_library
from cents.services import periods
from test_demo_household import TODAY, generate, open_client, upload


@pytest.fixture(scope="module")
def demo(tmp_path_factory):
    set_library(load_library())
    mp = pytest.MonkeyPatch()
    mp.setattr(periods, "today", lambda: date.fromisoformat(TODAY))
    root = tmp_path_factory.mktemp("consistency")
    client = open_client(root / "data")
    files = generate(root / "files")
    upload(client, [f for f in files if f.suffix == ".csv"])
    # a potje, so Potjes, the buffer and vrij spaargeld have something to agree on
    client.post("/api/goals", json={"name": "Vakantie", "target_cents": 300000})
    yield client
    mp.undo()


def get(client, path, **params):
    r = client.get("/api" + path, params=params)
    assert r.status_code == 200, (path, r.text)
    return r.json()


FLOWS = ("income_cents", "fixed_cents", "daily_cents", "saved_cents", "result_cents", "net_cents")


def complete_periods(client, n=6):
    out = [p["id"] for p in get(client, "/recap/index")["periods"][:n]]
    assert len(out) == n                       # the demo has 18 months: nothing passes vacuously
    return out


def test_a_month_is_the_same_on_every_screen(demo):
    trends = {p["period"]: p for p in get(demo, "/trends", periods=24)["periods"]}
    tempo = {m["period"]: m["net_cents"] for m in get(demo, "/overview")["tempo"]["months"]}
    for pid in complete_periods(demo):
        ov = get(demo, "/overview", period=pid)
        rc = get(demo, "/recap", period=pid)
        year = get(demo, "/overview", period=pid[:4])
        ym = next(m for m in year["months"] if m["period"] == pid)
        for k in FLOWS:
            assert ov[k] == rc["totals"][k] == trends[pid][k], (pid, k)
        for k in ("income_cents", "fixed_cents", "daily_cents", "saved_cents", "result_cents"):
            assert ym[k] == ov[k], (pid, k)
        # over / tekort: the Overzicht hero, the tempo bars and the Terugblik headline
        assert tempo[pid] == ov["result_cents"]
        word = "over" if ov["result_cents"] >= 0 else "meer uitgegeven"
        assert word in rc["highlights"][0]["title"]
        assert rc["savings"]["saved_cents"] == ov["saved_cents"]


def test_a_bakje_is_the_same_on_every_screen(demo):
    trends = get(demo, "/trends", periods=24)
    index = {p["period"]: i for i, p in enumerate(trends["periods"])}
    by_cat = {c["category_id"]: c["cents"] for c in trends["categories"]}
    for pid in complete_periods(demo, 3):
        ov = {c["category_id"]: c["spent_cents"] for c in get(demo, "/overview", period=pid)["categories"]}
        rc = {c["category_id"]: c["cents"] for c in get(demo, "/recap", period=pid)["categories"]}
        for cid, cents in ov.items():
            if cents <= 0:
                continue
            assert rc.get(cid) == cents, (pid, cid)
            assert by_cat[cid][index[pid]] == cents, (pid, cid)
            s = get(demo, f"/categories/{cid}/summary", period=pid)
            assert s["spent_cents"] == cents, (pid, cid)


def test_a_year_is_its_months(demo):
    year = TODAY[:4]
    ov = get(demo, "/overview", period=year)
    rc = get(demo, "/recap", year=year)
    for k in ("income_cents", "fixed_cents", "daily_cents", "saved_cents", "result_cents"):
        assert ov[k] == rc["totals"][k] == sum(m[k] for m in rc["months"]), k


def test_one_vaste_lasten_per_maand_and_one_percentage(demo):
    ov = get(demo, "/overview")
    rec = get(demo, "/recurring")
    h = ov["health"]
    assert h["fixed"]["cents"] == rec["monthly_out_cents"] == ov["buffer"]["monthly_fixed_cents"]
    assert h["income_cents"] == rec["income_cents"]
    assert h["fixed"]["share"] == rec["share_of_income"]
    # the fixed_share insight (hidden on the Overzicht, used elsewhere) says the same
    from cents import db
    from cents.services import insights, ledger, summary
    conn = db.connect(demo.app.state.db_path)
    lg = ledger.get(conn)
    p = lg.current()
    found = {i["kind"]: i for i in insights.candidates(conn, lg, p, summary.build_overview(conn, lg, p))}
    pct = f"{round(h['fixed']['share'] * 100)} %"
    assert pct in found["fixed_share"]["title"].replace("\u00a0", " ")


def test_one_buffer(demo):
    ov = get(demo, "/overview")
    b, h = ov["buffer"], ov["health"]["buffer"]
    assert (b["months"], b["target_months"], b["saved_cents"], b["target_cents"]) == (
        h["months"], h["target_months"], h["saved_cents"], h["target_cents"])
    assert b["months"] == round(b["saved_cents"] / b["monthly_fixed_cents"], 1)
    sugg = [s for s in get(demo, "/goals")["suggestions"] if s["kind"] == "buffer"]
    if b["target_source"] == "assumption" and sugg:
        assert sugg[0]["target_cents"] == math.ceil(b["target_cents"] / 10000) * 10000


def test_savings_add_up(demo):
    ov = get(demo, "/overview")
    goals = get(demo, "/goals")
    s = ov["free"]["savings"]
    assert s["balance_cents"] == goals["savings_balance_cents"]
    in_pots = sum(max(0, g["saldo_cents"]) for g in goals["goals"])
    assert s["goals_cents"] == min(in_pots, max(0, s["balance_cents"]))
    assert s["free_cents"] == max(0, s["balance_cents"] - s["goals_cents"] - s["buffer_cents"])
    # Potjes "nog vrij" is the same balance minus potjes, before the buffer
    assert goals["unallocated_cents"] == s["balance_cents"] - sum(g["saldo_cents"] for g in goals["goals"])


def test_nog_te_besteden_adds_up(demo):
    f = get(demo, "/overview")["free"]
    parts = (f["fixed_until_payday_cents"] + f["fixed_overdue_cents"] + f["saving_until_payday_cents"]
             + f["credit_cents"] + (f["card_settlement"]["cents"] if f["card_settlement"] else 0)
             + f["daily_until_payday_cents"])
    assert f["total_cents"] == f["balances_cents"] - parts
    assert f["balances_cents"] == sum(a["balance_cents"] for a in f["accounts"])
    assert sum(x["cents"] for x in f["fixed_overdue"]) == f["fixed_overdue_cents"]


def test_zelfcontrole_finds_nothing_in_a_complete_import(demo):
    """The demo files cover every month of both accounts without gaps: no false alarms."""
    c = get(demo, "/checks")
    assert c["issues"] == 0, c
    assert 0.8 < c["coverage"]["share"] <= 1
    assert get(demo, "/overview")["health"]["accounted"]["share"] == c["coverage"]["share"]
