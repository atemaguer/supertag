# /// script
# requires-python = ">=3.13"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Install into a disposable HOME and use its normal command link for real Tasks."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from install_native_release import install
from native_archive import ArchiveError, REPO, digest, require
from release_archive import validate_release
from smoke_native_archive import smoke
from smoke_native_release import installed_bridge


def smoke_install(archive, fixture, node, opencode_fixture=None):
    archive, fixture, node = (Path(value).resolve(strict=True) for value in (archive, fixture, node))
    opencode_fixture = opencode_fixture or REPO / "packages/runtime/harnesses/opencode/fixtures/native-opencode.mjs"
    with tempfile.TemporaryDirectory(prefix="supertag-native-installed-") as temporary:
        root = Path(temporary).resolve(strict=True)
        home = root / "home"
        home.mkdir(mode=0o700)
        env = {"HOME": str(home), "PATH": os.defpath, "LANG": "C.UTF-8"}
        state = home / ".supertag"
        state.mkdir(mode=0o700)
        old_data = state / "preserved-old-state"
        old_data.write_bytes(b"This file stands for archived old state; installation must not modify it.")
        before = digest(old_data)
        first = install(archive, env=env, node=node, expected_sha256=digest(archive))
        require(not first["reused"], "fresh installation unexpectedly reused a release")
        command, package = Path(first["command"]), Path(first["installation"])
        require(command == home / ".local/bin/supertag" and command.is_symlink(), "normal command path was not installed")
        again = install(archive, env=env, node=node)
        require(again["reused"] and again["installation"] == first["installation"], "reinstall was not idempotent")
        runtime = root / "runtime"
        runtime.mkdir(mode=0o700)
        installed_bridge(package, node, opencode_fixture, runtime, cli_override=command)
        ui = smoke(archive, fixture, validator=validate_release, extractor=lambda *_: package, cli_override=command)
        require(digest(old_data) == before and set(state.iterdir()) == {old_data}, "installation changed old state")
        return {"archive_sha256": digest(archive), "version": first["version"], "platform": first["platform"],
                "normal_install_paths": True, "fresh_home": True, "idempotent_reinstall": True,
                "old_state_preserved": True, "installed_opencode_task": True,
                "installed_tui_task": ui["real_ui_task_round_trip"], "clean_service_shutdown": ui["clean_service_shutdown"],
                "fixture_adapter_sha256": digest(fixture), "synthetic_native_fixture_sha256": digest(opencode_fixture),
                "real_provider_calls": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--fixture-adapter", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--opencode-fixture", type=Path)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    try:
        result = smoke_install(args.archive, args.fixture_adapter, args.node, args.opencode_fixture)
        encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
        if args.receipt:
            with args.receipt.open("x") as target:
                target.write(encoded)
        print(encoded, end="")
    except (ArchiveError, OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"native install smoke: {error}\n")


if __name__ == "__main__":
    main()
