#!/usr/bin/env python3
"""Archive and verify a stopped TypeScript SuperTag state directory. Requires Python 3.11+ and zstd.

The archive is a read-only record for the cutover to the Rust runtime, which starts with fresh
state. Nothing here imports legacy data into Rust. `create` reads a state directory (and its
PostgreSQL database when one is named), writes FILE (tar + zstd) and FILE.sha256, then verifies
both. `verify` re-reads an archive, and with --from also checks it against the source again.
`config` and `manifests` translate a TypeScript supertag.yaml and resource manifests, listing what
the Rust runtime no longer accepts.

Secrets stay out of the archive: credential stores, host credentials, .env files, and private
keys are listed in the manifest by path, size, and SHA-256 only. The archive still holds
conversation text and Task output that may quote secrets, so keep it private.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import fnmatch
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import unquote, urlsplit

FORMAT = "supertag-legacy-archive-v1"
MANIFEST = "manifest.json"
DATABASE_FILE = "supertag.db"
# File names left out as secrets, and names that match them but hold no secret.
SECRET_RULES = {
    "names": ["credentials.json", "credential.json", ".env", ".env.*", "*.pem", "*.key",
              "id_rsa", "id_rsa.*", "id_ecdsa", "id_ecdsa.*", "id_ed25519", "id_ed25519.*"],
    "except": ["*.example", "*.sample", "*.template"],
}
TABLE_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,62}")
CHUNK = 1024 * 1024


class ArchiveError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ArchiveError(message)


def sha256_file(path):
    with open(path, "rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def private_directory(prefix):
    return Path(tempfile.mkdtemp(prefix=prefix))


def is_secret(relative, rules):
    name = PurePosixPath(relative).name
    matches = lambda patterns: any(fnmatch.fnmatchcase(name, pattern) for pattern in patterns)
    return matches(rules["names"]) and not matches(rules["except"])


def excluded(relative, patterns):
    return any(fnmatch.fnmatchcase(relative, pattern) or fnmatch.fnmatchcase(relative, pattern.rstrip("/") + "/*")
               for pattern in patterns)


def walk(source, patterns, rules=SECRET_RULES):
    """Every path under source in a stable order, classified. Symlinks are never followed."""
    entries, secrets, skipped = {}, {}, {}

    def visit(directory, prefix):
        with os.scandir(directory) as iterator:
            children = sorted(iterator, key=lambda entry: entry.name)
        for child in children:
            relative = f"{prefix}{child.name}"
            if excluded(relative, patterns):
                continue
            info = child.stat(follow_symlinks=False)
            mode = stat.S_IMODE(info.st_mode)
            if stat.S_ISLNK(info.st_mode):
                entries[relative] = {"kind": "symlink", "target": os.readlink(child.path)}
            elif stat.S_ISDIR(info.st_mode):
                entries[relative] = {"kind": "directory", "mode": mode}
                visit(child.path, relative + "/")
            elif stat.S_ISREG(info.st_mode):
                if is_secret(relative, rules):
                    secrets[relative] = {"bytes": info.st_size, "sha256": sha256_file(child.path)}
                else:
                    entries[relative] = {"kind": "file", "mode": mode, "bytes": info.st_size}
            else:
                skipped[relative] = "not a regular file, directory, or symlink"

    visit(source, "")
    return entries, secrets, skipped


def require_stopped(source):
    """Refuse a state directory whose services still run or whose database has a hot journal."""
    for pid_file in [source / "control-plane/pid", *sorted(source.glob("hosts/*/pid"))]:
        try:
            pid = int(pid_file.read_text().strip())
        except (OSError, ValueError):
            continue
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        except PermissionError:
            pass
        raise ArchiveError(f"process {pid} from {pid_file.relative_to(source)} is running; run the old "
                           "runtime's supertag down first, or remove a stale pid file")
    for suffix in ("-wal", "-journal"):
        journal = source / (DATABASE_FILE + suffix)
        require(not journal.exists() or journal.stat().st_size == 0,
                f"{journal.name} is not empty: the database was not closed cleanly. Start and stop "
                "the old Control Plane once, then archive again")


# Table export ------------------------------------------------------------------------------

def sqlite_value(value):
    if isinstance(value, bytes):
        return {"$base64": base64.b64encode(value).decode()}
    return value


def export_sqlite(database, tables_directory):
    """One JSON object per row for every table, from a read-only connection to a private copy."""
    uri = "file:" + str(database).replace("?", "%3F").replace("#", "%23") + "?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    try:
        check = connection.execute("PRAGMA integrity_check").fetchall()
        require(check == [("ok",)], "the legacy SQLite database fails its integrity check")
        counts = {}
        names = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        for name in names:
            require(TABLE_NAME.fullmatch(name), f"unexpected table name {name!r}")
            cursor = connection.execute(f'SELECT * FROM "{name}"')
            columns = [column[0] for column in cursor.description]
            count = 0
            with (tables_directory / f"{name}.jsonl").open("x", encoding="utf-8") as output:
                for row in cursor:
                    record = {column: sqlite_value(value) for column, value in zip(columns, row)}
                    output.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
                    count += 1
            counts[name] = count
        return counts
    finally:
        connection.close()


def sqlite_counts(database):
    uri = "file:" + str(database).replace("?", "%3F").replace("#", "%23") + "?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    try:
        check = connection.execute("PRAGMA integrity_check").fetchall()
        require(check == [("ok",)], "the archived SQLite database fails its integrity check")
        names = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        return {name: connection.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0] for name in names}
    finally:
        connection.close()


class Postgres:
    """PostgreSQL client tools with the URL from a private file, never on a command line."""

    def __init__(self, url_file, pg_bin=None):
        parsed = urlsplit(Path(url_file).read_text().strip())
        require(parsed.scheme in ("postgres", "postgresql") and parsed.hostname and parsed.path.strip("/"),
                "the database URL file must hold a postgresql:// URL with a database name")
        self.bin = Path(pg_bin) if pg_bin else None
        self.description = {"host": parsed.hostname, "port": parsed.port or 5432,
                            "database": unquote(parsed.path.lstrip("/"))}
        self.env = {**os.environ, "PGHOST": parsed.hostname, "PGPORT": str(parsed.port or 5432),
                    "PGUSER": unquote(parsed.username or ""), "PGPASSWORD": unquote(parsed.password or ""),
                    "PGDATABASE": self.description["database"], "PGCONNECT_TIMEOUT": "10"}

    def tool(self, name):
        return str(self.bin / name) if self.bin else (shutil.which(name) or name)

    def run(self, name, *arguments, stdin=None):
        result = subprocess.run([self.tool(name), *arguments], env=self.env, input=stdin,
                                capture_output=True, text=True)
        require(result.returncode == 0, f"{name} failed: {result.stderr.strip()[-2000:]}")
        return result.stdout

    def tables(self):
        output = self.run("psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c",
                          "SELECT table_name FROM information_schema.tables WHERE table_schema = "
                          "current_schema() AND table_type = 'BASE TABLE' ORDER BY 1")
        names = [line for line in output.splitlines() if line]
        for name in names:
            require(TABLE_NAME.fullmatch(name), f"unexpected table name {name!r}")
        return names

    def counts(self):
        names = self.tables()
        if not names:
            return {}
        query = "SELECT json_build_object(" + ", ".join(
            f"'{name}', (SELECT count(*) FROM \"{name}\")" for name in names) + ")"
        return json.loads(self.run("psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query))

    def export(self, tables_directory, dump):
        """A custom-format dump, then every table as JSON lines in one read-only snapshot."""
        self.run("pg_dump", "--format=custom", "--no-password", "--file", str(dump))
        names = self.tables()
        require("'" not in str(tables_directory), "staging path must not contain a quote")
        script = ["\\set ON_ERROR_STOP 1", "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;"]
        for name in names:
            # CSV with control-character quote and delimiter leaves each JSON line byte-for-byte.
            script.append(f"\\copy (SELECT row_to_json(t) FROM \"{name}\" t) TO "
                          f"'{tables_directory}/{name}.jsonl' WITH (FORMAT csv, QUOTE E'\\x01', DELIMITER E'\\x02')")
        counts_file = tables_directory.parent / "counts.json"
        if names:
            script.append("\\copy (SELECT json_build_object(" + ", ".join(
                f"'{name}', (SELECT count(*) FROM \"{name}\")" for name in names) +
                f")) TO '{counts_file}' WITH (FORMAT csv, QUOTE E'\\x01', DELIMITER E'\\x02')")
        script.append("COMMIT;")
        self.run("psql", "-X", "-q", "-f", "-", stdin="\n".join(script) + "\n")
        counts = json.loads(counts_file.read_text()) if names else {}
        counts_file.unlink(missing_ok=True)
        for name in names:
            require(count_lines(tables_directory / f"{name}.jsonl") == counts[name],
                    f"{name} export differs from its row count")
        return counts


def count_lines(path):
    with open(path, "rb") as file:
        return sum(chunk.count(b"\n") for chunk in iter(lambda: file.read(CHUNK), b""))


# Readable records ----------------------------------------------------------------------------

def read_table(tables_directory, name):
    path = tables_directory / f"{name}.jsonl"
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as file:
        return [json.loads(line) for line in file]


def decoded(row):
    """Expand JSON held in text columns so records read naturally."""
    result = {}
    for key, value in row.items():
        if isinstance(value, str) and value[:1] in ("{", "["):
            try:
                value = json.loads(value)
            except ValueError:
                pass
        result[key] = value
    return result


def by(rows, column):
    groups = {}
    for row in rows:
        groups.setdefault(row.get(column), []).append(row)
    return groups


def created(row):
    return (str(row.get("createdAt") or ""), str(row.get("id") or ""))


def build_records(tables_directory, records_directory):
    """Tags, Objectives, Tasks with results, and conversations as plain JSON."""
    roles = {row.get("id"): row for row in read_table(tables_directory, "Role")}
    assignments = by(read_table(tables_directory, "RoleAssignment"), "tagId")
    tags = []
    for tag in sorted(read_table(tables_directory, "Tag"), key=created):
        tag = decoded(tag)
        tag["roles"] = [{"role": roles.get(item.get("roleId"), {}).get("name", item.get("roleId")),
                         **{key: item.get(key) for key in ("status", "createdAt") if key in item}}
                        for item in sorted(assignments.get(tag.get("id"), []), key=created)]
        tags.append(tag)

    tasks_table = sorted(read_table(tables_directory, "Task"), key=created)
    attempts = by(read_table(tables_directory, "TaskAttempt"), "taskId")
    replies = by(read_table(tables_directory, "OutboundReply"), "inboundEventId")
    tasks = []
    for task in tasks_table:
        task = decoded(task)
        task["attempts"] = [decoded(item) for item in sorted(
            attempts.get(task.get("id"), []), key=lambda item: item.get("attemptNumber") or 0)]
        tasks.append(task)

    messages = by(read_table(tables_directory, "ObjectiveMessage"), "objectiveId")
    workstreams = by(read_table(tables_directory, "Workstream"), "objectiveId")
    posts = by(read_table(tables_directory, "WorkstreamPost"), "workstreamId")
    tasks_by_objective = by(tasks_table, "objectiveId")
    objectives = []
    for objective in sorted(read_table(tables_directory, "Objective"), key=created):
        objective = decoded(objective)
        identifier = objective.get("id")
        objective["messages"] = [decoded(item) for item in sorted(messages.get(identifier, []), key=created)]
        objective["workstreams"] = [
            {**decoded(stream), "posts": [decoded(post) for post in sorted(
                posts.get(stream.get("id"), []), key=lambda post: post.get("sequence") or 0)]}
            for stream in sorted(workstreams.get(identifier, []), key=created)]
        objective["taskIds"] = [task.get("id") for task in tasks_by_objective.get(identifier, [])]
        objectives.append(objective)

    tasks_by_session = by(tasks_table, "sessionId")
    sessions = []
    for session in sorted(read_table(tables_directory, "Session"), key=created):
        session = decoded(session)
        session["turns"] = [{
            "taskId": task.get("id"), "actor": decoded(task).get("actor"), "trigger": task.get("trigger"),
            "request": task.get("requestText"), "response": task.get("responseText"),
            "status": task.get("status"), "createdAt": task.get("createdAt"), "endedAt": task.get("endedAt"),
            "replies": [{key: reply.get(key) for key in ("text", "status", "deliveredAt", "createdAt")}
                        for reply in sorted(replies.get(task.get("inboundEventId"), []), key=created)]
            if task.get("inboundEventId") else [],
        } for task in tasks_by_session.get(session.get("id"), [])]
        sessions.append(session)
    tag_messages = [decoded(item) for item in sorted(read_table(tables_directory, "TagMessage"), key=created)]

    records = {"tags.json": tags, "objectives.json": objectives, "tasks.json": tasks,
               "conversations.json": {"sessions": sessions, "tagMessages": tag_messages}}
    for name, value in records.items():
        with (records_directory / name).open("x", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.write("\n")
    return {"tags": len(tags), "objectives": len(objectives), "tasks": len(tasks),
            "sessions": len(sessions), "tagMessages": len(tag_messages)}


RECORD_FILES = ("tags.json", "objectives.json", "tasks.json", "conversations.json")
RECORD_TABLES = {"tags": "Tag", "objectives": "Objective", "tasks": "Task", "sessions": "Session",
                 "tagMessages": "TagMessage"}

README = """# Legacy SuperTag archive

A read-only record of a TypeScript SuperTag state directory, made for the cutover to the Rust
runtime. Rust starts with fresh state and never reads this archive.

- `state/`: the state directory's files, byte for byte, without secrets. `state/supertag.db` is
  the SQLite database when the old Control Plane used SQLite.
- `database/supertag.pgdump`: a `pg_dump --format=custom` of the old PostgreSQL database, when
  it used PostgreSQL. Restore it with `pg_restore` into an empty database.
- `tables/TABLE.jsonl`: every row of every table, one JSON object per line. SQLite BLOB values
  appear as `{"$base64": "..."}`.
- `records/`: the important records in readable JSON: `tags.json` (with Role assignments),
  `objectives.json` (with messages, Workstream posts, and Task IDs), `tasks.json` (with requests,
  responses, results, and Attempts), and `conversations.json` (Sessions as request and response
  turns with delivered replies, and Mailbox messages between Tags).
- `manifest.json`: the SHA-256, size, and mode of every entry, the row count of every table, and
  the secret files that were left out, listed by path, size, and SHA-256 only.

Verify with `python3 rust/scripts/legacy_archive.py verify ARCHIVE` from a SuperTag checkout.
"""


# Writing -----------------------------------------------------------------------------------

class HashingReader:
    def __init__(self, file):
        self.file, self.hash, self.bytes = file, hashlib.sha256(), 0

    def read(self, size=-1):
        data = self.file.read(size)
        self.hash.update(data)
        self.bytes += len(data)
        return data


def add_file(target, name, path, mode, mtime):
    info = tarfile.TarInfo(name)
    info.size, info.mode, info.mtime = os.stat(path).st_size, mode, int(mtime)
    with open(path, "rb") as file:
        reader = HashingReader(file)
        target.addfile(info, reader)
    require(reader.bytes == info.size, f"{name} changed while it was archived")
    return {"kind": "file", "mode": mode, "bytes": info.size, "sha256": reader.hash.hexdigest()}


def create(source, destination, database_url_file=None, pg_bin=None, patterns=()):
    started = time.monotonic()
    source, destination = Path(source).resolve(), Path(destination).absolute()
    require(source.is_dir() and not Path(source).is_symlink(), "--from must be a state directory")
    require(not destination.exists(), f"{destination} already exists")
    require(not destination.resolve().is_relative_to(source), "write the archive outside the state directory")
    require(shutil.which("zstd"), "zstd is required")
    require_stopped(source)
    sqlite_database = source / DATABASE_FILE
    require(database_url_file or sqlite_database.is_file(),
            f"{source} has no {DATABASE_FILE}; name the PostgreSQL database with --database-url-file")
    entries, secrets, skipped = walk(source, patterns)
    require(not (database_url_file is None and entries.get(DATABASE_FILE, {}).get("kind") != "file"),
            f"{DATABASE_FILE} must be a regular file")

    staging = private_directory(".supertag-legacy-archive-")
    partial = None
    try:
        tables_directory, records_directory = staging / "tables", staging / "records"
        tables_directory.mkdir()
        records_directory.mkdir()
        database = {}
        exported = time.monotonic()
        if database_url_file:
            postgres = Postgres(database_url_file, pg_bin)
            dump = staging / "supertag.pgdump"
            counts = postgres.export(tables_directory, dump)
            database = {"kind": "postgresql", **postgres.description, "dump": "database/supertag.pgdump"}
        else:
            # Read a private copy; the same bytes go into the archive and must match the source.
            copy = staging / DATABASE_FILE
            before = sha256_file(sqlite_database)
            shutil.copyfile(sqlite_database, copy)
            require(sha256_file(copy) == before == sha256_file(sqlite_database),
                    f"{DATABASE_FILE} changed while it was copied; stop the old services")
            counts = export_sqlite(copy, tables_directory)
            copy.unlink()
            database = {"kind": "sqlite", "file": f"state/{DATABASE_FILE}", "sha256": before}
        records = build_records(tables_directory, records_directory)
        exported = time.monotonic() - exported
        (staging / "README.md").write_text(README)

        archived = {}
        candidate = destination.with_name(destination.name + ".partial")
        descriptor = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        partial = candidate
        with os.fdopen(descriptor, "wb") as output:
            compressor = subprocess.Popen(["zstd", "-q", "-T0", "-c"], stdin=subprocess.PIPE, stdout=output)
            try:
                with tarfile.open(fileobj=compressor.stdin, mode="w|", format=tarfile.PAX_FORMAT) as target:
                    now = time.time()
                    archived["README.md"] = add_file(target, "README.md", staging / "README.md", 0o600, now)
                    for directory, prefix in ((records_directory, "records"), (tables_directory, "tables")):
                        for path in sorted(directory.iterdir()):
                            archived[f"{prefix}/{path.name}"] = add_file(target, f"{prefix}/{path.name}", path, 0o600, now)
                    if database_url_file:
                        archived["database/supertag.pgdump"] = add_file(
                            target, "database/supertag.pgdump", staging / "supertag.pgdump", 0o600, now)
                    for relative, record in entries.items():
                        name, path = f"state/{relative}", source / relative
                        if record["kind"] == "file":
                            archived[name] = add_file(target, name, path, record["mode"], path.lstat().st_mtime)
                        else:
                            info = tarfile.TarInfo(name)
                            info.mtime = int(path.lstat().st_mtime)
                            if record["kind"] == "directory":
                                info.type, info.mode = tarfile.DIRTYPE, record["mode"]
                            else:
                                info.type, info.linkname, info.mode = tarfile.SYMTYPE, record["target"], 0o777
                            target.addfile(info)
                            archived[name] = dict(record)
                    if database.get("kind") == "sqlite":
                        require(archived[database["file"]]["sha256"] == database["sha256"],
                                f"{DATABASE_FILE} changed while it was archived")
                    manifest = {
                        "format": FORMAT,
                        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "tool": {"script": "rust/scripts/legacy_archive.py", "sha256": sha256_file(__file__)},
                        "source": {"path": str(source), "database": database},
                        "entries": archived,
                        "tables": counts,
                        "records": records,
                        "secretsExcluded": secrets,
                        "secretRules": SECRET_RULES,
                        "excludedPatterns": list(patterns),
                        "skipped": skipped,
                    }
                    payload = json.dumps(manifest, indent=1, sort_keys=True).encode()
                    info = tarfile.TarInfo(MANIFEST)
                    info.size, info.mode, info.mtime = len(payload), 0o600, int(now)
                    target.addfile(info, io.BytesIO(payload))
            finally:
                compressor.stdin.close()
                code = compressor.wait()
            require(code == 0, "zstd failed")
            output.flush()
            os.fsync(output.fileno())
        written = time.monotonic()
        digest = sha256_file(partial)
        report = verify(partial, digest, source=source, database_url_file=database_url_file, pg_bin=pg_bin)
        os.rename(partial, destination)
        partial = None
        sidecar = destination.with_name(destination.name + ".sha256")
        with os.fdopen(os.open(sidecar, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
            file.write(f"{digest}  {destination.name}\n")
        return {
            "archive": str(destination), "sha256": digest, "archiveBytes": destination.stat().st_size,
            "stateBytes": sum(item.get("bytes", 0) for name, item in archived.items() if name.startswith("state/")),
            "entries": len(archived), "tables": len(counts), "rows": sum(counts.values()), "records": records,
            "secretsExcluded": sorted(secrets), "skipped": sorted(skipped), "excludedPatterns": list(patterns),
            "seconds": {"export": round(exported, 2), "write": round(written - started - exported, 2),
                        "verify": report["seconds"], "total": round(time.monotonic() - started, 2)},
        }
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        if partial is not None:
            partial.unlink(missing_ok=True)


# Verification ------------------------------------------------------------------------------

def safe_name(name):
    return (isinstance(name, str) and 0 < len(name) < 4096 and not name.startswith("/") and "\\" not in name
            and all(part not in ("", ".", "..") for part in name.split("/")))


def verify(archive, expected_sha256=None, source=None, database_url_file=None, pg_bin=None):
    started = time.monotonic()
    archive = Path(archive)
    require(archive.is_file(), f"{archive} is not a file")
    require(shutil.which("zstd"), "zstd is required")
    if expected_sha256 is None:
        sidecar = archive.with_name(archive.name + ".sha256")
        require(sidecar.is_file(), f"{sidecar.name} is missing; keep it next to the archive")
        expected_sha256 = sidecar.read_text().split()[0]
    require(sha256_file(archive) == expected_sha256, "the archive's SHA-256 differs from its .sha256 file")

    scratch = private_directory(".supertag-legacy-verify-")
    try:
        seen, lines, manifest = {}, {}, None
        decompressor = subprocess.Popen(["zstd", "-q", "-d", "-c", str(archive)], stdout=subprocess.PIPE)
        try:
            with tarfile.open(fileobj=decompressor.stdout, mode="r|") as contents:
                for member in contents:
                    name = member.name
                    require(manifest is None, "manifest.json must be the last entry")
                    require(safe_name(name) and name not in seen, f"invalid or repeated entry {name!r}")
                    if name == MANIFEST:
                        require(member.isfile() and member.size <= 256 * 1024 * 1024, "invalid manifest")
                        manifest = json.load(contents.extractfile(member))
                        continue
                    if member.isdir():
                        seen[name] = {"kind": "directory", "mode": member.mode}
                    elif member.issym():
                        seen[name] = {"kind": "symlink", "target": member.linkname}
                    else:
                        require(member.isfile(), f"{name} is not a file, directory, or symlink")
                        stream, digest = contents.extractfile(member), hashlib.sha256()
                        newlines, keep = 0, None
                        if name in ("state/" + DATABASE_FILE, "database/supertag.pgdump") or (
                                name.startswith("records/") and name[len("records/"):] in RECORD_FILES):
                            keep = (scratch / PurePosixPath(name).name).open("xb")
                        for chunk in iter(lambda: stream.read(CHUNK), b""):
                            digest.update(chunk)
                            newlines += chunk.count(b"\n")
                            if keep:
                                keep.write(chunk)
                        if keep:
                            keep.close()
                        seen[name] = {"kind": "file", "mode": member.mode, "bytes": member.size,
                                      "sha256": digest.hexdigest()}
                        if name.startswith("tables/"):
                            lines[name[len("tables/"):-len(".jsonl")]] = newlines
        finally:
            decompressor.stdout.close()
            code = decompressor.wait()
        require(code == 0, "zstd could not decompress the archive")
        require(isinstance(manifest, dict) and manifest.get("format") == FORMAT, "manifest.json is missing or invalid")

        entries, counts = manifest["entries"], manifest["tables"]
        require(set(entries) == set(seen), "the archive's entries differ from its manifest: "
                + ", ".join(sorted(set(entries) ^ set(seen))[:10]))
        for name, record in entries.items():
            require(seen[name] == record, f"{name} differs from its manifest record")
        require(set(lines) == set(counts), "the table exports differ from the manifest's tables")
        for table, count in counts.items():
            require(lines[table] == count, f"tables/{table}.jsonl has {lines[table]} rows, manifest says {count}")
        for record, table in RECORD_TABLES.items():
            require(manifest["records"].get(record) == counts.get(table, 0),
                    f"records hold {manifest['records'].get(record)} {record}, {table} has {counts.get(table, 0)}")
        readable = {name: json.loads((scratch / name).read_text()) for name in RECORD_FILES}
        found = {"tags": len(readable["tags.json"]), "objectives": len(readable["objectives.json"]),
                 "tasks": len(readable["tasks.json"]),
                 "sessions": len(readable["conversations.json"]["sessions"]),
                 "tagMessages": len(readable["conversations.json"]["tagMessages"])}
        require(found == manifest["records"], "the readable records differ from the manifest")
        database = manifest["source"]["database"]
        if database["kind"] == "sqlite":
            require(sqlite_counts(scratch / DATABASE_FILE) == counts,
                    "the archived SQLite database's row counts differ from the manifest")
        else:
            postgres_tool = Path(pg_bin) / "pg_restore" if pg_bin else (shutil.which("pg_restore") or "pg_restore")
            result = subprocess.run([str(postgres_tool), "--list", str(scratch / "supertag.pgdump")],
                                    capture_output=True, text=True)
            require(result.returncode == 0, "pg_restore cannot read the archived dump")

        checked_source = False
        if source is not None:
            check_source(Path(source).resolve(), manifest, database_url_file, pg_bin)
            checked_source = True
        return {"archive": str(archive), "sha256": expected_sha256, "entries": len(entries),
                "tables": len(counts), "rows": sum(counts.values()), "records": manifest["records"],
                "secretsExcluded": sorted(manifest["secretsExcluded"]), "checkedAgainstSource": checked_source,
                "seconds": round(time.monotonic() - started, 2)}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def check_source(source, manifest, database_url_file, pg_bin):
    """The source still matches: every file's checksum and every table's row count."""
    require(source.is_dir(), f"{source} is not a directory")
    entries, secrets, _ = walk(source, manifest["excludedPatterns"], manifest["secretRules"])
    archived = {name[len("state/"):]: record for name, record in manifest["entries"].items()
                if name.startswith("state/")}
    require(set(entries) == set(archived), "the source's files differ from the archive: "
            + ", ".join(sorted(set(entries) ^ set(archived))[:10]))
    for relative, record in entries.items():
        expected = archived[relative]
        if record["kind"] == "file":
            record = {**record, "sha256": sha256_file(source / relative)}
        require(record == expected, f"{relative} differs between the source and the archive")
    require(secrets == manifest["secretsExcluded"], "the source's secret files differ from those recorded")
    database = manifest["source"]["database"]
    if database["kind"] == "sqlite":
        scratch = private_directory(".supertag-legacy-source-")
        try:
            copy = scratch / DATABASE_FILE
            shutil.copyfile(source / DATABASE_FILE, copy)
            require(sqlite_counts(copy) == manifest["tables"], "the source database's row counts differ")
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
    else:
        require(database_url_file, "name the source PostgreSQL database with --database-url-file")
        require(Postgres(database_url_file, pg_bin).counts() == manifest["tables"],
                "the source database's row counts differ")


# supertag.yaml ---------------------------------------------------------------------------

RUST_KEYS = {
    None: {"version", "name", "services", "secrets", "surfaces", "env_file"},
    "control-plane": {"type", "ports", "url", "credentials", "restart", "provision", "notify", "database", "logging"},
    "host": {"type", "control-plane", "auth-key", "harnesses", "adapter", "adapter-args", "models", "workspaces",
             "skills", "allow-unsandboxed-commands", "restart", "depends_on", "concurrency",
             "attempt-timeout-seconds"},
    ("control-plane", "logging"): {"audit"},
    ("control-plane", "database"): {"url", "password"},
}
UNSANDBOXED_HARNESSES = ("opencode", "cursor")
GUIDANCE = {
    "tls": "the local Control Plane listens on loopback; deploy with `supertag setup deployment` for TLS",
    "hosts": "Worker Hosts connect to the Control Plane's one public endpoint",
    "operators": "issue named Operator Tokens with `supertag operator-token create`",
    "labels": "grant labels with `supertag auth-key create --role host --label LABEL`",
    "environment": "put harness variables in env_file (STATE_DIRECTORY/.env by default)",
    "mcp": "MCP servers are declared by Tags and Roles; see `supertag mcp list`",
    "volume-credentials": "declare Volumes with `supertag volume put`",
    "artifact-volume": "declare Volumes with `supertag volume put`",
    "local-mount-root": "live mounts are not supported",
    "level": "only logging.audit is configurable",
    "format": "only logging.audit is configurable",
}


def translate_config(source, destination):
    import yaml  # PyYAML, only for this command

    document = yaml.safe_load(Path(source).read_text())
    require(isinstance(document, dict) and isinstance(document.get("services"), dict), "not a supertag.yaml")
    removed = []

    def prune(mapping, allowed, path):
        for key in list(mapping):
            if key not in allowed and not str(key).startswith("x-"):
                removed.append({"key": ".".join([*path, str(key)]),
                                "instead": GUIDANCE.get(key, "not supported by the Rust runtime")})
                del mapping[key]

    prune(document, RUST_KEYS[None], [])
    for name, service in document["services"].items():
        kind = service.get("type") if isinstance(service, dict) else None
        require(kind in ("control-plane", "host"), f"service {name} has unknown type {kind!r}")
        prune(service, RUST_KEYS[kind], ["services", name])
        consent = service.get("allow-unsandboxed-commands")
        if kind == "host" and isinstance(consent, list):
            kept = [harness for harness in consent if harness in UNSANDBOXED_HARNESSES]
            for harness in consent:
                if harness not in kept:
                    removed.append({"key": f"services.{name}.allow-unsandboxed-commands[{harness}]",
                                    "instead": "only OpenCode and Cursor accept unsandboxed command consent"})
            if kept:
                service["allow-unsandboxed-commands"] = kept
            else:
                del service["allow-unsandboxed-commands"]
        for section in ("logging", "database"):
            if kind == "control-plane" and isinstance(service.get(section), dict):
                prune(service[section], RUST_KEYS[(kind, section)], ["services", name, section])
    if destination:
        with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
            output.write("# Translated from a TypeScript supertag.yaml by rust/scripts/legacy_archive.py.\n")
            yaml.safe_dump(document, output, sort_keys=False)
    return {"removed": removed, "written": str(destination) if destination else None}


def translate_manifests(source, destination):
    """Rename TypeScript manifest fields the Rust apply renamed, and drop what it no longer takes."""
    import yaml  # PyYAML, only for this command

    documents = [document for document in yaml.safe_load_all(Path(source).read_text()) if document is not None]
    changes, kept = [], []
    for index, document in enumerate(documents, 1):
        require(isinstance(document, dict) and "kind" in document, f"document {index} is not a manifest")
        kind, spec = document["kind"], document.get("spec") or {}
        name = f"{kind}/{(document.get('metadata') or {}).get('name')}"
        if kind == "Workspace" and "github" not in spec:
            moved = {key: spec[key] for key in ("delivery", "setup") if key in spec}
            changes.append({"resource": name, "change": "removed: a local Workspace is a host's workspaces entry in "
                            f"supertag.yaml; move {moved or 'nothing'} there, and bind Tags with "
                            "workspace: {id: NAME, baseCommit: SHA}",
                            "dropped": sorted(set(spec) - set(moved))})
            continue
        execution = spec.get("execution")
        if isinstance(execution, dict):
            for old, new in (("model", "models"), ("effort", "efforts")):
                if old in execution:
                    value = execution.pop(old)
                    execution[new] = value if isinstance(value, list) else [value]
                    changes.append({"resource": name, "change": f"execution.{old} -> execution.{new}"})
        if kind == "Tag" and "workerHosts" in spec:
            changes.append({"resource": name, "change": "removed workerHosts: local Worker Hosts serve every Tag; "
                            "route remote hosts with Auth Key labels and runsOn",
                            "dropped": spec.pop("workerHosts")})
        kept.append(document)
    if destination:
        with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
            output.write("# Translated from TypeScript manifests by rust/scripts/legacy_archive.py.\n")
            yaml.safe_dump_all(kept, output, sort_keys=False, allow_unicode=True, width=1000)
    return {"changes": changes, "documents": len(kept), "written": str(destination) if destination else None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("create", help="archive a stopped TypeScript state directory, then verify it")
    make.add_argument("--from", dest="source", required=True, type=Path, help="TypeScript state directory")
    make.add_argument("--to", dest="destination", required=True, type=Path, help="new archive file, such as legacy.tar.zst")
    make.add_argument("--database-url-file", type=Path, help="private file holding the PostgreSQL URL, when not SQLite")
    make.add_argument("--pg-bin", type=Path, help="directory of psql, pg_dump, and pg_restore")
    make.add_argument("--exclude", action="append", default=[], metavar="GLOB",
                      help="leave out matching paths relative to the state directory, such as 'workspaces'")
    check = commands.add_parser("verify", help="check an archive's checksums and row counts")
    check.add_argument("archive", type=Path)
    check.add_argument("--from", dest="source", type=Path, help="also compare with this state directory")
    check.add_argument("--database-url-file", type=Path)
    check.add_argument("--pg-bin", type=Path)
    config = commands.add_parser("config", help="list TypeScript supertag.yaml keys the Rust runtime rejects")
    config.add_argument("file", type=Path)
    config.add_argument("--to", dest="destination", type=Path, help="write a copy without them")
    manifests = commands.add_parser("manifests", help="translate TypeScript resource manifests for supertag apply")
    manifests.add_argument("file", type=Path)
    manifests.add_argument("--to", dest="destination", type=Path, help="write the translated manifests")
    arguments = parser.parse_args(argv)
    os.umask(0o077)
    try:
        if arguments.command == "create":
            result = create(arguments.source, arguments.destination, arguments.database_url_file,
                            arguments.pg_bin, arguments.exclude)
        elif arguments.command == "verify":
            result = verify(arguments.archive, source=arguments.source,
                            database_url_file=arguments.database_url_file, pg_bin=arguments.pg_bin)
        elif arguments.command == "config":
            result = translate_config(arguments.file, arguments.destination)
        else:
            result = translate_manifests(arguments.file, arguments.destination)
    except (ArchiveError, OSError, sqlite3.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
