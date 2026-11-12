"""The checks of a produced file, on the whole file and not only on what was added: it opens, it
holds nothing a template may not hold, the header, footer and images of the template are what
they were, and it has the counts the worker expects. Every XML part is read with `defusedxml`."""

from __future__ import annotations

import hashlib
import posixpath
import re
import xml.etree.ElementTree as StdET
from io import BytesIO

from defusedxml import ElementTree as SafeET

from . import render_docx

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
PKG_RELS = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def _xml(data: bytes):
    return SafeET.fromstring(data, forbid_dtd=True, forbid_entities=True, forbid_external=True)


def canonical(data: bytes) -> str:
    """An XML part in canonical form, white space between elements aside: the same content
    serialized again by a library compares equal."""
    return StdET.canonicalize(StdET.tostring(_xml(data), encoding="unicode"), strip_text=True)


def opens(fmt: str, data: bytes) -> bool:
    """Whether the library of the format opens the file again."""
    try:
        if fmt == "docx":
            from docx import Document

            Document(BytesIO(data))
        elif fmt == "pptx":
            from pptx import Presentation

            Presentation(BytesIO(data))
        else:
            from openpyxl import load_workbook

            load_workbook(BytesIO(data))
    except Exception:  # noqa: BLE001 (any failure to open is the finding)
        return False
    return True


# Parts of the template --------------------------------------------------------------------------


def _rels_name(name: str) -> str:
    folder, base = posixpath.split(name)
    return posixpath.join(folder, "_rels", f"{base}.rels")


def _targets(parts: dict[str, bytes], name: str) -> set[str]:
    """The parts that `name` refers to, inside the package."""
    rels = parts.get(_rels_name(name))
    if rels is None:
        return set()
    out = set()
    folder = posixpath.dirname(name)
    for rel in _xml(rels).iter(f"{PKG_RELS}Relationship"):
        if rel.get("TargetMode") == "External":
            continue
        target = rel.get("Target") or ""
        path = target.lstrip("/") if target.startswith("/") else posixpath.join(folder, target)
        out.add(posixpath.normpath(path).lower())
    return out


_PROTECTED = {
    "docx": re.compile(r"^word/(header|footer)\d*\.xml$"),
    "pptx": re.compile(r"^ppt/(slidemasters|slidelayouts|theme)/[^/]+\.xml$"),
}


def _protected(fmt: str, parts: dict[str, bytes]) -> set[str]:
    pattern = _PROTECTED[fmt]
    names = {n for n in parts if pattern.match(n)}
    for name in list(names):
        names |= {t for t in _targets(parts, name) if t in parts and not t.endswith(".xml")}
    return names


def _same_part(name: str, before: bytes, after: bytes) -> bool:
    if name.endswith(".xml"):
        try:
            return canonical(before) == canonical(after)
        except Exception:  # noqa: BLE001 (an unreadable part is a changed part)
            return False
    return before == after


def _header_footer(data: bytes) -> str | None:
    element = _xml(data).find(f"{S}headerFooter")
    if element is None:
        return None
    return StdET.canonicalize(StdET.tostring(element, encoding="unicode"), strip_text=True)


# Formulas ---------------------------------------------------------------------------------------

R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def _sheet_parts(parts: dict[str, bytes]) -> dict[str, str]:
    """The part of each sheet of a workbook, by the name of the sheet."""
    rels = parts.get("xl/_rels/workbook.xml.rels")
    workbook = parts.get("xl/workbook.xml")
    if rels is None or workbook is None:
        return {}
    targets = {}
    for rel in _xml(rels).iter(f"{PKG_RELS}Relationship"):
        target = rel.get("Target") or ""
        path = target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target)
        targets[rel.get("Id")] = posixpath.normpath(path).lower()
    return {
        sheet.get("name"): targets.get(sheet.get(f"{R}id"), "")
        for sheet in _xml(workbook).iter(f"{S}sheet")
    }


def _formula_cells(parts: dict[str, bytes]) -> set[tuple[str, str]]:
    out = set()
    for sheet, part in _sheet_parts(parts).items():
        data = parts.get(part)
        if data is None:
            continue
        for cell in _xml(data).iter(f"{S}c"):
            if cell.find(f"{S}f") is not None:
                out.add((sheet, cell.get("r") or ""))
    return out


def _defined_names(parts: dict[str, bytes]) -> dict[tuple[str, str | None], str]:
    workbook = parts.get("xl/workbook.xml")
    if workbook is None:
        return {}
    return {
        ((n.get("name") or "").lower(), n.get("localSheetId")): (n.text or "").strip()
        for n in _xml(workbook).iter(f"{S}definedName")
    }


def no_new_formulas(fmt: str, template: dict[str, bytes], file: dict[str, bytes]) -> bool:
    """Whether a workbook holds no formula and no defined name the template did not have at the
    same sheet and cell: the text of the document is never a formula, whatever it starts with.
    The print names Excel defines itself (`_xlnm.`) may be written again in another form."""
    if fmt != "xlsx":
        return True
    if not _formula_cells(file) <= _formula_cells(template):
        return False
    before, after = _defined_names(template), _defined_names(file)
    for key, text in after.items():
        if key not in before:
            return False
        if before[key] != text and not key[0].startswith("_xlnm."):
            return False
    return True


def template_parts_unchanged(fmt: str, template: dict[str, bytes], file: dict[str, bytes]) -> bool:
    if fmt == "xlsx":
        media = sorted(hashlib.sha256(d).hexdigest() for n, d in template.items() if _is_media(n))
        kept = sorted(hashlib.sha256(d).hexdigest() for n, d in file.items() if _is_media(n))
        if media != kept:
            return False
        sheets = [n for n in template if re.match(r"^xl/worksheets/sheet\d+\.xml$", n)]
        return all(
            n in file and _header_footer(template[n]) == _header_footer(file[n]) for n in sheets
        )
    for name in _protected(fmt, template):
        if name not in file or not _same_part(name, template[name], file[name]):
            return False
    return True


def _is_media(name: str) -> bool:
    return name.startswith("xl/media/")


# Counts -----------------------------------------------------------------------------------------


def _docx_counts(parts: dict[str, bytes], layout: dict) -> dict[str, int]:
    wanted = {n.lower() for n in render_docx.heading_style_names(layout)}
    ids = set()
    styles = parts.get("word/styles.xml")
    if styles is not None:
        for style in _xml(styles).iter(f"{W}style"):
            name = style.find(f"{W}name")
            if name is not None and (name.get(f"{W}val") or "").lower() in wanted:
                ids.add(style.get(f"{W}styleId"))
    body = _xml(parts["word/document.xml"]).find(f"{W}body")
    sections = tables = 0
    for child in list(body) if body is not None else []:
        if child.tag == f"{W}tbl":
            tables += 1
        elif child.tag == f"{W}p":
            style = child.find(f"{W}pPr/{W}pStyle")
            if style is not None and style.get(f"{W}val") in ids:
                sections += 1
    return {"sections": sections, "tables": tables}


def _pptx_counts(parts: dict[str, bytes]) -> dict[str, int]:
    presentation = _xml(parts["ppt/presentation.xml"])
    slides = presentation.find(f"{P}sldIdLst")
    tables = sum(
        sum(1 for _ in _xml(data).iter(f"{A}tbl"))
        for name, data in parts.items()
        if re.match(r"^ppt/slides/slide\d+\.xml$", name)
    )
    return {"slides": 0 if slides is None else len(list(slides)), "tables": tables}


_SINGLE_CELL = re.compile(r"^(?:'(?:[^']|'')+'|[^!'\s]+)!\$?[A-Za-z]{1,3}\$?\d+$")


def _xlsx_counts(
    template: dict[str, bytes], parts: dict[str, bytes], layout: dict
) -> dict[str, int]:
    def tables_of(p: dict[str, bytes]) -> int:
        return sum(1 for n in p if re.match(r"^xl/tables/table\d+\.xml$", n))

    defined = {}
    for name in _xml(parts["xl/workbook.xml"]).iter(f"{S}definedName"):
        defined.setdefault(name.get("name"), (name.text or "").strip())
    named = sum(
        1 for cell in layout["namedCells"] if _SINGLE_CELL.match(defined.get(cell["name"], ""))
    )
    return {"tables": tables_of(parts) - tables_of(template), "namedCells": named}


def counts(fmt: str, template: dict[str, bytes], parts: dict[str, bytes], layout: dict):
    if fmt == "docx":
        return _docx_counts(parts, layout)
    if fmt == "pptx":
        return _pptx_counts(parts)
    return _xlsx_counts(template, parts, layout)
