from supertag.runtime.v2 import runtime_pb2 as _runtime_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class RevokeAuthKeyRequest(_message.Message):
    __slots__ = ("name",)
    NAME_FIELD_NUMBER: _ClassVar[int]
    name: str
    def __init__(self, name: _Optional[str] = ...) -> None: ...

class GetAuthKeyRequest(_message.Message):
    __slots__ = ("name",)
    NAME_FIELD_NUMBER: _ClassVar[int]
    name: str
    def __init__(self, name: _Optional[str] = ...) -> None: ...

class ListAuthKeysRequest(_message.Message):
    __slots__ = ("limit", "cursor")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    limit: int
    cursor: str
    def __init__(self, limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListAuthKeysResponse(_message.Message):
    __slots__ = ("auth_keys", "next_cursor")
    AUTH_KEYS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    auth_keys: _containers.RepeatedCompositeFieldContainer[_runtime_pb2.AuthKey]
    next_cursor: str
    def __init__(self, auth_keys: _Optional[_Iterable[_Union[_runtime_pb2.AuthKey, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class EnrollRequest(_message.Message):
    __slots__ = ("role", "name", "operation_id", "token_digest")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TOKEN_DIGEST_FIELD_NUMBER: _ClassVar[int]
    role: _runtime_pb2.PrincipalRole
    name: str
    operation_id: str
    token_digest: bytes
    def __init__(self, role: _Optional[_Union[_runtime_pb2.PrincipalRole, str]] = ..., name: _Optional[str] = ..., operation_id: _Optional[str] = ..., token_digest: _Optional[bytes] = ...) -> None: ...

class Enrollment(_message.Message):
    __slots__ = ("role", "name", "principal", "auth_key_name", "enrolled_at_ms", "last_used_at_ms", "revoked_at_ms", "credential_revision", "allowed_tag_ids", "all_tags")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    PRINCIPAL_FIELD_NUMBER: _ClassVar[int]
    AUTH_KEY_NAME_FIELD_NUMBER: _ClassVar[int]
    ENROLLED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    LAST_USED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    REVOKED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    CREDENTIAL_REVISION_FIELD_NUMBER: _ClassVar[int]
    ALLOWED_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    ALL_TAGS_FIELD_NUMBER: _ClassVar[int]
    role: _runtime_pb2.PrincipalRole
    name: str
    principal: str
    auth_key_name: str
    enrolled_at_ms: int
    last_used_at_ms: int
    revoked_at_ms: int
    credential_revision: int
    allowed_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    all_tags: bool
    def __init__(self, role: _Optional[_Union[_runtime_pb2.PrincipalRole, str]] = ..., name: _Optional[str] = ..., principal: _Optional[str] = ..., auth_key_name: _Optional[str] = ..., enrolled_at_ms: _Optional[int] = ..., last_used_at_ms: _Optional[int] = ..., revoked_at_ms: _Optional[int] = ..., credential_revision: _Optional[int] = ..., allowed_tag_ids: _Optional[_Iterable[str]] = ..., all_tags: _Optional[bool] = ...) -> None: ...

class WhoAmIRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class WhoAmIResponse(_message.Message):
    __slots__ = ("role", "principal", "admin")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    PRINCIPAL_FIELD_NUMBER: _ClassVar[int]
    ADMIN_FIELD_NUMBER: _ClassVar[int]
    role: _runtime_pb2.PrincipalRole
    principal: str
    admin: bool
    def __init__(self, role: _Optional[_Union[_runtime_pb2.PrincipalRole, str]] = ..., principal: _Optional[str] = ..., admin: _Optional[bool] = ...) -> None: ...

class RotateCredentialRequest(_message.Message):
    __slots__ = ("role", "name", "expected_credential_revision", "token_digest")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_CREDENTIAL_REVISION_FIELD_NUMBER: _ClassVar[int]
    TOKEN_DIGEST_FIELD_NUMBER: _ClassVar[int]
    role: _runtime_pb2.PrincipalRole
    name: str
    expected_credential_revision: int
    token_digest: bytes
    def __init__(self, role: _Optional[_Union[_runtime_pb2.PrincipalRole, str]] = ..., name: _Optional[str] = ..., expected_credential_revision: _Optional[int] = ..., token_digest: _Optional[bytes] = ...) -> None: ...

class CredentialRotation(_message.Message):
    __slots__ = ("principal", "credential_revision")
    PRINCIPAL_FIELD_NUMBER: _ClassVar[int]
    CREDENTIAL_REVISION_FIELD_NUMBER: _ClassVar[int]
    principal: str
    credential_revision: int
    def __init__(self, principal: _Optional[str] = ..., credential_revision: _Optional[int] = ...) -> None: ...

class GetEnrollmentRequest(_message.Message):
    __slots__ = ("role", "name")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    role: _runtime_pb2.PrincipalRole
    name: str
    def __init__(self, role: _Optional[_Union[_runtime_pb2.PrincipalRole, str]] = ..., name: _Optional[str] = ...) -> None: ...

class ListEnrollmentsRequest(_message.Message):
    __slots__ = ("role", "limit", "cursor")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    role: _runtime_pb2.PrincipalRole
    limit: int
    cursor: str
    def __init__(self, role: _Optional[_Union[_runtime_pb2.PrincipalRole, str]] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListEnrollmentsResponse(_message.Message):
    __slots__ = ("enrollments", "next_cursor")
    ENROLLMENTS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    enrollments: _containers.RepeatedCompositeFieldContainer[Enrollment]
    next_cursor: str
    def __init__(self, enrollments: _Optional[_Iterable[_Union[Enrollment, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class RevokeEnrollmentRequest(_message.Message):
    __slots__ = ("role", "name")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    role: _runtime_pb2.PrincipalRole
    name: str
    def __init__(self, role: _Optional[_Union[_runtime_pb2.PrincipalRole, str]] = ..., name: _Optional[str] = ...) -> None: ...

class ResolveCredentialRequest(_message.Message):
    __slots__ = ("token_digest", "kind")
    TOKEN_DIGEST_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    token_digest: bytes
    kind: _runtime_pb2.PrincipalRole
    def __init__(self, token_digest: _Optional[bytes] = ..., kind: _Optional[_Union[_runtime_pb2.PrincipalRole, str]] = ...) -> None: ...

class ResolvedCredential(_message.Message):
    __slots__ = ("role", "name", "generation")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    role: _runtime_pb2.PrincipalRole
    name: str
    generation: int
    def __init__(self, role: _Optional[_Union[_runtime_pb2.PrincipalRole, str]] = ..., name: _Optional[str] = ..., generation: _Optional[int] = ...) -> None: ...

class SetTagRunsOnRequest(_message.Message):
    __slots__ = ("tag_id", "runs_on")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    RUNS_ON_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    runs_on: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, tag_id: _Optional[str] = ..., runs_on: _Optional[_Iterable[str]] = ...) -> None: ...

class DiagnoseTaskPlacementRequest(_message.Message):
    __slots__ = ("task_id",)
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    def __init__(self, task_id: _Optional[str] = ...) -> None: ...

class HostPlacement(_message.Message):
    __slots__ = ("host_id", "phase", "labels", "missing_labels", "eligible")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    LABELS_FIELD_NUMBER: _ClassVar[int]
    MISSING_LABELS_FIELD_NUMBER: _ClassVar[int]
    ELIGIBLE_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    phase: _runtime_pb2.HostPhase
    labels: _containers.RepeatedScalarFieldContainer[str]
    missing_labels: _containers.RepeatedScalarFieldContainer[str]
    eligible: bool
    def __init__(self, host_id: _Optional[str] = ..., phase: _Optional[_Union[_runtime_pb2.HostPhase, str]] = ..., labels: _Optional[_Iterable[str]] = ..., missing_labels: _Optional[_Iterable[str]] = ..., eligible: _Optional[bool] = ...) -> None: ...

class TaskPlacementDiagnosis(_message.Message):
    __slots__ = ("task_id", "tag_id", "state", "required_labels", "missing_labels", "requirement", "summary", "hosts")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_LABELS_FIELD_NUMBER: _ClassVar[int]
    MISSING_LABELS_FIELD_NUMBER: _ClassVar[int]
    REQUIREMENT_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    HOSTS_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    tag_id: str
    state: _runtime_pb2.TaskState
    required_labels: _containers.RepeatedScalarFieldContainer[str]
    missing_labels: _containers.RepeatedScalarFieldContainer[str]
    requirement: str
    summary: str
    hosts: _containers.RepeatedCompositeFieldContainer[HostPlacement]
    def __init__(self, task_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., state: _Optional[_Union[_runtime_pb2.TaskState, str]] = ..., required_labels: _Optional[_Iterable[str]] = ..., missing_labels: _Optional[_Iterable[str]] = ..., requirement: _Optional[str] = ..., summary: _Optional[str] = ..., hosts: _Optional[_Iterable[_Union[HostPlacement, _Mapping]]] = ...) -> None: ...
