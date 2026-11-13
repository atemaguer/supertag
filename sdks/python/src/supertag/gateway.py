"""Operator clients for the SuperTag Gateway's gRPC API."""

from __future__ import annotations

import re
from ipaddress import ip_address
from urllib.parse import urlsplit

try:
    import grpc
except ImportError as error:
    raise ImportError(
        "The Gateway API client needs the runtime extra: pip install 'supertag[runtime]'"
    ) from error

from ._runtime_v2 import artifact_pb2 as artifacts
from ._runtime_v2 import (
    artifact_pb2_grpc,
    github_publications_pb2_grpc,
    github_workspaces_pb2_grpc,
    policy_pb2_grpc,
    runtime_pb2_grpc,
)
from ._runtime_v2 import github_publications_pb2 as github_publications
from ._runtime_v2 import github_workspaces_pb2 as github_workspaces
from ._runtime_v2 import policy_pb2 as policy
from ._runtime_v2 import runtime_pb2 as runtime

__all__ = [
    "GatewayClient",
    "GatewayClientSync",
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
        raise ValueError("Gateway URL must be an HTTP or HTTPS origin")
    try:
        parts = urlsplit(url)
        host, port = parts.hostname, parts.port
    except ValueError:
        raise ValueError("Gateway URL must be an HTTP or HTTPS origin") from None
    if (
        host is None
        or port == 0
        or not re.fullmatch(r"(?:\[[0-9a-fA-F:.]+\]|[^:\[\]]+)(?::[0-9]{1,5})?", parts.netloc)
    ):
        raise ValueError("Gateway URL must be an HTTP or HTTPS origin")
    if len(token) > 512 or not re.fullmatch(r"[A-Za-z0-9._~+/\-]+=*", token):
        raise ValueError("Invalid Gateway operator token")

    options = _CHANNEL_OPTIONS
    if parts.scheme == "http":
        try:
            loopback = "%" not in host and ip_address(host).is_loopback
        except ValueError:
            loopback = False
        if not loopback:
            raise ValueError("Cleartext Gateway URL must use a loopback IP address")
        if ca is not None or identity is not None:
            raise ValueError("Gateway TLS options require HTTPS")
        transport = grpc.local_channel_credentials()
        options += (("grpc.enable_http_proxy", 0),)
    else:
        cert, key = identity if identity is not None else (None, None)
        transport = grpc.ssl_channel_credentials(ca, private_key=key, certificate_chain=cert)

    address = f"[{host}]" if ":" in host else host.encode("idna").decode("ascii")
    if ":" not in host and not re.fullmatch(r"[A-Za-z0-9._-]+", address):
        raise ValueError("Gateway URL has an invalid host")
    target = f"{address}:{port or (443 if parts.scheme == 'https' else 80)}"
    credentials = grpc.composite_channel_credentials(
        transport, grpc.access_token_call_credentials(token)
    )
    return target, credentials, options


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


class GatewayClient(_Services):
    """Async Gateway client. Create it in the event loop that will use it.

    Pass a PEM CA for private TLS and a (PEM certificate chain, PEM key) tuple for mutual TLS.
    """

    def __init__(
        self,
        url: str,
        token: str,
        *,
        ca: bytes | None = None,
        identity: tuple[bytes, bytes] | None = None,
    ) -> None:
        target, credentials, options = _connection(url, token, ca=ca, identity=identity)
        self._channel = grpc.aio.secure_channel(target, credentials, options)
        super().__init__(self._channel)

    async def close(self) -> None:
        await self._channel.close()

    async def __aenter__(self) -> GatewayClient:
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        await self.close()


class GatewayClientSync(_Services):
    """Blocking Gateway client with the same services and TLS options as GatewayClient."""

    def __init__(
        self,
        url: str,
        token: str,
        *,
        ca: bytes | None = None,
        identity: tuple[bytes, bytes] | None = None,
    ) -> None:
        target, credentials, options = _connection(url, token, ca=ca, identity=identity)
        self._channel = grpc.secure_channel(target, credentials, options)
        super().__init__(self._channel)

    def close(self) -> None:
        self._channel.close()

    def __enter__(self) -> GatewayClientSync:
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.close()
