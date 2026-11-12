"""The check of a whole Office package, template or produced file: the same as `inspectTemplate`
of the app. Caps first (compressed size, entry count and declared expanded size, before anything
is inflated), names normalized with repeated ones refused, every part inflated to exactly its
declared size, every XML part parsed strictly with `defusedxml` (no DTD, no entity other than the
predefined ones, any error refuses), the other parts checked by their declared type and first
bytes. Never raises: what cannot be read is `template_unreadable`."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from io import BytesIO
from xml.sax import SAXException
from xml.sax.handler import ContentHandler, feature_external_ges, feature_namespaces

from defusedxml.common import DefusedXmlException
from defusedxml.sax import make_parser

from . import rules
from .formula import NO_WORKBOOK, WorkbookNames, fold_ascii, is_defined_name, is_sheet_name
from .limits import (
    MAX_TEMPLATE_BYTES,
    MAX_TEMPLATE_ENTRIES,
    MAX_TEMPLATE_EXPANDED_BYTES,
    MAX_TEMPLATE_XML_DEPTH,
)
from .zipread import list_entries, read_entry

CONTENT_TYPES = "[content_types].xml"


class Unreadable(Exception):
    """A part that cannot be read as Office reads it: the whole package is refused."""


@dataclass
class Inspection:
    ok: bool
    refusals: list[str]
    expanded_bytes: int = 0
    # The parts by normalized name, when the package could be read.
    parts: dict[str, bytes] = field(default_factory=dict)
    content_types: dict[str, str] = field(default_factory=dict)


def normalized_name(raw: str) -> str:
    if "\x00" in raw or re.match(r"^[a-zA-Z]:", raw):
        raise Unreadable
    name = raw.replace("\\", "/")
    name = re.sub(r"^/+", "", name)
    name = unicodedata.normalize("NFC", name).upper().lower()
    name = unicodedata.normalize("NFC", name)
    directory = name.endswith("/")
    segments = (name[:-1] if directory else name).split("/")
    if any(s in ("", ".", "..") for s in segments):
        raise Unreadable
    return name


_DECLARATION = re.compile(rb"^(?:\xef\xbb\xbf)?<\?xml\s[^>]*?encoding\s*=\s*([\"'])([^\"']*)\1")


def _strict_bytes(data: bytes) -> bytes:
    """The XML part, only when it is UTF-8 without NUL, declared as UTF-8 or not declared."""
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        raise Unreadable
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise Unreadable from error
    if "\x00" in text:
        raise Unreadable
    declared = _DECLARATION.match(data)
    if declared and not re.fullmatch(rb"utf-?8", declared.group(2), re.IGNORECASE):
        raise Unreadable
    return data


class _Handler(ContentHandler):
    """Forwards events with namespace URI and local name, and keeps the depth under the cap."""

    def __init__(self, on_open, on_text, on_close, on_pi=None) -> None:
        super().__init__()
        self.depth = 0
        self.on_open = on_open
        self.on_text = on_text
        self.on_close = on_close
        self.on_pi = on_pi

    def processingInstruction(self, target, data) -> None:  # noqa: N802 (SAX API)
        # The XML declaration is not reported as one.
        if self.on_pi is not None:
            self.on_pi()

    def startElementNS(self, name, qname, attrs) -> None:  # noqa: N802 (SAX API)
        self.depth += 1
        if self.depth > MAX_TEMPLATE_XML_DEPTH:
            raise Unreadable
        attributes = [((uri or ""), local, value) for (uri, local), value in attrs.items()]
        self.on_open(name[0] or "", name[1], attributes)

    def endElementNS(self, name, qname) -> None:  # noqa: N802 (SAX API)
        self.depth -= 1
        self.on_close(name[0] or "", name[1])

    def characters(self, content) -> None:
        self.on_text(content)

    def startElement(self, name, attrs) -> None:  # noqa: N802 (SAX API)
        raise Unreadable

    def skippedEntity(self, name) -> None:  # noqa: N802 (SAX API)
        raise Unreadable


def parse_strict(data: bytes, on_open, on_text, on_close, on_pi=None) -> None:
    parser = make_parser()
    parser.setFeature(feature_namespaces, True)
    parser.setFeature(feature_external_ges, False)
    parser.forbid_dtd = True
    parser.forbid_entities = True
    parser.forbid_external = True
    parser.setContentHandler(_Handler(on_open, on_text, on_close, on_pi))
    try:
        parser.parse(BytesIO(_strict_bytes(data)))
    except (SAXException, DefusedXmlException, ValueError) as error:
        raise Unreadable from error


def _plain_attributes(attributes) -> dict[str, str]:
    out: dict[str, str] = {}
    for uri, local, value in attributes:
        if uri != "":
            raise Unreadable
        out[local] = value
    return out


def _read_content_types(data: bytes, found: set[str]) -> tuple[dict[str, str], dict[str, str]]:
    defaults: dict[str, str] = {}
    overrides: dict[str, str] = {}
    depth = 0

    def on_open(uri, local, attributes):
        nonlocal depth
        depth += 1
        if uri != rules.CONTENT_TYPES_NAMESPACE:
            raise Unreadable
        if depth == 1:
            if local != "Types":
                raise Unreadable
            return
        if depth != 2 or local not in ("Default", "Override"):
            raise Unreadable
        attrs = _plain_attributes(attributes)
        content_type = attrs.get("ContentType")
        if content_type is None:
            raise Unreadable
        found.update(rules.content_type_findings(content_type))
        key, table = ("Extension", defaults) if local == "Default" else ("PartName", overrides)
        raw = attrs.get(key)
        if raw is None:
            raise Unreadable
        name = normalized_name(raw)
        if name in table:
            raise Unreadable
        table[name] = content_type

    def on_close(uri, local):
        nonlocal depth
        depth -= 1

    parse_strict(data, on_open, lambda text: None, on_close)
    return defaults, overrides


def relationship_base(name: str) -> str:
    """The folder of the part a relationships part belongs to: its targets resolve from there."""
    folder = name.rsplit("/", 1)[0] if "/" in name else ""
    if folder == "_rels":
        return ""
    return folder[: -len("/_rels")] if folder.endswith("/_rels") else folder


def _scan_relationships(name: str, data: bytes, found: set[str]) -> None:
    base = relationship_base(name)
    depth = 0

    def on_open(uri, local, attributes):
        nonlocal depth
        depth += 1
        if uri != rules.RELATIONSHIPS_NAMESPACE:
            raise Unreadable
        expected = "Relationships" if depth == 1 else "Relationship"
        if depth > 2 or local != expected:
            raise Unreadable
        if depth == 2:
            attrs = _plain_attributes(attributes)
            found.update(
                rules.relationship_findings(
                    attrs.get("Type"), attrs.get("TargetMode"), attrs.get("Target"), base
                )
            )

    def on_close(uri, local):
        nonlocal depth
        depth -= 1

    parse_strict(data, on_open, lambda text: None, on_close)


@dataclass
class _Field:
    kind: str  # "complex" or "simple"
    instruction: str
    writing: bool


def _field_attribute(attributes, local: str) -> str:
    values = [(uri, value) for uri, name, value in attributes if name == local]
    if len(values) != 1 or values[0][0] not in rules.WORDPROCESSING_NAMESPACES:
        raise Unreadable
    return values[0][1]


SPREADSHEET_NAMESPACES = {
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "http://purl.oclc.org/ooxml/spreadsheetml/main",
}
TABLE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"
# The content types a declared sheet's part may have: a worksheet or a chart sheet.
SHEET_CONTENT_TYPES = frozenset(
    {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml",
    }
)


OFFICE_RELATIONSHIP_NAMESPACES = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
)


def _relationship_types(kind: str) -> frozenset[str]:
    """A type of relationship by its exact URI, transitional or strict."""
    return frozenset(f"{ns}/{kind}" for ns in OFFICE_RELATIONSHIP_NAMESPACES)


OFFICE_DOCUMENT = _relationship_types("officeDocument")
WORKSHEET_RELATIONSHIPS = _relationship_types("worksheet")
SHEET_RELATIONSHIPS = WORKSHEET_RELATIONSHIPS | _relationship_types("chartsheet")
TABLE_RELATIONSHIPS = _relationship_types("table")


@dataclass(frozen=True)
class _Relationship:
    type: str
    target: str
    external: bool


def _read_relationships(data: bytes | None) -> dict[str, _Relationship]:
    """The relationships of a relationships part, by id; a repeated id is unreadable."""
    out: dict[str, _Relationship] = {}
    if data is None:
        return out
    depth = 0

    def on_open(uri, local, attributes):
        nonlocal depth
        depth += 1
        if depth != 2 or uri != rules.RELATIONSHIPS_NAMESPACE:
            return
        attrs = _plain_attributes(attributes)
        rel_id = attrs.get("Id")
        if rel_id is None or rel_id in out:
            raise Unreadable
        out[rel_id] = _Relationship(
            attrs.get("Type", ""),
            attrs.get("Target", ""),
            attrs.get("TargetMode", "Internal") != "Internal",
        )

    def on_close(uri, local):
        nonlocal depth
        depth -= 1

    parse_strict(data, on_open, lambda text: None, on_close)
    return out


def relationships_part_of(name: str) -> str:
    """The relationships part of a part: `xl/_rels/workbook.xml.rels` for `xl/workbook.xml`."""
    folder = part_folder(name)
    base = name[len(folder) + 1 :] if folder else name
    return f"{folder + '/' if folder else ''}_rels/{base}.rels"


def _relationship_target(rel: _Relationship, base: str) -> str | None:
    """The part an internal relationship points to, resolved from `base` and normalized; None
    when it leaves the package or climbs above its root, as `relationshipTarget` of the app."""
    if rel.external or rules.leaves_package(rel.target):
        return None
    path = rel.target.replace("\\", "/")
    segments = [] if path.startswith("/") else [s for s in base.split("/") if s != ""]
    for segment in path.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if not segments:
                return None
            segments.pop()
        else:
            segments.append(segment)
    try:
        return normalized_name("/".join(segments))
    except Unreadable:
        return None


def _spreadsheet_attributes(attributes) -> tuple[dict[str, str], str | None]:
    """The attributes of a SpreadsheetML element without a namespace, and its `r:id`."""
    attrs: dict[str, str] = {}
    rel_id = None
    for uri, local, value in attributes:
        if uri == "":
            attrs[local] = value
        elif local == "id" and uri in OFFICE_RELATIONSHIP_NAMESPACES:
            rel_id = value
    return attrs, rel_id


def workbook_names(parts: dict[str, bytes], overrides: dict[str, str]) -> WorkbookNames:
    """What the workbook defines, for its formulas, as `workbookNames` of the app, folded as
    `fold_ascii` folds them. Only the workbook the package's `officeDocument` relationship points
    to counts, and in it only `workbook/sheets/sheet` and `workbook/definedNames/definedName`
    (exactly there, never in an extension); tables only from the table parts its worksheets point
    to. A name Excel would not accept or a sheet without its part is unreadable."""
    sheets: set[str] = set()
    names: set[str] = set()
    tables: set[str] = set()
    package = _read_relationships(parts.get("_rels/.rels"))
    mains = [r for r in package.values() if r.type in OFFICE_DOCUMENT]
    if len(mains) > 1:
        raise Unreadable
    main = _relationship_target(mains[0], "") if mains else None
    if main is None or overrides.get(main) != rules.MAIN_CONTENT_TYPES["xlsx"]:
        return WorkbookNames()
    data = parts.get(main)
    if data is None:
        return WorkbookNames()
    sheet_ids: dict[str, None] = {}
    path: list[str] = []

    def on_open(uri, local, attributes):
        path.append(local if uri in SPREADSHEET_NAMESPACES else "")
        at = "/".join(path)
        if at not in ("workbook/sheets/sheet", "workbook/definedNames/definedName"):
            return
        attrs, rel_id = _spreadsheet_attributes(attributes)
        name = attrs.get("name")
        if name is None:
            raise Unreadable
        if local == "sheet":
            # A sheet named twice (in ASCII case) or two sheets on one relationship: unreadable.
            folded = fold_ascii(name)
            if not is_sheet_name(name) or rel_id is None or folded in sheets:
                raise Unreadable
            if rel_id in sheet_ids or len(sheet_ids) >= MAX_TEMPLATE_ENTRIES:
                raise Unreadable
            sheets.add(folded)
            sheet_ids[rel_id] = None
        else:
            if not is_defined_name(name):
                raise Unreadable
            names.add(fold_ascii(name))

    parse_strict(data, on_open, lambda text: None, lambda uri, local: path.pop())
    rels = _read_relationships(parts.get(relationships_part_of(main)))
    # Each worksheet and each table part is read once, however many entries point to it.
    worksheets: dict[str, None] = {}
    for rel_id in sheet_ids:
        rel = rels.get(rel_id)
        target = None if rel is None else _relationship_target(rel, part_folder(main))
        if rel is None or rel.type not in SHEET_RELATIONSHIPS or target is None:
            raise Unreadable
        if target not in parts or overrides.get(target) not in SHEET_CONTENT_TYPES:
            raise Unreadable
        if rel.type in WORKSHEET_RELATIONSHIPS:
            worksheets[target] = None
    table_parts: dict[str, None] = {}
    for worksheet in worksheets:
        _collect_tables(parts, overrides, worksheet, table_parts)
    for table in table_parts:
        _read_table(parts[table], tables)
    return WorkbookNames(frozenset(sheets), frozenset(names), frozenset(tables))


def _collect_tables(
    parts: dict[str, bytes], overrides: dict[str, str], worksheet: str, table_parts: dict[str, None]
) -> None:
    """The table parts a worksheet points to, with their content type."""
    for rel in _read_relationships(parts.get(relationships_part_of(worksheet))).values():
        if rel.type not in TABLE_RELATIONSHIPS:
            continue
        target = _relationship_target(rel, part_folder(worksheet))
        if target is None or target not in parts or overrides.get(target) != TABLE_CONTENT_TYPE:
            continue
        table_parts[target] = None


def _read_table(data: bytes, tables: set[str]) -> None:
    """The name and display name of a table part."""
    depth = 0

    def on_open(uri, local, attributes):
        nonlocal depth
        depth += 1
        if depth != 1 or local != "table" or uri not in SPREADSHEET_NAMESPACES:
            return
        attrs, _ = _spreadsheet_attributes(attributes)
        for key in ("name", "displayName"):
            value = attrs.get(key)
            if value is None:
                continue
            if not is_defined_name(value):
                raise Unreadable
            tables.add(fold_ascii(value))

    def on_close(uri, local):
        nonlocal depth
        depth -= 1

    parse_strict(data, on_open, lambda text: None, on_close)


def part_folder(name: str) -> str:
    return name.rsplit("/", 1)[0] if "/" in name else ""


def is_svg_part(name: str, content_type: str | None) -> bool:
    """An SVG image by its name or by its declared content type."""
    base = (content_type or "").split(";")[0].strip().lower()
    return name.endswith(".svg") or base == "image/svg+xml"


def _scan_content(
    data: bytes, found: set[str], svg: bool, base: str, workbook: WorkbookNames
) -> None:
    """`svg`: an SVG image by name or content type; it is one too when its root element is `svg`,
    in any namespace. `base`: the folder of the part, links resolve from it. Fields are read
    structurally, formulas collected whole: as `scanContent` of the app."""
    state = {
        "collector": None,
        # A formula element that only wraps a formula (`x14:formula1` around an `xm:f`): its own
        # text may only be white space, and its only children are formulas.
        "wrapper": None,
        "character_depth": 0,
        "formatting_depth": 0,
        "svg": svg,
        "root_seen": False,
        # A processing instruction seen (an SVG may not have one: `xml-stylesheet` fetches a
        # sheet), and the depth inside the `metadata` of an SVG, where other namespaces are inert.
        "pi_seen": False,
        "metadata_depth": 0,
    }
    fields: list[_Field] = []

    def writing_instruction() -> bool:
        return bool(fields) and fields[-1].kind == "complex" and fields[-1].writing

    def end_field(f: _Field) -> None:
        found.update(rules.field_instruction_findings(f.instruction))

    def open_field(f: _Field) -> None:
        if fields:
            found.add("template_active_content")
        fields.append(f)

    def on_open(uri, local, attributes):
        if state["collector"] is not None:
            raise Unreadable
        if state["wrapper"] is not None and (
            rules.is_formula_wrapper(uri, local) or not rules.is_formula_element(uri, local)
        ):
            raise Unreadable
        inside = state["character_depth"] > 0 or state["formatting_depth"] > 0
        if inside and local in rules.FIELD_LOCAL_NAMES:
            raise Unreadable
        if state["character_depth"] > 0:
            state["character_depth"] += 1
            if state["character_depth"] == 2:
                if local not in rules.FIELD_CHARACTER_DATA:
                    raise Unreadable
                found.add("template_active_content")
        elif state["formatting_depth"] > 0:
            state["formatting_depth"] += 1
        elif writing_instruction():
            if (
                uri not in rules.WORDPROCESSING_NAMESPACES
                or local not in rules.FIELD_INSTRUCTION_ELEMENTS
            ):
                raise Unreadable
            if local == "rPr":
                state["formatting_depth"] = 1
        if not state["root_seen"]:
            state["root_seen"] = True
            if local == "svg":
                state["svg"] = True
            if state["svg"] and state["pi_seen"]:
                found.add("template_active_content")
        found.update(rules.element_findings(uri, local))
        svg_element = state["svg"] or uri == rules.SVG_NAMESPACE
        # Inside the `metadata` of an SVG only SVG, RDF, Dublin Core and Creative Commons;
        # elsewhere in an SVG only SVG.
        in_metadata = state["metadata_depth"] > 0
        if in_metadata:
            state["metadata_depth"] += 1
        elif svg_element and uri == rules.SVG_NAMESPACE and local == "metadata":
            state["metadata_depth"] = 1
        metadata_element = in_metadata and uri in rules.METADATA_NAMESPACES
        if svg_element and uri != rules.SVG_NAMESPACE and not metadata_element:
            found.add("template_active_content")
        if svg_element:
            found.update(rules.svg_element_findings(local))
        for attribute_uri, name, value in attributes:
            found.update(rules.attribute_value_findings(value))
            found.update(rules.href_findings(name, value, base))
            if svg_element:
                found.update(rules.svg_attribute_findings(name, value, attribute_uri))
                if metadata_element:
                    found.update(rules.metadata_attribute_findings(name, value))
            if name in rules.FORMULA_ATTRIBUTES:
                found.update(rules.formula_findings(value, workbook))
            # The macro a drawing shape runs when clicked.
            if name == "macro" and value != "":
                found.add("template_active_content")
        if local in rules.FIELD_LOCAL_NAMES:
            if uri not in rules.WORDPROCESSING_NAMESPACES:
                raise Unreadable
            if local == rules.FIELD_CHARACTER:
                kind = _field_attribute(attributes, rules.FIELD_CHARACTER_TYPE)
                if kind not in rules.FIELD_CHARACTER_TYPES:
                    raise Unreadable
                state["character_depth"] = 1
                top = fields[-1] if fields else None
                if kind == "begin":
                    open_field(_Field("complex", "", True))
                elif top is None or top.kind != "complex":
                    raise Unreadable
                elif kind == "separate":
                    if not top.writing:
                        raise Unreadable
                    top.writing = False
                else:
                    fields.pop()
                    end_field(top)
            elif local == rules.FIELD_SIMPLE:
                simple = _Field(
                    "simple", _field_attribute(attributes, rules.FIELD_SIMPLE_INSTRUCTION), False
                )
                open_field(simple)
                end_field(simple)
            elif local == rules.FIELD_INSTRUCTION:
                top = fields[-1] if fields else None
                if top is None or top.kind != "complex" or not top.writing:
                    raise Unreadable
                state["collector"] = [uri, local, ""]
            else:
                raise Unreadable
        if rules.is_formula_wrapper(uri, local):
            state["wrapper"] = [uri, local, ""]
        elif rules.is_formula_element(uri, local):
            state["collector"] = [uri, local, ""]

    def on_text(text):
        collector = state["collector"]
        if collector is not None:
            collector[2] += text
        elif state["wrapper"] is not None:
            state["wrapper"][2] += text
        elif state["character_depth"] == 0 and writing_instruction() and text.strip() != "":
            raise Unreadable

    def on_pi():
        state["pi_seen"] = True
        if state["svg"]:
            found.add("template_active_content")

    def on_close(uri, local):
        if state["metadata_depth"] > 0:
            state["metadata_depth"] -= 1
        if state["character_depth"] > 0:
            state["character_depth"] -= 1
        elif state["formatting_depth"] > 0:
            state["formatting_depth"] -= 1
        if (
            local == rules.FIELD_SIMPLE
            and uri in rules.WORDPROCESSING_NAMESPACES
            and fields
            and fields[-1].kind == "simple"
        ):
            fields.pop()
            return
        collector = state["collector"]
        wrapper = state["wrapper"]
        if collector is None and wrapper is not None and (uri, local) == (wrapper[0], wrapper[1]):
            if wrapper[2].strip(" \t\r\n") != "":
                raise Unreadable
            state["wrapper"] = None
            return
        if collector is None or uri != collector[0] or local != collector[1]:
            return
        state["collector"] = None
        if rules.is_formula_element(uri, local):
            found.update(rules.formula_findings(collector[2], workbook))
            return
        if fields:
            fields[-1].instruction += collector[2]

    parse_strict(data, on_open, on_text, on_close, on_pi)
    if fields:
        raise Unreadable


def inspect_package(
    data: bytes,
    fmt: str,
    max_bytes: int = MAX_TEMPLATE_BYTES,
    max_expanded: int = MAX_TEMPLATE_EXPANDED_BYTES,
) -> Inspection:
    """Whether the bytes of a package of `fmt` hold nothing a template may not hold."""
    if fmt not in rules.FORMATS:
        return Inspection(False, ["template_format_unknown"])
    if len(data) > max_bytes:
        return Inspection(False, ["template_too_large"])
    try:
        entries = list_entries(data)
        seen: set[str] = set()
        declared = 0
        for entry in entries:
            name = normalized_name(entry.name)
            if name in seen:
                raise Unreadable
            seen.add(name)
            declared += entry.declared_size
        if declared > max_expanded or len(entries) > MAX_TEMPLATE_ENTRIES:
            return Inspection(False, ["template_expanded_too_large"])
        parts = {normalized_name(e.name): read_entry(data, e) for e in entries}
        found: set[str] = set()
        types_part = parts.get(CONTENT_TYPES)
        if types_part is None:
            return Inspection(False, ["template_unreadable"])
        defaults, overrides = _read_content_types(types_part, found)
        workbook = workbook_names(parts, overrides) if fmt == "xlsx" else NO_WORKBOOK
        if rules.MAIN_CONTENT_TYPES[fmt] not in overrides.values():
            found.add("template_format_unknown")
        content_types: dict[str, str] = {}
        for name, part in parts.items():
            if name == CONTENT_TYPES or name.endswith("/"):
                continue
            found.update(rules.part_name_findings(name))
            ext = name.rsplit(".", 1)[-1] if "." in name else ""
            content_type = overrides.get(name, defaults.get(ext))
            if content_type is not None:
                content_types[name] = content_type
            if rules.media_part_mismatch(name, content_type):
                found.add("template_part_unknown")
                continue
            if (
                content_type is not None and rules.is_xml_content_type(content_type)
            ) or rules.is_xml_part_name(name):
                if name.endswith(".rels"):
                    _scan_relationships(name, part, found)
                else:
                    _scan_content(
                        part, found, is_svg_part(name, content_type), part_folder(name), workbook
                    )
            else:
                finding = rules.binary_part_finding(name, content_type, part[:8])
                if finding is not None:
                    found.add(finding)
        refusals = rules.ordered(found)
        if refusals:
            return Inspection(False, refusals)
        return Inspection(True, [], declared, parts, content_types)
    except Exception:  # noqa: BLE001 (whatever cannot be read is refused, never raised)
        return Inspection(False, ["template_unreadable"])
