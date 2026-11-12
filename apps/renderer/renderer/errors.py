"""A refusal with its finding, raised while rendering and reported as the outcome of a check."""


class Refusal(Exception):
    def __init__(self, check: str, finding: str) -> None:
        super().__init__(f"{check}: {finding}")
        self.check = check
        self.finding = finding
