from __future__ import annotations

import asyncio
import hashlib
import json
from contextlib import asynccontextmanager
from inspect import isawaitable
from pathlib import Path
from typing import Any, AsyncIterator

import grpc
import pytest

from supertag._runtime_v2 import artifact_pb2 as ap
from supertag._runtime_v2 import runtime_pb2 as pb
from supertag.openai_agents_adapter import HARNESS, run_adapter

from .fixtures.openai_agents_runtime import (
    FIRST_RESULT,
    RESUMED_RESULT,
    FixtureModel,
    FixtureProvider,
)

TOKEN = "fixture-execution-token"
API_KEY = "fixture-provider-key"


class Harness:
    def __init__(self, attached: pb.HarnessRun) -> None:
        self.attached = attached
        self.events: list[pb.HarnessPublishRequest] = []
        self.usage: list[pb.HarnessUsageRequest] = []
        self.completions: list[pb.HarnessCompleteRequest] = []
        self.artifact_handlers: dict[str, grpc.RpcMethodHandler] = {}

    def handler(
        self, method: Any, request: Any, *, pass_context: bool = False
    ) -> grpc.RpcMethodHandler:
        async def authorized(message: Any, context: Any) -> Any:
            if dict(context.invocation_metadata()).get("authorization") != f"Bearer {TOKEN}":
                await context.abort(grpc.StatusCode.UNAUTHENTICATED, "execution credential")
            response = method(message, context) if pass_context else method(message)
            return await response if isawaitable(response) else response

        return grpc.unary_unary_rpc_method_handler(
            authorized,
            request_deserializer=request.FromString,
            response_serializer=lambda response: response.SerializeToString(),
        )

    def publish(self, request: pb.HarnessPublishRequest) -> pb.TaskEvent:
        self.events.append(request)
        return pb.TaskEvent(sequence=request.sequence, text=request.text)

    def report_usage(self, request: pb.HarnessUsageRequest) -> pb.ReportAttemptUsageResponse:
        self.usage.append(request)
        return pb.ReportAttemptUsageResponse()

    def complete(self, request: pb.HarnessCompleteRequest) -> pb.HarnessCompleteResponse:
        self.completions.append(request)
        return pb.HarnessCompleteResponse()

    @asynccontextmanager
    async def serve(self) -> AsyncIterator[bytes]:
        server = grpc.aio.server()
        server.add_generic_rpc_handlers(
            (
                grpc.method_handlers_generic_handler(
                    "supertag.runtime.v2.Harness",
                    {
                        "Attach": self.handler(lambda _: self.attached, pb.HarnessAttachRequest),
                        "Publish": self.handler(self.publish, pb.HarnessPublishRequest),
                        "ReportUsage": self.handler(self.report_usage, pb.HarnessUsageRequest),
                        "Complete": self.handler(self.complete, pb.HarnessCompleteRequest),
                    },
                ),
                grpc.method_handlers_generic_handler(
                    "supertag.runtime.v2.HarnessArtifacts", self.artifact_handlers
                ),
            )
        )
        port = server.add_insecure_port("127.0.0.1:0")
        await server.start()
        try:
            yield pb.AdapterBootstrap(
                endpoint=f"http://127.0.0.1:{port}", token=TOKEN
            ).SerializeToString()
        finally:
            await server.stop(0)


def attach(
    *,
    actions: list[str] | None = None,
    checkpoint: pb.SessionCheckpoint | None = None,
    session: str = "session",
    attempt: str = "attempt-1",
    prompt: str = "First request",
) -> pb.HarnessRun:
    task = pb.Task(
        task_id=f"task-for-{attempt}",
        tag_id="engineering",
        session_id=session,
        attempt_id=attempt,
        state=pb.TASK_STATE_RUNNING,
        allowed_actions=actions or [],
        instructions="Be precise",
        prompt=prompt,
        workspace=pb.WorkspaceSpec(workspace_id="repo", base_commit="a" * 40),
    )
    return pb.HarnessRun(task=task, attempt_id=attempt, checkpoint=checkpoint)


async def test_real_sdk_tool_usage_redaction_and_portable_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", API_KEY)
    (tmp_path / "evidence.txt").write_text("repository evidence", encoding="utf-8")
    model = FixtureModel(secret=API_KEY, read_path="evidence.txt")
    provider = FixtureProvider(model)
    first = Harness(attach(actions=["files:read"]))
    first.attached.task.policy_snapshot.execution.models.append("accepted-role-model")
    async with first.serve() as bootstrap:
        await run_adapter(
            bootstrap, workspace=tmp_path, model="requested-model", model_provider=provider
        )
    assert provider.requested_models == ["accepted-role-model", "accepted-role-model"]
    assert [tool.name for tool in model.requests[0]["tools"]] == ["read_workspace_file"]
    assert "repository evidence" in json.dumps(model.requests[1]["input"])
    assert len(first.completions) == 1
    result = first.completions[0]
    assert result.succeeded
    assert result.result == f"{FIRST_RESULT} [REDACTED]"
    assert [event.sequence for event in first.events] == list(range(1, len(first.events) + 1))
    assert "".join(event.text for event in first.events) == result.result
    assert result.checkpoint.harness == HARNESS
    assert API_KEY.encode() not in result.checkpoint.payload
    assert TOKEN.encode() not in result.checkpoint.payload
    assert [report.sequence for report in first.usage] == [1, 2]
    assert first.usage[0].native_usage.input_tokens == 11
    usage = first.usage[1]
    assert usage.native_usage == pb.NativeTokenUsage(
        input_tokens=22,
        cached_input_tokens=4,
        output_tokens=10,
        observed_model="fixture-observed-model",
    )

    other_host = tmp_path / "different-checkout"
    other_host.mkdir()
    second = Harness(attach(checkpoint=result.checkpoint, attempt="attempt-2", prompt="Follow up"))
    provider = FixtureProvider()
    async with second.serve() as bootstrap:
        await run_adapter(bootstrap, workspace=other_host, model_provider=provider)
    assert second.completions[0].succeeded
    assert second.completions[0].result == RESUMED_RESULT
    assert provider.model.requests[0]["tools"] == []
    assert "First request" in json.dumps(provider.model.requests[0]["input"])

    foreign = Harness(attach(checkpoint=result.checkpoint, session="other-session"))
    provider = FixtureProvider()
    async with foreign.serve() as bootstrap:
        await run_adapter(bootstrap, workspace=tmp_path, model_provider=provider)
    assert not foreign.completions[0].succeeded
    assert "checkpoint does not match this Task" in foreign.completions[0].result
    assert provider.model.requests == []


async def test_adapter_refuses_unsupported_actions_and_invalid_checkpoint(tmp_path: Path) -> None:
    provider = FixtureProvider()
    budgeted = attach()
    budgeted.task.execution_limits.max_reported_tokens = 100
    requires_context = attach(actions=["files:read"])
    requires_context.task.policy_snapshot.context_sets.add(set_id="project-knowledge").items.add(
        item_key="runbook", type="example/runbook", version=1, required=True, config_json="{}"
    )
    for attached, expected in (
        (attach(actions=["commands:execute"]), "allowed actions"),
        (budgeted, "execution limits"),
        (requires_context, "required Context Item"),
        (
            attach(
                checkpoint=pb.SessionCheckpoint(
                    harness=HARNESS, format="session-items-v1", sha256="0" * 64, payload=b"{}"
                )
            ),
            "checkpoint is invalid",
        ),
    ):
        harness = Harness(attached)
        async with harness.serve() as bootstrap:
            await run_adapter(bootstrap, workspace=tmp_path, model_provider=provider)
        assert not harness.completions[0].succeeded
        assert expected in harness.completions[0].result
        assert not harness.completions[0].HasField("checkpoint")
    assert provider.model.requests == []


async def test_cancellation_drains_the_real_sdk_run_before_returning(tmp_path: Path) -> None:
    provider = FixtureProvider()
    harness = Harness(attach(prompt="wait for cancellation"))
    async with harness.serve() as bootstrap:
        adapter = asyncio.create_task(
            run_adapter(bootstrap, workspace=tmp_path, model_provider=provider)
        )
        await asyncio.wait_for(provider.model.started.wait(), 5)
        adapter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(adapter, 5)
    assert provider.model.cancelled.is_set()
    assert harness.completions == []


async def test_adapter_refuses_to_send_execution_token_to_non_loopback() -> None:
    bootstrap = pb.AdapterBootstrap(endpoint="http://192.0.2.1:44", token=TOKEN)
    with pytest.raises(Exception, match="invalid Worklet bootstrap"):
        await run_adapter(bootstrap.SerializeToString())


async def test_real_sdk_artifact_tools_verify_receipts_and_redact_untrusted_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", API_KEY)
    attached = attach(actions=["files:read"])
    attached.may_acquire_artifacts = True
    attached.may_capture_artifacts = True
    attached.may_materialize_artifacts = True
    harness = Harness(attached)
    content = f"fixture content {API_KEY}"
    payload = content.encode()
    file = ap.ArtifactFile(
        path="evidence.txt",
        blob={"sha256": hashlib.sha256(payload).hexdigest(), "byte_length": len(payload)},
    )
    producer = ap.ArtifactProducer(
        task_id=attached.task.task_id,
        attempt_id=attached.attempt_id,
        tag_id=attached.task.tag_id,
        session_id=attached.task.session_id,
    )
    summary = ap.ArtifactSummary(
        artifact_id="artifact-1",
        description=ap.ArtifactDescription(title="Evidence", kind="report"),
        producer=producer,
        file_count=1,
        byte_length=len(payload),
    )
    artifact = ap.CapturedArtifact(summary=summary, files=[file])
    requests = []

    def acquisition(request: Any, delivery: int) -> ap.ArtifactAcquisition:
        requests.append(request)
        return ap.ArtifactAcquisition(
            acquisition_id="acquisition",
            operation_id=request.operation_id,
            artifact_id=request.artifact_id,
            task_id=attached.task.task_id,
            attempt_id=attached.attempt_id,
            delivery=delivery,
            state=ap.ARTIFACT_ACQUISITION_STATE_DELIVERED,
            files=[file],
        )

    def read(request: ap.HarnessReadArtifactRequest) -> ap.HarnessArtifactPage:
        receipt = acquisition(request, ap.ARTIFACT_DELIVERY_READ)
        if request.operation_id == "forged-read":
            receipt.attempt_id = "different-attempt"
        return ap.HarnessArtifactPage(
            acquisition=receipt, path=request.path, text=content, next_offset=len(payload)
        )

    def attach_file(request: ap.HarnessAttachArtifactRequest) -> ap.HarnessAttachedArtifact:
        receipt = acquisition(request, ap.ARTIFACT_DELIVERY_MATERIALIZE)
        prefix = hashlib.sha256(attached.attempt_id.encode()).hexdigest()
        suffix = hashlib.sha256(request.operation_id.encode()).hexdigest()
        receipt.destination = f"inputs/{prefix}/artifact-{suffix}"
        return ap.HarnessAttachedArtifact(acquisition=receipt, local_path=receipt.destination)

    async def capture(
        request: ap.HarnessCaptureArtifactRequest, context: Any
    ) -> ap.CapturedArtifact:
        requests.append(request)
        if sum(isinstance(item, ap.HarnessCaptureArtifactRequest) for item in requests) == 1:
            await context.abort(grpc.StatusCode.UNAVAILABLE, "synthetic response loss")
        return artifact

    harness.artifact_handlers = {
        "Find": harness.handler(
            lambda _: ap.ListCapturedArtifactsResponse(artifacts=[summary], next_before_order=19),
            ap.HarnessFindArtifactsRequest,
        ),
        "Inspect": harness.handler(lambda _: artifact, ap.GetCapturedArtifactRequest),
        "Read": harness.handler(read, ap.HarnessReadArtifactRequest),
        "Attach": harness.handler(attach_file, ap.HarnessAttachArtifactRequest),
        "Capture": harness.handler(capture, ap.HarnessCaptureArtifactRequest, pass_context=True),
    }
    selection = {"artifactId": "artifact-1", "path": "evidence.txt"}
    model = FixtureModel(
        tool_calls=[
            ("find_artifacts", {"limit": 2}),
            ("inspect_artifact", {"artifactId": "artifact-1"}),
            ("read_artifact", {**selection, "operationId": "read-once"}),
            ("read_artifact", {**selection, "operationId": "forged-read"}),
            (
                "attach_artifact",
                {"artifactId": "artifact-1", "paths": ["evidence.txt"], "operationId": "attach"},
            ),
            (
                "capture_artifact",
                {"title": "Evidence", "kind": "report", "paths": ["evidence.txt"]},
            ),
        ]
    )
    async with harness.serve() as bootstrap:
        await run_adapter(bootstrap, workspace=tmp_path, model_provider=FixtureProvider(model))

    assert harness.completions[0].succeeded
    assert {tool.name for tool in model.requests[0]["tools"]} == {
        "read_workspace_file",
        "find_artifacts",
        "inspect_artifact",
        "read_artifact",
        "attach_artifact",
        "capture_artifact",
    }
    assert len(requests) == 5
    assert [request.operation_id for request in requests[:3]] == [
        "read-once",
        "forged-read",
        "attach",
    ]
    assert requests[3].operation_id
    assert requests[3] == requests[4]
    results = [
        item["output"]
        for item in model.requests[-1]["input"]
        if item.get("type") == "function_call_output"
    ]
    assert len(results) == 6
    assert "19" in results[0] and "artifact-1" in results[1]
    assert json.loads(results[2])["text"] == "fixture content [REDACTED]"
    assert "verified" in results[3] and "fixture content" not in results[3]
    assert json.loads(results[4])["localPath"].startswith("inputs/")
    assert json.loads(results[5])["artifactId"] == "artifact-1"
    assert API_KEY.encode() not in harness.completions[0].checkpoint.payload


async def test_artifact_discovery_does_not_enable_checkout_tools(tmp_path: Path) -> None:
    attached = attach()
    attached.may_acquire_artifacts = True
    attached.may_capture_artifacts = True
    attached.may_materialize_artifacts = True
    harness = Harness(attached)
    provider = FixtureProvider()
    async with harness.serve() as bootstrap:
        await run_adapter(bootstrap, workspace=tmp_path, model_provider=provider)

    assert harness.completions[0].succeeded
    assert [tool.name for tool in provider.model.requests[0]["tools"]] == [
        "find_artifacts",
        "inspect_artifact",
        "read_artifact",
    ]
