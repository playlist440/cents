"""Turn a parsed bank row into clean fields: method, merchant name/key, city, MCC, wallet,
mandate, creditor id and a readable description (SPEC 5.1).

Pure functions; the library is passed in (None = empty library).
"""

from __future__ import annotations

import hashlib
import re

from ..classify.library import TRADE_WORDS_BASE, Library, norm_text

# ---------------------------------------------------------------- bank code knowledge (ASN)

OWN_ACCOUNT_CODES = {"2724", "2754", "2758", "2795", "2025", "3724", "3754", "3758",
                     "3700", "3701", "2700", "2701", "3050", "2050"}
ATM_CODES = {"7900", "9900", "7910", "9910", "7901", "9901", "7911", "9911", "7902", "9902",
             "7912", "9912", "7017", "6017", "1003", "7008", "1002",
             "6900", "8900", "6901", "8901", "6902", "8902", "6910", "8910", "6911", "8911",
             "6912", "8912"}
INTEREST_CODES = {"6600", "6602", "6607", "7600", "7602", "7606"}
FEE_CODES = {"7225", "7227", "7228", "7236", "7240", "7241", "7260", "7263", "7264",
             "7921", "9921", "7922", "9922"}
DEBIT_TYPES = {"EIC", "IIC", "INC"}
TRANSFER_TYPES = {"NGI", "NGM", "OVS", "IOI", "IOM", "IOS", "ITP", "TPP", "POV", "ACC", "AGI",
                  "AGM", "PCQ", "BVZ", "RTI"}


def is_card_code(code: str | None) -> bool:
    if not code or not code.isdigit() or len(code) != 4:
        return False
    n = int(code[2:])
    return code[:2] in ("79", "99", "69", "89") and 0 <= n <= 28 and code not in ATM_CODES


# ---------------------------------------------------------------- text patterns

CARD_RE = re.compile(
    r"^(?P<merchant>[^>]*?)\s*>\s*(?P<city>[^>]*?)[\s.]*(?P<d>\d{2})\.(?P<m>\d{2})\.(?P<y>\d{4})")
MCC_RE = re.compile(r"\bMCC:?\s*(\d{4})\b", re.I)
WALLET_RE = re.compile(r"\b(apple|google|garmin|fitbit|samsung|swatch)\s?pay\b", re.I)
REFERENCE_TAIL_RE = re.compile(r"\s*\bReferentie:.*$", re.I)
IDEAL_RE = re.compile(r"\bideal\b|Referentie:\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}", re.I)
DIRECT_DEBIT_RE = re.compile(
    r"Europese incasso:\s*(?P<text>.*?)\s*-?\s*Incassant ID:\s*(?P<cid>[A-Za-z0-9]+)"
    r"(?:\s*-?\s*Kenmerk Machtiging:\s*(?P<mid>\S+))?", re.I)
IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b")
REF_TOKEN_RE = re.compile(r"^(?=.*\d)[A-Za-z0-9/\-_.:]{8,}$")  # long tokens holding digits

TERMINAL_PREFIX_RE = re.compile(r"^\s*(?:zettle_|sumup\s?|[A-Za-z.]{2,8}\s?)\*\s*", re.I)
WRAPPER_RE = re.compile(r"\s+(?:via|by)\s+\S.*$", re.I)
LEGAL_FORMS = {"bv", "nv", "vof", "gmbh", "ltd", "inc", "llc", "bvba", "sarl", "plc", "cv"}
COUNTRY_SUFFIXES = {"nl", "nld", "nederland", "netherlands", "nlnederland"}
SMALL_WORDS = {"van", "de", "der", "den", "het", "en", "op", "aan", "in", "voor", "bij", "t"}

PSP_NAMES = ("mollie", "adyen", "buckaroo", "stripe", "multisafepay", "pay nl", "paypal",
             "online betaalplatform", "ccv", "ingenico", "worldline", "cm payments", "icepay",
             "payvision", "sisow", "targetpay", "ems payment", "global collect", "klarna")

INTERMEDIARY_RE = re.compile(r"\b(tikkie|betaalverzoek)\b", re.I)
REQUESTER_RE = re.compile(r",\s*Van\s+([A-Z][\w'.\- ]{1,60}?)\s*(?:,|$|\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b)")

PERSON_PREFIX_RE = re.compile(r"^(dhr|hr|mw|mevr|mevrouw|meneer|de heer|fam|familie)\b\.?\s", re.I)
INITIALS_RE = re.compile(r"^(?:[A-Z]\.\s?){1,4}\s*[A-Za-z]")
TRAILING_INITIALS_RE = re.compile(r"\s(?:(?:[A-Z]\.){1,3}|[A-Z])$")
PARTNER_RE = re.compile(r"(?:\s|^)(?:e/o|eo|en/of|c\.s\.)(?:\s|$)", re.I)
COMPANY_WORDS = {
    "bv", "nv", "vof", "cv", "stichting", "vereniging", "gemeente", "belastingdienst", "bank",
    "holding", "groep", "group", "services", "service", "verzekering", "verzekeringen", "zorg",
    "school", "kinderopvang", "shop", "store", "webshop", "payments", "international", "nederland",
    "netherlands", "bedrijf", "fonds", "coop", "cooperatie", "ua", "ltd", "gmbh", "inc", "kerk",
    "club", "sportclub", "praktijk", "apotheek", "garage", "energie", "water", "waterschap",
    "provincie", "ministerie", "rijksoverheid", "cjib", "duo", "svb", "uwv", "hypotheek",
    "makelaar", "beheer", "management", "media", "online", "europe", "benelux", "retail",
}


def collapse(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def clean_iban(iban: str | None) -> str | None:
    if not iban:
        return None
    iban = re.sub(r"\s+", "", iban).upper()
    return iban or None


# ---------------------------------------------------------------- merchant names

def is_psp(name: str | None) -> bool:
    n = norm_text(name)
    if not n:
        return False
    stripped = re.sub(r"\b(stichting|derdengelden|payments?|b v|bv|nv|europe|s a r l|et cie|s c a)\b",
                      " ", n)
    stripped = collapse(stripped)
    return any(stripped == p or stripped.startswith(p + " ") for p in PSP_NAMES)


def clean_merchant(name: str | None) -> str:
    """Strip quotes, terminal prefixes, payment-provider wrappers, legal forms, branch numbers
    and country suffixes."""
    original = collapse(name)
    text = original.strip("'\"` ")
    text = TERMINAL_PREFIX_RE.sub("", text)
    text = WRAPPER_RE.sub("", text)
    tokens = text.split(" ")
    # legal forms anywhere but the first token
    tokens = [t for i, t in enumerate(tokens)
              if i == 0 or re.sub(r"[.,]", "", t).lower() not in LEGAL_FORMS]
    # trailing branch numbers and country suffixes
    while len(tokens) > 1:
        last = tokens[-1].lower().strip(",.-")
        if re.fullmatch(r"#?\d[\d\-/]*", last) or last in ("nr", "no") or last in COUNTRY_SUFFIXES:
            tokens.pop()
            continue
        break
    text = " ".join(tokens)
    text = re.sub(r"\.nl$", "", text, flags=re.I)
    text = collapse(text).strip(" ,.-*")
    return text or original


def tidy_name(name: str) -> str:
    """Sensible capitalisation for display: "ALBERT HEIJN" -> "Albert Heijn"."""
    letters = [c for c in name if c.isalpha()]
    if not letters:
        return name
    if not (all(c.isupper() for c in letters) or all(c.islower() for c in letters)):
        return name
    words = []
    for i, word in enumerate(name.split(" ")):
        low = word.lower()
        if i > 0 and low in SMALL_WORDS:
            words.append(low)
        elif word.isalpha() and len(word) <= 4 and not re.search(r"[aeiouy]", low):
            words.append(word.upper())          # KPN, NS, AH, VGZ
        else:
            words.append(low[:1].upper() + low[1:])
    return " ".join(words)


def is_person(name: str | None, counterparty_iban: str | None = None,
              trade_words: frozenset[str] | set[str] = TRADE_WORDS_BASE) -> bool:
    """A private counterparty: initials, Dhr/Mw/Fam prefixes or "e/o", and no company or trade
    word ("P. de Vries Slagerij" is a shop)."""
    if not name:
        return False
    words = set(norm_text(name).split())
    if words & COMPANY_WORDS or words & trade_words or re.search(r"\b(b\.v\.|n\.v\.)", name, re.I):
        return False
    stripped = name.strip()
    return bool(PERSON_PREFIX_RE.search(stripped) or INITIALS_RE.search(stripped)
                or PARTNER_RE.search(stripped) or TRAILING_INITIALS_RE.search(stripped))


def person_display(name: str) -> str:
    return tidy_name(collapse(name))


# ---------------------------------------------------------------- description parsing

def parse_card(text: str) -> dict | None:
    m = CARD_RE.search(text)
    if not m:
        return None
    city = collapse(m.group("city")).strip(" .,")
    return {"merchant": collapse(m.group("merchant")), "city": tidy_name(city) if city else None}


def parse_direct_debit(text: str) -> dict | None:
    m = DIRECT_DEBIT_RE.search(text)
    if not m:
        return None
    return {"text": collapse(m.group("text")).strip(" -"), "creditor_id": m.group("cid"),
            "mandate_id": m.group("mid")}


def strip_refs(text: str) -> str:
    """Remove IBANs and long reference tokens (with digits) from free text."""
    text = IBAN_RE.sub(" ", text)
    return collapse(" ".join(t for t in text.split(" ") if not REF_TOKEN_RE.match(t)))


def clean_description(text: str, card: dict | None, debit: dict | None, method: str = "") -> str:
    if debit and debit["text"]:
        return debit["text"]
    if card:
        return text
    text = collapse(REFERENCE_TAIL_RE.sub("", text))
    return strip_refs(text) if method == "ideal" else text


def clean_card_merchant(name: str, city: str | None) -> str:
    """Card terminals glue branch numbers, city and domains onto the name:
    "Winkel102Stad" -> "Winkel", "ParkeerAppNLCOM" -> "ParkeerApp"."""
    name = collapse(name)
    if city:
        name = re.sub(rf"(?<=[\w.])\s*{re.escape(city)}$", "", name, flags=re.I) or name
    name = re.sub(r"(?<=[A-Za-z])\d+$", "", name)
    name = re.sub(r"(?<=[a-z])(?:NL)?(?:COM|NL)$", "", name)
    return name.strip() or name


# ---------------------------------------------------------------- method

def detect_method(tx: dict, text: str, card: dict | None, lib: Library,
                  own_ibans: frozenset[str] | set[str]) -> str:
    pay_type = (tx.get("pay_type") or "").upper()
    code = tx.get("bank_code") or ""
    family = (tx.get("iso_family") or "").upper()
    sub = (tx.get("iso_subfamily") or "").upper()
    if tx.get("counterparty_iban") and tx["counterparty_iban"] in own_ibans:
        return "internal"
    known = lib.code_info(code).get("method")      # the 4-digit code is the most specific
    if known:
        return known
    if sub == "BOOK" or code in OWN_ACCOUNT_CODES:
        return "internal"
    known = lib.type_info(pay_type).get("method")
    if known:
        return known
    if pay_type == "GEA" or sub in ("CWDL", "XBCW", "BCWD", "CDPT") or code in ATM_CODES:
        return "atm"
    if pay_type == "BEA" or family == "CCRD" or card or is_card_code(code):
        return "card"
    if pay_type in ("IDE", "IDM") or IDEAL_RE.search(text):
        return "ideal"
    if pay_type in DEBIT_TYPES or family in ("RDDT", "IDDT") or "europese incasso" in text.lower():
        return "debit"
    if sub == "BOOK" or code in OWN_ACCOUNT_CODES:
        return "internal"
    if pay_type in ("BIJ", "RNT") or sub == "INTR" or code in INTEREST_CODES:
        return "interest"
    if pay_type in ("AFB", "KST") or sub == "CHRG" or code in FEE_CODES:
        return "fee"
    if pay_type in TRANSFER_TYPES or family in ("ICDT", "RCDT", "IRCT", "RRCT"):
        return "transfer"
    if tx.get("counterparty_iban"):
        return "transfer"
    return "other"


# ---------------------------------------------------------------- main entry

def _intermediary(counterparty: str, text: str) -> str | None:
    """'tikkie' / 'betaalverzoek' when a payment request service sits in between."""
    m = INTERMEDIARY_RE.search(counterparty) or (None if counterparty else INTERMEDIARY_RE.search(text))
    return m.group(1).lower() if m else None


def _nameless_key(tx: dict) -> tuple[str, str]:
    """Rows without any name never share one merchant: key on the counterparty IBAN, or a
    per-transaction key."""
    iban = tx.get("counterparty_iban")
    if iban:
        return f"Onbekend ••{iban[-4:]}", f"iban:{iban.lower()}"
    parts = [str(tx.get(k) or "") for k in ("date", "amount_cents", "seq", "end_to_end_id",
                                            "acct_svcr_ref", "raw_description")]
    return "Onbekend", "x:" + hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def normalize(tx: dict, lib: Library | None = None,
              own_ibans: frozenset[str] | set[str] = frozenset(),
              account_iban: str | None = None) -> dict:
    """Return the derived fields for a parsed transaction (does not modify `tx`).
    `account_iban` is the own account the row belongs to (for the per-account fee/interest
    merchant)."""
    lib = lib or Library()
    raw = tx.get("raw_description") or tx.get("remittance") or ""
    text = collapse(raw)
    card = parse_card(text)
    debit = parse_direct_debit(text)
    method = detect_method(tx, text, card, lib, own_ibans)
    card_fields = card if method in ("card", "atm") else None

    mcc_match = MCC_RE.search(text)
    wallet_match = WALLET_RE.search(text)
    description = clean_description(text, card_fields, debit, method)
    amount = tx.get("amount_cents")
    counterparty = collapse(tx.get("counterparty_name"))
    via = None if card_fields else _intermediary(counterparty, text)

    # Where the merchant name comes from
    person = False
    if card_fields and card_fields["merchant"]:
        source_name = clean_card_merchant(card_fields["merchant"], card_fields["city"])
    elif counterparty and not is_psp(counterparty) and not via:
        source_name = counterparty
        person = method not in ("internal",) and is_person(counterparty, tx.get("counterparty_iban"),
                                                           lib.trade_words)
    else:
        source_name = strip_refs(description)
        source_name = " ".join(source_name.split(" ")[:4])

    brand = None
    if not person and not via and method not in ("fee", "interest"):
        # only strong brand names rename a merchant; weak ones ("Tango", "Bolt") are common words
        brand = lib.match_merchant(clean_merchant(source_name), amount, method, weak=False) \
            or (lib.match_merchant(counterparty, amount, method, weak=False) if counterparty else None)
        if brand is None and method in ("ideal", "debit"):
            brand = lib.match_merchant(description, amount, method, weak=False)

    if method in ("fee", "interest"):
        # one stable merchant per own account, whatever the monthly text says
        merchant_name = "Bankkosten" if method == "fee" else "Rente"
        suffix = f" {account_iban[-4:].lower()}" if account_iban else ""
        merchant_key = norm_text(merchant_name) + suffix
    elif via:
        requester = REQUESTER_RE.search(text)
        if requester:
            merchant_name = person_display(requester.group(1))
            merchant_key = "p:" + norm_text(requester.group(1))
        else:
            merchant_name = "Tikkie" if via == "tikkie" else "Betaalverzoek"
            merchant_key = f"via:{via}"
    elif brand:
        merchant_name = brand.get("name") or source_name
        merchant_key = brand.get("key") or norm_text(merchant_name)
    elif person:
        merchant_name = person_display(source_name)
        merchant_key = "p:" + norm_text(PARTNER_RE.sub(" ", source_name))
    else:
        cleaned = clean_merchant(source_name)
        merchant_name = tidy_name(cleaned) if cleaned else ""
        merchant_key = norm_text(cleaned)
    if not merchant_key:
        merchant_name, merchant_key = _nameless_key(tx)

    return {
        "method": method,
        "merchant_name": merchant_name,
        "merchant_key": merchant_key,
        "city": card_fields["city"] if card_fields else None,
        "mcc": tx.get("mcc") or (mcc_match.group(1) if mcc_match else None),
        "wallet": tx.get("wallet") or (wallet_match.group(0).title() if wallet_match else None),
        "mandate_id": tx.get("mandate_id") or (debit["mandate_id"] if debit else None),
        "creditor_id": tx.get("creditor_id") or (debit["creditor_id"] if debit else None),
        "description": description,
    }
