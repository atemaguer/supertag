"""Minimal custom SuperTag Worker written as a normal Python application."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

from supertag import (
    CancellationToken,
    Capability,
    WorkerDescriptor,
    WorkerProfileCapabilities,
    WorkerProfileRef,
    assert_conformance,
    run_worker_conformance,
)
from supertag.worker import default_task_result, task_event

WORKER_ID = "example-python-worker"
PROFILE = WorkerProfileRef("example-python", "1")


class ExamplePythonWorker:
    async def describe(self) -> WorkerDescriptor:
        return WorkerDescriptor(
            profile_capabilities=tuple(
                WorkerProfileCapabilities(
                    profile=profile,
                    capabilities=(Capability("supertag.task-attempt.events", 1),),
                    context_types=(),
                )
                for profile in (PROFILE,)
            ),
            id=WORKER_ID,
            type="example-python",
            profiles=(PROFILE,),
            capabilities=(Capability("supertag.task-attempt.events", 1),),
            context_types=(),
        )

    async def execute(
        self, attempt: dict[str, Any], cancellation: CancellationToken
    ) -> AsyncIterator[dict[str, Any]]:
        yield task_event(attempt, "execution.started", workerId=WORKER_ID)

        profile = attempt.get("workerProfile")
        if profile != PROFILE.to_wire():
            yield task_event(
                attempt,
                "execution.failed",
                error={
                    "name": "UnsupportedProfile",
                    "message": "Worker Profile is not supported",
                },
            )
            return

        cancellation.raise_if_cancelled()
        messages = attempt.get("input", {}).get("messages", [])
        text = f"Example Python Worker received: {messages[-1].get('text', '') if messages else ''}"
        yield task_event(
            attempt,
            "output.message",
            message={"role": "teammate", "text": text},
        )
        yield task_event(attempt, "result", result=default_task_result(text))
        yield task_event(attempt, "execution.completed")


def example_attempt() -> dict[str, Any]:
    captured_at = "2026-08-15T00:00:00.000Z"
    profile = PROFILE.to_wire()
    return {
        "version": 2,
        "taskId": "example-python-task",
        "attemptId": "example-python-attempt",
        "tag": {"id": "example-tag", "name": "Example"},
        "input": {
            "origin": {
                "surface": "example",
                "accountId": "example-account",
                "scope": "channel:example",
                "sessionKey": "example-session",
                "occurredAt": captured_at,
            },
            "messages": [
                {"id": "message-1", "role": "requester", "text": "Hello from Python"}
            ],
        },
        "authorization": {
            "version": 5,
            "capturedAt": captured_at,
            "tag": {"id": "example-tag", "name": "Example"},
            "origin": {
                "tagRouteId": "route-1",
                "surfaceAccountId": "example-account",
                "provider": "example",
                "scope": "channel:example",
            },
            "requester": {"id": "user-1", "kind": "user"},
            "permissionSets": [],
            "resources": [],
            "runtimeActions": [],
        },
        "contextPlan": {"version": 7, "capturedAt": captured_at, "sets": []},
        "workspacePlan": {"version": 1, "status": "none"},
        "workerProfile": profile,
        "execution": {},
        "session": {"id": "example-session", "history": []},
    }


async def main() -> None:
    report = await run_worker_conformance(ExamplePythonWorker(), example_attempt())
    assert_conformance(report)
    print("External Python Worker conformance passed")


if __name__ == "__main__":
    asyncio.run(main())
