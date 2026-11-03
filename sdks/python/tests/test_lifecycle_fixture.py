"""The same portable event fixture is validated by the TypeScript conformance suite."""

import json
from pathlib import Path

from supertag.conformance import validate_events


def test_language_neutral_lifecycle_fixture() -> None:
    fixture = json.loads(
        (Path(__file__).resolve().parents[3] / "spec/fixtures/harness-lifecycle.json").read_text()
    )
    for case in fixture["cases"]:
        report = validate_events(case["events"], fixture["attempt"])
        assert report.passed is case["valid"], (case["name"], report.findings)
