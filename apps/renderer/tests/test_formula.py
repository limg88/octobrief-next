"""The formulas of a template, read as the core reads them: the same shared cases."""

from __future__ import annotations

import json
import time

import pytest
from conftest import FIXTURES

from renderer.formula import (
    LINKING,
    PURE,
    WorkbookNames,
    fold_ascii,
    formula_findings,
    is_defined_name,
    is_sheet_name,
)

SHARED = json.loads((FIXTURES / "formulas.json").read_text(encoding="utf-8"))
WORKBOOK = WorkbookNames(
    frozenset(SHARED["workbook"]["sheets"]),
    frozenset(SHARED["workbook"]["names"]),
    frozenset(SHARED["workbook"]["tables"]),
)


@pytest.mark.parametrize("case", SHARED["cases"], ids=lambda c: repr(c["formula"])[:60])
def test_answers_every_shared_formula_as_the_core_does(case):
    assert formula_findings(case["formula"], WORKBOOK) == case["refusals"]


@pytest.mark.parametrize("case", SHARED["names"], ids=lambda c: repr(c["name"])[:40])
def test_judges_sheet_defined_and_table_names_as_the_core_does(case):
    assert is_sheet_name(case["name"]) is case["sheet"]
    assert is_defined_name(case["name"]) is case["defined"]


def test_folds_only_ascii_letters():
    assert fold_ascii("KPI Città") == "kpi città"
    assert fold_ascii("KPI") == "Kpi"
    assert formula_findings("ſum(1)") == ["template_active_content"]
    assert formula_findings("KPI!A1", WORKBOOK) == ["template_external_link"]
    assert formula_findings("KPI!A1", WORKBOOK) == []


def test_refuses_outside_a_workbook_every_sheet_name_and_table():
    assert formula_findings("Foglio1!A1") == ["template_external_link"]
    assert formula_findings("Totale*2") == ["template_active_content"]
    assert formula_findings("SUM(A1:A3)") == []


def test_reads_the_functions_the_core_wrote():
    assert "SUM" in PURE and "VLOOKUP" in PURE
    assert "INDIRECT" in LINKING and not PURE & LINKING


PIECES = [
    "'",
    "'a''",
    "[",
    "[a.b]",
    "[a]'",
    "[a.x]Sheet'",
    "|a",
    "[[[[",
    '"',
    '""',
    "A:",
    "A1:A1:",
    "SUM(",
    "#",
    "Table1[",
    "a!",
    "Tabella1[",
    "Tabella1[[",
    "Tabella1['",
    "Tabella1[#",
]


@pytest.mark.parametrize("piece", PIECES)
def test_reads_pathological_formulas_of_80000_characters_in_linear_time(piece):
    timings = []
    for size in (20_000, 80_000):
        formula = piece * max(1, size // len(piece))
        started = time.perf_counter()
        formula_findings(formula, WORKBOOK)
        timings.append(time.perf_counter() - started)
    # Four times the input in at most about eight times the time (linear, with margin for noise).
    assert timings[1] < max(timings[0], 0.002) * 8
