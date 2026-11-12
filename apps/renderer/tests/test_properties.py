"""The properties of a produced file say nothing of the template: no author, company, manager,
link base, sensitivity label or custom property, no revision or print date of its own."""

from __future__ import annotations

import re
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from conftest import FORMATS, body, envelope, file_of, neutral

from renderer.service import handle

NEUTRAL = {"docx": "neutro-docx", "pptx": "neutro-pptx", "xlsx": "neutro-xlsx"}
CUSTOM = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"'
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2"'
    ' name="MSIP_Label_0000_Name"><vt:lpwstr>Riservato cliente Alfa</vt:lpwstr></property>'
    "</Properties>"
)
CUSTOM_REL = (
    '<Relationship Id="rIdCustom" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
    'relationships/custom-properties" Target="docProps/custom.xml"/>'
)
CUSTOM_TYPE = (
    '<Override PartName="/docProps/custom.xml"'
    ' ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>'
)
APP_EXTRA = (
    "<Company><![CDATA[Azienda Interna]]></Company><Manager>Capo&amp;<!-- x -->Interno</Manager>"
    "<HyperlinkBase>https://intranet.example.test/</HyperlinkBase><Template>Interno.dotm</Template>"
    '<TitlesOfParts><vt:vector size="1" baseType="lpstr" xmlns:vt="http://schemas.openxmlformats'
    '.org/officeDocument/2006/docPropsVTypes"><vt:lpstr>TitoloSegretoCliente</vt:lpstr>'
    "</vt:vector></TitlesOfParts>"
)
LABEL = (
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?><clbl:labelList'
    ' xmlns:clbl="http://schemas.microsoft.com/office/2020/mipLabelMetadata"><clbl:label'
    ' id="{11111111-2222-3333-4444-555555555555}" enabled="1" method="Privileged"'
    ' siteId="{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}" removed="0"/></clbl:labelList>'
)
LABEL_REL = (
    '<Relationship Id="rIdLabel" Type="http://schemas.microsoft.com/office/2020/02/relationships/'
    'classificationlabels" Target="docMetadata/LabelInfo.xml"/>'
)
LABEL_TYPE = (
    '<Override PartName="/docMetadata/LabelInfo.xml"'
    ' ContentType="application/vnd.ms-office.classificationlabels+xml"/>'
)


def _template_with_traces(fmt: str) -> bytes:
    source = ZipFile(BytesIO(neutral(NEUTRAL[fmt])))
    out = BytesIO()
    with ZipFile(out, "w", ZIP_DEFLATED) as z:
        for name in source.namelist():
            data = source.read(name).decode("utf-8") if name.endswith((".xml", ".rels")) else None
            if name == "[Content_Types].xml":
                data = data.replace("</Types>", CUSTOM_TYPE + LABEL_TYPE + "</Types>")
            elif name == "_rels/.rels":
                data = data.replace("</Relationships>", CUSTOM_REL + LABEL_REL + "</Relationships>")
            elif name == "docProps/app.xml":
                data = re.sub(
                    r"<(Company|Manager|HyperlinkBase|Template)\b[^>]*?(/>|>[^<]*</\1>)", "", data
                )
                data = re.sub(r"<TitlesOfParts>.*?</TitlesOfParts>", "", data, flags=re.S)
                data = data.replace("</Properties>", APP_EXTRA + "</Properties>")
            elif name == "docProps/core.xml":
                data = re.sub(r"<cp:revision>[^<]*</cp:revision>", "", data)
                data = data.replace(
                    "</cp:coreProperties>",
                    "<cp:revision>17</cp:revision>"
                    "<cp:lastPrinted>2020-01-01T00:00:00Z</cp:lastPrinted>"
                    '<dc:identifier xmlns:dc="http://purl.org/dc/elements/1.1/">INT-42'
                    "</dc:identifier></cp:coreProperties>",
                )
            z.writestr(name, data.encode("utf-8") if data is not None else source.read(name))
        if "docProps/app.xml" not in source.namelist():
            raise AssertionError("the neutral template has no app.xml")
        z.writestr("docProps/custom.xml", CUSTOM)
        z.writestr("docMetadata/LabelInfo.xml", LABEL)
    return out.getvalue()


@pytest.mark.parametrize("fmt", FORMATS)
def test_a_produced_file_keeps_no_property_of_the_template(status, fmt):
    code, payload = handle(body(envelope(status, fmt, _template_with_traces(fmt))))
    assert [c for c in payload["checks"] if not c["passed"]] == []
    assert code == 200
    with ZipFile(BytesIO(file_of(payload))) as z:
        names = z.namelist()
        everything = "\n".join(
            z.read(n).decode("utf-8", "replace") for n in names if n.endswith((".xml", ".rels"))
        )
        core = z.read("docProps/core.xml").decode("utf-8")
    assert "docProps/custom.xml" not in names
    assert "docMetadata/LabelInfo.xml" not in names
    assert "classificationlabels" not in everything
    assert "custom-properties" not in everything
    for trace in (
        "MSIP_Label",
        "Riservato",
        "Azienda Interna",
        "Capo Interno",
        "intranet",
        "Interno.dotm",
        "INT-42",
        "TitoloSegretoCliente",
        "Interno",
        "2020-01-01",
    ):
        assert trace not in everything, trace
    assert "<cp:revision>17</cp:revision>" not in core
    assert "2026-11-06T09:30:00" in core


# A picture of one transparent pixel, as the thumbnail of a template.
PIXEL = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63600000"
    "02000154a24f5d0000000049454e44ae426082"
)
THUMBNAIL_REL = (
    '<Relationship Id="rIdThumb" Type="http://schemas.openxmlformats.org/package/2006/'
    'relationships/metadata/thumbnail" Target="docProps/thumbnail.png"/>'
)
# A type that only ends as a kept one does: compared exactly, it is not kept.
LOOKALIKE_REL = (
    '<Relationship Id="rIdLook" Type="http://example.test/relationships/extended-properties"'
    ' Target="docProps/extra.png"/>'
)


def _template_with_thumbnail(fmt: str) -> bytes:
    source = ZipFile(BytesIO(neutral(NEUTRAL[fmt])))
    out = BytesIO()
    with ZipFile(out, "w", ZIP_DEFLATED) as z:
        for name in source.namelist():
            data = source.read(name)
            if name == "[Content_Types].xml" and b'Extension="png"' not in data:
                data = data.replace(
                    b"</Types>", b'<Default Extension="png" ContentType="image/png"/></Types>'
                )
            elif name == "_rels/.rels":
                added = (THUMBNAIL_REL + LOOKALIKE_REL).encode()
                data = data.replace(b"</Relationships>", added + b"</Relationships>")
            z.writestr(name, data)
        z.writestr("docProps/thumbnail.png", PIXEL)
        z.writestr("docProps/extra.png", PIXEL)
    return out.getvalue()


@pytest.mark.parametrize("fmt", FORMATS)
def test_a_produced_file_has_no_thumbnail_and_only_its_own_relationships(status, fmt):
    code, payload = handle(body(envelope(status, fmt, _template_with_thumbnail(fmt))))
    assert [c for c in payload["checks"] if not c["passed"]] == []
    assert code == 200
    with ZipFile(BytesIO(file_of(payload))) as z:
        names = z.namelist()
        package = z.read("_rels/.rels").decode("utf-8")
    assert "docProps/thumbnail.png" not in names
    assert "docProps/extra.png" not in names
    assert "thumbnail" not in package
    assert "example.test" not in package
