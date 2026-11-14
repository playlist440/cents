from datetime import date

import pytest

from cents.importers import ImportFormatError, asn_csv
from cents.importers.detect import detect, parse_file
from helpers import CHECKING, Account, Tx, asn_csv as make_csv, sample_account


def test_header_csv():
    sts = asn_csv.parse(make_csv(sample_account()).encode())
    assert len(sts) == 1 and sts[0].iban == CHECKING
    txs = sts[0].transactions
    assert len(txs) == 6
    first = txs[0]
    assert first["date"] == "2026-01-02" and first["amount_cents"] == -2345
    assert first["balance_after_cents"] == 150000 - 2345
    assert first["seq"] == 1001 and first["bank_code"] == "7916" and first["pay_type"] == "BEA"
    assert first["bank_category"] == "Boodschappen"
    assert not first["raw_description"].startswith("'")
    assert txs[1]["counterparty_iban"] and txs[1]["counterparty_name"].endswith("via Mollie")
    # running balance is consistent
    assert txs[-1]["balance_after_cents"] == 150000 + sum(t["amount_cents"] for t in txs)


def test_headerless_19_columns_and_unpadded_dates():
    text = make_csv(sample_account(), header=False, pad=False, categories=False)
    assert text.splitlines()[0].startswith("2-1-2026,")
    assert len(text.splitlines()[0].split(",")) >= 19
    assert detect(text.encode()) == "asn_csv"
    sts = asn_csv.parse(text.encode())
    txs = sts[0].transactions
    assert len(txs) == 6 and txs[0]["date"] == "2026-01-02"
    assert txs[0]["bank_category"] is None and txs[0]["seq"] == 1001


def test_bom_and_cp1252():
    acc = Account(CHECKING, 0, [Tx(date(2026, 2, 1), 7, -500, "9720", "NGI", "Café één", name="Crème BV")])
    bom = b"\xef\xbb\xbf" + make_csv(acc).encode("utf-8")
    assert asn_csv.parse(bom)[0].transactions[0]["raw_description"] == "Café één"
    cp = make_csv(acc).encode("cp1252")
    tx = asn_csv.parse(cp)[0].transactions[0]
    assert tx["raw_description"] == "Café één" and tx["counterparty_name"] == "Crème BV"


def test_single_quotes_commas_and_apostrophes_in_description():
    acc = Account(CHECKING, 0, [
        Tx(date(2026, 2, 1), 1, -500, "9720", "NGI", "Huur, maart en april"),
        Tx(date(2026, 2, 2), 2, -600, "7916", "BEA", "CAFE 'T HOEKJE  >ERGENS 02.02.2026 12U30 KV002 T1 MCC:5812"),
    ])
    txs = asn_csv.parse(make_csv(acc).encode())[0].transactions
    assert txs[0]["raw_description"] == "Huur, maart en april"
    assert txs[0]["bank_category"] == "Overig"
    assert txs[1]["raw_description"].startswith("CAFE 'T HOEKJE")
    assert txs[1]["amount_cents"] == -600


def test_eight_digit_sequence_numbers_are_ints():
    acc = Account(CHECKING, 0, [Tx(date(2026, 2, 1), 12345678, -1, "9720", "NGI", "x")])
    assert asn_csv.parse(make_csv(acc).encode())[0].transactions[0]["seq"] == 12345678


def test_multiple_accounts_in_one_csv():
    a = make_csv(sample_account())
    b = make_csv(Account("NL99TEST0000000099", 0, [Tx(date(2026, 1, 9), 5, 100, "8809", "OVS", "x")]), header=False)
    sts = asn_csv.parse((a + b).encode())
    assert sorted(len(s.transactions) for s in sts) == [1, 6]


def test_garbage_is_rejected():
    with pytest.raises(ImportFormatError):
        parse_file(b"hello,world\n1,2\n")
    with pytest.raises(ImportFormatError):
        parse_file(b"")
    with pytest.raises(ImportFormatError):
        parse_file(b"<html><body>no</body></html>")


def test_parse_file_returns_statements():
    fmt, sts = parse_file(make_csv(sample_account()).encode())
    assert fmt == "asn_csv" and len(sts[0].transactions) == 6
