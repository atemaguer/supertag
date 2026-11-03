from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from supertag import (
    CancellationToken,
    CodexHarness,
    CodexWorker,
    FileSessionStateStore,
    McpHttpToolBinding,
    ToolAuthorization,
    ToolAuthorizationResource,
    ToolCapability,
    ToolInput,
    ToolOperation,
    run_worker_conformance,
)
from supertag.codex import CodexStreamEvent

from .helpers import task_attempt


class FakeTurn:
    def __init__(self) -> None:
        self.interrupted = False

    async def interrupt(self) -> None:
        self.interrupted = True

    async def stream(self) -> AsyncIterator[CodexStreamEvent]:
        yield CodexStreamEvent("output.delta", text="Protocol ")
        yield CodexStreamEvent("output.delta", text="v13")
        yield CodexStreamEvent(
            "output.message",
            text="The Python Worker declares protocol 18 in models.py.",
        )
        yield CodexStreamEvent("execution.completed", status="completed")


class FakeThread:
    def __init__(self, thread_id: str) -> None:
        self.id = thread_id
        self.prompts: list[Any] = []

    async def turn(self, prompt: Any) -> FakeTurn:
        self.prompts.append(prompt)
        return FakeTurn()


class FakeSession:
    def __init__(self) -> None:
        self.started: list[FakeThread] = []
        self.start_options: list[dict[str, Any]] = []
        self.resumed: list[str] = []
        self.closed = False

    async def start_thread(self, **options: Any) -> FakeThread:
        self.start_options.append(options)
        thread = FakeThread(f"thread-{len(self.started) + 1}")
        self.started.append(thread)
        return thread

    async def resume_thread(self, thread_id: str, **_options: Any) -> FakeThread:
        self.resumed.append(thread_id)
        return FakeThread(thread_id)

    async def close(self) -> None:
        self.closed = True


class BlockingTurn(FakeTurn):
    def __init__(self, started: asyncio.Event) -> None:
        super().__init__()
        self.started = started

    async def stream(self) -> AsyncIterator[CodexStreamEvent]:
        self.started.set()
        await asyncio.Event().wait()
        if False:
            yield CodexStreamEvent("execution.completed")


class BlockingThread(FakeThread):
    def __init__(self, started: asyncio.Event) -> None:
        super().__init__("blocking-thread")
        self.turn_instance = BlockingTurn(started)

    async def turn(self, prompt: Any) -> BlockingTurn:
        self.prompts.append(prompt)
        return self.turn_instance


class BlockingSession(FakeSession):
    def __init__(self, started: asyncio.Event) -> None:
        super().__init__()
        self.thread = BlockingThread(started)

    async def start_thread(self, **_options: Any) -> BlockingThread:
        return self.thread


class GitHubToolProvider:
    id = "github-tools"
    scope = "authorization"

    async def resolve(self, _context: Any) -> tuple[ToolInput, ...]:
        return (
            ToolInput(
                id="tool:github",
                required=True,
                capability=ToolCapability(
                    id="github.repository.read",
                    provider="github",
                    operations=(ToolOperation("get_file_contents", "read", ("contents:read",)),),
                    authorization=ToolAuthorization(
                        "github",
                        (ToolAuthorizationResource("github-1", "repository:atemaguer/supertag"),),
                    ),
                ),
                binding=McpHttpToolBinding(
                    "github",
                    "https://api.githubcopilot.com/mcp/",
                    runtime_headers={"Authorization": "Bearer runtime-token"},
                ),
            ),
        )


@pytest.mark.asyncio
async def test_codex_worker_streams_valid_events_and_resumes_native_thread(
    tmp_path: Path,
) -> None:
    session = FakeSession()
    session_states = FileSessionStateStore(tmp_path / "session_states")
    harness = CodexHarness(
        tmp_path,
        session_state_store=session_states,
        client_factory=lambda: session,
    )
    worker = CodexWorker(harness, session_state_store=session_states)

    first = [event async for event in worker.execute(task_attempt(), CancellationToken())]
    assert [event["type"] for event in first] == [
        "execution.started",
        "runtime-inputs.resolved",
        "output.delta",
        "output.delta",
        "output.message",
        "result",
        "session.updated",
        "execution.completed",
    ]
    assert first[4]["message"]["role"] == "teammate"
    session_state = first[6]["sessionState"]

    second_attempt = task_attempt(session_state=session_state)
    second_attempt["taskId"] = "task-2"
    second_attempt["attemptId"] = "attempt-2"
    second = [event async for event in worker.execute(second_attempt, CancellationToken())]
    assert second[-1]["type"] == "execution.completed"
    assert session.resumed == ["thread-1"]

    report = await run_worker_conformance(worker, task_attempt())
    report.assert_passed()
    await worker.close()
    assert session.closed


@pytest.mark.asyncio
async def test_pre_cancelled_codex_worker_ends_in_failure(tmp_path: Path) -> None:
    harness = CodexHarness(tmp_path, client_factory=FakeSession)
    worker = CodexWorker(harness)
    token = CancellationToken()
    token.cancel("test cancellation")
    events = [event async for event in worker.execute(task_attempt(), token)]
    assert [event["type"] for event in events] == ["execution.started", "execution.failed"]
    assert events[-1]["error"]["name"] == "TaskCancelledError"


@pytest.mark.asyncio
async def test_active_codex_turn_is_interrupted_on_cancellation(tmp_path: Path) -> None:
    started = asyncio.Event()
    session = BlockingSession(started)
    harness = CodexHarness(tmp_path, client_factory=lambda: session)
    worker = CodexWorker(harness)
    token = CancellationToken()

    collector = asyncio.create_task(_collect(worker.execute(task_attempt(), token)))
    await asyncio.wait_for(started.wait(), 1)
    token.cancel("Control Plane cancelled the Task")
    events = await asyncio.wait_for(collector, 1)

    assert session.thread.turn_instance.interrupted
    assert events[-1]["type"] == "execution.failed"
    assert events[-1]["error"]["name"] == "TaskCancelledError"


@pytest.mark.asyncio
async def test_codex_worker_fails_closed_for_surface_tools_without_per_call_policy(
    tmp_path: Path,
) -> None:
    session = FakeSession()
    worker = CodexWorker(
        CodexHarness(tmp_path, client_factory=lambda: session),
        runtime_input_providers=(GitHubToolProvider(),),
    )

    events = [event async for event in worker.execute(task_attempt(), CancellationToken())]

    assert [event["type"] for event in events] == ["execution.started", "execution.failed"]
    assert events[-1]["error"]["name"] == "RuntimeError"
    assert "per-call surface resource policy" in events[-1]["error"]["message"]
    assert "ToolInputs are disabled" in events[-1]["error"]["message"]
    assert session.start_options == []


@pytest.mark.asyncio
async def test_codex_worker_projects_runtime_permissions_into_codex_policy(tmp_path: Path) -> None:
    session = FakeSession()
    worker = CodexWorker(
        CodexHarness(
            tmp_path,
            client_factory=lambda: session,
            session_state_store=FileSessionStateStore(tmp_path / "sessions"),
        )
    )
    attempt = task_attempt()
    attempt["authorization"]["runtimeActions"] = [
        "browser:use",
        "commands:execute",
        "files:write",
        "web:fetch",
        "web:search",
    ]

    events = [event async for event in worker.execute(attempt, CancellationToken())]

    assert events[-1]["type"] == "execution.completed"
    assert session.start_options[0]["config"] == {
        "features": {
            "shell_tool": True,
            "unified_exec": True,
            "browser_use": True,
            "browser_use_external": True,
            "computer_use": True,
            "in_app_browser": True,
        },
        "web_search": "live",
        "sandbox_workspace_write": {"network_access": True},
        "_supertag_files_write": True,
    }


@pytest.mark.asyncio
async def test_codex_session_state_cannot_cross_session_boundary(tmp_path: Path) -> None:
    session = FakeSession()
    session_states = FileSessionStateStore(tmp_path / "session_states")
    worker = CodexWorker(
        CodexHarness(tmp_path, session_state_store=session_states, client_factory=lambda: session),
        session_state_store=session_states,
    )
    first = [event async for event in worker.execute(task_attempt(), CancellationToken())]
    session_state = next(
        event["sessionState"] for event in first if event["type"] == "session.updated"
    )
    second_attempt = task_attempt(session_state=session_state)
    second_attempt["taskId"] = "task-2"
    second_attempt["attemptId"] = "attempt-2"
    second_attempt["session"]["id"] = "different-session"

    events = [event async for event in worker.execute(second_attempt, CancellationToken())]

    assert events[-1]["type"] == "execution.completed"
    assert session.resumed == []
    assert len(session.started) == 2


async def _collect(stream: AsyncIterator[dict[str, Any]]) -> list[dict[str, Any]]:
    return [event async for event in stream]
