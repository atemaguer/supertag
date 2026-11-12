# /// script
# requires-python = ">=3.13"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Exercise an extracted native release in a fresh HOME with no provider calls."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile

from native_archive import (ArchiveError, REPO, digest, native_platform, require)
from node_bridges import PACKAGES, smoke_entry, verify_node, verify_relocatable_tree
from release_archive import extract_release, validate_release
from smoke_native_archive import smoke, wait_until


def installed_bridge(package, node, fixture_source, scratch):
    """Real Host -> installed OpenCode bridge -> synthetic native subprocess."""
    home, tools, vendor = (scratch / name for name in ("home", "bin", "vendor"))
    for directory in (home, tools, vendor):
        directory.mkdir(mode=0o700)
    (tools / "node").symlink_to(node.resolve())
    (tools / "supertag").symlink_to(package / "supertag")
    native = vendor / "opencode.mjs"
    native.write_text(f"#!{node.resolve()}\n" + fixture_source.read_text())
    native.chmod(0o700)
    cli, state = tools / "supertag", scratch / "state"
    env = {"PATH": f"{tools}:{os.defpath}", "HOME": str(home), "LANG": "C.UTF-8"}
    with (scratch / "up.log").open("w+") as log:
        service = subprocess.Popen([cli, "up", "--state-directory", state, "--harness", "opencode",
                                    "--harness-model", "openai/fixture-model", "--opencode-path", native],
                                   cwd=home, env={**env, "OPENAI_API_KEY": "synthetic-opencode-provider-key"},
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
        def invoke(*arguments):
            result = subprocess.run([cli, *arguments, "--state-directory", state], cwd=home, env=env,
                                    capture_output=True, text=True, timeout=20)
            require(result.returncode == 0, "installed bridge CLI command failed: " + result.stderr[-1000:])
            return json.loads(result.stdout)
        try:
            def ready():
                require(service.poll() is None, "installed bridge service stopped before readiness")
                return (state / "endpoint").exists()
            wait_until(ready, "installed bridge readiness")
            invoke("put-tag", "packaged-opencode", "--instructions", "Installed packaging smoke",
                   "--harness", "opencode", "--allow", "files:read")
            task = invoke("submit", "--tag", "packaged-opencode", "--session", "default-discovery", "fixture:fresh")
            def complete():
                current = invoke("get-task", task["task_id"])
                return current if current["state"] in {"TASK_STATE_SUCCEEDED", "TASK_STATE_FAILED"} else None
            completed = wait_until(complete, "installed bridge Task result")
            require(completed["state"] == "TASK_STATE_SUCCEEDED" and "native-complete:" in completed["result"],
                    "installed bridge Task failed")
            require("synthetic-opencode-provider-key" not in completed["result"] and "[REDACTED]" in completed["result"],
                    "installed bridge did not redact synthetic provider evidence")
            calls = [json.loads(line) for line in (vendor / "calls.jsonl").read_text().splitlines()]
            require(len(calls) == 1 and calls[0]["mode"] == "fresh", "installed native fixture did not execute exactly once")
            service.send_signal(signal.SIGTERM)
            require(service.wait(timeout=30) == 0 and not (state / "endpoint").exists(), "installed bridge shutdown failed")
        finally:
            if service.poll() is None:
                service.send_signal(signal.SIGTERM)
                try:
                    service.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(service.pid, signal.SIGKILL)
                    service.wait(timeout=5)


def smoke_release(archive, fixture, node, opencode_fixture=None):
    opencode_fixture = opencode_fixture or REPO / "packages/runtime/harnesses/opencode/fixtures/native-opencode.mjs"
    verify_node(node)
    with tempfile.TemporaryDirectory(prefix="supertag-complete-smoke-") as temporary:
        scratch = Path(temporary)
        package = extract_release(archive, scratch / "extracted")
        manifest = json.loads((package / "manifest.json").read_text())
        require(manifest["platform"] == native_platform(), "smoke requires the native release platform")
        verify_relocatable_tree(package)
        for kind, name in PACKAGES.items():
            smoke_entry(node, kind, package / "node-bridges/node_modules" / name)
        installed_bridge(package, node, opencode_fixture, scratch)
        round_trip = smoke(archive, fixture, validator=validate_release, extractor=extract_release)
    return {"archive_sha256": digest(archive), "source": manifest["source"], "platform": manifest["platform"],
            "version": manifest["version"], "profile": manifest["profile"],
            "node_helpers_bootstrap": sorted(PACKAGES), "provider_credentials": "external; not used",
            "installed_opencode_task": True, "synthetic_native_fixture_sha256": digest(opencode_fixture),
            "fixture_adapter_sha256": round_trip["fixture_adapter_sha256"],
            "real_ui_task_round_trip": round_trip["real_ui_task_round_trip"],
            "clean_service_shutdown": round_trip["clean_service_shutdown"], "isolated_home_and_state": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--fixture-adapter", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    try:
        result = smoke_release(args.archive, args.fixture_adapter, args.node)
        encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
        if args.receipt:
            with args.receipt.open("x") as target:
                target.write(encoded)
        print(encoded, end="")
    except (ArchiveError, OSError, ValueError) as error:
        parser.exit(1, f"native release smoke: {error}\n")


if __name__ == "__main__":
    main()
