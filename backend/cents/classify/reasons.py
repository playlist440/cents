"""Short Dutch explanation of `transactions.category_reason` (shown in the transaction sheet).

Reason strings: user, rule, rule:below, transfer, merchant:<key>[:small], mcc:<code>[:small],
keyword:<word>, bank:<bank category>, heuristic:<atm|fee|interest|salary|other>, none.
"""

from __future__ import annotations

from .library import Library

SMALL = " · klein bedrag"
HEURISTICS = {"atm": "Geldopname", "fee": "Bankkosten", "interest": "Rente",
              "salary": "Lijkt op salaris", "other": "Herkend aan de betaling"}
BY_SOURCE = {"user": "user", "rule": "rule", "none": "none"}


def reason_label(reason: str | None, tx: dict, lib: Library) -> str:
    reason = reason or BY_SOURCE.get(tx.get("category_source") or "", "none")
    kind, _, rest = reason.partition(":")
    name = tx.get("merchant_name") or "deze winkel"
    if kind == "user":
        return "Door jou gekozen"
    if kind == "rule":
        return f"Jouw keuze voor {name}" + (SMALL if rest == "below" else "")
    if kind == "transfer":
        return "Eigen rekening"
    if kind == "merchant":
        key, _, small = rest.partition(":")
        brand = lib.brand(key)
        return f"{(brand or {}).get('name') or name}" + (SMALL if small else "")
    if kind == "mcc":
        code, _, small = rest.partition(":")
        label = lib.mcc_label(code)
        text = f"Soort winkel: {label.lower()}" if label else "Soort winkel"
        return text + (SMALL if small else "")
    if kind == "keyword":
        return f"Woord in omschrijving: {rest}" if rest else "Woord in omschrijving"
    if kind == "bank":
        return "Categorie van de bank"
    if kind == "heuristic":
        return HEURISTICS.get(rest, HEURISTICS["other"])
    return "Nog niet gesorteerd"
