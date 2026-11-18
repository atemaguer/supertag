"""End-to-end journeys: a person sends a Task, a harness runs it, and the Worker Host keeps the
changes where the Workspace says.

Each run brings up a disposable `supertag up` (its own state directory and port, and its own
Gateway) with one host service, a local repository, and a `file://` bare repository as the git
server. The journeys:

- local: `land: local` writes the Session's branch into the repository and leaves its checkout
  alone;
- continuation: a second turn of that Session commits on top of the first;
- remote: a remote Workspace with `land` omitted pushes the Session's branch to the server;
- merge: `land: merge` merges a Work Session into its target only once it is closed;
- conflict: two Work Sessions change the same line; closing the second gives it a follow-up Task.

By default the host runs the fixture adapter, so no model is called. It needs a CLI built with
the fixture adapter beside it:

    cargo build -p supertag-cli --features test-fixtures --bin supertag --bin supertag-fixture-adapter
    SUPERTAG_E2E_BINARY=core/target/debug/supertag python3 -m unittest scripts/test_e2e_journeys.py

With `--harness codex` or `--harness claude-code` (or SUPERTAG_E2E_HARNESS), the host runs that
harness with this machine's own CLI login instead, which spends a few small turns. Claude Code
also needs its bridge staged beside the CLI (scripts/node_bridges.py). Without
SUPERTAG_E2E_BINARY every journey is skipped, as in CI.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

BINARY = os.environ.get("SUPERTAG_E2E_BINARY", "")
HARNESS = os.environ.get("SUPERTAG_E2E_HARNESS", "")
TERMINAL = {"TASK_STATE_SUCCEEDED", "TASK_STATE_FAILED", "TASK_STATE_CANCELLED", "TASK_STATE_UNCERTAIN"}
BASE = "base\n"


def git(directory: Path, *args: str) -> str:
    environment = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    return subprocess.run(
        ["git", "-C", str(directory), "-c", "user.name=Operator", "-c", "user.email=operator@example.com", *args],
        check=True, capture_output=True, text=True, env=environment,
    ).stdout


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def edit(line: str) -> str:
    """A turn that appends `line` to workspace.txt."""
    if HARNESS:
        return f"Append the line '{line}' at the end of workspace.txt, creating the file if it is missing. Change nothing else."
    return f"edit: {line}"


def start(title: str, line: str) -> str:
    """A turn that starts one Work Session whose turn appends `line` to workspace.txt."""
    if HARNESS:
        return (f"Start one work Session with start_session, titled '{title}', whose instruction is: "
                f"{edit(line)} Don't edit files yourself in this turn; just start it and reply briefly.")
    return f"start: {title} | {edit(line)}"


@unittest.skipUnless(BINARY, "set SUPERTAG_E2E_BINARY to a supertag built with --features test-fixtures")
class Journeys(unittest.TestCase):
    """One stack for every journey, in order: later journeys reuse the earlier Sessions' state."""

    timeout = 600 if HARNESS else 120

    @classmethod
    def setUpClass(cls):
        cls.binary = Path(BINARY).resolve()
        cls.temporary = tempfile.TemporaryDirectory(prefix="st-e2e-")
        cls.root = Path(cls.temporary.name)
        cls.state = cls.root / "state"
        cls.state.mkdir(mode=0o700)
        cls.repository = cls.root / "app"
        cls.server = cls.root / "server.git"

        cls.repository.mkdir()
        git(cls.repository, "init", "-q", "-b", "main")
        (cls.repository / "workspace.txt").write_text(BASE)
        git(cls.repository, "add", "-A")
        git(cls.repository, "commit", "-qm", "Initial")
        git(cls.root, "init", "-q", "--bare", "-b", "main", str(cls.server))
        git(cls.repository, "push", "-q", str(cls.server), "main")
        for target in ("drafts", "conflicts"):
            git(cls.server, "branch", target, "main")

        if HARNESS:
            runner = f"    harnesses: [{HARNESS}]\n"
            if HARNESS == "claude-code":
                runner += "    allow-unsandboxed-commands: [claude-code]\n"
        else:
            adapter = cls.binary.with_name("supertag-fixture-adapter")
            if not adapter.exists():
                raise unittest.SkipTest(f"{adapter} is missing: build it with --features test-fixtures")
            runner = f"    adapter: {adapter}\n    adapter-args: [--journey]\n"
        cls.port = free_port()
        (cls.state / "supertag.yaml").write_text(f"""version: 1
name: st-e2e
services:
  control-plane:
    type: control-plane
    ports: ["127.0.0.1:{cls.port}"]
    provision:
      - apiVersion: supertag/v1
        kind: PermissionSet
        metadata: {{ name: edit }}
        spec:
          permissions:
            - {{ target: runtime, action: files:write }}
            - {{ target: runtime, action: commands:execute }}
            - {{ target: runtime, action: web:fetch }}
      - apiVersion: supertag/v1
        kind: Role
        metadata: {{ name: Builder }}
        spec:
          purpose: "Make small, bounded repository changes and report what changed."
          permissionSets: [edit]
  e2e:
    type: host
{runner}    concurrency: 2
    depends_on: [control-plane]
    workspaces:
      app: {{ path: {cls.repository}, land: local }}
      handbook: {{ remote: true }}
      handbook-m: {{ remote: true }}
      handbook-c: {{ remote: true }}
""")
        cls.cli("up")
        cls.addClassCleanup(cls.down)
        remote = f"file://{cls.server}"
        cls.cli("workspace", "put", "handbook", "--remote", remote, "--ref", "main")
        cls.cli("workspace", "put", "handbook-m", "--remote", remote, "--ref", "main",
                "--land", "merge", "--target", "drafts")
        cls.cli("workspace", "put", "handbook-c", "--remote", remote, "--ref", "main",
                "--land", "merge", "--target", "conflicts")
        execution = f"  execution: {{ harness: {HARNESS} }}\n" if HARNESS else ""
        tags = []
        for name, workspace in (("local", "{ id: app, ref: main }"), ("remote", "{ id: handbook }"),
                                ("merge", "{ id: handbook-m }"), ("conflict", "{ id: handbook-c }")):
            tags.append(f"""apiVersion: supertag/v1
kind: Tag
metadata: {{ name: {name} }}
spec:
  instructions: "Make the smallest change that does what is asked. Commit nothing yourself. Be brief."
  roles: [Builder]
{execution}  workspace: {workspace}
""")
        manifest = cls.root / "tags.yaml"
        manifest.write_text("---\n".join(tags))
        cls.cli("apply", "-f", str(manifest))

    @classmethod
    def down(cls):
        subprocess.run([str(cls.binary), "down", "--force"], env=cls.environment(), capture_output=True)
        cls.temporary.cleanup()

    @classmethod
    def environment(cls) -> dict[str, str]:
        environment = {key: value for key, value in os.environ.items() if not key.startswith("SUPERTAG_")}
        environment["SUPERTAG_STATE_DIR"] = str(cls.state)
        return environment

    @classmethod
    def cli(cls, *args: str):
        done = subprocess.run([str(cls.binary), *args], env=cls.environment(), capture_output=True, text=True,
                              timeout=300)
        if done.returncode != 0:
            raise AssertionError(f"supertag {' '.join(args)} failed:\n{done.stdout}\n{done.stderr}")
        try:
            return json.loads(done.stdout)
        except json.JSONDecodeError:
            return done.stdout

    def submit(self, tag: str, session: str, prompt: str) -> str:
        limits = []
        if HARNESS == "codex":
            limits = ["--max-reported-tokens", "400000"]
        elif HARNESS == "claude-code":
            limits = ["--max-reported-cost-minor", "100", "--reported-cost-currency", "USD"]
        return self.cli("task", "submit", "--tag", tag, "--session", session, *limits, prompt)["task_id"]

    def until(self, what: str, read, ready):
        deadline = time.monotonic() + self.timeout
        while True:
            value = read()
            if ready(value):
                return value
            if time.monotonic() > deadline:
                landings = self.cli("get", "landings")
                self.fail(f"timed out waiting for {what}: {value}\nlandings: {json.dumps(landings)}")
            time.sleep(1)

    def finished(self, task: str) -> dict:
        value = self.until(f"Task {task}", lambda: self.cli("get", "task", task),
                           lambda value: value["state"] in TERMINAL)
        self.assertEqual(value["state"], "TASK_STATE_SUCCEEDED", value)
        return value

    def landing(self, session: str, mode: str) -> dict:
        def read():
            for landing in self.cli("get", "landings", "--session-id", session)["landings"]:
                if landing["mode"] == mode:
                    return landing
            return None
        return self.until(f"a {mode} landing of {session}", read,
                          lambda value: value is not None and value["state"] not in ("queued", "claimed"))

    def work_session(self, tag: str, parent: str) -> dict:
        listed = self.until(f"the Work Session of {parent}",
                            lambda: self.cli("get", "sessions", "--parent-tag", tag, "--parent-session", parent),
                            lambda value: value["work_sessions"])
        work = listed["work_sessions"][0]
        self.finished(work["latest_task_id"])
        reported = self.until(f"the report of {work['work_session_id']}",
                              lambda: self.cli("get", "session", work["work_session_id"]),
                              lambda value: value.get("report_task_state") in TERMINAL)
        return reported

    @staticmethod
    def read(repository: Path, ref: str) -> str:
        return git(repository, "show", f"{ref}:workspace.txt")

    def session_branches(self, repository: Path) -> set[str]:
        return set(git(repository, "for-each-ref", "--format=%(refname:short)", "refs/heads/supertag/session").split())

    def test_1_local_land_writes_the_session_branch_and_continuation_builds_on_it(self):
        task = self.finished(self.submit("local", "journey-local", edit("alpha")))
        branches = self.until("the local Session branch", lambda: self.session_branches(self.repository), bool)
        self.assertEqual(len(branches), 1, branches)
        branch = branches.pop()
        first = git(self.repository, "rev-parse", branch).strip()
        self.assertEqual(first, task["workspace_delivery"]["head_commit"])
        self.assertIn("alpha", self.read(self.repository, branch))
        # The operator's checkout stays on its branch, untouched.
        self.assertEqual(git(self.repository, "branch", "--show-current").strip(), "main")
        self.assertEqual(git(self.repository, "status", "--porcelain"), "")
        self.assertEqual((self.repository / "workspace.txt").read_text(), BASE)
        author = git(self.repository, "log", "-1", "--format=%ae", branch).strip()
        self.assertEqual(author, "local@noreply.supertag.invalid")

        # Continuation: the Session's second turn starts from its first commit.
        second = self.finished(self.submit("local", "journey-local", edit("beta")))
        self.assertEqual(second["workspace_delivery"]["start_commit"], first)
        self.until("the continued Session branch",
                   lambda: git(self.repository, "rev-parse", branch).strip(),
                   lambda head: head == second["workspace_delivery"]["head_commit"])
        text = self.read(self.repository, branch)
        self.assertLess(text.index("alpha"), text.index("beta"), text)
        self.assertEqual(git(self.repository, "rev-parse", f"{branch}^").strip(), first)

    def test_2_remote_workspace_pushes_the_session_branch(self):
        task = self.finished(self.submit("remote", "journey-remote", edit("gamma")))
        landing = self.landing("journey-remote", "branch")
        self.assertEqual(landing["state"], "landed", landing)
        head = task["workspace_delivery"]["head_commit"]
        self.assertEqual(landing["landed_commit"], head)
        self.assertEqual(git(self.server, "rev-parse", landing["branch"]).strip(), head)
        self.assertIn("gamma", self.read(self.server, landing["branch"]))
        self.assertEqual(self.read(self.server, "main"), BASE)

    def test_3_merge_lands_a_work_session_only_once_it_is_closed(self):
        self.finished(self.submit("merge", "journey-merge", start("Glossary", "delta")))
        work = self.work_session("merge", "journey-merge")
        session = work["work_session_id"]
        self.assertEqual(self.read(self.server, "drafts"), BASE)
        self.cli("session", "close", session)
        landing = self.landing(session, "merge")
        self.assertEqual(landing["state"], "landed", landing)
        self.assertEqual(git(self.server, "rev-parse", "drafts").strip(), landing["landed_commit"])
        self.assertIn("delta", self.read(self.server, "drafts"))
        message = git(self.server, "log", "-1", "--format=%B", "drafts")
        self.assertIn(f"SuperTag-Session: {session}", message)
        self.assertIn("Co-authored-by: local <local@noreply.supertag.invalid>", message)
        self.assertEqual(self.read(self.server, "main"), BASE)

    def test_4_a_conflicting_merge_gives_the_session_a_follow_up_task(self):
        self.finished(self.submit("conflict", "journey-conflict-one", start("One", "epsilon")))
        self.finished(self.submit("conflict", "journey-conflict-two", start("Two", "zeta")))
        one = self.work_session("conflict", "journey-conflict-one")["work_session_id"]
        two = self.work_session("conflict", "journey-conflict-two")["work_session_id"]
        self.cli("session", "close", one)
        landed = self.landing(one, "merge")
        self.assertEqual(landed["state"], "landed", landed)
        self.cli("session", "close", two)
        conflict = self.landing(two, "merge")
        self.assertEqual(conflict["state"], "conflict", conflict)
        self.assertIn("workspace.txt", conflict["conflicts"])
        follow_up = self.cli("get", "task", conflict["follow_up_task_id"])
        self.assertEqual(follow_up["session_id"], two)
        self.assertEqual(follow_up["workspace"]["merge_commit"], landed["landed_commit"])
        # The target keeps the first Session's change until the second resolves its conflict.
        self.assertIn("epsilon", self.read(self.server, "conflicts"))
        self.assertNotIn("zeta", self.read(self.server, "conflicts"))


if __name__ == "__main__":
    if "--harness" in sys.argv:
        index = sys.argv.index("--harness")
        os.environ["SUPERTAG_E2E_HARNESS"] = sys.argv[index + 1]
        del sys.argv[index:index + 2]
        HARNESS = os.environ["SUPERTAG_E2E_HARNESS"]
        Journeys.timeout = 600
    unittest.main()
