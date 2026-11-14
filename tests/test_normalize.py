from datetime import date

import pytest

from cents.importers.normalize import clean_merchant, is_person, normalize, tidy_name
from helpers import card, tiny_library


@pytest.mark.parametrize("raw, expected", [
    ("CCV*BAKKERIJ TESTMAN", "BAKKERIJ TESTMAN"),
    ("BCK*Ijssalon Proef", "Ijssalon Proef"),
    ("SumUp *Koffiekar", "Koffiekar"),
    ("Zettle_*Markt Kraam", "Markt Kraam"),
    ("MOL*Webwinkel", "Webwinkel"),
    ("PAY.nl*Tickets Test", "Tickets Test"),
    ("iZ *Food Truck", "Food Truck"),
    ("TMC*Parkeren Test", "Parkeren Test"),
    ("PAYPAL *STREAMDIENST", "STREAMDIENST"),
    ("Webwinkel Testshop via Mollie", "Webwinkel Testshop"),
    ("Sportclub Test by Buckaroo", "Sportclub Test"),
    ("Tickets Voorbeeld via Adyen", "Tickets Voorbeeld"),
    ("Thuisbezorgd.nl via Takeaway.com", "Thuisbezorgd"),
    ("Voorbeeld Verzekeringen N.V.", "Voorbeeld Verzekeringen"),
    ("Testbedrijf B.V.", "Testbedrijf"),
    ("Snackbar Test VOF", "Snackbar Test"),
    ("ALBERT HEIJN 1234", "ALBERT HEIJN"),
    ("JUMBO 0123 NLD", "JUMBO"),
    ("'Quoted Shop'", "Quoted Shop"),
    ("  Lots    of   space  ", "Lots of space"),
])
def test_clean_merchant(raw, expected):
    assert clean_merchant(raw) == expected


def test_tidy_name():
    assert tidy_name("ALBERT HEIJN") == "Albert Heijn"
    assert tidy_name("KPN") == "KPN"
    assert tidy_name("BAKKERIJ VAN DE HOEK") == "Bakkerij van de Hoek"
    assert tidy_name("McDonald's") == "McDonald's"


@pytest.mark.parametrize("name, person", [
    ("J. de Testpersoon", True),
    ("J.M. Voorbeeld", True),
    ("A. Test e/o B. Proef", True),
    ("Dhr Voorbeeld", True),
    ("Mw. Test", True),
    ("Fam. Proefmans", True),
    ("Testpersoon J", True),
    ("Testbedrijf BV", False),
    ("Stichting Voorbeeld", False),
    ("Gemeente Testdorp", False),
    ("Jumbo", False),
    ("", False),
])
def test_person_detection(name, person):
    assert is_person(name) is person


def test_card_description():
    d = date(2026, 1, 2)
    out = normalize({"raw_description": card("CCV*BAKKERIJ TESTMAN 12", "TESTDORP", d, "5462"),
                     "pay_type": "BEA", "bank_code": "7916", "amount_cents": -350})
    assert out["method"] == "card"
    assert out["merchant_name"] == "Bakkerij Testman" and out["merchant_key"] == "bakkerij testman"
    assert out["city"] == "Testdorp" and out["mcc"] == "5462" and out["wallet"] == "Apple Pay"


def test_card_with_city_glued_to_date():
    raw = "WEBSHOPTEST           >amsterdam.02.01.2026  9U05 KV002 T2 MCC:5999 Apple Pay betaling   NLNEDERLAND"
    out = normalize({"raw_description": raw, "bank_code": "7926", "pay_type": "OVS", "amount_cents": -1})
    assert out["method"] == "card" and out["city"] == "Amsterdam" and out["merchant_name"] == "Webshoptest"


def test_library_brand_wins():
    lib = tiny_library()
    out = normalize({"raw_description": card("ALBERT HEIJN 1234", "UTRECHT", date(2026, 1, 1)),
                     "pay_type": "BEA", "amount_cents": -100}, lib)
    assert out["merchant_key"] == "albert-heijn" and out["merchant_name"] == "Albert Heijn"


def test_direct_debit():
    raw = "Europese incasso: Premie januari-Incassant ID: NL00ZZZ000000000001-Kenmerk Machtiging: MANDATE-1"
    out = normalize({"raw_description": raw, "pay_type": "EIC", "counterparty_name": "Voorbeeld Verzekeringen N.V.",
                     "counterparty_iban": "NL77FAKE0000000007", "amount_cents": -4500})
    assert out["method"] == "debit"
    assert out["creditor_id"] == "NL00ZZZ000000000001" and out["mandate_id"] == "MANDATE-1"
    assert out["description"] == "Premie januari"
    assert out["merchant_name"] == "Voorbeeld Verzekeringen"


def test_ideal_via_payment_provider_name():
    raw = "1234567890123456 0000111122223333 Webwinkel Testshop Referentie: 2026-01-03T10:11 1234567890123456"
    out = normalize({"raw_description": raw, "pay_type": "IDE", "counterparty_name": "Stichting Mollie Payments",
                     "counterparty_iban": "NL33FAKE0000000003", "amount_cents": -1999})
    assert out["method"] == "ideal"
    assert out["merchant_name"] == "Webwinkel Testshop"
    assert "Referentie" not in out["description"]


def test_person_key_and_internal_method():
    out = normalize({"raw_description": "Etentje", "pay_type": "NGI", "bank_code": "9720",
                     "counterparty_name": "J. de Testpersoon e/o M. Voorbeeld",
                     "counterparty_iban": "NL44FAKE0000000004", "amount_cents": -2500})
    assert out["merchant_key"].startswith("p:") and out["method"] == "transfer"
    out = normalize({"raw_description": "Sparen Referentie: abc", "bank_code": "3724", "pay_type": "NGI",
                     "counterparty_name": "Test Gezin", "counterparty_iban": "NL22TEST0000000002",
                     "amount_cents": -100})
    assert out["method"] == "internal" and out["description"] == "Sparen"


def test_atm_fee_interest():
    assert normalize({"raw_description": "GELDMAAT TEST >STAD 01.01.2026 10U00", "bank_code": "7017",
                      "pay_type": "GEA", "amount_cents": -5000})["method"] == "atm"
    assert normalize({"raw_description": "Kosten", "bank_code": "7241", "pay_type": "AFB",
                      "amount_cents": -100})["method"] == "fee"
    assert normalize({"raw_description": "Rente", "bank_code": "6607", "pay_type": "BIJ",
                      "amount_cents": 100})["method"] == "interest"


def test_brand_suffix_is_not_a_person():
    assert is_person("Testmarkt XL") is False
    assert is_person("Testpersoon J.M.") is True


def test_card_merchant_glued_parts():
    d = date(2026, 1, 2)
    out = normalize({"raw_description": card("Modehuis102Teststad", "Teststad", d), "pay_type": "BEA",
                     "amount_cents": -1})
    assert out["merchant_name"] == "Modehuis" and out["city"] == "Teststad"
    out = normalize({"raw_description": card("ParkeerAppNLCOM", "parkeerapp", d), "pay_type": "BEA",
                     "amount_cents": -1})
    assert out["merchant_name"] == "ParkeerApp"


def test_description_without_free_text():
    out = normalize({"raw_description": "Referentie: 0f0e0d0c-1111-2222-3333-444455556666", "bank_code": "2724",
                     "pay_type": "NGI", "counterparty_name": "Test Gezin", "amount_cents": 100})
    assert out["description"] == ""
    out = normalize({"raw_description": "Klant 1234567890123456 Testwinkel NL33FAKE0000000003 Referentie: 2026-01-03T10:11 1",
                     "pay_type": "IDE", "counterparty_name": "Testwinkel", "amount_cents": -1})
    assert out["description"] == "Klant Testwinkel"
