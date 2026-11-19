"""Savings goals: matching, entries, saldo, advice, status, roll-over, room, suggestions."""

from __future__ import annotations

from datetime import date

from book import book, today  # noqa: F401  (fixtures)
from conftest import upload
from helpers import CHECKING, SAVINGS, Account, Tx, asn_csv


def goal_by_name(client, name):
    return next(g for g in client.get("/api/goals").json()["goals"] if g["name"] == name)


def setup_transfers(book):
    chk = book.account("Betaal", "checking", CHECKING)
    sav = book.account("Spaar", "savings", SAVINGS)
    for m in ("01", "02"):
        book.tx(chk, f"2026-{m}-01", 300000, "salaris", "Werkgever")
    book.tx(chk, "2026-01-25", -50000, "sparen", "Spaar", kind="transfer", to=sav,
            description="Spaardoel 41827 Referentie: 0f0e0d0c-1111-2222-3333-444455556666")
    book.tx(sav, "2026-01-25", 50000, "intern", "Betaal", kind="transfer", to=chk,
            description="Spaardoel 41827 Referentie: 0f0e0d0c-1111-2222-3333-444455556666")
    book.tx(chk, "2026-02-25", -50000, "sparen", "Spaar", kind="transfer", to=sav,
            description="Spaardoel 41827")
    book.tx(chk, "2026-01-26", -25000, "sparen", "Spaar", kind="transfer", to=sav, description="vakantie")
    book.tx(chk, "2026-02-26", -25000, "sparen", "Spaar", kind="transfer", to=sav, description="Zomer!")
    book.tx(chk, "2026-03-02", 30000, "sparen", "Spaar", kind="transfer", to=sav, description="vakantie")
    potje = book.tx(chk, "2026-03-03", -10000, "sparen", "Spaar", kind="transfer", to=sav,
                    description="potje Referentie: aaaa")
    later = book.tx(chk, "2026-03-04", -10000, "sparen", "Spaar", kind="transfer", to=sav,
                    description="potje Referentie: bbbb")
    # only the savings side of this one is known (no checking mirror)
    book.tx(sav, "2026-03-05", 7000, "intern", "Betaal", kind="transfer", to=chk,
            description="Spaardoel 41827", balance=1234500)
    book.commit()
    return chk, sav, potje, later


def test_matching_by_code_name_keyword_and_learned(client, book):
    chk, sav, potje, later = setup_transfers(book)
    auto = client.post("/api/goals", json={"name": "Nieuwe auto", "emoji": "🚗", "target_cents": 600000,
                                           "target_date": "2026-09-01", "code": "41827"}).json()
    assert auto["saldo_cents"] == 50000 + 50000 + 7000            # code; mirror counted once
    assert [e["kind"] for e in auto["entries"]] == ["auto"] * 3
    vak = client.post("/api/goals", json={"name": "Vakantie", "target_cents": 100000,
                                          "target_date": "2026-08-01", "repeat": "yearly",
                                          "keywords": ["Zomer"]}).json()
    assert vak["saldo_cents"] == 25000 + 25000 - 30000            # name, keyword, withdrawal
    g = client.get("/api/goals").json()
    assert [u["transaction_id"] for u in g["unassigned"]] == [later, potje]
    assert g["unassigned"][0]["amount_cents"] == 10000 and g["unassigned"][0]["description"] == "potje"

    # manual assignment through PATCH /transactions creates the entry...
    r = client.patch(f"/api/transactions/{potje}", json={"goal_id": auto["id"]})
    assert r.status_code == 200 and r.json()["transaction"]["goal_id"] == auto["id"]
    auto_now = goal_by_name(client, "Nieuwe auto")
    assert auto_now["saldo_cents"] == 117000
    assert [e["kind"] for e in auto_now["entries"] if e["transaction_id"] == potje] == ["manual"]
    # ...and is learned: the next transfer with the same description follows
    client.post("/api/goals", json={"name": "Iets anders", "target_cents": 1000})
    assert goal_by_name(client, "Nieuwe auto")["saldo_cents"] == 127000
    assert client.get("/api/goals").json()["unassigned"] == []


def test_patch_moves_and_removes_entry(client, book):
    setup_transfers(book)
    auto = client.post("/api/goals", json={"name": "Auto", "target_cents": 600000, "code": "41827"}).json()
    vak = client.post("/api/goals", json={"name": "Vakantie", "target_cents": 100000}).json()
    tx = next(t for t in client.get("/api/transactions?q=vakantie").json()["items"] if t["amount_cents"] < 0)
    assert tx["goal_id"] == vak["id"]
    client.patch(f"/api/transactions/{tx['id']}", json={"goal_id": auto["id"]})
    assert goal_by_name(client, "Vakantie")["saldo_cents"] == -30000
    assert goal_by_name(client, "Auto")["saldo_cents"] == 107000 + 25000
    client.patch(f"/api/transactions/{tx['id']}", json={"goal_id": None})
    assert goal_by_name(client, "Auto")["saldo_cents"] == 107000
    assert tx["id"] in [u["transaction_id"] for u in client.get("/api/goals").json()["unassigned"]]
    assert client.patch(f"/api/transactions/{tx['id']}", json={"goal_id": 999}).status_code == 400


def test_advice_status_room(client, book):
    setup_transfers(book)
    client.post("/api/goals", json={"name": "Nieuwe auto", "target_cents": 600000,
                                    "target_date": "2026-09-01", "code": "41827"})
    client.post("/api/goals", json={"name": "Vakantie", "target_cents": 100000,
                                    "target_date": "2026-08-01", "keywords": ["zomer"]})
    client.post("/api/goals", json={"name": "Buffer", "target_cents": 1000000})
    g = client.get("/api/goals").json()
    auto, vak, buf = g["goals"]
    # (600000 - 107000) / 6 months = 82167 -> rounded up to EUR 5
    assert auto["months_left"] == 6 and auto["monthly_advice_cents"] == 82500
    assert auto["avg_contribution_cents"] == 50000          # Jan and Feb complete, 50000 each
    assert auto["status"] == "behind" and auto["catch_up_cents"] == 82500
    assert auto["progress"] == round(107000 / 600000, 4)
    assert auto["projected_date"] == "2027-01-15"            # 493000 / 50000 -> 10 months
    # (100000 - 20000) / 5 = 16000; average 25000 >= 90 %
    assert vak["monthly_advice_cents"] == 16000 and vak["status"] == "on_track"
    assert vak["catch_up_cents"] is None
    assert buf["status"] == "no_date" and buf["monthly_advice_cents"] == 0 and buf["months_left"] is None
    assert buf["projected_date"] is None
    assert g["total_advice_cents"] == 82500 + 16000
    # room: income - fixed - daily over Jan and Feb = 300000
    room = g["room"]
    assert (room["avg_over_cents"], room["fits"], room["difference_cents"]) == (300000, True, 300000 - 98500)
    assert (room["income_cents"], room["fixed_cents"], room["investing_cents"], room["months"]) == (300000, 0, 0, 2)
    assert g["savings_balance_cents"] == 1234500
    assert g["unallocated_cents"] == 1234500 - (107000 + 20000)
    assert [s["kind"] for s in g["suggestions"]] == []        # a buffer goal exists


def test_entries_saldo_and_delete(client, book, today):
    book.account("Betaal", "checking")
    book.commit()
    goal = client.post("/api/goals", json={"name": "Fiets", "target_cents": 50000}).json()
    assert len(goal["code"]) == 5 and goal["code"][0] != "0"
    r = client.post(f"/api/goals/{goal['id']}/entries", json={"amount_cents": 12000, "note": "Verjaardag"}).json()
    assert r["entry"]["kind"] == "manual" and r["entry"]["date"] == "2026-03-15"
    assert r["goal"]["saldo_cents"] == 12000
    r = client.post(f"/api/goals/{goal['id']}/saldo", json={"saldo_cents": 20000}).json()
    assert r["entry"]["kind"] == "adjust" and r["entry"]["amount_cents"] == 8000
    assert r["goal"]["saldo_cents"] == 20000
    assert client.post(f"/api/goals/{goal['id']}/saldo", json={"saldo_cents": 20000}).json()["entry"] is None
    first = r["goal"]["entries"][-1]["id"]
    assert client.delete(f"/api/goal-entries/{first}").json() == {"ok": True}
    assert goal_by_name(client, "Fiets")["saldo_cents"] == 8000
    assert client.post(f"/api/goals/{goal['id']}/entries", json={}).status_code == 400
    assert client.delete("/api/goal-entries/9999").status_code == 404
    # codes
    assert client.post("/api/goals", json={"name": "X", "target_cents": 1, "code": goal["code"]}).status_code == 409
    assert client.post("/api/goals", json={"name": "X", "target_cents": 1, "code": "01234"}).status_code == 400
    # archive and delete
    client.patch(f"/api/goals/{goal['id']}", json={"archived": True})
    g = client.get("/api/goals").json()
    assert g["goals"] == [] and g["archived_goals"][0]["id"] == goal["id"]
    assert client.delete(f"/api/goals/{goal['id']}").json() == {"ok": True}
    assert client.get("/api/goals").json()["archived_goals"] == []


def test_yearly_goal_rolls_over(client, book, today):
    book.account("Betaal", "checking")
    book.commit()
    neg = client.post("/api/goals", json={"name": "Kerst", "target_cents": 30000,
                                          "target_date": "2025-12-20", "repeat": "yearly"}).json()
    client.post(f"/api/goals/{neg['id']}/entries", json={"amount_cents": -5000, "date": "2025-12-21"})
    pos = client.post("/api/goals", json={"name": "Vakantie", "target_cents": 100000,
                                          "target_date": "2024-08-01", "repeat": "yearly"}).json()
    client.post(f"/api/goals/{pos['id']}/entries", json={"amount_cents": 4000, "date": "2025-09-01"})
    once = client.post("/api/goals", json={"name": "Oud", "target_cents": 1000,
                                           "target_date": "2025-01-01"}).json()
    g = {x["name"]: x for x in client.get("/api/goals").json()["goals"]}
    assert g["Kerst"]["target_date"] == "2026-12-20" and g["Kerst"]["saldo_cents"] == 0
    assert g["Kerst"]["entries"][0]["kind"] == "adjust"
    assert g["Vakantie"]["target_date"] == "2026-08-01" and g["Vakantie"]["saldo_cents"] == 4000
    assert g["Oud"]["target_date"] == "2025-01-01" and g["Oud"]["months_left"] == 0
    assert g["Oud"]["status"] == "overdue"
    assert g["Oud"]["monthly_advice_cents"] == 1000 and once["id"]


def test_suggestions(client, book, today):
    chk = book.account("Betaal", "checking")
    for m in ("01", "02"):
        book.tx(chk, f"2026-{m}-01", -100000, "wonen", "Huur")
        book.tx(chk, f"2026-{m}-10", -23333, "boodschappen", "Jumbo")
    book.tx(chk, "2025-03-14", -9450, "vervoer", "ANWB")
    book.tx(chk, "2026-03-11", -9450, "vervoer", "ANWB")
    book.commit()
    s = client.get("/api/goals").json()["suggestions"]
    # the same buffer as Slimme aannames: 3 months of fixed costs (rent), not of all spending
    assert s[0]["kind"] == "buffer" and s[0]["target_cents"] == 300000
    assert s[0]["reason"] == "3 maanden vaste lasten"
    assert s[1]["kind"] == "yearly_bills" and s[1]["target_cents"] == 9450
    assert s[1]["reason"] == "€ 8 per maand"


def test_goal_matched_on_import(client, today):
    today("2026-01-31")
    client.post("/api/accounts", json={"name": "Spaar", "type": "savings", "iban": SAVINGS})
    goal = client.post("/api/goals", json={"name": "Auto", "target_cents": 100000}).json()
    acc = Account(CHECKING, 100000, [
        Tx(date(2026, 1, 6), 2001, -10000, "3724", "NGI",
           f"Spaardoel {goal['code']} Referentie: 0f0e0d0c-1111-2222-3333-444455556666",
           name="Test Gezin", counterparty=SAVINGS, category="Sparen")])
    upload(client, ("checking.csv", asn_csv(acc)))
    g = goal_by_name(client, "Auto")
    assert g["saldo_cents"] == 10000 and g["entries"][0]["kind"] == "auto"
    tx = client.get("/api/transactions").json()["items"][0]
    assert tx["goal_id"] == goal["id"] and tx["kind"] == "transfer"
