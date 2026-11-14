"""Synthetic bank files for tests. Every name, IBAN and amount here is made up."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from xml.sax.saxutils import escape

from cents.classify.library import Library

CHECKING = "NL11TEST0000000001"
SAVINGS = "NL22TEST0000000002"
OTHER = "NL33FAKE0000000003"
FRIEND = "NL44FAKE0000000004"
CARD_CO = "NL55FAKE0000000005"

HEADER = ("Datum,Je rekening,Van / naar,Naam,Adres,Postcode,Woonplaats,Valuta saldo,"
          "Saldo voor boeking,Valuta,Bedrag bij / af,Verwerkingsdatum,Valutadatum,Code,Type,"
          "Volgnummer,Betalingskenmerk,Omschrijving,Afschriftnummer,Categorie")

# ISO codes per ASN 4-digit code (subset used in tests)
ISO = {"7916": ("PMNT", "CCRD", "POSD"), "7926": ("PMNT", "CCRD", "POSD"),
       "9806": ("PMNT", "ICDT", "ESCT"), "9714": ("PMNT", "RDDT", "ESDD"),
       "8809": ("PMNT", "RCDT", "ESCT"), "3724": ("PMNT", "ICDT", "BOOK"),
       "2724": ("PMNT", "RCDT", "BOOK"), "9720": ("PMNT", "ICDT", "ESCT"),
       "7017": ("PMNT", "CCRD", "CWDL"), "6607": ("ACMT", "MCOP", "INTR")}


@dataclass
class Tx:
    day: date
    seq: int | None
    amount_cents: int
    code: str
    type: str
    description: str
    name: str = ""
    counterparty: str = ""
    category: str = "Overig"
    end_to_end: str = ""


@dataclass
class Account:
    iban: str
    opening_cents: int
    txs: list[Tx] = field(default_factory=list)


def euro(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    return f"{sign}{abs(cents) // 100}.{abs(cents) % 100:02d}"


def card(merchant: str, city: str, day: date, mcc: str = "5411") -> str:
    return (f"{merchant:<22}>{city} {day:%d.%m.%Y} 12U30 KV002 TERM0001 MCC:{mcc} "
            f"Apple Pay betaling   NLNEDERLAND")


def asn_csv(account: Account, header: bool = True, pad: bool = True, categories: bool = True) -> str:
    lines = [HEADER if categories else HEADER.rsplit(",", 1)[0]] if header else []
    balance = account.opening_cents
    for t in account.txs:
        d = f"{t.day.day:02d}-{t.day.month:02d}-{t.day.year}" if pad else f"{t.day.day}-{t.day.month}-{t.day.year}"
        cols = [d, account.iban, t.counterparty, t.name, "", "", "", "EUR", euro(balance), "EUR",
                euro(t.amount_cents), d, d, t.code, t.type, "" if t.seq is None else str(t.seq), "", f"'{t.description}'", "1"]
        if categories:
            cols.append(f"'{t.category}'")
        lines.append(",".join(cols))
        balance += t.amount_cents
    return "\n".join(lines) + "\n"


def camt(accounts: list[Account], version: str = "02") -> str:
    ns = f"urn:iso:std:iso:20022:tech:xsd:camt.053.001.{version}"
    out = ['<?xml version="1.0" encoding="UTF-8"?>', f'<Document xmlns="{ns}"><BkToCstmrStmt>',
           "<GrpHdr><MsgId>TEST</MsgId><CreDtTm>2026-01-31T10:00:00</CreDtTm></GrpHdr>"]
    for n, acc in enumerate(accounts, start=1):
        closing = acc.opening_cents + sum(t.amount_cents for t in acc.txs)
        out.append(f"<Stmt><Id>{n}</Id><Acct><Id><IBAN>{acc.iban}</IBAN></Id><Ccy>EUR</Ccy></Acct>")
        for code, amount in (("OPBD", acc.opening_cents), ("CLBD", closing)):
            ind = "DBIT" if amount < 0 else "CRDT"
            out.append(f"<Bal><Tp><CdOrPrtry><Cd>{code}</Cd></CdOrPrtry></Tp>"
                       f"<Amt Ccy=\"EUR\">{euro(abs(amount))}</Amt><CdtDbtInd>{ind}</CdtDbtInd>"
                       f"<Dt><Dt>2026-01-31</Dt></Dt></Bal>")
        for t in acc.txs:
            ind = "DBIT" if t.amount_cents < 0 else "CRDT"
            dom, fam, sub = ISO.get(t.code, ("PMNT", "ICDT", "ESCT"))
            role, acct_role = ("Cdtr", "CdtrAcct") if ind == "DBIT" else ("Dbtr", "DbtrAcct")
            party = ""
            if t.name or t.counterparty:
                party = (f"<RltdPties><{role}><Nm>{escape(t.name)}</Nm></{role}>"
                         f"<{acct_role}><Id><IBAN>{t.counterparty}</IBAN></Id></{acct_role}></RltdPties>")
            ustrd = escape(t.description.split(" Referentie:")[0])
            out.append(
                "<Ntry>" + (f"<NtryRef>{20260101 + n:08d}-{t.seq:07d}</NtryRef>" if t.seq is not None else "") +
                f"<Amt Ccy=\"EUR\">{euro(abs(t.amount_cents))}</Amt><CdtDbtInd>{ind}</CdtDbtInd>"
                f"<Sts>BOOK</Sts><BookgDt><Dt>{t.day.isoformat()}</Dt></BookgDt>"
                f"<ValDt><Dt>{t.day.isoformat()}</Dt></ValDt>"
                f"<BkTxCd><Domn><Cd>{dom}</Cd><Fmly><Cd>{fam}</Cd><SubFmlyCd>{sub}</SubFmlyCd></Fmly></Domn>"
                f"<Prtry><Cd>{t.code}</Cd><Issr>ASNB</Issr></Prtry></BkTxCd>"
                f"<NtryDtls><TxDtls><Refs><EndToEndId>{t.end_to_end or 'NOTPROVIDED'}</EndToEndId></Refs>"
                f"{party}<RmtInf><Ustrd>{ustrd}</Ustrd></RmtInf></TxDtls></NtryDtls>"
                f"<AddtlNtryInf>{escape(t.description)}</AddtlNtryInf></Ntry>")
        out.append("</Stmt>")
    out.append("</BkToCstmrStmt></Document>")
    return "".join(out)


def sample_account() -> Account:
    """A small, varied month on a checking account."""
    d = date
    return Account(CHECKING, 150000, [
        Tx(d(2026, 1, 2), 1001, -2345, "7916", "BEA", card("JUMBO 4321", "UTRECHT", d(2026, 1, 2)),
           category="Boodschappen"),
        Tx(d(2026, 1, 3), 1002, -1999, "9806", "IDE",
           "1234567890123456 0000111122223333 Webwinkel Testshop Referentie: 2026-01-03T10:11 1234567890123456",
           name="Webwinkel Testshop via Mollie", counterparty=OTHER, category="Winkelen",
           end_to_end="E2E-0001"),
        Tx(d(2026, 1, 5), 1003, 250000, "8809", "OVS", "Salaris januari Testbedrijf",
           name="Testbedrijf BV", counterparty="NL66FAKE0000000006", category="Inkomsten"),
        Tx(d(2026, 1, 6), 1004, -10000, "3724", "NGI",
           "Naar spaarpot Referentie: 0f0e0d0c-1111-2222-3333-444455556666",
           name="Test Gezin", counterparty=SAVINGS, category="Sparen"),
        Tx(d(2026, 1, 7), 1005, -4500, "9714", "EIC",
           "Europese incasso: Premie januari-Incassant ID: NL00ZZZ000000000001-Kenmerk Machtiging: MANDATE-1",
           name="Voorbeeld Verzekeringen N.V.", counterparty="NL77FAKE0000000007", category="Verzekeringen"),
        Tx(d(2026, 1, 8), 1006, -2500, "9720", "NGI", "Etentje terug",
           name="J. de Testpersoon e/o M. Voorbeeld", counterparty=FRIEND, category="Overig"),
    ])


def tiny_library() -> Library:
    return Library(
        merchants=[
            {"key": "jumbo", "name": "Jumbo", "match": ["jumbo"], "category": "boodschappen"},
            {"key": "albert-heijn", "name": "Albert Heijn", "match": ["albert heijn", "ah to go"],
             "category": "boodschappen"},
            {"key": "belastingdienst", "name": "Belastingdienst", "match": ["belastingdienst"],
             "category": "belastingen", "sign": "out"},
            {"key": "belastingdienst", "name": "Belastingdienst", "match": ["belastingdienst"],
             "category": "toeslagen", "sign": "in"},
            {"key": "testbroker", "name": "Testbroker", "match": ["testbroker"], "category": "beleggen"},
        ],
        mcc={"5411": {"label": "Supermarkt", "category": "boodschappen"},
             "5812": {"label": "Restaurant", "category": "uit-eten"},
             "5311": {"label": "Warenhuis", "category": None}},
        keywords=[{"match": ["bakkerij", "bakker"], "category": "boodschappen"},
                  {"match": ["premie"], "category": "verzekeringen", "sign": "out"}],
        asn_categories={"Boodschappen": "boodschappen", "Verzekeringen": "verzekeringen", "Overig": None},
        bank_codes={},
    )
