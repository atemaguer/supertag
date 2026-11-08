from __future__ import annotations

import json
from typing import Any, AsyncIterator, Mapping

import pytest

from supertag.environment import StagedFile
from supertag.harness import HarnessEnvironmentAccesses
from supertag.models import (
    CancellationToken,
    Capability,
    EnvironmentLifetime,
    EnvironmentPlan,
    ExecutionConfiguration,
    ExecutionContext,
    HarnessCapabilities,
    HarnessPlan,
    InstructionInput,
    ProviderConfiguration,
    ResolutionContext,
    ResourceRef,
    SessionStateRef,
    SkillInput,
    WorkerProfile,
    WorkerProfileRef,
)
from supertag.runtime import RuntimeInputPipeline, WorkerOptions, create_worker
from supertag.tools import (
    McpHttpToolBinding,
    ToolAuthorization,
    ToolAuthorizationResource,
    ToolCapability,
    ToolInput,
    ToolOperation,
)

from .helpers import task_attempt


class FakeInputProvider:
    id = "fake-input-provider"
    scope = "context"

    async def resolve(
        self, _context: ResolutionContext
    ) -> tuple[InstructionInput | SkillInput, ...]:
        return (
            InstructionInput(id="instructions", content="Use evidence."),
            SkillInput(
                id="optional-skill",
                required=False,
                source_item_key="skill:one",
                source=ResourceRef(uri="file:///skills/one"),
            ),
        )


class FakeEnvironment:
    id = "environment-1"
    placement = "local"

    def __init__(self) -> None:
        self.prepared: EnvironmentPlan | None = None
        self.disposed: list[str] = []

    async def prepare(self, plan: EnvironmentPlan) -> None:
        self.prepared = plan

    async def dispose(self, reason: str) -> None:
        self.disposed.append(reason)


class FakeEnvironmentProvider:
    id = "local"
    capabilities = (Capability("supertag.execution.local-process", 1),)

    def __init__(self) -> None:
        self.environment = FakeEnvironment()

    async def provision(
        self,
        _task: Any,
        _profile: WorkerProfile,
        _plan: EnvironmentPlan,
        _cancellation: CancellationToken,
    ) -> FakeEnvironment:
        return self.environment

    async def provision_runtime(
        self,
        _task: Any,
        _profile: WorkerProfile,
        _plan: EnvironmentPlan,
        _cancellation: CancellationToken,
    ) -> FakeEnvironment:
        return self.environment


class FakeExecution:
    def __init__(self, session_state: SessionStateRef | None = None) -> None:
        self.closed = False
        self._session_state = session_state

    async def run(self, _cancellation: CancellationToken) -> AsyncIterator[Mapping[str, Any]]:
        yield {"type": "output.delta", "text": "hello"}
        yield {
            "type": "progress.updated",
            "progress": {
                "summary": "Working through the request",
                "items": [{"id": "inspect", "text": "Inspecting the code", "status": "active"}],
            },
        }
        yield {"type": "output.message", "text": "hello world"}

    async def session_state(self) -> SessionStateRef | None:
        return self._session_state

    async def close(self) -> None:
        self.closed = True


class FakeHarness:
    id = "fake"

    def __init__(self, session_state: SessionStateRef | None = None) -> None:
        self.execution = FakeExecution(session_state)
        self.context: ExecutionContext | None = None

    async def describe(self) -> HarnessCapabilities:
        return HarnessCapabilities(
            id=self.id,
            version="1.2.3",
            input_kinds=("instruction",),
            streaming=True,
            cancellation=True,
            session_persistence="native",
            runtime_placements=("local",),
        )

    async def plan(self, context: ExecutionContext) -> HarnessPlan:
        self.context = context
        return HarnessPlan(runtime=EnvironmentPlan(network={"mode": "none"}))

    async def start(
        self,
        _plan: HarnessPlan,
        _environments: HarnessEnvironmentAccesses,
        _context: ExecutionContext,
    ) -> FakeExecution:
        return self.execution


class RecordingPromotionHook:
    def __init__(self) -> None:
        self.values: list[tuple[str, str]] = []

    async def promote(self, task: Any, session_state: SessionStateRef) -> None:
        self.values.append((task.task_id, session_state.id))


class SecretToolProvider:
    id = "secret-tool-provider"
    scope = "authorization"

    async def resolve(self, _context: ResolutionContext) -> tuple[ToolInput, ...]:
        return (
            ToolInput(
                id="tool:secret-test",
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
                    "https://example.invalid/mcp",
                    runtime_headers={"Authorization": "Bearer header-secret-sentinel"},
                    runtime_environment={"GITHUB_TOKEN": "environment-secret-sentinel"},
                ),
            ),
        )


class SecretEchoExecution:
    async def run(self, _cancellation: CancellationToken) -> AsyncIterator[Mapping[str, Any]]:
        yield {
            "type": "approval.requested",
            "request": {
                "id": "approval-1",
                "description": "Approve header-secret-sentinel",
                "data": {
                    "authorization": "Bearer header-secret-sentinel",
                    "environment": ["environment-secret-sentinel"],
                },
            },
        }
        yield {
            "type": "output.message",
            "text": "observed environment-secret-sentinel session-only-secret-sentinel",
        }
        raise RuntimeError("failed with header-secret-sentinel")

    async def session_state(self) -> None:
        return None

    async def close(self) -> None:
        pass


class SecretEchoHarness:
    id = "secret-echo"

    async def describe(self) -> HarnessCapabilities:
        return HarnessCapabilities(
            id=self.id,
            version="1",
            input_kinds=("tool",),
            streaming=True,
            cancellation=True,
            session_persistence="none",
            runtime_placements=("local",),
        )

    async def plan(self, _context: ExecutionContext) -> HarnessPlan:
        return HarnessPlan()

    async def start(
        self,
        _plan: HarnessPlan,
        _environments: HarnessEnvironmentAccesses,
        _context: ExecutionContext,
    ) -> SecretEchoExecution:
        return SecretEchoExecution()


def test_input_pipeline_requires_unique_ids_and_known_scopes() -> None:
    first = FakeInputProvider()
    second = FakeInputProvider()
    with pytest.raises(ValueError, match="ids must be unique"):
        RuntimeInputPipeline((first, second))
    second.id = "other"
    second.scope = "unknown"
    with pytest.raises(ValueError, match="scope is not recognized"):
        RuntimeInputPipeline((first, second))


def profile() -> WorkerProfile:
    return WorkerProfile(
        ref=WorkerProfileRef("runtime", "1"),
        worker_type="runtime",
        harness=ProviderConfiguration("fake"),
        execution=ExecutionConfiguration("local", EnvironmentLifetime("attempt")),
    )


@pytest.mark.asyncio
async def test_created_worker_orchestrates_and_normalizes_lifecycle() -> None:
    session_state = SessionStateRef(
        uri="supertag://session_state/one", id="session_state-1", format="fake.v1"
    )
    harness = FakeHarness(session_state)
    provider = FakeEnvironmentProvider()
    hook = RecordingPromotionHook()
    worker = create_worker(
        WorkerOptions(
            id="python-worker",
            profiles=(profile(),),
            harnesses=(harness,),
            environments=(provider,),
            runtime_input_providers=(FakeInputProvider(),),
            session_state_promotion_hooks=(hook,),
        )
    )

    attempt = task_attempt(profile_id="runtime")
    attempt["authorization"]["roles"] = [
        {
            "assignmentId": "assignment-reviewer",
            "assignmentRevision": 2,
            "role": {
                "id": "role-reviewer",
                "name": "Security Reviewer",
                "purpose": "Review customer data changes.",
                "instructions": "State unresolved risk.",
                "revision": 4,
                "contextSetIds": [],
                "permissionSetIds": [],
            },
        },
    ]
    events = [event async for event in worker.execute(attempt, CancellationToken())]

    assert [event["type"] for event in events] == [
        "execution.started",
        "runtime-inputs.resolved",
        "output.delta",
        "progress.updated",
        "output.message",
        "result",
        "session.updated",
        "execution.completed",
    ]
    assert events[3]["progress"]["items"][0]["status"] == "active"
    assert events[4]["message"] == {"role": "teammate", "text": "hello world"}
    assert events[5]["result"]["summary"] == "hello world"
    manifest = events[1]["manifest"]
    assert manifest["workerProfile"] == {"id": "runtime", "revision": "1"}
    assert manifest["omitted"] == [
        {
            "id": "optional-skill",
            "kind": "skill",
            "sourceItemKey": "skill:one",
            "resource": None,
            "reason": "unsupported-by-harness",
        }
    ]
    assert harness.context is not None
    instructions = harness.context.by_kind("instruction")
    assert [item.id for item in instructions] == [
        "role:role-reviewer:4",
        "instructions",
    ]
    assert instructions[0].content == (
        "You are acting in the Security Reviewer Role.\n"
        "Purpose: Review customer data changes.\n"
        "State unresolved risk."
    )
    assert hook.values == [("task-1", "session_state-1")]
    assert provider.environment.disposed == ["completed"]
    assert harness.execution.closed


@pytest.mark.asyncio
async def test_created_worker_describes_merged_capabilities() -> None:
    worker = create_worker(
        WorkerOptions(
            id="python-worker",
            profiles=(profile(),),
            harnesses=(FakeHarness(),),
            environments=(FakeEnvironmentProvider(),),
            max_concurrency=3,
        )
    )

    descriptor = await worker.describe()

    assert descriptor.type == "supertag"
    assert descriptor.max_concurrency == 3
    assert {(item.id, item.version) for item in descriptor.capabilities} == {
        ("supertag.task-attempt.events", 1),
        ("supertag.task-attempt.cancellation", 1),
        ("supertag.execution.local-process", 1),
    }


@pytest.mark.asyncio
async def test_created_worker_fails_before_provision_when_cancelled() -> None:
    provider = FakeEnvironmentProvider()
    worker = create_worker(
        WorkerOptions(
            id="python-worker",
            profiles=(profile(),),
            harnesses=(FakeHarness(),),
            environments=(provider,),
        )
    )
    cancellation = CancellationToken()
    cancellation.cancel("requester cancelled")

    events = [
        event async for event in worker.execute(task_attempt(profile_id="runtime"), cancellation)
    ]

    assert [event["type"] for event in events] == ["execution.started", "execution.failed"]
    assert events[-1]["error"] == {
        "name": "TaskCancelledError",
        "message": "requester cancelled",
    }
    assert provider.environment.prepared is None


@pytest.mark.asyncio
async def test_session_history_is_available_as_canonical_replay_fallback() -> None:
    harness = FakeHarness()
    worker = create_worker(
        WorkerOptions(
            id="python-worker",
            profiles=(profile(),),
            harnesses=(harness,),
            environments=(FakeEnvironmentProvider(),),
        )
    )
    attempt = task_attempt(profile_id="runtime")
    attempt["session"]["history"] = [{"taskId": "prior-task", "summary": "Prior result"}]

    events = [event async for event in worker.execute(attempt, CancellationToken())]

    assert events[-1]["type"] == "execution.completed"
    assert harness.context is not None
    assert harness.context.continuity is not None
    replay = harness.context.continuity.replay_input
    assert replay is not None
    assert replay.kind == "history"
    assert '"taskId":"prior-task"' in replay.content


@pytest.mark.asyncio
async def test_worker_redacts_resolved_tool_secrets_from_events_and_errors() -> None:
    provider = FakeEnvironmentProvider()
    redaction_profile = WorkerProfile(
        ref=WorkerProfileRef("redaction", "1"),
        worker_type="runtime",
        harness=ProviderConfiguration("secret-echo"),
        execution=ExecutionConfiguration("local", EnvironmentLifetime("attempt")),
    )
    worker = create_worker(
        WorkerOptions(
            id="redacting-worker",
            profiles=(redaction_profile,),
            harnesses=(SecretEchoHarness(),),
            environments=(provider,),
            runtime_input_providers=(SecretToolProvider(),),
        )
    )

    attempt = task_attempt(profile_id="redaction")
    attempt["session"]["persistence"] = {
        "controlPlaneUrl": "https://control-plane.example",
        "token": "session-only-secret-sentinel",
    }
    events = [event async for event in worker.execute(attempt, CancellationToken())]

    serialized = json.dumps(events)
    assert "header-secret-sentinel" not in serialized
    assert "environment-secret-sentinel" not in serialized
    assert "session-only-secret-sentinel" not in serialized
    assert "Bearer header-secret-sentinel" not in serialized
    assert serialized.count("[REDACTED]") >= 4
    assert events[-1]["type"] == "execution.failed"
    assert events[-1]["error"] == {
        "name": "RuntimeError",
        "message": "failed with [REDACTED]",
    }


@pytest.mark.asyncio
async def test_cancellation_interrupts_inflight_harness_and_terminal_follows_cleanup() -> None:
    import asyncio

    started = asyncio.Event()

    class BlockingExecution(FakeExecution):
        async def run(self, _cancellation: CancellationToken) -> AsyncIterator[Mapping[str, Any]]:
            started.set()
            await asyncio.sleep(60)
            yield {"type": "output.message", "text": "late"}

    harness = FakeHarness()
    harness.execution = BlockingExecution()
    provider = FakeEnvironmentProvider()
    worker = create_worker(
        WorkerOptions(
            id="supervised", profiles=(profile(),), harnesses=(harness,), environments=(provider,)
        )
    )
    token = CancellationToken()

    async def collect() -> list[dict[str, Any]]:
        events = []
        async for event in worker.execute(task_attempt(profile_id="runtime"), token):
            if event["type"] == "execution.failed":
                assert harness.execution.closed
                assert provider.environment.disposed == ["cancelled"]
            events.append(event)
        return events

    running = asyncio.create_task(collect())
    await asyncio.wait_for(started.wait(), 1)
    token.cancel("inflight")
    events = await asyncio.wait_for(running, 2)
    assert events[-1]["type"] == "execution.failed"
    assert not any(event["type"] == "output.message" for event in events)


@pytest.mark.asyncio
async def test_cleanup_failure_never_emits_terminal_receipt() -> None:
    from supertag import ExecutionCleanupError

    class UnconfirmedEnvironment(FakeEnvironment):
        async def dispose(self, reason: str) -> None:
            raise RuntimeError("process ownership unresolved")

    provider = FakeEnvironmentProvider()
    provider.environment = UnconfirmedEnvironment()
    worker = create_worker(
        WorkerOptions(
            id="test", profiles=(profile(),), harnesses=(FakeHarness(),), environments=(provider,)
        )
    )
    events = []
    with pytest.raises(ExecutionCleanupError, match="ownership unresolved"):
        async for event in worker.execute(task_attempt(profile_id="runtime"), CancellationToken()):
            events.append(event)
    assert not any(event["type"] in ("execution.failed", "execution.completed") for event in events)
    with pytest.raises(ExecutionCleanupError):
        _ = [
            event
            async for event in worker.execute(
                task_attempt(profile_id="runtime"), CancellationToken()
            )
        ]


@pytest.mark.asyncio
async def test_required_environment_capability_rejected_before_provision() -> None:
    from dataclasses import replace

    class StreamingHarness(FakeHarness):
        async def describe(self) -> HarnessCapabilities:
            return replace(
                await super().describe(),
                required_runtime_capabilities=(Capability("supertag.process-output-streaming", 1),),
            )

    provider = FakeEnvironmentProvider()
    worker = create_worker(
        WorkerOptions(
            id="test",
            profiles=(profile(),),
            harnesses=(StreamingHarness(),),
            environments=(provider,),
        )
    )
    events = [
        event
        async for event in worker.execute(task_attempt(profile_id="runtime"), CancellationToken())
    ]
    assert events[-1]["type"] == "execution.failed"
    assert provider.environment.prepared is None
    assert not provider.environment.disposed


@pytest.mark.asyncio
async def test_split_runtime_and_execution_environments_are_prepared_and_reported() -> None:
    from dataclasses import replace

    class SplitHarness(FakeHarness):
        def __init__(self) -> None:
            super().__init__()
            self.environments: HarnessEnvironmentAccesses | None = None

        async def describe(self) -> HarnessCapabilities:
            return replace(await super().describe(), split_execution=True)

        async def plan(self, context: ExecutionContext) -> HarnessPlan:
            self.context = context
            return HarnessPlan(
                runtime=EnvironmentPlan(
                    files=(StagedFile("private/auth.json", "runtime-only"),),
                    network={"mode": "allowlist", "allowed_hosts": ("api.example.test",)},
                ),
                execution=EnvironmentPlan(
                    files=(StagedFile("workspace/input.txt", "execution-only"),),
                    network={"mode": "none"},
                ),
            )

        async def start(
            self,
            _plan: HarnessPlan,
            environments: HarnessEnvironmentAccesses,
            _context: ExecutionContext,
        ) -> FakeExecution:
            self.environments = environments
            return self.execution

    runtime_provider = FakeEnvironmentProvider()
    runtime_provider.id = "runtime"
    runtime_provider.environment.id = "runtime-environment"
    execution_provider = FakeEnvironmentProvider()
    execution_provider.id = "execution"
    execution_provider.environment.id = "execution-environment"
    harness = SplitHarness()
    split_profile = WorkerProfile(
        ref=WorkerProfileRef("runtime", "1"),
        worker_type="runtime",
        harness=ProviderConfiguration("fake"),
        runtime=ExecutionConfiguration("runtime", EnvironmentLifetime("attempt")),
        execution=ExecutionConfiguration("execution", EnvironmentLifetime("attempt")),
    )
    worker = create_worker(
        WorkerOptions(
            id="test",
            profiles=(split_profile,),
            harnesses=(harness,),
            harness_runtimes=(runtime_provider,),
            environments=(execution_provider,),
        )
    )

    events = [
        event
        async for event in worker.execute(task_attempt(profile_id="runtime"), CancellationToken())
    ]

    assert harness.environments is not None
    assert harness.environments.runtime is runtime_provider.environment
    assert harness.environments.execution is execution_provider.environment
    assert [item.path for item in runtime_provider.environment.prepared.files] == [
        "private/auth.json"
    ]
    assert [item.path for item in execution_provider.environment.prepared.files] == [
        "workspace/input.txt"
    ]
    manifest = next(
        event["manifest"] for event in events if event["type"] == "runtime-inputs.resolved"
    )
    assert manifest["executionEnvironment"] == {
        "id": "execution-environment",
        "provider": "execution",
        "placement": "local",
    }
    assert manifest["harnessRuntime"] == {
        "id": "runtime-environment",
        "provider": "runtime",
        "placement": "local",
    }
    assert runtime_provider.environment.disposed == ["completed"]
    assert execution_provider.environment.disposed == ["completed"]


@pytest.mark.asyncio
async def test_split_profile_is_rejected_before_environment_provisioning() -> None:
    runtime_provider = FakeEnvironmentProvider()
    runtime_provider.id = "runtime"
    execution_provider = FakeEnvironmentProvider()
    execution_provider.id = "execution"
    split_profile = WorkerProfile(
        ref=WorkerProfileRef("runtime", "1"),
        worker_type="runtime",
        harness=ProviderConfiguration("fake"),
        runtime=ExecutionConfiguration("runtime", EnvironmentLifetime("attempt")),
        execution=ExecutionConfiguration("execution", EnvironmentLifetime("attempt")),
    )
    worker = create_worker(
        WorkerOptions(
            id="test",
            profiles=(split_profile,),
            harnesses=(FakeHarness(),),
            harness_runtimes=(runtime_provider,),
            environments=(execution_provider,),
        )
    )

    with pytest.raises(ValueError, match="does not support split"):
        _ = [
            event
            async for event in worker.execute(
                task_attempt(profile_id="runtime"), CancellationToken()
            )
        ]
    assert runtime_provider.environment.prepared is None
    assert execution_provider.environment.prepared is None
