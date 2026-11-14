"""Amount-dependent bakjes, explained decisions and adjustable assumptions."""

from datetime import date

import pytest

from cents.classify.library import Library, set_library
from conftest import upload
from helpers import CHECKING, SAVINGS, Account, Tx, asn_csv, card

SMALL = {"below_cents": 1500, "category": "uit-eten"}


@pytest.fixture
def fuel_library():
    lib = Library(
        merchants=[{"key": "shell", "name": "Shell", "match": ["shell"], "category": "vervoer", "small": SMALL},
                   {"key": "jumbo", "name": "Jumbo", "match": ["jumbo"], "category": "boodschappen"}],
        mcc={"5541": {"label": "Tankstation", "category": "vervoer", "small": SMALL},
             "5542": {"label": "Onbemand tankstation", "category": "vervoer"},
             "5411": {"label": "Supermarkt", "category": "boodschappen"}},
        asn_categories={"Boodschappen": "boodschappen"})
    set_library(lib)
    return lib


def cid(client, key):
    return next(c["id"] for c in client.get("/api/categories").json() if c["key"] == key)


def pay(seq, merchant, amount, mcc, day=None):
    d = day or date(2026, 3, min(seq % 28 + 1, 28))
    return Tx(d, seq, amount, "7916", "BEA", card(merchant, "STAD", d, mcc))


def by_seq(client):
    items = client.get("/api/transactions", params={"limit": 500}).json()["items"]
    out = {}
    for t in items:
        detail = client.get(f"/api/transactions/{t['id']}").json()
        out[detail["amount_cents"], detail["merchant_key"]] = detail
    return out


def test_fuel_split_by_amount(client, fuel_library):
    acc = Account(CHECKING, 0, [
        pay(1, "SHELL 1234", -800, "5541"),          # sandwich
        pay(2, "SHELL 1234", -4500, "5541"),         # fuel
        pay(3, "SHELL 1234", -1500, "5541"),         # exactly the threshold: main bakje
        pay(4, "SHELL 1234", -700, "5542"),          # unattended pump: always fuel
        pay(5, "TANKSTATION DE HOEK", -600, "5541"),  # unknown station, MCC split
        Tx(date(2026, 3, 9), 6, 800, "7916", "BEA", card("SHELL 1234", "STAD", date(2026, 3, 9), "5541")),  # refund
    ])
    upload(client, ("a.csv", asn_csv(acc)))
    rows = by_seq(client)
    uit, vervoer = cid(client, "uit-eten"), cid(client, "vervoer")
    assert rows[-800, "shell"]["category_id"] == uit
    assert rows[-800, "shell"]["category_reason"] == "merchant:shell:small"
    assert rows[-800, "shell"]["category_reason_label"] == "Shell · klein bedrag"
    assert rows[-4500, "shell"]["category_id"] == vervoer and rows[-4500, "shell"]["category_reason"] == "merchant:shell"
    assert rows[-1500, "shell"]["category_id"] == vervoer
    assert rows[-700, "shell"]["category_id"] == vervoer
    assert rows[800, "shell"]["category_id"] == uit                      # refund follows the split
    station = rows[-600, "tankstation de hoek"]
    assert station["category_id"] == uit and station["category_reason"] == "mcc:5541:small"
    assert station["category_reason_label"] == "Soort winkel: tankstation · klein bedrag"
    # the list type is unchanged
    assert "category_reason" not in client.get("/api/transactions").json()["items"][0]


def test_assumption_setting(client, fuel_library):
    upload(client, ("a.csv", asn_csv(Account(CHECKING, 0, [pay(1, "SHELL 1", -800, "5541"),
                                                            pay(2, "SHELL 1", -1200, "5541")]))))
    s = client.get("/api/settings").json()
    assert s["assumptions"] == {"small_amount_at_fuel": {"enabled": True, "below_cents": 1500}}
    uit, vervoer = cid(client, "uit-eten"), cid(client, "vervoer")
    one = next(t for t in client.get("/api/transactions").json()["items"] if t["amount_cents"] == -800)
    client.patch(f"/api/transactions/{one['id']}", json={"category_id": cid(client, "kleding"), "apply_scope": "one"})
    s = client.patch("/api/settings", json={"assumptions": {"small_amount_at_fuel": {"below_cents": 1000}}}).json()
    assert s["assumptions"]["small_amount_at_fuel"] == {"enabled": True, "below_cents": 1000}
    cats = {t["amount_cents"]: t["category_id"] for t in client.get("/api/transactions").json()["items"]}
    assert cats[-1200] == vervoer and cats[-800] == cid(client, "kleding")      # user choice stays
    client.patch("/api/settings", json={"assumptions": {"small_amount_at_fuel": {"enabled": False}}})
    client.patch("/api/settings", json={"assumptions": {"small_amount_at_fuel": {"below_cents": 1500}}})
    cats = {t["amount_cents"]: t["category_id"] for t in client.get("/api/transactions").json()["items"]}
    assert cats[-1200] == vervoer                                               # disabled: no split
    client.patch("/api/settings", json={"assumptions": {"small_amount_at_fuel": {"enabled": True}}})
    cats = {t["amount_cents"]: t["category_id"] for t in client.get("/api/transactions").json()["items"]}
    assert cats[-1200] == uit
    for bad in ({"small_amount_at_fuel": {"below_cents": 50}}, {"small_amount_at_fuel": {"below_cents": 20000}},
                {"other": {"enabled": True}}, {"small_amount_at_fuel": {"enabled": "ja"}}):
        assert client.patch("/api/settings", json={"assumptions": bad}).status_code == 422


def test_rule_threshold_via_patch_and_rules_api(client, fuel_library):
    txs = [pay(i, "JUMBO 12", amount, "5411") for i, amount in enumerate([-400, -350, -4000, -5200, -499, -500], 1)]
    upload(client, ("a.csv", asn_csv(Account(CHECKING, 0, txs))))
    items = client.get("/api/transactions").json()["items"]
    small = next(t for t in items if t["amount_cents"] == -400)
    big = next(t for t in items if t["amount_cents"] == -5200)
    vrij, bood = cid(client, "vrije-tijd"), cid(client, "boodschappen")
    # one large payment chosen individually: never overwritten
    client.patch(f"/api/transactions/{big['id']}", json={"category_id": cid(client, "cadeaus"), "apply_to_merchant": False})
    assert client.patch(f"/api/transactions/{small['id']}",
                        json={"category_id": vrij, "apply_scope": "merchant_below"}).status_code == 400
    r = client.patch(f"/api/transactions/{small['id']}",
                     json={"category_id": vrij, "apply_scope": "merchant_below", "below_cents": 500}).json()
    assert r["transaction"]["category_id"] == vrij and r["updated_count"] == 5
    cats = {t["amount_cents"]: t["category_id"] for t in client.get("/api/transactions").json()["items"]}
    assert cats == {-400: vrij, -350: vrij, -499: vrij, -500: bood, -4000: bood, -5200: cid(client, "cadeaus")}
    detail = client.get(f"/api/transactions/{small['id']}").json()
    assert detail["category_reason"] == "rule:below" and detail["category_reason_label"] == "Jouw keuze voor Jumbo · klein bedrag"
    big4000 = next(t for t in client.get("/api/transactions").json()["items"] if t["amount_cents"] == -4000)
    assert client.get(f"/api/transactions/{big4000['id']}").json()["category_reason_label"] == "Jouw keuze voor Jumbo"
    [rule] = client.get("/api/rules").json()
    assert (rule["category_id"], rule["below_cents"], rule["below_category_id"]) == (bood, 500, vrij)
    # raise the threshold, then clear it
    rule = client.patch(f"/api/rules/{rule['id']}", json={"below_cents": 1000}).json()
    assert rule["below_cents"] == 1000
    rule = client.patch(f"/api/rules/{rule['id']}", json={"below_cents": None}).json()
    assert rule["below_cents"] is None and rule["below_category_id"] is None
    cats = {t["amount_cents"]: t["category_id"] for t in client.get("/api/transactions").json()["items"]}
    assert cats[-400] == bood and cats[-5200] == cid(client, "cadeaus")
    assert client.patch("/api/rules/99999", json={"below_cents": 100}).status_code == 404
    # the plain flows still work
    r = client.patch(f"/api/transactions/{small['id']}", json={"category_id": vrij, "apply_scope": "merchant"}).json()
    assert r["updated_count"] == 5


def test_other_reason_labels(client, fuel_library):
    acc = Account(CHECKING, 0, [
        Tx(date(2026, 3, 1), 1, -2000, "3724", "NGI", "Sparen", name="Test", counterparty=SAVINGS, category="Sparen"),
        Tx(date(2026, 3, 2), 2, -900, "9720", "NGI", "Iets", name="Winkeltje Test", counterparty="NL99FAKE0000000099",
           category="Boodschappen"),
    ])
    upload(client, ("a.csv", asn_csv(acc)))
    client.post("/api/accounts", json={"name": "Spaar", "type": "savings", "iban": SAVINGS})
    labels = {}
    for t in client.get("/api/transactions").json()["items"]:
        d = client.get(f"/api/transactions/{t['id']}").json()
        labels[d["amount_cents"]] = (d["category_reason"], d["category_reason_label"])
    assert labels[-2000] == ("transfer", "Eigen rekening")
    assert labels[-900] == ("bank:Boodschappen", "Categorie van de bank")
