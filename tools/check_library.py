#!/usr/bin/env python3
"""Validate the classification library in backend/cents/data/ (stdlib only).

Checks: JSON well-formed and of the right shape, every category is a known bakje key, the
optional fields "methods", "weak" and "small" are well-formed,
merchant keys unique and kebab-case, match strings normalised (lowercase, no accents, only
[a-z0-9] and single spaces), no match string pointing to different categories (unless the
entries have opposite `sign`), bank codes consistent with their first digit. Prints counts per
category. Exit code 1 when there are errors.

    python3 tools/check_library.py [--data DIR] [--quiet]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = ROOT / "backend" / "cents" / "data"

# SPEC 4.1; used when categories.json is missing.
SPEC_KEYS = [
    "salaris", "toeslagen", "inkomen-overig", "wonen", "energie", "verzekeringen", "telecom",
    "abonnementen", "belastingen", "opvang-school", "leningen", "boodschappen", "uit-eten",
    "vervoer", "huis-tuin", "kleding", "verzorging", "kinderen", "vrije-tijd", "vakantie",
    "cadeaus", "huisdieren", "winkelen", "contant", "overig", "sparen", "beleggen", "intern",
    "creditcard", "unsorted",
]
METHODS = {"card", "ideal", "debit", "transfer", "atm", "internal", "fee", "interest", "other"}
KEY_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def norm(text: str) -> str:
    """Same rule as the app: lowercase, accents removed, [a-z0-9] and single spaces."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def load(path: Path, rep: Report, shape: type):
    if not path.exists():
        rep.warn(f"{path.name}: missing (the app treats it as empty)")
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        rep.error(f"{path.name}: invalid JSON: {exc}")
        return None
    if not isinstance(data, shape):
        rep.error(f"{path.name}: top level must be a {shape.__name__}")
        return None
    return data


def category_keys(data_dir: Path, rep: Report) -> set[str]:
    path = data_dir / "categories.json"
    if path.exists():
        cats = load(path, rep, list)
        if cats:
            keys = {c.get("key") for c in cats if isinstance(c, dict)}
            missing = set(SPEC_KEYS) - keys
            if missing:
                rep.warn(f"categories.json lacks SPEC keys: {sorted(missing)}")
            return keys
    return set(SPEC_KEYS)


def check_match_list(where: str, matches, rep: Report) -> list[str]:
    if not isinstance(matches, list) or not matches:
        rep.error(f"{where}: 'match' must be a non-empty list")
        return []
    out = []
    for m in matches:
        if not isinstance(m, str):
            rep.error(f"{where}: match {m!r} is not a string")
            continue
        if m != norm(m) or not m:
            rep.error(f"{where}: match {m!r} is not normalised (expected {norm(m)!r})")
        elif len(m.replace(" ", "")) <= 2:
            rep.warn(f"{where}: very short match {m!r}")
        out.append(m)
    if len(set(out)) != len(out):
        rep.error(f"{where}: duplicate match strings in one entry")
    return out


def check_sign(where: str, entry: dict, rep: Report) -> str | None:
    sign = entry.get("sign")
    if sign is not None and sign not in ("in", "out"):
        rep.error(f"{where}: sign must be 'in' or 'out', not {sign!r}")
    return sign


def check_methods(where: str, entry: dict, rep: Report) -> None:
    """Optional allow-list of payment methods (e.g. brokers are never paid by card)."""
    methods = entry.get("methods")
    if methods is None:
        return
    if not isinstance(methods, list) or not methods or not set(methods) <= METHODS:
        rep.error(f"{where}: 'methods' must be a non-empty list of {sorted(METHODS)}")


def check_weak(where: str, entry: dict, rep: Report) -> None:
    """Optional "weak": true, or a list of the entry's match strings that are weak."""
    weak = entry.get("weak")
    if weak is None or weak is True:
        return
    if not isinstance(weak, list) or not weak or not set(weak) <= set(entry.get("match") or []):
        rep.error(f"{where}: 'weak' must be true or a list of this entry's match strings")


def check_small(where: str, entry: dict, cats: set[str], rep: Report) -> None:
    """Optional amount split: {"below_cents": 1500, "category": "uit-eten"}."""
    small = entry.get("small")
    if small is None:
        return
    if not isinstance(small, dict) or set(small) != {"below_cents", "category"} \
            or not isinstance(small["below_cents"], int) or not 100 <= small["below_cents"] <= 10000 \
            or small["category"] not in cats:
        rep.error(f"{where}: 'small' must be {{below_cents: 100..10000, category: <bakje>}}")


def signs_disjoint(a: str | None, b: str | None) -> bool:
    return a is not None and b is not None and a != b


def check_merchants(data, cats: set[str], rep: Report, counts: Counter) -> None:
    seen_keys: set[str] = set()
    by_match: dict[str, list[tuple[str, str, str | None]]] = defaultdict(list)
    for i, e in enumerate(data):
        where = f"merchants.json[{i}]"
        if not isinstance(e, dict):
            rep.error(f"{where}: not an object")
            continue
        key = e.get("key")
        where = f"merchants.json {key or i}"
        if not isinstance(key, str) or not KEY_RE.match(key):
            rep.error(f"{where}: key must be kebab-case")
        elif key in seen_keys:
            rep.error(f"{where}: duplicate key")
        seen_keys.add(key)
        if not isinstance(e.get("name"), str) or not e["name"].strip():
            rep.error(f"{where}: missing name")
        cat = e.get("category")
        if cat not in cats:
            rep.error(f"{where}: unknown category {cat!r}")
        extra = set(e) - {"key", "name", "match", "category", "sign", "methods", "weak", "small"}
        if extra:
            rep.error(f"{where}: unknown fields {sorted(extra)}")
        check_methods(where, e, rep)
        check_weak(where, e, rep)
        check_small(where, e, cats, rep)
        sign = check_sign(where, e, rep)
        for m in check_match_list(where, e.get("match"), rep):
            by_match[m].append((key, cat, sign))
        counts[cat] += 1
    for m, owners in by_match.items():
        for a in range(len(owners)):
            for b in range(a + 1, len(owners)):
                ka, ca, sa = owners[a]
                kb, cb, sb = owners[b]
                if signs_disjoint(sa, sb):
                    continue
                if ca != cb:
                    rep.error(f"merchants.json: {m!r} points to {ca} ({ka}) and {cb} ({kb})")
                else:
                    rep.warn(f"merchants.json: {m!r} appears in both {ka} and {kb}")


def check_mcc(data, cats: set[str], rep: Report, counts: Counter) -> None:
    for code, e in data.items():
        where = f"mcc.json {code}"
        if not re.fullmatch(r"\d{4}", code):
            rep.error(f"{where}: code must be 4 digits")
        if not isinstance(e, dict) or not isinstance(e.get("label"), str) or not e["label"]:
            rep.error(f"{where}: needs a label")
            continue
        cat = e.get("category", "missing")
        if cat is not None and cat not in cats:
            rep.error(f"{where}: unknown category {cat!r}")
        extra = set(e) - {"label", "category", "small"}
        if extra:
            rep.error(f"{where}: unknown fields {sorted(extra)}")
        check_small(where, e, cats, rep)
        counts[cat or "(null)"] += 1
    for broad in ("5300", "5310", "5311", "5331", "5399", "5999"):
        if broad in data and data[broad].get("category") is not None:
            rep.error(f"mcc.json {broad}: broad code must map to null (SPEC 6 step 5)")


def check_keywords(data, cats: set[str], rep: Report, counts: Counter) -> None:
    by_match: dict[str, list[tuple[str, str | None]]] = defaultdict(list)
    for i, e in enumerate(data):
        where = f"keywords.json[{i}]"
        if not isinstance(e, dict):
            rep.error(f"{where}: not an object")
            continue
        cat = e.get("category")
        if cat not in cats:
            rep.error(f"{where}: unknown category {cat!r}")
        sign = check_sign(where, e, rep)
        check_methods(where, e, rep)
        extra = set(e) - {"match", "category", "sign", "methods"}
        if extra:
            rep.error(f"{where}: unknown fields {sorted(extra)}")
        for m in check_match_list(f"{where} ({cat})", e.get("match"), rep):
            by_match[m].append((cat, sign))
            counts[cat] += 1
    for m, owners in by_match.items():
        for a in range(len(owners)):
            for b in range(a + 1, len(owners)):
                if signs_disjoint(owners[a][1], owners[b][1]):
                    continue
                if owners[a][0] != owners[b][0]:
                    rep.error(f"keywords.json: {m!r} points to {owners[a][0]} and {owners[b][0]}")
                else:
                    rep.warn(f"keywords.json: {m!r} listed twice")


def check_asn(data, cats: set[str], rep: Report, counts: Counter) -> None:
    for name, value in data.items():
        where = f"asn_categories.json {name!r}"
        if isinstance(value, dict):
            if set(value) != {"in", "out"}:
                rep.error(f"{where}: a direction object needs exactly 'in' and 'out'")
            for v in value.values():
                if v is not None and v not in cats:
                    rep.error(f"{where}: unknown category {v!r}")
                counts[v or "(null)"] += 1
        elif value is not None and value not in cats:
            rep.error(f"{where}: unknown category {value!r}")
        else:
            counts[value or "(null)"] += 1


def check_bank_codes(data, rep: Report, counts: Counter) -> None:
    types, codes = data.get("types"), data.get("codes")
    if not isinstance(types, dict) or not isinstance(codes, dict):
        rep.error("bank_codes.json: needs 'types' and 'codes' objects")
        return
    for t, e in types.items():
        if not re.fullmatch(r"[A-Z]{3}", t):
            rep.error(f"bank_codes.json type {t}: must be 3 capitals")
        if not isinstance(e, dict) or not e.get("label") or e.get("method") not in METHODS:
            rep.error(f"bank_codes.json type {t}: needs label and a valid method")
        else:
            counts[f"type:{e['method']}"] += 1
    for code, e in codes.items():
        where = f"bank_codes.json code {code}"
        if not re.fullmatch(r"\d{4}", code):
            rep.error(f"{where}: must be 4 digits")
            continue
        if not isinstance(e, dict) or not e.get("label") or e.get("method") not in METHODS:
            rep.error(f"{where}: needs label and a valid method")
            continue
        expected = "in" if code[0] in "0268" else "out"
        if e.get("direction") != expected:
            rep.error(f"{where}: direction should be {expected!r} (first digit rule)")
        counts[f"code:{e['method']}"] += 1


def print_counts(title: str, counts: Counter) -> None:
    total = sum(counts.values())
    print(f"\n{title}: {total}")
    for key, n in sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0]))):
        print(f"  {str(key):<22} {n}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", type=Path, default=DEFAULT_DATA, help="library folder")
    ap.add_argument("--quiet", action="store_true", help="only errors and warnings")
    args = ap.parse_args(argv)

    rep = Report()
    cats = category_keys(args.data, rep)
    sections = [
        ("merchants.json", list, lambda d, c: check_merchants(d, cats, rep, c), "Merchants per category"),
        ("mcc.json", dict, lambda d, c: check_mcc(d, cats, rep, c), "MCC codes per category"),
        ("keywords.json", list, lambda d, c: check_keywords(d, cats, rep, c), "Keywords per category"),
        ("asn_categories.json", dict, lambda d, c: check_asn(d, cats, rep, c), "ASN categories per bakje"),
        ("bank_codes.json", dict, lambda d, c: check_bank_codes(d, rep, c), "Bank types/codes per method"),
    ]
    for filename, shape, check, title in sections:
        data = load(args.data / filename, rep, shape)
        if data is None:
            continue
        counts: Counter = Counter()
        check(data, counts)
        if not args.quiet:
            print_counts(f"{title} ({filename})", counts)

    for w in rep.warnings:
        print(f"warning: {w}")
    for e in rep.errors:
        print(f"ERROR: {e}")
    print(f"\n{len(rep.errors)} error(s), {len(rep.warnings)} warning(s)")
    return 1 if rep.errors else 0


if __name__ == "__main__":
    sys.exit(main())
