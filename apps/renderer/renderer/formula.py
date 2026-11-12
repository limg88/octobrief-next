"""The formulas a template may hold: an allowlist, as `formula.ts` of the core, token by token.
The functions come from `schemas/formula-functions.json`, written by the core from
`PURE_FUNCTIONS`; the shared cases (`packages/core/test/fixtures/formulas.json`) pin that both
gates answer every formula the same way."""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

FUNCTIONS_FILE = Path(__file__).resolve().parent.parent / "schemas" / "formula-functions.json"
_FUNCTIONS = json.loads(FUNCTIONS_FILE.read_text(encoding="utf-8"))
PURE = frozenset(_FUNCTIONS["pure"])
LINKING = frozenset(_FUNCTIONS["linking"])

FUNCTION_PREFIXES = ("_XLFN._XLWS.", "_XLFN.", "_XLWS.")
ERRORS = (
    "#NULL!",
    "#DIV/0!",
    "#VALUE!",
    "#REF!",
    "#NAME?",
    "#NUM!",
    "#N/A",
    "#GETTING_DATA",
    "#SPILL!",
    "#CALC!",
    "#FIELD!",
    "#BLOCKED!",
    "#CONNECT!",
    "#BUSY!",
    "#UNKNOWN!",
)
DELIMITERS = frozenset(" \t\n\r+-*/^&=<>%,;:(){}\"'[]!#@|")
OPERATORS = frozenset("+-*/^&=<>%,;:(){}@")
_CELL = re.compile(r"\$?[A-Za-z]{1,3}\$?[0-9]+", re.ASCII)
_COLUMN = re.compile(r"\$?[A-Za-z]{1,3}", re.ASCII)
_ROW = re.compile(r"\$?[0-9]+", re.ASCII)
_DIGITS = frozenset("0123456789")
_NUMBER_CHARS = frozenset("0123456789.")
ACTIVE = "template_active_content"
EXTERNAL = "template_external_link"
# A quoted sheet reference that holds a path or a workbook (a `:` only splits a 3D one).
_QUOTED_PATH = frozenset("/\\[]")
SHEET_FORBIDDEN = frozenset("\\/?*[]:")
MAX_SHEET_NAME = 31
MAX_DEFINED_NAME = 255
STRUCTURED_SPECIFIERS = ("#ALL", "#DATA", "#HEADERS", "#TOTALS", "#THIS ROW")
_LOWER_ASCII = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
_UPPER_ASCII = str.maketrans("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ")


@dataclass(frozen=True)
class WorkbookNames:
    """What a workbook defines, with its ASCII letters in lower case (`fold_ascii`): its sheets,
    its defined names and its tables."""

    sheets: frozenset[str] = field(default_factory=frozenset)
    names: frozenset[str] = field(default_factory=frozenset)
    tables: frozenset[str] = field(default_factory=frozenset)


NO_WORKBOOK = WorkbookNames()


def fold_ascii(value: str) -> str:
    """A name with its ASCII letters in lower case and every other character as it is, as
    `foldAscii` of the core: a character that folds to an ASCII letter only in Unicode (the Kelvin
    sign, a long s, a ligature) is not that letter here."""
    return value.translate(_LOWER_ASCII)


def _upper_ascii(value: str) -> str:
    return value.translate(_UPPER_ASCII)


def _letter_or_number(c: str) -> bool:
    """A letter or a number of any script, by Unicode category, as the core tests it."""
    return unicodedata.category(c)[0] in ("L", "N")


def is_sheet_name(name: str) -> bool:
    """Whether a sheet name is one Excel accepts, as `isSheetName` of the core: 1 to 31
    characters, none of `\\ / ? * [ ] :`, not starting or ending with a quote."""
    if not 1 <= len(name) <= MAX_SHEET_NAME:
        return False
    if name.startswith("'") or name.endswith("'"):
        return False
    return not any(c in SHEET_FORBIDDEN for c in name)


def is_defined_name(name: str) -> bool:
    """Whether a defined name or a table name is one Excel accepts, with no path character in
    it, as `isDefinedName` of the core: a letter or `_` first, then letters, numbers, `_` and
    `.`, at most 255 characters."""
    if not 1 <= len(name) <= MAX_DEFINED_NAME:
        return False
    for i, c in enumerate(name):
        if c == "_":
            continue
        if c == ".":
            if i == 0:
                return False
            continue
        if not _letter_or_number(c) or (i == 0 and unicodedata.category(c)[0] == "N"):
            return False
    return True


def _word_char(c: str) -> bool:
    code = ord(c)
    return code > 0x20 and code != 0x7F and c not in DELIMITERS


def _function_name(word: str) -> str:
    upper = _upper_ascii(word)
    for prefix in FUNCTION_PREFIXES:
        if upper.startswith(prefix):
            return upper[len(prefix) :]
    return upper


def _sheets_exist(name: str, workbook: WorkbookNames) -> bool:
    lower = fold_ascii(name)
    if lower in workbook.sheets:
        return True
    parts = lower.split(":")
    return len(parts) == 2 and all(p in workbook.sheets for p in parts)


def _three_dimensional(formula: str, colon: int) -> int | None:
    end = colon + 1
    while end < len(formula) and _word_char(formula[end]):
        end += 1
    if end == colon + 1 or end >= len(formula) or formula[end] != "!":
        return None
    return end + 1


# The characters a `'` may escape in a structured reference (ECMA-376 18.17.2), and besides
# letters and numbers what a column name in single brackets may hold.
_STRUCTURED_ESCAPED = frozenset("'[]#")
_SINGLE_BRACKET = frozenset("_. %\u20ac")


def _is_control(c: str) -> bool:
    code = ord(c)
    return code < 0x20 or 0x7F <= code <= 0x9F


def _structured_reference(formula: str, start: int) -> tuple[int | None, bool]:
    """A structured reference opened at `start`, as `structuredReference` of the core: where it
    ends (None when it never closes) and whether it holds only column names (in inner brackets
    any character but a control one and an unescaped `[ ] # ' @`, in single brackets only
    letters, numbers, `_ . % €` and space; `'` escapes only `' [ ] #`) and the specifiers right
    after a `[`; `,` and `:`
    separate the items of the outer brackets, where a name or a specifier must be the whole
    reference; at most two levels."""
    depth = 0
    clean = True
    bare = False
    nested = False
    separated = False
    k = start
    n = len(formula)
    while k < n:
        ch = formula[k]
        if ch == "[":
            depth += 1
            if depth == 2:
                nested = True
            if depth > 2:
                clean = False
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return k + 1, clean and not (bare and (nested or separated))
        elif depth == 1 and ch in ",:":
            separated = True
        elif ch != " ":
            if depth == 1:
                bare = True
            if ch == "'":
                # An escape, only of the characters that would end or change a name.
                k += 1
                if k >= n:
                    return None, clean
                if formula[k] not in _STRUCTURED_ESCAPED:
                    clean = False
            elif ch == "#":
                rest = _upper_ascii(formula[k : k + 9])
                specifier = next((s for s in STRUCTURED_SPECIFIERS if rest.startswith(s)), None)
                length = len(specifier) if specifier is not None else 0
                placed = formula[k - 1 : k] == "[" and formula[k + length : k + length + 1] == "]"
                if specifier is None or not placed:
                    clean = False
                else:
                    k += length - 1
            elif ch == "@" or _is_control(ch):
                clean = False
            elif depth == 1 and not (_letter_or_number(ch) or ch in _SINGLE_BRACKET):
                # In single brackets only plain names: anything else needs `[[...]]`.
                clean = False
        k += 1
    return None, clean


def _bracket_end(formula: str, start: int) -> int | None:
    depth = 0
    k = start
    while k < len(formula):
        ch = formula[k]
        if ch == "'":
            k += 1
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return k + 1
        k += 1
    return None


def formula_findings(formula: str, workbook: WorkbookNames = NO_WORKBOOK) -> list[str]:
    """What a decoded formula holds that a template may not, as `formulaFindings` of the core."""
    found: set[str] = set()
    n = len(formula)
    at = 0
    after_colon = False
    while at < n:
        c = formula[at]
        if c in " \t\n\r":
            at += 1
            continue
        if c == '"':
            end = formula.find('"', at + 1)
            while end >= 0 and end + 1 < n and formula[end + 1] == '"':
                end = formula.find('"', end + 2)
            if end < 0:
                found.add(ACTIVE)
                break
            at = end + 1
            after_colon = False
            continue
        if c == "'":
            name = []
            end = at + 1
            while end < n:
                if formula[end] != "'":
                    name.append(formula[end])
                elif end + 1 < n and formula[end + 1] == "'":
                    name.append("'")
                    end += 1
                else:
                    break
                end += 1
            dde = at > 0 and formula[at - 1] == "|"
            if end >= n or end + 1 >= n or formula[end + 1] != "!":
                found.add(ACTIVE if dde else EXTERNAL)
                at = end + 1
            else:
                # A path or a workbook in quotes is never a sheet, whatever the workbook declares.
                quoted = "".join(name)
                if not dde and (
                    any(ch in _QUOTED_PATH for ch in quoted) or not _sheets_exist(quoted, workbook)
                ):
                    found.add(EXTERNAL)
                at = end + 2
            after_colon = False
            continue
        if c == "[":
            found.add(EXTERNAL)
            close = _bracket_end(formula, at)
            at = n if close is None else close
            continue
        if c == "#":
            rest = _upper_ascii(formula[at : at + 14])
            error = next((e for e in ERRORS if rest.startswith(e)), None)
            if error is None:
                found.add(ACTIVE)
                at += 1
            else:
                at += len(error)
            after_colon = False
            continue
        if c in "|!]":
            found.add(ACTIVE)
            at += 1
            continue
        if c in OPERATORS:
            after_colon = c == ":"
            at += 1
            continue
        if c in _DIGITS or (c == "." and at + 1 < n and formula[at + 1] in _DIGITS):
            end = at
            while end < n and formula[end] in _NUMBER_CHARS:
                end += 1
            if (
                end + 1 < n
                and formula[end] in "eE"
                and (formula[end + 1] in "-+" or formula[end + 1] in _DIGITS)
            ):
                end += 2
                while end < n and formula[end] in _DIGITS:
                    end += 1
            if not (end < n and _word_char(formula[end])):
                at = end
                after_colon = False
                continue
        if not _word_char(c):
            found.add(ACTIVE)
            at += 1
            continue
        end = at
        while end < n and _word_char(formula[end]):
            end += 1
        word = formula[at:end]
        following = formula[end] if end < n else ""
        if following == "(":
            name = _function_name(word)
            if name in LINKING:
                found.add(EXTERNAL)
            elif name not in PURE:
                found.add(ACTIVE)
            at = end
        elif following == "!":
            if not _sheets_exist(word, workbook):
                found.add(EXTERNAL)
            at = end + 1
        elif following == "[":
            close, clean = _structured_reference(formula, end)
            if fold_ascii(word) not in workbook.tables or close is None:
                found.add(EXTERNAL)
            elif not clean:
                found.add(ACTIVE)
            at = n if close is None else close
        elif following == ":" and _three_dimensional(formula, end) is not None:
            after = _three_dimensional(formula, end)
            if not _sheets_exist(formula[at : after - 1], workbook):
                found.add(EXTERNAL)
            at = after
        else:
            lower = fold_ascii(word)
            in_range = after_colon or following == ":"
            allowed = (
                lower in ("true", "false")
                or _CELL.fullmatch(word) is not None
                or (in_range and (_COLUMN.fullmatch(word) or _ROW.fullmatch(word)) is not None)
                or lower in workbook.names
            )
            if not allowed:
                found.add(ACTIVE)
            at = end
        after_colon = False
    return [f for f in (ACTIVE, EXTERNAL) if f in found]
