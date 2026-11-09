"""Generate the `supertag.operator.v1` bindings from the operator API protos.

Run it with the SDK's dev environment, which pins the generators:

    python sdks/python/scripts/generate_operator_api.py

`--check` regenerates into a temporary directory and fails when the checked-in bindings differ.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SDK = Path(__file__).resolve().parents[1]
PROTO_ROOT = SDK.parents[1] / "spec" / "proto"
PACKAGE = Path("supertag") / "operator" / "v1"
BINDINGS = SDK / "src" / PACKAGE
GENERATED_SUFFIXES = ("_pb2.py", "_pb2.pyi", "_connect.py")


def generated_files(directory: Path) -> dict[str, bytes]:
    return {
        path.name: path.read_bytes()
        for path in sorted(directory.iterdir())
        if path.name.endswith(GENERATED_SUFFIXES)
    }


def generate(output: Path) -> Path:
    plugin = Path(sys.executable).parent / "protoc-gen-connect-python"
    if not plugin.exists():
        found = shutil.which("protoc-gen-connect-python")
        if found is None:
            raise SystemExit("protoc-gen-connect-python is not installed; install the dev extra")
        plugin = Path(found)
    protos = sorted(str(path) for path in (PROTO_ROOT / PACKAGE).glob("*.proto"))
    subprocess.run(
        [
            sys.executable,
            "-m",
            "grpc_tools.protoc",
            f"-I{PROTO_ROOT}",
            f"--plugin=protoc-gen-connect-python={plugin}",
            f"--python_out={output}",
            f"--pyi_out={output}",
            f"--connect-python_out={output}",
            *protos,
        ],
        check=True,
    )
    return output / PACKAGE


def stale_bindings() -> list[str]:
    with tempfile.TemporaryDirectory() as temporary:
        expected = generated_files(generate(Path(temporary)))
    actual = generated_files(BINDINGS)
    return sorted(
        name for name in expected.keys() | actual.keys() if expected.get(name) != actual.get(name)
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail on stale bindings")
    arguments = parser.parse_args()
    if arguments.check:
        stale = stale_bindings()
        if stale:
            raise SystemExit(
                "Stale operator API bindings: "
                + ", ".join(stale)
                + "; run python sdks/python/scripts/generate_operator_api.py"
            )
        return
    with tempfile.TemporaryDirectory() as temporary:
        fresh = generate(Path(temporary))
        for name in generated_files(BINDINGS):
            (BINDINGS / name).unlink()
        BINDINGS.mkdir(parents=True, exist_ok=True)
        for name, content in generated_files(fresh).items():
            (BINDINGS / name).write_bytes(content)


if __name__ == "__main__":
    main()
