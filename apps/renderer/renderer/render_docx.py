"""The docx of a document: on the template, with its styles, header and footer kept; its body is
replaced by the title, a heading per section, the blocks, the numbered notes."""

from __future__ import annotations

from io import BytesIO

from docx import Document
from docx.oxml.ns import qn

from . import content, properties
from .content import Run
from .errors import Refusal

SECTION_STYLE = "Heading 1"
BLOCK_TITLE_STYLE = "Heading 2"


def _style(doc, name: str):
    try:
        return doc.styles[name]
    except KeyError:
        return None


def section_styles(layout: dict) -> dict[str, str]:
    """The heading style of each section that the layout names."""
    return {s["section"]: s["style"] for s in layout["sections"] if "style" in s}


def heading_style_names(layout: dict) -> set[str]:
    """Every style a heading of a section (or of the notes) may have in the file."""
    return {SECTION_STYLE, *section_styles(layout).values()}


def _runs(paragraph, runs: list[Run]) -> None:
    for r in runs:
        if r.text:
            paragraph.add_run(r.text)
        if r.notes:
            paragraph.add_run(r.notes).font.superscript = True


def render(document: dict, template: bytes, layout: dict) -> bytes:
    doc = Document(BytesIO(template))
    body = doc.element.body
    # The body of the template goes; its last section properties (header, footer, page) stay.
    for child in list(body):
        if child.tag != qn("w:sectPr"):
            body.remove(child)

    styles = section_styles(layout)
    for name in styles.values():
        if _style(doc, name) is None:
            raise Refusal("layout", "layout_style_missing")
    if _style(doc, SECTION_STYLE) is None:
        raise Refusal("layout", "layout_style_missing")
    headings = heading_style_names(layout)
    block_title = BLOCK_TITLE_STYLE if BLOCK_TITLE_STYLE not in headings else None
    if block_title is not None and _style(doc, block_title) is None:
        block_title = None
    title_style = "Title" if _style(doc, "Title") is not None else None
    subtitle_style = "Subtitle" if _style(doc, "Subtitle") is not None else None
    list_style = "List Bullet" if _style(doc, "List Bullet") is not None else None
    table_style = "Table Grid" if _style(doc, "Table Grid") is not None else None

    title = doc.add_paragraph(style=title_style)
    run = title.add_run(document["title"])
    if title_style is None:
        run.bold = True
    doc.add_paragraph(content.header_line(document), style=subtitle_style)

    for section in document["sections"]:
        doc.add_paragraph(section["title"], style=styles.get(section["id"], SECTION_STYLE))
        if section["notDeduced"]:
            doc.add_paragraph(content.text(document, "not_deduced"))
        for block in section["blocks"]:
            heading = block.get("title")
            if heading:
                p = doc.add_paragraph(style=block_title)
                r = p.add_run(heading)
                if block_title is None:
                    r.bold = True
            if block["kind"] == "table":
                _table(doc, document, block, table_style)
                continue
            for line in content.block_runs(document, block):
                if block["kind"] == "list":
                    p = doc.add_paragraph(style=list_style)
                    if list_style is None:
                        p.add_run("• ")
                else:
                    p = doc.add_paragraph()
                _runs(p, line)

    if document["sourceNotes"]:
        doc.add_paragraph(content.text(document, "sources"), style=SECTION_STYLE)
        for line in content.note_lines(document):
            doc.add_paragraph(line)
    if document["internalNotes"]:
        doc.add_paragraph(content.text(document, "internal_notes"), style=SECTION_STYLE)
        for note in document["internalNotes"]:
            _runs(doc.add_paragraph(), content.segment_runs([note]))

    properties.reset_office(doc.core_properties, doc.part.package, document)
    _drop_comments(doc)
    out = BytesIO()
    doc.save(out)
    return out.getvalue()


COMMENT_PARTS = ("/comments", "/commentsExtended", "/commentsIds", "/commentsExtensible")


def _drop_comments(doc) -> None:
    """The comments of the template went with its body: their parts go too."""
    for r_id, rel in list(doc.part.rels.items()):
        if rel.reltype.endswith(COMMENT_PARTS):
            doc.part.drop_rel(r_id)


def _table(doc, document: dict, block: dict, style: str | None) -> None:
    rows = content.table_rows(document, block)
    table = doc.add_table(rows=1 + len(rows), cols=len(block["columns"]))
    if style is not None:
        table.style = style
    for i, column in enumerate(block["columns"]):
        cell = table.rows[0].cells[i]
        cell.paragraphs[0].add_run(column["title"]).bold = True
    for r, row in enumerate(rows, start=1):
        for c, run in enumerate(row[: len(block["columns"])]):
            _runs(table.rows[r].cells[c].paragraphs[0], [run])
