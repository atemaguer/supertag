"""Tests for the legacy TypeScript state archive (needs zstd; PostgreSQL only when configured)."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
import uuid

import legacy_archive
from legacy_archive import ArchiveError, create, translate_config, translate_manifests, verify

SECRET = "synthetic-provider-secret-value"


def legacy_schema(execute):
    for statement in (
        'CREATE TABLE "Tag" (id TEXT PRIMARY KEY, name TEXT, execution TEXT, "createdAt" TEXT)',
        'CREATE TABLE "Role" (id TEXT PRIMARY KEY, name TEXT, "createdAt" TEXT)',
        'CREATE TABLE "RoleAssignment" (id TEXT PRIMARY KEY, "tagId" TEXT, "roleId" TEXT, status TEXT, "createdAt" TEXT)',
        'CREATE TABLE "Objective" (id TEXT PRIMARY KEY, outcome TEXT, status TEXT, "createdAt" TEXT)',
        'CREATE TABLE "ObjectiveMessage" (id TEXT PRIMARY KEY, "objectiveId" TEXT, body TEXT, "createdAt" TEXT)',
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
        ('INSERT INTO "Objective" VALUES (?, ?, ?, ?)', ("obj-1", "Ship the archive", "completed", "2026-10-02")),
        ('INSERT INTO "ObjectiveMessage" VALUES (?, ?, ?, ?)', ("om-1", "obj-1", "Done?", "2026-10-03")),
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


@unittest.skipUnless(shutil.which("zstd"), "zstd is required")
class LegacyArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = make_state(self.root)
        self.archive = self.root / "legacy.tar.zst"

    def tearDown(self):
        self.temporary.cleanup()

    def test_round_trip_counts_rows_excludes_secrets_and_exports_records(self):
        report = create(self.state, self.archive)
        self.assertEqual(self.archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(report["rows"], 11)
        self.assertEqual(sorted(report["secretsExcluded"]), [".env", "credentials.json", "hosts/laptop/credential.json"])
        self.assertTrue(verify(self.archive, source=self.state)["checkedAgainstSource"])
        tar = tarfile.open(fileobj=io.BytesIO(decompressed(self.archive)))
        names = tar.getnames()
        self.assertEqual(names[-1], "manifest.json")
        self.assertNotIn(SECRET.encode(), decompressed(self.archive))
        self.assertIn("state/workspaces/repo/.env.example", names)
        self.assertEqual(tar.getmember("state/workspaces/repo/link").linkname, "../../supertag.yaml")
        manifest = json.load(tar.extractfile("manifest.json"))
        self.assertEqual(manifest["tables"]["Empty"], 0)
        self.assertEqual(set(manifest["secretsExcluded"]["credentials.json"]), {"bytes", "sha256"})
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
        self.assertEqual((objectives[0]["messages"][0]["body"], objectives[0]["taskIds"]), ("Done?", ["task-1"]))
        self.assertTrue(Path(str(self.archive) + ".sha256").read_text().startswith(report["sha256"]))

    def test_refuses_running_services_or_an_unclosed_database(self):
        (self.state / "control-plane").mkdir()
        (self.state / "control-plane/pid").write_text(str(os.getpid()))
        with self.assertRaisesRegex(ArchiveError, "is running"):
            create(self.state, self.archive)
        (self.state / "control-plane/pid").unlink()
        (self.state / "supertag.db-wal").write_bytes(b"x")
        with self.assertRaisesRegex(ArchiveError, "not closed cleanly"):
            create(self.state, self.archive)
        self.assertFalse(self.archive.exists())
        self.assertFalse(Path(str(self.archive) + ".partial").exists())

    def test_verify_detects_a_changed_source(self):
        create(self.state, self.archive)
        (self.state / "supertag.yaml").write_text("services: {}\n")
        with self.assertRaisesRegex(ArchiveError, "supertag.yaml differs"):
            verify(self.archive, source=self.state)
        (self.state / "supertag.yaml").unlink()
        with self.assertRaisesRegex(ArchiveError, "differ from the archive"):
            verify(self.archive, source=self.state)

    def test_verify_detects_a_changed_source_row_count(self):
        create(self.state, self.archive)
        connection = sqlite3.connect(self.state / "supertag.db")
        connection.execute('UPDATE "Tag" SET name = name')
        connection.execute('INSERT INTO "Empty" VALUES (?)', ("new",))
        connection.commit()
        connection.close()
        with self.assertRaisesRegex(ArchiveError, "supertag.db differs"):
            verify(self.archive, source=self.state)

    def test_verify_detects_corruption_and_rewritten_members(self):
        create(self.state, self.archive)
        data = bytearray(self.archive.read_bytes())
        data[len(data) // 2] ^= 1
        corrupt = self.root / "corrupt.tar.zst"
        corrupt.write_bytes(data)
        Path(str(corrupt) + ".sha256").write_text(Path(str(self.archive) + ".sha256").read_text())
        with self.assertRaisesRegex(ArchiveError, "SHA-256 differs"):
            verify(corrupt)
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
                    verify(copy)

    def test_verify_checks_row_counts_inside_the_archive(self):
        create(self.state, self.archive)

        def lie(name, data):
            if name == "manifest.json":
                manifest = json.loads(data)
                manifest["tables"]["Task"] = 2
                return json.dumps(manifest).encode()
            return data

        repack(self.archive, lie)
        with self.assertRaisesRegex(ArchiveError, "Task.jsonl has 1 rows, manifest says 2"):
            verify(self.archive)

    def test_exclude_leaves_out_paths_and_verify_honours_it(self):
        report = create(self.state, self.archive, patterns=["workspaces"])
        names = tarfile.open(fileobj=io.BytesIO(decompressed(self.archive))).getnames()
        self.assertFalse([name for name in names if name.startswith("state/workspaces")])
        self.assertEqual(report["excludedPatterns"], ["workspaces"])
        verify(self.archive, source=self.state)

    def test_config_lists_and_removes_keys_the_rust_runtime_rejects(self):
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.skipTest("PyYAML is not installed")
        source = self.root / "supertag.yaml"
        source.write_text(
            "name: dogfood\nservices:\n  control-plane:\n    type: control-plane\n    tls: {cert: a, key: b}\n"
            "    logging: {level: info, audit: stderr}\n  laptop:\n    type: host\n    harnesses: [codex]\n"
            "    labels: [gpu]\n    concurrency: 2\n    allow-unsandboxed-commands: [codex, cursor]\n")
        result = translate_config(source, self.root / "rust.yaml")
        self.assertEqual(sorted(item["key"] for item in result["removed"]), [
            "services.control-plane.logging.level", "services.control-plane.tls",
            "services.laptop.allow-unsandboxed-commands[codex]", "services.laptop.labels"])
        translated = (self.root / "rust.yaml").read_text()
        self.assertIn("concurrency: 2", translated)
        self.assertNotIn("labels", translated)
        self.assertIn("- cursor", translated)

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
                self.assertEqual(report["rows"], 10)
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
