#!/usr/bin/env python3
"""Verify a trusted local native archive with a real, disposable CLI/TUI round trip.

Requires tmux and an existing SuperTag fixture adapter built with test-fixtures.
The fixture adapter is test equipment and is never bundled in the archive.
No provider credentials, user state, installer, or external service is used.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

from native_archive import ArchiveError, check_versions, digest, extract_archive, native_platform, require, validate_archive

WAIT_SECONDS = 30


def run(command, env, timeout=WAIT_SECONDS):
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=timeout)
    require(result.returncode == 0, "packaged smoke command failed: " + " ".join(command[:2])
            + ": " + result.stderr[-1500:])
    return result.stdout


def wait_until(check, description):
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    raise ArchiveError("timed out waiting for " + description)


def smoke(path, fixture, checksum=None):
    path, fixture = Path(path).resolve(), Path(fixture).resolve()
    manifest = validate_archive(path, checksum)
    require(manifest["platform"] == native_platform(), "smoke test requires the archive's native platform")
    require(fixture.is_file() and os.access(fixture, os.X_OK), "fixture adapter must be executable")
    tmux = shutil.which("tmux")
    require(tmux is not None, "tmux is required for the packaged terminal UI smoke")
    with tempfile.TemporaryDirectory(prefix="supertag-archive-smoke-", dir="/tmp") as temporary:
        root = Path(temporary)
        package = extract_archive(path, root / "unpacked", checksum)
        cli, tui = package / "supertag", package / "supertag-tui"
        check_versions(cli, tui, manifest["version"])
        home, state = root / "home", root / "state"
        home.mkdir(mode=0o700)
        env = {"PATH": os.defpath, "HOME": str(home), "LANG": "C.UTF-8", "TERM": "xterm-256color"}
        socket = root / "tmux.sock"
        tmux_prefix = [tmux, "-f", "/dev/null", "-S", str(socket)]
        terminal_started = False
        with (root / "service.log").open("w") as error_log:
            service = subprocess.Popen([str(cli), "up", "--adapter", str(fixture), "--state-directory", str(state)],
                env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=error_log, start_new_session=True)
            try:
                def ready():
                    require(service.poll() is None, "packaged local service stopped before readiness")
                    endpoint = state / "endpoint"
                    return endpoint.read_text().strip() if endpoint.exists() else None
                endpoint = wait_until(ready, "packaged local services")
                parsed = urlsplit(endpoint)
                require(parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "::1")
                        and parsed.port, "fixture service did not bind loopback")
                run([str(cli), "put-tag", "archive-agent", "--instructions", "Packaged archive fixture",
                     "--state-directory", str(state)], env)
                # No --binary or SUPERTAG_TUI_BINARY override: this proves sibling discovery.
                shell = shlex.join(["env", "-i", f"PATH={os.defpath}", f"HOME={home}",
                                    "TERM=xterm-256color", "LANG=C.UTF-8", f"SUPERTAG_STATE_DIR={state}", str(cli)])
                run([*tmux_prefix, "new-session", "-d", "-s", "archive", "-x", "160", "-y", "45", shell], env)
                terminal_started = True

                def pane_contains(text):
                    pane = run([*tmux_prefix, "capture-pane", "-p", "-t", "archive"], env)
                    return text in pane
                wait_until(lambda: pane_contains("Say something to archive-agent"), "loaded packaged TUI conversation")
                run([*tmux_prefix, "send-keys", "-t", "archive", "-l", "Packaged UI round trip"], env)
                run([*tmux_prefix, "send-keys", "-t", "archive", "Enter"], env)
                wait_until(lambda: pane_contains("Packaged archive fixture: Packaged UI round trip"), "packaged UI Task result")
                run([*tmux_prefix, "send-keys", "-t", "archive", "C-c"], env)
                service.send_signal(signal.SIGTERM)
                require(service.wait(timeout=WAIT_SECONDS) == 0, "packaged services did not stop cleanly")
            finally:
                if terminal_started:
                    subprocess.run([*tmux_prefix, "kill-server"], env=env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
                if service.poll() is None:
                    service.send_signal(signal.SIGTERM)
                    try:
                        service.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        os.killpg(service.pid, signal.SIGKILL)
                        service.wait(timeout=5)
    return {"archive_sha256": digest(path), "version": manifest["version"], "platform": manifest["platform"],
            "profile": manifest["profile"], "features": manifest["features"], "source": manifest["source"],
            "fixture_adapter_sha256": digest(fixture), "isolated_home_and_state": True,
            "default_sibling_tui": True, "real_ui_task_round_trip": True, "clean_service_shutdown": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--checksum", type=Path)
    parser.add_argument("--fixture-adapter", type=Path, required=True)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    try:
        result = smoke(args.archive, args.fixture_adapter, args.checksum)
        encoded = json.dumps(result, sort_keys=True, indent=2) + "\n"
        if args.receipt:
            with args.receipt.open("x") as target:
                target.write(encoded)
        print(encoded, end="")
    except (ArchiveError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"native archive smoke: {error}\n")


if __name__ == "__main__":
    main()
