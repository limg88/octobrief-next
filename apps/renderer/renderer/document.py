"""The document and the request, validated before anything is rendered. The document is checked
against the JSON Schema of the core (`octobrief.document/1`), plus what a JSON Schema cannot say:
one category per cited source, and notes that the document defines."""

from __future__ import annotations

import json
import re
from functools import cache
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

from . import rules

SCHEMA_FILE = (
    Path(__file__).resolve().parent.parent / "schemas" / "octobrief.document-1.schema.json"
)

EXPECTED_KEYS = {
    "docx": {"sections", "tables"},
    "pptx": {"slides", "tables"},
    "xlsx": {"tables", "namedCells"},
}
_ID = re.compile(r"^.{1,100}$", re.DOTALL)
_CELL_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]{0,254}$")
_LABEL_MAX = 200
_MAX_LAYOUT = 200


@cache
def _validator() -> Draft202012Validator:
    schema = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def _segments(document: dict):
    for section in document["sections"]:
        for block in section["blocks"]:
            if block["kind"] == "text":
                yield from block["segments"]
    yield from document["internalNotes"]


def _cells(document: dict):
    for section in document["sections"]:
        for block in section["blocks"]:
            if block["kind"] == "value":
                yield block["cell"]
            elif block["kind"] in ("table", "list"):
                rows = block["rows"] if block["kind"] == "table" else block["items"]
                for row in rows:
                    yield from row["cells"]


def document_valid(document: object) -> bool:
    if not isinstance(document, dict) or not _validator().is_valid(document):
        return False
    notes = {n["n"] for n in document["sourceNotes"]}
    if len(notes) != len(document["sourceNotes"]):
        return False
    for segment in _segments(document):
        if len(segment["sourceCategories"]) != len(segment["sources"]):
            return False
        if not set(segment["sources"]) <= notes:
            return False
    for section in document["sections"]:
        for block in section["blocks"]:
            if block["kind"] in ("table", "list"):
                rows = block["rows"] if block["kind"] == "table" else block["items"]
                if any(len(r["cells"]) != len(block["columns"]) for r in rows):
                    return False
    return all(set(c["sources"]) <= notes for c in _cells(document))


def _is_count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 100_000


def _label(value: object) -> bool:
    return isinstance(value, str) and 0 < len(value.strip()) <= _LABEL_MAX


def layout_valid(layout: object) -> bool:
    if not isinstance(layout, dict) or set(layout) != {"sections", "namedCells"}:
        return False
    sections, cells = layout["sections"], layout["namedCells"]
    if not isinstance(sections, list) or not isinstance(cells, list):
        return False
    if len(sections) > _MAX_LAYOUT or len(cells) > _MAX_LAYOUT:
        return False
    for s in sections:
        if not isinstance(s, dict) or not set(s) <= {"section", "style", "slideLayout", "sheet"}:
            return False
        if not isinstance(s.get("section"), str) or not _ID.match(s["section"]):
            return False
        if any(k != "section" and not _label(v) for k, v in s.items()):
            return False
    for c in cells:
        if not isinstance(c, dict) or not set(c) <= {"name", "block", "column"}:
            return False
        if not isinstance(c.get("name"), str) or not _CELL_NAME.match(c["name"]):
            return False
        if not isinstance(c.get("block"), str) or not _ID.match(c["block"]):
            return False
        if "column" in c and (not isinstance(c["column"], str) or not _ID.match(c["column"])):
            return False
    return True


def request_valid(request: object) -> bool:
    """The shape of the envelope; the document is checked on its own."""
    if not isinstance(request, dict) or set(request) != {
        "document",
        "template",
        "format",
        "expected",
    }:
        return False
    fmt, template, expected = request["format"], request["template"], request["expected"]
    if fmt not in rules.FORMATS:
        return False
    if not isinstance(template, dict) or set(template) != {"data", "layout"}:
        return False
    if not isinstance(template["data"], str) or not layout_valid(template["layout"]):
        return False
    if not isinstance(expected, dict) or set(expected) != EXPECTED_KEYS[fmt]:
        return False
    return all(_is_count(v) for v in expected.values())
