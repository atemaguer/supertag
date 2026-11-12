"""Connect a Python harness adapter to its supervising SuperTag Worker Host."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, BinaryIO
from urllib.parse import urlsplit

if TYPE_CHECKING:
    import grpc

from ._runtime_v2 import artifact_pb2 as artifacts
from ._runtime_v2 import mcp_pb2 as mcp
from ._runtime_v2 import policy_pb2 as policy
from ._runtime_v2 import runtime_pb2 as runtime

__all__ = ["HarnessConnection", "artifacts", "mcp", "open_harness", "policy", "runtime"]

MAX_BOOTSTRAP_BYTES = 4_096
MAX_HARNESS_MESSAGE_BYTES = 17 * 1024 * 1024


def bootstrap_target(bootstrap: runtime.AdapterBootstrap) -> str:
    if not re.fullmatch(
        r"http://(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}/?", bootstrap.endpoint
    ) or not re.fullmatch(r"[A-Za-z0-9._~-]{16,512}", bootstrap.token):
        raise ValueError("invalid Worklet bootstrap identity")
    try:
        endpoint = urlsplit(bootstrap.endpoint)
        port = endpoint.port
    except ValueError:
        raise ValueError("invalid Worklet bootstrap endpoint") from None
    if not port:
        raise ValueError("invalid Worklet bootstrap identity")
    return endpoint.netloc


class HarnessConnection:
    """Generated gRPC services scoped to one Task Attempt."""

    def __init__(self, channel: grpc.aio.Channel) -> None:
        from ._runtime_v2 import artifact_pb2_grpc, mcp_pb2_grpc, runtime_pb2_grpc

        self.client = runtime_pb2_grpc.HarnessStub(channel)
        self.questions = runtime_pb2_grpc.HarnessQuestionsStub(channel)
        self.workstreams = runtime_pb2_grpc.HarnessWorkstreamsStub(channel)
        self.mailbox = runtime_pb2_grpc.HarnessMailboxStub(channel)
        self.work_sessions = runtime_pb2_grpc.HarnessWorkSessionsStub(channel)
        self.workspace = runtime_pb2_grpc.HarnessWorkspaceStub(channel)
        self.artifacts = artifact_pb2_grpc.HarnessArtifactsStub(channel)
        self.mcp = mcp_pb2_grpc.HarnessMcpStub(channel)


@asynccontextmanager
async def open_harness(source: BinaryIO) -> AsyncIterator[HarnessConnection]:
    """Read one bounded bootstrap from the Worker Host and close its channel on exit."""
    try:
        import grpc
    except ImportError as error:
        raise ImportError(
            "The Harness client needs the runtime extra: pip install 'supertag[runtime]'"
        ) from error

    payload = source.read(MAX_BOOTSTRAP_BYTES + 1)
    if not 0 < len(payload) <= MAX_BOOTSTRAP_BYTES:
        raise ValueError("invalid Worklet bootstrap size")
    bootstrap = runtime.AdapterBootstrap.FromString(payload)
    target = bootstrap_target(bootstrap)
    credentials = grpc.composite_channel_credentials(
        grpc.local_channel_credentials(), grpc.access_token_call_credentials(bootstrap.token)
    )
    options = (
        ("grpc.enable_http_proxy", 0),
        ("grpc.max_receive_message_length", MAX_HARNESS_MESSAGE_BYTES),
        ("grpc.max_send_message_length", MAX_HARNESS_MESSAGE_BYTES),
    )
    async with grpc.aio.secure_channel(target, credentials, options) as channel:
        yield HarnessConnection(channel)
