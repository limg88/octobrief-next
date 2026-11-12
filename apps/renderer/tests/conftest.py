"""Shared fixtures: the render fixtures and the hostile corpus are the same files the TypeScript
tests read, copied into the test image from the repository."""

from __future__ import annotations

import base64
import copy
import json
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import pytest

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
RENDER = FIXTURES / "render"
CORPUS = FIXTURES / "corpus"
NEUTRAL = FIXTURES / "neutral"
FORMATS = ("docx", "pptx", "xlsx")


def render_fixtures() -> dict[str, dict]:
    return {
        p.name: json.loads(p.read_text(encoding="utf-8"))
        for p in sorted(RENDER.glob("*.json"))
        if not p.name.startswith("invalid-")
    }


def invalid_documents() -> list[dict]:
    return json.loads((RENDER / "invalid-documents.json").read_text(encoding="utf-8"))["cases"]


def corpus() -> list[dict]:
    return json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))["cases"]


def neutral(slug: str) -> bytes:
    for path in NEUTRAL.iterdir():
        if path.stem == slug:
            return path.read_bytes()
    raise FileNotFoundError(slug)


def envelope(fixture: dict, fmt: str, template: bytes | None = None) -> dict:
    data = template if template is not None else neutral(fixture["templates"][fmt])
    return {
        "document": copy.deepcopy(fixture["document"]),
        "format": fmt,
        "template": {
            "data": base64.b64encode(data).decode("ascii"),
            "layout": copy.deepcopy(fixture["layout"]),
        },
        "expected": dict(fixture["expected"][fmt]),
    }


def body(request: dict) -> bytes:
    return json.dumps(request).encode("utf-8")


def file_of(payload: dict) -> bytes:
    return base64.b64decode(payload["file"])


def texts_of(data: bytes) -> str:
    """Every XML part of a package, as one string, to look for what must never be there."""
    with ZipFile(BytesIO(data)) as z:
        return "\n".join(
            z.read(n).decode("utf-8", "replace") for n in z.namelist() if n.endswith(".xml")
        )


@pytest.fixture
def status() -> dict:
    return render_fixtures()["status-internal.json"]


@pytest.fixture
def sal() -> dict:
    return render_fixtures()["sal-client.json"]
