#!/usr/bin/env python3
"""Prepare and independently verify the live Rust Worker exercise."""

import argparse
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path


BRANCH = "codex/rust-harness-live"
FILES = ["src/duration.js", "test/duration.test.js"]
PROJECT_FILES = ["package.json", *FILES]
COMMIT_ID = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
BASELINE_TEST_COUNT = 2
EXTERNAL_CHECK_COUNT = 37

PROMPT = """Improve the parseDuration utility in this local Git repository.

Accept nonnegative finite JavaScript numbers as milliseconds. After trimming leading and trailing
whitespace from a string, accept an unsigned decimal followed immediately by one lowercase unit
ms, s, m, or h. A decimal may include a fractional part, such as 1.5 or .5. Return milliseconds
and throw TypeError for negative, non-finite, malformed, or unsupported inputs, including a string
whose converted result overflows. Add tests for the new behavior using node:test.

Change only src/duration.js and test/duration.test.js. Use only the local workspace and tools.
Run npm test and npm run check. Commit both files together on the current branch, leave a clean
working tree, and report the full commit hash and check results. Keep the existing Git settings
and package.json. Use no dependencies, external services, or remotes.
"""

SOURCE = """export function parseDuration(value) {
  if (typeof value === "number") return value;
  throw new TypeError("Expected a number of milliseconds");
}
"""

TESTS = """import assert from "node:assert/strict";
import test from "node:test";
import { parseDuration } from "../src/duration.js";

test("returns numbers in milliseconds", () => {
  assert.equal(parseDuration(0), 0);
  assert.equal(parseDuration(125), 125);
});

test("rejects missing values", () => {
  assert.throws(() => parseDuration(undefined), TypeError);
});
"""

EXTERNAL_CHECKS = """import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const { parseDuration } = await import(pathToFileURL(process.argv[2]));
const valid = [
  [0, 0], [0.125, 0.125], [125, 125], [Number.MAX_VALUE, Number.MAX_VALUE],
  ["0ms", 0], ["2.5ms", 2.5], ["\\t1.25s \\n", 1250], [".5s", 500],
  ["2m", 120000], ["1.5m", 90000], ["1h", 3600000], [".25h", 900000],
];
const invalid = [
  -1, Number.NaN, Infinity, -Infinity, undefined, null, true, [], {},
  "", " ", "1", "-1s", "+1s", "1 s", "1S", "1d", "s", "1.2.3s", "1e2ms", "0x10ms",
  "NaNms", "Infinityh", "1ms extra", "9".repeat(309) + "h",
];
for (const [value, expected] of valid) {
  assert.equal(parseDuration(value), expected, `duration ${JSON.stringify(value)}`);
}
for (const value of invalid) {
  assert.throws(() => parseDuration(value), TypeError, `duration ${String(value)}`);
}
console.log(JSON.stringify({ passed: valid.length + invalid.length }));
"""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def run(
    workspace: Path,
    env: dict[str, str],
    *args: str,
    stdin: str | None = None,
) -> str:
    result = subprocess.run(
        args, cwd=workspace, env=env, input=stdin, text=True, capture_output=True, timeout=60
    )
    if result.returncode != 0:
        output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
        raise ValueError(f"{' '.join(args)} exited {result.returncode}\n{output}")
    return result.stdout


def git(workspace: Path, *args: str) -> str:
    env = {
        "PATH": os.environ.get("PATH", os.defpath),
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_NO_REPLACE_OBJECTS": "1",
    }
    return run(
        workspace, env, "git", "--no-optional-locks", "-c", f"core.hooksPath={os.devnull}",
        "-c", "core.fsmonitor=false", *args,
    )


def prepare(workspace: Path) -> dict:
    workspace.mkdir()
    workspace = workspace.resolve()
    git(workspace, "init", "--quiet", "--template=", "--initial-branch", BRANCH)
    git(workspace, "config", "--local", "user.name", "SuperTag Interoperability Fixture")
    git(workspace, "config", "--local", "user.email", "fixture@example.test")
    for name, content in zip(FILES, [SOURCE, TESTS]):
        path = workspace / name
        path.parent.mkdir()
        path.write_text(content, encoding="utf-8")
    package = {
        "name": "supertag-duration-fixture",
        "private": True,
        "type": "module",
        "scripts": {
            "test": "node --test",
            "check": "node --check src/duration.js && node --check test/duration.test.js",
        },
    }
    (workspace / "package.json").write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    git(workspace, "add", "--", *PROJECT_FILES)
    git(workspace, "commit", "--quiet", "-m", "Seed the duration utility exercise")
    return {
        "workspace": str(workspace),
        "baseCommit": git(workspace, "rev-parse", "HEAD").strip(),
        "prompt": PROMPT,
    }


def verify_tree(workspace: Path, commit: str) -> None:
    require(
        git(workspace, "rev-parse", "HEAD").strip() == commit,
        "HEAD does not match the claimed commit",
    )
    require(
        git(workspace, "symbolic-ref", "--short", "HEAD").strip() == BRANCH,
        "unexpected branch",
    )
    require(git(workspace, "remote").strip() == "", "workspace has a Git remote")
    status = git(
        workspace, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"
    )
    require(status == "", f"working tree is dirty\n{status}")

    tree = git(workspace, "ls-tree", "-r", "--full-tree", "-z", commit)
    entries = {}
    for record in tree.split("\0")[:-1]:
        entry, name = record.split("\t", 1)
        entries[name] = entry
    require(sorted(entries) == PROJECT_FILES, "commit does not contain exactly the exercise files")
    for name, entry in entries.items():
        mode, kind, blob = entry.split()
        require(mode == "100644" and kind == "blob", f"unexpected committed file mode for {name}")
        path = workspace / name
        require(stat.S_ISDIR(path.parent.lstat().st_mode), f"expected a directory for {name}")
        disk_mode = path.lstat().st_mode
        require(
            stat.S_ISREG(disk_mode) and (disk_mode & 0o111) == 0,
            f"expected a non-executable regular file at {name}",
        )
        # Read the raw bytes directly. Git status can skip paths marked assume-unchanged.
        actual = git(workspace, "hash-object", "--no-filters", "--", name).strip()
        require(actual == blob, f"working tree bytes differ from the claimed commit for {name}")


def verify(workspace: Path, base: str, commit: str) -> dict:
    workspace = workspace.resolve(strict=True)
    require(bool(COMMIT_ID.fullmatch(base)), "expected a full base commit hash")
    require(bool(COMMIT_ID.fullmatch(commit)), "expected a full claimed commit hash")
    root = Path(git(workspace, "rev-parse", "--show-toplevel").strip()).resolve()
    require(workspace == root, "workspace is not the repository root")
    verify_tree(workspace, commit)
    parents = git(workspace, "rev-list", "--parents", "-n", "1", commit).split()
    require(parents == [commit, base], "expected exactly one non-merge commit after the base commit")
    require(
        git(workspace, "rev-parse", f"{base}:package.json")
        == git(workspace, "rev-parse", f"{commit}:package.json"),
        "package.json changed",
    )
    changed = git(workspace, "diff", "--name-only", "--no-renames", "-z", base, commit, "--")
    files = sorted(changed.split("\0")[:-1])
    require(files == FILES, f"expected changes to both exercise files only, found {files}")

    with tempfile.TemporaryDirectory(prefix="supertag-rust-verify-") as directory:
        env = {
            "HOME": directory,
            "PATH": os.environ.get("PATH", os.defpath),
            "npm_config_userconfig": str(Path(directory) / "user-npmrc"),
            "npm_config_globalconfig": str(Path(directory) / "global-npmrc"),
            "npm_config_offline": "true",
        }
        tests = run(workspace, env, "npm", "test")
        counts = {
            name: int(count)
            for name, count in re.findall(r"^# (tests|pass|fail) (\d+)$", tests, re.MULTILINE)
        }
        require(
            counts.get("tests", 0) > BASELINE_TEST_COUNT
            and counts.get("tests") == counts.get("pass")
            and counts.get("fail") == 0,
            f"expected more than {BASELINE_TEST_COUNT} passing Node tests\n{tests}",
        )
        syntax = run(workspace, env, "npm", "run", "check")
        external = run(
            workspace, env, "node", "--input-type=module", "-", str(workspace / FILES[0]),
            stdin=EXTERNAL_CHECKS,
        )
        result = json.loads(external.splitlines()[-1]) if external.strip() else {}
        require(
            result == {"passed": EXTERNAL_CHECK_COUNT},
            f"expected all independent duration checks to run\n{external}",
        )
    verify_tree(workspace, commit)
    return {
        "accepted": True,
        "committedTreeVerified": True,
        "commit": commit,
        "branch": BRANCH,
        "files": files,
        "checks": {
            "test": {"count": counts["tests"], "passed": counts["pass"], "stdout": tests},
            "syntax": {"stdout": syntax},
            "external": {
                "count": EXTERNAL_CHECK_COUNT,
                "passed": result["passed"],
                "stdout": external,
            },
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("prepare").add_argument("workspace", type=Path)
    verifier = commands.add_parser("verify")
    verifier.add_argument("workspace", type=Path)
    verifier.add_argument("base_commit")
    verifier.add_argument("claimed_commit")
    args = parser.parse_args()
    try:
        result = (
            prepare(args.workspace)
            if args.command == "prepare"
            else verify(args.workspace, args.base_commit, args.claimed_commit)
        )
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"live project: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
