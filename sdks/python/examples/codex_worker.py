"""Example custom Python Worker application using the SuperTag Codex Harness."""

from __future__ import annotations

import asyncio
import os
import re
import signal
from contextlib import suppress
from pathlib import Path

from supertag import (
    DurableLocalWorklet,
    FileAttemptJournal,
    LocalWorklet,
    WorkerProfileRef,
    WorkletConnection,
)
from supertag.codex import CodexHarness, CodexWorker


def required_environment(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


async def run() -> None:
    worklet_id = os.getenv("SUPERTAG_WORKLET_ID", "python-codex-worklet")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", worklet_id):
        raise ValueError("SUPERTAG_WORKLET_ID must contain only letters, digits, _ or -")
    state_dir = Path(os.getenv("SUPERTAG_STATE_DIR", str(Path.home() / ".supertag")))
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    journals = state_dir / "python-worklets"
    journals.mkdir(mode=0o700, exist_ok=True)
    worker_id = os.getenv("SUPERTAG_WORKER_ID", "python-codex").strip()
    harness = CodexHarness(
        Path(os.getenv("SUPERTAG_WORKER_WORKSPACE", str(Path.cwd()))).resolve(),
        model=os.getenv("SUPERTAG_CODEX_MODEL") or None,
        timeout_seconds=float(os.getenv("SUPERTAG_WORKER_TIMEOUT_SECONDS", "300")),
    )
    worker = CodexWorker(
        harness,
        worker_id=worker_id,
        profile=WorkerProfileRef(
            os.getenv("SUPERTAG_WORKER_PROFILE", "codex"),
            os.getenv("SUPERTAG_WORKER_PROFILE_REVISION", "1"),
        ),
        max_concurrency=int(os.getenv("SUPERTAG_WORKER_MAX_CONCURRENCY", "1")),
    )
    worklet = LocalWorklet(
        worklet_id,
        os.getenv("SUPERTAG_WORKER_HOST_ID", "python-codex-host"),
        (worker,),
    )
    worklet = DurableLocalWorklet(
        worklet,
        FileAttemptJournal(journals / worklet_id),
    )
    connection = WorkletConnection(
        os.getenv("SUPERTAG_CONTROL_PLANE_URL", "http://127.0.0.1:3434"),
        required_environment("SUPERTAG_WORKLET_TOKEN"),
        worklet,
    )
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        with suppress(NotImplementedError):
            loop.add_signal_handler(signum, stopped.set)
    runner = asyncio.create_task(connection.run())
    stop_waiter = asyncio.create_task(stopped.wait())
    try:
        done, _pending = await asyncio.wait(
            {runner, stop_waiter}, return_when=asyncio.FIRST_COMPLETED
        )
        if runner in done:
            await runner
    finally:
        stop_waiter.cancel()
        await connection.stop()
        await worklet.shutdown()
        await worker.close()


if __name__ == "__main__":
    asyncio.run(run())
