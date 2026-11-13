"""Operator clients for the SuperTag Control Plane's gRPC API."""

from __future__ import annotations

import asyncio
import re
import threading
from ipaddress import ip_address
from typing import Any, NamedTuple
from urllib.parse import urlsplit

try:
    import grpc
except ImportError as error:
    raise ImportError(
        "The Control Plane client needs the runtime extra: pip install 'supertag[runtime]'"
    ) from error

from ._runtime_v2 import artifact_pb2 as artifacts
from ._runtime_v2 import (
    artifact_pb2_grpc,
    github_publications_pb2_grpc,
    github_workspaces_pb2_grpc,
    negotiation_pb2,
    negotiation_pb2_grpc,
    policy_pb2_grpc,
    runtime_pb2_grpc,
)
from ._runtime_v2 import github_publications_pb2 as github_publications
from ._runtime_v2 import github_workspaces_pb2 as github_workspaces
from ._runtime_v2 import policy_pb2 as policy
from ._runtime_v2 import runtime_pb2 as runtime

__all__ = [
    "ControlPlaneClient",
    "ControlPlaneClientSync",
    "ControlPlaneProtocolError",
    "artifacts",
    "github_publications",
    "github_workspaces",
    "policy",
    "runtime",
]

_MAX_MESSAGE_BYTES = 1024 * 1024
_CHANNEL_OPTIONS = (
    ("grpc.max_receive_message_length", _MAX_MESSAGE_BYTES),
    ("grpc.max_send_message_length", _MAX_MESSAGE_BYTES),
)


def _connection(url: str, token: str, *, ca: bytes | None, identity: tuple[bytes, bytes] | None):
    if not re.fullmatch(r"https?://[^/?#@\\\s]+/?", url):
        raise ValueError("Control Plane URL must be an HTTP or HTTPS origin")
    try:
        parts = urlsplit(url)
        host, port = parts.hostname, parts.port
    except ValueError:
        raise ValueError("Control Plane URL must be an HTTP or HTTPS origin") from None
    if (
        host is None
        or port == 0
        or not re.fullmatch(r"(?:\[[0-9a-fA-F:.]+\]|[^:\[\]]+)(?::[0-9]{1,5})?", parts.netloc)
    ):
        raise ValueError("Control Plane URL must be an HTTP or HTTPS origin")
    if len(token) > 512 or not re.fullmatch(r"[A-Za-z0-9._~+/\-]+=*", token):
        raise ValueError("Invalid operator token")

    options = _CHANNEL_OPTIONS
    if parts.scheme == "http":
        try:
            loopback = "%" not in host and ip_address(host).is_loopback
        except ValueError:
            loopback = False
        if not loopback:
            raise ValueError("Cleartext Control Plane URL must use a loopback IP address")
        if ca is not None or identity is not None:
            raise ValueError("Control Plane TLS options require HTTPS")
        transport = grpc.local_channel_credentials()
        options += (("grpc.enable_http_proxy", 0),)
    else:
        cert, key = identity if identity is not None else (None, None)
        transport = grpc.ssl_channel_credentials(ca, private_key=key, certificate_chain=cert)

    address = f"[{host}]" if ":" in host else host.encode("idna").decode("ascii")
    if ":" not in host and not re.fullmatch(r"[A-Za-z0-9._-]+", address):
        raise ValueError("Control Plane URL has an invalid host")
    target = f"{address}:{port or (443 if parts.scheme == 'https' else 80)}"
    credentials = grpc.composite_channel_credentials(
        transport, grpc.access_token_call_credentials(token)
    )
    return target, transport, credentials, options


# Every call names the protocol version this client negotiated with the Control Plane, which
# refuses a call without it.
_PROTOCOL_HEADER = "x-supertag-protocol"
_PROTOCOL_VERSIONS = (2,)
_NEGOTIATION_TIMEOUT = 5.0


class ControlPlaneProtocolError(RuntimeError):
    """The Control Plane runs an incompatible SuperTag release or refused this client's role."""


def _negotiation_request() -> negotiation_pb2.NegotiateProtocolRequest:
    return negotiation_pb2.NegotiateProtocolRequest(
        role=negotiation_pb2.SERVICE_ROLE_OPERATOR,
        protocol_versions=_PROTOCOL_VERSIONS,
        build_version="supertag-python",
    )


def _refusal(error: grpc.RpcError) -> Exception:
    code, details = error.code(), error.details() or ""
    if code == grpc.StatusCode.UNIMPLEMENTED:
        return ControlPlaneProtocolError(
            "incompatible SuperTag protocol: the Control Plane does not offer SuperTag protocol "
            "negotiation"
        )
    if code in (
        grpc.StatusCode.FAILED_PRECONDITION,
        grpc.StatusCode.PERMISSION_DENIED,
        grpc.StatusCode.INVALID_ARGUMENT,
    ):
        return ControlPlaneProtocolError(
            f"the SuperTag Control Plane refused this operator client: {details}"
        )
    return error


def _protocol_refusal(code: grpc.StatusCode | None, details: str | None) -> bool:
    """A Control Plane replaced by another release refuses the version this client holds."""
    details = details or ""
    return code == grpc.StatusCode.FAILED_PRECONDITION and (
        details.startswith("incompatible SuperTag protocol")
        or "did not negotiate a protocol version" in details
    )


def _selected(answer: negotiation_pb2.NegotiateProtocolResponse) -> int:
    if answer.role != negotiation_pb2.SERVICE_ROLE_CONTROL_PLANE:
        raise ControlPlaneProtocolError(
            "this operator client expected a SuperTag Control Plane but reached another service"
        )
    version = answer.protocol_version
    if version not in _PROTOCOL_VERSIONS or version not in answer.protocol_versions:
        raise ControlPlaneProtocolError(
            "incompatible SuperTag protocol: the Control Plane selected protocol "
            f"{version}; run the same SuperTag release on the Control Plane and this client"
        )
    return version


class _CallDetails(NamedTuple):
    method: str
    timeout: float | None
    metadata: Any
    credentials: Any
    wait_for_ready: Any
    compression: Any


class _SyncNegotiation(
    grpc.UnaryUnaryClientInterceptor,
    grpc.UnaryStreamClientInterceptor,
    grpc.StreamUnaryClientInterceptor,
    grpc.StreamStreamClientInterceptor,
):
    """Negotiates before the first call, over a channel without call credentials."""

    def __init__(self, target: str, transport: grpc.ChannelCredentials, options) -> None:
        self._target, self._transport, self._options = target, transport, options
        self._lock = threading.Lock()
        self._version: int | None = None

    def _negotiated(self) -> int:
        with self._lock:
            if self._version is None:
                with grpc.secure_channel(self._target, self._transport, self._options) as channel:
                    stub = negotiation_pb2_grpc.ProtocolNegotiationStub(channel)
                    try:
                        answer = stub.Negotiate(
                            _negotiation_request(), timeout=_NEGOTIATION_TIMEOUT
                        )
                    except grpc.RpcError as error:
                        raise _refusal(error) from None
                self._version = _selected(answer)
            return self._version

    def _details(self, details):
        metadata = [*(details.metadata or ()), (_PROTOCOL_HEADER, str(self._negotiated()))]
        return _CallDetails(
            details.method,
            details.timeout,
            metadata,
            details.credentials,
            getattr(details, "wait_for_ready", None),
            getattr(details, "compression", None),
        )

    def _forget(self, call) -> None:
        if _protocol_refusal(call.code(), call.details()):
            with self._lock:
                self._version = None

    def _watched(self, call):
        # The next call negotiates again after a protocol refusal.
        call.add_done_callback(self._forget)
        return call

    def intercept_unary_unary(self, continuation, details, request):
        return self._watched(continuation(self._details(details), request))

    def intercept_unary_stream(self, continuation, details, request):
        return self._watched(continuation(self._details(details), request))

    def intercept_stream_unary(self, continuation, details, requests):
        return self._watched(continuation(self._details(details), requests))

    def intercept_stream_stream(self, continuation, details, requests):
        return self._watched(continuation(self._details(details), requests))


class _AsyncNegotiation:
    """The async counterpart of _SyncNegotiation, for grpc.aio channels."""

    def __init__(self, target: str, transport: grpc.ChannelCredentials, options) -> None:
        self._target, self._transport, self._options = target, transport, options
        self._lock: asyncio.Lock | None = None
        self._version: int | None = None

    async def _negotiated(self) -> int:
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            if self._version is None:
                async with grpc.aio.secure_channel(
                    self._target, self._transport, self._options
                ) as channel:
                    stub = negotiation_pb2_grpc.ProtocolNegotiationStub(channel)
                    try:
                        answer = await stub.Negotiate(
                            _negotiation_request(), timeout=_NEGOTIATION_TIMEOUT
                        )
                    except grpc.RpcError as error:
                        raise _refusal(error) from None
                self._version = _selected(answer)
            return self._version

    def forget(self) -> None:
        self._version = None

    async def settled(self, call):
        """Awaits a unary response so a protocol refusal is seen before the caller retries."""
        try:
            await call
        except grpc.aio.AioRpcError as error:
            if _protocol_refusal(error.code(), error.details()):
                self.forget()
        return call

    def watched(self, call):
        """Forgets the held version once a streaming call ends in a protocol refusal."""

        def done(finished) -> None:
            async def check() -> None:
                if _protocol_refusal(await finished.code(), await finished.details()):
                    self.forget()

            if not finished.cancelled():
                asyncio.ensure_future(check())

        call.add_done_callback(done)
        return call

    async def details(self, details):
        metadata = grpc.aio.Metadata(*(details.metadata or ()))
        metadata.add(_PROTOCOL_HEADER, str(await self._negotiated()))
        return grpc.aio.ClientCallDetails(
            details.method,
            details.timeout,
            metadata,
            details.credentials,
            details.wait_for_ready,
        )


class _AsyncUnaryUnary(grpc.aio.UnaryUnaryClientInterceptor):
    def __init__(self, negotiation: _AsyncNegotiation) -> None:
        self._negotiation = negotiation

    async def intercept_unary_unary(self, continuation, details, request):
        call = await continuation(await self._negotiation.details(details), request)
        return await self._negotiation.settled(call)


class _AsyncUnaryStream(grpc.aio.UnaryStreamClientInterceptor):
    def __init__(self, negotiation: _AsyncNegotiation) -> None:
        self._negotiation = negotiation

    async def intercept_unary_stream(self, continuation, details, request):
        call = await continuation(await self._negotiation.details(details), request)
        return self._negotiation.watched(call)


class _AsyncStreamUnary(grpc.aio.StreamUnaryClientInterceptor):
    def __init__(self, negotiation: _AsyncNegotiation) -> None:
        self._negotiation = negotiation

    async def intercept_stream_unary(self, continuation, details, requests):
        call = await continuation(await self._negotiation.details(details), requests)
        return self._negotiation.watched(call)


class _AsyncStreamStream(grpc.aio.StreamStreamClientInterceptor):
    def __init__(self, negotiation: _AsyncNegotiation) -> None:
        self._negotiation = negotiation

    async def intercept_stream_stream(self, continuation, details, requests):
        call = await continuation(await self._negotiation.details(details), requests)
        return self._negotiation.watched(call)


class _Services:
    def __init__(self, channel: grpc.Channel | grpc.aio.Channel) -> None:
        self.operator = runtime_pb2_grpc.OperatorStub(channel)
        self.conversations = runtime_pb2_grpc.ConversationsStub(channel)
        self.events = runtime_pb2_grpc.OperatorEventsStub(channel)
        self.objectives = runtime_pb2_grpc.ObjectivesStub(channel)
        self.inbox = runtime_pb2_grpc.InboxStub(channel)
        self.work_sessions = runtime_pb2_grpc.WorkSessionsStub(channel)
        self.teams = runtime_pb2_grpc.TeamsStub(channel)
        self.mailbox = runtime_pb2_grpc.MailboxStub(channel)
        self.live_inputs = runtime_pb2_grpc.LiveInputsStub(channel)
        self.policy = policy_pb2_grpc.PolicyCatalogStub(channel)
        self.manifest_relationships = runtime_pb2_grpc.ManifestRelationshipsStub(channel)
        self.surfaces = policy_pb2_grpc.SurfacePolicyCatalogStub(channel)
        self.github_workspaces = github_workspaces_pb2_grpc.GithubWorkspacesStub(channel)
        self.github_publications = github_publications_pb2_grpc.GithubPublicationsStub(channel)
        self.artifacts = artifact_pb2_grpc.ArtifactCatalogStub(channel)
        self.artifact_publications = artifact_pb2_grpc.ArtifactPublicationsStub(channel)
        self.volumes = artifact_pb2_grpc.ArtifactVolumesStub(channel)
        self.download_artifact_file = artifact_pb2_grpc.ArtifactTransfersStub(channel).DownloadFile
        workspaces = runtime_pb2_grpc.TransfersStub(channel)
        self.download_workspace_artifact = workspaces.DownloadWorkspaceArtifact
        self.download_review_artifact = workspaces.DownloadReviewArtifact


class ControlPlaneClient(_Services):
    """Async Control Plane client. Create it in the event loop that will use it.

    Pass a PEM CA for private TLS and a (PEM certificate chain, PEM key) tuple for mutual TLS.
    The first call negotiates the SuperTag protocol version and raises ControlPlaneProtocolError
    for a Control Plane from another release.
    """

    def __init__(
        self,
        url: str,
        token: str,
        *,
        ca: bytes | None = None,
        identity: tuple[bytes, bytes] | None = None,
    ) -> None:
        target, transport, credentials, options = _connection(url, token, ca=ca, identity=identity)
        negotiation = _AsyncNegotiation(target, transport, options)
        self._channel = grpc.aio.secure_channel(
            target,
            credentials,
            options,
            interceptors=[
                _AsyncUnaryUnary(negotiation),
                _AsyncUnaryStream(negotiation),
                _AsyncStreamUnary(negotiation),
                _AsyncStreamStream(negotiation),
            ],
        )
        super().__init__(self._channel)

    async def close(self) -> None:
        await self._channel.close()

    async def __aenter__(self) -> ControlPlaneClient:
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        await self.close()


class ControlPlaneClientSync(_Services):
    """Blocking Control Plane client with the same services, TLS options, and protocol
    negotiation as ControlPlaneClient."""

    def __init__(
        self,
        url: str,
        token: str,
        *,
        ca: bytes | None = None,
        identity: tuple[bytes, bytes] | None = None,
    ) -> None:
        target, transport, credentials, options = _connection(url, token, ca=ca, identity=identity)
        self._channel = grpc.secure_channel(target, credentials, options)
        super().__init__(
            grpc.intercept_channel(self._channel, _SyncNegotiation(target, transport, options))
        )

    def close(self) -> None:
        self._channel.close()

    def __enter__(self) -> ControlPlaneClientSync:
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.close()
