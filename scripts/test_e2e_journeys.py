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
- conflict: two Work Sessions change the same line; closing the second gives it a follow-up Task,
  which resolves the conflict, and the Session merges again with both changes;
- HTTPS token: a remote behind `git http-backend` that requires basic auth, with a Workspace
  Credential the Control Plane grants for each read and push;
- SSH key: a remote served by sshd in a disposable Docker container (skipped without Docker).
- local-vm: a remote Workspace whose Task runs commands in a local-vm container, on a Worker Host
  enrolled with a host Auth Key, and whose Session branch lands (`LocalVmJourney`; skipped without
  Docker or the built Claude Code adapter and local-vm provider).

The credentialed journeys also check that the secret never reaches the harness's environment or
the host's disk (its state directory, which holds every checkout).

`land: review` is not covered: it opens pull requests through the GitHub API only. A live run
needs a GitHub repository, a GitHub App installed on it with Contents and Pull requests read and
write (or an HTTPS token), `supertag workspace credential add --github-app`, and
`supertag workspace put --land review --base main`; no fake forge stands in for it here.

By default the host runs the fixture adapter, so no model is called. It needs a CLI built with
the fixture adapter beside it:

    cargo build -p supertag-cli --features test-fixtures --bin supertag --bin supertag-fixture-adapter
    SUPERTAG_E2E_BINARY=core/target/debug/supertag python3 -m unittest scripts/test_e2e_journeys.py

With `--harness codex`, `claude-code`, `cursor`, or `opencode` (or SUPERTAG_E2E_HARNESS), the host
runs that harness instead, which spends about a dozen small turns. Codex and Claude Code use this
machine's own CLI sign-in; Cursor needs CURSOR_API_KEY; OpenCode runs SUPERTAG_E2E_OPENCODE_MODEL
(default openai/gpt-5.5: smaller models announce a Work Session's edit and end the turn without
making it) with its provider's API-key variable, such as OPENAI_API_KEY. A harness without its
credential skips. Claude Code, Cursor, and OpenCode need their bridges staged beside the CLI
(scripts/node_bridges.py). Without SUPERTAG_E2E_BINARY every journey is skipped, as in CI.

`--provider modal` runs only ModalJourney instead: one Claude Code turn in a Modal sandbox on the
signed-in Modal CLI's profile (see its docstring for what it needs). `--provider codex-local-vm`
runs only CodexLocalVmJourney: one Codex turn whose commands and edits run in a local-vm
container through Codex's exec-server.
"""
from __future__ import annotations

import base64
import http.server
import json
import os
import shutil
import socket
import threading
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

BINARY = os.environ.get("SUPERTAG_E2E_BINARY", "")
HARNESS = os.environ.get("SUPERTAG_E2E_HARNESS", "")
PROVIDER = os.environ.get("SUPERTAG_E2E_PROVIDER", "")
REPOSITORY = Path(__file__).resolve().parents[1]
TERMINAL = {"TASK_STATE_SUCCEEDED", "TASK_STATE_FAILED", "TASK_STATE_CANCELLED", "TASK_STATE_UNCERTAIN"}
BASE = "base\n"


def git(directory: Path, *args: str) -> str:
    environment = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    return subprocess.run(
        ["git", "-C", str(directory), "-c", "user.name=Operator", "-c", "user.email=operator@example.com", *args],
        check=True, capture_output=True, text=True, env=environment,
    ).stdout


TOKEN = "e2e-" + os.urandom(16).hex()


class GitHttp(http.server.BaseHTTPRequestHandler):
    """`git http-backend` over HTTP that requires basic auth with the user `supertag` and TOKEN.
    `Stack.serve_git_http` makes a subclass with its own `root`."""

    root = ""
    expected = "Basic " + base64.b64encode(f"supertag:{TOKEN}".encode()).decode()

    def log_message(self, *args):
        pass

    def serve(self):
        if self.headers.get("Authorization") != self.expected:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="e2e"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        path, _, query = self.path.partition("?")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        environment = {
            "PATH": os.environ["PATH"], "GIT_PROJECT_ROOT": self.root, "GIT_HTTP_EXPORT_ALL": "1",
            "REQUEST_METHOD": self.command, "PATH_INFO": path, "QUERY_STRING": query,
            "CONTENT_TYPE": self.headers.get("Content-Type", ""), "CONTENT_LENGTH": str(len(body)),
            "REMOTE_USER": "supertag", "REMOTE_ADDR": "127.0.0.1",
            "HTTP_CONTENT_ENCODING": self.headers.get("Content-Encoding", ""),
            "GIT_PROTOCOL": self.headers.get("Git-Protocol", ""),
        }
        done = subprocess.run(["git", "http-backend"], input=body, env=environment, capture_output=True)
        head, _, payload = done.stdout.partition(b"\r\n\r\n")
        status = 200
        headers = []
        for line in head.decode().split("\r\n"):
            name, _, value = line.partition(": ")
            if name.lower() == "status":
                status = int(value.split()[0])
            elif name:
                headers.append((name, value))
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = serve
    do_POST = serve


OPENCODE_MODEL = os.environ.get("SUPERTAG_E2E_OPENCODE_MODEL", "openai/gpt-5.5")
# The provider API-key variable OpenCode reads for each provider a model may name.
OPENCODE_KEYS = {"openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY"}


def harness_credentials_missing(harness: str) -> str:
    """Why `harness` can't run here, or "" when its credential is present. Codex and Claude Code
    use this machine's own CLI sign-in; Cursor's SDK needs CURSOR_API_KEY (a Cursor app or
    cursor-agent sign-in isn't enough), and OpenCode the API-key variable of its model's provider."""
    if harness == "cursor" and not os.environ.get("CURSOR_API_KEY"):
        return "the Cursor journeys need CURSOR_API_KEY"
    if harness == "opencode":
        provider = OPENCODE_MODEL.split("/", 1)[0]
        variable = OPENCODE_KEYS.get(provider)
        if variable is None:
            return f"set SUPERTAG_E2E_OPENCODE_MODEL to an openai/ or anthropic/ model, not {OPENCODE_MODEL}"
        if not os.environ.get(variable):
            return f"the OpenCode journeys with {OPENCODE_MODEL} need {variable}"
    return ""


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def edit_text(line: str) -> str:
    """A model's turn that appends `line` to workspace.txt."""
    return f"Append the line '{line}' at the end of workspace.txt, creating the file if it is missing. Change nothing else."


def edit(line: str) -> str:
    """A turn that appends `line` to workspace.txt."""
    return edit_text(line) if HARNESS else f"edit: {line}"


def start(title: str, line: str) -> str:
    """A turn that starts one Work Session whose turn appends `line` to workspace.txt."""
    if HARNESS:
        return (f"Start one work Session with start_session, titled '{title}', whose instruction is: "
                f"{edit(line)} Don't edit files yourself in this turn; just start it and reply briefly.")
    return f"start: {title} | {edit(line)}"


class Stack(unittest.TestCase):
    """A disposable `supertag up` in a temporary directory, and helpers to drive it. A subclass's
    setUpClass sets `binary`, `temporary`, `root`, and `state`, then writes supertag.yaml and
    runs `up`."""

    timeout = 120

    @classmethod
    def serve_git_http(cls, root: Path) -> str:
        """Serves the bare repositories under `root` over HTTP with basic auth; returns the URL."""
        handler = type("Handler", (GitHttp,), {"root": str(root)})
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        cls.addClassCleanup(server.server_close)
        cls.addClassCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}"

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
    def cli(cls, *args: str, extra: dict[str, str] | None = None):
        done = subprocess.run([str(cls.binary), *args], env={**cls.environment(), **(extra or {})},
                              capture_output=True, text=True, timeout=300)
        if done.returncode != 0:
            raise AssertionError(f"supertag {' '.join(args)} failed:\n{done.stdout}\n{done.stderr}")
        try:
            return json.loads(done.stdout)
        except json.JSONDecodeError:
            return done.stdout

    def submit(self, tag: str, session: str, prompt: str, harness: str | None = None) -> str:
        harness = HARNESS if harness is None else harness
        limits = []
        if harness == "codex":
            limits = ["--max-reported-tokens", "400000"]
        elif harness == "claude-code":
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

    def landing(self, session: str, mode: str, after: str | None = None) -> dict:
        """The Session's first `mode` landing, or the first one after the landing `after`, once
        it has finished."""
        def read():
            landings = sorted(self.cli("get", "landings", "--session-id", session)["landings"],
                              key=lambda landing: landing["created_order"])
            if after is not None:
                ids = [landing["landing_id"] for landing in landings]
                landings = landings[ids.index(after) + 1:] if after in ids else []
            for landing in landings:
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

    def assert_no_secret_on_disk(self, directory: Path, secrets: list[str]):
        """No regular file under `directory` holds any of `secrets`."""
        self.assertTrue(directory.is_dir(), directory)
        for path in directory.rglob("*"):
            if path.is_file() and not path.is_symlink():
                data = path.read_bytes()
                for secret in secrets:
                    self.assertNotIn(secret.encode(), data, f"{secret[:12]}... found in {path}")


@unittest.skipUnless(BINARY, "set SUPERTAG_E2E_BINARY to a supertag built with --features test-fixtures")
class Journeys(Stack):
    """One stack for every journey, in order: later journeys reuse the earlier Sessions' state."""

    timeout = 600 if HARNESS else 120

    @classmethod
    def setUpClass(cls):
        missing = harness_credentials_missing(HARNESS)
        if missing:
            raise unittest.SkipTest(missing)
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

        # HTTPS token: the same repository behind basic auth on a loopback HTTP server.
        cls.http_root = cls.root / "http"
        cls.http_root.mkdir()
        git(cls.root, "clone", "-q", "--bare", str(cls.server), str(cls.http_root / "handbook.git"))
        cls.http_remote = cls.serve_git_http(cls.http_root) + "/handbook.git"

        # SSH key: sshd in a disposable container, when Docker runs here.
        cls.ssh_remote = cls.start_sshd()

        cls.environment_dumps = cls.root / "environment"
        cls.environment_dumps.mkdir()

        if HARNESS:
            runner = f"    harnesses: [{HARNESS}]\n"
            if HARNESS in ("claude-code", "cursor", "opencode"):
                runner += f"    allow-unsandboxed-commands: [{HARNESS}]\n"
            if HARNESS == "opencode":
                runner += f"    models: {{ opencode: {OPENCODE_MODEL} }}\n"
        else:
            adapter = cls.binary.with_name("supertag-fixture-adapter")
            if not adapter.exists():
                raise unittest.SkipTest(f"{adapter} is missing: build it with --features test-fixtures")
            runner = (f"    adapter: {adapter}\n"
                      f"    adapter-args: [--journey, --journey-environment={cls.environment_dumps}]\n")
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
      handbook-https: {{ remote: true }}
      handbook-ssh: {{ remote: true }}
""")
        cls.cli("up")
        cls.addClassCleanup(cls.down)
        remote = f"file://{cls.server}"
        cls.cli("workspace", "put", "handbook", "--remote", remote, "--ref", "main")
        cls.cli("workspace", "put", "handbook-m", "--remote", remote, "--ref", "main",
                "--land", "merge", "--target", "drafts")
        cls.cli("workspace", "put", "handbook-c", "--remote", remote, "--ref", "main",
                "--land", "merge", "--target", "conflicts")
        cls.cli("workspace", "credential", "add", "https-token", "--https-token", "--username", "supertag",
                extra={"SUPERTAG_WORKSPACE_TOKEN": TOKEN})
        cls.cli("workspace", "put", "handbook-https", "--remote", cls.http_remote, "--ref", "main",
                "--credential", "https-token")
        bound = [("local", "{ id: app, ref: main }"), ("remote", "{ id: handbook }"),
                 ("merge", "{ id: handbook-m }"), ("conflict", "{ id: handbook-c }"),
                 ("https", "{ id: handbook-https }")]
        if cls.ssh_remote:
            cls.cli("workspace", "credential", "add", "ssh-key", "--ssh-key", str(cls.ssh_key),
                    "--known-hosts", str(cls.known_hosts))
            cls.cli("workspace", "put", "handbook-ssh", "--remote", cls.ssh_remote, "--ref", "main",
                    "--credential", "ssh-key")
            bound.append(("ssh", "{ id: handbook-ssh }"))
        execution = f"  execution: {{ harness: {HARNESS} }}\n" if HARNESS else ""
        tags = []
        for name, workspace in bound:
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
    def start_sshd(cls) -> str | None:
        """A bare repository served over SSH by a disposable container, or None without Docker."""
        if shutil.which("docker") is None or subprocess.run(["docker", "info"], capture_output=True).returncode:
            return None
        ssh = cls.root / "ssh"
        ssh.mkdir(mode=0o700)
        cls.ssh_key = ssh / "id_ed25519"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(cls.ssh_key)], check=True)
        public = (ssh / "id_ed25519.pub").read_text().strip()
        script = (
            "set -e; apk add --no-cache openssh-server git >/dev/null; ssh-keygen -A >/dev/null; "
            "adduser -D -s /usr/bin/git-shell git; sed -i 's/^git:!/git:*/' /etc/shadow; "
            "mkdir -p /home/git/.ssh; echo \"$KEY\" > /home/git/.ssh/authorized_keys; "
            "git init -q --bare -b main /srv/handbook.git; chown -R git:git /home/git /srv/handbook.git; "
            "chmod 700 /home/git/.ssh; chmod 600 /home/git/.ssh/authorized_keys; touch /ready; "
            "exec /usr/sbin/sshd -D -e")
        container = subprocess.run(
            ["docker", "run", "-d", "--rm", "-e", f"KEY={public}", "-p", "127.0.0.1::22", "alpine:3.20",
             "sh", "-c", script], check=True, capture_output=True, text=True).stdout.strip()
        cls.addClassCleanup(subprocess.run, ["docker", "rm", "-f", container], capture_output=True)
        port = subprocess.run(["docker", "port", container, "22/tcp"], check=True, capture_output=True,
                              text=True).stdout.split(":")[-1].strip()
        deadline = time.monotonic() + 120
        while subprocess.run(["docker", "exec", container, "test", "-f", "/ready"]).returncode:
            if time.monotonic() > deadline:
                raise AssertionError("sshd did not start")
            time.sleep(1)
        cls.known_hosts = ssh / "known_hosts"
        while True:
            scanned = subprocess.run(["ssh-keyscan", "-p", port, "-t", "ed25519", "127.0.0.1"],
                                     capture_output=True, text=True).stdout
            if scanned.strip():
                cls.known_hosts.write_text(scanned)
                break
            if time.monotonic() > deadline:
                raise AssertionError("sshd does not answer")
            time.sleep(1)
        remote = f"ssh://git@127.0.0.1:{port}/srv/handbook.git"
        ssh_command = (f"ssh -i {cls.ssh_key} -o IdentitiesOnly=yes -o UserKnownHostsFile={cls.known_hosts} "
                       "-o StrictHostKeyChecking=yes")
        subprocess.run(["git", "-C", str(cls.repository), "push", "-q", remote, "main"], check=True,
                       env={**os.environ, "GIT_SSH_COMMAND": ssh_command}, capture_output=True)
        cls.ssh_command = ssh_command
        return remote

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

    def test_4_a_conflicting_merge_is_resolved_by_a_follow_up_and_lands_again(self):
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
        self.assertEqual(conflict["target_commit"], landed["landed_commit"])
        follow_up = self.cli("get", "task", conflict["follow_up_task_id"])
        self.assertEqual(follow_up["session_id"], two)
        self.assertEqual(follow_up["workspace"]["merge_commit"], landed["landed_commit"])

        # The follow-up resolves the conflict, keeping both sides, and the Session merges again.
        self.finished(follow_up["task_id"])
        relanded = self.landing(two, "merge", after=conflict["landing_id"])
        self.assertEqual(relanded["state"], "landed", relanded)
        head = git(self.server, "rev-parse", "conflicts").strip()
        self.assertEqual(head, relanded["landed_commit"])
        git(self.server, "merge-base", "--is-ancestor", landed["landed_commit"], head)
        text = self.read(self.server, "conflicts")
        self.assertIn("epsilon", text)
        self.assertIn("zeta", text)
        for marker in ("<<<<<<<", "=======", ">>>>>>>"):
            self.assertNotIn(marker, text)
        self.assertEqual(self.read(self.server, "main"), BASE)

    def credentialed_journey(self, tag: str, session: str, line: str, secrets: list[str]) -> dict:
        """A turn on a credentialed remote: the Session's branch lands, and no secret reaches the
        harness's environment or the host's disk."""
        task = self.finished(self.submit(tag, session, edit(line)))
        landing = self.landing(session, "branch")
        self.assertEqual(landing["state"], "landed", landing)
        self.assertEqual(landing["landed_commit"], task["workspace_delivery"]["head_commit"])
        if not HARNESS:
            received = (self.environment_dumps / f"{task['task_id']}.env").read_text()
            for secret in secrets:
                self.assertNotIn(secret, received)
        self.assert_no_secret_on_disk(self.state / "hosts", secrets)
        return landing

    def test_5_https_token_remote_lands_without_the_token_reaching_the_host(self):
        # The server refuses anyone without the token.
        anonymous = subprocess.run(["git", "ls-remote", self.http_remote], capture_output=True, text=True,
                                   env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "true"})
        self.assertNotEqual(anonymous.returncode, 0, anonymous.stdout)
        steps = {step["step"]: step["status"] for step in self.cli("workspace", "check", "handbook-https")["steps"]}
        self.assertEqual((steps["read"], steps["push"]), ("ok", "ok"), steps)
        landing = self.credentialed_journey("https", "journey-https", "eta", [TOKEN])
        self.assertIn("eta", self.read(self.http_root / "handbook.git", landing["branch"]))

    def test_6_ssh_key_remote_lands_without_the_key_reaching_the_host(self):
        if not self.ssh_remote:
            self.skipTest("Docker is not running")
        steps = {step["step"]: step["status"] for step in self.cli("workspace", "check", "handbook-ssh")["steps"]}
        self.assertEqual((steps["read"], steps["push"]), ("ok", "ok"), steps)
        key = self.ssh_key.read_text().splitlines()
        body = [line for line in key if line and not line.startswith("-----")]
        landing = self.credentialed_journey("ssh", "journey-ssh", "theta", body)
        shown = subprocess.run(["git", "ls-remote", self.ssh_remote, landing["branch"]], check=True,
                               capture_output=True, text=True,
                               env={**os.environ, "GIT_SSH_COMMAND": self.ssh_command}).stdout
        self.assertTrue(shown.startswith(landing["landed_commit"]), shown)


LOCAL_VM_ADAPTER = REPOSITORY / "harnesses/claude-code/dist/rust-adapter/entry.js"
LOCAL_VM_PROVIDER = REPOSITORY / "harnesses/environments/local-vm/dist/rust-provider/main.js"
LOCAL_VM_CLAUDE = REPOSITORY / "harnesses/claude-code/fixtures/rust-native-claude.mjs"


def docker_runs() -> bool:
    return shutil.which("docker") is not None and subprocess.run(
        ["docker", "info"], capture_output=True).returncode == 0


@unittest.skipUnless(BINARY, "set SUPERTAG_E2E_BINARY to a supertag built with --features test-fixtures")
@unittest.skipUnless(docker_runs(), "the local-vm journey needs Docker")
@unittest.skipUnless(shutil.which("node") and LOCAL_VM_ADAPTER.exists() and LOCAL_VM_PROVIDER.exists(),
                     "build the Claude Code adapter and the local-vm provider: pnpm -r build")
class LocalVmJourney(Stack):
    """A remote Workspace whose Task runs commands in a local-vm container, on a Worker Host
    enrolled with a host Auth Key, and whose Session branch lands on the git server. The host runs
    the fixture Claude Code, so no model is called; the first run builds the container image."""

    timeout = 1_200

    @classmethod
    def setUpClass(cls):
        cls.binary = Path(BINARY).resolve()
        cls.temporary = tempfile.TemporaryDirectory(prefix="st-e2e-vm-")
        cls.root = Path(cls.temporary.name)
        cls.state = cls.root / "state"
        cls.state.mkdir(mode=0o700)
        repository = cls.root / "app"
        cls.server = cls.root / "server.git"
        repository.mkdir()
        git(repository, "init", "-q", "-b", "main")
        (repository / "workspace.txt").write_text(BASE)
        git(repository, "add", "-A")
        git(repository, "commit", "-qm", "Initial")
        git(cls.root, "init", "-q", "--bare", "-b", "main", str(cls.server))
        git(repository, "push", "-q", str(cls.server), "main")
        cls.port = free_port()
        (cls.state / "supertag.yaml").write_text(f"""version: 1
name: st-e2e-vm
services:
  control-plane:
    type: control-plane
    ports: ["127.0.0.1:{cls.port}"]
    provision:
      - apiVersion: supertag/v1
        kind: PermissionSet
        metadata: {{ name: run }}
        spec:
          permissions:
            - {{ target: runtime, action: files:write }}
            - {{ target: runtime, action: commands:execute }}
      - apiVersion: supertag/v1
        kind: Role
        metadata: {{ name: Builder }}
        spec:
          purpose: "Run the requested command in the Workspace."
          permissionSets: [run]
""")
        cls.cli("up")
        cls.addClassCleanup(cls.down)
        cls.cli("workspace", "put", "handbook-vm", "--remote", f"file://{cls.server}", "--ref", "main")
        manifest = cls.root / "tag.yaml"
        manifest.write_text("""apiVersion: supertag/v1
kind: Tag
metadata: { name: vm }
spec:
  instructions: "Run the requested command."
  roles: [Builder]
  execution: { harness: claude-code }
  workspace: { id: handbook-vm }
""")
        cls.cli("apply", "-f", str(manifest))
        # A Worker Host of its own: the Claude Code adapter with the fixture CLI, its remote
        # Workspace in a local-vm container on this machine's Docker.
        key = cls.cli("auth-key", "create", "vm-host", "--role", "host", "--tag", "vm")
        key = key["auth_key"] if isinstance(key, dict) else key.strip().split()[-1]
        host_state = cls.root / "host"
        control_plane = f"http://127.0.0.1:{cls.port}"
        cls.cli("host", "enroll", "vm-host", "--control-plane", control_plane,
                "--state-directory", str(host_state), "--auth-key", key)
        claude = cls.root / "claude-fixture.mjs"
        shutil.copy(LOCAL_VM_CLAUDE, claude)
        claude.chmod(0o700)
        node = shutil.which("node")
        docker = Path(shutil.which("docker")).parent
        environment = {**cls.environment(), "ANTHROPIC_API_KEY": "fixture-provider-key",
                       "PATH": f"{Path(node).parent}:{docker}:/usr/bin:/bin"}
        cls.host_log = open(cls.root / "host.log", "w")
        cls.host = subprocess.Popen(
            [str(cls.binary), "worker-host", "--control-plane", control_plane,
             "--state-directory", str(host_state), "--harness", "claude-code",
             "--harness-model", "fixture-model", "--harness-entrypoint", str(LOCAL_VM_ADAPTER),
             "--harness-runtime", node, "--claude-path", str(claude),
             "--remote-workspace", "handbook-vm",
             "--local-vm-workspace-provider", node,
             "--local-vm-workspace-provider-arg", str(LOCAL_VM_PROVIDER)],
            env=environment, stdout=cls.host_log, stderr=subprocess.STDOUT)
        cls.addClassCleanup(cls.stop_host)

    @classmethod
    def stop_host(cls):
        cls.host.terminate()
        try:
            cls.host.wait(30)
        except subprocess.TimeoutExpired:
            cls.host.kill()
        cls.host_log.close()

    def test_a_local_vm_task_runs_commands_in_its_container_and_lands_its_session_branch(self):
        task_id = self.cli("task", "submit", "--tag", "vm", "--session", "journey-vm",
                           "local-vm-command")["task_id"]
        try:
            task = self.finished(task_id)
        except AssertionError:
            raise AssertionError((self.root / "host.log").read_text()[-4000:])
        # The command ran in the container: as its unprivileged user, on Linux, with no network.
        output = json.loads(task["result"])
        self.assertFalse(output["isError"], output)
        self.assertEqual(output["text"].splitlines()[:3], ["1000", "Linux", "lo"], output)
        # Its file returns with the Workspace, and the Session branch lands on the server.
        landing = self.landing("journey-vm", "branch")
        self.assertEqual(landing["state"], "landed", landing)
        self.assertEqual(git(self.server, "rev-parse", landing["branch"]).strip(),
                         task["workspace_delivery"]["head_commit"])
        landed = git(self.server, "show", f"{landing['branch']}:command-output.txt")
        self.assertEqual(landed.splitlines()[:3], ["1000", "Linux", "lo"])
        self.assertEqual(git(self.server, "show", "main:workspace.txt"), BASE)
        # The Task's container is gone.
        left = subprocess.run(["docker", "ps", "-aq", "--filter", f"label=supertag.taskId={task_id}"],
                              capture_output=True, text=True).stdout
        self.assertEqual(left.strip(), "")


class CodexLocalVmJourney(Stack):
    """One live Codex turn on a remote Workspace whose sandbox is a local-vm container: Codex stays
    on the Worker Host with this machine's Codex sign-in, and its commands and file edits run in
    the container through Codex's exec-server. The delivery holds an apply_patch change and a
    command's output that only the container could produce (Linux, uid 1000), and the Session
    branch lands on the git server.

    Run with `--provider codex-local-vm`; it spends one small Codex turn. It needs Docker, the
    local-vm provider built, Codex signed in with a file-backed login, and
    SUPERTAG_E2E_CODEX_LINUX naming a Linux `codex` binary of exactly this machine's Codex
    version for the container's architecture (from npm's `@openai/codex@VERSION-linux-ARCH`).
    """

    timeout = 900

    @classmethod
    def setUpClass(cls):
        if not (BINARY and PROVIDER == "codex-local-vm"):
            raise unittest.SkipTest("run with --provider codex-local-vm; it spends a Codex turn")
        linux_codex = Path(os.environ.get("SUPERTAG_E2E_CODEX_LINUX", ""))
        node = shutil.which("node")
        if not (docker_runs() and LOCAL_VM_PROVIDER.exists() and node and linux_codex.is_file()):
            raise unittest.SkipTest("needs Docker, the local-vm provider, Node, and SUPERTAG_E2E_CODEX_LINUX")
        cls.binary = Path(BINARY).resolve()
        cls.temporary = tempfile.TemporaryDirectory(prefix="st-e2e-codex-")
        cls.root = Path(cls.temporary.name)
        # The sandbox image: the local-vm base's essentials, plus this host's Codex version.
        version = subprocess.run(["codex", "--version"], capture_output=True, text=True,
                                 check=True).stdout.strip().removeprefix("codex-cli ")
        context = cls.root / "image"
        context.mkdir()
        shutil.copy(linux_codex, context / "codex")
        (context / "Dockerfile").write_text("""FROM debian:bookworm-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends ca-certificates git procps python3 \\
 && rm -rf /var/lib/apt/lists/* \\
 && useradd --create-home --shell /bin/bash --uid 1000 user \\
 && find / -xdev -type f -perm /6000 -exec chmod u-s,g-s {} +
COPY --chmod=755 codex /usr/local/bin/codex
USER user
WORKDIR /home/user
""")
        cls.image = f"supertag-e2e-codex:{version}"
        # The machine's own platform, as the local-vm provider runs its containers.
        native = "linux/arm64" if os.uname().machine in ("arm64", "aarch64") else "linux/amd64"
        subprocess.run(["docker", "build", "-q", "--platform", native, "-t", cls.image, str(context)],
                       check=True, capture_output=True)
        found = subprocess.run(["docker", "run", "--rm", "--platform", native, cls.image, "codex", "--version"],
                               capture_output=True, text=True).stdout.strip()
        if found != f"codex-cli {version}":
            raise unittest.SkipTest(f"SUPERTAG_E2E_CODEX_LINUX is {found or 'not runnable'}, not codex-cli {version}")
        cls.state = cls.root / "state"
        cls.state.mkdir(mode=0o700)
        repository = cls.root / "app"
        cls.server = cls.root / "server.git"
        repository.mkdir()
        git(repository, "init", "-q", "-b", "main")
        (repository / "workspace.txt").write_text(BASE)
        git(repository, "add", "-A")
        git(repository, "commit", "-qm", "Initial")
        git(cls.root, "init", "-q", "--bare", "-b", "main", str(cls.server))
        git(repository, "push", "-q", str(cls.server), "main")
        cls.port = free_port()
        (cls.state / "supertag.yaml").write_text(f"""version: 1
name: st-e2e-codex
services:
  control-plane:
    type: control-plane
    ports: ["127.0.0.1:{cls.port}"]
    provision:
      - apiVersion: supertag/v1
        kind: PermissionSet
        metadata: {{ name: run }}
        spec:
          permissions:
            - {{ target: runtime, action: files:write }}
            - {{ target: runtime, action: commands:execute }}
      - apiVersion: supertag/v1
        kind: Role
        metadata: {{ name: Builder }}
        spec:
          purpose: "Edit and run commands in the Workspace."
          permissionSets: [run]
""")
        cls.cli("up")
        cls.addClassCleanup(cls.down)
        cls.cli("workspace", "put", "handbook-codex", "--remote", f"file://{cls.server}", "--ref", "main")
        manifest = cls.root / "tag.yaml"
        manifest.write_text("""apiVersion: supertag/v1
kind: Tag
metadata: { name: codex-vm }
spec:
  instructions: "Do exactly what the request asks, then reply DONE."
  roles: [Builder]
  execution: { harness: codex, models: [gpt-6-sol], efforts: [low] }
  workspace: { id: handbook-codex }
""")
        cls.cli("apply", "-f", str(manifest))
        key = cls.cli("auth-key", "create", "codex-vm-host", "--role", "host", "--tag", "codex-vm")
        key = key["auth_key"] if isinstance(key, dict) else key.strip().split()[-1]
        cls.host_state = cls.root / "host"
        control_plane = f"http://127.0.0.1:{cls.port}"
        cls.cli("host", "enroll", "codex-vm-host", "--control-plane", control_plane,
                "--state-directory", str(cls.host_state), "--auth-key", key)
        docker = Path(shutil.which("docker")).parent
        codex = Path(shutil.which("codex")).parent
        environment = {**cls.environment(), "SUPERTAG_LOCAL_VM_IMAGE": cls.image,
                       "PATH": f"{codex}:{Path(node).parent}:{docker}:/usr/bin:/bin"}
        cls.host_log = open(cls.root / "host.log", "w")
        cls.host = subprocess.Popen(
            [str(cls.binary), "worker-host", "--control-plane", control_plane,
             "--state-directory", str(cls.host_state), "--harness", "codex",
             "--harness-model", "gpt-6-sol",
             "--remote-workspace", "handbook-codex",
             "--local-vm-workspace-provider", node,
             "--local-vm-workspace-provider-arg", str(LOCAL_VM_PROVIDER)],
            env=environment, stdout=cls.host_log, stderr=subprocess.STDOUT)
        cls.addClassCleanup(cls.stop_host)
        cls.addClassCleanup(lambda: subprocess.run(["docker", "image", "rm", "-f", cls.image],
                                                   capture_output=True))

    @classmethod
    def stop_host(cls):
        cls.host.terminate()
        try:
            cls.host.wait(30)
        except subprocess.TimeoutExpired:
            cls.host.kill()
        cls.host_log.close()

    def test_a_codex_turn_edits_and_runs_commands_only_in_its_container(self):
        task_id = self.submit(
            "codex-vm", "journey-codex",
            "1. Use apply_patch to append the line `codex-remote` to workspace.txt. "
            "2. Run the shell command `uname -s > where.txt && id -u >> where.txt` in the "
            "working directory. Reply DONE.",
            harness="codex")
        def read():
            if self.host.poll() is not None:
                self.fail("the Worker Host exited:\n" + (self.root / "host.log").read_text()[-6000:])
            return self.cli("get", "task", task_id)
        task = self.until(f"Task {task_id}", read, lambda value: value["state"] in TERMINAL)
        self.assertEqual(task["state"], "TASK_STATE_SUCCEEDED",
                         (json.dumps(task), (self.root / "host.log").read_text()[-6000:]))
        landing = self.landing("journey-codex", "branch")
        self.assertEqual(landing["state"], "landed", landing)
        self.assertEqual(git(self.server, "rev-parse", landing["branch"]).strip(),
                         task["workspace_delivery"]["head_commit"])
        # The apply_patch change, made through the exec-server's file operations.
        self.assertEqual(git(self.server, "show", f"{landing['branch']}:workspace.txt"),
                         BASE + "codex-remote\n")
        # The command ran in the container: Linux, as its unprivileged user, never this host.
        self.assertEqual(git(self.server, "show", f"{landing['branch']}:where.txt").split(),
                         ["Linux", "1000"])
        self.assertNotEqual(os.uname().sysname, "Linux", "the proof needs a non-Linux host")
        self.assertEqual(git(self.server, "show", "main:workspace.txt"), BASE)
        left = subprocess.run(["docker", "ps", "-aq", "--filter", f"label=supertag.taskId={task_id}"],
                              capture_output=True, text=True).stdout
        self.assertEqual(left.strip(), "")


class ModalJourney(Stack):
    """A remote Workspace on a Worker Host whose Workspaces run in Modal sandboxes: one Claude Code
    turn (a Modal host takes Claude Code, Cursor, or OpenCode, not Codex or an adapter) whose
    Session branch lands on an HTTPS-token server.

    The git server stays on loopback: the Worker Host reads the source and pushes the Session's
    branch itself, and only the checkout's files travel to the sandbox, so Modal never reaches it.
    It needs the Modal CLI signed in (`~/.modal.toml`; MODAL_PROFILE picks a profile other than
    the active one), an existing Modal app (SUPERTAG_E2E_MODAL_APP, default supertag-conformance),
    the Modal provider built (`pnpm --filter @supertag/worker-environment-modal build`), Node on
    PATH, the Claude Code bridge staged beside the CLI, and a Claude Code sign-in. One sandbox,
    for one turn of a few seconds; the provider takes no filesystem snapshot without a setup.
    """

    timeout = 900

    @classmethod
    def setUpClass(cls):
        if not (BINARY and PROVIDER == "modal"):
            raise unittest.SkipTest("run with --provider modal; it spends Modal and Claude Code credit")
        provider = REPOSITORY / "harnesses/environments/modal/dist/rust-provider/main.js"
        node = shutil.which("node")
        if not provider.exists() or node is None:
            raise unittest.SkipTest(f"build {provider} and put node on PATH")
        token_id, token_secret = cls.modal_token()
        cls.binary = Path(BINARY).resolve()
        cls.temporary = tempfile.TemporaryDirectory(prefix="st-e2e-modal-")
        cls.root = Path(cls.temporary.name)
        cls.state = cls.root / "state"
        cls.state.mkdir(mode=0o700)
        seed = cls.root / "seed"
        seed.mkdir()
        git(seed, "init", "-q", "-b", "main")
        (seed / "workspace.txt").write_text(BASE)
        git(seed, "add", "-A")
        git(seed, "commit", "-qm", "Initial")
        cls.http_root = cls.root / "http"
        cls.http_root.mkdir()
        git(cls.root, "init", "-q", "--bare", "-b", "main", str(cls.http_root / "handbook.git"))
        git(seed, "push", "-q", str(cls.http_root / "handbook.git"), "main")
        cls.http_remote = cls.serve_git_http(cls.http_root) + "/handbook.git"

        port = free_port()
        (cls.state / "supertag.yaml").write_text(f"""version: 1
name: st-e2e-modal
services:
  control-plane:
    type: control-plane
    ports: ["127.0.0.1:{port}"]
    provision:
      - apiVersion: supertag/v1
        kind: PermissionSet
        metadata: {{ name: edit }}
        spec:
          permissions:
            - {{ target: runtime, action: files:read }}
            - {{ target: runtime, action: files:write }}
            - {{ target: runtime, action: commands:execute }}
      - apiVersion: supertag/v1
        kind: Role
        metadata: {{ name: Builder }}
        spec:
          purpose: "Make small, bounded repository changes and report what changed."
          permissionSets: [edit]
""")
        cls.cli("up")
        cls.addClassCleanup(cls.down)
        cls.cli("workspace", "credential", "add", "https-token", "--https-token", "--username", "supertag",
                extra={"SUPERTAG_WORKSPACE_TOKEN": TOKEN})
        cls.cli("workspace", "put", "handbook-modal", "--remote", cls.http_remote, "--ref", "main",
                "--credential", "https-token")
        manifest = cls.root / "tag.yaml"
        manifest.write_text("""apiVersion: supertag/v1
kind: Tag
metadata: { name: modal }
spec:
  instructions: "Make the smallest change that does what is asked. Commit nothing yourself. Be brief."
  roles: [Builder]
  execution: { harness: claude-code }
  workspace: { id: handbook-modal }
""")
        cls.cli("apply", "-f", str(manifest))

        key = cls.cli("auth-key", "create", "modal-host", "--role", "host", "--all-tags")["auth_key"]
        cls.host_state = cls.root / "modal-host"
        cls.host_state.mkdir(mode=0o700)
        control_plane = f"http://127.0.0.1:{port}"
        cls.cli("host", "enroll", "modal-host", "--control-plane", control_plane,
                "--state-directory", str(cls.host_state), extra={"SUPERTAG_AUTH_KEY": key})
        environment = {key: value for key, value in os.environ.items() if not key.startswith(("SUPERTAG_", "MODAL_"))}
        environment.update({
            "MODAL_TOKEN_ID": token_id, "MODAL_TOKEN_SECRET": token_secret,
            "SUPERTAG_MODAL_WORKSPACE_APP": os.environ.get("SUPERTAG_E2E_MODAL_APP", "supertag-conformance"),
        })
        cls.host_log = (cls.root / "modal-host.log").open("w")
        host = subprocess.Popen(
            [str(cls.binary), "worker-host", "--control-plane", control_plane,
             "--state-directory", str(cls.host_state), "--harness", "claude-code",
             "--remote-workspace", "handbook-modal",
             "--modal-workspace-provider", node, "--modal-workspace-provider-arg", str(provider)],
            env=environment, stdout=cls.host_log, stderr=subprocess.STDOUT)
        cls.addClassCleanup(cls.host_log.close)
        cls.addClassCleanup(host.wait, 60)
        cls.addClassCleanup(host.terminate)
        cls.modal_secrets = [token_secret]

    @staticmethod
    def modal_token() -> tuple[str, str]:
        """The Modal CLI's token for MODAL_PROFILE or its active profile, never printed."""
        import tomllib
        path = Path.home() / ".modal.toml"
        if not path.exists():
            raise unittest.SkipTest("sign in with the Modal CLI first (~/.modal.toml)")
        profiles = tomllib.loads(path.read_text())
        name = os.environ.get("MODAL_PROFILE") or next(
            (name for name, profile in profiles.items() if profile.get("active")), None)
        profile = profiles.get(name or "", {})
        if not profile.get("token_id") or not profile.get("token_secret"):
            raise unittest.SkipTest("no Modal token in the selected profile")
        return profile["token_id"], profile["token_secret"]

    def test_a_modal_sandbox_turn_lands_its_session_branch(self):
        task = self.finished(self.submit("modal", "journey-modal", edit_text("kappa"), harness="claude-code"))
        self.assertTrue(task["workspace_delivery"]["committed"], task["result"])
        landing = self.landing("journey-modal", "branch")
        self.assertEqual(landing["state"], "landed", landing)
        self.assertEqual(landing["landed_commit"], task["workspace_delivery"]["head_commit"])
        self.assertIn("kappa", self.read(self.http_root / "handbook.git", landing["branch"]))
        # Neither the git token nor the Modal token reaches the host's state (every checkout).
        self.assert_no_secret_on_disk(self.host_state, [TOKEN, *self.modal_secrets])


if __name__ == "__main__":
    if "--provider" in sys.argv:
        index = sys.argv.index("--provider")
        os.environ["SUPERTAG_E2E_PROVIDER"] = sys.argv[index + 1]
        del sys.argv[index:index + 2]
        PROVIDER = os.environ["SUPERTAG_E2E_PROVIDER"]
        if PROVIDER not in ("modal", "codex-local-vm"):
            sys.exit("--provider takes modal or codex-local-vm")
        # The provider journey runs alone; the other journeys keep their own flags.
        sys.argv.append("ModalJourney" if PROVIDER == "modal" else "CodexLocalVmJourney")
    if "--harness" in sys.argv:
        index = sys.argv.index("--harness")
        os.environ["SUPERTAG_E2E_HARNESS"] = sys.argv[index + 1]
        del sys.argv[index:index + 2]
        HARNESS = os.environ["SUPERTAG_E2E_HARNESS"]
        Journeys.timeout = 600
    unittest.main()
