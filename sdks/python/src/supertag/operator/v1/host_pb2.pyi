import datetime

from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf import timestamp_pb2 as _timestamp_pb2
from supertag.operator.v1 import common_pb2 as _common_pb2
from supertag.operator.v1 import options_pb2 as _options_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class WorkerHostPhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WORKER_HOST_PHASE_UNSPECIFIED: _ClassVar[WorkerHostPhase]
    WORKER_HOST_PHASE_CONNECTED: _ClassVar[WorkerHostPhase]
    WORKER_HOST_PHASE_DRAINING: _ClassVar[WorkerHostPhase]
    WORKER_HOST_PHASE_READY: _ClassVar[WorkerHostPhase]
    WORKER_HOST_PHASE_REVOKED: _ClassVar[WorkerHostPhase]
    WORKER_HOST_PHASE_UNREACHABLE: _ClassVar[WorkerHostPhase]

class WorkerHostConnection(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WORKER_HOST_CONNECTION_UNSPECIFIED: _ClassVar[WorkerHostConnection]
    WORKER_HOST_CONNECTION_CONNECTED: _ClassVar[WorkerHostConnection]
    WORKER_HOST_CONNECTION_DISCONNECTED: _ClassVar[WorkerHostConnection]

class AuthKeyPhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    AUTH_KEY_PHASE_UNSPECIFIED: _ClassVar[AuthKeyPhase]
    AUTH_KEY_PHASE_ACTIVE: _ClassVar[AuthKeyPhase]
    AUTH_KEY_PHASE_USED: _ClassVar[AuthKeyPhase]
    AUTH_KEY_PHASE_EXPIRED: _ClassVar[AuthKeyPhase]
    AUTH_KEY_PHASE_REVOKED: _ClassVar[AuthKeyPhase]
WORKER_HOST_PHASE_UNSPECIFIED: WorkerHostPhase
WORKER_HOST_PHASE_CONNECTED: WorkerHostPhase
WORKER_HOST_PHASE_DRAINING: WorkerHostPhase
WORKER_HOST_PHASE_READY: WorkerHostPhase
WORKER_HOST_PHASE_REVOKED: WorkerHostPhase
WORKER_HOST_PHASE_UNREACHABLE: WorkerHostPhase
WORKER_HOST_CONNECTION_UNSPECIFIED: WorkerHostConnection
WORKER_HOST_CONNECTION_CONNECTED: WorkerHostConnection
WORKER_HOST_CONNECTION_DISCONNECTED: WorkerHostConnection
AUTH_KEY_PHASE_UNSPECIFIED: AuthKeyPhase
AUTH_KEY_PHASE_ACTIVE: AuthKeyPhase
AUTH_KEY_PHASE_USED: AuthKeyPhase
AUTH_KEY_PHASE_EXPIRED: AuthKeyPhase
AUTH_KEY_PHASE_REVOKED: AuthKeyPhase

class ListWorkerHostsRequest(_message.Message):
    __slots__ = ("page_size", "page_token")
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    page_size: int
    page_token: str
    def __init__(self, page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListWorkerHostsResponse(_message.Message):
    __slots__ = ("worker_hosts", "next_page_token")
    WORKER_HOSTS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    worker_hosts: _containers.RepeatedCompositeFieldContainer[WorkerHost]
    next_page_token: str
    def __init__(self, worker_hosts: _Optional[_Iterable[_Union[WorkerHost, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class GetWorkerHostRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class EnrollWorkerHostRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class RotateWorkerHostCredentialRequest(_message.Message):
    __slots__ = ("id", "expected_credential_revision")
    ID_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_CREDENTIAL_REVISION_FIELD_NUMBER: _ClassVar[int]
    id: str
    expected_credential_revision: int
    def __init__(self, id: _Optional[str] = ..., expected_credential_revision: _Optional[int] = ...) -> None: ...

class RevokeWorkerHostCredentialRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class DrainWorkerHostRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class ResumeWorkerHostRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class JoinWorkerHostRequest(_message.Message):
    __slots__ = ("name", "idempotency_key")
    NAME_FIELD_NUMBER: _ClassVar[int]
    IDEMPOTENCY_KEY_FIELD_NUMBER: _ClassVar[int]
    name: str
    idempotency_key: str
    def __init__(self, name: _Optional[str] = ..., idempotency_key: _Optional[str] = ...) -> None: ...

class JoinWorkerHostResponse(_message.Message):
    __slots__ = ("credential", "auth_key", "tags", "ephemeral")
    CREDENTIAL_FIELD_NUMBER: _ClassVar[int]
    AUTH_KEY_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    EPHEMERAL_FIELD_NUMBER: _ClassVar[int]
    credential: WorkerHostCredential
    auth_key: str
    tags: _containers.RepeatedScalarFieldContainer[str]
    ephemeral: bool
    def __init__(self, credential: _Optional[_Union[WorkerHostCredential, _Mapping]] = ..., auth_key: _Optional[str] = ..., tags: _Optional[_Iterable[str]] = ..., ephemeral: _Optional[bool] = ...) -> None: ...

class BindWorkerHostRequest(_message.Message):
    __slots__ = ("tag", "worker_host_id")
    TAG_FIELD_NUMBER: _ClassVar[int]
    WORKER_HOST_ID_FIELD_NUMBER: _ClassVar[int]
    tag: str
    worker_host_id: str
    def __init__(self, tag: _Optional[str] = ..., worker_host_id: _Optional[str] = ...) -> None: ...

class BindWorkerHostResponse(_message.Message):
    __slots__ = ("tag", "tag_id", "worker_hosts", "changed")
    TAG_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    WORKER_HOSTS_FIELD_NUMBER: _ClassVar[int]
    CHANGED_FIELD_NUMBER: _ClassVar[int]
    tag: str
    tag_id: str
    worker_hosts: _containers.RepeatedScalarFieldContainer[str]
    changed: bool
    def __init__(self, tag: _Optional[str] = ..., tag_id: _Optional[str] = ..., worker_hosts: _Optional[_Iterable[str]] = ..., changed: _Optional[bool] = ...) -> None: ...

class UnbindWorkerHostRequest(_message.Message):
    __slots__ = ("tag", "worker_host_id")
    TAG_FIELD_NUMBER: _ClassVar[int]
    WORKER_HOST_ID_FIELD_NUMBER: _ClassVar[int]
    tag: str
    worker_host_id: str
    def __init__(self, tag: _Optional[str] = ..., worker_host_id: _Optional[str] = ...) -> None: ...

class UnbindWorkerHostResponse(_message.Message):
    __slots__ = ("tag", "tag_id", "worker_hosts", "changed")
    TAG_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    WORKER_HOSTS_FIELD_NUMBER: _ClassVar[int]
    CHANGED_FIELD_NUMBER: _ClassVar[int]
    tag: str
    tag_id: str
    worker_hosts: _containers.RepeatedScalarFieldContainer[str]
    changed: bool
    def __init__(self, tag: _Optional[str] = ..., tag_id: _Optional[str] = ..., worker_hosts: _Optional[_Iterable[str]] = ..., changed: _Optional[bool] = ...) -> None: ...

class CreateAuthKeyRequest(_message.Message):
    __slots__ = ("name", "tags", "labels", "reusable", "ephemeral")
    NAME_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    LABELS_FIELD_NUMBER: _ClassVar[int]
    REUSABLE_FIELD_NUMBER: _ClassVar[int]
    EPHEMERAL_FIELD_NUMBER: _ClassVar[int]
    name: str
    tags: _containers.RepeatedScalarFieldContainer[str]
    labels: _containers.RepeatedScalarFieldContainer[str]
    reusable: bool
    ephemeral: bool
    def __init__(self, name: _Optional[str] = ..., tags: _Optional[_Iterable[str]] = ..., labels: _Optional[_Iterable[str]] = ..., reusable: _Optional[bool] = ..., ephemeral: _Optional[bool] = ...) -> None: ...

class CreateAuthKeyResponse(_message.Message):
    __slots__ = ("auth_key", "secret")
    AUTH_KEY_FIELD_NUMBER: _ClassVar[int]
    SECRET_FIELD_NUMBER: _ClassVar[int]
    auth_key: AuthKey
    secret: str
    def __init__(self, auth_key: _Optional[_Union[AuthKey, _Mapping]] = ..., secret: _Optional[str] = ...) -> None: ...

class ListAuthKeysRequest(_message.Message):
    __slots__ = ("page_size", "page_token")
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    page_size: int
    page_token: str
    def __init__(self, page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListAuthKeysResponse(_message.Message):
    __slots__ = ("auth_keys", "next_page_token")
    AUTH_KEYS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    auth_keys: _containers.RepeatedCompositeFieldContainer[AuthKey]
    next_page_token: str
    def __init__(self, auth_keys: _Optional[_Iterable[_Union[AuthKey, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class GetAuthKeyRequest(_message.Message):
    __slots__ = ("name",)
    NAME_FIELD_NUMBER: _ClassVar[int]
    name: str
    def __init__(self, name: _Optional[str] = ...) -> None: ...

class RevokeAuthKeyRequest(_message.Message):
    __slots__ = ("name",)
    NAME_FIELD_NUMBER: _ClassVar[int]
    name: str
    def __init__(self, name: _Optional[str] = ...) -> None: ...

class WorkerHost(_message.Message):
    __slots__ = ("metadata", "draining", "phase", "disk_space", "ephemeral", "storage", "auth_key", "credential_revision", "connection_generation", "connection_status", "worklet_id", "protocol_version", "durable_protocol_version", "control_protocol_version", "workers", "workspaces", "labels", "granted_labels", "ready", "last_authenticated_at", "failed_authentication_count", "last_authentication_failure_at", "last_seen_at", "connected_at", "disconnected_at", "revoked_at", "revocation_reason", "active_attempts", "capacity", "available_slots")
    METADATA_FIELD_NUMBER: _ClassVar[int]
    DRAINING_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    DISK_SPACE_FIELD_NUMBER: _ClassVar[int]
    EPHEMERAL_FIELD_NUMBER: _ClassVar[int]
    STORAGE_FIELD_NUMBER: _ClassVar[int]
    AUTH_KEY_FIELD_NUMBER: _ClassVar[int]
    CREDENTIAL_REVISION_FIELD_NUMBER: _ClassVar[int]
    CONNECTION_GENERATION_FIELD_NUMBER: _ClassVar[int]
    CONNECTION_STATUS_FIELD_NUMBER: _ClassVar[int]
    WORKLET_ID_FIELD_NUMBER: _ClassVar[int]
    PROTOCOL_VERSION_FIELD_NUMBER: _ClassVar[int]
    DURABLE_PROTOCOL_VERSION_FIELD_NUMBER: _ClassVar[int]
    CONTROL_PROTOCOL_VERSION_FIELD_NUMBER: _ClassVar[int]
    WORKERS_FIELD_NUMBER: _ClassVar[int]
    WORKSPACES_FIELD_NUMBER: _ClassVar[int]
    LABELS_FIELD_NUMBER: _ClassVar[int]
    GRANTED_LABELS_FIELD_NUMBER: _ClassVar[int]
    READY_FIELD_NUMBER: _ClassVar[int]
    LAST_AUTHENTICATED_AT_FIELD_NUMBER: _ClassVar[int]
    FAILED_AUTHENTICATION_COUNT_FIELD_NUMBER: _ClassVar[int]
    LAST_AUTHENTICATION_FAILURE_AT_FIELD_NUMBER: _ClassVar[int]
    LAST_SEEN_AT_FIELD_NUMBER: _ClassVar[int]
    CONNECTED_AT_FIELD_NUMBER: _ClassVar[int]
    DISCONNECTED_AT_FIELD_NUMBER: _ClassVar[int]
    REVOKED_AT_FIELD_NUMBER: _ClassVar[int]
    REVOCATION_REASON_FIELD_NUMBER: _ClassVar[int]
    ACTIVE_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    CAPACITY_FIELD_NUMBER: _ClassVar[int]
    AVAILABLE_SLOTS_FIELD_NUMBER: _ClassVar[int]
    metadata: _common_pb2.Metadata
    draining: bool
    phase: WorkerHostPhase
    disk_space: DiskSpace
    ephemeral: bool
    storage: WorkerHostStorage
    auth_key: str
    credential_revision: int
    connection_generation: int
    connection_status: WorkerHostConnection
    worklet_id: str
    protocol_version: int
    durable_protocol_version: int
    control_protocol_version: int
    workers: _containers.RepeatedCompositeFieldContainer[_struct_pb2.Struct]
    workspaces: _containers.RepeatedScalarFieldContainer[str]
    labels: _containers.RepeatedScalarFieldContainer[str]
    granted_labels: _containers.RepeatedScalarFieldContainer[str]
    ready: bool
    last_authenticated_at: _timestamp_pb2.Timestamp
    failed_authentication_count: int
    last_authentication_failure_at: _timestamp_pb2.Timestamp
    last_seen_at: _timestamp_pb2.Timestamp
    connected_at: _timestamp_pb2.Timestamp
    disconnected_at: _timestamp_pb2.Timestamp
    revoked_at: _timestamp_pb2.Timestamp
    revocation_reason: str
    active_attempts: int
    capacity: int
    available_slots: int
    def __init__(self, metadata: _Optional[_Union[_common_pb2.Metadata, _Mapping]] = ..., draining: _Optional[bool] = ..., phase: _Optional[_Union[WorkerHostPhase, str]] = ..., disk_space: _Optional[_Union[DiskSpace, _Mapping]] = ..., ephemeral: _Optional[bool] = ..., storage: _Optional[_Union[WorkerHostStorage, _Mapping]] = ..., auth_key: _Optional[str] = ..., credential_revision: _Optional[int] = ..., connection_generation: _Optional[int] = ..., connection_status: _Optional[_Union[WorkerHostConnection, str]] = ..., worklet_id: _Optional[str] = ..., protocol_version: _Optional[int] = ..., durable_protocol_version: _Optional[int] = ..., control_protocol_version: _Optional[int] = ..., workers: _Optional[_Iterable[_Union[_struct_pb2.Struct, _Mapping]]] = ..., workspaces: _Optional[_Iterable[str]] = ..., labels: _Optional[_Iterable[str]] = ..., granted_labels: _Optional[_Iterable[str]] = ..., ready: _Optional[bool] = ..., last_authenticated_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., failed_authentication_count: _Optional[int] = ..., last_authentication_failure_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., last_seen_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., connected_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., disconnected_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., revoked_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., revocation_reason: _Optional[str] = ..., active_attempts: _Optional[int] = ..., capacity: _Optional[int] = ..., available_slots: _Optional[int] = ...) -> None: ...

class DiskSpace(_message.Message):
    __slots__ = ("free_bytes", "total_bytes")
    FREE_BYTES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_BYTES_FIELD_NUMBER: _ClassVar[int]
    free_bytes: int
    total_bytes: int
    def __init__(self, free_bytes: _Optional[int] = ..., total_bytes: _Optional[int] = ...) -> None: ...

class WorkerHostStorage(_message.Message):
    __slots__ = ("sandboxes", "placement_unknown")
    SANDBOXES_FIELD_NUMBER: _ClassVar[int]
    PLACEMENT_UNKNOWN_FIELD_NUMBER: _ClassVar[int]
    sandboxes: _containers.RepeatedScalarFieldContainer[str]
    placement_unknown: bool
    def __init__(self, sandboxes: _Optional[_Iterable[str]] = ..., placement_unknown: _Optional[bool] = ...) -> None: ...

class WorkerHostCredential(_message.Message):
    __slots__ = ("worker_host_id", "issued_at", "token")
    WORKER_HOST_ID_FIELD_NUMBER: _ClassVar[int]
    ISSUED_AT_FIELD_NUMBER: _ClassVar[int]
    TOKEN_FIELD_NUMBER: _ClassVar[int]
    worker_host_id: str
    issued_at: _timestamp_pb2.Timestamp
    token: str
    def __init__(self, worker_host_id: _Optional[str] = ..., issued_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., token: _Optional[str] = ...) -> None: ...

class AuthKey(_message.Message):
    __slots__ = ("metadata", "tags", "labels", "reusable", "ephemeral", "phase", "expires_at", "used_at", "redemption_count", "revoked_at")
    METADATA_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    LABELS_FIELD_NUMBER: _ClassVar[int]
    REUSABLE_FIELD_NUMBER: _ClassVar[int]
    EPHEMERAL_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    EXPIRES_AT_FIELD_NUMBER: _ClassVar[int]
    USED_AT_FIELD_NUMBER: _ClassVar[int]
    REDEMPTION_COUNT_FIELD_NUMBER: _ClassVar[int]
    REVOKED_AT_FIELD_NUMBER: _ClassVar[int]
    metadata: _common_pb2.Metadata
    tags: _containers.RepeatedScalarFieldContainer[str]
    labels: _containers.RepeatedScalarFieldContainer[str]
    reusable: bool
    ephemeral: bool
    phase: AuthKeyPhase
    expires_at: _timestamp_pb2.Timestamp
    used_at: _timestamp_pb2.Timestamp
    redemption_count: int
    revoked_at: _timestamp_pb2.Timestamp
    def __init__(self, metadata: _Optional[_Union[_common_pb2.Metadata, _Mapping]] = ..., tags: _Optional[_Iterable[str]] = ..., labels: _Optional[_Iterable[str]] = ..., reusable: _Optional[bool] = ..., ephemeral: _Optional[bool] = ..., phase: _Optional[_Union[AuthKeyPhase, str]] = ..., expires_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., used_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., redemption_count: _Optional[int] = ..., revoked_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...
