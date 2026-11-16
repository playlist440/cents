#!/usr/bin/env python3
"""Generate bank exports for a fictitious Dutch family (stdlib only).

Writes ASN CSV files (new 20-column format) and CAMT.053.001.02 XML files with the same
transactions (same sequence numbers), for a checking and a savings account, split per quarter
with one overlapping month between consecutive files. Everything is synthetic: person names,
IBANs, creditor ids and amounts are made up; brand names are real so the library recognises
them. Deterministic for a given --seed and --today.

Also writes a fictitious DEGIRO export (Transacties, Rekeningoverzicht, Portefeuille) in
OUT_DIR/degiro/: monthly buys of two broad ETFs (public ISINs), made-up prices and quantities.

    python3 tools/make_demo_data.py [OUT_DIR] [--seed 42] [--months 18] [--today YYYY-MM-DD]
"""

from __future__ import annotations

import argparse
import calendar
import random
import string
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from xml.sax.saxutils import escape

# --------------------------------------------------------------------------- formats

CSV_HEADER = ("Datum,Je rekening,Van / naar,Naam,Adres,Postcode,Woonplaats,Valuta saldo,"
              "Saldo voor boeking,Valuta,Bedrag bij / af,Verwerkingsdatum,Valutadatum,Code,Type,"
              "Volgnummer,Betalingskenmerk,Omschrijving,Afschriftnummer,Categorie")

# kind -> (ASN code, ASN type, ISO domain, family, sub-family)
KINDS = {
    "card": ("7916", "BEA", "PMNT", "CCRD", "POSD"),        # contactless NL
    "card_eu": ("7917", "BEA", "PMNT", "CCRD", "POSD"),     # contactless EU
    "card_online": ("7926", "OVS", "PMNT", "CCRD", "POSD"),  # card not present (VISA)
    "card_refund": ("6920", "RTI", "PMNT", "CCRD", "RIMB"),
    "atm": ("7017", "GEA", "PMNT", "CCRD", "CWDL"),
    "ideal": ("9806", "IDE", "PMNT", "ICDT", "ESCT"),
    "transfer_out": ("9720", "NGI", "PMNT", "ICDT", "ESCT"),
    "transfer_in": ("8809", "OVS", "PMNT", "RCDT", "ESCT"),
    "debit": ("9714", "EIC", "PMNT", "RDDT", "ESDD"),
    "standing_order": ("9802", "POV", "PMNT", "ICDT", "STDO"),
    "own_out": ("3724", "NGI", "PMNT", "ICDT", "BOOK"),
    "own_in": ("2724", "NGI", "PMNT", "RCDT", "BOOK"),
    "interest": ("6607", "BIJ", "ACMT", "MCOP", "INTR"),
    "fee": ("7241", "AFB", "ACMT", "MDOP", "CHRG"),
}
COUNTRIES = {"NL": "NEDERLAND", "FR": "FRANKRIJK", "BE": "BELGIE", "DE": "DUITSLAND"}


def iban(rng: random.Random, bank: str, country: str = "NL") -> str:
    """A format-valid IBAN (mod-97) with a made-up account number passing the Dutch 11-test."""
    while True:
        digits = [rng.randint(0, 9) for _ in range(9)]
        if digits[0] == 0:
            continue
        s = sum(d * w for d, w in zip(digits, range(10, 1, -1)))
        last = (-s) % 11
        if last < 10:
            account = "".join(map(str, digits + [last]))
            break
    return with_check(country, bank + account)


def _num(text: str) -> int:
    return int("".join(str(int(ch, 36)) for ch in text))


def with_check(country: str, bban: str) -> str:
    check = 98 - _num(bban + country + "00") % 97
    return f"{country}{check:02d}{bban}"


def creditor_id(rng: random.Random) -> str:
    national = f"{rng.randint(10000000, 99999999)}0000"
    check = 98 - _num(national + "NL00") % 97
    return f"NL{check:02d}ZZZ{national}"


def money(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"


# --------------------------------------------------------------------------- model

@dataclass
class Tx:
    date: date
    account: str                 # "checking" | "savings"
    amount: int                  # cents, signed
    kind: str
    description: str
    category: str = "Overig"     # ASN's own category
    name: str = ""
    iban: str = ""
    kenmerk: str = ""            # Betalingskenmerk
    end_to_end: str = ""
    mandate: str = ""
    creditor: str = ""
    ustrd: str | None = None     # CAMT RmtInf/Ustrd (None = no RmtInf)
    tx_id: str = ""
    seq: int = 0
    balance_before: int = 0
    statement: int = 0
    order: int = 0               # tie-breaker within a day


@dataclass
class Household:
    rng: random.Random
    start: date
    today: date
    checking: str
    savings: str
    holder: str
    txs: list[Tx] = field(default_factory=list)
    _order: int = 0

    def add(self, tx: Tx) -> Tx | None:
        if not (self.start <= tx.date <= self.today):
            return None
        self._order += 1
        tx.order = self._order
        self.txs.append(tx)
        return tx

    # -- helpers ---------------------------------------------------------------
    def hexref(self, n: int) -> str:
        return "".join(self.rng.choice("0123456789abcdef") for _ in range(n))

    def digits(self, n: int) -> str:
        return "".join(self.rng.choice(string.digits) for _ in range(n))

    def uuid_ref(self) -> str:
        h = self.hexref(32)
        return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:30]}"  # truncated like ASN

    def sct_id(self) -> str:
        return "SCT" + self.digits(25)

    def card(self, d: date, merchant: str, city: str, mcc: str, cents: int, cat: str,
             kind: str = "card", country: str = "NL", hour: int | None = None) -> Tx | None:
        h = hour if hour is not None else self.rng.randint(8, 20)
        m = self.rng.randint(0, 59)
        terminal = "".join(self.rng.choice(string.ascii_uppercase + string.digits) for _ in range(6))
        desc = (f"{merchant:<22}>{city} {d:%d.%m.%Y} {h:>2}U{m:02d} KV002 {terminal} "
                f"MCC:{mcc} Apple Pay betaling   {country}{COUNTRIES[country]}")
        return self.add(Tx(d, "checking", -cents, kind, desc, cat))

    def ideal(self, d: date, name: str, ib: str, text: str, cents: int, cat: str) -> Tx | None:
        ref16 = self.digits(16)
        stamp = f"{d:%Y-%m-%d}T{self.rng.randint(7, 22):02d}:{self.rng.randint(0, 59):02d}"
        head = f"{self.hexref(32)} {ref16} {text}"
        return self.add(Tx(d, "checking", -cents, "ideal", f"{head} Referentie: {stamp} {ref16}",
                           cat, name, ib, end_to_end=f"{stamp} {ref16}", ustrd=head,
                           tx_id=self.sct_id()))

    def debit(self, d: date, name: str, ib: str, cid: str, mandate: str, text: str,
              cents: int, cat: str) -> Tx | None:
        desc = f"Europese incasso: {text}-Incassant ID: {cid}-Kenmerk Machtiging: {mandate}"
        return self.add(Tx(d, "checking", -cents, "debit", desc, cat, name, ib,
                           end_to_end=self.digits(16), mandate=mandate, creditor=cid,
                           ustrd=text))

    def incoming(self, d: date, name: str, ib: str, text: str, cents: int, cat: str,
                 account: str = "checking") -> Tx | None:
        return self.add(Tx(d, account, cents, "transfer_in", text, cat, name, ib,
                           end_to_end=self.digits(12), ustrd=text, tx_id=self.sct_id()))

    def transfer(self, d: date, name: str, ib: str, text: str, cents: int, cat: str,
                 kind: str = "transfer_out", kenmerk: str = "") -> Tx | None:
        ref = self.uuid_ref()
        desc = f"{text} Referentie: {ref}" if text else f"Referentie: {ref}"
        return self.add(Tx(d, "checking", -cents, kind, desc, cat, name, ib, kenmerk=kenmerk,
                           end_to_end=ref, ustrd=text or None, tx_id=self.sct_id()))

    def own(self, d: date, cents: int, text: str) -> None:
        """Move money between checking and savings (positive = to savings)."""
        ref = self.uuid_ref()
        desc = f"{text} Referentie: {ref}" if text else f"Referentie: {ref}"
        src, dst = ("checking", "savings") if cents > 0 else ("savings", "checking")
        src_iban = self.checking if src == "checking" else self.savings
        dst_iban = self.savings if dst == "savings" else self.checking
        dst_name = "ASN Sparen" if dst == "savings" else self.holder
        src_name = self.holder if src == "checking" else "ASN Sparen"
        a = abs(cents)
        for account, amount, kind, other, other_name in (
                (src, -a, "own_out", dst_iban, dst_name), (dst, a, "own_in", src_iban, src_name)):
            self.add(Tx(d, account, amount, kind, desc, "Sparen", other_name, other,
                        end_to_end=ref, ustrd=text or None, tx_id=self.sct_id()))


# --------------------------------------------------------------------------- calendar

def months_between(start: date, end: date):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def day_in(y: int, m: int, day: int) -> date:
    return date(y, m, min(day, calendar.monthrange(y, m)[1]))


def workday_after(d: date) -> date:
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def workday_before(d: date) -> date:
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def add_months(y: int, m: int, n: int) -> tuple[int, int]:
    total = y * 12 + (m - 1) + n
    return total // 12, total % 12 + 1


# --------------------------------------------------------------------------- the story

def build(rng: random.Random, months: int, today: date) -> Household:
    sy, sm = add_months(today.year, today.month, -(months - 1))
    start = date(sy, sm, 1)
    hh = Household(rng, start, today, iban(rng, "ASNB"), iban(rng, "ASNB"),
                   "P. Hendriks e/o A. Hendriks-Kramer")
    R = rng

    def cp(bank: str = "") -> str:
        return iban(R, bank or R.choice(["INGB", "RABO", "ABNA", "TRIO", "BUNQ", "KNAB", "SNSB"]))

    # counterparties: real brands (library hits), made-up IBANs and creditor ids
    C = {k: (cp(), creditor_id(R), "".join(R.choice(string.ascii_uppercase + string.digits)
                                            for _ in range(12)))
         for k in ["obvion", "eneco", "vitens", "cb", "zk", "ziggo", "odido", "videoland",
                   "gblt", "bd", "anwb", "partou", "ics", "basicfit"]}
    employer_a, employer_b = cp("RABO"), cp("INGB")
    toeslagen, svb, meesman = cp("INGB"), cp("INGB"), cp("ABNA")
    eneco_in = C["eneco"][0]
    persons = {n: cp() for n in ["R. de Graaf", "T. Mulder", "L. Bosman", "K. Smit",
                                  "J. van Leeuwen"]}

    def dd(d: date, key: str, name: str, text: str, cents: int, cat: str) -> None:
        ib, cid, mandate = C[key]
        hh.debit(workday_after(d), name, ib, cid, mandate, text, cents, cat)

    netflix_change = add_months(sy, sm, months // 2)
    ziggo_change = add_months(sy, sm, 9)
    spotify_stop = add_months(today.year, today.month, -6)
    disney_start = add_months(today.year, today.month, -2)
    big_buy = add_months(today.year, today.month, -5)
    hol_year = today.year if today.month >= 9 else today.year - 1
    holiday = date(hol_year, 8, 1)

    for y, m in months_between(start, today):
        ym = f"{y}{m:02d}"
        first = day_in(y, m, 1)
        # -- income
        sal_a = 341255 + (y - 2020) * 3100
        hh.incoming(workday_before(day_in(y, m, 24)), "Hoogland Techniek B.V.", employer_a,
                    f"Salaris {m:02d}-{y} personeelsnummer 1042", sal_a, "Salaris")
        if m == 5:
            hh.incoming(workday_before(day_in(y, m, 24)), "Hoogland Techniek B.V.", employer_a,
                        f"Vakantiegeld {y} personeelsnummer 1042", 289040, "Salaris")
        last = workday_before(day_in(y, m, 31))
        hh.incoming(last, "Zorggroep De Lindehof", employer_b,
                    f"Netto salaris {calendar.month_name[m].lower()} {y}", 184620, "Salaris")
        if m == 12:
            hh.incoming(last, "Zorggroep De Lindehof", employer_b,
                        f"Eindejaarsuitkering {y}", 151210, "Salaris")
        hh.incoming(workday_before(day_in(y, m, 20)), "Belastingdienst Toeslagen", toeslagen,
                    f"Kinderopvangtoeslag {y} betaling {m:02d} {hh.digits(10)}", 61200,
                    "Belastingen & Toeslagen")
        if m in (1, 4, 7, 10):
            q = {1: "4e", 4: "1e", 7: "2e", 10: "3e"}[m]
            qy = y - 1 if m == 1 else y
            hh.incoming(workday_after(day_in(y, m, 2)), "Sociale Verzekeringsbank", svb,
                        f"Kinderbijslag {q} kwartaal {qy} {hh.digits(9)}", 29860,
                        "Belastingen & Toeslagen")
        # -- fixed costs
        dd(first, "obvion", "Obvion N.V.", f"Maandtermijn hypotheek {ym} leningnummer 77120938",
           118342, "Huur & hypotheek")
        cb_ib, cb_cid, cb_m = C["cb"]
        hh.debit(workday_after(first), "Centraal Beheer", cb_ib, cb_cid, cb_m,
                 f"Premie autoverzekering polis 30418877 periode {ym}", 4812, "Verzekeringen")
        hh.debit(workday_after(first), "Centraal Beheer", cb_ib, cb_cid, cb_m + "W",
                 f"Premie woonverzekering polis 30419102 periode {ym}", 1735, "Verzekeringen")
        dd(first, "zk", "Zilveren Kruis Zorgverzekeringen N.V.",
           f"Zorgverzekering premie {ym} relatienummer 118200341", 28190 + (y - sy) * 1450,
           "Verzekeringen")
        dd(day_in(y, m, 20), "eneco", "Eneco Consumenten B.V.",
           f"Termijnbedrag energie {ym} klantnummer 20417256", 15800 + (y - sy) * 1300,
           "Gas water & licht")
        if m == 3:
            hh.incoming(workday_after(day_in(y, m, 14)), "Eneco Consumenten B.V.", eneco_in,
                        f"Jaarafrekening {y - 1} terugbetaling klantnummer 20417256", 8630,
                        "Gas water & licht")
        dd(day_in(y, m, 26), "vitens", "Vitens N.V.", f"Voorschot drinkwater {ym}", 2140,
           "Gas water & licht")
        dd(day_in(y, m, 20), "ziggo", "Ziggo B.V.", f"Ziggo abonnement {ym} klant 88231",
           6450 if (y, m) < ziggo_change else 6650, "Internet TV & Bellen")
        dd(day_in(y, m, 18), "odido", "Odido Netherlands B.V.", f"Factuur {ym} mobiel 0612",
           2200, "Internet TV & Bellen")
        dd(day_in(y, m, 5), "videoland", "Videoland", f"Videoland Basis {ym}", 899,
           "Hobby sport & vrije tijd")
        if 3 <= m <= 12:
            dd(day_in(y, m, 28), "gblt", "GBLT",
               f"Termijn {m - 2} van 10 aanslag gemeentelijke belastingen {y} {hh.digits(12)}",
               6120, "Belastingen & Toeslagen")
        if m in (1, 4, 7, 10):
            dd(day_in(y, m, 15), "bd", "Belastingdienst",
               f"Motorrijtuigenbelasting kenteken XX-123-Y tijdvak {ym}", 11800,
               "Belastingen & Toeslagen")
        if m == 4:
            dd(day_in(y, m, 12), "anwb", "ANWB B.V.", f"Lidmaatschap Wegenwacht {y}-{y + 1}",
               9450, "Vervoer")
        dd(day_in(y, m, 28), "basicfit", "Basic-Fit Nederland B.V.",
           f"Lidmaatschap {ym} lidnummer 4471023", 2999, "Hobby sport & vrije tijd")
        if m in (1, 4, 7, 10):
            hh.transfer(workday_after(day_in(y, m, 10)), "Voetbalvereniging Leusden",
                        cp("RABO"), f"Contributie kwartaal {(m + 2) // 3} {y} Daan", 4500,
                        "Hobby sport & vrije tijd")
        dd(day_in(y, m, 25), "partou", "Partou B.V.", f"Factuur kinderopvang {ym}", 109218,
           "Kinderen")
        dd(day_in(y, m, 23), "ics", "International Card Services B.V.",
           f"Afschrift creditcard {ym} kaart 4111 XXXX XXXX 0042",
           R.randint(8000, 42000), "Overig")
        # streaming / subscriptions by card
        nf = 1399 if (y, m) < netflix_change else 1599
        hh.card(day_in(y, m, 9), "NETFLIX.COM", "Amsterdam", "4899", nf,
                "Hobby sport & vrije tijd", kind="card_online")
        if (y, m) < spotify_stop:
            hh.card(day_in(y, m, 14), "Spotify P2B4C1D", "Stockholm", "5815", 1299,
                    "Hobby sport & vrije tijd", kind="card_online")
        if (y, m) >= disney_start:
            hh.card(day_in(y, m, 3), "DisneyPlus", "Amsterdam", "4899", 1099,
                    "Hobby sport & vrije tijd", kind="card_online")
        # bank costs
        hh.add(Tx(workday_after(day_in(y, m, 1)), "checking", -295, "fee",
                  f"Kosten ASN Betaalrekening {calendar.month_name[m].lower()} {y}",
                  "Bankkosten", "ASN Bank"))
        # saving & investing
        hh.own(workday_after(day_in(y, m, 25)), 50000, "Spaardoel 41827")
        hh.own(workday_after(day_in(y, m, 25)), 25000, "vakantie")
        if m in (5, 12):
            hh.own(workday_after(day_in(y, m, 27)), 100000, "Extra sparen buffer")
        hh.add(Tx(workday_after(day_in(y, m, 27)), "checking", -25000, "standing_order",
                  f"Periodieke inleg {ym} rekening 552301", "Beleggen",
                  "Meesman Indexbeleggingen", meesman, end_to_end=hh.digits(14),
                  ustrd=f"Periodieke inleg {ym} rekening 552301", tx_id=hh.sct_id()))
        if m == 1:
            hh.add(Tx(day_in(y, m, 1), "savings", R.randint(9000, 16000), "interest",
                      f"Rente {y - 1}", "Sparen", "ASN Bank"))

    # -- daily life
    d = start
    while d <= today:
        wd = d.weekday()
        if wd == 5:  # Saturday
            hh.card(d, f"Albert Heijn {R.choice(['1342', '1388'])}", "AMERSFOORT", "5411",
                    R.randint(8000, 16500), "Boodschappen", hour=R.randint(9, 12))
            hh.card(d, "Vlaamsch Broodhuys", "LEUSDEN", "5462", R.randint(450, 1250),
                    "Boodschappen")
        if wd == 3 and R.random() < 0.6:
            hh.card(d, R.choice(["Action 2104", "HEMA Amersfoort", "Blokker Amersfoort"]),
                    "AMERSFOORT", "5331", R.randint(500, 3500), "Huishouden & elektronica")
        if wd == 2:
            hh.card(d, "Jumbo Leusden", "LEUSDEN", "5411", R.randint(2500, 7200), "Boodschappen")
        if wd == 0 and R.random() < 0.5:
            hh.card(d, "Lidl Amersfoort", "AMERSFOORT", "5411", R.randint(1500, 4800),
                    "Boodschappen")
        if R.random() < 0.06:
            hh.card(d, R.choice(["Etos 3381", "Etos3381Amersfoort"]), "AMERSFOORT", "5912", R.randint(600, 2600),
                    "Verzorging & gezondheid")
        if R.random() < 0.08:
            st = R.choice([("Shell Leusden", "5541"), ("Tango Amersfoort", "5542")])
            hh.card(d, st[0], st[0].split()[1].upper(), st[1], R.randint(5200, 8600), "Vervoer")
        if R.random() < 0.07:
            hh.card(d, "EASYPARK.NL", "Amsterdam", "7523", R.randint(150, 800), "Vervoer",
                    kind="card_online")
        if R.random() < 0.03:
            hh.card(d, "Q-Park Utrecht", "UTRECHT", "7523", R.randint(400, 1400), "Vervoer")
        if wd in (4, 5) and R.random() < 0.18:
            name, mcc = R.choice([("McDonalds Leusden", "5814"),
                                  ("Brasserie De Waag", "5812"),
                                  ("Restaurant Het Hooghe Huys", "5812")])
            hh.card(d, name, "AMERSFOORT", mcc, R.randint(1400, 7800), "Eten & drinken",
                    hour=R.randint(12, 21))
        if wd == 4 and R.random() < 0.35:
            hh.ideal(d, "Thuisbezorgd.nl via Takeaway.com", cp("ABNA"),
                     "Thuisbezorgd.nl bestelling", R.randint(2400, 4600), "Eten & drinken")
        if R.random() < 0.05:
            hh.ideal(d, "bol.com", cp("ABNA"), f"Bestelling {hh.digits(10)} bol.com",
                     R.randint(1200, 8900), "Huishouden & elektronica")
        if R.random() < 0.015:
            hh.ideal(d, "Zalando SE via Adyen", cp("ABNA"), f"Zalando bestelling {hh.digits(9)}",
                     R.randint(3900, 12900), "Kleding")
        if R.random() < 0.012:
            hh.ideal(d, "Lindenhof Woonwinkel via Mollie", cp("RABO"),
                     f"Order LW{hh.digits(6)}", R.randint(1900, 7400), "Overig")
        if R.random() < 0.02:  # unknown local merchants
            name, mcc = R.choice([("Studio Veldhuis", "7299"), ("De Groene Vlinder", "5999"),
                                  ("Atelier Ruimzicht", "5999")])
            hh.card(d, name, "AMERSFOORT", mcc, R.randint(1500, 6500), "Overig")
        if d.day in (2, 16) and R.random() < 0.6:
            hh.add(Tx(d, "checking", -R.choice([5000, 10000]), "atm",
                      f"{'Geldmaat Leusden':<22}>LEUSDEN {d:%d.%m.%Y} {R.randint(9, 18):>2}U"
                      f"{R.randint(0, 59):02d} KV002 GM{hh.digits(4)} MCC:6011   NLNEDERLAND",
                      "Contanten"))
        if R.random() < 0.03:  # paying someone's Tikkie
            who = R.choice(list(persons))
            hh.ideal(d, "Tikkie", cp("ABNA"), f"Tikkie ID {hh.digits(12)} "
                     f"{R.choice(['Etentje', 'Cadeau juf', 'Uitje', 'Pizza'])} {who}",
                     R.randint(800, 3500), "Overig")
        if R.random() < 0.025:  # friends paying back
            who = R.choice(list(persons))
            hh.incoming(d, who, persons[who], R.choice(["Terug voor etentje", "Bedankt",
                                                         "Kaartjes", "Voorgeschoten"]),
                        R.randint(1000, 4000), "Overig")
        if wd == 5 and R.random() < 0.12:
            hh.transfer(d, "T. Mulder", persons["T. Mulder"], "Oppas zaterdag",
                        R.choice([2500, 3000, 3500]), "Kinderen")
        d += timedelta(days=1)

    # -- one-off events
    # holiday in France
    if start <= holiday <= today:
        hh.ideal(holiday - timedelta(days=60), "Camping Les Pins via Mollie", cp("RABO"),
                 "Aanbetaling reservering 2208", 45000, "Vakantie")
        hh.own(holiday - timedelta(days=1), -120000, "vakantie")
        for i, (merchant, city, mcc, lo, hi, cat) in enumerate([
                ("TotalEnergies A1", "ARRAS", "5541", 6500, 9200, "Vervoer"),
                ("VINCI AUTOROUTES", "ARRAS", "4784", 1800, 4200, "Vervoer"),
                ("Carrefour Market", "VALLON PONT D AR", "5411", 4500, 13000, "Boodschappen"),
                ("Boulangerie du Pont", "VALLON PONT D AR", "5462", 400, 1300, "Boodschappen"),
                ("Le Petit Bistro", "RUOMS", "5812", 3800, 9500, "Eten & drinken"),
                ("Camping Les Pins", "RUOMS", "7033", 30000, 52000, "Vakantie"),
                ("Carrefour Market", "VALLON PONT D AR", "5411", 4500, 13000, "Boodschappen"),
                ("Canoe Ardeche Loc", "VALLON PONT D AR", "7999", 4000, 7000,
                 "Hobby sport & vrije tijd"),
                ("Le Petit Bistro", "RUOMS", "5812", 3800, 9500, "Eten & drinken"),
                ("TotalEnergies A6", "BEAUNE", "5541", 6500, 9200, "Vervoer")]):
            day = holiday + timedelta(days=1 + i * 13 // 10)
            hh.card(day, merchant, city, mcc, R.randint(lo, hi), cat, kind="card_eu",
                    country="FR")
    # a large one-off purchase, paid partly from savings
    by, bm = big_buy
    big_day = workday_after(day_in(by, bm, 11))
    hh.own(big_day, -90000, "wasmachine")
    hh.ideal(big_day, "Coolblue B.V.", cp("INGB"), f"Coolblue bestelling {hh.digits(8)}",
             84900, "Huishouden & elektronica")
    # a duplicate card charge and refunds
    dup = workday_after(today - timedelta(days=40))
    for _ in range(2):
        hh.card(dup, "Jumbo Leusden", "LEUSDEN", "5411", 4718, "Boodschappen", hour=17)
    ref_day = today - timedelta(days=75)
    t = hh.card(ref_day, "Decathlon Amersfoort", "AMERSFOORT", "5941", 5999,
                "Hobby sport & vrije tijd")
    if t:
        hh.add(Tx(ref_day + timedelta(days=6), "checking", 5999, "card_refund",
                  t.description.replace(f"{ref_day:%d.%m.%Y}", f"{ref_day + timedelta(days=6):%d.%m.%Y}"),
                  "Hobby sport & vrije tijd"))
    zr = today - timedelta(days=100)
    hh.incoming(workday_after(zr), "Zalando SE", cp("ABNA"),
                f"Terugbetaling retour bestelling {hh.digits(9)}", 6495, "Kleding")
    # an invoice paid by transfer with a payment reference
    hh.transfer(workday_after(today - timedelta(days=130)), "Hoveniersbedrijf Groenewoud",
                cp("RABO"), f"Factuur {today.year}-118 snoeiwerk", 38500, "Klussen & onderhoud",
                kenmerk="1000020261180041")
    return hh


# --------------------------------------------------------------------------- finalise

def finalise(hh: Household, opening: dict[str, int]) -> None:
    """Order transactions, assign sequence numbers, running balances and statement numbers."""
    hh.txs.sort(key=lambda t: (t.date, t.order))
    balance = dict(opening)
    day_seq: dict[tuple[str, date], int] = {}
    for t in hh.txs:
        key = (t.account, t.date)
        if key not in day_seq:
            day_seq[key] = hh.rng.randint(1000000, 1600000)
        day_seq[key] += hh.rng.randint(1, 40000)
        t.seq = day_seq[key]
        t.balance_before = balance[t.account]
        balance[t.account] += t.amount
        t.statement = (t.date.year - 2019) * 12 + t.date.month
        if not t.tx_id and t.kind not in ("card", "card_eu", "card_online", "card_refund", "atm",
                                           "interest", "fee"):
            t.tx_id = hh.sct_id()


def periods(start: date, today: date) -> list[tuple[date, date]]:
    """Quarter files, each also covering the month before the quarter (one overlapping month)."""
    out = []
    q_start = date(start.year, (start.month - 1) // 3 * 3 + 1, 1)
    while q_start <= today:
        ny, nm = add_months(q_start.year, q_start.month, 3)
        q_end = date(ny, nm, 1) - timedelta(days=1)
        py, pm = add_months(q_start.year, q_start.month, -1)
        f_from = max(start, date(py, pm, 1))
        out.append((f_from, min(q_end, today)))
        q_start = date(ny, nm, 1)
    return out


def csv_row(t: Tx, own_iban: str) -> str:
    dt = f"{t.date:%d-%m-%Y}"
    fields = [dt, own_iban, t.iban, t.name, "", "", "", "EUR", money(t.balance_before), "EUR",
              money(t.amount), dt, dt, KINDS[t.kind][0], KINDS[t.kind][1], str(t.seq), t.kenmerk,
              f"'{t.description}'", str(t.statement % 1000), f"'{t.category}'"]
    for f in fields:
        assert "," not in f, f"comma in CSV field: {f!r}"
    return ",".join(fields)


def camt_entry(t: Tx, ind: str) -> str:
    code, _type, domain, family, sub = KINDS[t.kind]
    cd = "CRDT" if t.amount > 0 else "DBIT"
    amt = money(abs(t.amount))
    x = [f"{ind}<Ntry>",
         f"{ind}  <NtryRef>{t.date:%Y%m%d}-{t.seq:07d}</NtryRef>",
         f'{ind}  <Amt Ccy="EUR">{amt}</Amt>',
         f"{ind}  <CdtDbtInd>{cd}</CdtDbtInd>",
         f"{ind}  <RvslInd>false</RvslInd>",
         f"{ind}  <Sts>BOOK</Sts>",
         f"{ind}  <BookgDt><Dt>{t.date:%Y-%m-%d}</Dt></BookgDt>",
         f"{ind}  <ValDt><Dt>{t.date:%Y-%m-%d}</Dt></ValDt>",
         f"{ind}  <BkTxCd>",
         f"{ind}    <Domn><Cd>{domain}</Cd><Fmly><Cd>{family}</Cd>"
         f"<SubFmlyCd>{sub}</SubFmlyCd></Fmly></Domn>",
         f"{ind}    <Prtry><Cd>{code}</Cd><Issr>ASNBANK</Issr></Prtry>",
         f"{ind}  </BkTxCd>",
         f"{ind}  <NtryDtls>"]
    if not t.iban:
        x.append(f"{ind}    <TxDtls/>")
    else:
        party, acct, agt = ("Cdtr", "CdtrAcct", "CdtrAgt") if cd == "DBIT" else \
            ("Dbtr", "DbtrAcct", "DbtrAgt")
        refs = []
        if t.end_to_end:
            refs.append(f"<EndToEndId>{escape(t.end_to_end)}</EndToEndId>")
        if t.tx_id:
            refs.append(f"<TxId>{t.tx_id}</TxId>")
        if t.mandate:
            refs.append(f"<MndtId>{escape(t.mandate)}</MndtId>")
        x.append(f"{ind}    <TxDtls>")
        if refs:
            x.append(f"{ind}      <Refs>{''.join(refs)}</Refs>")
        x.append(f'{ind}      <AmtDtls><InstdAmt><Amt Ccy="EUR">{amt}</Amt></InstdAmt></AmtDtls>')
        x.append(f"{ind}      <RltdPties>")
        x.append(f"{ind}        <{party}><Nm>{escape(t.name)}</Nm>")
        if t.creditor:
            x.append(f"{ind}          <Id><PrvtId><Othr><Id>{t.creditor}</Id>"
                     f"<SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id>")
        x.append(f"{ind}        </{party}>")
        x.append(f"{ind}        <{acct}><Id><IBAN>{t.iban}</IBAN></Id></{acct}>")
        x.append(f"{ind}      </RltdPties>")
        bic = t.iban[4:8] + "NL2A" if t.iban[4:8] != "ASNB" else "ASNBNL21"
        x.append(f"{ind}      <RltdAgts><{agt}><FinInstnId><BIC>{bic}</BIC></FinInstnId>"
                 f"</{agt}></RltdAgts>")
        if t.ustrd or t.kenmerk:
            x.append(f"{ind}      <RmtInf>")
            if t.ustrd:
                x.append(f"{ind}        <Ustrd>{escape(t.ustrd)}</Ustrd>")
            if t.kenmerk:
                x.append(f"{ind}        <Strd><CdtrRefInf><Ref>{t.kenmerk}</Ref></CdtrRefInf></Strd>")
            x.append(f"{ind}      </RmtInf>")
        x.append(f"{ind}    </TxDtls>")
    x.append(f"{ind}  </NtryDtls>")
    x.append(f"{ind}  <AddtlNtryInf>{escape(t.description)}</AddtlNtryInf>")
    x.append(f"{ind}</Ntry>")
    return "\n".join(x)


def balance_xml(kind: str, cents: int, d: date) -> str:
    cd = "DBIT" if cents < 0 else "CRDT"
    return (f"      <Bal>\n        <Tp><CdOrPrtry><Cd>{kind}</Cd></CdOrPrtry></Tp>\n"
            f'        <Amt Ccy="EUR">{money(abs(cents))}</Amt>\n'
            f"        <CdtDbtInd>{cd}</CdtDbtInd>\n        <Dt><Dt>{d:%Y-%m-%d}</Dt></Dt>\n"
            f"      </Bal>")


def write_camt(path: Path, own_iban: str, txs: list[Tx], seq_nr: int, created: datetime) -> None:
    opening = txs[0].balance_before
    closing = txs[-1].balance_before + txs[-1].amount
    stamp = created.strftime("%Y-%m-%dT%H:%M:%S+01:00")
    msg = f"CAMT053DEMO{seq_nr:012d}"
    parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
             '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">',
             "  <BkToCstmrStmt>",
             f"    <GrpHdr><MsgId>{msg}</MsgId><CreDtTm>{stamp}</CreDtTm></GrpHdr>",
             "    <Stmt>",
             f"      <Id>{msg}00000</Id>",
             f"      <ElctrncSeqNb>{seq_nr}</ElctrncSeqNb>",
             f"      <CreDtTm>{stamp}</CreDtTm>",
             f"      <Acct><Id><IBAN>{own_iban}</IBAN></Id><Ccy>EUR</Ccy>"
             "<Svcr><FinInstnId><BIC>ASNBNL21</BIC></FinInstnId></Svcr></Acct>",
             balance_xml("OPBD", opening, txs[0].date),
             balance_xml("CLBD", closing, txs[-1].date)]
    parts += [camt_entry(t, "      ") for t in txs]
    parts += ["    </Stmt>", "  </BkToCstmrStmt>", "</Document>", ""]
    path.write_text("\n".join(parts), encoding="utf-8")


def write_files(hh: Household, out: Path) -> list[tuple[str, int]]:
    out.mkdir(parents=True, exist_ok=True)
    written = []
    seq_nr = 1000
    created = datetime.combine(hh.today, datetime.min.time()).replace(hour=12)
    for account, own_iban in (("checking", hh.checking), ("savings", hh.savings)):
        txs = [t for t in hh.txs if t.account == account]
        for f_from, f_to in periods(hh.start, hh.today):
            part = [t for t in txs if f_from <= t.date <= f_to]
            if not part:
                continue
            base = f"transactie-historie_{own_iban}_{f_from:%Y%m%d}-{f_to:%Y%m%d}"
            csv_path = out / f"{base}.csv"
            lines = [CSV_HEADER] + [csv_row(t, own_iban) for t in part]
            csv_path.write_bytes(("\r\n".join(lines) + "\r\n").encode("utf-8"))
            seq_nr += 1
            write_camt(out / f"{base}.xml", own_iban, part, seq_nr, created)
            written += [(csv_path.name, len(part)), (f"{base}.xml", len(part))]
    return written


# --------------------------------------------------------------------------- DEGIRO

DEGIRO_FUNDS = [   # isin, name, start price, monthly drift, units per buy, every n months
    ("IE00B3RBWM25", "VANGUARD FTSE ALL-WORLD UCITS ETF", 108.0, 0.0075, 2, 1),
    ("IE00B4L5Y983", "ISHARES CORE MSCI WORLD UCITS ETF", 86.0, 0.008, 3, 3),
]


def _nl(x: float, decimals: int = 2) -> str:
    return f'"{x:.{decimals}f}"'.replace(".", ",")


def _price(rng_seed: int, start: float, drift: float, months: float) -> float:
    import math
    return round(start * (1 + drift * months) * (1 + 0.035 * math.sin(months * 1.3 + rng_seed)), 2)


def write_degiro(rng: random.Random, start: date, today: date, out: Path) -> list[tuple[str, int]]:
    """Fictitious DEGIRO CSV exports in the Dutch layout (decimal comma, unnamed currency
    columns next to amounts). Order ids are random hex, nothing refers to a real account."""
    out.mkdir(parents=True, exist_ok=True)
    tx_lines, acc_lines, held = [], [], {}
    first = date(start.year, start.month, 1)
    for n, (y, m) in enumerate(months_between(first, today)):
        for k, (isin, name, p0, drift, units, every) in enumerate(DEGIRO_FUNDS):
            if n % every:
                continue
            d = workday_after(date(y, m, 5 + k))
            if d > today:
                continue
            price = _price(k, p0, drift, n)
            value = -round(units * price, 2)
            fee = -1.0 if every == 1 else -2.0
            order = "".join(rng.choice("0123456789abcdef") for _ in range(32))
            order = f"{order[:8]}-{order[8:12]}-{order[12:16]}-{order[16:20]}-{order[20:]}"
            tx_lines.append((d, f"{d:%d-%m-%Y},09:{10 + k:02d},{name},{isin},EAM,XAMS,{units},{_nl(price, 4)},EUR,"
                                f"{_nl(value)},EUR,{_nl(value)},EUR,,{_nl(fee)},EUR,{_nl(value + fee)},EUR,{order}"))
            held[isin] = held.get(isin, 0) + units
        if m in (3, 6, 9, 12):
            d = workday_after(date(y, m, 20))
            if d <= today and held.get(DEGIRO_FUNDS[0][0]):
                div = round(held[DEGIRO_FUNDS[0][0]] * 0.62, 2)
                for desc, amount in (("Dividend", div), ("Dividendbelasting", -round(div * 0.15, 2))):
                    acc_lines.append((d, f"{d:%d-%m-%Y},07:30,{d:%d-%m-%Y},{DEGIRO_FUNDS[0][1]},{DEGIRO_FUNDS[0][0]},"
                                         f"{desc},,EUR,{_nl(amount)},EUR,,"))
        if m == 1:
            d = workday_after(date(y, 1, 3))
            if d <= today:
                acc_lines.append((d, f"{d:%d-%m-%Y},06:00,{d:%d-%m-%Y},,,DEGIRO Aansluitingskosten {y} "
                                     f"(Euronext Amsterdam - EAM),,EUR,{_nl(-2.5)},EUR,,"))
    files = {
        "Transacties.csv": ("Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,,Lokale waarde,,"
                            "Waarde,,Wisselkoers,Transactiekosten en/of,,Totaal,,Order ID", tx_lines),
        "Account.csv": ("Datum,Tijd,Valutadatum,Product,ISIN,Omschrijving,FX,Mutatie,,Saldo,,Order Id", acc_lines),
    }
    written = []
    for fname, (header, lines) in files.items():
        body = [header] + [line for _, line in sorted(lines, key=lambda x: x[0], reverse=True)]
        (out / fname).write_text("\n".join(body) + "\n", encoding="utf-8")
        written.append((f"degiro/{fname}", len(lines)))
    months_total = len(list(months_between(first, today))) - 1
    pf = ["Product,Symbool/ISIN,Aantal,Slotkoers,Lokale waarde,,Waarde in EUR",
          'CASH & CASH FUND & FTX CASH (EUR),,,,EUR,"12,40","12,40"']
    for k, (isin, name, p0, drift, _, _) in enumerate(DEGIRO_FUNDS):
        if held.get(isin):
            close = _price(k, p0, drift, months_total + 0.5)
            pf.append(f"{name},{isin},{held[isin]},{_nl(close)},EUR,{_nl(close * held[isin])},{_nl(close * held[isin])}")
    (out / "Portfolio.csv").write_text("\n".join(pf) + "\n", encoding="utf-8")
    written.append(("degiro/Portfolio.csv", len(pf) - 1))
    return written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate demo ASN CSV + CAMT.053 exports.")
    ap.add_argument("out", nargs="?", default="demo-data", help="output folder (default ./demo-data)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--months", type=int, default=18)
    ap.add_argument("--today", type=date.fromisoformat, default=None,
                    help="last day of data, YYYY-MM-DD (default: today)")
    args = ap.parse_args(argv)
    if args.months < 1:
        ap.error("--months must be at least 1")
    today = args.today or date.today()
    rng = random.Random(args.seed)
    hh = build(rng, args.months, today)
    finalise(hh, {"checking": 245037, "savings": 820000})
    written = write_files(hh, Path(args.out))
    written += write_degiro(random.Random(args.seed + 1), hh.start, hh.today, Path(args.out) / "degiro")

    print(f"Demo household {hh.holder} (fictitious)")
    print(f"  checking {hh.checking}   savings {hh.savings}")
    print(f"  period   {hh.start} .. {hh.today}")
    for account in ("checking", "savings"):
        txs = [t for t in hh.txs if t.account == account]
        end = txs[-1].balance_before + txs[-1].amount if txs else 0
        print(f"  {account:<9}{len(txs):>5} transactions, closing balance EUR {money(end)}")
    print(f"Wrote {len(written)} files to {Path(args.out).resolve()}:")
    for name, n in written:
        print(f"  {name}  ({n} rows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
