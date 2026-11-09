import datetime

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

class OperatorTokenPhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OPERATOR_TOKEN_PHASE_UNSPECIFIED: _ClassVar[OperatorTokenPhase]
    OPERATOR_TOKEN_PHASE_ACTIVE: _ClassVar[OperatorTokenPhase]
    OPERATOR_TOKEN_PHASE_EXPIRED: _ClassVar[OperatorTokenPhase]
    OPERATOR_TOKEN_PHASE_REVOKED: _ClassVar[OperatorTokenPhase]
OPERATOR_TOKEN_PHASE_UNSPECIFIED: OperatorTokenPhase
OPERATOR_TOKEN_PHASE_ACTIVE: OperatorTokenPhase
OPERATOR_TOKEN_PHASE_EXPIRED: OperatorTokenPhase
OPERATOR_TOKEN_PHASE_REVOKED: OperatorTokenPhase

class CreateOperatorTokenRequest(_message.Message):
    __slots__ = ("name",)
    NAME_FIELD_NUMBER: _ClassVar[int]
    name: str
    def __init__(self, name: _Optional[str] = ...) -> None: ...

class CreateOperatorTokenResponse(_message.Message):
    __slots__ = ("operator_token", "secret")
    OPERATOR_TOKEN_FIELD_NUMBER: _ClassVar[int]
    SECRET_FIELD_NUMBER: _ClassVar[int]
    operator_token: OperatorToken
    secret: str
    def __init__(self, operator_token: _Optional[_Union[OperatorToken, _Mapping]] = ..., secret: _Optional[str] = ...) -> None: ...

class ListOperatorTokensRequest(_message.Message):
    __slots__ = ("page_size", "page_token")
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    page_size: int
    page_token: str
    def __init__(self, page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListOperatorTokensResponse(_message.Message):
    __slots__ = ("operator_tokens", "next_page_token")
    OPERATOR_TOKENS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    operator_tokens: _containers.RepeatedCompositeFieldContainer[OperatorToken]
    next_page_token: str
    def __init__(self, operator_tokens: _Optional[_Iterable[_Union[OperatorToken, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class GetOperatorTokenRequest(_message.Message):
    __slots__ = ("name",)
    NAME_FIELD_NUMBER: _ClassVar[int]
    name: str
    def __init__(self, name: _Optional[str] = ...) -> None: ...

class RevokeOperatorTokenRequest(_message.Message):
    __slots__ = ("name",)
    NAME_FIELD_NUMBER: _ClassVar[int]
    name: str
    def __init__(self, name: _Optional[str] = ...) -> None: ...

class OperatorToken(_message.Message):
    __slots__ = ("metadata", "phase", "operator_id", "expires_at", "last_used_at", "revoked_at")
    METADATA_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    OPERATOR_ID_FIELD_NUMBER: _ClassVar[int]
    EXPIRES_AT_FIELD_NUMBER: _ClassVar[int]
    LAST_USED_AT_FIELD_NUMBER: _ClassVar[int]
    REVOKED_AT_FIELD_NUMBER: _ClassVar[int]
    metadata: _common_pb2.Metadata
    phase: OperatorTokenPhase
    operator_id: str
    expires_at: _timestamp_pb2.Timestamp
    last_used_at: _timestamp_pb2.Timestamp
    revoked_at: _timestamp_pb2.Timestamp
    def __init__(self, metadata: _Optional[_Union[_common_pb2.Metadata, _Mapping]] = ..., phase: _Optional[_Union[OperatorTokenPhase, str]] = ..., operator_id: _Optional[str] = ..., expires_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., last_used_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., revoked_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...
