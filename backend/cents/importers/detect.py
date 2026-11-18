"""Pick the parser from the file content (never from the file name)."""

from __future__ import annotations

from typing import Callable, Iterator

from . import ImportFormatError, Source, Statement, asn_csv, camt053, collect, degiro, etoro, read_head

PARSERS: dict[str, Callable[[Source], Iterator[tuple[Statement, dict]]]] = {
    "asn_csv": asn_csv.iter_rows,
    "camt053": camt053.iter_entries,
}


def detect(source: Source) -> str:
    stripped = read_head(source).lstrip(b"\xef\xbb\xbf \t\r\n")
    if etoro.looks_like(stripped):
        if etoro.is_statement(etoro.read_workbook(source)):
            return "etoro"
        raise ImportFormatError("Dit Excel-bestand herken ik niet. Van eToro kan ik het rekeningoverzicht (Account Statement) lezen.")
    if stripped.startswith(b"<"):
        if camt053.looks_like(stripped):
            return "camt053"
        raise ImportFormatError("Dit XML-bestand is geen CAMT.053-afschrift.")
    investment = degiro.looks_like(degiro.decode(stripped[:8192]))
    if investment:
        return investment
    if asn_csv.looks_like(asn_csv.decode(stripped[:8192])):
        return "asn_csv"
    raise ImportFormatError("Dit bestand herken ik niet. Kies een CSV- of CAMT.053-export van je bank.")


def iter_file(source: Source) -> tuple[str, Iterator[tuple[Statement, dict]]]:
    """Detect the format and return a lazy (statement, transaction) stream. Format errors in
    the body surface while iterating (as ImportFormatError)."""
    fmt = detect(source)
    if fmt not in PARSERS:
        raise ImportFormatError("Dit is een beleggingsbestand, geen bankafschrift.")
    return fmt, PARSERS[fmt](source)


def parse_file(source: Source) -> tuple[str, list[Statement]]:
    """Detect and parse completely (tests and tools)."""
    fmt, pairs = iter_file(source)
    return fmt, collect(pairs)
