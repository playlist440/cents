"""Calculation review: each test reproduces a confirmed defect (written before the fix)."""

import os
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

from cents import db
from cents.classify.engine import Context, classify
from cents.classify.library import Library, load_library
from cents.importers import camt053, to_cents
from cents.importers.detect import parse_file
from cents.importers.normalize import is_person, normalize
from cents.services import imports
from helpers import CHECKING, Account, Tx, asn_csv, camt, card, sample_account, tiny_library

ROOT = Path(__file__).resolve().parents[1]


def run(conn, *files, lib=None):
    return imports.import_files(conn, [(f"f{i}", b.encode()) for i, b in enumerate(files)],
                                lib or tiny_library())


def key_of(conn, cid):
    return db.value(conn, "SELECT key FROM categories WHERE id = ?", (cid,))


def classify_with(conn, lib, **tx):
    base = {"account_id": 1, "amount_cents": -1000, "merchant_key": "x", "merchant_name": "",
            "description": "", "method": "card", "category_source": "none", "manual": 0}
    base.update(tx)
    ctx = Context(lib=lib, accounts=[], cat_ids=db.category_ids(conn))
    r = classify(base, ctx)
    return key_of(conn, r.category_id), r.category_source


# ---------------------------------------------------------------- 1 RvslInd keeps CdtDbtInd

def test_reversal_keeps_direction_and_balance():
    acc = sample_account()
    xml = camt([acc]).replace("<CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>",
                              "<CdtDbtInd>DBIT</CdtDbtInd><RvslInd>true</RvslInd><Sts>BOOK</Sts>", 1)
    [st] = camt053.parse(xml.encode())
    assert st.transactions[0]["amount_cents"] == -2345
    assert st.transactions[-1]["balance_after_cents"] == st.closing_balance_cents


# ---------------------------------------------------------------- 2 descending files

def test_descending_camt_balances_follow_booking_order(conn):
    acc = sample_account()
    ascending = camt053.parse(camt([acc]).encode())[0].transactions
    expected = {t["seq"]: t["balance_after_cents"] for t in ascending}
    desc = Account(acc.iban, acc.opening_cents, list(reversed(acc.txs)))
    [st] = camt053.parse(camt([desc]).encode())
    assert {t["seq"]: t["balance_after_cents"] for t in st.transactions} == expected
    run(conn, camt([desc]))
    stored = {r["seq"]: r["balance_after_cents"] for r in db.rows(conn, "SELECT seq, balance_after_cents FROM transactions")}
    assert stored == expected
    latest = db.row(conn, "SELECT balance_after_cents FROM transactions ORDER BY date DESC, seq DESC LIMIT 1")
    assert latest["balance_after_cents"] == st.closing_balance_cents


def test_wrong_opening_balance_is_overruled_by_closing(conn):
    acc = sample_account()
    xml = camt([acc]).replace("<Amt Ccy=\"EUR\">1500.00</Amt>", "<Amt Ccy=\"EUR\">1400.00</Amt>", 1)
    [st] = camt053.parse(xml.encode())
    assert st.transactions[-1]["balance_after_cents"] == st.closing_balance_cents


def test_descending_csv_is_order_independent(conn):
    acc = sample_account()
    lines = asn_csv(acc).strip().split("\n")
    desc = "\n".join([lines[0]] + list(reversed(lines[1:]))) + "\n"
    a = {t["seq"]: t["balance_after_cents"] for t in parse_file(asn_csv(acc).encode())[1][0].transactions}
    b = {t["seq"]: t["balance_after_cents"] for t in parse_file(desc.encode())[1][0].transactions}
    assert a == b


# ---------------------------------------------------------------- 3 fee / interest merchant

def test_fee_and_interest_have_one_stable_merchant(conn):
    d = date
    acc = Account(CHECKING, 0, [
        Tx(d(2026, 6, 1), 1, -195, "7241", "AFB", "Kosten ASN Betaalrekening june"),
        Tx(d(2026, 7, 1), 2, -195, "7241", "AFB", "Kosten ASN Betaalrekening july"),
        Tx(d(2026, 7, 1), 3, 120, "6607", "BIJ", "Rente over juni"),
    ])
    run(conn, camt([acc]))
    run(conn, asn_csv(Account(CHECKING, 0, [Tx(d(2026, 8, 1), 4, -195, "7241", "AFB", "Kosten augustus")])))
    rows = db.rows(conn, "SELECT method, merchant_key, merchant_name FROM transactions ORDER BY seq")
    fees = {(r["merchant_key"], r["merchant_name"]) for r in rows if r["method"] == "fee"}
    interest = {(r["merchant_key"], r["merchant_name"]) for r in rows if r["method"] == "interest"}
    assert len(fees) == 1 and list(fees)[0][1] == "Bankkosten"
    assert len(interest) == 1 and list(interest)[0][1] == "Rente"


# ---------------------------------------------------------------- 4 strict amounts

@pytest.mark.parametrize("text, cents", [("-43.90", -4390), ("1228.3", 122830), ("+5", 500), ("0.01", 1)])
def test_to_cents_accepts_point_decimals(text, cents):
    assert to_cents(text) == cents


@pytest.mark.parametrize("text", ["1,234", "1.234", "1.234,56", "12,50", "1 000.00", "abc", "", "1.2.3"])
def test_to_cents_rejects_everything_else(text):
    with pytest.raises(ValueError):
        to_cents(text)


def test_bad_amount_gives_clean_file_error(conn):
    text = asn_csv(sample_account()).replace(",-23.45,", ",-1.234,", 1)
    res = run(conn, text)
    assert res["files"][0]["ok"] is False and "bedrag" in res["files"][0]["error"]
    assert db.value(conn, "SELECT COUNT(*) FROM transactions") == 0


# ---------------------------------------------------------------- 5 NtryRef only in ASN form

def test_only_asn_style_ntryref_is_a_sequence_number(conn):
    xml = re.sub(r"<NtryRef>\d{8}-(\d+)</NtryRef>", r"<NtryRef>REF\1</NtryRef>", camt([sample_account()]))
    [st] = camt053.parse(xml.encode())
    assert all(t["seq"] is None for t in st.transactions)
    xml = re.sub(r"<NtryRef>\d{8}-(\d+)</NtryRef>", r"<NtryRef>BANK-\1</NtryRef>", camt([sample_account()]))
    assert all(t["seq"] is None for t in camt053.parse(xml.encode())[0].transactions)
    # a bank that restarts numbering: same NtryRef, different transactions
    acc = Account(CHECKING, 0, [Tx(date(2026, 1, 2), 1, -100, "9720", "NGI", "eerste")])
    acc2 = Account(CHECKING, 0, [Tx(date(2026, 1, 2), 1, -999, "9720", "NGI", "andere")])
    for a in (acc, acc2):
        run(conn, re.sub(r"<NtryRef>\d{8}-(\d+)</NtryRef>", r"<NtryRef>\1</NtryRef>", camt([a])))
    assert db.value(conn, "SELECT COUNT(*) FROM transactions") == 2


# ---------------------------------------------------------------- 6 deterministic matching

SCRIPT = """
import sys; sys.path.insert(0, {backend!r})
from cents.classify.library import Library
lib = Library(merchants=[
    {{"key": "gemeente-utrecht", "name": "Gemeente Utrecht", "match": ["gemeente utrecht"], "category": "belastingen"}},
    {{"key": "utrecht-parkeren", "name": "Utrecht Parkeren", "match": ["utrecht parkeren"], "category": "vervoer"}},
])
print(lib.match_merchant("Gemeente Utrecht Parkeren")["key"])
"""


def test_matching_is_deterministic_across_hash_seeds():
    code = SCRIPT.format(backend=str(ROOT / "backend"))
    out = set()
    for seed in ("0", "1", "2", "3", "42", "1234"):
        env = {**os.environ, "PYTHONHASHSEED": seed, "PYTHONDONTWRITEBYTECODE": "1"}
        out.add(subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True,
                               check=True).stdout.strip())
    assert out == {"gemeente-utrecht"}           # same length: earliest position wins


# ---------------------------------------------------------------- 7 method allow-lists

def test_broker_brand_not_matched_on_card(conn):
    lib = Library(merchants=[{"key": "peaks", "name": "Peaks", "match": ["peaks"], "category": "beleggen",
                              "methods": ["transfer", "ideal", "debit", "internal", "other"]}],
                  mcc={"5814": {"label": "Fastfood", "category": "uit-eten"}})
    assert classify_with(conn, lib, merchant_name="Peaks Coffee", mcc="5814")[0] == "uit-eten"
    assert classify_with(conn, lib, merchant_name="Peaks", method="debit")[0] == "beleggen"
    out = normalize({"raw_description": card("PEAKS COFFEE", "STAD", date(2026, 1, 1), "5814"),
                     "pay_type": "BEA", "amount_cents": -450}, lib)
    assert out["merchant_key"] == "peaks coffee"


def test_real_library_restricts_creditors():
    lib = load_library()
    for entry in lib.merchants:
        if entry["category"] in ("beleggen", "leningen", "wonen"):
            assert entry.get("methods") and "card" not in entry["methods"] and "atm" not in entry["methods"], entry["key"]


# ---------------------------------------------------------------- 8 weak brands

def test_weak_brand_loses_to_better_evidence(conn):
    lib = Library(merchants=[{"key": "bolt", "name": "Bolt", "match": ["bolt"], "category": "vervoer", "weak": True},
                             {"key": "tango", "name": "Tango", "match": ["tango"], "category": "vervoer", "weak": True},
                             {"key": "shell", "name": "Shell", "match": ["shell", "shell express"],
                              "category": "vervoer", "weak": ["shell"]}],
                  mcc={"5814": {"label": "Fastfood", "category": "uit-eten"}},
                  keywords=[{"match": ["pizzeria"], "category": "uit-eten"},
                            {"match": ["dansschool"], "category": "vrije-tijd"},
                            {"match": ["tuin"], "category": "huis-tuin"}])
    assert classify_with(conn, lib, merchant_name="Tango Dansschool")[0] == "vrije-tijd"
    assert classify_with(conn, lib, merchant_name="Pizzeria Bolt")[0] == "uit-eten"
    assert classify_with(conn, lib, merchant_name="Bolt Tuin")[0] == "huis-tuin"
    assert classify_with(conn, lib, merchant_name="Bolt", mcc="5814")[0] == "uit-eten"
    assert classify_with(conn, lib, merchant_name="Bolt")[0] == "vervoer"            # still wins alone
    assert classify_with(conn, lib, merchant_name="Shell Express Utrecht", mcc="5814")[0] == "vervoer"
    out = normalize({"raw_description": card("TANGO DANSSCHOOL", "STAD", date(2026, 1, 1)), "pay_type": "BEA",
                     "amount_cents": -1}, lib)
    assert out["merchant_key"] == "tango dansschool"


def test_real_library_weak_flags():
    lib = load_library()
    weak = {e["key"] for e in lib.merchants if e.get("weak")}
    for key in ("action", "normal", "picnic", "spar", "coop", "boni", "crisp", "lush", "mango", "tango",
                "bolt", "uber", "shell", "gamma", "bever", "argos", "esprit", "douglas", "condor", "hilton",
                "avis", "stater", "attens", "kika", "toto", "tidal", "ns", "bp", "ret", "q8", "omv", "nle",
                "wml", "pwn", "dsw", "cak", "bcc"):
        assert key in weak, key
    assert lib.match_merchant("Shell Express Leusden", -1, method="card")["key"] == "shell"
    assert lib.match_merchant("Shell Express Leusden", -1, method="card", weak=False) is not None


# ---------------------------------------------------------------- 9 keywords

def test_real_keywords():
    lib = load_library()
    assert lib.match_keyword("VvE contributie Zonnehof", -5000, method="transfer") == "wonen"
    assert lib.match_keyword("Huur fiets vakantie", -2500, method="card") != "wonen"
    assert lib.match_keyword("Huur april", -95000, method="transfer") == "wonen"


# ---------------------------------------------------------------- 10 Lening direction

def test_loan_payout_is_income():
    lib = load_library()
    assert lib.bank_category("Lening", -10000) == "leningen"
    assert lib.bank_category("Lening", 500000) == "inkomen-overig"


# ---------------------------------------------------------------- 11 shops with initials

def test_trade_word_is_not_a_person():
    assert is_person("P. de Vries Slagerij") is False
    assert is_person("J. Jansen Garage") is False
    assert is_person("P. de Vries") is True


# ---------------------------------------------------------------- 12 Tikkie

def tikkie(seq, text, amount=-1500):
    return Tx(date(2026, 3, seq), seq, amount, "9806", "IDE", f"Tikkie ID 00012345678{seq} {text}",
              name="Tikkie", counterparty="NL12ABNA0000000001")


def test_tikkie_is_not_one_merchant(conn, client=None):
    acc = Account(CHECKING, 0, [tikkie(1, "Pizza, Van J de Vries"), tikkie(2, "Cadeau juf"),
                                tikkie(3, "Etentje, Van A Bakker")])
    run(conn, asn_csv(acc), lib=Library(keywords=[{"match": ["pizza"], "category": "uit-eten"},
                                                  {"match": ["cadeau"], "category": "cadeaus"}]))
    rows = {r["seq"]: r for r in db.rows(conn, "SELECT t.*, c.key FROM transactions t JOIN categories c ON c.id = t.category_id")}
    assert rows[1]["merchant_key"].startswith("p:") and rows[3]["merchant_key"].startswith("p:")
    assert rows[1]["merchant_key"] != rows[3]["merchant_key"]
    assert rows[2]["merchant_key"].startswith("via:") and rows[2]["key"] == "unsorted"
    from cents.services import learning
    unsorted = db.unsorted_id(conn)
    learning.set_merchant_category(conn, rows[2]["merchant_key"], db.category_ids(conn)["cadeaus"])
    assert db.value(conn, "SELECT COUNT(*) FROM rules WHERE merchant_key LIKE 'via:%'") == 0
    queue = learning.sort_queue(conn)
    assert all(i["is_person"] for i in queue["items"] if i["merchant_key"].startswith("via:"))
    assert unsorted


# ---------------------------------------------------------------- 13 nameless payees

def test_nameless_payees_do_not_merge():
    a = normalize({"raw_description": "", "counterparty_iban": "NL11FAKE0000000011", "amount_cents": -100,
                   "bank_code": "9720", "pay_type": "NGI", "date": "2026-01-01"})
    b = normalize({"raw_description": "", "counterparty_iban": "NL22FAKE0000000022", "amount_cents": -100,
                   "bank_code": "9720", "pay_type": "NGI", "date": "2026-01-01"})
    c = normalize({"raw_description": "", "amount_cents": -100, "date": "2026-01-01"})
    d = normalize({"raw_description": "", "amount_cents": -200, "date": "2026-01-02"})
    keys = {a["merchant_key"], b["merchant_key"], c["merchant_key"], d["merchant_key"]}
    assert len(keys) == 4 and "onbekend" not in keys
