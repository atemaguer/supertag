#!/usr/bin/env python3
"""Verify a trusted local native archive with a real, disposable CLI round trip and a terminal
UI launch.

Requires an existing SuperTag fixture adapter built with the fixture-adapter feature
(test-fixtures includes it). Plain `supertag` starts the packaged terminal UI in a
pseudo-terminal, so no terminal multiplexer is needed.
The fixture adapter is test equipment and is never bundled in the archive.
No provider credentials, user state, installer, or external service is used.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
from urllib.parse import urlsplit

from native_archive import (ArchiveError, SHIP_TUI, check_tui, check_versions, digest, extract_archive, native_platform, require,
                            validate_archive)

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


# The terminal UI enters the alternate screen when it starts and leaves it when it exits.
ENTER_ALTERNATE_SCREEN = b"\x1b[?1049h"
LEAVE_ALTERNATE_SCREEN = b"\x1b[?1049l"


def launch_terminal_ui(cli, env, rows=40, columns=120):
    """Run plain `supertag` (or the terminal UI itself) with no arguments in a new
    pseudo-terminal: the CLI must find the terminal UI beside it, check its version and start it. The UI must draw on the alternate screen, keep running, and
    exit cleanly with the terminal restored when it reads Ctrl-C."""
    pid, terminal = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
            os.execve(str(cli), [str(cli)], env)
        finally:
            os._exit(127)
    output = bytearray()
    status = None

    def read(seconds):
        nonlocal status
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready, _, _ = select.select([terminal], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(terminal, 65536)
                except OSError:
                    chunk = b""
                output.extend(chunk)
                if not chunk:
                    time.sleep(0.05)
            if status is None:
                finished, code = os.waitpid(pid, os.WNOHANG)
                if finished:
                    status = code
            yield

    try:
        for _ in read(WAIT_SECONDS):
            if ENTER_ALTERNATE_SCREEN in output or status is not None:
                break
        require(status is None and ENTER_ALTERNATE_SCREEN in output,
                "plain supertag did not start the terminal UI: " + output[-800:].decode(errors="replace"))
        # Still running after its first frames; then quit as a person would.
        for _ in read(1.5):
            pass
        require(status is None, "the terminal UI stopped on its own: " + output[-800:].decode(errors="replace"))
        drawn = len(output)
        os.write(terminal, b"\x03")
        for _ in read(WAIT_SECONDS):
            if status is not None:
                break
        require(status is not None, "the terminal UI did not exit on Ctrl-C")
        require(os.waitstatus_to_exitcode(status) == 0, f"the terminal UI exited with {os.waitstatus_to_exitcode(status)}")
        require(LEAVE_ALTERNATE_SCREEN in output, "the terminal UI did not restore the terminal")
        return {"bytes_drawn": drawn}
    finally:
        if status is None:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(terminal)


def smoke(path, fixture, checksum=None, *, validator=validate_archive, extractor=extract_archive, cli_override=None):
    path, fixture = Path(path).resolve(), Path(fixture).resolve()
    manifest = validator(path, checksum)
    require(manifest["platform"] == native_platform(), "smoke test requires the archive's native platform")
    require(fixture.is_file() and os.access(fixture, os.X_OK), "fixture adapter must be executable")
    with tempfile.TemporaryDirectory(prefix="supertag-archive-smoke-", dir="/tmp") as temporary:
        root = Path(temporary)
        package = extractor(path, root / "unpacked", checksum)
        cli = cli_override or package / "supertag"
        if SHIP_TUI:
            check_versions(cli, package / "supertag-tui", manifest["version"])
            tui = check_tui(package / "supertag-tui", manifest["platform"])
        else:
            check_versions(cli, None, manifest["version"])
            require(not (package / "supertag-tui").exists() and not (package / "licenses/opentui").exists(),
                    "the archive carries the terminal UI, which does not ship (SHIP_TUI)")
        home, state = root / "home", root / "state"
        home.mkdir(mode=0o700)
        env = {"PATH": os.defpath, "HOME": str(home), "LANG": "C.UTF-8"}
        with (root / "service.log").open("w") as error_log:
            service = subprocess.Popen([str(cli), "up", "--foreground", "--adapter", str(fixture), "--state-directory", str(state)],
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
                run([str(cli), "tag", "put", "archive-agent", "--instructions", "Packaged archive fixture",
                     "--state-directory", str(state)], env)
                reply = run([str(cli), "message", "archive-agent", "Packaged CLI round trip",
                             "--state-directory", str(state)], env, timeout=2 * WAIT_SECONDS)
                require("Packaged archive fixture: Packaged CLI round trip" in reply,
                        "packaged CLI message did not print the Task result")
                if SHIP_TUI:
                    # No --binary or SUPERTAG_TUI_BINARY: this proves the CLI finds its sibling.
                    launch = launch_terminal_ui(cli, {**env, "TERM": "xterm-256color", "SUPERTAG_STATE_DIR": str(state)})
                    terminal_ui = {**tui, "default_sibling": True, "launched_in_terminal": True, **launch}
                else:
                    bare = subprocess.run([str(cli)], env=env, stdin=subprocess.DEVNULL, capture_output=True,
                                          text=True, timeout=WAIT_SECONDS)
                    require(bare.returncode == 2 and "Usage: supertag" in bare.stdout
                            and "The terminal UI isn't installed" in bare.stdout,
                            "plain supertag without the terminal UI did not print the help and say so")
                    terminal_ui = {"shipped": False, "plain_supertag_says_not_installed": True}
                service.send_signal(signal.SIGTERM)
                require(service.wait(timeout=WAIT_SECONDS) == 0, "packaged services did not stop cleanly")
            finally:
                if service.poll() is None:
                    service.send_signal(signal.SIGTERM)
                    try:
                        service.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        os.killpg(service.pid, signal.SIGKILL)
                        service.wait(timeout=5)
    return {"archive_sha256": digest(path), "version": manifest["version"], "platform": manifest["platform"],
            "profile": manifest["profile"], "features": manifest.get("features", []), "source": manifest["source"],
            "fixture_adapter_sha256": digest(fixture), "isolated_home_and_state": True,
            "real_cli_task_round_trip": True, "clean_service_shutdown": True,
            "terminal_ui": terminal_ui}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, nargs="?")
    parser.add_argument("--checksum", type=Path)
    parser.add_argument("--fixture-adapter", type=Path)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--terminal-ui", type=Path, metavar="BINARY",
                        help="instead of an archive, start this terminal UI in a pseudo-terminal and quit it")
    args = parser.parse_args()
    try:
        if args.terminal_ui:
            with tempfile.TemporaryDirectory(prefix="supertag-tui-smoke-") as home:
                result = launch_terminal_ui(args.terminal_ui.resolve(strict=True),
                                            {"PATH": os.defpath, "HOME": home, "TERM": "xterm-256color"})
        else:
            if args.archive is None or args.fixture_adapter is None:
                parser.error("an archive and --fixture-adapter are required")
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
