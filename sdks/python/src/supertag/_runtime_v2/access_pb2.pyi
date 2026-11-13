from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class OperatorTokenPhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OPERATOR_TOKEN_PHASE_UNSPECIFIED: _ClassVar[OperatorTokenPhase]
    OPERATOR_TOKEN_PHASE_ACTIVE: _ClassVar[OperatorTokenPhase]
    OPERATOR_TOKEN_PHASE_EXPIRED: _ClassVar[OperatorTokenPhase]
    OPERATOR_TOKEN_PHASE_REVOKED: _ClassVar[OperatorTokenPhase]

class AuditOutcome(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    AUDIT_OUTCOME_UNSPECIFIED: _ClassVar[AuditOutcome]
    AUDIT_OUTCOME_SUCCEEDED: _ClassVar[AuditOutcome]
    AUDIT_OUTCOME_FAILED: _ClassVar[AuditOutcome]
OPERATOR_TOKEN_PHASE_UNSPECIFIED: OperatorTokenPhase
OPERATOR_TOKEN_PHASE_ACTIVE: OperatorTokenPhase
OPERATOR_TOKEN_PHASE_EXPIRED: OperatorTokenPhase
OPERATOR_TOKEN_PHASE_REVOKED: OperatorTokenPhase
AUDIT_OUTCOME_UNSPECIFIED: AuditOutcome
AUDIT_OUTCOME_SUCCEEDED: AuditOutcome
AUDIT_OUTCOME_FAILED: AuditOutcome

class CreateOperatorTokenRequest(_message.Message):
    __slots__ = ("name", "operation_id", "secret_digest")
    NAME_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    SECRET_DIGEST_FIELD_NUMBER: _ClassVar[int]
    name: str
    operation_id: str
    secret_digest: bytes
    def __init__(self, name: _Optional[str] = ..., operation_id: _Optional[str] = ..., secret_digest: _Optional[bytes] = ...) -> None: ...

class GetOperatorTokenRequest(_message.Message):
    __slots__ = ("name",)
    NAME_FIELD_NUMBER: _ClassVar[int]
    name: str
    def __init__(self, name: _Optional[str] = ...) -> None: ...

class ListOperatorTokensRequest(_message.Message):
    __slots__ = ("limit", "cursor")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    limit: int
    cursor: str
    def __init__(self, limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListOperatorTokensResponse(_message.Message):
    __slots__ = ("tokens", "next_cursor")
    TOKENS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    tokens: _containers.RepeatedCompositeFieldContainer[OperatorToken]
    next_cursor: str
    def __init__(self, tokens: _Optional[_Iterable[_Union[OperatorToken, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class RotateOperatorTokenRequest(_message.Message):
    __slots__ = ("name", "operation_id", "secret_digest")
    NAME_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    SECRET_DIGEST_FIELD_NUMBER: _ClassVar[int]
    name: str
    operation_id: str
    secret_digest: bytes
    def __init__(self, name: _Optional[str] = ..., operation_id: _Optional[str] = ..., secret_digest: _Optional[bytes] = ...) -> None: ...

class RevokeOperatorTokenRequest(_message.Message):
    __slots__ = ("name",)
    NAME_FIELD_NUMBER: _ClassVar[int]
    name: str
    def __init__(self, name: _Optional[str] = ...) -> None: ...

class OperatorToken(_message.Message):
    __slots__ = ("name", "operator_id", "phase", "created_at_ms", "expires_at_ms", "last_used_at_ms", "revoked_at_ms", "rotated_at_ms", "secret_revision", "created_by")
    NAME_FIELD_NUMBER: _ClassVar[int]
    OPERATOR_ID_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    EXPIRES_AT_MS_FIELD_NUMBER: _ClassVar[int]
    LAST_USED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    REVOKED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    ROTATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    SECRET_REVISION_FIELD_NUMBER: _ClassVar[int]
    CREATED_BY_FIELD_NUMBER: _ClassVar[int]
    name: str
    operator_id: str
    phase: OperatorTokenPhase
    created_at_ms: int
    expires_at_ms: int
    last_used_at_ms: int
    revoked_at_ms: int
    rotated_at_ms: int
    secret_revision: int
    created_by: str
    def __init__(self, name: _Optional[str] = ..., operator_id: _Optional[str] = ..., phase: _Optional[_Union[OperatorTokenPhase, str]] = ..., created_at_ms: _Optional[int] = ..., expires_at_ms: _Optional[int] = ..., last_used_at_ms: _Optional[int] = ..., revoked_at_ms: _Optional[int] = ..., rotated_at_ms: _Optional[int] = ..., secret_revision: _Optional[int] = ..., created_by: _Optional[str] = ...) -> None: ...

class AuthenticateOperatorRequest(_message.Message):
    __slots__ = ("token_digest",)
    TOKEN_DIGEST_FIELD_NUMBER: _ClassVar[int]
    token_digest: bytes
    def __init__(self, token_digest: _Optional[bytes] = ...) -> None: ...

class OperatorIdentity(_message.Message):
    __slots__ = ("operator_id",)
    OPERATOR_ID_FIELD_NUMBER: _ClassVar[int]
    operator_id: str
    def __init__(self, operator_id: _Optional[str] = ...) -> None: ...

class AuditEntry(_message.Message):
    __slots__ = ("id", "at_ms", "actor", "action", "target", "outcome", "code", "method")
    ID_FIELD_NUMBER: _ClassVar[int]
    AT_MS_FIELD_NUMBER: _ClassVar[int]
    ACTOR_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    TARGET_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    CODE_FIELD_NUMBER: _ClassVar[int]
    METHOD_FIELD_NUMBER: _ClassVar[int]
    id: str
    at_ms: int
    actor: str
    action: str
    target: str
    outcome: AuditOutcome
    code: str
    method: str
    def __init__(self, id: _Optional[str] = ..., at_ms: _Optional[int] = ..., actor: _Optional[str] = ..., action: _Optional[str] = ..., target: _Optional[str] = ..., outcome: _Optional[_Union[AuditOutcome, str]] = ..., code: _Optional[str] = ..., method: _Optional[str] = ...) -> None: ...

class ListAuditEntriesRequest(_message.Message):
    __slots__ = ("since_ms", "actor", "limit", "cursor")
    SINCE_MS_FIELD_NUMBER: _ClassVar[int]
    ACTOR_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    since_ms: int
    actor: str
    limit: int
    cursor: str
    def __init__(self, since_ms: _Optional[int] = ..., actor: _Optional[str] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListAuditEntriesResponse(_message.Message):
    __slots__ = ("entries", "next_cursor")
    ENTRIES_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    entries: _containers.RepeatedCompositeFieldContainer[AuditEntry]
    next_cursor: str
    def __init__(self, entries: _Optional[_Iterable[_Union[AuditEntry, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...
