"""Run the language-neutral harness lifecycle cases through the Python conformance validator."""

import json
from pathlib import Path

from supertag.conformance import validate_events


def test_language_neutral_lifecycle_fixture() -> None:
    fixture = json.loads((Path(__file__).parent / "fixtures/harness-lifecycle.json").read_text())
    for case in fixture["cases"]:
        report = validate_events(case["events"], fixture["attempt"])
        assert report.passed is case["valid"], (case["name"], report.findings)
