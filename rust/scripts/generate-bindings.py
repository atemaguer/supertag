# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "grpcio==1.85.1",
#   "grpcio-tools==1.85.1",
#   "protobuf==7.36.2",
# ]
# ///
"""Generate the Go, TypeScript, and Python bindings for the Rust runtime API."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

RUST = Path(__file__).resolve().parents[1]
REPO = RUST.parent
PROTO_ROOT = RUST / "proto"
PROTO_FILE = "supertag/runtime/v2/runtime.proto"
BINDINGS = RUST / "bindings"
PYTHON_SDK = REPO / "sdks" / "python" / "src" / "supertag" / "_runtime_v2"
PYTHON_PROTO = Path("python/supertag/runtime/v2")
TYPESCRIPT_PROTO = Path("typescript/supertag/runtime/v2/runtime_pb.ts")
CLAUDE_DESCRIPTOR = (
    REPO / "packages/runtime/harnesses/claude-code/src/rust-adapter/gen"
    / "supertag/runtime/v2/runtime_pb.ts"
)
GO_MODULE = "github.com/atemaguer/supertag/rust/bindings/go"
GO_TOOLS = REPO / "packages" / "operator-api" / "go"
OUTPUTS = (
    (Path("go/runtimev2"), (".pb.go", ".connect.go")),
    (Path("typescript/supertag/runtime/v2"), ("_pb.ts",)),
    (Path("python/supertag/runtime/v2"), ("_pb2.py", "_pb2.pyi", "_pb2_grpc.py")),
)


def generate(output: Path) -> None:
    go_options = [f"M{PROTO_FILE}={GO_MODULE}/runtimev2", f"module={GO_MODULE}"]
    template = {
        "version": "v2",
        "plugins": [
            {
                "local": "protoc-gen-es",
                "out": str(output / "typescript"),
                "opt": ["target=ts", "import_extension=js"],
            },
            *(
                {
                    "local": ["go", "-C", str(GO_TOOLS), "tool", plugin],
                    "out": str(output / "go"),
                    "opt": go_options,
                }
                for plugin in ("protoc-gen-go", "protoc-gen-connect-go")
            ),
        ],
    }
    subprocess.run(
        [
            "pnpm", "exec", "buf", "generate", str(PROTO_ROOT),
            "--path", str(PROTO_ROOT / PROTO_FILE), "--template", json.dumps(template),
        ],
        cwd=REPO,
        check=True,
    )
    for binding in (output / "typescript").rglob("*_pb.ts"):
        binding.write_bytes(binding.read_bytes().rstrip(b"\n") + b"\n")

    python_output = output / "python"
    python_output.mkdir()
    subprocess.run(
        [
            sys.executable,
            "-m",
            "grpc_tools.protoc",
            f"-I{PROTO_ROOT}",
            f"--python_out={python_output}",
            f"--pyi_out={python_output}",
            f"--grpc_python_out={python_output}",
            PROTO_FILE,
        ],
        cwd=PROTO_ROOT,
        check=True,
    )


def inventory(root: Path) -> dict[Path, bytes]:
    return {
        path.relative_to(root): path.read_bytes()
        for directory, suffixes in OUTPUTS
        for path in (root / directory).rglob("*")
        if path.is_file() and path.name.endswith(suffixes)
    }


def python_sdk_messages(expected: dict[Path, bytes]) -> dict[Path, bytes]:
    messages = expected[PYTHON_PROTO / "runtime_pb2.py"]
    original = b"'supertag.runtime.v2.runtime_pb2'"
    if messages.count(original) != 1:
        raise SystemExit("Unexpected Python protobuf module name in generated runtime bindings")
    return {
        PYTHON_SDK / "runtime_pb2.py": messages.replace(
            original, b"'supertag._runtime_v2.runtime_pb2'"
        ),
        PYTHON_SDK / "runtime_pb2.pyi": expected[PYTHON_PROTO / "runtime_pb2.pyi"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail on missing or stale bindings")
    args = parser.parse_args()

    with TemporaryDirectory(prefix="supertag-runtime-bindings-") as temporary:
        output = Path(temporary)
        generate(output)
        expected = inventory(output)
    if len(expected) != 6:
        raise SystemExit(f"expected six generated files, got {len(expected)}")
    checked_in = inventory(BINDINGS)
    package_bindings = {
        **python_sdk_messages(expected),
        CLAUDE_DESCRIPTOR: expected[TYPESCRIPT_PROTO],
    }
    if args.check:
        changed = sorted(
            path for path in expected.keys() | checked_in.keys()
            if expected.get(path) != checked_in.get(path)
        )
        changed.extend(
            path.relative_to(REPO)
            for path, content in package_bindings.items()
            if not path.is_file() or path.read_bytes() != content
        )
        if changed:
            raise SystemExit(
                "Stale runtime bindings: " + ", ".join(map(str, changed))
                + ". Run uv run --python 3.13 --script rust/scripts/generate-bindings.py."
            )
        print("Go, TypeScript, and Python runtime bindings match the protobuf source.")
        return

    for path in checked_in.keys() - expected.keys():
        (BINDINGS / path).unlink()
    for path, content in expected.items():
        target = BINDINGS / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    for path, content in package_bindings.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)


if __name__ == "__main__":
    main()
