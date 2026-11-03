"""Deterministic external Python Harness + custom Environment transport fixture."""

import asyncio
import os
import signal
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "examples/custom-worker"))
from environment import ExampleEnvironmentProvider
from harness import ExampleHarness
from worker import PROFILE

from supertag import (
    DurableLocalWorklet,
    EnvironmentLifetime,
    ExecutionConfiguration,
    FileAttemptJournal,
    LocalWorklet,
    ProviderConfiguration,
    WorkerOptions,
    WorkerProfile,
    WorkletConnection,
    create_worker,
)


class ControlledHarness(ExampleHarness):
    async def start(self, plan, environment, context):
        execution = await super().start(plan, environment, context)
        gate = os.getenv("SUPERTAG_TEST_GATE")
        starts = os.getenv("SUPERTAG_TEST_STARTS")

        class ControlledExecution:
            async def run(self, cancellation):
                if starts:
                    with open(starts, "a") as output:
                        output.write(context.attempt.attempt_id + "\n")
                while gate and not Path(gate).exists():
                    await asyncio.sleep(0.01)
                async for event in execution.run(cancellation):
                    yield event

            async def session_state(self):
                return await execution.session_state()

            async def close(self):
                await execution.close()

        return ControlledExecution()


async def main() -> None:
    profile = WorkerProfile(
        ref=PROFILE,
        worker_type="supertag",
        harness=ProviderConfiguration("example-python-harness"),
        execution=ExecutionConfiguration(
            "example-python-local-environment", EnvironmentLifetime("attempt")
        ),
    )
    worker = create_worker(
        WorkerOptions(
            id="external-python",
            profiles=(profile,),
            harnesses=(ControlledHarness(),),
            environments=(ExampleEnvironmentProvider(),),
        )
    )
    worklet = LocalWorklet("python-custom-worklet", "python-custom-host", (worker,))
    temporary = TemporaryDirectory(prefix="python-worklet-")
    journal = os.getenv("SUPERTAG_TEST_JOURNAL", str(Path(temporary.name) / "journal"))
    worklet = DurableLocalWorklet(worklet, FileAttemptJournal(journal))
    connection = WorkletConnection(
        os.environ["SUPERTAG_CONTROL_PLANE_URL"],
        os.environ["SUPERTAG_WORKLET_TOKEN"],
        worklet,
    )
    stopped = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stopped.set)
    runner = asyncio.create_task(connection.run())
    waiter = asyncio.create_task(stopped.wait())
    try:
        done, _ = await asyncio.wait((runner, waiter), return_when=asyncio.FIRST_COMPLETED)
        if runner in done:
            await runner
    finally:
        waiter.cancel()
        await connection.stop()
        await worklet.shutdown()
        temporary.cleanup()


asyncio.run(main())
