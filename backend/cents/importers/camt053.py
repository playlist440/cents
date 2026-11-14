"""ISO 20022 CAMT.053 bank statements (any camt.053.001.xx version, any bank).

One transaction per `Ntry` (batch entries with several `TxDtls` stay one transaction).
Parsed with defusedxml (no external entities, no entity expansion).
"""

from __future__ import annotations

import re
from typing import Iterator
from xml.etree.ElementTree import Element

from defusedxml import ElementTree as SafeET
from defusedxml.common import DefusedXmlException

from . import ImportFormatError, Source, Statement, as_stream, collect, parse_seq, to_cents
from .normalize import clean_iban, collapse


def _strip_namespaces(root: Element) -> None:
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]


def _text(el: Element | None, path: str) -> str | None:
    if el is None:
        return None
    found = el.find(path)
    if found is None or found.text is None:
        return None
    text = found.text.strip()
    return text or None


def _date(el: Element | None, path: str) -> str | None:
    """`<X><Dt>2026-01-31</Dt></X>` or `<X><DtTm>2026-01-31T10:00:00</DtTm></X>`."""
    value = _text(el, f"{path}/Dt") or _text(el, f"{path}/DtTm")
    return value[:10] if value else None


def _signed(amount: str | None, indicator: str | None) -> int:
    cents = to_cents(amount or "0")
    return -cents if (indicator or "").upper() == "DBIT" else cents


def _party(details: Element, role: str) -> tuple[str | None, str | None]:
    """Name and IBAN of `Cdtr` or `Dbtr` (both camt.053.001.02 and .08 layouts)."""
    parties = details.find("RltdPties")
    if parties is None:
        return None, None
    name = _text(parties, f"{role}/Nm") or _text(parties, f"{role}/Pty/Nm") \
        or _text(parties, f"Ultmt{role}/Nm") or _text(parties, f"Ultmt{role}/Pty/Nm")
    iban = _text(parties, f"{role}Acct/Id/IBAN") or _text(parties, f"{role}Acct/Id/Othr/Id")
    return name, clean_iban(iban)


def _creditor_id(details: Element) -> str | None:
    for path in ("RltdPties/Cdtr/Id/PrvtId/Othr/Id", "RltdPties/Cdtr/Pty/Id/PrvtId/Othr/Id",
                 "CdtrSchmeId/Id/PrvtId/Othr/Id", "RltdPties/Cdtr/Id/OrgId/Othr/Id"):
        value = _text(details, path)
        if value:
            return value
    return None


def _not_provided(value: str | None) -> str | None:
    return None if value is None or value.upper() in ("NOTPROVIDED", "NOT PROVIDED") else value


def _entry(entry: Element) -> dict:
    indicator = _text(entry, "CdtDbtInd")
    # CdtDbtInd is the real direction on the account; RvslInd only marks a reversal and must
    # not flip the sign (flipping breaks the balance chain against CLBD).
    amount = _signed(_text(entry, "Amt"), indicator)

    details_list = entry.findall("NtryDtls/TxDtls")
    details = details_list[0] if details_list else None
    batch = len(details_list) > 1
    tx: dict = {
        "date": _date(entry, "BookgDt") or _date(entry, "ValDt"),
        "value_date": _date(entry, "ValDt"),
        "amount_cents": amount,
        "iso_domain": _text(entry, "BkTxCd/Domn/Cd"),
        "iso_family": _text(entry, "BkTxCd/Domn/Fmly/Cd"),
        "iso_subfamily": _text(entry, "BkTxCd/Domn/Fmly/SubFmlyCd"),
        "bank_code": _text(entry, "BkTxCd/Prtry/Cd"),
        "entry_ref": _text(entry, "NtryRef"),
        "acct_svcr_ref": _text(entry, "AcctSvcrRef"),
        "counterparty_name": None,
        "counterparty_iban": None,
        "end_to_end_id": None,
        "mandate_id": None,
        "creditor_id": None,
        "remittance": None,
        "reversal": (_text(entry, "RvslInd") or "").lower() == "true",
    }
    if details is not None and not batch:
        # The counterparty is the creditor when money goes out, the debtor when it comes in.
        role = "Cdtr" if (indicator or "").upper() == "DBIT" else "Dbtr"
        name, iban = _party(details, role)
        tx["counterparty_name"], tx["counterparty_iban"] = name, iban
        tx["end_to_end_id"] = _not_provided(_text(details, "Refs/EndToEndId"))
        tx["mandate_id"] = _text(details, "Refs/MndtId")
        tx["creditor_id"] = _creditor_id(details)
        tx["acct_svcr_ref"] = tx["acct_svcr_ref"] or _text(details, "Refs/AcctSvcrRef")
        ustrd = [u.text.strip() for u in details.findall("RmtInf/Ustrd") if u.text and u.text.strip()]
        strd = _text(details, "RmtInf/Strd/CdtrRefInf/Ref")
        tx["remittance"] = collapse(" ".join(ustrd)) or strd
        if not tx["bank_code"]:
            tx["bank_code"] = _text(details, "BkTxCd/Prtry/Cd")
    additional = _text(entry, "AddtlNtryInf")
    if details is not None and not additional:
        additional = _text(details, "AddtlTxInf")
    tx["raw_description"] = additional or tx["remittance"] or ""

    # Only the ASN form "<8 digits>-<digits>" is a trustworthy sequence number; any other bank
    # gets the content-hash key, so restarted numbering can never drop a new transaction.
    m = ASN_NTRYREF_RE.fullmatch(tx["entry_ref"] or "")
    tx["seq"] = parse_seq(m.group(1)) if m else None
    return tx


def looks_like(head: bytes) -> bool:
    text = head[:8192].decode("utf-8", errors="ignore")
    return "<" in text and ("camt.053" in text or "BkToCstmrStmt" in text)


ASN_NTRYREF_RE = re.compile(r"\d{8}-(\d{1,10})")


def _settle(st: Statement, rows: list[tuple[int, str, int | None, int, int | None]]) -> None:
    """Balances in booking order (date, sequence), anchored on the opening balance, or on the
    closing balance when the opening one does not add up. Sets `st.balance_fix` when the
    running balance in file order (already handed out) was different.
    rows: (position, date, seq, amount, balance given in file order)."""
    if not rows:
        return
    descending = rows[0][1] > rows[-1][1]
    ordered = sorted(rows, key=lambda r: (r[1], r[2] if r[2] is not None else (-r[0] if descending else r[0])))
    total = sum(r[3] for r in rows)
    opening, closing = st.opening_balance_cents, st.closing_balance_cents
    if opening is not None and (closing is None or opening + total == closing):
        balance = opening
    elif closing is not None:
        balance = closing - total
    else:
        return
    correct: dict[int, int] = {}
    for r in ordered:
        balance += r[3]
        correct[r[0]] = balance
    if any(correct[r[0]] != r[4] for r in rows):
        st.balance_fix = correct


def _local(tag: object) -> str:
    return tag.rpartition("}")[2] if isinstance(tag, str) else str(tag)


def parse(source: Source) -> list[Statement]:
    return collect(iter_entries(source))


def iter_entries(source: Source) -> Iterator[tuple[Statement, dict]]:
    """Incremental parse yielding (statement, transaction). Only "end" events are used; every
    processed `Ntry` is cleared at once, so memory stays flat for very large statements.
    `Acct` and `Bal` only occur directly under `Stmt` in CAMT.053."""
    statements: list[Statement] = []
    st: Statement | None = None
    running: int | None = None
    rows: list[tuple[int, str, int | None, int, int | None]] = []
    count = 0
    try:
        for _, el in SafeET.iterparse(as_stream(source), events=("end",)):
            tag = _local(el.tag)
            if tag == "Ntry":
                if st is None:
                    raise ImportFormatError("In dit afschrift staat geen rekeningnummer.")
                _strip_namespaces(el)
                status = (_text(el, "Sts") or _text(el, "Sts/Cd") or "BOOK").upper()
                if status in ("BOOK", "BOOKED"):
                    try:
                        tx = _entry(el)
                    except ValueError:
                        raise ImportFormatError("Een bedrag in dit afschrift kan ik niet lezen.") from None
                    if not tx["date"]:
                        raise ImportFormatError("Een boeking in dit afschrift heeft geen datum.")
                    if running is not None:
                        running += tx["amount_cents"]
                    tx["balance_after_cents"] = running
                    tx["_pos"] = len(rows)
                    rows.append((len(rows), tx["date"], tx["seq"], tx["amount_cents"], running))
                    count += 1
                    yield st, tx
                el.clear()                         # free the processed entry
            elif tag == "Acct":
                _strip_namespaces(el)
                iban = clean_iban(_text(el, "Id/IBAN") or _text(el, "Id/Othr/Id"))
                if not iban:
                    raise ImportFormatError("In dit afschrift staat geen rekeningnummer.")
                if st is not None:
                    _settle(st, rows)
                st, running, rows = Statement(iban=iban), None, []
                statements.append(st)
            elif tag == "Bal" and st is not None:
                _strip_namespaces(el)
                code = _text(el, "Tp/CdOrPrtry/Cd") or _text(el, "Tp/CdOrPrtry/Prtry")
                try:
                    amount = _signed(_text(el, "Amt"), _text(el, "CdtDbtInd"))
                except ValueError:
                    raise ImportFormatError("Een saldo in dit afschrift kan ik niet lezen.") from None
                if code in ("OPBD", "PRCD") and st.opening_balance_cents is None:
                    st.opening_balance_cents = running = amount
                elif code == "CLBD":
                    st.closing_balance_cents = amount
            elif tag == "Stmt":
                if st is not None:
                    _settle(st, rows)
                    rows = []
                el.clear()
    except DefusedXmlException:
        raise ImportFormatError("Dit XML-bestand bevat onveilige onderdelen.") from None
    except SafeET.ParseError:
        raise ImportFormatError("Dit XML-bestand is beschadigd.") from None
    if not statements:
        raise ImportFormatError("Dit XML-bestand is geen CAMT.053-afschrift.")
    if not count:
        raise ImportFormatError("Er staan geen transacties in dit bestand.")
