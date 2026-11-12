"""The properties of a produced file: those of the document, never those of the template. The
author is «Octobrief», the title is the document's, the dates are when it was generated; the
template's subject, keywords, comments, identifier, revision and print date are not carried
over. Of the parts of the package only the document and its core and extended properties stay,
by the exact type of their relationship: the thumbnail of the template, custom properties,
classification labels (`docMetadata/LabelInfo.xml`) and any other part of the package go, and the
extended properties are written anew, minimal."""

from __future__ import annotations

from datetime import UTC, datetime

from .content import AUTHOR

# The relationships of the package that stay, by their exact type, transitional and strict.
OFFICE_DOCUMENT = frozenset(
    {
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
        "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
    }
)
CORE_PROPERTIES = frozenset(
    {"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"}
)
EXTENDED_PROPERTIES = frozenset(
    {
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
        "http://purl.oclc.org/ooxml/officeDocument/relationships/extendedProperties",
    }
)
KEPT_PACKAGE_RELATIONSHIPS = OFFICE_DOCUMENT | CORE_PROPERTIES | EXTENDED_PROPERTIES
MINIMAL_APP = (
    b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    b'<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
    b"<Application>Octobrief</Application></Properties>"
)


def generated_at(document: dict) -> datetime:
    """The instant the document was generated, naive in UTC as the libraries write it."""
    value = datetime.fromisoformat(document["header"]["generatedAt"].replace("Z", "+00:00"))
    return value.astimezone(UTC).replace(tzinfo=None)


def reset_office(props, package, document: dict) -> None:
    """A docx or pptx: core properties, extended properties and custom properties."""
    props.author = AUTHOR
    props.last_modified_by = AUTHOR
    props.title = document["title"]
    for name in ("subject", "keywords", "comments", "category", "content_status", "identifier"):
        setattr(props, name, "")
    props.revision = 1
    props.created = props.modified = generated_at(document)
    element = props._element
    for child in list(element):
        if child.tag.endswith("}lastPrinted"):
            element.remove(child)
    # python-docx names the relationships of the package `rels`, python-pptx `_rels`.
    rels = package.rels if hasattr(package, "rels") else package._rels
    for r_id, rel in list(rels.items()):
        if rel.reltype not in KEPT_PACKAGE_RELATIONSHIPS or rel.is_external:
            rels.pop(r_id)
        elif rel.reltype in EXTENDED_PROPERTIES:
            rel.target_part._blob = MINIMAL_APP


def reset_workbook(wb, document: dict) -> None:
    """An xlsx: openpyxl writes its own extended properties; core and custom are reset here."""
    from openpyxl.packaging.custom import CustomPropertyList

    props = wb.properties
    props.creator = props.lastModifiedBy = AUTHOR
    props.title = document["title"]
    props.description = props.subject = props.keywords = props.category = None
    props.contentStatus = props.identifier = props.revision = props.lastPrinted = None
    props.created = props.modified = generated_at(document)
    wb.custom_doc_props = CustomPropertyList()
