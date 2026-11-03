from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from supertag.models import (
    EnvironmentLifetime,
    ExecutionConfiguration,
    ProviderConfiguration,
    ResolutionContext,
    TaskAttemptSpec,
    WorkerProfile,
    WorkerProfileRef,
    wire,
)
from supertag.tools import (
    FileToolEffectJournal,
    McpHttpToolBinding,
    McpStdioToolBinding,
    McpToolAdapter,
    MemoryToolEffectJournal,
    NativeToolBinding,
    ReliableToolInvokerRegistry,
    ToolAdapterRegistry,
    ToolAuthorization,
    ToolAuthorizationResource,
    ToolCapability,
    ToolEffectInDoubtError,
    ToolInput,
    ToolInvocationRequest,
    ToolInvocationResult,
    ToolInvokerRegistry,
    ToolOperation,
    describe_tool_call,
    read_mcp_tool_configuration,
    tool_call_outcome_from_text,
)

from .helpers import task_attempt


def resolution_context() -> ResolutionContext:
    return ResolutionContext(
        TaskAttemptSpec.from_wire(task_attempt(profile_id="runtime")),
        WorkerProfile(
            ref=WorkerProfileRef("runtime", "1"),
            worker_type="runtime",
            harness=ProviderConfiguration("codex"),
            execution=ExecutionConfiguration("local", EnvironmentLifetime("attempt")),
        ),
    )


def tool(binding: Any | None = None, *, required: bool = True) -> ToolInput:
    return ToolInput(
        id="github:account-1",
        required=required,
        capability=ToolCapability(
            id="github:account-1",
            provider="github",
            operations=(ToolOperation("add_issue_comment", "write", ("issues:comment",)),),
            authorization=ToolAuthorization(
                "github", (ToolAuthorizationResource("account-1", "repository:123"),)
            ),
        ),
        binding=binding or NativeToolBinding("github-sdk", "octokit", {"apiVersion": "2022-11-28"}),
    )


def request(*, key: str | None = None) -> ToolInvocationRequest:
    return ToolInvocationRequest(
        "call-1",
        "native",
        "github-sdk",
        "add_issue_comment",
        {"issue_number": 3, "body": "Done"},
        key,
    )


def test_mcp_configuration_and_adaptation_enforce_transport_security() -> None:
    http = tool(McpHttpToolBinding("github", "https://mcp.github.example"))
    configuration = read_mcp_tool_configuration(http)
    assert configuration.url == "https://mcp.github.example/"

    stdio = tool(
        McpStdioToolBinding(
            "github",
            "npx",
            ("@github/mcp-server",),
            runtime_environment={"TOKEN": "resolved-at-runtime"},
        )
    )
    projected = McpToolAdapter().adapt(stdio, resolution_context())
    assert projected.command == "npx"
    assert projected.tool_names == ("add_issue_comment",)
    assert projected.environment == {"TOKEN": "resolved-at-runtime"}

    with pytest.raises(ValueError, match="must use HTTPS"):
        read_mcp_tool_configuration(tool(McpHttpToolBinding("unsafe", "http://mcp.example.com")))
    assert (
        read_mcp_tool_configuration(
            tool(McpHttpToolBinding("dev", "http://127.0.0.1:8787/mcp"))
        ).url
        == "http://127.0.0.1:8787/mcp"
    )


def test_tool_input_uses_the_canonical_camel_case_wire_shape() -> None:
    encoded = wire(tool(McpHttpToolBinding("github", "https://mcp.github.example")))

    assert encoded["kind"] == "tool"
    assert encoded["capability"]["authorization"]["resources"] == [
        {"surfaceAccountId": "account-1", "scope": "repository:123"}
    ]
    assert encoded["binding"]["kind"] == "mcp-http"


@pytest.mark.asyncio
async def test_adaptation_fails_closed_for_required_and_omits_optional_tools() -> None:
    registry = ToolAdapterRegistry([McpToolAdapter()])
    context = resolution_context()
    with pytest.raises(ValueError, match="cannot adapt required native tool"):
        await registry.adapt([tool()], context)
    assert await registry.adapt([replace(tool(), required=False)], context) == ()


def test_describe_tool_call_enforces_authorized_operations_and_bounds_arguments() -> None:
    call = describe_tool_call([tool()], request())
    assert call.capability_id == "github:account-1"
    assert call.effect == "write"
    assert call.actions == ("issues:comment",)
    assert call.resources[0].scope == "repository:123"

    with pytest.raises(ValueError, match="unprovisioned native operation"):
        describe_tool_call(
            [tool()], ToolInvocationRequest("call-2", "native", "github-sdk", "delete_repo")
        )
    huge = ToolInvocationRequest(
        "call-3", "native", "github-sdk", "add_issue_comment", {"body": "x" * 16_001}
    )
    assert describe_tool_call([tool()], huge).arguments == {
        "omitted": "arguments exceeded 16000 bytes"
    }


class FakeInvoker:
    id = "octokit"

    def __init__(self) -> None:
        self.calls = 0

    def supports(self, tool_input: ToolInput) -> bool:
        return isinstance(tool_input.binding, NativeToolBinding)

    async def invoke(
        self,
        tool_input: ToolInput,
        invocation: ToolInvocationRequest,
        cancellation: Any | None = None,
    ) -> ToolInvocationResult:
        del tool_input, invocation, cancellation
        self.calls += 1
        return ToolInvocationResult({"commentId": "42"})


@pytest.mark.asyncio
async def test_worker_managed_invocation_and_write_replay() -> None:
    invoker = FakeInvoker()
    call, result = await ToolInvokerRegistry([invoker]).invoke([tool()], request())
    assert call.operation == "add_issue_comment"
    assert result.content == {"commentId": "42"}

    reliable = ReliableToolInvokerRegistry([invoker], MemoryToolEffectJournal())
    first = await reliable.invoke([tool()], request(key="task-1/comment/final"))
    replay = await reliable.invoke([tool()], request(key="task-1/comment/final"))
    assert first[2] is False
    assert replay[2] is True
    assert invoker.calls == 2  # one direct call plus one reliable call


@pytest.mark.asyncio
async def test_file_journal_replays_across_registry_instances(tmp_path: Path) -> None:
    path = tmp_path / "effects.json"
    invoker = FakeInvoker()
    invocation = request(key="task-1/comment/durable")
    await ReliableToolInvokerRegistry([invoker], FileToolEffectJournal(path)).invoke(
        [tool()], invocation
    )
    replay = await ReliableToolInvokerRegistry([invoker], FileToolEffectJournal(path)).invoke(
        [tool()], invocation
    )
    assert replay[2] is True
    assert invoker.calls == 1
    assert path.stat().st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_in_doubt_effect_fails_closed() -> None:
    journal = MemoryToolEffectJournal()
    reliable = ReliableToolInvokerRegistry([FakeInvoker()], journal)
    invocation = request(key="task-1/comment/ambiguous")
    await reliable.invoke([tool()], invocation)
    completed = journal.records["task-1/comment/ambiguous"]
    journal.records[completed.key] = replace(
        completed, state="started", completed_at=None, result=None
    )
    with pytest.raises(ToolEffectInDoubtError):
        await reliable.invoke([tool()], invocation)


def test_outcome_keeps_canonical_references_only() -> None:
    outcome = tool_call_outcome_from_text(
        [
            "Created https://github.com/atemaguer/supertag/issues/17.",
            "Duplicate https://github.com/atemaguer/supertag/issues/17 and no raw receipt",
        ]
    )
    assert outcome is not None
    assert outcome.references == ("https://github.com/atemaguer/supertag/issues/17",)
    assert tool_call_outcome_from_text(["Created comment 9001"]) is None
