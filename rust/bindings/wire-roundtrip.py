# /// script
# requires-python = ">=3.10"
# dependencies = ["grpcio==1.85.1", "protobuf==7.36.2"]
# ///
"""Exercise the same protobuf Task across Python, Go, and TypeScript bindings."""

from __future__ import annotations

import importlib
import subprocess
import sys
from pathlib import Path

BINDINGS = Path(__file__).resolve().parent


def main() -> None:
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(BINDINGS / "python"))
    wire = importlib.import_module("supertag.runtime.v2.runtime_pb2")
    importlib.import_module("supertag.runtime.v2.runtime_pb2_grpc")

    task = wire.Task(
        task_id="first-task",
        tag_id="builder",
        session_id="workspace",
        prompt="Fix the café example",
        allowed_actions=["read", "write"],
        tag_revision=9007199254740993,
        state=wire.TASK_STATE_RUNNING,
        result="",
    )
    go_bytes = subprocess.run(
        ["go", "-C", str(BINDINGS / "go"), "run", "./conformance"],
        input=task.SerializeToString(),
        stdout=subprocess.PIPE,
        check=True,
    ).stdout
    typescript_bytes = subprocess.run(
        ["pnpm", "exec", "tsx", str(BINDINGS / "typescript" / "conformance.mjs")],
        cwd=BINDINGS.parents[1],
        input=go_bytes,
        stdout=subprocess.PIPE,
        check=True,
    ).stdout

    task.tag_revision += 1
    task.attempt_id = "go-attempt"
    task.state = wire.TASK_STATE_SUCCEEDED
    task.result = "✓ verified"
    actual = wire.Task.FromString(typescript_bytes)
    if actual != task:
        raise AssertionError(f"protobuf Task changed unexpectedly: {actual}")
    print("Python, Go, and TypeScript preserved the Task and its optional fields and uint64.")


if __name__ == "__main__":
    main()
