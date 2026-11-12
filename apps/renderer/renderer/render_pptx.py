"""The pptx of a document: on the template, with its masters, layouts and theme kept; its slides
are replaced by a title slide, a slide per section with the layout the recipe declares, and a
slide for the notes."""

from __future__ import annotations

from io import BytesIO

from pptx import Presentation
from pptx.enum.shapes import PP_PLACEHOLDER
from pptx.util import Emu, Inches, Pt

from . import content, properties
from .content import Run
from .errors import Refusal

TITLE_LAYOUT = "Title Slide"
SECTION_LAYOUT = "Title and Content"
NOTES_LAYOUT = "Title and Content"
BODY_TYPES = {PP_PLACEHOLDER.BODY, PP_PLACEHOLDER.OBJECT}


def _layout(prs, name: str):
    for layout in prs.slide_layouts:
        if layout.name == name:
            return layout
    return None


def _fallback_layout(prs, name: str):
    found = _layout(prs, name)
    if found is not None:
        return found
    layouts = list(prs.slide_layouts)
    if not layouts:
        raise Refusal("layout", "layout_slide_layout_missing")
    return layouts[min(1, len(layouts) - 1)] if name != TITLE_LAYOUT else layouts[0]


def _remove_slides(prs) -> None:
    ids = prs.slides._sldIdLst
    for sld_id in list(ids):
        prs.part.drop_rel(sld_id.rId)
        ids.remove(sld_id)


def _set_title(slide, title: str, prs) -> None:
    if slide.shapes.title is not None:
        slide.shapes.title.text = title
        return
    box = slide.shapes.add_textbox(Inches(0.5), Inches(0.3), prs.slide_width - Inches(1), Inches(1))
    box.text_frame.text = title
    box.text_frame.paragraphs[0].runs[0].font.size = Pt(28)


def _content_area(slide, prs) -> tuple[int, int, int, int]:
    """The box of the body placeholder, which is removed; a default box when there is none."""
    for shape in slide.placeholders:
        if shape.placeholder_format.type in BODY_TYPES:
            area = (shape.left, shape.top, shape.width, shape.height)
            shape._element.getparent().remove(shape._element)
            if None not in area:
                return area  # type: ignore[return-value]
    return (Inches(0.5), Inches(1.5), prs.slide_width - Inches(1), prs.slide_height - Inches(2))


def _drop_empty_placeholders(slide) -> None:
    for shape in list(slide.placeholders):
        if shape.placeholder_format.type == PP_PLACEHOLDER.TITLE:
            continue
        if shape.has_text_frame and shape.text_frame.text == "":
            shape._element.getparent().remove(shape._element)


def _write_runs(paragraph, runs: list[Run]) -> None:
    for r in runs:
        if r.text:
            paragraph.add_run().text = r.text
        if r.notes:
            note = paragraph.add_run()
            note.text = r.notes
            note.font._rPr.set("baseline", "30000")


def _text_box(slide, area, lines: list[list[Run]]) -> None:
    left, top, width, height = area
    frame = slide.shapes.add_textbox(left, top, width, height).text_frame
    frame.word_wrap = True
    for i, line in enumerate(lines):
        paragraph = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        _write_runs(paragraph, line)
        for run in paragraph.runs:
            run.font.size = Pt(14)


def _table(slide, area, document: dict, block: dict) -> None:
    left, top, width, height = area
    rows = content.table_rows(document, block)
    columns = block["columns"]
    shape = slide.shapes.add_table(1 + len(rows), len(columns), left, top, width, height)
    table = shape.table
    for c, column in enumerate(columns):
        table.cell(0, c).text = column["title"]
    for r, row in enumerate(rows, start=1):
        for c, run in enumerate(row[: len(columns)]):
            frame = table.cell(r, c).text_frame
            _write_runs(frame.paragraphs[0], [run])
    for row in table.rows:
        for cell in row.cells:
            for paragraph in cell.text_frame.paragraphs:
                for run in paragraph.runs:
                    run.font.size = Pt(11)


def _section_slide(prs, layout, title: str, lines: list[list[Run]], tables, document) -> None:
    slide = prs.slides.add_slide(layout)
    _set_title(slide, title, prs)
    left, top, width, height = _content_area(slide, prs)
    _drop_empty_placeholders(slide)
    parts = (1 if lines else 0) + len(tables)
    if parts == 0:
        return
    step = Emu(int(height / parts))
    y = top
    if lines:
        _text_box(slide, (left, y, width, step), lines)
        y += step
    for block in tables:
        _table(slide, (left, y, width, step), document, block)
        y += step


def render(document: dict, template: bytes, layout: dict) -> bytes:
    prs = Presentation(BytesIO(template))
    declared = {s["section"]: s["slideLayout"] for s in layout["sections"] if "slideLayout" in s}
    for name in declared.values():
        if _layout(prs, name) is None:
            raise Refusal("layout", "layout_slide_layout_missing")
    _remove_slides(prs)

    title_slide = prs.slides.add_slide(_fallback_layout(prs, TITLE_LAYOUT))
    _set_title(title_slide, document["title"], prs)
    for shape in title_slide.placeholders:
        if shape.placeholder_format.type == PP_PLACEHOLDER.SUBTITLE:
            shape.text_frame.text = content.header_line(document)
            break
    else:
        box = title_slide.shapes.add_textbox(
            Inches(0.5), prs.slide_height - Inches(1.2), prs.slide_width - Inches(1), Inches(0.6)
        )
        box.text_frame.text = content.header_line(document)
    _drop_empty_placeholders(title_slide)

    for section in document["sections"]:
        name = declared.get(section["id"])
        slide_layout = _layout(prs, name) if name else _fallback_layout(prs, SECTION_LAYOUT)
        lines: list[list[Run]] = []
        if section["notDeduced"]:
            lines.append([Run(content.text(document, "not_deduced"))])
        tables = []
        for block in section["blocks"]:
            if block["kind"] == "table":
                tables.append(block)
                continue
            if block.get("title"):
                lines.append([Run(block["title"])])
            lines.extend(content.block_runs(document, block))
        _section_slide(prs, slide_layout, section["title"], lines, tables, document)

    notes_layout = _fallback_layout(prs, NOTES_LAYOUT)
    if document["sourceNotes"]:
        lines = [[Run(line)] for line in content.note_lines(document)]
        _section_slide(prs, notes_layout, content.text(document, "sources"), lines, [], document)
    if document["internalNotes"]:
        lines = [content.segment_runs([n]) for n in document["internalNotes"]]
        title = content.text(document, "internal_notes")
        _section_slide(prs, notes_layout, title, lines, [], document)

    properties.reset_office(prs.core_properties, prs.part.package, document)
    out = BytesIO()
    prs.save(out)
    return out.getvalue()
