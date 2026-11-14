"""The classification library: brand, MCC, keyword, bank-category and bank-code data.

Loaded once from `backend/cents/data/*.json`. A missing or broken file gives an empty part,
so the app always starts. Tests build small libraries with `Library(...)` directly.
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import LIBRARY_DIR

log = logging.getLogger("cents.library")


def norm_text(text: str | None) -> str:
    """lowercase, accents removed, only [a-z0-9] and single spaces."""
    if not text:
        return ""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return text.strip()


def sign_ok(sign: str | None, amount_cents: int | None) -> bool:
    if not sign or amount_cents is None:
        return True
    return (sign == "out" and amount_cents < 0) or (sign == "in" and amount_cents > 0)


def method_ok(entry: dict, method: str | None) -> bool:
    """An optional "methods" allow-list: e.g. brokers and lenders are never paid by card."""
    allowed = entry.get("methods")
    return not allowed or method is None or method in allowed


def is_weak(entry: dict, pattern: str) -> bool:
    """"weak": true (every match string) or a list of the weak match strings. Weak = the
    brand name is also a common word or surname, so better evidence (MCC, keyword) wins."""
    weak = entry.get("weak")
    if isinstance(weak, list):
        return pattern in {norm_text(w) for w in weak}
    return bool(weak)


# first word -> [(pattern, entry, order, weak)]
Index = dict[str, list[tuple[str, dict, int, bool]]]


def _index(entries: list[dict]) -> Index:
    index: Index = {}
    for order, entry in enumerate(entries):
        for m in entry.get("match", []):
            pattern = norm_text(m)
            if pattern:
                index.setdefault(pattern.split(" ", 1)[0], []).append(
                    (pattern, entry, order, is_weak(entry, pattern)))
    return index


def _match(index: Index, text: str | None, amount_cents: int | None, method: str | None = None,
           weak: bool | None = None) -> dict | None:
    found = _match_full(index, text, amount_cents, method, weak)
    return found[0] if found else None


def _match_full(index: Index, text: str | None, amount_cents: int | None, method: str | None = None,
                weak: bool | None = None) -> tuple[dict, str] | None:
    """The best pattern occurring on word boundaries in `text`: longest first, then earliest
    position in the text, then file order (deterministic). Respects "sign" and "methods";
    `weak` True/False keeps only weak/strong matches, None keeps both."""
    norm = norm_text(text)
    if not norm or not index:
        return None
    padded = f" {norm} "
    best: tuple[tuple[int, int, int], dict, str] | None = None
    for word in dict.fromkeys(norm.split(" ")):
        for pattern, entry, order, entry_weak in index.get(word, ()):
            if weak is not None and entry_weak != weak:
                continue
            pos = padded.find(f" {pattern} ")
            if pos < 0 or not sign_ok(entry.get("sign"), amount_cents) or not method_ok(entry, method):
                continue
            rank = (-len(pattern), pos, order)
            if best is None or rank < best[0]:
                best = (rank, entry, pattern)
    return (best[1], best[2]) if best else None


TRADE_WORDS_BASE = {"slagerij", "bakkerij", "garage", "kapsalon", "kapper", "schilder",
                    "schildersbedrijf", "loodgieter", "installatie", "fysiotherapie", "tandarts",
                    "huisarts", "praktijk", "atelier", "studio", "salon", "winkel", "eetcafe",
                    "cafe", "restaurant", "snackbar", "bloemen", "bloemist", "fietsen",
                    "rijschool", "hoveniers", "hovenier", "klusbedrijf", "timmerbedrijf"}


@dataclass
class Library:
    merchants: list[dict] = field(default_factory=list)
    mcc: dict[str, dict] = field(default_factory=dict)
    keywords: list[dict] = field(default_factory=list)
    asn_categories: dict[str, Any] = field(default_factory=dict)
    bank_codes: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # patterns indexed by their first word: only patterns whose first word occurs in the
        # text are tried, so matching stays fast with thousands of patterns
        self._merchant_index = _index(self.merchants)
        self._keyword_index = _index(self.keywords)
        self._asn = {k.strip().lower(): v for k, v in self.asn_categories.items()}
        self._by_key: dict[str, list[dict]] = {}
        for entry in self.merchants:
            self._by_key.setdefault(entry.get("key") or "", []).append(entry)
        self.trade_words = frozenset(TRADE_WORDS_BASE | {
            norm_text(m) for entry in self.keywords for m in entry.get("match", [])
            if " " not in norm_text(m) and len(norm_text(m)) >= 5
            and entry.get("category") not in ("salaris", "toeslagen", "inkomen-overig", "cadeaus")})

    # -------------------------------------------------------------- lookups

    def match_merchant(self, text: str | None, amount_cents: int | None = None,
                       method: str | None = None, weak: bool | None = None) -> dict | None:
        """Brand entry whose pattern occurs on word boundaries in `text` (see `_match`)."""
        return _match(self._merchant_index, text, amount_cents, method, weak)

    def brand(self, key: str | None, amount_cents: int | None = None, method: str | None = None,
              weak: bool | None = None) -> dict | None:
        """Brand entry by key (respecting "sign" and "methods"). `weak=False` needs at least one
        strong match string in the entry (the importer only assigns brand keys for strong
        matches), `weak=True` at least one weak one."""
        for entry in self._by_key.get(key or "", []):
            flags = {is_weak(entry, norm_text(m)) for m in entry.get("match", [])}
            if weak is not None and weak not in flags:
                continue
            if sign_ok(entry.get("sign"), amount_cents) and method_ok(entry, method):
                return entry
        return None

    def mcc_category(self, mcc: str | None) -> str | None:
        entry = self.mcc.get(str(mcc)) if mcc else None
        return entry.get("category") if entry else None

    def mcc_entry(self, mcc: str | None) -> dict | None:
        return self.mcc.get(str(mcc)) if mcc else None

    def mcc_label(self, mcc: str | None) -> str | None:
        entry = self.mcc.get(str(mcc)) if mcc else None
        return entry.get("label") if entry else None

    def match_keyword(self, text: str | None, amount_cents: int | None = None,
                      method: str | None = None) -> str | None:
        found = self.match_keyword_full(text, amount_cents, method)
        return found[0] if found else None

    def match_keyword_full(self, text: str | None, amount_cents: int | None = None,
                           method: str | None = None) -> tuple[str, str] | None:
        """(category, matched word) or None."""
        found = _match_full(self._keyword_index, text, amount_cents, method)
        if not found or not found[0].get("category"):
            return None
        return found[0]["category"], found[1]

    def bank_category(self, name: str | None, amount_cents: int | None = None) -> str | None:
        """Bakje for the bank's own category. A value may be direction-specific:
        {"out": "belastingen", "in": "toeslagen"}."""
        if not name:
            return None
        value = self._asn.get(name.strip().lower())
        if isinstance(value, dict):
            if amount_cents is None:
                return None
            return value.get("out" if amount_cents < 0 else "in")
        return value

    def code_info(self, code: str | None) -> dict:
        return (self.bank_codes.get("codes") or {}).get(str(code), {}) if code else {}

    def type_info(self, pay_type: str | None) -> dict:
        return (self.bank_codes.get("types") or {}).get(str(pay_type), {}) if pay_type else {}


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log.warning("library file %s ignored: %s", path.name, exc)
        return default
    if not isinstance(data, type(default)):
        log.warning("library file %s has the wrong shape, ignored", path.name)
        return default
    return data


def load_library(directory: Path = LIBRARY_DIR) -> Library:
    return Library(
        merchants=_load_json(directory / "merchants.json", []),
        mcc=_load_json(directory / "mcc.json", {}),
        keywords=_load_json(directory / "keywords.json", []),
        asn_categories=_load_json(directory / "asn_categories.json", {}),
        bank_codes=_load_json(directory / "bank_codes.json", {}),
    )


_library: Library | None = None


def get_library() -> Library:
    """The process-wide library (loaded on first use)."""
    global _library
    if _library is None:
        _library = load_library()
    return _library


def set_library(lib: Library | None) -> None:
    """Replace the process-wide library (tests); None reloads from disk on next use."""
    global _library
    _library = lib
