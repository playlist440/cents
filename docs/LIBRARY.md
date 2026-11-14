# Classification library

The files in `backend/cents/data/` let Cents put most transactions in a bakje with zero
configuration (SPEC §6). `categories.json` belongs to the backend; this page covers the other
five. Check them after every edit:

```
PYTHONDONTWRITEBYTECODE=1 python3 tools/check_library.py          # counts + errors
PYTHONDONTWRITEBYTECODE=1 python3 tools/check_library.py --quiet  # errors and warnings only
```

## Files

| File | Shape | Count |
|---|---|---|
| `merchants.json` | `[{"key", "name", "match": [...], "category", "sign"?, "methods"?, "weak"?, "small"?}]` | 895 brands |
| `mcc.json` | `{"5411": {"label": "Supermarkt", "category": "boodschappen", "small"?}}` | 981 codes (77 → `null`) |
| `keywords.json` | `[{"match": [...], "category", "sign"?, "methods"?}]` | 26 groups |
| `asn_categories.json` | `{"Boodschappen": "boodschappen", "Overig": null}` | 31 names |
| `bank_codes.json` | `{"types": {"BEA": {"label", "method"}}, "codes": {"7916": {"label", "method", "direction"}}}` | 27 types, 222 codes |

`sign` is `"in"` (money in) or `"out"` (money out) and is only set where direction changes the
meaning. **One deviation from SPEC §6:** in `asn_categories.json` the value for
`"Belastingen & Toeslagen"` is an object `{"out": "belastingen", "in": "toeslagen"}`. The
engine has to pick by the sign of the amount; every other value is a bakje key or `null`.

Merchants per bakje: vervoer 101, vrije-tijd 87, abonnementen 75, vakantie 70, kleding 55,
verzekeringen 51, cadeaus 49, wonen 49, boodschappen 48, energie 46, huis-tuin 40, uit-eten 37,
verzorging 35, winkelen 31, telecom 25, opvang-school 24, beleggen 20, belastingen 16,
kinderen 13, leningen 7, huisdieren 6, toeslagen 5, contant 3, creditcard 2.

### Optional fields

- `methods`: allow-list of payment methods (`card`, `ideal`, `debit`, `transfer`, `atm`,
  `internal`, `fee`, `interest`, `other`). Set on every brand in beleggen, leningen, wonen,
  verzekeringen, energie, belastingen, toeslagen and creditcard (`transfer`, `ideal`, `debit`,
  `internal`, `other`), so a card payment at "Peaks Coffee" never becomes an investment. On
  keyword groups: the generic housing words (huur, hypotheek, …) only for debit/transfer,
  "loon" only for transfers.
- `weak`: `true` (all match strings) or a list of the weak match strings. A weak brand name is
  also a common word, surname, place or a very short token (action, shell, tango, bolt, ns, bp,
  zeeman, blokker, …; 82 entries). Weak matches come after MCC and keywords and never rename a
  merchant. Recognisable longer forms ("shell express", "action nederland", "bp express") stay
  strong.
- `small`: `{"below_cents": 1500, "category": "uit-eten"}`: amounts below the threshold go to
  the small bakje (a sandwich at a fuel station). Set on MCC 5541 and the 19 fuel brands; never
  on MCC 5542 (unattended pumps) or EV charging, and a card with MCC 5542 never splits. The
  setting `assumptions.small_amount_at_fuel` can change the threshold or switch it off.

Matching is deterministic: longest match string, then earliest position in the text, then
file order.

## Matching assumptions

- Text is normalised like `library.norm_text`: NFKD, accents removed, lowercase, every run of
  non-`[a-z0-9]` becomes one space. So `bol.com` → `bol com`, `McDonald's` → `mcdonald s`,
  `Q-Park` → `q park`. Names that are often written without punctuation get both forms
  (`bol com` and `bolcom`, `mcdonald s` and `mcdonalds`).
- A match string hits when it occurs as **whole words** (`" pattern "` inside `" text "`).
  The longest matching string wins, so specific entries beat generic ones: `shell recharge`
  over `shell`, `coolblue energie` (energie) over `coolblue` (winkelen), `anwb verzekeren`
  (verzekeringen) over `anwb` (vervoer), `amazon prime` (abonnementen) over `amazon`,
  `uber eats` over `uber`, `ronald mcdonald` (cadeaus) over `mcdonalds`.
- Merchants are matched on the tidy merchant name and counterparty name (and the description for
  iDEAL and direct debits). Keywords are matched on merchant name + description, whole words
  only, so a Dutch compound needs its own entry (`autoverzekering`, `tandartspraktijk`).
- Very short tokens are avoided. Allowed on purpose: `ns`, `bp`, `q8` and some unique
  3-letter names (`kpn`, `gvb`, `ret`, `htm`, `rdw`, `uwv`, `svb`, `duo`, `cak`, `vgz`, `dsw`,
  `kfc`, `klm`, `pwn`, `wml`, `bcc`). Ambiguous words are not used alone: `plus`, `dirk`,
  `ben`, `simpel`, `flink`, `casa`, `delta`, `h m` only appear in longer forms.
- Card descriptors glued to digits or city names (e.g. `Etos3381Amersfoort`) do not hit on
  word boundaries. The MCC is the fallback for those.

Direction-specific entries: `belastingdienst` out → belastingen, in → toeslagen;
`belastingdienst toeslagen` / `dienst toeslagen` → toeslagen; ASN `Lening` out → leningen,
in → inkomen-overig; ASN `Sparen` → sparen both ways (a withdrawal is negative saving); `duo` out → leningen, in →
toeslagen; `svb`, `uwv` → toeslagen. Keyword groups with a sign: wonen, belastingen, leningen,
cadeaus (out); toeslagen, salaris, inkomen-overig (in). `gemeente` (out) → belastingen.

## Choices worth knowing

- MCC: the broad codes 5300, 5310, 5311, 5331, 5399, 5999 → `null` (SPEC). Also `null`: business
  and ambiguous codes (4816 internet services, 5817/5818 app stores, 5992 florist, 5993 tobacco,
  5994 newsstands, 7372 software, 6051 currency/crypto, 6012). 3000–3299 → "Luchtvaartmaatschappij",
  3300–3499 → "Autoverhuur", 3500–3999 → "Hotel", all `vakantie`. 7512 (car rental, generic) →
  vervoer; 4899 (pay-TV, streaming) and 5815 → abonnementen; 6010/6011 → contant.
- Car rental brands (Sixt, Hertz, Avis, Europcar…) → vakantie; car sharing → vervoer.
  Grocery delivery (Picnic, Flink, Getir) and meal boxes → boodschappen; meal delivery
  (Thuisbezorgd, Uber Eats, Deliveroo) → uit-eten. Sports shops → vrije-tijd. Lotteries →
  vrije-tijd. Drinking-water companies → energie. Mortgage servicers (Stater, Quion) → wonen.
- ASN categories: `Dier & tuin` → `null` (pets vs garden is ambiguous), `Huishouden &
  elektronica` → winkelen, `Eten & drinken` → uit-eten, `Bankkosten` → overig, `Zak- &
  kleedgeld` → kinderen. Names with and without commas (`Gas water & licht` and `Gas, water &
  licht`) are both listed because the exact spelling in exports is not verified; lookup in the
  backend is case-insensitive.
- `bank_codes.json` contains only codes listed in `docs/research/asn-format.md`. Business ranges
  given there without a meaning (7614–7643, 7259–7262, 7734–7741) are left out. `direction`
  follows the first-digit rule (0/2/6/8 in, 1/3/7/9 out). Own-account BOOK codes (3724/2724,
  3754/2754, 3758/2758, 2795, 2025, 3700/2700, 3701/2701, 3050/2050) have method `internal`.

## Deliberately unsorted

Payment intermediaries say nothing about what was bought, so they are **not** in the library
(the normaliser strips the wrapper when the real merchant is named, e.g. "X via Mollie"):
Tikkie, PayPal, Klarna, Riverty / AfterPay, in3, Billink, SprayPay, generic "betaalverzoek",
Payconiq, Mollie, Adyen, Buckaroo, Stripe, MultiSafepay, Pay.nl, CM.com, Online Betaalplatform,
Sisow, Ingenico, Worldline, Wise, Revolut, bunq and other banks as counterparties. Also left out
on purpose because their dominant purpose is unclear: Van der Valk (hotel or restaurant),
Welkoop/Boerenbond (pets or garden), Belsimpel, Google (bare), PostNL, Makro/Sligro, bare
"bloemist".

## Sources and licences

- MCC code set: [greggles/mcc-codes](https://github.com/greggles/mcc-codes), `mcc_codes.csv`
  (981 codes), licence **Unlicense** (public domain; verified via the GitHub licence API on
  2026-11-14). Only the code set is used; all Dutch labels and mappings are our own.
- ASN types, 4-digit codes, ISO families: `docs/research/asn-format.md` (ASN/SNS documents).
- Brands, tax collectors, insurers, water companies: general knowledge, not checked against
  live bank statements. Names change (Nuon → Vattenfall, T-Mobile → Odido, LeasePlan →
  Ayvens); old names are kept as extra match strings.

## How to extend

1. Add an entry to `merchants.json`: unique kebab-case `key`, display `name`, normalised
   `match` strings (write them as `norm_text` would produce them), a bakje `category`, and
   `sign` only when direction matters. Add the specific variant when a brand has a sub-brand in
   another bakje (`<brand> energie`, `<brand> verzekeren`).
2. Prefer a merchant entry over a keyword; prefer no entry over a doubtful one (a wrong
   category is worse than "Nog te sorteren").
3. Run `tools/check_library.py` and fix every error. Warnings flag very short match strings.

## Demo data

`tools/make_demo_data.py` writes a fictitious family's exports (ASN CSV + CAMT.053.001.02 with
identical sequence numbers, per quarter with one overlapping month) for tests and screenshots:

```
PYTHONDONTWRITEBYTECODE=1 python3 tools/make_demo_data.py [OUT_DIR] --seed 42 --months 18 [--today YYYY-MM-DD]
```

Default output is `./demo-data` (git-ignored). Volgnummers are always 7 digits, so
`NtryRef = <yyyymmdd>-<volgnummer>` is the same with or without zero padding. Not verified
against real exports: ATM and online-card description layouts, foreign country suffixes such
as `FRFRANKRIJK`, the `Afschriftnummer` scheme and the exact ASN category spellings.
