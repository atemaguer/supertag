"""A minimal custom Harness that reads an approved file from its Environment."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from supertag import (
    CancellationToken,
    EnvironmentPlan,
    HarnessCapabilities,
    HarnessEnvironmentAccesses,
    HarnessPlan,
)
from supertag.environment import StagedFile
from supertag.worker import default_task_result


class ExampleHarness:
    id = "example-python-harness"

    async def describe(self) -> HarnessCapabilities:
        return HarnessCapabilities(
            id=self.id,
            version="1",
            input_kinds=(),
            streaming=False,
            cancellation=True,
            session_persistence="none",
            runtime_placements=("local",),
        )

    async def plan(self, context: Any) -> HarnessPlan:
        messages = context.attempt.input.get("messages", [])
        requester_message = next(
            (item for item in reversed(messages) if item.get("role") == "requester"), None
        )
        if requester_message is None:
            raise ValueError("Task has no requester message")
        return HarnessPlan(
            execution=EnvironmentPlan(
                files=(StagedFile("request.txt", str(requester_message.get("text", ""))),),
                network={"mode": "none"},
            )
        )

    async def start(
        self, plan: HarnessPlan, environments: HarnessEnvironmentAccesses, context: Any
    ) -> ExampleExecution:
        del plan, context
        return ExampleExecution(environments.execution)


class ExampleExecution:
    def __init__(self, environment: Any) -> None:
        self._environment = environment

    async def run(self, cancellation: CancellationToken) -> AsyncIterator[dict[str, Any]]:
        if cancellation.cancelled:
            return
        request = await self._environment.read("request.txt")
        text = f"Example Python Harness received: {request}"
        yield {"type": "output.message", "text": text}
        yield {"type": "result", "result": default_task_result(text)}

    async def session_state(self) -> None:
        return None

    async def close(self) -> None:
        return None
