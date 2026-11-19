"""Smoke test for 1.0: the demo household through the real import, then every endpoint and every
kind of change the screens make, each followed by the screens that read the result. Nothing may
answer with a server error (500); every read must be valid JSON."""

from __future__ import annotations

import io
import zipfile

import pytest

from test_consistency import demo  # noqa: F401  (fixture: demo household, frozen today)
from test_consistency import TODAY

SCREENS = [("/overview", {}), ("/recurring", {}), ("/besparen", {}), ("/checks", {}), ("/networth", {}),
           ("/goals", {}), ("/assets", {}), ("/trends", {"periods": "24"}), ("/assumptions", {}),
           ("/sort/queue", {}), ("/calendar", {}), ("/bootstrap", {}), ("/mortgage", {}),
           ("/recap/index", {}), ("/transactions", {"sort": "amount"}), ("/settings", {})]


def ok(r, *codes):
    assert r.status_code < 500, (r.request.method, r.request.url, r.status_code, r.text[:300])
    if codes:
        assert r.status_code in codes, (r.request.method, r.request.url, r.status_code, r.text[:300])
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else r


def screens(c):
    for path, q in SCREENS:
        ok(c.get("/api" + path, params=q), 200)


def test_every_read(demo):
    c = demo
    screens(c)
    y, m = int(TODAY[:4]), int(TODAY[5:7])
    months = []
    for i in range(20):
        mm, yy = m - i, y
        while mm < 1:
            mm, yy = mm + 12, yy - 1
        months.append(f"{yy:04d}-{mm:02d}")
    cats = ok(c.get("/api/categories"), 200)
    for p in months:
        ok(c.get("/api/overview", params={"period": p}), 200)
        ok(c.get("/api/calendar", params={"period": p}), 200)
    for p in months[1:14]:
        ok(c.get("/api/recap", params={"period": p}), 200)
    for yr in (y, y - 1):
        ok(c.get("/api/overview", params={"period": str(yr)}), 200)
        ok(c.get("/api/recap", params={"year": str(yr)}), 200)
    for cat in cats:
        for p in months[:3]:
            ok(c.get(f"/api/categories/{cat['id']}/summary", params={"period": p}), 200)
    txs = ok(c.get("/api/transactions", params={"limit": 1000}), 200)["items"]
    for t in txs[::25]:
        ok(c.get(f"/api/transactions/{t['id']}"), 200)
    for sort in ("date", "-date", "amount", "-amount", "merchant", "-merchant", "category", "account"):
        page = ok(c.get("/api/transactions", params={"sort": sort, "limit": 50}), 200)
        if page["next_cursor"]:
            ok(c.get("/api/transactions", params={"sort": sort, "limit": 50, "cursor": page["next_cursor"]}), 200)
    for acc in ok(c.get("/api/accounts"), 200):
        if acc["type"] == "investment":
            ok(c.get(f"/api/accounts/{acc['id']}/holdings"))
            ok(c.get(f"/api/accounts/{acc['id']}/values"))
    for tag in ok(c.get("/api/tags"), 200):
        ok(c.get(f"/api/tags/{tag['id']}/summary"), 200)
    ok(c.get("/api/rules"), 200)
    ok(c.get("/api/imports"), 200)
    assert ok(c.get("/api/creditcard/template"), 200).content[:2] == b"PK"
    ok(c.get("/api/export/transactions.csv"), 200)


def test_every_change_then_every_screen(demo):
    c = demo
    cats = {x["key"]: x["id"] for x in ok(c.get("/api/categories"), 200)}
    txs = ok(c.get("/api/transactions", params={"limit": 1000, "sort": "amount"}), 200)["items"]
    big = next(t for t in txs if t["amount_cents"] < -50000 and t["kind"] == "normal")
    small = next(t for t in reversed(txs) if t["amount_cents"] < 0 and t["kind"] == "normal")

    # transactions: bakje (each scope), spread, book date, note, tags, manual add/remove, bulk
    for scope in ("one", "merchant"):
        ok(c.patch(f"/api/transactions/{small['id']}", json={"category_id": cats["boodschappen"], "apply_scope": scope}), 200)
        screens(c)
    ok(c.patch(f"/api/transactions/{small['id']}", json={"category_id": cats["uit-eten"], "apply_scope": "merchant_below",
                                                         "below_cents": 2000}))
    ok(c.patch(f"/api/transactions/{big['id']}", json={"spread_months": 24}), 200)
    screens(c)
    ok(c.patch(f"/api/transactions/{big['id']}", json={"spread_months": 1}), 200)
    ok(c.patch(f"/api/transactions/{small['id']}", json={"book_date": small["date"], "note": "test"}), 200)
    tag = ok(c.post("/api/tags", json={"name": "Smoke", "emoji": "🧪", "color": "blue"}))
    ok(c.patch(f"/api/transactions/{small['id']}", json={"tag_ids": [tag["id"]]}), 200)
    manual = ok(c.post("/api/transactions", json={"account_id": small["account_id"], "date": TODAY,
                                                 "amount_cents": -1234, "merchant_name": "Markt"}), 200)
    ok(c.post("/api/transactions/bulk", json={"ids": [manual["transaction"]["id"]], "category_id": cats["boodschappen"]}))
    screens(c)
    ok(c.delete(f"/api/transactions/{manual['transaction']['id']}"))

    # potjes
    g = ok(c.post("/api/goals", json={"name": "Smoke potje", "target_cents": 100000, "target_date": "2027-06-01"}))
    ok(c.post(f"/api/goals/{g['id']}/saldo", json={"saldo_cents": 25000}))
    ok(c.post(f"/api/goals/{g['id']}/entries", json={"amount_cents": 5000, "date": TODAY}))
    ok(c.patch(f"/api/goals/{g['id']}", json={"target_cents": 120000}))
    screens(c)
    ok(c.patch(f"/api/goals/{g['id']}", json={"archived": True}))
    ok(c.delete(f"/api/goals/{g['id']}"))

    # bezittingen: from a payment and by hand, curve, sale and undo
    p1 = ok(c.post("/api/assets", json={"kind": "possession", "name": "Auto", "tx_id": big["id"], "curve": "front"}))
    p2 = ok(c.post("/api/assets", json={"kind": "possession", "name": "Oude auto", "price_cents": 1800000,
                                       "start_date": "2019-03-01", "life_months": 120, "residual_cents": 200000}))
    screens(c)
    ok(c.patch(f"/api/assets/{p1['id']}", json={"curve": "linear", "life_months": 60}))
    ok(c.patch(f"/api/assets/{p2['id']}", json={"sale_date": TODAY, "sale_cents": 300000}))
    screens(c)
    ok(c.patch(f"/api/assets/{p2['id']}", json={"sale_date": None, "sale_cents": None}))
    # schuld, pensioen, overig
    d = ok(c.post("/api/assets", json={"kind": "debt", "name": "Lening", "debt_kind": "lening"}))
    ok(c.post(f"/api/assets/{d['id']}/entries", json={"date": TODAY, "value_cents": 500000, "interest_cents": 10000,
                                                    "repaid_cents": 50000}))
    ok(c.post("/api/assets", json={"kind": "pension", "name": "Pensioen"}))
    ok(c.post("/api/assets", json={"kind": "other", "name": "Bezit"}))
    screens(c)

    # hypotheek
    m = ok(c.post("/api/mortgage", json={"parts": [{"name": "Deel 1"}]}))
    pid = (m.get("parts") or [{}])[0].get("id")
    if pid:
        ok(c.put(f"/api/mortgage/years/{int(TODAY[:4]) - 1}", json={"parts": [{"part_id": pid, "debt_end_cents": 20000000,
                                                                             "interest_cents": 600000, "repaid_cents": 400000}]}))
    ok(c.post("/api/mortgage/home-values", json={"date": TODAY, "value_cents": 40000000}))
    screens(c)

    # bakjes, regels, instellingen, meldingen, vaste lasten negeren
    cat = ok(c.post("/api/categories", json={"name": "Smoke bakje", "grp": "daily", "emoji": "🧪", "color": "red"}))
    ok(c.patch(f"/api/categories/{cat['id']}", json={"name": "Smoke 2"}))
    ok(c.delete(f"/api/categories/{cat['id']}"))
    ok(c.patch("/api/settings", json={"assumptions": {"buffer": {"months": 6, "amount_cents": None},
                                                      "payday_day": {"day": 25}, "checking_floor_cents": {"cents": 50000}}}), 200)
    ok(c.post("/api/insights/mute", json={"kind": "overdrawn", "muted": True}))
    rec = ok(c.get("/api/recurring"), 200)["items"]
    if rec:
        ok(c.post("/api/recurring/ignore", json={"key": rec[0]["key"]}))
        screens(c)
        ok(c.request("DELETE", "/api/recurring/ignore", json={"key": rec[0]["key"]}))
    queue = ok(c.get("/api/sort/queue"), 200)
    first = (queue.get("items") or queue.get("merchants") or [None])[0] if isinstance(queue, dict) else None
    if first and first.get("merchant_key"):
        ok(c.post("/api/sort", json={"merchant_key": first["merchant_key"], "category_id": cats["overig"]}))
    ok(c.post("/api/reclassify"))
    screens(c)

    # creditcard by hand
    raw = ok(c.get("/api/creditcard/template"), 200).content
    zin = zipfile.ZipFile(io.BytesIO(raw))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zout:
        for name in zin.namelist():
            data = zin.read(name).decode()
            if name == "xl/worksheets/sheet1.xml":
                row = ('<row r="2"><c r="A2" t="inlineStr"><is><t>' + f"{TODAY[8:10]}-{TODAY[5:7]}-{TODAY[:4]}"
                       + '</t></is></c><c r="B2" t="inlineStr"><is><t>Bol.com</t></is></c><c r="C2"><v>25.5</v></c></row>')
                end = data.index("</row>", data.index("<sheetData>")) + len("</row>")
                data = data[:end] + row + data[data.index("</sheetData>"):]
            zout.writestr(name, data)
    res = ok(c.post("/api/import", files=[("files", ("cc.xlsx", out.getvalue(), "application/octet-stream"))]), 200)
    assert res["files"][0]["ok"], res
    screens(c)

    # accounts: add with IBAN, rename, remove
    acc = ok(c.post("/api/accounts", json={"name": "Zakgeld", "type": "checking", "iban": "NL02ABNA0123456789"}))
    acc_id = acc.get("id") or acc.get("account", {}).get("id")
    if acc_id:
        ok(c.patch(f"/api/accounts/{acc_id}", json={"name": "Zakgeld 2"}))
        screens(c)
        ok(c.delete(f"/api/accounts/{acc_id}"))
    screens(c)


@pytest.mark.parametrize("path", ["/api/export/backup"])
def test_downloads(demo, path):
    assert demo.get(path).status_code == 200
