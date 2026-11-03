"""Durable, single-supervisor execution receipts. Specifications stay in memory only."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sqlite3
import stat
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator
from uuid import uuid4

from .environment import ExecutionCleanupError
from .models import (
    WORKLET_PROTOCOL_VERSION,
    CancellationToken,
    LocalWorklet,
    _capabilities_for_attempt,
    _supports_required_context,
    required_text,
)

_TERMINAL = {"completed", "failed", "cancelled", "unknown"}
_SECRET = re.compile(r"token|secret|password|credential|api.?key", re.I)


class FileAttemptJournal:
    """Private SQLite journal, locked for the lifetime of one supervisor (POSIX)."""

    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(directory).absolute()
        self.database: sqlite3.Connection | None = None
        self._lock: int | None = None

    def initialize(self) -> None:
        if self.database is not None:
            raise RuntimeError("Attempt journal already open")
        if os.name != "posix":
            raise RuntimeError("Durable Python journal requires POSIX file locking")
        import fcntl

        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = self.directory.lstat()
        if (
            self.directory.is_symlink()
            or not self.directory.is_dir()
            or metadata.st_mode & 0o077
            or metadata.st_uid != os.getuid()
        ):
            raise ValueError("Attempt journal must be a private owned directory")
        lock = os.open(self.directory / "owner.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        db = None
        try:
            lock_metadata = os.fstat(lock)
            if (
                not stat.S_ISREG(lock_metadata.st_mode)
                or lock_metadata.st_uid != os.getuid()
                or lock_metadata.st_mode & 0o077
            ):
                raise ValueError("Journal owner lock must be a private owned file")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            path = self.directory / "attempts.sqlite"
            for name in ("attempts.sqlite", "attempts.sqlite-wal", "attempts.sqlite-shm"):
                entry = self.directory / name
                if entry.is_symlink():
                    raise ValueError("Attempt database files cannot be symlinks")
                if entry.exists() and (not entry.is_file() or entry.stat().st_uid != os.getuid()):
                    raise ValueError("Attempt database files must be owned regular files")
            db = sqlite3.connect(path)
            os.chmod(path, 0o600)
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
            db.execute(
                "CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, receipt TEXT NOT NULL)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS events (attempt_id TEXT NOT NULL, "
                "sequence INTEGER NOT NULL, event TEXT NOT NULL, "
                "PRIMARY KEY(attempt_id,sequence))"
            )
            db.commit()
            self.database, self._lock = db, lock
        except BaseException:
            if db is not None:
                db.close()
            os.close(lock)
            raise

    def receipts(self) -> list[dict[str, Any]]:
        assert self.database is not None
        return [json.loads(row[0]) for row in self.database.execute("SELECT receipt FROM attempts")]

    def put(self, receipt: dict[str, Any], event: dict[str, Any] | None = None) -> None:
        assert self.database is not None
        with self.database:
            if event is not None:
                self.database.execute(
                    "INSERT INTO events VALUES (?,?,?)",
                    (
                        receipt["attemptId"],
                        receipt["lastSequence"],
                        json.dumps(event, allow_nan=False),
                    ),
                )
            self.database.execute(
                "INSERT INTO attempts VALUES (?,?) ON CONFLICT(id) "
                "DO UPDATE SET receipt=excluded.receipt",
                (receipt["attemptId"], json.dumps(receipt, allow_nan=False)),
            )

    def events(self, attempt_id: str, after: int) -> list[dict[str, Any]]:
        assert self.database is not None
        return [
            {"sequence": row[0], "event": json.loads(row[1])}
            for row in self.database.execute(
                "SELECT sequence,event FROM events WHERE attempt_id=? AND sequence>? "
                "ORDER BY sequence LIMIT 100",
                (attempt_id, after),
            )
        ]

    def close(self) -> None:
        if self.database is not None:
            self.database.close()
            self.database = None
        if self._lock is not None:
            os.close(self._lock)
            self._lock = None


class DurableLocalWorklet:
    """Persist admission before acknowledgement; never reissue unresolved executions."""

    durable_protocol_version = WORKLET_PROTOCOL_VERSION

    def __init__(self, worklet: LocalWorklet, journal: FileAttemptJournal) -> None:
        self.id = worklet.id
        self._worklet = worklet
        self._journal = journal
        journal.initialize()
        try:
            self._records = {row["attemptId"]: row for row in journal.receipts()}
            for record in self._records.values():
                if record["status"] not in _TERMINAL:
                    record["status"] = "unknown"
                    journal.put(record)
        except BaseException:
            journal.close()
            raise
        self._active: dict[str, tuple[CancellationToken, asyncio.Task[None]]] = {}
        self._lock = asyncio.Lock()
        self._changed = asyncio.Event()
        self._closed = False
        self._placements: dict[str, tuple[float, dict[str, Any]]] = {}

    async def describe(self):
        return await self._worklet.describe()

    async def execute(self, attempt, cancellation):
        raise RuntimeError("Durable Worklet requires accept/inspect/events, not legacy execute")
        yield  # pragma: no cover

    def _prune_placements(self) -> None:
        now = time.time()
        self._placements = {key: value for key, value in self._placements.items() if value[0] > now}

    def _reserved(self, worker_id: str) -> int:
        return sum(
            r["status"] in {"accepted", "running", "unknown"}
            and r.get("workerId") in (None, worker_id)
            for r in self._records.values()
        ) + sum(p["workerId"] == worker_id for _, p in self._placements.values())

    async def select_placement(
        self, requirements: dict[str, Any], context_plan: dict[str, Any], options: dict[str, Any]
    ) -> dict[str, Any] | None:
        if not all(isinstance(value, dict) for value in (requirements, context_plan, options)):
            raise ValueError("Invalid Worklet placement request")
        # These claims are not advertised by Python Workers.
        if "model" in requirements or "limits" in requirements:
            return None
        async with self._lock:
            if self._closed:
                return None
            descriptor = await self.describe()
            if "allowedWorkerHostIds" in options and not _host_allowed(
                descriptor.host.id, options["allowedWorkerHostIds"]
            ):
                return None
            self._prune_placements()
            candidates = []
            for worker in descriptor.host.workers:
                capacity = (worker.max_concurrency or 1) + (
                    1 if options.get("coordinationSlot") is True else 0
                )
                if self._reserved(worker.id) >= capacity:
                    continue
                for profile in worker.profiles:
                    ref = profile.to_wire()
                    if options.get("compatibleProfile", ref) != ref:
                        continue
                    attempt = {
                        "workerProfile": ref,
                        "execution": requirements,
                        "contextPlan": context_plan,
                    }
                    if not _supports_required_context(worker, attempt):
                        continue
                    capabilities = {
                        (c.id, c.version) for c in _capabilities_for_attempt(worker, attempt)
                    }
                    if (
                        options.get("requiresCoordination")
                        and ("supertag.coordination", 1) not in capabilities
                    ):
                        continue
                    if (
                        options.get("requiresSurfaceCoordination")
                        and ("supertag.coordination.surface", 1) not in capabilities
                    ):
                        continue
                    score = sum(
                        (item["id"], item["version"]) in capabilities
                        for item in requirements.get("prefers", [])
                    )
                    candidates.append(
                        (
                            -score,
                            self._reserved(worker.id) / (worker.max_concurrency or 1),
                            worker.id,
                            profile.id,
                            profile.revision,
                            ref,
                        )
                    )
            if not candidates:
                return None
            _, _, worker_id, _, _, profile = min(candidates, key=lambda candidate: candidate[:5])
            expires = time.time() + 30
            placement = {
                "workerHostId": descriptor.host.id,
                "workletId": descriptor.id,
                "workerId": worker_id,
                "workerProfile": profile,
                "reservation": {
                    "id": str(uuid4()),
                    "expiresAt": datetime.fromtimestamp(expires, timezone.utc)
                    .isoformat()
                    .replace("+00:00", "Z"),
                },
            }
            self._placements[placement["reservation"]["id"]] = (expires, placement)
            return json.loads(json.dumps(placement))

    async def release_placement(self, placement: dict[str, Any]) -> None:
        async with self._lock:
            reservation_id = required_text(placement["reservation"], "id")
            stored = self._placements.get(reservation_id)
            if stored is not None:
                if stored[1] != placement:
                    raise ValueError("Placement reservation mismatch")
                del self._placements[reservation_id]

    async def accept(self, spec: dict[str, Any]) -> dict[str, Any]:
        from .transport import _validate_attempt_spec

        if not isinstance(spec, dict):
            raise ValueError("Task Attempt Spec must be an object")
        _validate_attempt_spec(spec, authorization_versions=(5, 4))
        # Freeze mutable caller data before yielding to descriptor lookup.
        serialized = json.dumps(
            spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        )
        spec = json.loads(serialized)
        attempt_id, task_id = required_text(spec, "attemptId"), required_text(spec, "taskId")
        digest = hashlib.sha256(serialized.encode()).hexdigest()
        async with self._lock:
            if self._closed:
                raise RuntimeError("Durable Worklet is closing")
            existing = self._records.get(attempt_id)
            if existing is not None:
                if existing["specDigest"] != digest:
                    raise ValueError("Attempt specification conflict")
                return dict(existing)
            descriptor = await self.describe()
            identities = [worker.id for worker in descriptor.host.workers]
            if len(set(identities)) != len(identities):
                raise ValueError("Durable Workers require unique IDs")
            placement = spec.get("placement") or {}
            if placement and (
                not _host_allowed(descriptor.host.id, placement.get("allowedWorkerHostIds"))
                or placement.get("workerHostId", descriptor.host.id) != descriptor.host.id
                or placement.get("workletId", descriptor.id) != descriptor.id
            ):
                raise ValueError("Worker Host is not bound to this Task")
            self._prune_placements()
            reservation = placement.get("reservation")
            reservation_id = None
            if reservation is not None:
                reservation_id = required_text(reservation, "id")
                stored = self._placements.get(reservation_id)
                expected = {
                    "workerHostId": descriptor.host.id,
                    "workletId": descriptor.id,
                    "workerId": placement.get("workerId"),
                    "workerProfile": spec["workerProfile"],
                    "reservation": reservation,
                }
                if stored is None or stored[1] != expected:
                    raise ValueError("Placement reservation missing, expired, or mismatched")
            worker_id = None
            for worker in descriptor.host.workers:
                if placement.get("workerId", worker.id) != worker.id:
                    continue
                if not any(p.to_wire() == spec.get("workerProfile") for p in worker.profiles):
                    continue
                if not _supports_required_context(worker, spec):
                    continue
                capabilities = {(c.id, c.version) for c in _capabilities_for_attempt(worker, spec)}
                if (
                    spec.get("coordination") or spec.get("authorization", {}).get("version") == 4
                ) and ("supertag.coordination", 1) not in capabilities:
                    continue
                if (
                    spec.get("coordination", {}).get("scope") == "surface"
                    and ("supertag.coordination.surface", 1) not in capabilities
                ):
                    continue
                reserved = self._reserved(worker.id) - (1 if reservation_id is not None else 0)
                # An Objective owner's activation may use the coordination slot beyond the limit.
                coordination_slot = (spec.get("placement") or {}).get("coordinationSlot") is True
                if reserved < (worker.max_concurrency or 1) + (1 if coordination_slot else 0):
                    worker_id = worker.id
                    break
            if worker_id is None:
                raise RuntimeError("No eligible Worker capacity")
            record = {
                "workerId": worker_id,
                "attemptId": attempt_id,
                "taskId": task_id,
                "specDigest": digest,
                "status": "accepted",
                "lastSequence": 0,
            }
            self._journal.put(record)
            if reservation_id is not None:
                del self._placements[reservation_id]
            self._records[attempt_id] = record
            token = CancellationToken()
            run = asyncio.create_task(self._run(spec, token))
            self._active[attempt_id] = (token, run)
            return dict(record)

    async def _run(self, spec: dict[str, Any], token: CancellationToken) -> None:
        attempt_id = spec["attemptId"]
        record = self._records[attempt_id]
        secrets: list[str] = []

        def collect(value, key=""):
            if isinstance(value, str) and _SECRET.search(key) and value:
                secrets.append(value)
            elif isinstance(value, dict):
                for k, v in value.items():
                    collect(v, k)
            elif isinstance(value, list):
                for v in value:
                    collect(v)

        collect(spec)

        def redact(value, key=""):
            if _SECRET.search(key):
                return "[REDACTED]"
            if isinstance(value, str):
                for secret in secrets:
                    value = value.replace(secret, "[REDACTED]")
            elif isinstance(value, dict):
                return {k: redact(v, k) for k, v in value.items()}
            elif isinstance(value, list):
                return [redact(v) for v in value]
            return value

        status, terminal_seen = "unknown", None
        try:
            record["status"] = "running"
            self._journal.put(record)
            async for event in self._worklet.execute_on_worker(record["workerId"], spec, token):
                if event.get("taskId") != spec["taskId"] or event.get("attemptId") != attempt_id:
                    raise ValueError("Worker event identity mismatch")
                if terminal_seen is not None:
                    raise ValueError("Worker emitted event after terminal receipt")
                if event.get("type") in {"execution.completed", "execution.failed"}:
                    terminal_seen = event["type"]
                next_record = {**record, "lastSequence": record["lastSequence"] + 1}
                self._journal.put(next_record, redact(event))
                record.update(next_record)
                self._changed.set()
            status = (
                "cancelled"
                if token.cancelled
                else {"execution.completed": "completed", "execution.failed": "failed"}.get(
                    terminal_seen, "unknown"
                )
            )
        except BaseException as error:
            status = (
                "cancelled"
                if token.cancelled and not isinstance(error, ExecutionCleanupError)
                else "unknown"
            )
        finally:
            record["status"] = status
            try:
                self._journal.put(record)
            except Exception:
                record["status"] = "unknown"
            self._active.pop(attempt_id, None)
            self._changed.set()

    async def inspect(self, attempt_id: str) -> dict[str, Any] | None:
        record = self._records.get(attempt_id)
        return dict(record) if record is not None else None

    async def events(self, attempt_id: str, after: int = 0) -> AsyncIterator[dict[str, Any]]:
        if isinstance(after, bool) or not isinstance(after, int) or after < 0 or after > 2**53 - 1:
            raise ValueError("Invalid durable event cursor")
        if attempt_id not in self._records:
            raise ValueError("Unknown attempt")
        while True:
            self._changed.clear()
            batch = self._journal.events(attempt_id, after)
            for item in batch:
                after = item["sequence"]
                yield item
            if batch:
                continue
            if self._records[attempt_id]["status"] in _TERMINAL:
                return
            await self._changed.wait()

    async def cancel(
        self, attempt_id: str, reason: str = "Cancellation requested"
    ) -> dict[str, Any]:
        if not isinstance(reason, str):
            raise ValueError("Cancellation reason must be a string")
        async with self._lock:
            record = self._records.get(attempt_id)
            if record is None:
                raise ValueError("Unknown attempt")
            record["cancellationRequested"] = True
            self._journal.put(record)
            if attempt_id in self._active:
                self._active[attempt_id][0].cancel(reason)
            return dict(record)

    async def close(self) -> None:
        async with self._lock:
            if self._active:
                raise RuntimeError("Cannot close while attempts are active")
            self._closed = True
            self._journal.close()

    async def shutdown(self, reason: str = "Worklet shutting down") -> None:
        async with self._lock:
            self._closed = True
            active = tuple(self._active.items())
        runs = [entry[1] for _, entry in active]
        for attempt_id, _ in active:
            await self.cancel(attempt_id, reason)
        await asyncio.gather(*runs)
        await self.close()


def _host_allowed(host_id: str, allowed: Any) -> bool:
    return (
        isinstance(allowed, list)
        and all(isinstance(item, str) for item in allowed)
        and host_id in allowed
    )
