"""The xlsx of a document. A form (the layout names cells) is filled through its named cells, the
name of a column being its first row, filled downward. Otherwise the texts go on the first sheet
of the template (or the sheet the layout declares for the section) and each table block becomes
a workbook table on a sheet of its own. The notes of a cell are a comment on it, listed on a
sheet of the sources."""

from __future__ import annotations

import re
from io import BytesIO

from openpyxl import load_workbook
from openpyxl.comments import Comment
from openpyxl.styles import Font
from openpyxl.utils.cell import coordinate_from_string, get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

from . import content, properties
from .content import Run
from .errors import Refusal

SHEET_TITLE_MAX = 31
_SHEET_FORBIDDEN = re.compile(r"[\[\]:*?/\\]")


def _literal(ws, row: int, column: int, value: str | None):
    """A cell that holds the text as text, never a formula, whatever it starts with (`=`, `@`)."""
    cell = ws.cell(row=row, column=column, value=value)
    if isinstance(value, str):
        cell.data_type = "s"
    return cell


def _write(ws, row: int, column: int, run: Run, document: dict) -> None:
    cell = _literal(ws, row, column, run.text)
    if run.notes:
        cell.comment = Comment(
            content.text(document, "sources_comment", numbers=run.notes), content.AUTHOR
        )


def _named_target(wb, name: str):
    """The sheet and cell a defined name points to, when it is a single cell."""
    defined = wb.defined_names.get(name)
    if defined is None:
        for ws in wb.worksheets:
            if name in ws.defined_names:
                defined = ws.defined_names[name]
                break
    if defined is None:
        return None
    destinations = list(defined.destinations)
    if len(destinations) != 1:
        return None
    sheet, ref = destinations[0]
    if sheet not in wb.sheetnames or ":" in ref:
        return None
    column, row = coordinate_from_string(ref.replace("$", ""))
    return wb[sheet], row, column


def _block(document: dict, block_id: str) -> dict | None:
    for section in document["sections"]:
        for block in section["blocks"]:
            if block["id"] == block_id:
                return block
    return None


def _fill_form(wb, document: dict, layout: dict) -> None:
    for named in layout["namedCells"]:
        target = _named_target(wb, named["name"])
        if target is None:
            raise Refusal("layout", "named_cell_missing")
        block = _block(document, named["block"])
        if block is None:
            raise Refusal("layout", "layout_unknown_block")
        ws, row, column_letter = target
        column = ws[f"{column_letter}{row}"].column
        if "column" in named:
            if block["kind"] not in ("table", "list"):
                raise Refusal("layout", "layout_unknown_block")
            ids = [c["id"] for c in block["columns"]]
            if named["column"] not in ids:
                raise Refusal("layout", "layout_unknown_block")
            index = ids.index(named["column"])
            rows = block["rows"] if block["kind"] == "table" else block["items"]
            for offset, item in enumerate(rows):
                run = content.cell_run(document, item["cells"][index])
                _write(ws, row + offset, column, run, document)
        elif block["kind"] == "value":
            _write(ws, row, column, content.cell_run(document, block["cell"]), document)
        else:
            lines = content.block_runs(document, block)
            _literal(ws, row, column, "\n".join(content.plain(li) for li in lines))


def _unique_title(wb, wanted: str) -> str:
    base = _SHEET_FORBIDDEN.sub(" ", wanted).strip().strip("'") or "Tabella"
    # Cut to the length Excel accepts, never ending on a quote: the gate refuses such a name.
    base = base[:SHEET_TITLE_MAX].rstrip(" '") or "Tabella"
    title, n = base, 2
    existing = {s.lower() for s in wb.sheetnames}
    while title.lower() in existing:
        suffix = f" ({n})"
        title = base[: SHEET_TITLE_MAX - len(suffix)] + suffix
        n += 1
    return title


def _next_row(ws) -> int:
    return 1 if ws.max_row == 1 and ws["A1"].value is None else ws.max_row + 2


def _table(wb, document: dict, block: dict, section: dict, n: int) -> None:
    ws = wb.create_sheet(_unique_title(wb, block.get("title") or section["title"]))
    headers: list[str] = []
    for column in block["columns"]:
        title, k = column["title"], 2
        while title in headers:
            title = f"{column['title']} ({k})"
            k += 1
        headers.append(title)
    for c, title in enumerate(headers, start=1):
        _literal(ws, 1, c, title).font = Font(bold=True)
    rows = content.table_rows(document, block)
    for r, row in enumerate(rows, start=2):
        for c, run in enumerate(row[: len(headers)], start=1):
            _write(ws, r, c, run, document)
    ref = f"A1:{get_column_letter(len(headers))}{1 + len(rows)}"
    table = Table(displayName=f"Tabella{n}", ref=ref)
    table.tableStyleInfo = TableStyleInfo(name="TableStyleLight9", showRowStripes=True)
    ws.add_table(table)


def _texts(wb, document: dict, layout: dict) -> None:
    sheets = {s["section"]: s["sheet"] for s in layout["sections"] if "sheet" in s}
    for name in sheets.values():
        if name not in wb.sheetnames:
            raise Refusal("layout", "layout_sheet_missing")
    first = wb.worksheets[0]
    row = _next_row(first)
    _literal(first, row, 1, document["title"]).font = Font(bold=True, size=14)
    _literal(first, row + 1, 1, content.header_line(document))
    tables = 0
    for section in document["sections"]:
        ws = wb[sheets[section["id"]]] if section["id"] in sheets else first
        row = _next_row(ws)
        _literal(ws, row, 1, section["title"]).font = Font(bold=True, size=12)
        row += 1
        if section["notDeduced"]:
            _literal(ws, row, 1, content.text(document, "not_deduced"))
            row += 1
        for block in section["blocks"]:
            if block["kind"] == "table":
                tables += 1
                _table(wb, document, block, section, tables)
                continue
            if block.get("title"):
                _literal(ws, row, 1, block["title"]).font = Font(bold=True)
                row += 1
            for line in content.block_runs(document, block):
                _literal(ws, row, 1, content.plain(line))
                row += 1
    if document["internalNotes"]:
        row = _next_row(first)
        title = content.text(document, "internal_notes")
        _literal(first, row, 1, title).font = Font(bold=True, size=12)
        for i, note in enumerate(document["internalNotes"], start=1):
            line = content.plain(content.segment_runs([note]))
            _literal(first, row + i, 1, line)


def _sources(wb, document: dict) -> None:
    if not document["sourceNotes"]:
        return
    ws = wb.create_sheet(_unique_title(wb, content.text(document, "sources")))
    for i, line in enumerate(content.note_lines(document), start=1):
        _literal(ws, i, 1, line)


def render(document: dict, template: bytes, layout: dict) -> bytes:
    wb = load_workbook(BytesIO(template), keep_vba=False, keep_links=False, rich_text=False)
    if layout["namedCells"]:
        _fill_form(wb, document, layout)
    else:
        _texts(wb, document, layout)
    _sources(wb, document)
    properties.reset_workbook(wb, document)
    out = BytesIO()
    wb.save(out)
    return out.getvalue()
