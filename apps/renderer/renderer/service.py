"""One request, from its body to the answer: the request and the document validated, the template
checked as the app checks it, the file rendered and checked as a whole. The file is returned only
when every check passed; otherwise only the outcomes are."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json

from . import document as validation
from . import render_docx, render_pptx, render_xlsx, verify
from .errors import Refusal
from .limits import MAX_FILE_BYTES, MAX_FILE_EXPANDED_BYTES, MAX_REQUEST_BYTES
from .scan import inspect_package

RENDERERS = {"docx": render_docx.render, "pptx": render_pptx.render, "xlsx": render_xlsx.render}

# HTTP statuses of the outcomes: a request that cannot be read, or one refused by a check.
BAD_REQUEST = 400
TOO_LARGE = 413
REFUSED = 422
RENDERED = 200


def _outcome(subject: str, check: str, findings: list[str] | None = None) -> dict:
    findings = findings or []
    return {"subject": subject, "check": check, "passed": not findings, "findings": findings}


def _refused(checks: list[dict], status: int = REFUSED) -> tuple[int, dict]:
    return status, {"outcome": "refused", "checks": checks}


def handle(body: bytes) -> tuple[int, dict]:
    checks: list[dict] = []
    if len(body) > MAX_REQUEST_BYTES:
        return _refused([_outcome("request", "request", ["request_too_large"])], TOO_LARGE)
    try:
        request = json.loads(body)
    except (ValueError, UnicodeDecodeError, RecursionError):
        request = None
    if not validation.request_valid(request):
        return _refused([_outcome("request", "request", ["request_invalid"])], BAD_REQUEST)
    try:
        template = base64.b64decode(request["template"]["data"], validate=True)
    except (binascii.Error, ValueError):
        return _refused([_outcome("request", "request", ["request_invalid"])], BAD_REQUEST)
    checks.append(_outcome("request", "request"))

    document = request["document"]
    if not validation.document_valid(document):
        checks.append(_outcome("request", "document", ["document_invalid"]))
        return _refused(checks)
    checks.append(_outcome("request", "document"))

    fmt, layout, expected = request["format"], request["template"]["layout"], request["expected"]
    inspection = inspect_package(template, fmt)
    checks.append(_outcome("template", "template", inspection.refusals))
    if not inspection.ok:
        return _refused(checks)

    try:
        produced = RENDERERS[fmt](document, template, layout)
    except Refusal as refusal:
        checks.append(_outcome("template", refusal.check, [refusal.finding]))
        return _refused(checks)
    except Exception:  # noqa: BLE001 (a template the libraries cannot use is a refusal)
        checks.append(_outcome("file", "render", ["render_failed"]))
        return _refused(checks)
    if layout["sections"] or layout["namedCells"]:
        checks.append(_outcome("template", "layout"))
    checks.append(_outcome("file", "render"))

    return _check_file(fmt, produced, inspection.parts, layout, expected, checks)


def _check_file(fmt, produced, template_parts, layout, expected, checks) -> tuple[int, dict]:
    if len(produced) > MAX_FILE_BYTES:
        checks.append(_outcome("file", "opens", ["file_too_large"]))
        return _refused(checks)
    scanned = inspect_package(produced, fmt, MAX_FILE_BYTES, MAX_FILE_EXPANDED_BYTES)
    unreadable = {"template_unreadable", "template_format_unknown", "template_too_large"}
    if (scanned.refusals and set(scanned.refusals) <= unreadable) or not verify.opens(
        fmt, produced
    ):
        checks.append(_outcome("file", "opens", ["file_unreadable"]))
        return _refused(checks)
    checks.append(_outcome("file", "opens"))
    if scanned.refusals == ["template_expanded_too_large"]:
        checks.append(_outcome("file", "active_content", ["file_too_large"]))
        return _refused(checks)
    checks.append(_outcome("file", "active_content", scanned.refusals))
    if not scanned.ok:
        return _refused(checks)
    if not verify.no_new_formulas(fmt, template_parts, scanned.parts):
        checks.append(_outcome("file", "formulas", ["file_formula"]))
        return _refused(checks)
    if fmt == "xlsx":
        checks.append(_outcome("file", "formulas"))
    if not verify.template_parts_unchanged(fmt, template_parts, scanned.parts):
        checks.append(_outcome("file", "template_parts", ["template_part_changed"]))
        return _refused(checks)
    checks.append(_outcome("file", "template_parts"))
    counted = verify.counts(fmt, template_parts, scanned.parts, layout)
    if counted != expected:
        checks.append(_outcome("file", "counts", ["count_mismatch"]))
        return _refused(checks)
    checks.append(_outcome("file", "counts"))
    return RENDERED, {
        "outcome": "rendered",
        "file": base64.b64encode(produced).decode("ascii"),
        "sha256": hashlib.sha256(produced).hexdigest(),
        "checks": checks,
    }
