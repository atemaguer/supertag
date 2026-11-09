from __future__ import annotations

import asyncio
import importlib.util
import json
import struct
import sys
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from supertag.operator import (
    Code,
    ConnectError,
    OperatorClient,
    OperatorClientSync,
    error_detail,
)
from supertag.operator.v1 import (
    common_pb2,
    conversation_pb2,
    event_pb2,
    organization_pb2,
)

SDK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK / "examples"))

from message_tag import message_tag  # noqa: E402

TOKEN = "fake-operator-token"
ORGANIZATION = "/supertag.operator.v1.OrganizationService/"
CONVERSATION = "/supertag.operator.v1.ConversationService/"
EVENT = "/supertag.operator.v1.EventService/"
UNAUTHENTICATED_DETAIL = {
    "type": "supertag.operator.v1.ErrorDetail",
    "value": "CAE",
    "debug": {"reason": "ERROR_REASON_UNAUTHENTICATED"},
}


def frame(message: dict, flags: int = 0) -> bytes:
    body = json.dumps(message).encode()
    return struct.pack(">BI", flags, len(body)) + body


def frames(body: bytes) -> list[tuple[int, dict]]:
    parsed = []
    while body:
        flags, length = struct.unpack(">BI", body[:5])
        parsed.append((flags, json.loads(body[5 : 5 + length])))
        body = body[5 + length :]
    return parsed


@dataclass
class Call:
    path: str
    headers: dict[str, str]
    body: bytes


@dataclass
class FakeControlPlane:
    """Answers operator RPCs the way the Control Plane's Connect handler does."""

    calls: list[Call] = field(default_factory=list)
    url: str = ""

    def unary(self, path: str, request: dict) -> tuple[int, dict]:
        if path == ORGANIZATION + "GetStatus":
            return 200, {
                "metadata": {
                    "id": "control-plane",
                    "name": "control-plane",
                    "resourceVersion": "9f2c",
                    "createdAt": "2026-11-08T09:00:00Z",
                    "updatedAt": "2026-11-08T09:41:12.345Z",
                },
                "phase": "CONTROL_PLANE_PHASE_ACCEPTING",
                "controllers": [{"name": "task-dispatch", "phase": "CONTROLLER_PHASE_RUNNING"}],
            }
        if path == CONVERSATION + "SendMessage":
            if not request.get("text", "").strip():
                return 400, {
                    "code": "invalid_argument",
                    "message": "Message text must not be empty",
                    "details": [
                        {
                            "type": "supertag.operator.v1.ErrorDetail",
                            "value": "CAYSDQoEdGV4dBIFZW1wdHk",
                        }
                    ],
                }
            return 200, {
                "taskId": "task-1",
                "tag": request["tag"],
                "conversation": request.get("conversation") or "default",
                "text": request["text"].strip(),
                "status": "REPLY_STATUS_WAITING",
            }
        return 404, {"code": "unimplemented", "message": f"{path} is not implemented"}

    def stream(self, path: str, request: dict) -> bytes:
        if path == CONVERSATION + "FollowMessage":
            finished = {
                "taskId": request["taskId"],
                "tag": request["tag"],
                "status": "REPLY_STATUS_REPLIED",
                "reply": {"presentation": "REPLY_PRESENTATION_FINAL_RESULT", "text": "Hello."},
            }
            return b"".join(
                (
                    frame({"sequence": "1", "textDelta": {"text": "Hel"}}),
                    frame({"heartbeat": {}}),
                    frame({"sequence": "2", "textDelta": {"text": "lo."}}),
                    frame(
                        {
                            "sequence": "3",
                            "finish": {"reply": finished["reply"], "message": finished},
                        }
                    ),
                    frame({"sequence": "4", "end": {}}),
                    frame({}, flags=0x02),
                )
            )
        if path == EVENT + "Watch":
            return frame({"heartbeat": {}}) + frame(
                {
                    "error": {
                        "code": "unavailable",
                        "message": "The Control Plane is draining",
                        "details": [{"type": "supertag.operator.v1.ErrorDetail", "value": "CAU"}],
                    }
                },
                flags=0x02,
            )
        return frame(
            {"error": {"code": "unimplemented", "message": f"{path} is not implemented"}},
            flags=0x02,
        )


@pytest.fixture
def control_plane() -> Iterator[FakeControlPlane]:
    fake = FakeControlPlane()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: object) -> None:
            pass

        def do_POST(self) -> None:
            headers = {key.lower(): value for key, value in self.headers.items()}
            body = self.read_body()
            if headers.get("authorization") != f"Bearer {TOKEN}":
                self.respond(
                    401,
                    "application/json",
                    {
                        "code": "unauthenticated",
                        "message": (
                            "A valid Control Plane admin token or Operator Token is required"
                        ),
                        "details": [UNAUTHENTICATED_DETAIL],
                    },
                )
                return
            fake.calls.append(Call(self.path, headers, body))
            if headers["content-type"] == "application/connect+json":
                [(flags, request)] = frames(body)
                assert flags == 0
                self.respond(200, "application/connect+json", fake.stream(self.path, request))
                return
            assert headers["content-type"] == "application/json"
            status, response = fake.unary(self.path, json.loads(body))
            self.respond(status, "application/json", response)

        def read_body(self) -> bytes:
            if self.headers["content-length"] is not None:
                return self.rfile.read(int(self.headers["content-length"]))
            assert self.headers["transfer-encoding"] == "chunked"
            body = b""
            while size := int(self.rfile.readline().split(b";")[0], 16):
                body += self.rfile.read(size)
                self.rfile.readline()
            self.rfile.readline()
            return body

        def respond(self, status: int, content_type: str, body: dict | bytes) -> None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fake.url = f"http://127.0.0.1:{server.server_address[1]}/ignored/path?query=1"
    try:
        yield fake
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


async def test_unary_call_sends_proto3_json_with_the_bearer_token(
    control_plane: FakeControlPlane,
) -> None:
    async with OperatorClient(control_plane.url, TOKEN) as client:
        status = await client.organization.get_status(organization_pb2.GetStatusRequest())

    assert status.phase == organization_pb2.CONTROL_PLANE_PHASE_ACCEPTING
    assert status.metadata.updated_at.ToJsonString() == "2026-11-08T09:41:12.345Z"
    assert [controller.name for controller in status.controllers] == ["task-dispatch"]
    [call] = control_plane.calls
    assert call.path == ORGANIZATION + "GetStatus"
    assert call.headers["connect-protocol-version"] == "1"
    assert call.headers.get("content-encoding", "identity") == "identity"
    assert json.loads(call.body) == {}


async def test_request_fields_use_lower_camel_case(control_plane: FakeControlPlane) -> None:
    async with OperatorClient(control_plane.url, TOKEN) as client:
        message = await client.conversation.send_message(
            conversation_pb2.SendMessageRequest(
                tag="docs-writer", text=" Hi ", idempotency_key="retry-1"
            )
        )

    assert message.task_id == "task-1"
    assert message.conversation == "default"
    assert message.status == conversation_pb2.REPLY_STATUS_WAITING
    assert json.loads(control_plane.calls[0].body) == {
        "tag": "docs-writer",
        "text": " Hi ",
        "idempotencyKey": "retry-1",
    }


async def test_refused_call_carries_the_error_detail(control_plane: FakeControlPlane) -> None:
    async with OperatorClient(control_plane.url) as client:
        with pytest.raises(ConnectError) as refused:
            await client.organization.get_status(organization_pb2.GetStatusRequest())

    assert refused.value.code == Code.UNAUTHENTICATED
    assert refused.value.message.startswith("A valid Control Plane admin token")
    detail = error_detail(refused.value)
    assert detail is not None
    assert detail.reason == common_pb2.ERROR_REASON_UNAUTHENTICATED
    assert control_plane.calls == []


async def test_error_detail_names_the_fields(control_plane: FakeControlPlane) -> None:
    async with OperatorClient(control_plane.url, TOKEN) as client:
        with pytest.raises(ConnectError) as refused:
            await client.conversation.send_message(
                conversation_pb2.SendMessageRequest(tag="docs-writer", text="  ")
            )

    assert refused.value.code == Code.INVALID_ARGUMENT
    detail = error_detail(refused.value)
    assert detail is not None
    assert detail.reason == common_pb2.ERROR_REASON_INVALID_ARGUMENT
    assert [(field.path, field.description) for field in detail.fields] == [("text", "empty")]


def test_error_detail_is_none_without_one() -> None:
    assert error_detail(ConnectError(Code.DEADLINE_EXCEEDED, "deadline")) is None


async def test_server_stream_yields_each_event_until_the_end(
    control_plane: FakeControlPlane,
) -> None:
    async with OperatorClient(control_plane.url, TOKEN) as client:
        events = [
            event
            async for event in client.conversation.follow_message(
                conversation_pb2.FollowMessageRequest(
                    tag="docs-writer", task_id="task-1", after_sequence=7
                )
            )
        ]

    assert [event.WhichOneof("part") for event in events] == [
        "text_delta",
        "heartbeat",
        "text_delta",
        "finish",
        "end",
    ]
    assert [event.sequence for event in events] == [1, 0, 2, 3, 4]
    assert events[3].finish.message.reply.text == "Hello."
    [call] = control_plane.calls
    assert frames(call.body) == [
        (0, {"tag": "docs-writer", "taskId": "task-1", "afterSequence": "7"})
    ]


async def test_server_stream_raises_the_error_that_ends_it(
    control_plane: FakeControlPlane,
) -> None:
    received = []
    async with OperatorClient(control_plane.url, TOKEN) as client:
        with pytest.raises(ConnectError) as ended:
            async for event in client.event.watch(event_pb2.WatchRequest()):
                received.append(event.WhichOneof("event"))

    assert received == ["heartbeat"]
    assert ended.value.code == Code.UNAVAILABLE
    detail = error_detail(ended.value)
    assert detail is not None
    assert detail.reason == common_pb2.ERROR_REASON_DRAINING


def test_sync_client_calls_unary_and_stream_rpcs(control_plane: FakeControlPlane) -> None:
    with OperatorClientSync(control_plane.url, TOKEN) as client:
        status = client.organization.get_status(organization_pb2.GetStatusRequest())
        parts = [
            event.WhichOneof("part")
            for event in client.conversation.follow_message(
                conversation_pb2.FollowMessageRequest(tag="docs-writer", task_id="task-1")
            )
        ]

    assert status.phase == organization_pb2.CONTROL_PLANE_PHASE_ACCEPTING
    assert parts == ["text_delta", "heartbeat", "text_delta", "finish", "end"]


def test_unimplemented_rpc_raises_unimplemented(control_plane: FakeControlPlane) -> None:
    with OperatorClientSync(control_plane.url, TOKEN) as client:
        with pytest.raises(ConnectError) as refused:
            client.organization.get_metrics(organization_pb2.GetMetricsRequest())

    assert refused.value.code == Code.UNIMPLEMENTED
    assert error_detail(refused.value) is None


@pytest.mark.parametrize(
    "url",
    ["ftp://control.example.com", "control.example.com", "https://user:pass@control.example.com"],
)
def test_client_refuses_a_url_that_is_not_a_plain_http_origin(url: str) -> None:
    with pytest.raises(ValueError):
        OperatorClient(url)


def test_clients_cover_every_operator_service() -> None:
    services = set()
    for module in sorted((SDK / "src/supertag/operator/v1").glob("*_pb2.py")):
        imported = importlib.import_module(f"supertag.operator.v1.{module.stem}")
        services.update(imported.DESCRIPTOR.services_by_name)
    assert len(services) == 12
    for client, suffix in (
        (OperatorClient("http://127.0.0.1:1"), "Client"),
        (OperatorClientSync("http://127.0.0.1:1"), "ClientSync"),
    ):
        assert {
            type(getattr(client, name.removesuffix("Service").lower())).__name__
            for name in services
        } == {f"{name}{suffix}" for name in services}


async def test_message_tag_example_prints_the_streamed_reply(
    control_plane: FakeControlPlane, capsys: pytest.CaptureFixture[str]
) -> None:
    reply = await message_tag(control_plane.url, TOKEN, "docs-writer", "Hi")

    assert reply == "Hello."
    assert capsys.readouterr().out == "Hello.\n"


def test_checked_in_bindings_match_the_protos() -> None:
    spec = importlib.util.spec_from_file_location(
        "generate_operator_api", SDK / "scripts/generate_operator_api.py"
    )
    assert spec is not None and spec.loader is not None
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)

    assert generator.stale_bindings() == []


def test_async_client_closes_without_calls() -> None:
    async def open_and_close() -> None:
        async with OperatorClient("https://control.example.com", TOKEN):
            pass

    asyncio.run(open_and_close())
