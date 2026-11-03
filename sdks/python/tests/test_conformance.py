from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator

import pytest

from supertag.conformance import (
    run_environment_conformance,
    run_harness_conformance,
    run_tool_adapter_conformance,
    run_tool_invoker_conformance,
    validate_harness_events,
)
from supertag.models import (
    CancellationToken,
    Capability,
    EnvironmentLifetime,
    ExecutionConfiguration,
    HarnessCapabilities,
    ProviderConfiguration,
    ResolutionContext,
    TaskAttemptSpec,
    WorkerProfile,
    WorkerProfileRef,
)
from supertag.tools import (
    NativeToolBinding,
    ToolAuthorization,
    ToolAuthorizationResource,
    ToolCapability,
    ToolInput,
    ToolInvocationRequest,
    ToolInvocationResult,
    ToolOperation,
)

from .helpers import task_attempt

TOOL_CALL = {"id": "call-1"}


class Execution:
    def __init__(self, events: list[dict[str, Any]]) -> None:
        self.events = events
        self.closed = False

    async def run(self, cancellation: CancellationToken) -> AsyncIterator[dict[str, Any]]:
        if cancellation.cancelled:
            return
        for event in self.events:
            yield event

    async def close(self) -> None:
        self.closed = True


class HarnessFixture:
    id = "example"

    def __init__(self) -> None:
        self.execution: Execution | None = None

    async def describe(self) -> HarnessCapabilities:
        return HarnessCapabilities(
            id="example",
            version="1.0.0",
            input_kinds=("skill", "tool"),
            streaming=True,
            cancellation=True,
            session_persistence="none",
            runtime_placements=("local",),
        )

    async def plan(self, context: Any) -> dict[str, Any]:
        del context
        return {"files": []}

    async def start(self, plan: Any, environment: Any, context: Any) -> Execution:
        del plan, environment, context
        self.execution = Execution(
            [
                {"type": "tool.call.started", "call": TOOL_CALL},
                {"type": "output.delta", "text": "working"},
                {"type": "tool.call.completed", "call": TOOL_CALL},
                {"type": "output.message", "text": "done"},
            ]
        )
        return self.execution


@pytest.mark.asyncio
async def test_harness_conformance_checks_declaration_lifecycle_and_cancellation() -> None:
    harness = HarnessFixture()
    environment = type("Environment", (), {"placement": "local"})()
    report = await run_harness_conformance(
        harness,
        {"attempt": {}},
        environment,
        expected_input_kinds=("skill", "tool"),
        verify_cancellation=True,
    )
    report.assert_passed()
    assert harness.execution is not None and harness.execution.closed


def test_harness_event_validation_detects_unbalanced_calls_and_streaming() -> None:
    descriptor = HarnessCapabilities("example", "1", ("tool",), False, False, "none", ("local",))
    report = validate_harness_events(
        [
            {"type": "output.delta", "text": "undeclared"},
            {"type": "tool.call.started", "call": TOOL_CALL},
        ],
        descriptor,
    )
    assert {finding.code for finding in report.findings} == {
        "harness.capabilities.streaming",
        "harness.tools.unfinished",
    }


@dataclass
class EnvironmentSpec:
    plan: dict[str, Any]


class Environment:
    id = "local-1"
    placement = "local"
    root_directory = "/tmp/supertag-conformance"

    def __init__(self) -> None:
        self.prepared = False
        self.disposed = False

    async def prepare(self, plan: Any) -> None:
        del plan
        self.prepared = True

    async def dispose(self, outcome: str) -> None:
        assert outcome == "completed"
        self.disposed = True


class EnvironmentProvider:
    id = "local"
    capabilities = (Capability("supertag.execution.local-process", 1),)

    def __init__(self) -> None:
        self.environment = Environment()

    async def provision(self, spec: EnvironmentSpec) -> Environment:
        del spec
        return self.environment


@pytest.mark.asyncio
async def test_environment_conformance_covers_prepare_placement_and_dispose() -> None:
    provider = EnvironmentProvider()
    report = await run_environment_conformance(
        provider, EnvironmentSpec({"files": []}), expected_placement="local"
    )
    report.assert_passed()
    assert provider.environment.prepared
    assert provider.environment.disposed


def tool_input() -> ToolInput:
    return ToolInput(
        "example-tool",
        ToolCapability(
            "example.lookup",
            "example",
            (ToolOperation("lookup", "read", ("example:read",)),),
            ToolAuthorization("example", (ToolAuthorizationResource("example-1", "resource:one"),)),
        ),
        NativeToolBinding("example", "example-sdk"),
    )


class Adapter:
    id = "native-adapter"

    def supports(self, candidate: ToolInput, context: ResolutionContext) -> bool:
        return candidate.binding.kind == "native" and context.profile.harness.provider == "example"

    def adapt(self, candidate: ToolInput, context: ResolutionContext) -> dict[str, str]:
        del candidate, context
        return {"adapter": "example"}


class Invoker:
    id = "native-invoker"

    def supports(self, candidate: ToolInput) -> bool:
        return candidate.binding.kind == "native"

    async def invoke(
        self,
        candidate: ToolInput,
        request: ToolInvocationRequest,
        cancellation: Any | None = None,
    ) -> ToolInvocationResult:
        del candidate, request, cancellation
        return ToolInvocationResult({"ok": True})


@pytest.mark.asyncio
async def test_adapter_and_invoker_conformance() -> None:
    context = ResolutionContext(
        TaskAttemptSpec.from_wire(task_attempt(profile_id="runtime")),
        WorkerProfile(
            ref=WorkerProfileRef("runtime", "1"),
            worker_type="runtime",
            harness=ProviderConfiguration("example"),
            execution=ExecutionConfiguration("local", EnvironmentLifetime("attempt")),
        ),
    )
    adapted = await run_tool_adapter_conformance(Adapter(), tool_input(), context)
    invoked = await run_tool_invoker_conformance(
        Invoker(),
        tool_input(),
        ToolInvocationRequest("call-1", "native", "example", "lookup"),
    )
    adapted.assert_passed()
    invoked.assert_passed()
