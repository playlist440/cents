from datetime import date

import pytest

from cents.importers import ImportFormatError, camt053
from cents.importers.detect import detect
from helpers import CHECKING, SAVINGS, Account, Tx, camt, sample_account


def test_basic_entries():
    acc = sample_account()
    xml = camt([acc]).encode()
    assert detect(xml) == "camt053"
    [st] = camt053.parse(xml)
    assert st.iban == CHECKING and st.opening_balance_cents == 150000
    txs = st.transactions
    assert len(txs) == 6
    assert txs[0]["amount_cents"] == -2345 and txs[0]["seq"] == 1001
    assert txs[0]["iso_family"] == "CCRD" and txs[0]["bank_code"] == "7916"
    assert txs[1]["counterparty_name"].endswith("via Mollie")       # Cdtr for DBIT
    assert txs[2]["counterparty_name"] == "Testbedrijf BV"           # Dbtr for CRDT
    assert txs[1]["end_to_end_id"] == "E2E-0001" and txs[0]["end_to_end_id"] is None
    assert txs[1]["raw_description"].endswith("1234567890123456")    # AddtlNtryInf
    assert "Referentie" not in (txs[1]["remittance"] or "")
    assert txs[-1]["balance_after_cents"] == st.closing_balance_cents


def test_other_namespace_versions():
    for version in ("08", "10"):
        [st] = camt053.parse(camt([sample_account()], version=version).encode())
        assert len(st.transactions) == 6


def test_multiple_statements():
    a = sample_account()
    b = Account(SAVINGS, 50000, [Tx(date(2026, 1, 6), 2001, 10000, "2724", "NGI", "Naar spaarpot",
                                    name="Test Gezin", counterparty=CHECKING)])
    sts = camt053.parse(camt([a, b]).encode())
    assert [s.iban for s in sts] == [CHECKING, SAVINGS]
    assert sts[1].transactions[0]["balance_after_cents"] == 60000


def test_reversal_indicator_does_not_flip_sign():
    """ISO 20022: CdtDbtInd is the real direction; RvslInd only marks a reversal."""
    xml = camt([sample_account()]).replace(
        "<CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>",
        "<CdtDbtInd>DBIT</CdtDbtInd><RvslInd>true</RvslInd><Sts>BOOK</Sts>", 1)
    [st] = camt053.parse(xml.encode())
    assert st.transactions[0]["amount_cents"] == -2345 and st.transactions[0]["reversal"] is True


def test_batch_entry_is_one_transaction():
    xml = camt([sample_account()])
    one = "<TxDtls><Refs><EndToEndId>A</EndToEndId></Refs><RmtInf><Ustrd>deel 1</Ustrd></RmtInf></TxDtls>"
    two = "<TxDtls><Refs><EndToEndId>B</EndToEndId></Refs><RmtInf><Ustrd>deel 2</Ustrd></RmtInf></TxDtls>"
    start = xml.index("<NtryDtls>") + len("<NtryDtls>")
    xml = xml[:start] + one + two + xml[start:]
    [st] = camt053.parse(xml.encode())
    assert len(st.transactions) == 6
    assert st.transactions[0]["counterparty_name"] is None


def test_xxe_and_entity_expansion_are_refused():
    bomb = ('<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>'
            '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>&b;'
            '</BkToCstmrStmt></Document>')
    with pytest.raises(ImportFormatError):
        camt053.parse(bomb.encode())
    xxe = ('<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>'
           '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>&x;'
           '</BkToCstmrStmt></Document>')
    with pytest.raises(ImportFormatError):
        camt053.parse(xxe.encode())


def test_not_camt():
    with pytest.raises(ImportFormatError):
        camt053.parse(b"<Document><Other/></Document>")
    with pytest.raises(ImportFormatError):
        camt053.parse(b"<Document><BkToCstmrStmt>")
