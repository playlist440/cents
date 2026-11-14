"""Bank file parsers. Each parser returns a list of `Statement`s with raw transaction dicts."""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import BinaryIO, Iterator, Union


class ImportFormatError(Exception):
    """The file is not in a format we understand. The message is Dutch and user-facing."""


@dataclass
class Statement:
    iban: str
    transactions: list[dict] = field(default_factory=list)
    opening_balance_cents: int | None = None
    closing_balance_cents: int | None = None
    # position in file -> corrected balance, set at the end of a statement when the running
    # balance in file order was wrong (descending file, wrong opening balance)
    balance_fix: dict[int, int] | None = None


AMOUNT_RE = re.compile(r"[+-]?\d+(?:\.\d{1,2})?")


def to_cents(text: str) -> int:
    """'-43.90' -> -4390. Bank files (ASN CSV, CAMT) always use a decimal point with at most
    two decimals and no thousands separator; anything else ('1,234', '1.234', '12,50') is
    refused rather than guessed, so a wrong amount is never stored."""
    s = (text or "").strip()
    if not AMOUNT_RE.fullmatch(s):
        raise ValueError(f"bad amount {text!r}")
    return int((Decimal(s) * 100).to_integral_value())


def parse_seq(text: str | None) -> int | None:
    digits = re.sub(r"\D", "", text or "")
    return int(digits) if digits else None


Source = Union[bytes, BinaryIO]


def as_stream(source: "Source") -> BinaryIO:
    """A binary stream positioned at the start (bytes are wrapped, files are rewound)."""
    if isinstance(source, (bytes, bytearray)):
        return io.BytesIO(source)
    source.seek(0)
    return source


def read_head(source: "Source", size: int = 8192) -> bytes:
    stream = as_stream(source)
    head = stream.read(size)
    stream.seek(0)
    return head


def collect(pairs: Iterator[tuple[Statement, dict]]) -> list[Statement]:
    """Materialise a parser's (statement, transaction) stream into Statements (tests, tools)."""
    out: list[Statement] = []
    seen: set[int] = set()
    for st, tx in pairs:
        if id(st) not in seen:
            seen.add(id(st))
            out.append(st)
        st.transactions.append(tx)
    for st in out:
        if st.balance_fix:
            for pos, tx in enumerate(st.transactions):
                if pos in st.balance_fix:
                    tx["balance_after_cents"] = st.balance_fix[pos]
    return out
