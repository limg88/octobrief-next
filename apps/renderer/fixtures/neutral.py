"""Generates the neutral templates of the library, without data or logos: a document, a
presentation, a workbook and the SAL form, whose cell names are fixed here and exported by the core
as `SAL_CELL_NAMES` (a test checks that both say the same). Runs in the test image of the renderer:
`pnpm templates:neutral`. The letterhead is not generated: the Admin uploads it in the app."""

from __future__ import annotations

import sys
from datetime import UTC, datetime
from pathlib import Path

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.workbook.defined_name import DefinedName
from pptx import Presentation
from pptx.util import Inches

AUTHOR = "Octobrief"
CREATED = datetime(2026, 11, 6, tzinfo=UTC)

# The cells of the SAL form: (name, label, cell). Columns of the positions start on row 15.
SAL_VALUES = [
    ("order_number", "Numero d'ordine", "C4"),
    ("order_date", "Data dell'ordine", "C5"),
    ("order_customer", "Cliente", "C6"),
    ("order_total", "Totale dell'ordine", "C7"),
    ("request_number", "Numero della richiesta", "C9"),
    ("request_period", "Periodo", "C10"),
    ("request_amount", "Importo richiesto", "C11"),
    ("requested_to_date", "Fatturato a oggi", "C12"),
    ("remaining_amount", "Residuo", "C13"),
]
SAL_COLUMNS = [
    ("position_item", "Posizione", "B"),
    ("position_amount", "Importo", "C"),
    ("position_previous_pct", "% precedente", "D"),
    ("position_current_pct", "% attuale", "E"),
    ("position_period_pct", "% di periodo", "F"),
    ("position_period_amount", "Importo di periodo", "G"),
]
SAL_HEADER_ROW = 15


def _page_field(paragraph) -> None:
    """A footer «Pagina N»: an inert simple field, as a template may have."""
    paragraph.add_run("Pagina ")
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), " PAGE ")
    run = OxmlElement("w:r")
    text = OxmlElement("w:t")
    text.text = "1"
    run.append(text)
    field.append(run)
    paragraph._p.append(field)


def docx(path: Path) -> None:
    doc = Document()
    props = doc.core_properties
    props.author = props.last_modified_by = AUTHOR
    props.title = props.comments = props.subject = props.keywords = ""
    props.created = props.modified = CREATED
    props.revision = 1
    doc.styles["Normal"].font.size = Pt(11)
    section = doc.sections[0]
    _page_field(section.footer.paragraphs[0])
    doc.save(path)


def pptx(path: Path) -> None:
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    props = prs.core_properties
    props.author = props.last_modified_by = AUTHOR
    props.title = props.subject = props.keywords = props.comments = ""
    props.created = props.modified = CREATED
    props.revision = 1
    prs.save(path)


def _workbook() -> Workbook:
    wb = Workbook()
    props = wb.properties
    props.creator = props.lastModifiedBy = AUTHOR
    props.created = props.modified = CREATED.replace(tzinfo=None)
    return wb


def xlsx(path: Path) -> None:
    wb = _workbook()
    ws = wb.active
    ws.title = "Documento"
    ws.column_dimensions["A"].width = 100
    ws.oddFooter.center.text = "Pagina &P di &N"
    wb.save(path)


def sal(path: Path) -> None:
    wb = _workbook()
    ws = wb.active
    ws.title = "SAL"
    ws.oddFooter.center.text = "Pagina &P di &N"
    ws["B2"] = "Stato di avanzamento lavori"
    ws["B2"].font = Font(bold=True, size=14)
    ws.column_dimensions["B"].width = 28
    for column in "CDEFG":
        ws.column_dimensions[column].width = 20
    bold = Font(bold=True)
    thin = Side(style="thin", color="999999")
    for name, label, ref in SAL_VALUES:
        row = int(ref[1:])
        ws.cell(row=row, column=2, value=label).font = bold
        ws[ref].border = Border(bottom=thin)
        wb.defined_names[name] = DefinedName(name, attr_text=f"'SAL'!${ref[0]}${ref[1:]}")
    fill = PatternFill("solid", fgColor="E7E6E6")
    for name, label, column in SAL_COLUMNS:
        header = ws[f"{column}{SAL_HEADER_ROW}"]
        header.value = label
        header.font = bold
        header.fill = fill
        header.alignment = Alignment(wrap_text=True)
        first = SAL_HEADER_ROW + 1
        wb.defined_names[name] = DefinedName(name, attr_text=f"'SAL'!${column}${first}")
    wb.save(path)


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    docx(out / "neutro-docx.docx")
    pptx(out / "neutro-pptx.pptx")
    xlsx(out / "neutro-xlsx.xlsx")
    sal(out / "modulo-sal.xlsx")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
