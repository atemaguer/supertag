from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any, AsyncIterator

import pytest

from supertag import (
    CancellationToken,
    FileSessionStateStore,
    McpHttpToolBinding,
    OpenAIAgentsHarness,
    OpenAIAgentsWorker,
    ToolAuthorization,
    ToolAuthorizationResource,
    ToolCapability,
    ToolInput,
    ToolOperation,
    run_worker_conformance,
)
from supertag.openai_agents import OpenAIAgentsStreamEvent

from .helpers import task_attempt


class FakeRun:
    def __init__(
        self,
        prior_items: list[dict[str, Any]],
        *,
        started: asyncio.Event | None = None,
    ) -> None:
        self.cancelled = False
        self._started = started
        self._final_output = "The protocol is declared in models.py and currently equals 18."
        self._session_items = [
            *prior_items,
            {"role": "user", "content": "Where is the protocol declared?"},
            {"role": "assistant", "content": self._final_output},
        ]

    @property
    def final_output(self) -> str:
        return self._final_output

    @property
    def session_items(self) -> list[dict[str, Any]]:
        return self._session_items

    async def cancel(self) -> None:
        self.cancelled = True

    async def stream(self) -> AsyncIterator[OpenAIAgentsStreamEvent]:
        if self._started is not None:
            self._started.set()
            await asyncio.Event().wait()
        yield OpenAIAgentsStreamEvent("output.delta", "The protocol ")
        yield OpenAIAgentsStreamEvent("output.delta", "equals 13.")


class FakeRunner:
    def __init__(self, *, started: asyncio.Event | None = None) -> None:
        self.started = started
        self.calls: list[dict[str, Any]] = []
        self.runs: list[FakeRun] = []

    def start(self, **options: Any) -> FakeRun:
        self.calls.append(options)
        run = FakeRun(options["session_items"], started=self.started)
        self.runs.append(run)
        return run


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


def agents_attempt(**options: Any) -> dict[str, Any]:
    return task_attempt(profile_id="openai-agents", **options)


@pytest.mark.asyncio
async def test_agents_worker_streams_and_resumes_session_items(tmp_path: Path) -> None:
    runner = FakeRunner()
    session_states = FileSessionStateStore(tmp_path / "session_states")
    harness = OpenAIAgentsHarness(
        tmp_path,
        session_state_store=session_states,
        runner=runner,
    )
    worker = OpenAIAgentsWorker(harness, session_state_store=session_states)

    first = [event async for event in worker.execute(agents_attempt(), CancellationToken())]
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

    follow_up = agents_attempt(session_state=session_state)
    follow_up["taskId"] = "task-2"
    follow_up["attemptId"] = "attempt-2"
    second = [event async for event in worker.execute(follow_up, CancellationToken())]

    assert second[-1]["type"] == "execution.completed"
    assert runner.calls[0]["session_items"] == []
    assert runner.calls[1]["session_items"] == runner.runs[0].session_items
    report = await run_worker_conformance(worker, agents_attempt())
    report.assert_passed()


@pytest.mark.asyncio
async def test_agents_run_is_cancelled_with_the_task(tmp_path: Path) -> None:
    started = asyncio.Event()
    runner = FakeRunner(started=started)
    worker = OpenAIAgentsWorker(OpenAIAgentsHarness(tmp_path, runner=runner))
    cancellation = CancellationToken()

    collector = asyncio.create_task(_collect(worker.execute(agents_attempt(), cancellation)))
    await asyncio.wait_for(started.wait(), 1)
    cancellation.cancel("Control Plane cancelled the Task")
    events = await asyncio.wait_for(collector, 1)

    assert runner.runs[0].cancelled
    assert events[-1]["type"] == "execution.failed"
    assert events[-1]["error"]["name"] == "TaskCancelledError"


@pytest.mark.asyncio
async def test_agents_worker_fails_closed_for_unadapted_surface_tools(tmp_path: Path) -> None:
    runner = FakeRunner()
    worker = OpenAIAgentsWorker(
        OpenAIAgentsHarness(tmp_path, runner=runner),
        runtime_input_providers=(GitHubToolProvider(),),
    )

    events = [event async for event in worker.execute(agents_attempt(), CancellationToken())]

    assert [event["type"] for event in events] == ["execution.started", "execution.failed"]
    assert "does not support required tool input" in events[-1]["error"]["message"]
    assert runner.calls == []


@pytest.mark.asyncio
async def test_agents_session_state_cannot_cross_session_boundary(tmp_path: Path) -> None:
    runner = FakeRunner()
    session_states = FileSessionStateStore(tmp_path / "session_states")
    worker = OpenAIAgentsWorker(
        OpenAIAgentsHarness(tmp_path, session_state_store=session_states, runner=runner),
        session_state_store=session_states,
    )
    first = [event async for event in worker.execute(agents_attempt(), CancellationToken())]
    session_state = next(
        event["sessionState"] for event in first if event["type"] == "session.updated"
    )
    second_attempt = agents_attempt(session_state=session_state)
    second_attempt["taskId"] = "task-2"
    second_attempt["attemptId"] = "attempt-2"
    second_attempt["session"]["id"] = "different-session"

    events = [event async for event in worker.execute(second_attempt, CancellationToken())]

    assert events[-1]["type"] == "execution.completed"
    assert runner.calls[1]["session_items"] == []


@pytest.mark.asyncio
async def test_official_agents_adapter_uses_the_installed_sdk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # This test uses a fake Runner; SDK import must not depend on host proxy extras.
    for name in (
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
    ):
        monkeypatch.delenv(name, raising=False)
    from agents import Runner

    captured: dict[str, Any] = {}

    class InstalledSdkResult:
        final_output = "The installed OpenAI Agents SDK completed the Task."

        async def stream_events(self) -> AsyncIterator[Any]:
            yield SimpleNamespace(
                type="raw_response_event",
                data=SimpleNamespace(type="response.output_text.delta", delta="Installed SDK "),
            )

        def cancel(self) -> None:
            captured["cancelled"] = True

    def run_streamed(agent: Any, **options: Any) -> InstalledSdkResult:
        captured["agent"] = agent
        captured["options"] = options
        return InstalledSdkResult()

    monkeypatch.setattr(Runner, "run_streamed", staticmethod(run_streamed))
    worker = OpenAIAgentsWorker(
        OpenAIAgentsHarness(
            tmp_path,
            session_state_store=FileSessionStateStore(tmp_path / "sessions"),
        )
    )

    events = [event async for event in worker.execute(agents_attempt(), CancellationToken())]

    assert events[-1]["type"] == "execution.completed"
    assert captured["agent"].name == "Engineering"
    assert len(captured["agent"].tools) == 1
    assert captured["options"]["max_turns"] == 10
    assert captured["options"]["session"].session_id == "supertag-run"
    assert captured["options"]["run_config"].tracing_disabled is True


async def _collect(stream: AsyncIterator[dict[str, Any]]) -> list[dict[str, Any]]:
    return [event async for event in stream]
