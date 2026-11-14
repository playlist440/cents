import re
from datetime import date

from cents import db
from cents.services import imports
from helpers import (CHECKING, SAVINGS, Account, Tx, asn_csv, camt, sample_account,
                     tiny_library)


def keys(conn):
    return sorted(r["dedupe_key"] for r in db.rows(conn, "SELECT dedupe_key FROM transactions"))


def run(conn, *files):
    return imports.import_files(conn, [(f"f{i}", body.encode()) for i, body in enumerate(files)], tiny_library())


def test_csv_then_camt_enriches(conn):
    acc = sample_account()
    first = run(conn, asn_csv(acc))
    assert first["totals"] == {"new": 6, "duplicates": 0, "enriched": 0}
    k1 = keys(conn)
    second = run(conn, camt([acc]))
    assert second["totals"] == {"new": 0, "duplicates": 6, "enriched": 6}
    assert keys(conn) == k1
    row = db.row(conn, "SELECT * FROM transactions WHERE seq = 1002")
    assert row["iso_family"] == "ICDT" and row["end_to_end_id"] == "E2E-0001"
    assert row["pay_type"] == "IDE" and row["bank_category"] == "Winkelen"
    # importing the same file again changes nothing
    again = run(conn, camt([acc]))
    assert again["totals"] == {"new": 0, "duplicates": 6, "enriched": 0}


def test_camt_then_csv_enriches(conn):
    acc = sample_account()
    run(conn, camt([acc]))
    k1 = keys(conn)
    second = run(conn, asn_csv(acc))
    assert second["totals"] == {"new": 0, "duplicates": 6, "enriched": 6}
    assert keys(conn) == k1
    row = db.row(conn, "SELECT * FROM transactions WHERE seq = 1001")
    assert row["bank_category"] == "Boodschappen" and row["pay_type"] == "BEA"


def test_dedupe_without_sequence_number_uses_hash(conn):
    xml = re.sub(r"<NtryRef>.*?</NtryRef>", "", camt([sample_account()]))
    for _ in range(2):
        res = imports.import_files(conn, [("a.xml", xml.encode())], tiny_library())
    assert res["totals"]["duplicates"] == 6 and res["totals"]["new"] == 0
    assert len(keys(conn)) == 6 and all(k.startswith("h:") for k in keys(conn))


def test_accounts_created_and_typed(conn):
    acc = sample_account()
    res = run(conn, asn_csv(acc))
    f = res["files"][0]
    assert f["is_new_account"] and f["account_name"] == "Betaalrekening"
    savings = Account(SAVINGS, 0, [Tx(date(2026, 1, 6), 2001, 10000, "2724", "NGI", "Naar spaarpot",
                                      name="Test Gezin", counterparty=CHECKING)])
    res = run(conn, camt([savings]))
    f = res["files"][0]
    assert f["is_new_account"] and f["account_name"] == "Spaarrekening"
    accounts = {a["iban"]: a["type"] for a in db.rows(conn, "SELECT iban, type FROM accounts")}
    assert accounts == {CHECKING: "checking", SAVINGS: "savings"}
    # the checking -> savings transfer is now a transfer in bakje sparen
    row = db.row(conn, "SELECT t.kind, c.key FROM transactions t JOIN categories c ON c.id = t.category_id "
                       "WHERE t.seq = 1004")
    assert row == {"kind": "transfer", "key": "sparen"}
    row = db.row(conn, "SELECT t.kind, c.key FROM transactions t JOIN categories c ON c.id = t.category_id "
                       "WHERE t.seq = 2001")
    assert row == {"kind": "transfer", "key": "intern"}


def test_savings_first_in_one_batch(conn):
    savings = Account(SAVINGS, 0, [Tx(date(2026, 1, 6), 2001, 10000, "2724", "NGI", "Naar spaarpot",
                                      name="Test Gezin", counterparty=CHECKING)])
    run(conn, camt([savings]), asn_csv(sample_account()))
    accounts = {a["iban"]: (a["type"], a["name"]) for a in db.rows(conn, "SELECT iban, type, name FROM accounts")}
    assert accounts == {CHECKING: ("checking", "Betaalrekening"), SAVINGS: ("savings", "Spaarrekening")}


def test_second_checking_gets_suffix(conn):
    run(conn, asn_csv(sample_account()))
    other = Account("NL88TEST0000004321", 0, [Tx(date(2026, 1, 9), 5, -100, "7916", "BEA", "x >y 09.01.2026")])
    res = run(conn, asn_csv(other))
    assert res["files"][0]["account_name"] == "Betaalrekening 4321"


def test_classification_after_import(conn):
    run(conn, asn_csv(sample_account()))
    cats = {r["seq"]: (r["key"], r["category_source"], r["merchant_key"]) for r in db.rows(conn, """
        SELECT t.seq, c.key, t.category_source, t.merchant_key FROM transactions t
        JOIN categories c ON c.id = t.category_id""")}
    assert cats[1001] == ("boodschappen", "merchant", "jumbo")
    assert cats[1003][0] == "salaris"
    assert cats[1005][0] == "verzekeringen"
    assert cats[1006][0] == "unsorted" and cats[1006][2].startswith("p:")


def test_delete_import(conn):
    res = run(conn, asn_csv(sample_account()))
    import_id = res["files"][0]["import_id"]
    assert imports.delete_import(conn, import_id) == 6
    assert db.value(conn, "SELECT COUNT(*) FROM transactions") == 0
    assert imports.delete_import(conn, import_id) is None


# ---------------------------------------------------------------- order-independent account typing

import pytest  # noqa: E402

from helpers import card  # noqa: E402


def household(months: int = 4) -> tuple[Account, Account]:
    """A checking account with card payments and a monthly transfer to savings, and the
    savings account with those deposits, interest and one withdrawal."""
    checking, savings = Account(CHECKING, 100000), Account(SAVINGS, 500000)
    seq_c, seq_s = 5000, 9000
    for m in range(1, months + 1):
        for day in (3, 12, 21):
            seq_c += 1
            checking.txs.append(Tx(date(2026, m, day), seq_c, -2000 - day, "7916", "BEA",
                                   card("JUMBO 12", "STAD", date(2026, m, day)), category="Boodschappen"))
        seq_c += 1
        seq_s += 1
        desc = f"Sparen maand {m} Referentie: 00000000-0000-0000-0000-00000000000{m}"
        checking.txs.append(Tx(date(2026, m, 25), seq_c, -20000, "3724", "NGI", desc,
                               name="Test Gezin", counterparty=SAVINGS, category="Sparen"))
        savings.txs.append(Tx(date(2026, m, 25), seq_s, 20000, "2724", "NGI", desc,
                              name="Test Gezin", counterparty=CHECKING, category="Sparen"))
    seq_c += 1
    seq_s += 1
    savings.txs.append(Tx(date(2026, months, 27), seq_s, -5000, "3724", "NGI", "Terug naar betaal",
                          name="Test Gezin", counterparty=CHECKING, category="Sparen"))
    checking.txs.append(Tx(date(2026, months, 27), seq_c, 5000, "2724", "NGI", "Terug naar betaal",
                           name="Test Gezin", counterparty=SAVINGS, category="Sparen"))
    seq_s += 1
    savings.txs.append(Tx(date(2026, months, 28), seq_s, 312, "6607", "BIJ", "Rente", category="Rente"))
    return checking, savings


def state(conn):
    accounts = {a["iban"]: (a["type"], a["name"]) for a in db.rows(conn, "SELECT iban, type, name FROM accounts")}
    cats = {}
    for r in db.rows(conn, "SELECT c.key, COUNT(*) n FROM transactions t JOIN categories c ON c.id = t.category_id "
                           "GROUP BY c.key"):
        cats[r["key"]] = r["n"]
    return accounts, cats


def split(acc: Account, chunks: int) -> list[Account]:
    size = -(-len(acc.txs) // chunks)
    return [Account(acc.iban, 0, acc.txs[i:i + size]) for i in range(0, len(acc.txs), size)]


@pytest.mark.parametrize("fmt", ["csv", "camt"])
@pytest.mark.parametrize("order", ["savings_first", "checking_first", "one_request", "interleaved"])
def test_account_types_do_not_depend_on_order(conn, fmt, order):
    checking, savings = household()
    render = (lambda a: asn_csv(a)) if fmt == "csv" else (lambda a: camt([a]))
    c_files = [render(a) for a in split(checking, 3)]
    s_files = [render(a) for a in split(savings, 3)]
    if order == "savings_first":
        for f in s_files + c_files:
            run(conn, f)
    elif order == "checking_first":
        for f in c_files + s_files:
            run(conn, f)
    elif order == "one_request":
        run(conn, *(s_files + c_files))
    else:
        for pair in zip(s_files, c_files):
            for f in pair:
                run(conn, f)
    accounts, cats = state(conn)
    assert accounts == {CHECKING: ("checking", "Betaalrekening"), SAVINGS: ("savings", "Spaarrekening")}
    # 4 deposits + 1 withdrawal on the checking side are "sparen"; the savings side is "intern"
    assert cats["sparen"] == 5 and cats["intern"] == 5


def test_lone_savings_account_starts_as_savings(conn):
    _, savings = household()
    run(conn, asn_csv(savings))
    assert state(conn)[0] == {SAVINGS: ("savings", "Spaarrekening")}


def test_user_choices_are_never_overridden(conn):
    checking, savings = household()
    run(conn, asn_csv(savings))
    sid = db.value(conn, "SELECT id FROM accounts WHERE iban = ?", (SAVINGS,))
    db.update(conn, "accounts", sid, {"type": "checking", "type_source": "user",
                                      "name": "Onze pot", "name_source": "user"})
    run(conn, asn_csv(checking))
    accounts, _ = state(conn)
    assert accounts[SAVINGS] == ("checking", "Onze pot")
    # two checking accounts now: the automatic one gets the IBAN suffix, the user's name stays
    assert accounts[CHECKING] == ("checking", "Betaalrekening 0001")


# ---------------------------------------------------------------- duplicate safety

def no_seq(acc: Account) -> Account:
    return Account(acc.iban, acc.opening_cents, [Tx(**{**t.__dict__, "seq": None}) for t in acc.txs])


@pytest.mark.parametrize("fmt", ["csv", "camt"])
def test_identical_rows_without_sequence_number(conn, fmt):
    render = (lambda a: asn_csv(a)) if fmt == "csv" else (lambda a: camt([a]))
    d = date(2026, 3, 4)
    same = Tx(d, None, -350, "7916", "BEA", card("KOFFIEBAR", "STAD", d))
    later = [Tx(date(2026, 3, 5 + i), None, -100 - i, "7916", "BEA", card("BAKKER", "STAD", date(2026, 3, 5 + i)))
             for i in range(3)]
    first = Account(CHECKING, 0, [same, same])
    assert run(conn, render(first))["totals"]["new"] == 2
    assert run(conn, render(first))["totals"] == {"new": 0, "duplicates": 2, "enriched": 0}
    overlap = Account(CHECKING, 0, [same] + later)
    assert run(conn, render(overlap))["totals"]["new"] == 3
    assert db.value(conn, "SELECT COUNT(*) FROM transactions") == 5
    assert all(k.startswith("h:") for k in keys(conn))


def test_idempotence_matrix(conn):
    checking, savings = household(months=6)
    total = len(checking.txs) + len(savings.txs)
    monthly_csv = [asn_csv(a) for a in split(checking, 6)]
    quarterly_camt = [camt([a]) for a in split(checking, 2)]
    for f in monthly_csv:
        run(conn, f)
    assert sum(run(conn, f)["totals"]["new"] for f in quarterly_camt) == 0      # other split + format
    assert run(conn, asn_csv(checking))["totals"]["new"] == 0                   # one big file again
    overlapping = Account(CHECKING, 0, checking.txs[5:20])
    assert run(conn, camt([overlapping]))["totals"]["new"] == 0
    assert run(conn, camt([savings]), asn_csv(savings))["totals"]["new"] == len(savings.txs)
    assert run(conn, camt([savings, checking]))["totals"]["new"] == 0           # two accounts, one file
    assert db.value(conn, "SELECT COUNT(*) FROM transactions") == total
    assert state(conn)[0][SAVINGS][0] == "savings"


def test_interrupted_import_leaves_nothing(conn, monkeypatch):
    calls = {"n": 0}
    real = imports.normalize

    def flaky(tx, *a, **kw):
        calls["n"] += 1
        if calls["n"] == 4:
            raise RuntimeError("disk on fire")
        return real(tx, *a, **kw)

    monkeypatch.setattr(imports, "normalize", flaky)
    checking, savings = household()
    res = run(conn, asn_csv(checking), asn_csv(savings))
    assert [f["ok"] for f in res["files"]] == [False, True]
    assert res["files"][0]["error"] and res["files"][0]["new"] == 0
    assert db.value(conn, "SELECT COUNT(*) FROM imports") == 1
    assert db.value(conn, "SELECT COUNT(*) FROM transactions") == len(savings.txs)
    assert db.value(conn, "SELECT COUNT(*) FROM accounts") == 1
    monkeypatch.setattr(imports, "normalize", real)
    assert run(conn, asn_csv(checking))["totals"]["new"] == len(checking.txs)


def test_response_has_no_rows(conn):
    checking, _ = household(months=6)
    res = run(conn, asn_csv(checking))
    assert len(str(res)) < 2000
