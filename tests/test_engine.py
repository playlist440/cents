import json

from cents import db
from cents.classify import engine
from cents.classify.engine import Context, classify
from helpers import tiny_library

CHECKING, SAVINGS, INVEST, CARD = 1, 2, 3, 4


def ctx(conn, rules=None, accounts=None):
    c = Context(lib=tiny_library(), accounts=accounts if accounts is not None else [
        {"id": CHECKING, "iban": "NL11TEST0000000001", "type": "checking", "match": []},
        {"id": SAVINGS, "iban": "NL22TEST0000000002", "type": "savings", "match": []},
        {"id": INVEST, "iban": None, "type": "investment", "match": ["testbroker"]},
        {"id": CARD, "iban": None, "type": "credit", "match": ["international card services", "ics"]},
    ], cat_ids=db.category_ids(conn), rules=rules or {})
    return c


def key_of(conn, result):
    return db.value(conn, "SELECT key FROM categories WHERE id = ?", (result.category_id,))


def tx(**kw):
    base = {"account_id": CHECKING, "amount_cents": -1000, "merchant_key": "winkel", "merchant_name": "Winkel",
            "description": "", "method": "card", "category_source": "none", "category_id": None, "manual": 0}
    base.update(kw)
    return base


def test_order_first_hit_wins(conn):
    ids = db.category_ids(conn)
    c = ctx(conn, rules={"jumbo": {"category_id": ids["kleding"], "tag_id": None}})
    # user beats everything
    r = classify(tx(merchant_key="jumbo", merchant_name="Jumbo", category_source="user",
                    category_id=ids["vakantie"]), c)
    assert (key_of(conn, r), r.category_source) == ("vakantie", "user")
    # rule beats merchant
    r = classify(tx(merchant_key="jumbo", merchant_name="Jumbo"), c)
    assert (key_of(conn, r), r.category_source) == ("kleding", "rule")
    # merchant beats mcc
    r = classify(tx(merchant_key="albert-heijn", merchant_name="Albert Heijn", mcc="5812"), c)
    assert (key_of(conn, r), r.category_source) == ("boodschappen", "merchant")
    # mcc beats keyword
    r = classify(tx(mcc="5812", description="bakkerij"), c)
    assert (key_of(conn, r), r.category_source) == ("uit-eten", "mcc")
    # a broad mcc maps to nothing and falls through to keyword
    r = classify(tx(mcc="5311", merchant_name="Bakkerij Test"), c)
    assert (key_of(conn, r), r.category_source) == ("boodschappen", "keyword")
    # keyword beats bank
    r = classify(tx(description="premie", bank_category="Boodschappen"), c)
    assert (key_of(conn, r), r.category_source) == ("verzekeringen", "keyword")
    r = classify(tx(bank_category="Boodschappen"), c)
    assert (key_of(conn, r), r.category_source) == ("boodschappen", "bank")
    # bank "Overig" maps to nothing -> heuristic / unsorted
    r = classify(tx(bank_category="Overig", method="atm"), c)
    assert (key_of(conn, r), r.category_source) == ("contant", "heuristic")
    r = classify(tx(bank_category="Overig"), c)
    assert (key_of(conn, r), r.category_source) == ("unsorted", "none")


def test_sign_specific_merchants(conn):
    c = ctx(conn)
    out = classify(tx(merchant_key="belastingdienst", merchant_name="Belastingdienst", amount_cents=-500), c)
    inn = classify(tx(merchant_key="belastingdienst", merchant_name="Belastingdienst", amount_cents=500), c)
    assert key_of(conn, out) == "belastingen" and key_of(conn, inn) == "toeslagen"


def test_persons_stay_unsorted_unless_rule(conn):
    ids = db.category_ids(conn)
    person = tx(merchant_key="p:j de test", merchant_name="J. de Test", description="bakkerij",
                bank_category="Boodschappen", method="transfer")
    assert key_of(conn, classify(person, ctx(conn))) == "unsorted"
    c = ctx(conn, rules={"p:j de test": {"category_id": ids["kinderen"], "tag_id": None}})
    assert key_of(conn, classify(person, c)) == "kinderen"


def test_heuristics(conn):
    c = ctx(conn)
    assert key_of(conn, classify(tx(method="fee"), c)) == "overig"
    assert key_of(conn, classify(tx(method="interest", amount_cents=120), c)) == "inkomen-overig"
    assert key_of(conn, classify(tx(method="transfer", amount_cents=250000,
                                    description="Salaris januari"), c)) == "salaris"


def test_transfers(conn):
    c = ctx(conn)
    r = classify(tx(counterparty_iban="NL22TEST0000000002", method="internal"), c)
    assert (key_of(conn, r), r.kind, r.transfer_account_id) == ("sparen", "transfer", SAVINGS)
    # the same transfer seen from the savings side is internal, never counted twice
    r = classify(tx(account_id=SAVINGS, amount_cents=1000, counterparty_iban="NL11TEST0000000001"), c)
    assert (key_of(conn, r), r.kind, r.transfer_account_id) == ("intern", "transfer", CHECKING)
    r = classify(tx(counterparty_name="Testbroker Beleggen", description="Inleg"), c)
    assert (key_of(conn, r), r.kind, r.transfer_account_id) == ("beleggen", "transfer", INVEST)
    r = classify(tx(counterparty_name="International Card Services", method="debit"), c)
    assert (key_of(conn, r), r.kind, r.transfer_account_id) == ("creditcard", "settlement", CARD)
    # a rule for the name does not override the account number of an own account (pocket
    # money and the broker under the same name); a keyword match still follows the rule
    ids = db.category_ids(conn)
    c2 = ctx(conn, rules={"winkel": {"category_id": ids["wonen"], "tag_id": None}})
    r = classify(tx(counterparty_iban="NL22TEST0000000002"), c2)
    assert (key_of(conn, r), r.kind, r.transfer_account_id) == ("sparen", "transfer", SAVINGS)
    r = classify(tx(counterparty_iban="NL99TEST0000000009"), c2)
    assert (key_of(conn, r), r.kind) == ("wonen", "normal")
    r = classify(tx(counterparty_name="Testbroker"), c2)
    assert (key_of(conn, r), r.kind) == ("wonen", "transfer")
    # manual transactions are never transfers
    r = classify(tx(counterparty_name="ics", manual=1), c)
    assert r.kind == "normal"


def test_checking_to_checking_is_intern(conn):
    accounts = [{"id": 1, "iban": "NL11TEST0000000001", "type": "checking", "match": []},
                {"id": 5, "iban": "NL55TEST0000000005", "type": "checking", "match": []}]
    r = classify(tx(counterparty_iban="NL55TEST0000000005"), ctx(conn, accounts=accounts))
    assert key_of(conn, r) == "intern"


def test_classify_all_detects_largest_stable_salary(conn):
    acc = db.insert(conn, "accounts", {"iban": "NL11TEST0000000001", "name": "B", "type": "checking",
                                       "match": json.dumps([]), "created_at": "x"})
    unsorted = db.unsorted_id(conn)
    for i, (key, amount) in enumerate([("werkgever", 310000), ("werkgever", 312000), ("werkgever", 309000),
                                       ("klein", 6000), ("klein", 6000), ("klein", 6000)]):
        month = (i % 3) + 1
        db.insert(conn, "transactions", {
            "account_id": acc, "dedupe_key": f"k{i}", "date": f"2026-0{month}-25", "amount_cents": amount,
            "merchant_key": key, "merchant_name": key, "method": "transfer", "category_id": unsorted,
            "created_at": "x", "updated_at": "x"})
    engine.classify_all(conn, tiny_library())
    cats = {r["merchant_key"]: r["key"] for r in db.rows(
        conn, "SELECT t.merchant_key, c.key FROM transactions t JOIN categories c ON c.id = t.category_id")}
    assert cats == {"werkgever": "salaris", "klein": "unsorted"}


def test_direction_specific_bank_category_and_empty_library(conn):
    from cents.classify.library import Library
    lib = Library(asn_categories={"Belastingen & Toeslagen": {"out": "belastingen", "in": "toeslagen"}})
    c = ctx(conn)
    c.lib = lib
    assert key_of(conn, classify(tx(bank_category="Belastingen & Toeslagen", amount_cents=-1), c)) == "belastingen"
    assert key_of(conn, classify(tx(bank_category="Belastingen & Toeslagen", amount_cents=1), c)) == "toeslagen"
    c.lib = Library()
    r = classify(tx(merchant_key="jumbo", merchant_name="Jumbo", mcc="5411"), c)
    assert key_of(conn, r) == "unsorted"


def test_missing_library_files(tmp_path):
    from cents.classify.library import load_library
    (tmp_path / "mcc.json").write_text("{broken")
    lib = load_library(tmp_path)
    assert lib.merchants == [] and lib.mcc == {} and lib.match_merchant("jumbo") is None
