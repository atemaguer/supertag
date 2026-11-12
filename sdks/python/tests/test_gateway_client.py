from __future__ import annotations

import os
import selectors
import subprocess
from contextlib import ExitStack, contextmanager
from pathlib import Path
from uuid import uuid4

import grpc
import pytest

from supertag.gateway import GatewayClient, GatewayClientSync, artifacts, runtime

TOKEN = "fixture-operator-token"


@pytest.mark.parametrize(
    ("url", "token", "error"),
    [
        ("http://192.0.2.1:3434", TOKEN, "loopback"),
        ("http://localhost:3434", TOKEN, "loopback"),
        ("http://[::1]tail:3434", TOKEN, "origin"),
        ("http://127.0.0.1:0", TOKEN, "origin"),
        ("https://gateway.test/path", TOKEN, "origin"),
        ("https://user:password@gateway.test", TOKEN, "origin"),
        ("https://gateway.test?", TOKEN, "origin"),
        ("https://gateway.test", TOKEN + "\n", "operator token"),
    ],
)
def test_gateway_rejects_invalid_connection_options(url, token, error):
    with pytest.raises(ValueError, match=error):
        GatewayClientSync(url, token)


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
def gateway_url(tmp_path: Path):
    binary = os.environ.get("SUPERTAG_RUST_TEST_CLI")
    if not binary:
        pytest.skip("requires SUPERTAG_RUST_TEST_CLI pointing to the native SuperTag CLI")
    env = {
        "SUPERTAG_GATEWAY_TOKEN": "fixture-private-gateway-token",
        "SUPERTAG_OPERATOR_TOKEN": TOKEN,
        "SUPERTAG_DATABASE_URL": f"sqlite://{tmp_path / 'control.sqlite'}?mode=rwc",
    }
    with ExitStack() as services:
        private = services.enter_context(service(binary, ["control-plane"], env))
        yield services.enter_context(service(binary, ["gateway", "--control-plane", private], env))


async def test_gateway_clients_replay_task_and_stream_events(gateway_url):
    with GatewayClientSync(gateway_url, "invalid-fixture-token") as wrong:
        with pytest.raises(grpc.RpcError) as rejected:
            wrong.operator.ListTags(runtime.ListTagsRequest(), timeout=3)
        assert rejected.value.code() == grpc.StatusCode.UNAUTHENTICATED

    with GatewayClientSync(gateway_url, TOKEN) as client:
        tags = client.operator.ListTags(runtime.ListTagsRequest(), timeout=3)
        assert not tags.tags
        with pytest.raises(grpc.RpcError) as missing:
            client.artifact_publications.ListPublications(
                artifacts.ListObjectiveArtifactApprovalsRequest(objective_id="unknown"), timeout=3
            )
        assert missing.value.code() == grpc.StatusCode.NOT_FOUND

    async with GatewayClient(gateway_url, TOKEN) as client:
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
            prompt="Verify the installed Gateway client.",
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
