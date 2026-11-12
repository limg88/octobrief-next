"""What every format writes, the same way: texts of the language of the document, the header with
the age of the data, the numbers of the notes (each once per segment or cell), «non dedotto»."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

ROME = ZoneInfo("Europe/Rome")

TEXTS = {
    "it": {
        "not_deduced": "non dedotto",
        "sources": "Fonti",
        "internal_notes": "Note per il PM",
        "header": "Dati al {data_as_of}, generato il {generated_at}",
        "header_undated": "Data dei dati non indicata, generato il {generated_at}",
        "note": "{n}. {label}, dati al {data_as_of}",
        "note_undated": "{n}. {label}",
        "document_sheet": "Documento",
        "sources_comment": "Fonti: {numbers}",
    }
}


def text(document: dict, key: str, **params: object) -> str:
    return TEXTS[document["lang"]][key].format(**params)


def _instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(ROME)


def format_instant(value: str) -> str:
    """An instant as the PM reads it, in the time of Rome: «05/11/2026 09:00»."""
    return _instant(value).strftime("%d/%m/%Y %H:%M")


def header_line(document: dict) -> str:
    header = document["header"]
    generated_at = format_instant(header["generatedAt"])
    if header["dataAsOf"] is None:
        return text(document, "header_undated", generated_at=generated_at)
    return text(
        document,
        "header",
        data_as_of=format_instant(header["dataAsOf"]),
        generated_at=generated_at,
    )


def note_lines(document: dict) -> list[str]:
    """The numbered notes. The generic note of a client version already says the day of its
    data, so it is written as it is; an internal note is followed by the instant of its data."""
    lines = []
    for note in document["sourceNotes"]:
        if note["dataAsOf"] is None or document["audience"] == "client":
            lines.append(text(document, "note_undated", n=note["n"], label=note["label"]))
        else:
            lines.append(
                text(
                    document,
                    "note",
                    n=note["n"],
                    label=note["label"],
                    data_as_of=format_instant(note["dataAsOf"]),
                )
            )
    return lines


def note_numbers(sources: list[int]) -> str:
    """The notes of one segment or cell, each once, in order: a segment may cite the same note
    for operands of different categories."""
    return ",".join(str(n) for n in sorted(set(sources)))


@dataclass(frozen=True)
class Run:
    """A piece of text and the notes it cites, shown after it."""

    text: str
    notes: str = ""


def segment_runs(segments: list[dict]) -> list[Run]:
    return [Run(s["text"], note_numbers(s["sources"])) for s in segments]


def cell_run(document: dict, cell: dict) -> Run:
    value = cell["text"]
    if value is None:
        return Run(text(document, "not_deduced"))
    return Run(value, note_numbers(cell["sources"]))


def block_runs(document: dict, block: dict) -> list[list[Run]]:
    """The lines of a block that is not a table, each a list of runs."""
    kind = block["kind"]
    if kind == "static":
        return [[Run(block["text"])]]
    if kind == "text":
        if block["notDeduced"] or not block["segments"]:
            return [[Run(text(document, "not_deduced"))]]
        return [segment_runs(block["segments"])]
    if kind == "value":
        return [[Run(f"{block['label']}: "), cell_run(document, block["cell"])]]
    if kind == "list":
        if block["notDeduced"] or not block["items"]:
            return [[Run(text(document, "not_deduced"))]]
        lines = []
        for item in block["items"]:
            runs: list[Run] = []
            for i, cell in enumerate(item["cells"]):
                if i > 0:
                    runs.append(Run(" — "))
                runs.append(cell_run(document, cell))
            lines.append(runs)
        return lines
    return []


def table_rows(document: dict, block: dict) -> list[list[Run]]:
    """The rows of a table block, at least one: «non dedotto» when it has none."""
    rows = [[cell_run(document, c) for c in row["cells"]] for row in block["rows"]]
    if not rows:
        width = len(block["columns"])
        rows = [[Run(text(document, "not_deduced"))] + [Run("") for _ in range(width - 1)]]
    return rows


def plain(runs: list[Run]) -> str:
    return "".join(r.text + (f" [{r.notes}]" if r.notes else "") for r in runs)


AUTHOR = "Octobrief"
