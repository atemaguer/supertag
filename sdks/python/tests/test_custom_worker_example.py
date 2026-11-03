from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def test_custom_python_extension_examples_use_the_installed_sdk() -> None:
    repository = Path(__file__).resolve().parents[3]
    example = repository / "examples" / "custom-worker" / "verify.py"
    result = subprocess.run(
        [sys.executable, str(example)],
        cwd=example.parent,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == (
        "External Python Worker, Harness, and Environment conformance passed"
    )
