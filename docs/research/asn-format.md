# ASN Bank export formats and code tables (reference)

Researched 2026-11-14. Marker per item: **[V]** verified in an official/primary source, **[S]** seen in the user's own samples only, **[K]** general knowledge / third-party, not verified against ASN, **[U]** unverified or not found.

Primary sources (both ASN/SNS-owned, PDFs):
- A: "Uitleg transactieoverzicht in Mijn SNS" (ASN Bank, created 2025-09-30) https://www.snsbank.nl/particulier/support/download-tonen-op-pagina/uitleg-van-je-transactieoverzicht-in-mijn-sns.html
- B: "Transaction Codeset ASN Bank AIS API Documentation v2.0" (1 July 2025, codeset v1.24) https://openbanking.asnbank.nl/build/image/pdf/transaction_codeset_asn_bank_ais_api_documentation_v2.0.pdf
- C: CAMT.053 format description https://www.asnbank.nl/downloads/formaatbeschrijving-camt053.html (found, not read in detail)

## 1. CSV format

Source: A. Note A is the SNS-branded doc (SNS/ASN merged brand since 2025-07-01); it matches the user's header only partly.

| Item | Finding |
|---|---|
| Fields documented in A (17) | Datum, Je rekening, Van / naar, Naam, Valuta saldo, Saldo voor boeking, Valuta boeking, Bedrag bij/af, Verwerkingsdatum, Valutadatum, Code, Type, Volgnummer, Betalingskenmerk, Omschrijving, Afschriftnummer, Categorie **[V]** |
| User's header (20) | Additionally has Adres, Postcode, Woonplaats and calls the amount currency column "Valuta". A does not document these three; their meaning (counterparty address) is inferred **[U]** |
| Date | dd-mm-jjjj; example in A is unpadded (`25-3-2025`), so parse tolerant of 1-digit day/month **[V]** |
| Datum | "boekdatum" (booking date); Verwerkingsdatum = processing date, may differ; Valutadatum = interest value date **[V]** |
| Numbers | Decimal point, `-` prefix for negatives (`-43.90`, `1228.30`); "Bedrag bij/af" is signed (negative = af) **[V]**; no thousands separator in examples |
| Saldo voor boeking | Balance before the booking (not after) **[V]** |
| Code | N(4), booking code, "to recognise certain bookings e.g. credit or cash withdrawal"; examples 8810, 9820 **[V]** |
| Type | XXX, "translation of the boekingscode"; appendix list in section 2 **[V]** |
| Volgnummer | N(8), unique per booking (user's CAMT NtryRef contains it) **[V]/[S]** |
| Betalingskenmerk | X(16), reference given by payer (invoice no.) **[V]** |
| Omschrijving | X(140) in A, but real values are longer/multi-line style with padded spaces **[S]**; literal single quotes around Omschrijving, Betalingskenmerk example (`'factuur 9234820'`) **[V]** (A's example shows quotes; user's samples confirm for Omschrijving/Categorie) |
| Afschriftnummer | N(3) **[V]** |
| Categorie | X(40), "assigned category of the booking"; A's example is `Boodschappen, vervoer, sport & vrije tijd` i.e. looks like a comma list in the doc, but real files hold one category **[V]/[S]** |
| File name | last 10 digits of IBAN + journaaldatum + volgnummer **[V]** |
| Old 19-column headerless format | No official description found. Third-party: ofxstatement-dutch ASN CSV parser keys on "Journaaldatum" and "Volgnummer transactie" (older/other layout) https://pypi.org/project/ofxstatement-dutch **[K]**. Not verified; do not assume column order from it |
| Other formats offered | PDF, CAMT.053, CSV (A); MT940 and CAMT.053 per third parties **[V]/[K]**. CAMT.053 history max. 18 months (Yuki/Nmbrs, business) https://support.yuki.nl/en/support/solutions/articles/80000786198-asn-bank-export-files |

Parser advice: map by header name, not position; trim; strip surrounding `'`; treat Adres/Postcode/Woonplaats as optional.

## 2. Type codes (3-letter "boekingscode")

Source: A, Bijlage 1 (complete list as published) **[V]**:

| Type | Betekenis (as published) | Type | Betekenis |
|---|---|---|---|
| ACC | Acceptgiro | KAS | Kastransactie |
| AFB | Afschrijving kosten | MSC | Overige |
| BEA | Betaalautomaat | NGI | Overboeking |
| BIJ | Rentebijschrijving | NGM | Overboeking |
| BVZ | Betaalverzoek | NUL | Bericht (zero-amount info) |
| EFF | Effectenboeking | OVS | Overboeking |
| EIC | Europese incasso | PCQ | Payconiq |
| GEA | Geldautomaat | POV | Periodieke overboeking |
| IDE | iDEAL-betaling | RTI | Terugboeking |
| IDM | iDEAL-betaling | TPP | Overboeking (via third party/PSD2) |
| IIC | Interne incasso | AGI / AGM | (in B only) acceptgiro internet / mobile **[V]** (B) |
| IOI, IOM, IOS | Directe overboeking (instant) | ITP | Directe overboeking (instant, via TPP) |

Notes:
- Several of the user's guessed codes are NOT in the official list: AF, BTL, CHP, CHQ, COR, DIV, GBK, INC, IDB, IMB, IOB, KTN, KST, PRM, PRV, RNT, STO, TEL, TER, TRN, VV (VV is quoted as an example value in A's Type row but absent from Bijlage 1 - treat as possible legacy value) **[V]**/**[U]**.
- "Directe overboeking" = SEPA Instant (IOI/IOM/IOS/ITP map to PMNT IRCT/RRCT, see B). IOS (seen by user) is used both for outgoing instant recall (9948/9949) and incoming instant (8948/8949).
- Type is a lossy mapping of Code: several Codes share one Type.

## 3. 4-digit Code (= CAMT BkTxCd/Prtry/Cd)

A public table exists: source B (ASN Bank AIS API codeset, Excel-derived PDF). It maps Code -> ISO Domain/Family/Subfamily -> Type ("Proprietary Bank Transaction Code FXXX"). Where B shows "7900 / 9900" the first is the code for a debit-card booking, second for the corresponding variant (see pattern). Full table **[V]**, condensed below (descriptions are B's, translated/shortened by me).

### Pattern (inferred from B, consistent across all rows) **[V by inspection]**
- Direction by 1st digit: **0, 2, 6, 8 = credit (bij)**; **1, 3, 7, 9 = debit (af)** (holds for every row in B).
- 2xxx/3xxx are "own-account / within-bank-brand / incoming-vs-outgoing" families; 8xxx/9xxx are "other bank / NL / SEPA / external".
- Card codes come in pairs: **79xx and 99xx** are two code variants of the same product (B lists both, e.g. `7903 / 9903`; the user's samples contain 7906, 7916, 7926 and 9806/9714). Last two digits identify scheme+geo+channel (see card table).
- Interest/charges 6xxx (credit) and 7xxx (debit).

### Payments, debit (outgoing credit transfers)
| Code | ISO D/F/S | Type | Meaning |
|---|---|---|---|
| 3724 | PMNT ICDT BOOK | NGI | Own accounts, internet & app (**e.g. betaal -> spaar**) |
| 3754 | PMNT ICDT BOOK | NGM | Own accounts, mobile app |
| 3758 | PMNT ICDT BOOK | TPP | Own accounts via TPP |
| 3723 / 3753 / 3757 | PMNT ICDT ESCT | NGI / NGM / TPP | SCT within same bank brand |
| 9720 / 9755 / 9759 | PMNT ICDT ESCT | NGI / NGM / TPP | SCT NL+SEPA (internet / app / TPP) |
| 9747 | PMNT ICDT ESCT | OVS | SCT SEPA excl. NL |
| 9722 | PMNT ICDT ESCT | OVS | Corporate batch booking |
| 9930, 9933 / 9932, 9935 / 9931, 9934 | PMNT IRCT ESCT | IOI / IOM / ITP | SCT Instant (internet / app / TPP) |
| 3719 / 9719 | PMNT ICDT ESCT | PCQ | Payconiq |
| 9806 / 9856 | PMNT ICDT ESCT | IDE / IDM | iDEAL outgoing (internet / app) |
| 9721 / 9756 / 9844 | PMNT ICDT ESCT | AGI / AGM / ACC | Acceptgiro (internet / app / paper) |
| 9846, 3025/3026/9801, 9849 | PMNT ICDT BOOK/ESCT | OVS | Paper / branch / service dept |
| 9729, 9772, 9773 | PMNT ICDT PRCT | OVS | Urgent payment (discontinued) |
| 7727, 7767, 7761, 7768 | PMNT ICDT XBCT | OVS | Non-SEPA foreign payments |
| 9802 | PMNT ICDT STDO | POV | Standing order (periodiek) |
| 3700 / 3701 | PMNT ICDT AUTT / CAMT ACCB SWEP | POV | Automated own-account transfer fixed amount / cash pooling |
| 9718, 9948, 9949 | PMNT RCDT RRTN | RTI / IOS | Recall of SCT / SCT Inst |
| 3050 | PMNT ICDT BOOK | KAS | Account closure -> own account |
| 9200 | SECU SETT TRAD | EFF | Securities purchase |

### Direct debits
| Code | ISO | Type | Meaning |
|---|---|---|---|
| 9714 | PMNT RDDT ESDD | EIC | SEPA Core DD (debit) |
| 9827 | PMNT RDDT BBDD | EIC | B2B DD |
| 9885 | PMNT RDDT PMDD | MSC | Overheidsvordering |
| 9715 / 9716 / 9717 / 9842 | PMNT IDDT UPDD/UPDD/PRDD/RCDD | RTI | DD return / refund / reversal / reject |
| 8715 / 8716 / 8717 | PMNT RDDT UPDD/UPDD/PRDD | RTI | credit side of return/refund/reversal |
| 8820 / 8821 / 8842 | PMNT IDDT ESDD / OODD / RCDD | EIC / EIC / RTI | Business collection (core recurring / one-off / reject) |

### Credits (incoming)
| Code | ISO | Type | Meaning |
|---|---|---|---|
| 2724 / 2754 / 2758 | PMNT RCDT BOOK | NGI / NGM / TPP | Own accounts incoming (**spaar -> betaal**) |
| 2795, 2025 | PMNT RCDT BOOK | OVS | Own accounts via phone / branch |
| 2723 / 2753 / 2757 | PMNT RCDT ESCT | NGI / NGM / TPP | Within bank brand |
| 8722, 2026, 8743, 8750 | PMNT RCDT ESCT (8750 RRCT) | OVS | Batch / branch / between brands / other |
| **8809** | PMNT RCDT ESCT | OVS | **SCT NL + SEPA, all channels (the common "salaris/incoming transfer")** |
| 8949 / 8948 | PMNT RRCT ESCT | IOS | Incoming SCT Instant |
| 2719 | PMNT RCDT ESCT | PCQ | Payconiq |
| 6853 | PMNT RCDT OTHR | BVZ | Payment request via iDEAL |
| 8845 | PMNT RCDT ESCT | ACC | Acceptgiro in |
| 8806 / 8877 / 2806 | PMNT RCDT ESCT | IDE | iDEAL in (NL/SEPA / within bank / batch) |
| 8783, 8872 | PMNT RCDT PRCT | OVS | Urgent payment in |
| 6761, 6768 | PMNT RCDT XBCT | OVS | Foreign non-SEPA in |
| 8706 / 8746 | PMNT RCDT STDO | POV | Standing order in |
| 8749 | PMNT ICDT RRTN | RTI | SCT return received |
| 2700 / 2701 | RCDT AUTT / CAMT ACCB TOPG | POV | automated own-account |
| 8200 | SECU SETT TRAD | EFF | Securities sale |
| 2050 | PMNT RCDT BOOK | KAS | closure -> from closed account |
| 0001 | PMNT CNTR BCDP | KAS | Cash deposit RegioBank office |

### Cards (all Type BEA/GEA unless noted); debit = 7xxx or 9xxx, credit correction = 6xxx or 8xxx
| Code(s) | ISO | Type | Meaning |
|---|---|---|---|
| 7903/9903, 7913/9913 | CCRD POSD | BEA | POS NL Maestro / V PAY |
| 7904/9904, 7914/9914 | CCRD POSD | BEA | POS EU Maestro / V PAY |
| 7905/9905, 7915/9915 | CCRD POSD | BEA | POS World Maestro / V PAY |
| 7906/9906, 7916/9916 | CCRD POSD | BEA | NFC/mobile NL Maestro / V PAY (**Apple Pay samples**) |
| 7907/9907, 7917/9917 | CCRD POSD | BEA | NFC EU |
| 7908/9908, 7918/9918 | CCRD POSD | BEA | NFC World |
| 7923/9923, 7926/9926 | CCRD POSD | OVS | Card-not-present NL Mastercard / **VISA** |
| 7924/9924, 7927/9927 | CCRD POSD | OVS | CNP EU Mastercard / VISA |
| 7925/9925, 7928/9928 | CCRD POSD | OVS | CNP World Mastercard / VISA |
| 7909/9909, 7920/9920 | CCRD RIMB | RTI | POS refund (debit side) |
| 6909/8909, 6920/8920 | CCRD RIMB | RTI | POS refund (credit) |
| 6903-6905 / 8903-8905, 6913-6915 / 8913-8915 | CCRD POSD | BEA | POS credit corrections |
| 6906-6908, 6916-6918 (/8xxx) | CCRD POSD | BEA | NFC credit corrections |
| 6923-6928 (/8923-8928) | CCRD POSD | OVS | CNP credit corrections |
| 7900/9900, 7910/9910 | CCRD CWDL | GEA | ATM NL Maestro / V PAY |
| 7901/9901, 7911/9911 | CCRD XBCW | GEA | ATM EU |
| 7902/9902, 7912/9912 | CCRD XBCW | GEA | ATM World |
| 7017 | CCRD CWDL | GEA | Geldmaat withdrawal |
| 6017 | CCRD CDPT | GEA | Geldmaat deposit |
| 6900-6902, 6910-6912 (/8xxx) | CCRD CWDL / XBCW | GEA | ATM credit corrections |
| 1003 / 7008 | CCRD CWDL | GEA | ATM SNS |
| 1002 | CNTR BCWD | KAS | Cash withdrawal RegioBank office |

Pairing 79xx vs 99xx: B does not explain the difference; plausible = old vs new processing platform **[U]**.

### Interest, charges (Type AFB/BIJ/MSC; domain ACMT MDOP debit / MCOP credit)
7606 interest accrued (debit, AFB), 6607 (credit, BIJ); 7600/6600 capitalised (MSC); 7602/6602 to other account; 7225 correction; 7241 commissie rekeninggebruik, 7260 "Basis Bankieren" commissie; 7227 card usage charges; 7921/9921 ATM charges; 7922/9922 POS charges (BEA); 7264 Geldmaat deposit charges; 7228 non-SEPA charges; 7236 paper statement; 7240 paper transfers; 7263 branch payment; business: 7614-7643, 7259-7262, 7615/7617/7627/7628, 7734-7741. 6230 corrections (ACMT MCOP ADJT AFB). 6303/6305/8303 zero-amount information postings (Type NUL) **[V]**.

## 4. ISO 20022 BankTransactionCode (Dutch retail)

Source: ISO external code sets https://www.iso20022.org/catalogue-messages/additional-content-messages/external-code-sets ; ING NL annex (code labels, verified in text) https://assets.ing.com/m/3235595966a614f9/original/Codification-Annex-ING-update-2026-03-02.pdf ; usage by ASN in B.

| Family | Meaning | Direction on own account |
|---|---|---|
| ICDT | Issued credit transfer | debit (money out) **[V]** |
| RCDT | Received credit transfer | credit (money in) **[V]** |
| IRCT / RRCT | Issued / Received instant credit transfer (newer ISO version; ASN uses RRCT for incoming instant, IRCT outgoing) | out / in **[V in B]** |
| RDDT | Received direct debit (debtor side: money out) | debit **[V in B: 9714]** |
| IDDT | Issued direct debit (creditor side) | credit; ASN also uses it for returns **[V in B]** |
| CCRD | Customer card transactions | both |
| CNTR | Counter transactions (branch) | both |
| Subfamily | Meaning |
|---|---|
| ESCT | SEPA credit transfer |
| ESDD | SEPA Core direct debit; BBDD = B2B DD; OODD = one-off DD; PMDD = direct debit (generic) |
| BOOK | Internal book transfer (own accounts / same bank) |
| STDO | Standing order |
| AUTT | Automatic transfer; SWEP/TOPG = sweeping / topping (cash pooling) |
| PRCT | Priority credit transfer (urgent) |
| XBCT | Cross-border credit transfer (non-SEPA) |
| RRTN | Reversal due to payment reject/return |
| UPDD, PRDD, RCDD | Unpaid DD (return); reversal; reversal due to cancellation request |
| POSD | POS payment (debit card) |
| CWDL / XBCW | Cash withdrawal / cross-border cash withdrawal |
| CDPT / BCDP / BCWD | Cash deposit / branch deposit / branch cash withdrawal |
| RIMB | Reimbursement (card refund) |
| CHRG | Charges |
| INTR (ACMT/MDOP, MCOP) | Interest (domain ACMT = account management; MDOP debit op., MCOP credit op.) |
| ADJT | Adjustments |
| NTAV (ACMT OTHR) | Not available / info posting |
Labels for ESCT, BOOK, POSD, CWDL etc. verified in ING annex **[V]**; ACMT/MDOP/MCOP/SWEP/TOPG/ACCB/SECU/SETT/TRAD/NTAV glosses are my knowledge **[K]**. Remember ISO Domain+Family+Sub are only a coarse view: ASN's 4-digit Prtry code is far more specific (card scheme, geo, channel), so key classification on Prtry first.

## 5. MCC list (ISO 18245)

| Source | Licence | Format | Verdict |
|---|---|---|---|
| https://github.com/greggles/mcc-codes | **Unlicense** (public domain) **[V]** (GitHub page) | `mcc_codes.csv`, `mcc_codes.json`, `.small.json`, `.jsonl`; fields mcc, edited_description, combined_description, usda_description, irs_description, irs_reportable | Best choice; use `edited_description` (English). |
| https://github.com/jleclanche/python-iso18245 (PyPI `iso18245`) | MIT **[K]**, from search result, not opened | Python package with the code database | Alternative |
| https://github.com/maximbilan/mcc | MIT **[K]** | Go package | n/a |

Caveat: the ISO 18245 standard itself is paid; the free lists are derived from USDA/IRS public descriptions, so descriptions are not an official ISO text. Dutch translations are not available there; Cents must translate itself.

In card descriptions the MCC appears as `MCC:5814` **[S]**; this is also the strongest classification signal.

## 6. Savings pots (spaarpotjes / spaardoelen)

**[U] Not verified.** No ASN documentation found about "spaarpotjes" appearing in exports, and no description examples of transfers between betaal- and spaarrekening. What can be said:
- Transfers betaal <-> spaar between own ASN accounts are PMNT ICDT/RCDT **BOOK** with Type **NGI** (internet/app), codes **3724 (out) / 2724 (in)**, NGM 3754/2754 (mobile) **[V]** (B). The user's samples include 2724 and 3724, consistent **[S]**.
- Periodic ones use 3700/2700 (Type POV, AUTT) or standing order 9802/8706/8746 **[V]**.
- ASN Sparen: deposits via (periodic) transfer; withdrawals via transfer to linked own account (savings terms https://www.asnbank.nl/downloads/voorwaarden-asn-sparen-1.html) **[V]**. Since Dec 2025 a savings account no longer requires a payment account (per search summary) **[K]**.
- Whether the pot/goal name is put in Omschrijving: **unknown**. Check on the user's own sample (only the user may decide to open it). Safe approach: classify as internal transfer by (own IBAN in Van/naar, Code 2724/3724/2754/3754) regardless of description.

## 7. "Categorie" values

- A documents only the field (X(40), "assigned category of the booking") and does not list values **[V]**; no official list found **[U]**. ASN app manual (https://asnbank.nl/downloads/asn-app-en-online-bankieren-handleiding.html) mentions "Inzicht in je geld / Bekijk per categorie" and auto-assignment with user correction, but the PDF text could not be extracted **[U]**.
- The 27 values the user listed (Bankkosten ... Zak- & kleedgeld) are **[S]** only; no source to confirm completeness. Treat them as an open set, map unknown strings to "Overig", and never rely on them as ground truth (they are the bank's own heuristic). Note A's example has a comma-separated string, so a Categorie field may in theory hold more than one value.

## Could not verify
Old 19-col headerless format; the meaning of Adres/Postcode/Woonplaats columns; whether pot names appear; full ASN category list; why 79xx vs 99xx; CAMT.053 spec details (source C not read); licence of python-iso18245/maximbilan (taken from search summary).
