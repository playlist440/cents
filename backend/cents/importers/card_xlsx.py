"""Creditcard-invulbestand: a tiny Excel file the family fills in by hand (credit-card purchases
that no bank export gives) and imports like any other file.

Sheet "Creditcard": Datum | Winkel | Bedrag | Bakje (mag leeg). One row per purchase; a positive
amount is a purchase, a negative amount money back. `template()` writes the file (stdlib only:
a minimal SpreadsheetML package), `looks_like()` / `parse()` read it back.
"""

from __future__ import annotations

import io
import re
import zipfile
from xml.sax.saxutils import escape

from . import ImportFormatError
from .etoro import num, when

SHEET = "creditcard"
HEADER = ("datum", "winkel", "bedrag")
ROWS = 500                       # rows prepared with formats and the bakje list


def looks_like(workbook: dict[str, list[list]]) -> bool:
    rows = workbook.get(SHEET) or []
    head = [str(v or "").strip().lower() for v in (rows[0] if rows else [])]
    return tuple(head[:3]) == HEADER


def _cents(v) -> int | None:
    x = num(re.sub(r"[€\s]", "", v) if isinstance(v, str) else v)
    return None if x is None else int(round(x * 100))


def parse(workbook: dict[str, list[list]]) -> list[dict]:
    """[{date, name, amount_cents (negative = purchase), bakje}] in file order. Empty rows are
    skipped; a row with a missing or unreadable date or amount is an error with its row number."""
    out = []
    for n, row in enumerate((workbook.get(SHEET) or [])[1:], start=2):
        cells = list(row) + [None] * 4
        day, name, amount, bakje = cells[:4]
        if all(v in (None, "") for v in (day, name, amount)):
            continue
        d = when(day)
        if d is None:
            raise ImportFormatError(f"Rij {n}: de datum '{day}' kan ik niet lezen. Gebruik bijvoorbeeld 14-11-2026.")
        cents = _cents(amount)
        if cents is None or cents == 0:
            raise ImportFormatError(f"Rij {n}: vul een bedrag in, bijvoorbeeld 12,50.")
        name = str(name or "").strip()
        if not name:
            raise ImportFormatError(f"Rij {n}: vul de winkel in.")
        out.append({"date": d[0], "name": name[:120], "amount_cents": -cents,
                    "bakje": str(bakje).strip() if bakje not in (None, "") else None})
    if not out:
        raise ImportFormatError("Het creditcard-invulbestand is nog leeg.")
    return out


# ---------------------------------------------------------------- writing the template

def _col(i: int) -> str:
    return "ABCDEFGHIJ"[i]


def _cell(ref: str, value: str, style: int = 0) -> str:
    return f'<c r="{ref}" t="inlineStr"{f" s={chr(34)}{style}{chr(34)}" if style else ""}><is><t xml:space="preserve">{escape(value)}</t></is></c>'


def _sheet(rows: list[list[str]], *, cols: str = "", extra: str = "", pane: str = "", styles: dict | None = None) -> str:
    body = []
    for r, row in enumerate(rows, start=1):
        cells = "".join(_cell(f"{_col(i)}{r}", v, (styles or {}).get((r, i), 0)) for i, v in enumerate(row) if v != "")
        body.append(f'<row r="{r}">{cells}</row>')
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f'<sheetViews><sheetView workbookViewId="0">{pane}</sheetView></sheetViews>'
            f'{cols}<sheetData>{"".join(body)}</sheetData>{extra}</worksheet>')


def template(bakjes: list[str]) -> bytes:
    """The invulbestand: sheet Creditcard (header, date and euro formats on the first ROWS rows,
    a bakje drop-down), sheet Uitleg, and a hidden sheet with the bakje names."""
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
              '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd-mm-yyyy"/>'
              '<numFmt numFmtId="165" formatCode="&quot;€&quot; #,##0.00"/></numFmts>'
              '<fonts count="2"><font><sz val="12"/><name val="Calibri"/></font>'
              '<font><b/><sz val="12"/><name val="Calibri"/></font></fonts>'
              '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
              '<fill><patternFill patternType="solid"><fgColor rgb="FFE8F5E9"/></patternFill></fill></fills>'
              '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
              '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
              '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
              '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'   # 1 header
              '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'      # 2 date
              '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'      # 3 euro
              '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'      # 4 bold
              '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
              '</styleSheet>')
    header = ["Datum", "Winkel", "Bedrag", "Bakje (mag leeg)"]
    styled_rows = "".join(f'<row r="{r}"><c r="A{r}" s="2"/><c r="C{r}" s="3"/></row>' for r in range(2, ROWS + 1))
    head_cells = "".join(_cell(f"{_col(i)}1", v, 1) for i, v in enumerate(header))
    card = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheetViews><sheetView workbookViewId="0" tabSelected="1"><pane ySplit="1" topLeftCell="A2" '
            'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
            '<cols><col min="1" max="1" width="13" customWidth="1"/><col min="2" max="2" width="32" customWidth="1"/>'
            '<col min="3" max="3" width="13" customWidth="1"/><col min="4" max="4" width="24" customWidth="1"/></cols>'
            f'<sheetData><row r="1">{head_cells}</row>{styled_rows}</sheetData>'
            '<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="0" '
            f'sqref="D2:D{ROWS}"><formula1>Bakjes!$A$1:$A${max(1, len(bakjes))}</formula1></dataValidation></dataValidations>'
            '</worksheet>')
    uitleg_rows = [
        ["Zo vul je het in"],
        ["Eén regel per aankoop met de creditcard."],
        ["Datum: de dag van de aankoop, bijvoorbeeld 14-11-2026."],
        ["Winkel: de naam zoals je hem kent, bijvoorbeeld Bol.com of Booking."],
        ["Bedrag: wat je betaalde, bijvoorbeeld 12,50. Geld terug? Zet er een min voor: -12,50."],
        ["Bakje: mag leeg. Cents kiest dan zelf, of je sorteert het later in de app."],
        [""],
        ["Importeren"],
        ["Sla het bestand op en sleep het in Cents (Importeren). Je kunt hetzelfde bestand elke maand aanvullen"],
        ["en opnieuw importeren: Cents voegt alleen nieuwe regels toe. Een regel die je verandert of weghaalt,"],
        ["past Cents aan voor de periode die in het bestand staat."],
        ["De maandelijkse afschrijving van de creditcard telt niet dubbel: Cents ziet dat die aankopen al zijn geteld."],
    ]
    uitleg = _sheet(uitleg_rows, cols='<cols><col min="1" max="1" width="110" customWidth="1"/></cols>',
                    styles={(1, 0): 4, (8, 0): 4})
    lists = _sheet([[b] for b in bakjes] or [[""]])
    files = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            + "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in (1, 2, 3))
            + '</Types>'),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>'),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
            '<sheet name="Creditcard" sheetId="1" r:id="rId1"/><sheet name="Uitleg" sheetId="2" r:id="rId2"/>'
            '<sheet name="Bakjes" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>'),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in (1, 2, 3))
            + '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            '</Relationships>'),
        "xl/styles.xml": styles,
        "xl/worksheets/sheet1.xml": card,
        "xl/worksheets/sheet2.xml": uitleg,
        "xl/worksheets/sheet3.xml": lists,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, xml in files.items():
            zf.writestr(name, xml)
    return buf.getvalue()
