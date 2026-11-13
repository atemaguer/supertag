from __future__ import annotations

import os
import selectors
import subprocess
import sys
from contextlib import ExitStack, contextmanager
from pathlib import Path
from uuid import uuid4

import grpc
import pytest

from supertag._runtime_v2 import negotiation_pb2, negotiation_pb2_grpc, runtime_pb2_grpc
from supertag.control_plane_client import (
    ControlPlaneClient,
    ControlPlaneClientSync,
    ControlPlaneProtocolError,
    artifacts,
    runtime,
)

TOKEN = "fixture-operator-token"
HOST_TOKEN = "fixture-worker-host-credential-12345"


@pytest.mark.parametrize(
    ("url", "token", "error"),
    [
        ("http://192.0.2.1:3434", TOKEN, "loopback"),
        ("http://localhost:3434", TOKEN, "loopback"),
        ("http://[::1]tail:3434", TOKEN, "origin"),
        ("http://127.0.0.1:0", TOKEN, "origin"),
        ("https://control-plane.test/path", TOKEN, "origin"),
        ("https://user:password@control-plane.test", TOKEN, "origin"),
        ("https://control-plane.test?", TOKEN, "origin"),
        ("https://control-plane.test", TOKEN + "\n", "operator token"),
    ],
)
def test_control_plane_client_rejects_invalid_connection_options(url, token, error):
    with pytest.raises(ValueError, match=error):
        ControlPlaneClientSync(url, token)


class _OldControlPlane(negotiation_pb2_grpc.ProtocolNegotiationServicer):
    def __init__(self) -> None:
        self.calls: list[str] = []

    def Negotiate(self, request, context):  # noqa: N802
        self.calls.append(dict(context.invocation_metadata()).get("authorization", ""))
        assert request.role == negotiation_pb2.SERVICE_ROLE_CLIENT
        assert list(request.protocol_versions) == [2]
        context.abort(
            grpc.StatusCode.FAILED_PRECONDITION,
            "incompatible SuperTag protocol: this Control Plane (SuperTag 0.1.0) speaks protocol "
            "versions [1], but the connecting operator client (SuperTag supertag-python) "
            "offered [2]",
        )


@contextmanager
def old_control_plane():
    from concurrent import futures

    server = grpc.server(futures.ThreadPoolExecutor(max_workers=2))
    handler = _OldControlPlane()
    negotiation_pb2_grpc.add_ProtocolNegotiationServicer_to_server(handler, server)
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    try:
        yield f"http://127.0.0.1:{port}", handler
    finally:
        server.stop(None)


def test_sync_client_refuses_a_control_plane_from_another_protocol_epoch():
    with old_control_plane() as (url, handler), ControlPlaneClientSync(url, TOKEN) as client:
        with pytest.raises(ControlPlaneProtocolError, match="refused this operator client"):
            client.operator.ListTags(runtime.ListTagsRequest(), timeout=5)
        # Negotiation carries no credential, and no operator call was sent.
        assert handler.calls == [""]


async def test_async_client_refuses_a_control_plane_from_another_protocol_epoch():
    with old_control_plane() as (url, handler):
        async with ControlPlaneClient(url, TOKEN) as client:
            with pytest.raises(ControlPlaneProtocolError, match="offered \\[2\\]"):
                await client.operator.ListTags(runtime.ListTagsRequest(), timeout=5)
        assert handler.calls == [""]


_EPOCH_REFUSAL = (
    "incompatible SuperTag protocol: this Control Plane (SuperTag 0.2.0) was replaced; "
    "negotiate again"
)


class _ReplacedControlPlane(
    negotiation_pb2_grpc.ProtocolNegotiationServicer,
    runtime_pb2_grpc.OperatorServicer,
    runtime_pb2_grpc.OperatorEventsServicer,
):
    """Refuses the first operator call and the first Watch with a protocol
    refusal, as a Control Plane replaced by another release does, then serves."""

    def __init__(self) -> None:
        self.negotiations = 0
        self.refused: set[str] = set()

    def Negotiate(self, request, context):  # noqa: N802
        self.negotiations += 1
        return negotiation_pb2.NegotiateProtocolResponse(
            role=negotiation_pb2.SERVICE_ROLE_CONTROL_PLANE,
            protocol_version=2,
            protocol_versions=[2],
            build_version="fixture",
        )

    def _refuse_once(self, method: str, context) -> None:
        if method not in self.refused:
            self.refused.add(method)
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, _EPOCH_REFUSAL)

    def ListTags(self, request, context):  # noqa: N802
        self._refuse_once("ListTags", context)
        return runtime.ListTagsResponse()

    def Watch(self, request, context):  # noqa: N802
        self._refuse_once("Watch", context)
        return iter(())


@contextmanager
def replaced_control_plane():
    from concurrent import futures

    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    handler = _ReplacedControlPlane()
    negotiation_pb2_grpc.add_ProtocolNegotiationServicer_to_server(handler, server)
    runtime_pb2_grpc.add_OperatorServicer_to_server(handler, server)
    runtime_pb2_grpc.add_OperatorEventsServicer_to_server(handler, server)
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    try:
        yield f"http://127.0.0.1:{port}", handler
    finally:
        server.stop(None)


def test_sync_client_negotiates_again_after_a_protocol_refusal():
    with replaced_control_plane() as (url, handler), ControlPlaneClientSync(url, TOKEN) as client:
        with pytest.raises(grpc.RpcError) as refused:
            client.operator.ListTags(runtime.ListTagsRequest(), timeout=5)
        assert refused.value.code() == grpc.StatusCode.FAILED_PRECONDITION
        client.operator.ListTags(runtime.ListTagsRequest(), timeout=5)
        assert handler.negotiations == 2
        with pytest.raises(grpc.RpcError):
            list(client.events.Watch(runtime.WatchRequest(), timeout=5))
        assert list(client.events.Watch(runtime.WatchRequest(), timeout=5)) == []
        assert handler.negotiations == 3


async def test_async_client_negotiates_again_after_a_protocol_refusal():
    import asyncio

    with replaced_control_plane() as (url, handler):
        async with ControlPlaneClient(url, TOKEN) as client:
            with pytest.raises(grpc.aio.AioRpcError) as refused:
                await client.operator.ListTags(runtime.ListTagsRequest(), timeout=5)
            assert refused.value.code() == grpc.StatusCode.FAILED_PRECONDITION
            await client.operator.ListTags(runtime.ListTagsRequest(), timeout=5)
            assert handler.negotiations == 2
            with pytest.raises(grpc.aio.AioRpcError):
                async for _ in client.events.Watch(runtime.WatchRequest(), timeout=5):
                    pass
            # A done callback observes the stream's refusal; let it run.
            await asyncio.sleep(0.1)
            watch = client.events.Watch(runtime.WatchRequest(), timeout=5)
            assert [event async for event in watch] == []
            assert handler.negotiations == 3


@contextmanager
def service(binary: str, args: list[str], env: dict[str, str]):
    process = subprocess.Popen(
        [binary, *args], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True
    )
    try:
        assert process.stdout is not None
        with selectors.DefaultSelector() as ready:
            ready.register(process.stdout, selectors.EVENT_READ)
            assert ready.select(10), "SuperTag service did not bind"
        endpoint = process.stdout.readline().strip()
        assert endpoint.startswith("127.0.0.1:"), "SuperTag service did not bind on loopback"
        yield "http://" + endpoint
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if process.stdout is not None:
            process.stdout.close()


@pytest.fixture
def control_plane_url(tmp_path: Path):
    binary = os.environ.get("SUPERTAG_RUST_TEST_CLI")
    if not binary:
        pytest.skip("requires SUPERTAG_RUST_TEST_CLI pointing to the native SuperTag CLI")
    env = {
        "SUPERTAG_OPERATOR_TOKEN": TOKEN,
        "SUPERTAG_DATABASE_URL": f"sqlite://{tmp_path / 'control.sqlite'}?mode=rwc",
        "SUPERTAG_BOOTSTRAP_HOST_TOKEN": HOST_TOKEN,
    }
    with ExitStack() as services:
        yield services.enter_context(service(binary, ["control-plane"], env))


async def test_control_plane_clients_replay_task_and_stream_events(control_plane_url):
    with ControlPlaneClientSync(control_plane_url, "invalid-fixture-token") as wrong:
        with pytest.raises(grpc.RpcError) as rejected:
            wrong.operator.ListTags(runtime.ListTagsRequest(), timeout=3)
        assert rejected.value.code() == grpc.StatusCode.UNAUTHENTICATED

    with ControlPlaneClientSync(control_plane_url, TOKEN) as client:
        tags = client.operator.ListTags(runtime.ListTagsRequest(), timeout=3)
        assert not tags.tags
        with pytest.raises(grpc.RpcError) as missing:
            client.artifact_publications.ListPublications(
                artifacts.ListObjectiveArtifactApprovalsRequest(objective_id="unknown"), timeout=3
            )
        assert missing.value.code() == grpc.StatusCode.NOT_FOUND

    async with ControlPlaneClient(control_plane_url, TOKEN) as client:
        stream = client.events.Watch(
            runtime.WatchRequest(kinds=[runtime.WATCH_KIND_TAG]), timeout=5
        )
        try:
            first = await stream.read()
            assert first.HasField("heartbeat") and first.resume_token
            tag = await client.operator.PutTag(
                runtime.PutTagRequest(tag_id="python-sdk", instructions="Build release notes."),
                timeout=3,
            )
            change = await stream.read()
            assert change.change.id == tag.tag_id and change.resume_token != first.resume_token
        finally:
            stream.cancel()

        submission = runtime.SubmitTaskRequest(
            tag_id=tag.tag_id,
            session_id="fixture",
            operation_id=str(uuid4()),
            prompt="Verify the installed Control Plane client.",
        )
        accepted = await client.operator.SubmitTask(submission, timeout=3)
        replay = await client.operator.SubmitTask(submission, timeout=3)
        assert accepted.task_id and replay.task_id == accepted.task_id

        missing = client.download_artifact_file(
            artifacts.DownloadArtifactFileRequest(artifact_id="unknown", path="evidence.txt"),
            timeout=3,
        )
        with pytest.raises(grpc.aio.AioRpcError) as rejected:
            await missing.read()
        assert rejected.value.code() == grpc.StatusCode.NOT_FOUND


def test_installed_harness_runs_one_task_and_replays_event(control_plane_url, tmp_path):
    adapter = tmp_path / "adapter.py"
    adapter.write_text(
        """import asyncio
import os
import sys
from supertag.harness_adapter import effects, open_harness, runtime

async def run():
    assert "SUPERTAG_HOST_TOKEN" not in os.environ
    async with open_harness(sys.stdin.buffer) as harness:
        attached = await harness.client.Attach(runtime.HarnessAttachRequest(), timeout=5)
        # Worker-managed effect receipts: a completed effect replays, an unsettled one is in doubt.
        effect = dict(
            idempotency_key="ticket/1", operation="create_ticket", arguments_json='{"title":"R"}'
        )
        begun = await harness.effects.Begin(effects.HarnessBeginEffectRequest(**effect), timeout=5)
        assert begun.state == effects.EFFECT_RECEIPT_STATE_ACQUIRED
        await harness.effects.Complete(
            effects.HarnessCompleteEffectRequest(**effect, result_json='{"ticket":"T-1"}'),
            timeout=5,
        )
        replay = await harness.effects.Begin(effects.HarnessBeginEffectRequest(**effect), timeout=5)
        assert replay.state == effects.EFFECT_RECEIPT_STATE_COMPLETED and replay.replayed
        assert replay.result_json == '{"ticket":"T-1"}'
        unsettled = effects.HarnessBeginEffectRequest(**{**effect, "idempotency_key": "ticket/2"})
        await harness.effects.Begin(unsettled, timeout=5)
        doubt = await harness.effects.Begin(unsettled, timeout=5)
        assert doubt.state == effects.EFFECT_RECEIPT_STATE_IN_DOUBT
        result = "Installed Python harness for " + attached.task.tag_id
        event = runtime.HarnessPublishRequest(sequence=1, text=result)
        await harness.client.Publish(event, timeout=5)
        await harness.client.Publish(event, timeout=5)
        await harness.client.Complete(
            runtime.HarnessCompleteRequest(result=result, succeeded=True), timeout=5
        )

asyncio.run(run())
""",
        encoding="utf-8",
    )
    with ControlPlaneClientSync(control_plane_url, TOKEN) as client:
        tag = client.operator.PutTag(
            runtime.PutTagRequest(tag_id="python-harness", instructions="Verify SDK."),
            timeout=3,
        )
        task = client.operator.SubmitTask(
            runtime.SubmitTaskRequest(
                tag_id=tag.tag_id,
                session_id="fixture",
                operation_id="sdk-harness-test",
                prompt="Run one Task.",
            ),
            timeout=3,
        )
        output = subprocess.run(
            [
                os.environ["SUPERTAG_RUST_TEST_CLI"],
                "worker-host",
                "--control-plane",
                control_plane_url,
                "--state-directory",
                str(tmp_path / "host"),
                "--adapter",
                sys.executable,
                "--adapter-arg",
                str(adapter),
                "--once",
            ],
            env={"SUPERTAG_HOST_TOKEN": HOST_TOKEN, "PATH": "/usr/bin:/bin"},
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert output.returncode == 0, output.stderr
        final = client.operator.GetTask(runtime.GetTaskRequest(task_id=task.task_id), timeout=3)
        assert final.state == runtime.TASK_STATE_SUCCEEDED, (final.result, output.stderr)
        assert final.result == "Installed Python harness for python-harness"
        events = client.operator.ListEvents(
            runtime.ListEventsRequest(task_id=task.task_id), timeout=3
        )
        assert sum(event.text == final.result for event in events.events) == 1
