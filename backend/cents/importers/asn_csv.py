"""ASN Bank CSV export (SPEC 5).

With header: 20 columns (incl. Categorie). Older exports: no header, 19 columns, same order.
Dates dd-mm-yyyy (possibly unpadded); amounts with a decimal point; Omschrijving/Categorie in
literal single quotes. UTF-8 (optional BOM) with cp1252 fallback.
"""

from __future__ import annotations

import codecs
import csv
import io
import itertools
import re
from datetime import date
from typing import BinaryIO, Callable, Iterator

from . import ImportFormatError, Source, Statement, as_stream, collect, parse_seq, to_cents
from .normalize import clean_iban

COLUMNS = ["datum", "je rekening", "van / naar", "naam", "adres", "postcode", "woonplaats",
           "valuta saldo", "saldo voor boeking", "valuta", "bedrag bij / af", "verwerkingsdatum",
           "valutadatum", "code", "type", "volgnummer", "betalingskenmerk", "omschrijving",
           "afschriftnummer", "categorie"]
DATE_RE = re.compile(r"^\s*(\d{1,2})-(\d{1,2})-(\d{4})\s*$")


def decode(content: bytes) -> str:
    if content.startswith(b"\xef\xbb\xbf"):
        content = content[3:]
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return content.decode("cp1252", errors="replace")


def parse_date(text: str) -> date | None:
    m = DATE_RE.match(text or "")
    if not m:
        return None
    try:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None


def _header_key(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip().strip("'\"").lower())


def _unquote(text: str | None) -> str:
    text = (text or "").strip()
    if len(text) >= 2 and text[0] == "'" and text[-1] == "'":
        text = text[1:-1]
    return text.strip()


TAIL_RE = re.compile(
    r"^(?P<ref>'.*?'(?=,)|[^,]*),(?P<desc>'.*?'(?=,\d*(?:,|$))|[^,]*),(?P<stmt>\d*)(?:,(?P<cat>.*))?$")
FIXED = 16  # columns before Betalingskenmerk never contain quotes


def split_line(line: str) -> list[str]:
    """Split one ASN line. Free-text columns are wrapped in single quotes and may contain
    commas and apostrophes, so the tail is parsed with a pattern instead of a CSV reader."""
    parts = line.split(",")
    if len(parts) <= FIXED:
        return parts
    head, tail = parts[:FIXED], ",".join(parts[FIXED:])
    m = TAIL_RE.match(tail)
    if not m:
        return next(csv.reader([line], quotechar="'"))
    out = head + [m.group("ref"), m.group("desc"), m.group("stmt")]
    if m.group("cat") is not None:
        out.append(m.group("cat"))
    return out


def looks_like(text: str) -> bool:
    """Cheap check used by detect.py."""
    first = next((line for line in text.splitlines() if line.strip()), "")
    fields = first.split(",")
    if len(fields) < 17:
        return False
    head = _unquote(fields[0]).lower()
    return head == "datum" or parse_date(fields[0]) is not None


def _encoding(stream: BinaryIO) -> str:
    """'utf-8-sig' when the whole file is valid UTF-8, else 'cp1252' (checked in chunks)."""
    decoder = codecs.getincrementaldecoder("utf-8")()
    try:
        while chunk := stream.read(1024 * 1024):
            decoder.decode(chunk)
        decoder.decode(b"", final=True)
        encoding = "utf-8-sig"
    except UnicodeDecodeError:
        encoding = "cp1252"
    stream.seek(0)
    return encoding


def _lines(source: Source) -> Iterator[str]:
    """Non-empty lines, read row by row (the file is never held in memory as a whole)."""
    stream = as_stream(source)
    encoding = _encoding(stream)
    text = io.TextIOWrapper(stream, encoding=encoding, errors="replace", newline="")
    try:
        for line in text:
            line = line.rstrip("\r\n")
            if line.strip():
                yield line
    finally:
        text.detach()          # leave the caller's stream open


def iter_rows(source: Source) -> Iterator[tuple[Statement, dict]]:
    """Yield (statement, transaction) row by row; the statement object is shared per IBAN."""
    lines = _lines(source)
    first = next(lines, None)
    if first is None:
        raise ImportFormatError("Dit bestand is leeg.")

    reader: Callable[[str], list[str]] = split_line
    if parse_date(first.split(",")[0]) is None:             # header row
        header = [_header_key(h) for h in first.split(",")]
        if "datum" not in header or "bedrag bij / af" not in header:
            raise ImportFormatError("Deze CSV herken ik niet als ASN-export.")
        index = {name: i for i, name in enumerate(header)}
        if header != COLUMNS[:len(header)]:                 # unexpected order: map by name
            reader = lambda line: next(csv.reader([line], quotechar="'"))  # noqa: E731
        rows = (reader(line) for line in lines)
    else:                                                   # old headerless export
        index = {name: i for i, name in enumerate(COLUMNS)}
        rows = (reader(line) for line in itertools.chain([first], lines))

    statements: dict[str, Statement] = {}
    for line_no, r in enumerate(rows, start=1):
        def col(name: str) -> str:
            i = index.get(name)
            return r[i].strip() if i is not None and i < len(r) else ""

        day = parse_date(col("datum"))
        iban = clean_iban(col("je rekening"))
        if day is None or not iban:
            raise ImportFormatError(f"Regel {line_no} kan ik niet lezen.")
        try:
            amount = to_cents(col("bedrag bij / af"))
            before = to_cents(col("saldo voor boeking")) if col("saldo voor boeking") else None
        except ValueError:
            raise ImportFormatError(f"Regel {line_no} heeft een onleesbaar bedrag.") from None
        value_day = parse_date(col("valutadatum"))
        tx = {
            "date": day.isoformat(),
            "value_date": value_day.isoformat() if value_day else None,
            "amount_cents": amount,
            "balance_after_cents": before + amount if before is not None else None,
            "seq": parse_seq(col("volgnummer")),
            "counterparty_name": _unquote(col("naam")) or None,
            "counterparty_iban": clean_iban(col("van / naar")),
            "raw_description": _unquote(col("omschrijving")),
            "pay_type": col("type").upper() or None,
            "bank_code": col("code") or None,
            "bank_category": _unquote(col("categorie")) or None,
            "payment_reference": _unquote(col("betalingskenmerk")) or None,
        }
        if iban not in statements:
            statements[iban] = Statement(iban=iban)
        yield statements[iban], tx

    if not statements:
        raise ImportFormatError("Er staan geen transacties in dit bestand.")


def parse(source: Source) -> list[Statement]:
    return collect(iter_rows(source))
