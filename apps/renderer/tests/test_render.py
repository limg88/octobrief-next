from __future__ import annotations

import base64
import copy
import re
from io import BytesIO
from zipfile import ZipFile

import pytest
from conftest import CORPUS, FORMATS, body, envelope, file_of, neutral, render_fixtures, texts_of
from docx import Document
from openpyxl import Workbook, load_workbook
from pptx import Presentation

from renderer import verify
from renderer.formula import is_sheet_name
from renderer.render_xlsx import _unique_title
from renderer.scan import inspect_package
from renderer.service import handle

CASES = [(name, fmt) for name in sorted(render_fixtures()) for fmt in FORMATS]


def failed(payload: dict) -> list[tuple[str, list[str]]]:
    return [(c["check"], c["findings"]) for c in payload["checks"] if not c["passed"]]


@pytest.mark.parametrize(("name", "fmt"), CASES)
def test_renders_every_shared_fixture_in_every_format_with_the_expected_counts(name, fmt):
    status, payload = handle(body(envelope(render_fixtures()[name], fmt)))
    assert failed(payload) == []
    assert status == 200
    assert payload["outcome"] == "rendered"
    checks = [c["check"] for c in payload["checks"]]
    for check in ("request", "document", "template", "opens", "active_content", "counts"):
        assert check in checks
    assert "template_parts" in checks
    data = file_of(payload)
    assert inspect_package(data, fmt).ok
    assert re.fullmatch(r"[0-9a-f]{64}", payload["sha256"])


def test_the_docx_keeps_the_styles_and_the_footer_of_the_template(status):
    _, payload = handle(body(envelope(status, "docx")))
    doc = Document(BytesIO(file_of(payload)))
    headings = [p.text for p in doc.paragraphs if p.style.name == "Heading 1"]
    assert headings == ["Sintesi", "Avanzamento per feature", "Rischi", "Fonti", "Note per il PM"]
    footer = doc.sections[0].footer.paragraphs[0]
    assert "Pagina" in footer.text
    assert len(doc.tables) == 1
    assert doc.tables[0].rows[0].cells[0].text == "Feature"


def test_shows_the_notes_of_a_segment_once(status):
    _, payload = handle(body(envelope(status, "docx")))
    doc = Document(BytesIO(file_of(payload)))
    paragraph = next(p for p in doc.paragraphs if p.text.startswith("Sono chiusi"))
    notes = [r.text for r in paragraph.runs if r.font.superscript]
    assert notes == ["1", "2"]
    assert doc.tables[0].rows[2].cells[1].text == "51"
    assert doc.tables[0].rows[2].cells[2].text == "non dedotto"


def test_writes_the_age_of_the_data_and_the_numbered_notes(status):
    _, payload = handle(body(envelope(status, "docx")))
    text = "\n".join(p.text for p in Document(BytesIO(file_of(payload))).paragraphs)
    assert "Dati al 05/11/2026 09:00, generato il 06/11/2026 10:30" in text
    assert "1. Tracker del progetto, conteggi, dati al 05/11/2026 09:00" in text
    assert "2. Verbale della riunione di avanzamento" in text


@pytest.mark.parametrize("fmt", FORMATS)
def test_never_writes_ids_or_places_of_the_sources(status, fmt):
    _, payload = handle(body(envelope(status, fmt)))
    text = texts_of(file_of(payload))
    for internal in ("src-tracker", "ev-7", "by_feature", "work_item_counts"):
        assert internal not in text


@pytest.mark.parametrize("fmt", FORMATS)
def test_the_client_file_has_no_internal_note_section(sal, fmt):
    _, payload = handle(body(envelope(sal, fmt)))
    assert "Note per il PM" not in texts_of(file_of(payload))


def test_writes_a_client_note_as_it_is_without_repeating_its_day(sal):
    document = copy.deepcopy(sal["document"])
    document["sourceNotes"][1]["label"] = "Sistema amministrativo, dati al 05/11/2026"
    _, payload = handle(body({**envelope(sal, "docx"), "document": document}))
    text = "\n".join(p.text for p in Document(BytesIO(file_of(payload))).paragraphs)
    assert "2. Sistema amministrativo, dati al 05/11/2026" in text
    assert "dati al 05/11/2026, dati al" not in text


def test_the_pptx_has_a_slide_per_section_with_the_declared_layout(sal):
    _, payload = handle(body(envelope(sal, "pptx")))
    prs = Presentation(BytesIO(file_of(payload)))
    layouts = [s.slide_layout.name for s in prs.slides]
    assert layouts == [
        "Title Slide",
        "Title and Content",
        "Title and Content",
        "Title Only",
        "Title and Content",
    ]
    titles = [s.shapes.title.text for s in prs.slides]
    assert titles[1:4] == ["Dati dell'ordine", "Richiesta di SAL", "Avanzamento per posizione"]


def test_fills_the_named_cells_of_the_sal_form(sal):
    _, payload = handle(body(envelope(sal, "xlsx")))
    wb = load_workbook(BytesIO(file_of(payload)))
    ws = wb["SAL"]
    assert ws["C4"].value == "ORD-0042"
    assert ws["C7"].value == "40.000,00 €"
    assert ws["C13"].value == "non dedotto"
    assert [ws[f"B{r}"].value for r in (16, 17)] == ["Analisi", "Sviluppo"]
    assert [ws[f"G{r}"].value for r in (16, 17)] == ["0,00 €", "8.000,00 €"]
    assert ws["C11"].comment.text == "Fonti: 1,3"
    assert "Fonti" in wb.sheetnames


@pytest.mark.parametrize(
    "wanted", ["x" * 30 + "'abc", "'Rischi'", "a/b[c]:d", "x" * 29 + " ' ' z", "''"]
)
def test_names_a_sheet_only_as_excel_and_the_gate_accept(wanted):
    title = _unique_title(Workbook(), wanted)
    assert is_sheet_name(title), title


def test_makes_a_workbook_table_per_table_block(status):
    _, payload = handle(body(envelope(status, "xlsx")))
    wb = load_workbook(BytesIO(file_of(payload)))
    assert wb.sheetnames == ["Documento", "Feature", "Fonti"]
    assert list(wb["Feature"].tables) == ["Tabella1"]
    first = [c.value for c in wb["Documento"]["A"] if c.value]
    assert first[0] == "Stato del progetto Aurora"
    assert "Rischi" in first


def test_a_count_other_than_the_expected_one_is_a_failed_check_without_file(status):
    request = envelope(status, "docx")
    request["expected"]["tables"] = 2
    code, payload = handle(body(request))
    assert code == 422
    assert payload == {"outcome": "refused", "checks": payload["checks"]}
    assert "file" not in payload
    assert failed(payload) == [("counts", ["count_mismatch"])]


@pytest.mark.parametrize(
    ("file", "finding"),
    [
        ("macro-project.docx", "template_macro"),
        ("external-link.docx", "template_external_link"),
        ("ole-object.pptx", "template_embedded_object"),
        ("bomb.docx", "template_expanded_too_large"),
    ],
)
def test_refuses_a_hostile_template_without_rendering(status, file, finding):
    fmt = file.rsplit(".", 1)[1]
    code, payload = handle(body(envelope(status, fmt, (CORPUS / file).read_bytes())))
    assert code == 422
    assert "file" not in payload
    [(check, findings)] = failed(payload)
    assert check == "template"
    assert finding in findings
    assert payload["checks"][-1]["subject"] == "template"


def test_refuses_an_invalid_document_before_the_template(status):
    request = envelope(status, "docx")
    request["document"]["audience"] = "client"
    code, payload = handle(body(request))
    assert code == 422
    assert failed(payload) == [("document", ["document_invalid"])]


def test_refuses_a_request_it_cannot_read():
    for raw in (b"{", b"[]", b'{"document": {}}', "é".encode("latin-1")):
        code, payload = handle(raw)
        assert code == 400
        assert failed(payload) == [("request", ["request_invalid"])]


def test_refuses_a_template_that_is_not_base64(status):
    request = envelope(status, "docx")
    request["template"]["data"] = "non è base64!"
    assert handle(body(request))[0] == 400


@pytest.mark.parametrize(
    ("fmt", "entry", "finding"),
    [
        ("docx", {"section": "summary", "style": "Stile inesistente"}, "layout_style_missing"),
        (
            "pptx",
            {"section": "summary", "slideLayout": "Nessun layout"},
            "layout_slide_layout_missing",
        ),
        ("xlsx", {"section": "summary", "sheet": "Nessun foglio"}, "layout_sheet_missing"),
    ],
)
def test_refuses_a_layout_the_template_does_not_have(status, fmt, entry, finding):
    request = envelope(status, fmt)
    request["template"]["layout"]["sections"] = [entry]
    code, payload = handle(body(request))
    assert code == 422
    assert failed(payload) == [("layout", [finding])]


def test_refuses_a_named_cell_the_template_does_not_have(sal):
    request = envelope(sal, "xlsx", neutral("neutro-xlsx"))
    code, payload = handle(body(request))
    assert code == 422
    assert failed(payload) == [("layout", ["named_cell_missing"])]


def test_refuses_a_named_cell_of_a_block_the_document_does_not_have(sal):
    request = envelope(sal, "xlsx")
    request["template"]["layout"]["namedCells"][0]["block"] = "missing"
    assert failed(handle(body(request))[1]) == [("layout", ["layout_unknown_block"])]


def test_a_changed_header_footer_or_image_of_the_template_is_a_failed_check(status):
    template = inspect_package(neutral("neutro-docx"), "docx").parts
    _, payload = handle(body(envelope(status, "docx")))
    produced = inspect_package(file_of(payload), "docx").parts
    assert verify.template_parts_unchanged("docx", template, produced)
    footer = next(n for n in produced if re.match(r"^word/footer\d*\.xml$", n))
    changed = dict(produced)
    changed[footer] = produced[footer].replace(b"Pagina", b"Pag.")
    assert not verify.template_parts_unchanged("docx", template, changed)
    missing = {n: d for n, d in produced.items() if n != footer}
    assert not verify.template_parts_unchanged("docx", template, missing)


def test_a_changed_master_of_the_presentation_is_a_failed_check(sal):
    template = inspect_package(neutral("neutro-pptx"), "pptx").parts
    _, payload = handle(body(envelope(sal, "pptx")))
    produced = inspect_package(file_of(payload), "pptx").parts
    assert verify.template_parts_unchanged("pptx", template, produced)
    master = next(n for n in produced if n.startswith("ppt/slidemasters/") and n.endswith(".xml"))
    changed = {
        **produced,
        master: produced[master].replace(b"<a:latin", b'<a:latin altLang="x"', 1),
    }
    assert not verify.template_parts_unchanged("pptx", template, changed)


def test_a_file_with_active_content_is_refused_without_its_bytes(status, monkeypatch):
    from renderer import service

    hostile = (CORPUS / "field-dde.docx").read_bytes()
    monkeypatch.setitem(service.RENDERERS, "docx", lambda d, t, la: hostile)
    code, payload = handle(body(envelope(status, "docx")))
    assert code == 422
    assert "file" not in payload
    assert failed(payload) == [("active_content", ["template_active_content"])]


def test_a_file_that_does_not_open_is_refused(status, monkeypatch):
    from renderer import service

    monkeypatch.setitem(service.RENDERERS, "docx", lambda d, t, la: b"PK\x05\x06" + b"\0" * 18)
    _, payload = handle(body(envelope(status, "docx")))
    assert failed(payload) == [("opens", ["file_unreadable"])]


def test_a_failure_of_the_libraries_is_a_refusal_not_a_crash(status, monkeypatch):
    from renderer import service

    def broken(document, template, layout):
        raise ValueError("boom")

    monkeypatch.setitem(service.RENDERERS, "pptx", broken)
    code, payload = handle(body(envelope(status, "pptx")))
    assert code == 422
    assert failed(payload) == [("render", ["render_failed"])]


FORMULAS = ["=1+2", '=HYPERLINK("https://example.test","x")', "+1+1", "@SUM(1)", "-2+3"]


def _every_text(node, value):
    if isinstance(node, dict):
        for key, child in node.items():
            if key == "text" and isinstance(child, str):
                node[key] = value
            else:
                _every_text(child, value)
    elif isinstance(node, list):
        for child in node:
            _every_text(child, value)


@pytest.mark.parametrize("payload", FORMULAS)
@pytest.mark.parametrize("name", ["status-internal.json", "sal-client.json"])
def test_writes_text_that_looks_like_a_formula_as_text(name, payload):
    request = envelope(render_fixtures()[name], "xlsx")
    _every_text(request["document"]["sections"], payload)
    code, response = handle(body(request))
    assert failed(response) == []
    assert code == 200
    with ZipFile(BytesIO(file_of(response))) as z:
        for part in z.namelist():
            if part.startswith("xl/worksheets/"):
                assert b"<f>" not in z.read(part) and b"<f " not in z.read(part)
    wb = load_workbook(BytesIO(file_of(response)))
    values = [c.value for ws in wb.worksheets for row in ws.iter_rows() for c in row]
    assert payload in values


def _workbook_with(edit) -> bytes:
    wb = load_workbook(BytesIO(neutral("neutro-xlsx")))
    edit(wb)
    out = BytesIO()
    wb.save(out)
    return out.getvalue()


def test_a_formula_or_a_name_the_template_did_not_have_is_a_failed_check(status, monkeypatch):
    from openpyxl.workbook.defined_name import DefinedName

    from renderer import service

    def add_formula(wb):
        wb["Documento"]["B2"] = "=1+2"

    def add_name(wb):
        wb.defined_names["exfiltrate"] = DefinedName("exfiltrate", attr_text="'Documento'!$A$1")

    for edit in (add_formula, add_name):
        produced = _workbook_with(edit)
        monkeypatch.setitem(service.RENDERERS, "xlsx", lambda d, t, la, p=produced: p)
        request = envelope(status, "xlsx")
        request["expected"] = {"tables": 0, "namedCells": 0}
        code, payload = handle(body(request))
        assert code == 422
        assert "file" not in payload
        assert failed(payload) == [("formulas", ["file_formula"])]


def test_keeps_the_formulas_of_the_template(sal):
    wb = load_workbook(BytesIO(neutral("modulo-sal")))
    wb["SAL"]["H2"] = "=SUM(C11:C12)"
    out = BytesIO()
    wb.save(out)
    code, payload = handle(body(envelope(sal, "xlsx", out.getvalue())))
    assert failed(payload) == []
    assert code == 200
    assert load_workbook(BytesIO(file_of(payload)))["SAL"]["H2"].value == "=SUM(C11:C12)"


def _with_author(fmt: str) -> bytes:
    out = BytesIO()
    if fmt == "docx":
        doc = Document(BytesIO(neutral("neutro-docx")))
        doc.core_properties.author = "Mario Rossi"
        doc.core_properties.keywords = "margine 12%"
        paragraph = doc.add_paragraph("Testo commentato")
        doc.add_comment(paragraph.runs, text="Nota interna del modello", author="Mario Rossi")
        doc.save(out)
    elif fmt == "pptx":
        prs = Presentation(BytesIO(neutral("neutro-pptx")))
        prs.core_properties.author = "Mario Rossi"
        prs.core_properties.keywords = "margine 12%"
        prs.save(out)
    else:
        wb = load_workbook(BytesIO(neutral("neutro-xlsx")))
        wb.properties.creator = "Mario Rossi"
        wb.properties.keywords = "margine 12%"
        wb.save(out)
    return out.getvalue()


@pytest.mark.parametrize("fmt", FORMATS)
def test_the_file_carries_its_title_and_nothing_of_the_template_author(status, fmt):
    code, payload = handle(body(envelope(status, fmt, _with_author(fmt))))
    assert failed(payload) == []
    assert code == 200
    with ZipFile(BytesIO(file_of(payload))) as z:
        core = z.read("docProps/core.xml").decode("utf-8")
        names = z.namelist()
    assert "Mario Rossi" not in core and "margine" not in core
    assert "Octobrief" in core and "Stato del progetto Aurora" in core
    if fmt == "docx":
        assert not any(n.startswith("word/comments") for n in names)
        assert "Nota interna del modello" not in texts_of(file_of(payload))


def test_replaces_the_slides_of_a_template_that_has_some(sal):
    prs = Presentation(BytesIO(neutral("neutro-pptx")))
    for _ in range(2):
        prs.slides.add_slide(prs.slide_layouts[1]).shapes.title.text = "Esempio del modello"
    template = BytesIO()
    prs.save(template)
    code, payload = handle(body(envelope(sal, "pptx", template.getvalue())))
    assert failed(payload) == []
    assert code == 200
    assert "Esempio del modello" not in texts_of(file_of(payload))


def test_replaces_the_body_of_a_letterhead_and_keeps_its_header(status):
    doc = Document(BytesIO(neutral("neutro-docx")))
    doc.add_paragraph("Testo di esempio della carta intestata")
    doc.sections[0].header.paragraphs[0].text = "Intestazione della carta"
    template = BytesIO()
    doc.save(template)
    _, payload = handle(body(envelope(status, "docx", template.getvalue())))
    assert failed(payload) == []
    produced = Document(BytesIO(file_of(payload)))
    assert produced.sections[0].header.paragraphs[0].text == "Intestazione della carta"
    assert "Testo di esempio" not in texts_of(file_of(payload))


def test_the_file_is_the_base64_of_its_sha256(status):
    _, payload = handle(body(envelope(status, "xlsx")))
    import hashlib

    data = base64.b64decode(payload["file"])
    assert hashlib.sha256(data).hexdigest() == payload["sha256"]
    with ZipFile(BytesIO(data)) as z:
        assert z.testzip() is None
