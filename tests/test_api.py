import csv
import io
from datetime import date

from conftest import PASSWORD, upload
from helpers import CHECKING, SAVINGS, Account, Tx, asn_csv, camt, sample_account


def cat_id(client, key):
    return next(c["id"] for c in client.get("/api/categories").json() if c["key"] == key)


def tx_by_seq(client, merchant_key):
    return client.get("/api/transactions", params={"merchant_key": merchant_key}).json()["items"]


def test_import_endpoint_and_history(client):
    res = upload(client, ("a.csv", asn_csv(sample_account())), ("b.xml", camt([sample_account()])),
                 ("c.txt", "niets"))
    files = res["files"]
    assert [f["ok"] for f in files] == [True, True, False]
    assert files[0]["format"] == "asn_csv" and files[0]["new"] == 6 and files[0]["is_new_account"]
    assert files[1]["format"] == "camt053" and files[1]["duplicates"] == 6 and files[1]["enriched"] == 6
    assert files[2]["error"]
    assert res["totals"] == {"new": 6, "duplicates": 6, "enriched": 6}
    assert res["unsorted_merchants"] >= 1
    history = client.get("/api/imports").json()
    assert len(history) == 2 and history[0]["n_duplicate"] == 6
    boot = client.get("/api/bootstrap").json()
    assert boot["has_data"] and boot["periods"]["first"] == "2026-01" and len(boot["accounts"]) == 1
    assert len(boot["categories"]) == 30
    # undo the first import: its transactions disappear
    first = [h for h in history if h["format"] == "asn_csv"][0]
    assert client.delete(f"/api/imports/{first['id']}").json()["deleted"] == 6
    assert client.get("/api/transactions").json()["count"] == 0


def test_upload_limit(client, monkeypatch):
    from cents.api import imports as imports_api
    monkeypatch.setattr(imports_api, "MAX_UPLOAD_BYTES", 100)
    res = upload(client, ("big.csv", asn_csv(sample_account())))
    assert res["files"][0]["ok"] is False and "MB" in res["files"][0]["error"]


def test_list_filters_search_and_paging(client):
    upload(client, ("a.csv", asn_csv(sample_account())))
    all_ = client.get("/api/transactions").json()
    assert all_["count"] == 6 and all_["sum_in_cents"] == 250000
    assert all_["sum_out_cents"] == -(2345 + 1999 + 10000 + 4500 + 2500)
    assert [t["date"] for t in all_["items"]] == sorted([t["date"] for t in all_["items"]], reverse=True)
    item = all_["items"][0]
    assert set(item) >= {"id", "account_id", "date", "amount_cents", "merchant_name", "merchant_key",
                         "counterparty_iban", "description", "method", "city", "category_id",
                         "category_source", "kind", "transfer_account_id", "tag_ids", "goal_id",
                         "note", "manual", "balance_after_cents"}
    page1 = client.get("/api/transactions", params={"limit": 4}).json()
    page2 = client.get("/api/transactions", params={"limit": 4, "cursor": page1["next_cursor"]}).json()
    assert len(page1["items"]) == 4 and len(page2["items"]) == 2 and page2["next_cursor"] is None
    assert not {t["id"] for t in page1["items"]} & {t["id"] for t in page2["items"]}
    q = lambda **p: client.get("/api/transactions", params=p).json()["count"]
    assert q(q="jumbo") == 1
    assert q(q="23,45") == 1 and q(q="€ 23,45") == 1 and q(q="23.45") == 1
    assert q(q="premie") == 1
    assert q(period="2026-01") == 6 and q(period="2026-02") == 0
    assert q(**{"from": "2026-01-03", "to": "2026-01-05"}) == 2
    assert q(method="card") == 1
    assert q(min_cents=4000, max_cents=10000) == 2
    assert q(unsorted=True) >= 1
    assert q(category_id=cat_id(client, "boodschappen")) == 1
    assert client.get("/api/transactions", params={"period": "rubbish"}).status_code == 400


def test_patch_learns_rule_and_detail(client):
    upload(client, ("a.csv", asn_csv(sample_account())))
    friend = tx_by_seq(client, "p:j de testpersoon m voorbeeld")
    assert len(friend) == 1
    t = friend[0]
    uit = cat_id(client, "uit-eten")
    r = client.patch(f"/api/transactions/{t['id']}", json={"category_id": uit}).json()
    assert r["transaction"]["category_id"] == uit and r["transaction"]["category_source"] == "rule"
    assert r["updated_count"] == 1
    rules = client.get("/api/rules").json()
    assert rules[0]["merchant_key"] == t["merchant_key"] and rules[0]["count"] == 1
    # a new transaction of the same person follows the rule
    more = Account(CHECKING, 0, [Tx(date(2026, 2, 1), 3001, -1500, "9720", "NGI", "Pizza",
                                    name="J. de Testpersoon e/o M. Voorbeeld", counterparty="NL44FAKE0000000004")])
    upload(client, ("b.csv", asn_csv(more)))
    assert all(x["category_id"] == uit for x in tx_by_seq(client, t["merchant_key"]))
    # one-off change: only this transaction, source user
    kado = cat_id(client, "cadeaus")
    r = client.patch(f"/api/transactions/{t['id']}", json={"category_id": kado, "apply_to_merchant": False}).json()
    assert r["transaction"]["category_source"] == "user"
    assert sorted(x["category_id"] for x in tx_by_seq(client, t["merchant_key"])) == sorted([uit, kado])
    # a later merchant-wide change does not touch the user's individual choice ...
    r = client.patch(f"/api/transactions/{tx_by_seq(client, t['merchant_key'])[0]['id']}",
                     json={"category_id": cat_id(client, "vrije-tijd")}).json()
    # detail view
    d = client.get(f"/api/transactions/{t['id']}").json()
    assert d["merchant"]["count"] == 2 and "raw_description" in d and "mcc_label" in d
    # deleting the rule re-runs the engine: persons go back to unsorted
    rule_id = client.get("/api/rules").json()[0]["id"]
    assert client.delete(f"/api/rules/{rule_id}").status_code == 200
    unsorted = cat_id(client, "unsorted")
    cats = [x["category_id"] for x in tx_by_seq(client, t["merchant_key"])]
    assert kado in cats and unsorted in cats


def test_tags_notes_and_tag_always(client):
    upload(client, ("a.csv", asn_csv(sample_account())))
    tag = client.post("/api/tags", json={"name": "Verbouwing", "emoji": "🔨"}).json()
    assert client.post("/api/tags", json={"name": "verbouwing"}).status_code == 409
    jumbo = tx_by_seq(client, "jumbo")[0]
    r = client.patch(f"/api/transactions/{jumbo['id']}",
                     json={"tag_ids": [tag["id"]], "tag_always": True, "note": "  tegels  "}).json()
    assert r["transaction"]["tag_ids"] == [tag["id"]] and r["transaction"]["note"] == "tegels"
    more = Account(CHECKING, 0, [Tx(date(2026, 2, 3), 3002, -999, "7916", "BEA", "JUMBO 9 >STAD 03.02.2026 10U00 MCC:5411")])
    upload(client, ("b.csv", asn_csv(more)))
    assert all(x["tag_ids"] == [tag["id"]] for x in tx_by_seq(client, "jumbo"))
    assert client.get("/api/transactions", params={"tag_id": tag["id"]}).json()["count"] == 2
    assert client.get("/api/transactions", params={"q": "verbouwing"}).json()["count"] == 2
    assert client.get("/api/transactions", params={"q": "tegels"}).json()["count"] == 1
    assert client.patch(f"/api/tags/{tag['id']}", json={"archived": True}).json()["archived"] is True
    assert client.delete(f"/api/tags/{tag['id']}").status_code == 200
    assert tx_by_seq(client, "jumbo")[0]["tag_ids"] == []


def test_manual_transactions_and_bulk(client):
    card = client.post("/api/accounts", json={"name": "Creditcard", "type": "credit"}).json()
    assert card["match"] == ["international card services", "ics"]
    kleding = cat_id(client, "kleding")
    r = client.post("/api/transactions", json={"account_id": card["id"], "date": "2026-01-10",
                                                "amount_cents": -4999, "merchant_name": "Modezaak Test",
                                                "category_id": kleding, "note": "jas"})
    assert r.status_code == 200
    t = r.json()["transaction"]
    assert t["manual"] and t["category_source"] == "user" and t["kind"] == "normal"
    # engine fills the category when none is given
    t2 = client.post("/api/transactions", json={"account_id": card["id"], "date": "2026-01-11",
                                                 "amount_cents": -1200, "merchant_name": "Jumbo"}).json()["transaction"]
    assert t2["category_id"] == cat_id(client, "boodschappen") and t2["merchant_key"] == "jumbo"
    r = client.patch(f"/api/transactions/{t['id']}", json={"amount_cents": -5999, "date": "2026-01-12"})
    assert r.json()["transaction"]["amount_cents"] == -5999
    assert client.post("/api/transactions", json={"account_id": 999, "date": "2026-01-10",
                                                   "amount_cents": -1, "merchant_name": "x"}).status_code == 400
    assert client.post("/api/transactions", json={"account_id": card["id"], "date": "10-01-2026",
                                                   "amount_cents": -1, "merchant_name": "x"}).status_code == 400
    # bulk
    tag = client.post("/api/tags", json={"name": "Vakantie Test"}).json()
    vak = cat_id(client, "vakantie")
    r = client.post("/api/transactions/bulk", json={"ids": [t["id"], t2["id"]], "category_id": vak,
                                                    "add_tag_ids": [tag["id"]]}).json()
    assert r["updated_count"] == 2
    items = client.get("/api/transactions", params={"account_id": card["id"]}).json()["items"]
    assert all(i["category_id"] == vak and i["tag_ids"] == [tag["id"]] for i in items)
    client.post("/api/transactions/bulk", json={"ids": [t["id"]], "remove_tag_ids": [tag["id"]]})
    assert client.get(f"/api/transactions/{t['id']}").json()["tag_ids"] == []
    # delete: manual only
    assert client.delete(f"/api/transactions/{t['id']}").status_code == 200
    upload(client, ("a.csv", asn_csv(sample_account())))
    imported = client.get("/api/transactions", params={"account_id": 2}).json()["items"][0]
    assert client.delete(f"/api/transactions/{imported['id']}").status_code == 400
    assert client.patch(f"/api/transactions/{imported['id']}", json={"amount_cents": 1}).status_code == 400


def test_sort_queue_and_sort(client):
    upload(client, ("a.csv", asn_csv(sample_account())))
    queue = client.get("/api/sort/queue").json()
    assert queue["remaining"] == len(queue["items"]) >= 2
    totals = [abs(i["total_cents"]) for i in queue["items"]]
    assert totals == sorted(totals, reverse=True)
    person = next(i for i in queue["items"] if i["is_person"])
    assert 1 <= len(person["suggestions"]) <= 4
    shop = next(i for i in queue["items"] if not i["is_person"])
    assert shop["sample_description"] and shop["count"] >= 1
    r = client.post("/api/sort", json={"merchant_key": shop["merchant_key"],
                                       "category_id": cat_id(client, "winkelen")}).json()
    assert r["updated_count"] >= 1 and r["remaining"] == queue["remaining"] - 1
    # sorting to "unsorted" forgets the rule again
    r = client.post("/api/sort", json={"merchant_key": shop["merchant_key"],
                                       "category_id": cat_id(client, "unsorted")}).json()
    assert r["remaining"] == queue["remaining"]
    assert client.get("/api/rules").json() == []


def test_categories_crud(client):
    upload(client, ("a.csv", asn_csv(sample_account())))
    c = client.post("/api/categories", json={"name": "Hobby's", "emoji": "🎨", "color": "pink", "grp": "daily"}).json()
    assert c["key"].startswith("c-") and not c["builtin"]
    jumbo = tx_by_seq(client, "jumbo")[0]
    client.patch(f"/api/transactions/{jumbo['id']}", json={"category_id": c["id"]})
    assert client.patch(f"/api/categories/{c['id']}", json={"name": "Hobby", "grp": "fixed"}).json()["grp"] == "fixed"
    builtin = cat_id(client, "boodschappen")
    assert client.patch(f"/api/categories/{builtin}", json={"grp": "fixed"}).status_code == 400
    assert client.patch(f"/api/categories/{builtin}", json={"name": "Eten", "hidden": True}).json()["hidden"]
    assert client.delete(f"/api/categories/{builtin}").status_code == 400
    assert client.delete(f"/api/categories/{c['id']}").json()["moved"] == 1
    assert tx_by_seq(client, "jumbo")[0]["category_id"] == cat_id(client, "unsorted")
    assert client.get("/api/rules").json() == []


def test_accounts_values_and_transfer_reclassification(client):
    upload(client, ("a.csv", asn_csv(sample_account())))
    boot = client.get("/api/bootstrap").json()
    sugg = boot["suggestions"]["accounts"]
    assert [s["type"] for s in sugg] == ["savings"] and sugg[0]["iban"] == SAVINGS
    # one tap: create the savings account -> the transfer becomes "sparen"
    acc = client.post("/api/accounts", json={"name": "Spaarrekening", "type": "savings", "iban": SAVINGS}).json()
    t = client.get("/api/transactions", params={"q": "spaarpot"}).json()["items"][0]
    assert t["kind"] == "transfer" and t["transfer_account_id"] == acc["id"]
    assert t["category_id"] == cat_id(client, "sparen")
    assert client.get("/api/bootstrap").json()["suggestions"]["accounts"] == []
    assert client.post("/api/accounts", json={"name": "Dubbel", "type": "savings", "iban": SAVINGS}).status_code == 409
    # dismiss a suggestion via settings
    assert client.patch("/api/settings", json={"dismissed_suggestions": ["x"]}).json()["dismissed_suggestions"] == ["x"]
    # investment account with values
    inv = client.post("/api/accounts", json={"name": "Beleggen", "type": "investment", "match": ["Testbroker"]}).json()
    assert inv["match"] == ["testbroker"]
    v = client.post(f"/api/accounts/{inv['id']}/values", json={"date": "2026-01-31", "value_cents": 123400}).json()
    assert client.get(f"/api/accounts/{inv['id']}/values").json()[0]["value_cents"] == 123400
    assert client.delete(f"/api/account-values/{v['id']}").status_code == 200
    assert client.delete(f"/api/account-values/{v['id']}").status_code == 404
    patched = client.patch(f"/api/accounts/{inv['id']}", json={"name": "Fonds", "manual_balance_cents": 5}).json()
    assert patched["name"] == "Fonds" and patched["manual_balance_cents"] == 5
    # deleting an account with imported transactions needs force
    checking = next(a for a in client.get("/api/accounts").json() if a["iban"] == CHECKING)
    assert client.delete(f"/api/accounts/{checking['id']}").status_code == 409
    assert client.delete(f"/api/accounts/{checking['id']}", params={"force": 1}).status_code == 200
    assert client.get("/api/transactions").json()["count"] == 0
    # deleting the savings account turns the remaining transfers back into normal ones
    assert client.delete(f"/api/accounts/{acc['id']}").status_code == 200


def test_settings(client):
    s = client.get("/api/settings").json()
    assert s["month_start_day"] == 1 and "_password_hash" not in s
    s = client.patch("/api/settings", json={"month_start_day": 24, "household_name": " Gezin Test "}).json()
    assert s["month_start_day"] == 24 and s["household_name"] == "Gezin Test"
    assert client.patch("/api/settings", json={"month_start_day": 29}).status_code == 422
    upload(client, ("a.csv", asn_csv(sample_account())))
    assert client.get("/api/transactions", params={"period": "2026-01"}).json()["count"] == 6


def test_export_backup_restore_reclassify_delete(client, tmp_path):
    upload(client, ("a.csv", asn_csv(sample_account())))
    r = client.get("/api/export/transactions.csv")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig")), delimiter=";"))
    assert rows[0][0] == "datum" and len(rows) == 7 and "-23,45" in [x[3] for x in rows]
    backup = client.get("/api/export/backup")
    assert backup.status_code == 200 and backup.content[:15] == b"SQLite format 3"
    assert client.post("/api/reclassify").json()["ok"]
    # delete everything (wrong password first)
    assert client.request("DELETE", "/api/data", json={"password": "fout"}).status_code == 400
    assert client.request("DELETE", "/api/data", json={"password": PASSWORD}).status_code == 200
    assert client.get("/api/transactions").json()["count"] == 0
    # restore brings it back and keeps us logged in
    r = client.post("/api/restore", files={"file": ("b.db", backup.content, "application/octet-stream")})
    assert r.status_code == 200, r.text
    assert r.json()["transactions"] == 6
    assert client.get("/api/transactions").json()["count"] == 6
    bad = client.post("/api/restore", files={"file": ("x.db", b"not a database", "application/octet-stream")})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "bad_backup"
