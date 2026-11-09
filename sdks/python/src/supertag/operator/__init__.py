"""Clients for the SuperTag operator API, `supertag.operator.v1`.

The messages and per-service clients are generated from the protos under `spec/proto/` into
`supertag.operator.v1`. `OperatorClient` and `OperatorClientSync` bundle one client per service,
call the Control Plane over the Connect protocol with JSON bodies, and send the credential as
`authorization: Bearer TOKEN`.
"""

from __future__ import annotations

from types import TracebackType
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

try:
    from connectrpc.code import Code
    from connectrpc.errors import ConnectError
except ImportError as error:
    raise ImportError(
        "The operator API client needs the operator extra: pip install 'supertag[operator]'"
    ) from error

from .v1.access_connect import AccessServiceClient, AccessServiceClientSync
from .v1.common_pb2 import ErrorDetail
from .v1.conversation_connect import ConversationServiceClient, ConversationServiceClientSync
from .v1.event_connect import EventServiceClient, EventServiceClientSync
from .v1.host_connect import HostServiceClient, HostServiceClientSync
from .v1.inbox_connect import InboxServiceClient, InboxServiceClientSync
from .v1.mailbox_connect import MailboxServiceClient, MailboxServiceClientSync
from .v1.objective_connect import ObjectiveServiceClient, ObjectiveServiceClientSync
from .v1.organization_connect import OrganizationServiceClient, OrganizationServiceClientSync
from .v1.resource_connect import ResourceServiceClient, ResourceServiceClientSync
from .v1.surface_connect import SurfaceServiceClient, SurfaceServiceClientSync
from .v1.team_connect import TeamServiceClient, TeamServiceClientSync
from .v1.work_connect import WorkServiceClient, WorkServiceClientSync

if TYPE_CHECKING:
    from connectrpc.request import RequestContext

OPERATOR_API_VERSION = "v1"
"""The operator API version, from its protobuf package `supertag.operator.v1`."""

__all__ = [
    "OPERATOR_API_VERSION",
    "Code",
    "ConnectError",
    "ErrorDetail",
    "OperatorClient",
    "OperatorClientSync",
    "error_detail",
]


def error_detail(error: ConnectError) -> ErrorDetail | None:
    """Returns the `ErrorDetail` of a refused call, or None when the error carries none.

    Branch on its `reason`, never on the error message, which is prose for people.
    """
    for detail in error.details:
        if detail.Is(ErrorDetail.DESCRIPTOR):
            unpacked = ErrorDetail()
            detail.Unpack(unpacked)
            return unpacked
    return None


def _origin(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("The Control Plane URL must be an http or https URL")
    if parts.username is not None or parts.password is not None:
        raise ValueError("The Control Plane URL must not contain credentials")
    return f"{parts.scheme}://{parts.netloc}"


_SERVICES = (
    "access",
    "conversation",
    "event",
    "host",
    "inbox",
    "mailbox",
    "objective",
    "organization",
    "resource",
    "surface",
    "team",
    "work",
)


def _service_clients(client: OperatorClient | OperatorClientSync) -> list:
    return [getattr(client, name) for name in _SERVICES]


def _client_options(token: str | None) -> dict:
    return {
        "proto_json": True,
        "send_compression": None,
        "interceptors": (_Credential(token),),
    }


class _Credential:
    def __init__(self, token: str | None) -> None:
        self._authorization = None if token is None else f"Bearer {token}"

    def _apply(self, ctx: RequestContext) -> None:
        if self._authorization is not None:
            ctx.request_headers()["authorization"] = self._authorization

    async def on_start(self, ctx: RequestContext) -> None:
        self._apply(ctx)

    async def on_end(self, token: None, ctx: RequestContext, error: Exception | None) -> None:
        return None

    def on_start_sync(self, ctx: RequestContext) -> None:
        self._apply(ctx)

    def on_end_sync(self, token: None, ctx: RequestContext, error: Exception | None) -> None:
        return None


class OperatorClient:
    """Calls every operator service asynchronously.

    `url` is the Control Plane URL; only its origin is used. `token` is the admin token or an
    Operator Token; leave it unset for an RPC that accepts anonymous calls. Calls have no
    deadline unless one passes `timeout_ms`, so server streams such as `event.watch` stay open
    until they end or the caller stops reading.
    """

    def __init__(self, url: str, token: str | None = None) -> None:
        address = _origin(url)
        options = _client_options(token)
        self.access = AccessServiceClient(address, **options)
        self.conversation = ConversationServiceClient(address, **options)
        self.event = EventServiceClient(address, **options)
        self.host = HostServiceClient(address, **options)
        self.inbox = InboxServiceClient(address, **options)
        self.mailbox = MailboxServiceClient(address, **options)
        self.objective = ObjectiveServiceClient(address, **options)
        self.organization = OrganizationServiceClient(address, **options)
        self.resource = ResourceServiceClient(address, **options)
        self.surface = SurfaceServiceClient(address, **options)
        self.team = TeamServiceClient(address, **options)
        self.work = WorkServiceClient(address, **options)

    async def close(self) -> None:
        for client in _service_clients(self):
            await client.close()

    async def __aenter__(self) -> OperatorClient:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.close()


class OperatorClientSync:
    """Calls every operator service synchronously, with the same options as `OperatorClient`."""

    def __init__(self, url: str, token: str | None = None) -> None:
        address = _origin(url)
        options = _client_options(token)
        self.access = AccessServiceClientSync(address, **options)
        self.conversation = ConversationServiceClientSync(address, **options)
        self.event = EventServiceClientSync(address, **options)
        self.host = HostServiceClientSync(address, **options)
        self.inbox = InboxServiceClientSync(address, **options)
        self.mailbox = MailboxServiceClientSync(address, **options)
        self.objective = ObjectiveServiceClientSync(address, **options)
        self.organization = OrganizationServiceClientSync(address, **options)
        self.resource = ResourceServiceClientSync(address, **options)
        self.surface = SurfaceServiceClientSync(address, **options)
        self.team = TeamServiceClientSync(address, **options)
        self.work = WorkServiceClientSync(address, **options)

    def close(self) -> None:
        for client in _service_clients(self):
            client.close()

    def __enter__(self) -> OperatorClientSync:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()
