"""The rules on what a template may contain: the same as the core's (`recipe/template.ts`), on
values a strict XML parser has already decoded, by namespace URI and local name, never by prefix.
The shared hostile corpus checks that both sides refuse the same files with the same reasons."""

from __future__ import annotations

import re

from . import formula as _formula

FORMATS = ("docx", "pptx", "xlsx")

REFUSALS = (
    "template_format_unknown",
    "template_unreadable",
    "template_too_large",
    "template_expanded_too_large",
    "template_macro",
    "template_active_content",
    "template_external_link",
    "template_embedded_object",
    "template_part_unknown",
    "template_unchecked",
)

MAIN_CONTENT_TYPES = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
}

RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"


def extension_of(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


# Parts ----------------------------------------------------------------------------------------

IMAGE_MAGIC: dict[str, tuple[bytes, ...]] = {
    "png": (b"\x89PNG",),
    "jpg": (b"\xff\xd8\xff",),
    "jpeg": (b"\xff\xd8\xff",),
    "jpe": (b"\xff\xd8\xff",),
    "jfif": (b"\xff\xd8\xff",),
    "gif": (b"GIF8",),
    "bmp": (b"BM",),
    "tif": (b"II*\x00", b"MM\x00*"),
    "tiff": (b"II*\x00", b"MM\x00*"),
    "emf": (b"\x01\x00\x00\x00",),
    "wmf": (b"\xd7\xcd\xc6\x9a", b"\x01\x00\x09\x00", b"\x02\x00\x09\x00"),
    "webp": (b"RIFF",),
}
FONT_MAGIC: dict[str, tuple[bytes, ...]] = {
    "ttf": (b"\x00\x01\x00\x00", b"true", b"OTTO"),
    "otf": (b"OTTO",),
    "woff": (b"wOFF",),
    "woff2": (b"wOF2",),
}
FONT_EXTENSIONS = {"fntdata", "odttf", "ttf", "otf", "woff", "woff2"}
XML_EXTENSIONS = {"xml", "rels", "vml"}

_FONT_TYPE = re.compile(
    r"^(font/|application/(x-font|font-|vnd\.ms-(opentype|fontobject)|"
    r"vnd\.openxmlformats-officedocument\.obfuscatedfont|x-fontdata))",
    re.IGNORECASE,
)
_IMAGE_TYPE = re.compile(r"^image/", re.IGNORECASE)
_SVG_TYPE = re.compile(r"^image/svg\+xml$", re.IGNORECASE)


def _starts_with_any(head: bytes, magic: tuple[bytes, ...]) -> bool:
    return any(head.startswith(m) for m in magic)


def media_part_mismatch(name: str, content_type: str | None) -> bool:
    ext = extension_of(name)
    if ext == "svg":
        return content_type is None or not _SVG_TYPE.match(content_type.strip())
    if ext in IMAGE_MAGIC:
        return content_type is None or not _IMAGE_TYPE.match(content_type)
    if ext in FONT_EXTENSIONS:
        return content_type is None or not _FONT_TYPE.match(content_type)
    return False


def is_xml_content_type(content_type: str) -> bool:
    base = content_type.split(";")[0].strip().lower()
    return base.endswith("+xml") or base in ("application/xml", "text/xml")


def is_xml_part_name(name: str) -> bool:
    return extension_of(name) in XML_EXTENSIONS


def binary_part_finding(name: str, content_type: str | None, head: bytes) -> str | None:
    ext = extension_of(name)
    if content_type is None:
        return "template_part_unknown"
    if ext in IMAGE_MAGIC:
        if not _IMAGE_TYPE.match(content_type):
            return "template_part_unknown"
        return None if _starts_with_any(head, IMAGE_MAGIC[ext]) else "template_part_unknown"
    if ext in FONT_EXTENSIONS:
        if not _FONT_TYPE.match(content_type):
            return "template_part_unknown"
        magic = FONT_MAGIC.get(ext)
        return None if magic is None or _starts_with_any(head, magic) else "template_part_unknown"
    if ext == "bin":
        return None
    return "template_part_unknown"


def part_name_findings(name: str) -> list[str]:
    n = name.lower()
    out: list[str] = []
    if "vbaproject" in n or "vbadata" in n or re.search(r"(^|/)macrosheets/", n):
        out.append("template_macro")
    if re.search(r"(^|/)activex/", n) or "customui" in n:
        out.append("template_active_content")
    if re.search(r"(^|/)embeddings/", n) or "oleobject" in n:
        out.append("template_embedded_object")
    if (
        re.search(r"(^|/)externallinks/", n)
        or n.endswith("/connections.xml")
        or "querytables/" in n
    ):
        out.append("template_external_link")
    if n.endswith(".bin") and "printersettings" not in n and not re.search(r"(^|/)embeddings/", n):
        out.append("template_active_content")
    return out


def content_type_findings(content_type: str) -> list[str]:
    out: list[str] = []
    if re.search(r"macroEnabled|vbaProject|macrosheet", content_type, re.IGNORECASE):
        out.append("template_macro")
    if re.search(r"oleObject", content_type, re.IGNORECASE):
        out.append("template_embedded_object")
    if re.search(
        r"activeX|webextension|dialogsheet|customui|ui\.extensibility", content_type, re.IGNORECASE
    ):
        out.append("template_active_content")
    if re.search(
        r"spreadsheetml\.(connections|queryTable)\+xml|externalLink", content_type, re.IGNORECASE
    ):
        out.append("template_external_link")
    return out


# Relationships --------------------------------------------------------------------------------

RELATIONSHIP_FINDINGS = {
    "vbaproject": "template_macro",
    "wordvbadata": "template_macro",
    "keymapcustomizations": "template_macro",
    "xlmacrosheet": "template_macro",
    "xlintlmacrosheet": "template_macro",
    "control": "template_active_content",
    "activexcontrolbinary": "template_active_content",
    "oleobject": "template_embedded_object",
    "package": "template_embedded_object",
    "afchunk": "template_embedded_object",
    "attachedtemplate": "template_external_link",
    "externallink": "template_external_link",
    "externallinkpath": "template_external_link",
    "subdocument": "template_external_link",
    "frame": "template_external_link",
    "connections": "template_external_link",
    "querytable": "template_external_link",
    "extensibility": "template_active_content",
    "dialogsheet": "template_active_content",
    "attachedtoolbars": "template_active_content",
}

_RELATIONSHIP_TYPE = re.compile(r"^[a-z][a-z0-9+.-]*://[^?#\s]+$", re.IGNORECASE)
_LEAVING = re.compile(r"^(?:[a-z][a-z0-9+.-]*:|//)", re.IGNORECASE | re.ASCII)
_ESCAPED_PATH = re.compile(r"%(2e|2f|5c)", re.IGNORECASE)
# The white space and controls trimmed at both ends of a target or a link, written out exactly as
# `EDGE_CHARACTERS` of the core, so both gates trim the same characters.
EDGE_CHARACTERS = (
    "\\u0000-\\u0020\\u007f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029"
    "\\u202f\\u205f\\u3000\\ufeff"
)
_EDGES = re.compile("^[" + EDGE_CHARACTERS + "]+|[" + EDGE_CHARACTERS + "]+$")
_INNER_BREAKS = re.compile(r"[\t\n\r]")


def _js_trim(value: str) -> str:
    # The same white space as JavaScript's `trim` for what a relationship type can hold.
    return value.strip(" \t\n\r\v\f ﻿  ")


def _resolved_path(value: str) -> str:
    """A target or a link as Office may resolve it: a backslash is a slash, an escaped dot, slash
    or backslash is what it stands for."""
    value = _EDGES.sub("", _INNER_BREAKS.sub("", value))
    return _ESCAPED_PATH.sub(lambda m: chr(int(m.group(1), 16)), value).replace("\\", "/")


def leaves_package(value: str) -> bool:
    return bool(_LEAVING.match(_resolved_path(value)))


def _climbs_out(target: str, base: str) -> bool:
    path = _resolved_path(target)
    segments = [] if path.startswith("/") else [s for s in base.split("/") if s]
    for segment in path.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if not segments:
                return True
            segments.pop()
        else:
            segments.append(segment)
    return False


def relationship_findings(
    rel_type: str | None,
    target_mode: str | None,
    target: str | None = None,
    base: str | None = None,
) -> list[str]:
    out: list[str] = []
    if (target_mode is not None and target_mode != "Internal") or (
        target is not None
        and (leaves_package(target) or (base is not None and _climbs_out(target, base)))
    ):
        out.append("template_external_link")
    trimmed = _js_trim(rel_type or "")
    if rel_type is None or not _RELATIONSHIP_TYPE.match(trimmed):
        out.append("template_unreadable")
        return out
    kind = trimmed.split("/")[-1].lower()
    if kind == "":
        out.append("template_unreadable")
        return out
    if kind.startswith("webextension"):
        out.append("template_active_content")
    finding = RELATIONSHIP_FINDINGS.get(kind)
    if finding:
        out.append(finding)
    return out


# Elements, fields and formulas ----------------------------------------------------------------

WORDPROCESSING_NAMESPACES = {
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
}
EMBEDDED_ELEMENTS = {"OLEObject", "oleObj", "oleObject", "oleObjects"}
CONTROL_ELEMENTS = {"control", "controls"}
MAIL_MERGE_SOURCES = {"connectString", "query", "dataSource", "headerSource"}


def element_findings(uri: str, local: str) -> list[str]:
    if local in EMBEDDED_ELEMENTS:
        return ["template_embedded_object"]
    if local == "object" and uri in WORDPROCESSING_NAMESPACES:
        return ["template_embedded_object"]
    if local in CONTROL_ELEMENTS:
        return ["template_active_content"]
    if local == "FmlaMacro":
        return ["template_macro"]
    if local in ("script", "customUI"):
        return ["template_active_content"]
    if (local == "mailMerge" or local in MAIL_MERGE_SOURCES) and uri in WORDPROCESSING_NAMESPACES:
        return ["template_external_link"]
    return []


# Elements whose text is a formula, by local name in any namespace, as `FORMULA_ELEMENTS` of the
# core: Office keeps formulas under many namespaces of its own (`c15`, `c16`, `cx`, `x15`...).
# Only the equations of Office Math, whose `f` is a fraction, are not formulas.
FORMULA_ELEMENTS = frozenset(
    {
        "f",
        "definedName",
        "formula",
        "formula1",
        "formula2",
        "calculatedColumnFormula",
        "totalsRowFormula",
    }
)
OMML_NAMESPACES = frozenset(
    {
        "http://schemas.openxmlformats.org/officeDocument/2006/math",
        "http://purl.oclc.org/ooxml/officeDocument/math",
    }
)
X14_NAMESPACE = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"
C15_NAMESPACE = "http://schemas.microsoft.com/office/drawing/2012/chart"


def is_formula_element(uri: str, local: str) -> bool:
    if local == "sqref" and uri == C15_NAMESPACE:
        return True
    return local in FORMULA_ELEMENTS and uri not in OMML_NAMESPACES


def is_formula_wrapper(uri: str, local: str) -> bool:
    """`x14:formula1` and `x14:formula2` wrap an `xm:f`: their own text may only be white space."""
    return uri == X14_NAMESPACE and local in ("formula1", "formula2")


FORMULA_ATTRIBUTES = {"formula", "textlink"}

# An image inline in a link: only a raster image, never an SVG (which could run or fetch).
_RASTER_DATA = re.compile(r"^data:image/(?:png|jpeg|gif|webp)[;,]", re.IGNORECASE | re.ASCII)


def href_findings(local: str, value: str, base: str | None = None) -> list[str]:
    if local != "href" or _RASTER_DATA.match(_resolved_path(value)):
        return []
    if leaves_package(value) or (base is not None and _climbs_out(value, base)):
        return ["template_external_link"]
    return []


SVG_NAMESPACE = "http://www.w3.org/2000/svg"
SVG_ACTIVE_ELEMENTS = {
    "foreignObject",
    "set",
    "animate",
    "animateMotion",
    "animateTransform",
    "animateColor",
    "style",
    "script",
    "handler",
    "listener",
}
_OUTSIDE_URL = re.compile(r"url\s*\(\s*(?!#)|src\s*\(|image-set\s*\(", re.IGNORECASE)
XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace"
XLINK_NAMESPACE = "http://www.w3.org/1999/xlink"
METADATA_NAMESPACES = {
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "http://purl.org/dc/elements/1.1/",
    "http://purl.org/dc/terms/",
    "http://creativecommons.org/ns#",
    "http://web.resource.org/cc/",
}
_METADATA_URL_ATTRIBUTES = {"src", "data", "action"}


def metadata_attribute_findings(local: str, value: str) -> list[str]:
    """An attribute of a metadata element that fetches, or any value that leaves the package."""
    if local in _METADATA_URL_ATTRIBUTES or leaves_package(value):
        return ["template_external_link"]
    return []


_HANDLER = re.compile(r"^on", re.IGNORECASE)


def svg_element_findings(local: str) -> list[str]:
    return ["template_active_content"] if local in SVG_ACTIVE_ELEMENTS else []


def svg_attribute_findings(local: str, value: str, uri: str = "") -> list[str]:
    if uri == XML_NAMESPACE and local == "base":
        return ["template_external_link"]
    if _HANDLER.match(local) or local == "style":
        return ["template_active_content"]
    if _OUTSIDE_URL.search(value) or ("\\" in value and "(" in value):
        return ["template_external_link"]
    return []


FIELD_CHARACTER = "fldChar"
FIELD_INSTRUCTION = "instrText"
FIELD_DELETED_INSTRUCTION = "delInstrText"
FIELD_SIMPLE = "fldSimple"
FIELD_CHARACTER_TYPE = "fldCharType"
FIELD_SIMPLE_INSTRUCTION = "instr"
FIELD_LOCAL_NAMES = {FIELD_CHARACTER, FIELD_INSTRUCTION, FIELD_DELETED_INSTRUCTION, FIELD_SIMPLE}
FIELD_CHARACTER_TYPES = {"begin", "separate", "end"}
FIELD_CHARACTER_DATA = {"ffData", "fldData"}
FIELD_INSTRUCTION_ELEMENTS = {
    "r",
    "rPr",
    "instrText",
    "fldChar",
    "fldSimple",
    "proofErr",
    "bookmarkStart",
    "bookmarkEnd",
}

_INERT_FIELD = re.compile(
    r"^\s*(?:PAGE|NUMPAGES|SECTIONPAGES|DATE|TIME)"
    r'(?:\s+(?:\\@\s*"[^"\\]*"|\\\*\s*(?:MERGEFORMAT|Arabic|roman|ROMAN)))*\s*$',
    re.IGNORECASE,
)


def field_instruction_findings(instruction: str) -> list[str]:
    return [] if _INERT_FIELD.match(instruction) else ["template_active_content"]


# Formulas: an allowlist, in `formula.py`.
formula_findings = _formula.formula_findings


_MACRO_ACTION = re.compile(r"^\s*ppaction://macro", re.IGNORECASE)
_PROGRAM_ACTION = re.compile(r"^\s*ppaction://program", re.IGNORECASE)


def attribute_value_findings(value: str) -> list[str]:
    if _MACRO_ACTION.match(value):
        return ["template_macro"]
    if _PROGRAM_ACTION.match(value):
        return ["template_active_content"]
    return []


def ordered(found: set[str]) -> list[str]:
    return [r for r in REFUSALS if r in found]
