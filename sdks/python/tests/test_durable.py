from __future__ import annotations

import asyncio
import json

import pytest

from supertag import (
    Capability,
    DurableLocalWorklet,
    ExecutionCleanupError,
    FileAttemptJournal,
    LocalWorklet,
    WorkerDescriptor,
    WorkerProfileCapabilities,
    WorkerProfileRef,
)
from supertag.models import task_event

from .helpers import task_attempt


class Worker:
    def __init__(self, identifier="worker", failure=False):
        self.id = identifier
        self.starts = 0
        self.release = asyncio.Event()
        self.failure = failure

    async def describe(self):
        return WorkerDescriptor(
            profile_capabilities=tuple(
                WorkerProfileCapabilities(
                    profile=profile,
                    capabilities=(Capability("supertag.task-attempt.events", 1),),
                    context_types=(),
                )
                for profile in (WorkerProfileRef("codex", "1"),)
            ),
            id=self.id,
            type="test",
            profiles=(WorkerProfileRef("codex", "1"),),
            capabilities=(Capability("supertag.task-attempt.events", 1),),
            context_types=(),
            max_concurrency=1,
        )

    async def execute(self, attempt, token):
        self.starts += 1
        yield task_event(attempt, "execution.started", workerId=self.id)
        await self.release.wait()
        if self.failure:
            raise ExecutionCleanupError("Unresolved process")
        yield task_event(attempt, "output.delta", text="result")
        yield task_event(attempt, "execution.completed")


def build(path, workers):
    return DurableLocalWorklet(
        LocalWorklet("worklet", "host", tuple(workers)), FileAttemptJournal(path)
    )


@pytest.mark.asyncio
async def test_admission_duplicate_cursor_restart_and_exact_worker(tmp_path):
    first, second = Worker("first"), Worker("second")
    durable = build(tmp_path / "journal", [first, second])
    spec = task_attempt()
    a, b = await asyncio.gather(durable.accept(spec), durable.accept(spec))
    assert a["specDigest"] == b["specDigest"]
    assert a["workerId"] == "first"
    await durable.accept({**spec, "attemptId": "second"})
    await asyncio.sleep(0)
    assert first.starts == second.starts == 1
    with pytest.raises(RuntimeError, match="capacity"):
        await durable.accept({**spec, "attemptId": "third"})
    with pytest.raises(ValueError, match="conflict"):
        await durable.accept({**spec, "taskId": "other"})
    first.release.set()
    second.release.set()
    items = [item async for item in durable.events(spec["attemptId"])]
    assert [item["sequence"] for item in items] == [1, 2, 3]
    assert (await durable.inspect(spec["attemptId"]))["status"] == "completed"
    await durable.shutdown()
    restarted = build(tmp_path / "journal", [first, second])
    assert (await restarted.accept(spec))["status"] == "completed"
    assert first.starts == 1
    assert [item["sequence"] async for item in restarted.events(spec["attemptId"], 1)] == [2, 3]
    await restarted.close()


@pytest.mark.asyncio
async def test_cancel_cleanup_failure_holds_capacity_after_restart(tmp_path):
    worker = Worker(failure=True)
    durable = build(tmp_path / "journal", [worker])
    spec = task_attempt()
    await durable.accept(spec)
    receipt = await durable.cancel(spec["attemptId"], "stop")
    assert receipt["cancellationRequested"]
    worker.release.set()
    _ = [item async for item in durable.events(spec["attemptId"])]
    assert (await durable.inspect(spec["attemptId"]))["status"] == "unknown"
    await durable.close()
    restarted = build(tmp_path / "journal", [worker])
    with pytest.raises(RuntimeError, match="capacity"):
        await restarted.accept({**spec, "attemptId": "another"})
    assert (await restarted.accept(spec))["status"] == "unknown"
    assert worker.starts == 1
    await restarted.close()


@pytest.mark.asyncio
async def test_unfinished_journal_recovers_unknown_without_execution(tmp_path):
    journal = FileAttemptJournal(tmp_path / "journal")
    journal.initialize()
    journal.put(
        {
            "attemptId": "old",
            "taskId": "task",
            "workerId": "worker",
            "status": "running",
            "specDigest": "abc",
            "lastSequence": 0,
        }
    )
    journal.close()
    worker = Worker()
    durable = build(tmp_path / "journal", [worker])
    assert (await durable.inspect("old"))["status"] == "unknown"
    assert worker.starts == 0
    with pytest.raises(RuntimeError, match="capacity"):
        await durable.accept(task_attempt())
    await durable.close()


def test_private_journal_exclusive_lock_and_symlink(tmp_path):
    journal = FileAttemptJournal(tmp_path / "journal")
    journal.initialize()
    try:
        with pytest.raises(BlockingIOError):
            FileAttemptJournal(tmp_path / "journal").initialize()
    finally:
        journal.close()
    link = tmp_path / "link"
    link.symlink_to(tmp_path / "journal")
    with pytest.raises(ValueError):
        FileAttemptJournal(link).initialize()


@pytest.mark.asyncio
async def test_redacts_events_never_persists_spec(tmp_path):
    class SecretWorker(Worker):
        async def execute(self, attempt, token):
            yield task_event(attempt, "execution.started", workerId=self.id)
            yield task_event(attempt, "output.delta", text="PRIVATE_TOKEN", token="PRIVATE_TOKEN")
            yield task_event(attempt, "execution.completed")

    durable = build(tmp_path / "journal", [SecretWorker()])
    spec = {**task_attempt(), "privateToken": "PRIVATE_TOKEN"}
    await durable.accept(spec)
    events = [item async for item in durable.events(spec["attemptId"])]
    assert "PRIVATE_TOKEN" not in json.dumps(events)
    await durable.close()
    assert all(b"PRIVATE_TOKEN" not in p.read_bytes() for p in (tmp_path / "journal").iterdir())


@pytest.mark.asyncio
async def test_failed_accept_persistence_never_starts_and_can_retry(tmp_path, monkeypatch):
    worker = Worker()
    durable = build(tmp_path / "journal", [worker])
    original = durable._journal.put
    monkeypatch.setattr(
        durable._journal, "put", lambda *_: (_ for _ in ()).throw(OSError("disk full"))
    )
    with pytest.raises(OSError, match="disk full"):
        await durable.accept(task_attempt())
    assert worker.starts == 0
    assert await durable.inspect(task_attempt()["attemptId"]) is None
    monkeypatch.setattr(durable._journal, "put", original)
    worker.release.set()
    await durable.accept(task_attempt())
    await durable.shutdown()


@pytest.mark.asyncio
async def test_cancel_releases_capacity_only_after_worker_cleanup(tmp_path):
    worker = Worker()
    durable = build(tmp_path / "journal", [worker])
    spec = task_attempt()
    await durable.accept(spec)
    await durable.cancel(spec["attemptId"])
    with pytest.raises(RuntimeError, match="capacity"):
        await durable.accept({**spec, "attemptId": "next"})
    worker.release.set()
    _ = [item async for item in durable.events(spec["attemptId"])]
    assert (await durable.inspect(spec["attemptId"]))["status"] == "cancelled"
    await durable.accept({**spec, "attemptId": "next"})
    await durable.shutdown()


@pytest.mark.asyncio
async def test_internal_and_surface_admission_requires_capabilities(tmp_path):
    worker = Worker()
    durable = build(tmp_path / "journal", [worker])
    spec = task_attempt()
    with pytest.raises(RuntimeError, match="eligible"):
        await durable.accept({**spec, "coordination": {"scope": "surface"}})
    with pytest.raises(RuntimeError, match="eligible"):
        await durable.accept({**spec, "authorization": {**spec["authorization"], "version": 4}})
    assert worker.starts == 0
    await durable.close()


@pytest.mark.asyncio
async def test_shutdown_serializes_with_paused_admission(tmp_path):
    worker = Worker()
    entered, release = asyncio.Event(), asyncio.Event()

    class PausedWorklet(LocalWorklet):
        async def describe(self):
            entered.set()
            await release.wait()
            return await super().describe()

    durable = DurableLocalWorklet(
        PausedWorklet("worklet", "host", (worker,)), FileAttemptJournal(tmp_path / "journal")
    )
    admission = asyncio.create_task(durable.accept(task_attempt()))
    await entered.wait()
    shutdown = asyncio.create_task(durable.shutdown())
    await asyncio.sleep(0)
    release.set()
    await admission
    worker.release.set()
    await asyncio.wait_for(shutdown, 1)
    assert (await durable.inspect(task_attempt()["attemptId"]))["cancellationRequested"]


@pytest.mark.asyncio
async def test_invalid_spec_never_persists_admission(tmp_path):
    worker = Worker()
    durable = build(tmp_path / "journal", [worker])
    with pytest.raises(RuntimeError, match="version"):
        await durable.accept({**task_attempt(), "version": 1})
    assert not durable._records
    await durable.close()


def test_recovery_failure_releases_journal_lock(tmp_path):
    journal = FileAttemptJournal(tmp_path / "journal")
    journal.initialize()
    journal.database.execute("INSERT INTO attempts VALUES ('broken','invalid json')")
    journal.database.commit()
    journal.close()
    with pytest.raises(json.JSONDecodeError):
        build(tmp_path / "journal", [Worker()])
    reopened = FileAttemptJournal(tmp_path / "journal")
    reopened.initialize()
    reopened.close()


@pytest.mark.asyncio
async def test_profile_requirements_rejected_before_local_or_durable_execution(tmp_path):
    from dataclasses import replace

    from supertag import WorkerProfileCapabilities

    class ScopedWorker(Worker):
        async def describe(self):
            descriptor = await super().describe()
            return replace(
                descriptor,
                profile_capabilities=(
                    WorkerProfileCapabilities(
                        profile=descriptor.profiles[0],
                        capabilities=descriptor.capabilities,
                        context_types=(),
                        harness="codex",
                    ),
                ),
            )

    worker = ScopedWorker()
    durable = build(tmp_path / "requirements", [worker])
    spec = task_attempt()
    spec["execution"] = {"harness": "other"}
    try:
        with pytest.raises(RuntimeError, match="No eligible Worker"):
            await durable.accept(spec)
        with pytest.raises(ValueError):
            await LocalWorklet("local", "host", (worker,))._select(spec)
        assert worker.starts == 0
    finally:
        await durable.close()
