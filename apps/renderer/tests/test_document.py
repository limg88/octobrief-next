from __future__ import annotations

import pytest
from conftest import envelope, invalid_documents, render_fixtures

from renderer.document import document_valid, request_valid


@pytest.mark.parametrize("name", sorted(render_fixtures()))
def test_accepts_the_documents_of_the_shared_fixtures(name):
    assert document_valid(render_fixtures()[name]["document"])


@pytest.mark.parametrize("case", invalid_documents(), ids=lambda c: c["description"])
def test_refuses_the_documents_the_core_refuses(case):
    assert not document_valid(case["document"])


def test_refuses_a_note_number_the_document_does_not_define(status):
    document = status["document"]
    document["sections"][0]["blocks"][2]["cell"]["sources"] = [9]
    assert not document_valid(document)


def test_refuses_a_row_with_a_cell_more_than_its_columns(status):
    document = status["document"]
    table = document["sections"][1]["blocks"][0]
    table["rows"][0]["cells"].append(table["rows"][0]["cells"][0])
    assert not document_valid(document)


def test_checks_the_shape_of_the_request(status):
    good = envelope(status, "docx", b"PK")
    assert request_valid(good)
    for broken in (
        {**good, "extra": 1},
        {**good, "format": "pdf"},
        {**good, "expected": {"sections": 1}},
        {**good, "expected": {"sections": -1, "tables": 0}},
        {**good, "expected": {"sections": True, "tables": 0}},
        {**good, "template": {"data": 1, "layout": good["template"]["layout"]}},
        {**good, "template": {"data": "", "layout": {"sections": []}}},
        {
            **good,
            "template": {
                "data": "",
                "layout": {"sections": [], "namedCells": [{"name": "1bad", "block": "b"}]},
            },
        },
    ):
        assert not request_valid(broken)
    assert not request_valid([good])
