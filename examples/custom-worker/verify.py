"""Run public conformance checks for the Python Worker, Harness, and Environment."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from supertag import (
    CancellationToken,
    EnvironmentLifetime,
    ExecutionConfiguration,
    ExecutionContext,
    InMemorySessionStateStore,
    ProviderConfiguration,
    TaskAttemptSpec,
    WorkerProfile,
    assert_conformance,
    run_environment_conformance,
    run_harness_conformance,
    run_worker_conformance,
)

from environment import ExampleEnvironmentProvider
from harness import ExampleHarness
from worker import ExamplePythonWorker, PROFILE, example_attempt


@dataclass(frozen=True)
class EnvironmentSpec:
    task: TaskAttemptSpec
    profile: WorkerProfile
    plan: object


async def main() -> None:
    attempt_wire = example_attempt()
    attempt = TaskAttemptSpec.from_wire(attempt_wire)
    profile = WorkerProfile(
        ref=PROFILE,
        worker_type="supertag",
        harness=ProviderConfiguration("example-python-harness"),
        execution=ExecutionConfiguration(
            "example-python-local-environment", EnvironmentLifetime("attempt")
        ),
    )
    context = ExecutionContext(
        attempt=attempt,
        profile=profile,
        inputs=(),
        session_state_store=InMemorySessionStateStore(),
    )
    harness = ExampleHarness()
    provider = ExampleEnvironmentProvider()
    plan = await harness.plan(context)
    environment_spec = EnvironmentSpec(attempt, profile, plan.execution)

    assert_conformance(await run_worker_conformance(ExamplePythonWorker(), attempt_wire))
    assert_conformance(await run_environment_conformance(provider, environment_spec, "local"))

    environment = await provider.provision(attempt, profile, plan.execution, CancellationToken())
    await environment.prepare(plan.execution)
    try:
        assert_conformance(
            await run_harness_conformance(
                harness,
                context,
                environment,
                expected_input_kinds=(),
                verify_cancellation=True,
            )
        )
    finally:
        await environment.dispose()

    print("External Python Worker, Harness, and Environment conformance passed")


if __name__ == "__main__":
    asyncio.run(main())
