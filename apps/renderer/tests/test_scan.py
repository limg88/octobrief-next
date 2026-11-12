from __future__ import annotations

import io
import struct
import time
import zipfile
import zlib

import pytest
from conftest import CORPUS, corpus, neutral

from renderer import rules
from renderer.scan import inspect_package, normalized_name, relationship_base
from renderer.zipread import ZipEntry, ZipUnreadable, read_entry


@pytest.mark.parametrize("case", corpus(), ids=lambda c: c["file"])
def test_answers_each_file_of_the_shared_corpus_as_the_app_does(case):
    data = (CORPUS / case["file"]).read_bytes()
    outcome = inspect_package(data, case["file"].rsplit(".", 1)[1])
    assert outcome.refusals == case["refusals"]
    assert outcome.ok == (case["refusals"] == [])


def test_the_corpus_refuses_a_macro_an_external_link_an_ole_object_and_a_bomb():
    refused = {c["file"]: c["refusals"] for c in corpus()}
    assert "template_macro" in refused["macro-project.docx"]
    assert refused["external-link.docx"] == ["template_external_link"]
    assert "template_embedded_object" in refused["ole-object.pptx"]
    assert refused["bomb.docx"] == ["template_expanded_too_large"]


@pytest.mark.parametrize(
    ("slug", "fmt"),
    [
        ("neutro-docx", "docx"),
        ("neutro-pptx", "pptx"),
        ("neutro-xlsx", "xlsx"),
        ("modulo-sal", "xlsx"),
    ],
)
def test_accepts_the_neutral_templates(slug, fmt):
    outcome = inspect_package(neutral(slug), fmt)
    assert outcome.refusals == []
    assert outcome.ok


def test_refuses_a_file_over_the_compressed_cap_before_reading_it():
    assert inspect_package(b"\0" * (10 * 1024 * 1024 + 1), "docx").refusals == [
        "template_too_large"
    ]


def test_refuses_a_format_it_does_not_render():
    assert inspect_package(neutral("neutro-docx"), "pdf").refusals == ["template_format_unknown"]


def test_folds_names_as_office_does():
    assert normalized_name("/Word\\Document.XML") == "word/document.xml"
    assert normalized_name("word/ſtyles.xml") == normalized_name("word/styles.xml")
    for hostile in ("word/../x.xml", "c:/x.xml", "word//x.xml", "a\x00b"):
        with pytest.raises(Exception):  # noqa: B017 (any refusal)
            normalized_name(hostile)


def test_inflates_an_entry_to_exactly_its_declared_size():
    payload = b"x" * 100_000
    deflater = zlib.compressobj(9, zlib.DEFLATED, -15)
    raw = deflater.compress(payload) + deflater.flush()
    entry = ZipEntry("a.xml", 8, len(raw), len(payload), 0)
    assert read_entry(raw, entry) == payload
    for declared in (len(payload) - 1, len(payload) + 1):
        with pytest.raises(ZipUnreadable):
            read_entry(raw, ZipEntry("a.xml", 8, len(raw), declared, 0))
    with pytest.raises(ZipUnreadable):
        read_entry(b"abc", ZipEntry("a.xml", 0, 3, 4, 0))
    assert struct.calcsize("<I") == 4


IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"


@pytest.mark.parametrize(
    "target", ["\\\\host\\share", "/\\host\\share", "\\/host/share", "/\\/evil", "//h", "file:x"]
)
def test_reads_a_backslash_in_a_target_as_a_slash(target):
    assert rules.relationship_findings(IMAGE, None, target) == ["template_external_link"]


@pytest.mark.parametrize("href", ["/\\evil.example/p.png", "\\/evil.example/x", "http://e"])
def test_reads_a_backslash_in_a_link_as_a_slash(href):
    assert rules.href_findings("href", href) == ["template_external_link"]


def test_refuses_a_target_that_climbs_out_of_the_package_from_its_part():
    for inside in ("../media/a.png", "media/a.png", "/word/media/a.png"):
        assert rules.relationship_findings(IMAGE, None, inside, "word") == []
    for outside in ("../../x.png", "..\\..\\..\\x", "%2e%2e/%2e%2e/x", "/../x"):
        assert rules.relationship_findings(IMAGE, None, outside, "word") == [
            "template_external_link"
        ]
    assert relationship_base("word/_rels/document.xml.rels") == "word"
    assert relationship_base("_rels/.rels") == ""


def test_refuses_what_an_svg_image_runs_or_fetches():
    for local in ("foreignObject", "set", "animate", "animateMotion", "style", "script"):
        assert rules.svg_element_findings(local) == ["template_active_content"]
    assert rules.svg_attribute_findings("onload", "x()") == ["template_active_content"]
    assert rules.svg_attribute_findings("style", "fill:red") == ["template_active_content"]
    assert rules.svg_attribute_findings("fill", "url(http://e/x#p)") == ["template_external_link"]
    assert rules.svg_attribute_findings("fill", "u\\72l(x)") == ["template_external_link"]
    assert rules.svg_attribute_findings("fill", "url(#g)") == []


def test_refuses_a_link_that_climbs_out_of_the_package_from_its_part():
    for inside in ("image2.png", "../media/a.png", "#g"):
        assert rules.href_findings("href", inside, "word/media") == []
    for outside in ("../../../a.png", "..\\..\\..\\a.png", "/../a.png"):
        assert rules.href_findings("href", outside, "word/media") == ["template_external_link"]


CONTROLLED = [
    "h\tttp://evil.example/p.png",
    "java\nscript:alert(1)",
    "/\t/evil.example/p.png",
    "fi\rle:x",
    "\\\t\\evil\\s\\x.png",
    "\u0000\u001fhttp://e",
    "\ufeffhttp://e",
    "\u0085http://e",
    "\u00a0//e",
]


@pytest.mark.parametrize("value", CONTROLLED, ids=repr)
def test_drops_tabs_and_line_breaks_and_trims_controls_before_reading_a_target(value):
    assert rules.href_findings("href", value, "word/media") == ["template_external_link"]
    assert rules.relationship_findings(IMAGE, None, value, "word") == ["template_external_link"]


def test_reads_dots_split_by_tabs_as_dots():
    assert rules.relationship_findings(IMAGE, None, ".\t./.\t./.\t./x.png", "word") == [
        "template_external_link"
    ]


def test_accepts_only_raster_images_inline():
    for ok in ("data:image/png;base64,AA", "\ufeffdata:image/jpeg,AA", " data:image/webp,A"):
        assert rules.href_findings("href", ok) == []
    for no in ("data:image/svg+xml,<svg/>", "data:text/html,x", "\u0085data:image/gif"):
        assert rules.href_findings("href", no) == ["template_external_link"]


@pytest.mark.parametrize(
    "formula",
    [
        "'\\\\evil\\s\\[a.xlsx]Sheet1'!A1",
        "'http://evil/[a.xlsx]Sheet1'!A1",
        "SUM('C:\\dati\\[b.xlsx]Foglio'!A1:A3)",
        "[a.xlsx]Sheet1!A1",
        "'[a.xlsx]Sheet 1'!A1",
    ],
)
def test_refuses_a_formula_that_reads_another_workbook(formula):
    assert rules.formula_findings(formula) == ["template_external_link"]


# The formulas that are kept are in the shared cases (`test_formula.py`).


def test_refuses_svg_handlers_xml_base_and_source_functions():
    for local in ("handler", "listener"):
        assert rules.svg_element_findings(local) == ["template_active_content"]
    assert rules.svg_attribute_findings("base", "http://e/", rules.XML_NAMESPACE) == [
        "template_external_link"
    ]
    assert rules.svg_attribute_findings("base", "x", "") == []
    assert rules.svg_attribute_findings("fill", 'src("x.svg")') == ["template_external_link"]
    assert rules.svg_attribute_findings("fill", 'image-set("x.png" 1x)') == [
        "template_external_link"
    ]


def _many_sheets(one_id: bool) -> bytes:
    s = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rt = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    pr = "http://schemas.openxmlformats.org/package/2006/relationships"
    ct = "application/vnd.openxmlformats-officedocument.spreadsheetml"
    sheets = "".join(
        f'<sheet name="S{i}" sheetId="{i + 1}" r:id="rId{1 if one_id else i + 1}"/>'
        for i in range(1000)
    )
    rels = "".join(
        f'<Relationship Id="rId{i + 1}" Type="{rt}/worksheet" Target="worksheets/sheet1.xml"/>'
        for i in range(1000)
    )
    columns = "".join(f'<tableColumn id="{i + 1}" name="c{i}"/>' for i in range(20000))
    parts = {
        "[Content_Types].xml": (
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.'
            'relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
            f'<Override PartName="/xl/workbook.xml" ContentType="{ct}.sheet.main+xml"/>'
            f'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="{ct}.worksheet+xml"/>'
            f'<Override PartName="/xl/tables/table1.xml" ContentType="{ct}.table+xml"/></Types>'
        ),
        "_rels/.rels": (
            f'<Relationships xmlns="{pr}"><Relationship Id="rId1" Type="{rt}/officeDocument"'
            ' Target="xl/workbook.xml"/></Relationships>'
        ),
        "xl/workbook.xml": (
            f'<workbook xmlns="{s}" xmlns:r="{rt}"><sheets>{sheets}</sheets></workbook>'
        ),
        "xl/_rels/workbook.xml.rels": f'<Relationships xmlns="{pr}">{rels}</Relationships>',
        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{s}"/>',
        "xl/worksheets/_rels/sheet1.xml.rels": (
            f'<Relationships xmlns="{pr}"><Relationship Id="rId1" Type="{rt}/table"'
            ' Target="../tables/table1.xml"/></Relationships>'
        ),
        "xl/tables/table1.xml": (
            f'<table xmlns="{s}" id="1" name="T1" displayName="T1" ref="A1:A2">'
            f'<tableColumns count="20000">{columns}</tableColumns></table>'
        ),
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.writestr(name, data)
    return out.getvalue()


def test_reads_each_sheet_and_table_once_however_many_sheet_entries():
    started = time.perf_counter()
    assert inspect_package(_many_sheets(True), "xlsx").refusals == ["template_unreadable"]
    assert inspect_package(_many_sheets(False), "xlsx").refusals == []
    assert time.perf_counter() - started < 5
