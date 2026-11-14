"""Tests for the legacy TypeScript state archive (needs zstd; PostgreSQL only when configured)."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta

import legacy_archive
from legacy_archive import ArchiveError, create, translate_config, translate_manifests, verify

SECRET = "synthetic-provider-secret-value"
# A stand-in for age that runs everywhere: it records the recipients and XORs the plaintext, and
# decrypts only with an identity whose name matches a recipient. The real age is tested below.
FAKE_AGE = r"""#!/usr/bin/env python3
import json, sys
arguments = sys.argv[1:]
def xor(data):
    return bytes(byte ^ 0x5A for byte in data)
if arguments[0] in ("-e", "--encrypt"):
    recipients = [arguments[index + 1] for index, value in enumerate(arguments) if value == "-r"]
    if any(not recipient.startswith("fakeage1") for recipient in recipients):
        sys.stderr.write("age: error: unknown recipient type\n")
        sys.exit(1)
    sys.stdout.buffer.write(b"FAKEAGE\n" + json.dumps(recipients).encode() + b"\n" + xor(sys.stdin.buffer.read()))
elif arguments[0] in ("-d", "--decrypt"):
    identity = open(arguments[arguments.index("-i") + 1]).read().strip()
    with open(arguments[-1], "rb") as file:
        header, recipients, body = file.read().split(b"\n", 2)
    if header != b"FAKEAGE" or "fakeage1" + identity.removeprefix("FAKE-IDENTITY-") not in json.loads(recipients):
        sys.stderr.write("age: error: no identity matched any of the recipients\n")
        sys.exit(1)
    sys.stdout.buffer.write(xor(body))
else:
    sys.stderr.write("age: error: unsupported arguments\n")
    sys.exit(2)
"""


def legacy_schema(execute):
    for statement in (
        'CREATE TABLE "Tag" (id TEXT PRIMARY KEY, name TEXT, execution TEXT, "createdAt" TEXT)',
        'CREATE TABLE "Role" (id TEXT PRIMARY KEY, name TEXT, "createdAt" TEXT)',
        'CREATE TABLE "RoleAssignment" (id TEXT PRIMARY KEY, "tagId" TEXT, "roleId" TEXT, status TEXT, "createdAt" TEXT)',
        'CREATE TABLE "Objective" (id TEXT PRIMARY KEY, outcome TEXT, status TEXT, "teamId" TEXT, "createdAt" TEXT)',
        'CREATE TABLE "Team" (id TEXT PRIMARY KEY, name TEXT, "memberTagIds" TEXT, "createdAt" TEXT)',
        'CREATE TABLE "WorkstreamPost" (id TEXT PRIMARY KEY, "teamId" TEXT, "authorTagId" TEXT, body TEXT, '
        'sequence INTEGER, "createdAt" TEXT)',
        'CREATE TABLE "TagMessage" (id TEXT PRIMARY KEY, "senderTagId" TEXT, "recipientTagId" TEXT, '
        '"objectiveId" TEXT, text TEXT, "createdAt" TEXT)',
        'CREATE TABLE "Session" (id TEXT PRIMARY KEY, "tagId" TEXT, "createdAt" TEXT)',
        'CREATE TABLE "Task" (id TEXT PRIMARY KEY, "tagId" TEXT, "sessionId" TEXT, "objectiveId" TEXT, '
        '"inboundEventId" TEXT, actor TEXT, "requestText" TEXT, "responseText" TEXT, result TEXT, status TEXT, "createdAt" TEXT)',
        'CREATE TABLE "TaskAttempt" (id TEXT PRIMARY KEY, "taskId" TEXT, "attemptNumber" INTEGER, outcome TEXT, "createdAt" TEXT)',
        'CREATE TABLE "OutboundReply" (id TEXT PRIMARY KEY, "inboundEventId" TEXT, text TEXT, status TEXT, "createdAt" TEXT)',
        'CREATE TABLE "Empty" (id TEXT PRIMARY KEY)',
    ):
        execute(statement)
    rows = [
        ('INSERT INTO "Tag" VALUES (?, ?, ?, ?)', ("tag-1", "lead", '{"harness":"codex"}', "2026-10-01")),
        ('INSERT INTO "Role" VALUES (?, ?, ?)', ("role-1", "reviewer", "2026-10-01")),
        ('INSERT INTO "RoleAssignment" VALUES (?, ?, ?, ?, ?)', ("ra-1", "tag-1", "role-1", "active", "2026-10-01")),
        ('INSERT INTO "Objective" VALUES (?, ?, ?, ?, ?)', ("obj-1", "Ship the archive", "completed", "team-1", "2026-10-02")),
        ('INSERT INTO "Team" VALUES (?, ?, ?, ?)', ("team-1", "archive", '["tag-1"]', "2026-10-02")),
        ('INSERT INTO "WorkstreamPost" VALUES (?, ?, ?, ?, ?, ?)', ("wp-2", "team-1", "tag-1", "Second", 2, "2026-10-03")),
        ('INSERT INTO "WorkstreamPost" VALUES (?, ?, ?, ?, ?, ?)', ("wp-1", "team-1", "tag-1", "First", 1, "2026-10-03")),
        ('INSERT INTO "TagMessage" VALUES (?, ?, ?, ?, ?, ?)', ("tm-1", "tag-1", "tag-1", "obj-1", "Done?", "2026-10-03")),
        ('INSERT INTO "Session" VALUES (?, ?, ?)', ("ses-1", "tag-1", "2026-10-02")),
        ('INSERT INTO "Task" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
         ("task-1", "tag-1", "ses-1", "obj-1", "in-1", '{"kind":"operator"}', "Line one\nline \\two \"quoted\" é",
          "Answer", '{"summary":"ok"}', "completed", "2026-10-02")),
        ('INSERT INTO "TaskAttempt" VALUES (?, ?, ?, ?, ?)', ("att-2", "task-1", 2, "succeeded", "2026-10-02")),
        ('INSERT INTO "TaskAttempt" VALUES (?, ?, ?, ?, ?)', ("att-1", "task-1", 1, "failed", "2026-10-02")),
        ('INSERT INTO "OutboundReply" VALUES (?, ?, ?, ?, ?)', ("rep-1", "in-1", "Answer posted", "delivered", "2026-10-02")),
    ]
    return rows


def make_state(root):
    state = root / "state"
    (state / "hosts/laptop/attempt-journal").mkdir(parents=True)
    (state / "artifacts/sha256").mkdir(parents=True)
    (state / "workspaces/repo").mkdir(parents=True)
    (state / "supertag.yaml").write_text("services:\n  control-plane:\n    type: control-plane\n")
    (state / "credentials.json").write_text(json.dumps({"key": SECRET}))
    (state / "hosts/laptop/credential.json").write_text(json.dumps({"secret": SECRET}))
    (state / "worker-hosts").mkdir()
    (state / "worker-hosts/laptop%20two.credential.json").write_text(json.dumps({"secret": SECRET}))
    (state / "hosts/laptop/home/.codex").mkdir(parents=True)
    (state / "hosts/laptop/home/.codex/auth.json").write_text(json.dumps({"token": SECRET}))
    (state / "hosts/laptop/home/.claude").mkdir(parents=True)
    (state / "hosts/laptop/home/.claude/.credentials.json").write_text(json.dumps({"token": SECRET}))
    (state / ".env").write_text(f"CURSOR_API_KEY={SECRET}\n")
    (state / "workspaces/repo/.env.example").write_text("CURSOR_API_KEY=\n")
    (state / "hosts/laptop/attempt-journal/attempts.sqlite").write_bytes(b"journal\x00bytes")
    (state / "artifacts/sha256/abc").write_bytes(os.urandom(4096))
    (state / "workspaces/repo/link").symlink_to("../../supertag.yaml")
    connection = sqlite3.connect(state / "supertag.db")
    for statement, values in legacy_schema(connection.execute):
        connection.execute(statement, values)
    connection.execute('CREATE TABLE "Blob" (id TEXT, data BLOB)')
    connection.execute('INSERT INTO "Blob" VALUES (?, ?)', ("b", b"\x00\xff"))
    connection.commit()
    connection.close()
    return state


def decompressed(archive):
    return subprocess.run(["zstd", "-q", "-d", "-c", str(archive)], check=True, capture_output=True).stdout


def repack(archive, change):
    """Rewrite an archive's members with change(name, data) and give it a matching .sha256."""
    original = tarfile.open(fileobj=io.BytesIO(decompressed(archive)))
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as target:
        for member in original.getmembers():
            data = original.extractfile(member).read() if member.isfile() else None
            if data is not None:
                data = change(member.name, data)
                member.size = len(data)
            target.addfile(member, io.BytesIO(data) if data is not None else None)
    compressed = subprocess.run(["zstd", "-q", "-c"], input=buffer.getvalue(), check=True, capture_output=True).stdout
    archive.write_bytes(compressed)
    Path(str(archive) + ".sha256").write_text(f"{hashlib.sha256(compressed).hexdigest()}  {archive.name}\n")


def git(*arguments, cwd):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *arguments], cwd=cwd,
                          check=True, capture_output=True, text=True).stdout.strip()


@unittest.skipUnless(shutil.which("zstd"), "zstd is required")
class LegacyArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = make_state(self.root)
        self.archive = self.root / "legacy.tar.zst"
        self.bundle = self.root / "legacy.tar.zst.secrets.tar.age"
        tools = self.root / "tools"
        tools.mkdir()
        (tools / "age").write_text(FAKE_AGE)
        (tools / "age").chmod(0o755)
        self.identity = self.root / "identity.txt"
        self.identity.write_text("FAKE-IDENTITY-operator\n")
        self.path = os.environ["PATH"]
        os.environ["PATH"] = f"{tools}{os.pathsep}{self.path}"

    def tearDown(self):
        os.environ["PATH"] = self.path
        self.temporary.cleanup()

    def create(self, source, archive, **options):
        options.setdefault("age_recipients", ["fakeage1operator"])
        return create(source, archive, **options)

    def verify(self, archive, **options):
        options.setdefault("age_identity", self.identity)
        return verify(archive, **options)

    def test_round_trip_counts_rows_excludes_secrets_and_exports_records(self):
        report = self.create(self.state, self.archive)
        self.assertEqual(self.archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(report["rows"], 14)
        self.assertEqual(report["warnings"], [])
        self.assertEqual(sorted(report["secrets"]), [
            ".env", "credentials.json", "hosts/laptop/credential.json", "hosts/laptop/home/.claude/.credentials.json",
            "hosts/laptop/home/.codex/auth.json", "worker-hosts/laptop%20two.credential.json"])
        self.assertTrue(self.verify(self.archive, source=self.state)["checkedAgainstSource"])
        tar = tarfile.open(fileobj=io.BytesIO(decompressed(self.archive)))
        names = tar.getnames()
        self.assertEqual(names[-1], "manifest.json")
        self.assertNotIn(SECRET.encode(), decompressed(self.archive))
        self.assertIn("state/workspaces/repo/.env.example", names)
        self.assertEqual(tar.getmember("state/workspaces/repo/link").linkname, "../../supertag.yaml")
        manifest = json.load(tar.extractfile("manifest.json"))
        self.assertEqual(manifest["tables"]["Empty"], 0)
        self.assertEqual(set(manifest["secrets"]["credentials.json"]), {"bytes", "sha256"})
        blob = json.loads(tar.extractfile("tables/Blob.jsonl").read())
        self.assertEqual(blob["data"], {"$base64": "AP8="})
        tasks = json.load(tar.extractfile("records/tasks.json"))
        self.assertEqual([attempt["id"] for attempt in tasks[0]["attempts"]], ["att-1", "att-2"])
        self.assertEqual(tasks[0]["result"], {"summary": "ok"})
        conversations = json.load(tar.extractfile("records/conversations.json"))
        turn = conversations["sessions"][0]["turns"][0]
        self.assertEqual(turn["request"], "Line one\nline \\two \"quoted\" é")
        self.assertEqual(turn["replies"][0]["text"], "Answer posted")
        tags = json.load(tar.extractfile("records/tags.json"))
        self.assertEqual(tags[0]["roles"][0]["role"], "reviewer")
        objectives = json.load(tar.extractfile("records/objectives.json"))
        self.assertEqual((objectives[0]["messages"][0]["text"], objectives[0]["taskIds"]), ("Done?", ["task-1"]))
        self.assertEqual(objectives[0]["team"]["name"], "archive")
        self.assertEqual([post["body"] for post in objectives[0]["team"]["posts"]], ["First", "Second"])
        self.assertEqual(conversations["tagMessages"][0]["id"], "tm-1")
        self.assertTrue(Path(str(self.archive) + ".sha256").read_text().startswith(report["sha256"]))
        self.assertEqual(manifest["secretsBundle"]["recipients"], ["fakeage1operator"])
        self.assertEqual(manifest["secretsBundle"]["sha256"], hashlib.sha256(self.bundle.read_bytes()).hexdigest())
        self.assertEqual((report["secretsBundle"], report["secretsDecrypted"]), (str(self.bundle), False))
        self.assertEqual(self.bundle.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(SECRET.encode(), self.bundle.read_bytes())
        created = datetime.fromisoformat(manifest["createdAt"])
        self.assertEqual(manifest["snapshot"], {"keepDays": 30,
                                                "deleteAfter": (created + timedelta(days=30)).date().isoformat()})
        self.assertEqual(report["snapshotDeleteAfter"], manifest["snapshot"]["deleteAfter"])

    def test_secrets_bundle_decrypts_with_the_identity_and_verify_requires_it(self):
        report = self.create(self.state, self.archive, age_identity=self.identity)
        self.assertTrue(report["secretsDecrypted"])
        self.assertTrue(self.verify(self.archive, source=self.state)["secretsDecrypted"])
        with self.assertRaisesRegex(ArchiveError, "pass --age-identity"):
            verify(self.archive)
        stranger = self.root / "stranger.txt"
        stranger.write_text("FAKE-IDENTITY-stranger\n")
        with self.assertRaisesRegex(ArchiveError, "does not decrypt with .*no identity matched"):
            verify(self.archive, age_identity=stranger)
        self.assertEqual(legacy_archive.main(["verify", str(self.archive), "--age-identity", str(self.identity)]), 0)
        self.assertEqual(legacy_archive.main(["verify", str(self.archive)]), 1)
        original = self.bundle.read_bytes()
        self.bundle.write_bytes(original + b"x")
        with self.assertRaisesRegex(ArchiveError, "SHA-256 differs from the manifest"):
            self.verify(self.archive)
        self.bundle.unlink()
        with self.assertRaisesRegex(ArchiveError, "is missing"):
            self.verify(self.archive)

    def test_verify_matches_each_decrypted_secret_with_the_manifest(self):
        self.create(self.state, self.archive)

        def forget(name, data):
            if name == "manifest.json":
                manifest = json.loads(data)
                manifest["secrets"][".env"]["sha256"] = "0" * 64
                return json.dumps(manifest).encode()
            return data

        repack(self.archive, forget)
        with self.assertRaisesRegex(ArchiveError, "secrets bundle's files differ from the manifest: .env"):
            self.verify(self.archive)

    def test_secrets_need_recipients_and_age(self):
        with self.assertRaisesRegex(ArchiveError, "6 secret files need an encrypted bundle"):
            self.create(self.state, self.archive, age_recipients=[])
        with self.assertRaisesRegex(ArchiveError, "could not encrypt the secrets bundle: age: error: unknown"):
            self.create(self.state, self.archive, age_recipients=["age1notfake"])
        only_zstd = self.root / "only-zstd"
        only_zstd.mkdir()
        (only_zstd / "zstd").symlink_to(shutil.which("zstd"))
        os.environ["PATH"] = str(only_zstd)
        with self.assertRaisesRegex(ArchiveError, "age is not installed; install it from https://age-encryption.org"):
            self.create(self.state, self.archive)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()),
                         ["identity.txt", "only-zstd", "state", "tools"])

    def test_files_supertag_yaml_names_as_secrets_go_into_the_bundle(self):
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.skipTest("PyYAML is not installed")
        # The snapshot was renamed from ~/.supertag, which supertag.yaml still names.
        home, saved = self.root / "home", {name: os.environ.get(name) for name in ("HOME", "SUPERTAG_STATE_DIR")}
        os.environ["HOME"] = str(home)
        os.environ.pop("SUPERTAG_STATE_DIR", None)
        self.addCleanup(lambda: [os.environ.pop(name, None) if value is None else os.environ.__setitem__(name, value)
                                 for name, value in saved.items()])
        (self.state / "supertag.yaml").write_text(
            "env_file: [config/harness.env]\n"
            "services:\n  control-plane:\n    type: control-plane\n"
            "    tls: {cert: tls/server.crt, key: tls/server-material}\n    operators: {file: operators.yaml}\n"
            "  laptop:\n    type: host\n    volume-credentials: {bucket: {file: \"${CREDS_DIR:-creds}/bucket\"}}\n"
            "secrets:\n  db-password: {file: ~/.supertag/db-password}\n"
            "  slack: {file: secrets/slack-app-token}\n  elsewhere: {file: /nonexistent/token}\n"
            "  github: {environment: GITHUB_TOKEN}\n")
        named = ["config/harness.env", "creds/bucket", "db-password", "operators.yaml", "secrets/slack-app-token",
                 "tls/server-material"]
        for relative in [*named, "tls/server.crt"]:
            (self.state / relative).parent.mkdir(parents=True, exist_ok=True)
            (self.state / relative).write_text(SECRET if relative in named else "certificate\n")
        report = self.create(self.state, self.archive, age_identity=self.identity)
        self.assertTrue(set(named) <= set(report["secrets"]))
        self.assertTrue(report["secretsDecrypted"])
        names = tarfile.open(fileobj=io.BytesIO(decompressed(self.archive))).getnames()
        self.assertIn("state/tls/server.crt", names)
        self.assertFalse({f"state/{relative}" for relative in named} & set(names))
        self.assertNotIn(SECRET.encode(), decompressed(self.archive))
        self.assertTrue(self.verify(self.archive, source=self.state)["checkedAgainstSource"])
        # A database URL file kept in the state directory is a secret too.
        self.assertIn("legacy-db-url", legacy_archive.secret_paths(self.state, self.state / "legacy-db-url"))

    def test_create_refuses_supertag_yaml_secret_files_it_cannot_read(self):
        (self.state / "supertag.yaml").write_text(
            "services:\n  control-plane:\n    type: control-plane\nsecrets:\n  db-password: {file: db-password}\n")
        (self.state / "db-password").write_text(SECRET)
        saved = sys.modules.get("yaml")
        sys.modules["yaml"] = None  # import yaml now fails, as without PyYAML
        try:
            with self.assertRaisesRegex(ArchiveError, "reading it needs PyYAML"):
                self.create(self.state, self.archive)
        finally:
            if saved is None:
                del sys.modules["yaml"]
            else:
                sys.modules["yaml"] = saved
        self.assertFalse(self.archive.exists())
        self.assertFalse(self.bundle.exists())

    def test_state_without_secrets_needs_no_bundle(self):
        for path in [*self.state.rglob("*credential*.json"), *self.state.rglob("auth.json"), self.state / ".env"]:
            path.unlink()
        report = create(self.state, self.archive)
        self.assertEqual((report["secrets"], report["secretsBundle"]), ([], None))
        self.assertFalse(self.bundle.exists())
        self.assertFalse(verify(self.archive, source=self.state)["secretsDecrypted"])

    def test_task_checkouts_are_left_out_and_unsaved_work_is_reported(self):
        repository = self.root / "repository"
        repository.mkdir()
        git("init", "-q", "-b", "main", cwd=repository)
        (repository / "README.md").write_text("repository\n")
        git("add", ".", cwd=repository)
        git("commit", "-q", "-m", "first", cwd=repository)
        worktrees = self.state / "workspaces/repo/worktrees"
        for name in ("clean", "dirty", "orphan"):
            git("worktree", "add", "-q", "--detach", str(worktrees / name), cwd=repository)
        (worktrees / "dirty/README.md").write_text("unsaved\n")
        git("commit", "-q", "--allow-empty", "-m", "only here", cwd=worktrees / "orphan")
        (worktrees / "clean/.env").write_text(f"TOKEN={SECRET}\n")
        git("add", "-f", ".env", cwd=worktrees / "clean")
        git("commit", "-q", "-m", "committed secret", cwd=worktrees / "clean")
        git("branch", "kept", cwd=worktrees / "clean")
        (worktrees / "broken").mkdir()
        report = self.create(self.state, self.archive)
        self.assertEqual(report["unsavedCheckouts"], {
            "workspaces/repo/worktrees/broken": "is not a readable Git checkout",
            "workspaces/repo/worktrees/dirty": "has uncommitted changes",
            "workspaces/repo/worktrees/orphan": "has a commit that is on no branch"})
        self.assertEqual(len(report["warnings"]), 3)
        self.assertIn("save that work before you delete the snapshot", report["warnings"][0])
        self.assertEqual(report["excludedPatterns"], ["workspaces/*/worktrees"])
        names = tarfile.open(fileobj=io.BytesIO(decompressed(self.archive))).getnames()
        self.assertFalse([name for name in names if "/worktrees" in name])
        self.assertNotIn("workspaces/repo/worktrees/clean/.env", report["secrets"])
        self.assertEqual((worktrees / "dirty/README.md").read_text(), "unsaved\n")
        self.verify(self.archive, source=self.state)

    def test_refuses_running_services_or_an_unclosed_database(self):
        (self.state / "control-plane").mkdir()
        (self.state / "control-plane/pid").write_text(str(os.getpid()))
        with self.assertRaisesRegex(ArchiveError, "is running"):
            self.create(self.state, self.archive)
        (self.state / "control-plane/pid").unlink()
        (self.state / "supertag.db-wal").write_bytes(b"x")
        with self.assertRaisesRegex(ArchiveError, "not closed cleanly"):
            self.create(self.state, self.archive)
        self.assertFalse(self.archive.exists())
        self.assertFalse(Path(str(self.archive) + ".partial").exists())

    def test_warns_when_the_state_directory_names_a_postgresql_database(self):
        (self.state / "supertag.yaml").write_text(
            "services:\n  control-plane:\n    type: control-plane\n    database:\n      url: ${DATABASE_URL}\n")
        report = self.create(self.state, self.archive)
        self.assertEqual(len(report["warnings"]), 1)
        self.assertIn("--database-url-file", report["warnings"][0])

    def test_damaged_archive_fails_without_a_traceback(self):
        self.create(self.state, self.archive)
        data = self.archive.read_bytes()[:-200]
        self.archive.write_bytes(data)
        Path(str(self.archive) + ".sha256").write_text(f"{hashlib.sha256(data).hexdigest()}  {self.archive.name}\n")
        self.assertEqual(legacy_archive.main(["verify", str(self.archive)]), 1)

    def test_postgres_url_passes_tls_and_socket_options_to_the_client_tools(self):
        url_file = self.root / "url"
        url_file.write_text("postgresql://user:p%40ss@/supertag?host=/var/run/postgresql&sslmode=verify-full"
                            "&sslrootcert=/etc/ca.pem\n")
        database = legacy_archive.Postgres(url_file)
        self.assertEqual({key: database.env[key] for key in ("PGHOST", "PGPASSWORD", "PGSSLMODE", "PGSSLROOTCERT")},
                         {"PGHOST": "/var/run/postgresql", "PGPASSWORD": "p@ss", "PGSSLMODE": "verify-full",
                          "PGSSLROOTCERT": "/etc/ca.pem"})
        url_file.write_text("postgresql://h/supertag?unknown=1\n")
        with self.assertRaisesRegex(ArchiveError, "unknown"):
            legacy_archive.Postgres(url_file)

    def test_verify_detects_a_changed_source(self):
        self.create(self.state, self.archive)
        (self.state / "supertag.yaml").write_text("services: {}\n")
        with self.assertRaisesRegex(ArchiveError, "supertag.yaml differs"):
            self.verify(self.archive, source=self.state)
        (self.state / "supertag.yaml").unlink()
        with self.assertRaisesRegex(ArchiveError, "differ from the archive"):
            self.verify(self.archive, source=self.state)

    def test_verify_detects_a_changed_source_row_count(self):
        self.create(self.state, self.archive)
        connection = sqlite3.connect(self.state / "supertag.db")
        connection.execute('UPDATE "Tag" SET name = name')
        connection.execute('INSERT INTO "Empty" VALUES (?)', ("new",))
        connection.commit()
        connection.close()
        with self.assertRaisesRegex(ArchiveError, "supertag.db differs"):
            self.verify(self.archive, source=self.state)

    def test_verify_detects_corruption_and_rewritten_members(self):
        self.create(self.state, self.archive)
        data = bytearray(self.archive.read_bytes())
        data[len(data) // 2] ^= 1
        corrupt = self.root / "corrupt.tar.zst"
        corrupt.write_bytes(data)
        Path(str(corrupt) + ".sha256").write_text(Path(str(self.archive) + ".sha256").read_text())
        with self.assertRaisesRegex(ArchiveError, "SHA-256 differs"):
            self.verify(corrupt)
        cases = {
            "state/supertag.yaml": (lambda data: data + b"#", "differs from its manifest"),
            "tables/Task.jsonl": (lambda data: b"", "differs from its manifest"),
        }
        for name, (edit, message) in cases.items():
            with self.subTest(name=name):
                copy = self.root / f"edited-{name.replace('/', '-')}.tar.zst"
                shutil.copyfile(self.archive, copy)
                repack(copy, lambda member, data: edit(data) if member == name else data)
                with self.assertRaisesRegex(ArchiveError, message):
                    self.verify(copy)

    def test_verify_checks_row_counts_inside_the_archive(self):
        self.create(self.state, self.archive)

        def lie(name, data):
            if name == "manifest.json":
                manifest = json.loads(data)
                manifest["tables"]["Task"] = 2
                return json.dumps(manifest).encode()
            return data

        repack(self.archive, lie)
        with self.assertRaisesRegex(ArchiveError, "Task.jsonl has 1 rows, manifest says 2"):
            self.verify(self.archive)

    def test_exclude_leaves_out_paths_and_verify_honours_it(self):
        report = self.create(self.state, self.archive, patterns=["workspaces"])
        names = tarfile.open(fileobj=io.BytesIO(decompressed(self.archive))).getnames()
        self.assertFalse([name for name in names if name.startswith("state/workspaces")])
        self.assertEqual(report["excludedPatterns"], ["workspaces/*/worktrees", "workspaces"])
        self.verify(self.archive, source=self.state)

    def test_config_lists_and_removes_keys_the_rust_runtime_rejects(self):
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.skipTest("PyYAML is not installed")
        source = self.root / "supertag.yaml"
        source.write_text(
            "name: dogfood\nservices:\n  control-plane:\n    type: control-plane\n    tls: {cert: a, key: b}\n"
            "    logging: {level: info, audit: stderr}\n  laptop:\n    type: host\n    harnesses: [codex]\n"
            "    labels: [gpu]\n    concurrency: 2\n    allow-unsandboxed-commands: [codex, claude-code, cursor]\n"
            "    x-note: kept by TypeScript\n  x-template:\n    harnesses: [codex]\n"
            "x-anchor: &anchor {a: 1}\n")
        text = source.read_text().replace("    tls:", "    credentials: vault://kv/supertag\n    x-owner: me\n    tls:")
        source.write_text(text)
        result = translate_config(source, self.root / "rust.yaml")
        self.assertEqual(sorted(item["key"] for item in result["removed"]), [
            "services.control-plane.credentials", "services.control-plane.logging.level",
            "services.control-plane.tls", "services.control-plane.x-owner",
            "services.laptop.allow-unsandboxed-commands[codex]",
            "services.laptop.x-note", "services.x-template"])
        translated = (self.root / "rust.yaml").read_text()
        self.assertIn("concurrency: 2", translated)
        # The Rust host reports declared labels, so a Tag's runsOn keeps selecting it.
        self.assertIn("labels:\n    - gpu", translated)
        self.assertIn("- claude-code", translated)
        self.assertIn("- cursor", translated)
        self.assertIn("x-anchor", translated)
        self.assertNotIn("vault", translated)

    def test_manifests_rename_execution_fields_and_drop_local_workspaces(self):
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML is not installed")
        source = self.root / "org.yaml"
        source.write_text(
            "apiVersion: supertag/v1\nkind: Workspace\nmetadata: {name: repo}\nspec: {ref: main, delivery: branch, setup: make}\n"
            "---\napiVersion: supertag/v1\nkind: Tag\nmetadata: {name: lead}\n"
            "spec: {roles: [Lead], workerHosts: [laptop], execution: {harness: codex, model: m, effort: [low]}}\n")
        result = translate_manifests(source, self.root / "rust.yaml")
        self.assertEqual(result["documents"], 1)
        self.assertEqual([change["resource"] for change in result["changes"]], ["Workspace/repo", "Tag/lead", "Tag/lead", "Tag/lead"])
        [tag] = list(yaml.safe_load_all((self.root / "rust.yaml").read_text()))
        self.assertEqual(tag["spec"], {"roles": ["Lead"], "execution": {"harness": "codex", "models": ["m"], "efforts": ["low"]}})

    def test_manifests_drop_what_rust_refuses_and_rename_what_it_renamed(self):
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML is not installed")
        source = self.root / "org.yaml"
        source.write_text(
            "apiVersion: supertag/v1\nkind: Workspace\nmetadata: {name: api}\n"
            "spec: {source: 'https://github.com/acme/api.git', ref: main}\n"
            "---\napiVersion: supertag/v1\nkind: SurfaceAccount\nmetadata: {name: slack}\n"
            "spec: {provider: slack, secrets: {botToken: {env: SLACK_BOT_TOKEN}}}\n"
            "---\napiVersion: supertag/v1\nkind: Tag\nmetadata: {name: lead, labels: {a: b}}\n"
            "spec: {roles: [Lead], locations: [{provider: slack, channelId: C1}]}\n"
            "---\napiVersion: supertag/v1\nkind: Volume\nmetadata: {name: data}\n"
            "spec: {source: 's3://bucket/prefix', credential: r2}\n"
            "---\napiVersion: supertag/v1\nkind: PermissionSet\nmetadata: {name: slack-post}\n"
            "spec: {permissions: [{target: surface, surfaceAccountId: slack, scope: C1, action: post, approval: required}]}\n"
            "---\napiVersion: supertag/v1\nkind: Objective\nmetadata: {name: ship}\n"
            "spec: {owner: lead, outcome: Ship it, budget: {minor: 500, currency: USD}, workspaces: [api]}\n")
        result = translate_manifests(source, self.root / "rust.yaml")
        self.assertEqual(result["documents"], 4)
        messages = {(change["resource"], change["change"].split(":")[0]) for change in result["changes"]}
        self.assertIn(("Workspace/api", "removed the document"), messages)
        self.assertTrue(any("supertag workspace put" in change["change"] for change in result["changes"]))
        self.assertIn(("SurfaceAccount/slack", "removed the document"), messages)
        self.assertIn(("Tag/lead", "removed locations"), messages)
        self.assertIn(("Volume/data", "removed credential"), messages)
        tag, volume, permissions, objective = yaml.safe_load_all((self.root / "rust.yaml").read_text())
        self.assertEqual((tag["metadata"], tag["spec"]), ({"name": "lead"}, {"roles": ["Lead"]}))
        self.assertEqual(volume["spec"], {"source": "s3://bucket/prefix"})
        self.assertEqual(permissions["spec"]["permissions"], [
            {"target": "surface", "scope": "C1", "action": "post", "surface_account_id": "slack", "approval_required": True}])
        self.assertEqual(objective["spec"], {"outcome": "Ship it", "ownerTagId": "lead", "budgetLimitMinor": 500,
                                             "budgetCurrency": "USD"})


@unittest.skipUnless(shutil.which("zstd"), "zstd is required")
@unittest.skipUnless(shutil.which("age") and shutil.which("age-keygen"),
                     "age is not installed, so the real age encryption tests are skipped; install age "
                     "(https://age-encryption.org) to run them")
class RealAgeSecretsBundleTests(unittest.TestCase):
    """The secrets bundle against the real age, with throwaway keys made for each test."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = make_state(self.root)
        self.archive = self.root / "legacy.tar.zst"

    def tearDown(self):
        self.temporary.cleanup()

    def keypair(self, name):
        identity = self.root / f"{name}.key"
        subprocess.run(["age-keygen", "-o", str(identity)], check=True, capture_output=True)
        recipient = subprocess.run(["age-keygen", "-y", str(identity)], check=True, capture_output=True,
                                   text=True).stdout.strip()
        return identity, recipient

    def test_bundle_round_trips_through_age(self):
        identity, recipient = self.keypair("operator")
        recipients_file = self.root / "recipients.txt"
        backup_identity, backup_recipient = self.keypair("backup")
        recipients_file.write_text(f"# backup key\n{backup_recipient}\n")
        status = legacy_archive.main(["create", "--from", str(self.state), "--to", str(self.archive),
                                      "--age-recipient", recipient, "--age-recipients-file", str(recipients_file),
                                      "--age-identity", str(identity)])
        self.assertEqual(status, 0)
        bundle = Path(str(self.archive) + ".secrets.tar.age")
        self.assertNotIn(SECRET.encode(), bundle.read_bytes())
        self.assertNotIn(SECRET.encode(), decompressed(self.archive))
        for key in (identity, backup_identity):
            self.assertTrue(verify(self.archive, source=self.state, age_identity=key)["secretsDecrypted"])
        stranger, _ = self.keypair("stranger")
        with self.assertRaisesRegex(ArchiveError, "does not decrypt"):
            verify(self.archive, age_identity=stranger)
        restored = self.root / "restored"
        restored.mkdir()
        plaintext = subprocess.run(["age", "-d", "-i", str(identity), str(bundle)], check=True,
                                   capture_output=True).stdout
        tarfile.open(fileobj=io.BytesIO(plaintext)).extractall(restored, filter="tar")
        self.assertEqual((restored / ".env").read_text(), (self.state / ".env").read_text())
        self.assertEqual(stat.S_IMODE((restored / "credentials.json").stat().st_mode),
                         stat.S_IMODE((self.state / "credentials.json").stat().st_mode))


@unittest.skipUnless(shutil.which("zstd") and os.environ.get("SUPERTAG_LEGACY_ARCHIVE_TEST_POSTGRES_URL_FILE"),
                     "set SUPERTAG_LEGACY_ARCHIVE_TEST_POSTGRES_URL_FILE to a disposable PostgreSQL server URL")
class LegacyPostgresArchiveTests(unittest.TestCase):
    def test_postgres_round_trip(self):
        base = legacy_archive.Postgres(os.environ["SUPERTAG_LEGACY_ARCHIVE_TEST_POSTGRES_URL_FILE"])
        name = f"supertag_legacy_archive_{uuid.uuid4().hex[:12]}"
        base.run("psql", "-X", "-v", "ON_ERROR_STOP=1", "-c", f'CREATE DATABASE "{name}"')
        try:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                url = Path(os.environ["SUPERTAG_LEGACY_ARCHIVE_TEST_POSTGRES_URL_FILE"]).read_text().strip()
                url_file = root / "url"
                url_file.write_text(url.rsplit("/", 1)[0] + "/" + name)
                database = legacy_archive.Postgres(url_file)
                statements = []
                for statement, values in legacy_schema(statements.append):
                    statements.append(statement.replace("?", "{}").format(*(
                        "'" + value.replace("'", "''") + "'" if isinstance(value, str) else str(value)
                        for value in values)))
                database.run("psql", "-X", "-v", "ON_ERROR_STOP=1", "-f", "-", stdin=";\n".join(statements) + ";\n")
                database.run("psql", "-X", "-v", "ON_ERROR_STOP=1", "-c",
                             'ALTER TABLE "Task" ALTER COLUMN result TYPE jsonb USING result::jsonb')
                state = root / "state"
                state.mkdir()
                (state / "supertag.yaml").write_text("services: {}\n")
                archive = root / "legacy.tar.zst"
                report = create(state, archive, database_url_file=url_file)
                self.assertEqual(report["rows"], 13)
                tar = tarfile.open(fileobj=io.BytesIO(decompressed(archive)))
                self.assertIn("database/supertag.pgdump", tar.getnames())
                task = json.loads(tar.extractfile("tables/Task.jsonl").read())
                self.assertEqual(task["requestText"], "Line one\nline \\two \"quoted\" é")
                self.assertEqual(task["result"], {"summary": "ok"})
                verify(archive, source=state, database_url_file=url_file)
                database.run("psql", "-X", "-c", 'INSERT INTO "Empty" VALUES (\'new\')')
                with self.assertRaisesRegex(ArchiveError, "row counts differ"):
                    verify(archive, source=state, database_url_file=url_file)
        finally:
            base.run("psql", "-X", "-c", f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


if __name__ == "__main__":
    unittest.main()
