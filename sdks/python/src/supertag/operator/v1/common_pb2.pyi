import datetime

from google.protobuf import timestamp_pb2 as _timestamp_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ErrorReason(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ERROR_REASON_UNSPECIFIED: _ClassVar[ErrorReason]
    ERROR_REASON_UNAUTHENTICATED: _ClassVar[ErrorReason]
    ERROR_REASON_CREDENTIAL_REVOKED: _ClassVar[ErrorReason]
    ERROR_REASON_CREDENTIAL_EXPIRED: _ClassVar[ErrorReason]
    ERROR_REASON_PERMISSION_DENIED: _ClassVar[ErrorReason]
    ERROR_REASON_DRAINING: _ClassVar[ErrorReason]
    ERROR_REASON_INVALID_ARGUMENT: _ClassVar[ErrorReason]
    ERROR_REASON_NOT_FOUND: _ClassVar[ErrorReason]
    ERROR_REASON_CONFLICT: _ClassVar[ErrorReason]
    ERROR_REASON_INTERNAL: _ClassVar[ErrorReason]
    ERROR_REASON_UNAVAILABLE: _ClassVar[ErrorReason]
    ERROR_REASON_RESOURCE_EXHAUSTED: _ClassVar[ErrorReason]
ERROR_REASON_UNSPECIFIED: ErrorReason
ERROR_REASON_UNAUTHENTICATED: ErrorReason
ERROR_REASON_CREDENTIAL_REVOKED: ErrorReason
ERROR_REASON_CREDENTIAL_EXPIRED: ErrorReason
ERROR_REASON_PERMISSION_DENIED: ErrorReason
ERROR_REASON_DRAINING: ErrorReason
ERROR_REASON_INVALID_ARGUMENT: ErrorReason
ERROR_REASON_NOT_FOUND: ErrorReason
ERROR_REASON_CONFLICT: ErrorReason
ERROR_REASON_INTERNAL: ErrorReason
ERROR_REASON_UNAVAILABLE: ErrorReason
ERROR_REASON_RESOURCE_EXHAUSTED: ErrorReason

class Money(_message.Message):
    __slots__ = ("currency", "amount_minor")
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    AMOUNT_MINOR_FIELD_NUMBER: _ClassVar[int]
    currency: str
    amount_minor: int
    def __init__(self, currency: _Optional[str] = ..., amount_minor: _Optional[int] = ...) -> None: ...

class Metadata(_message.Message):
    __slots__ = ("id", "name", "resource_version", "created_at", "updated_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    RESOURCE_VERSION_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    resource_version: str
    created_at: _timestamp_pb2.Timestamp
    updated_at: _timestamp_pb2.Timestamp
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., resource_version: _Optional[str] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., updated_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class Heartbeat(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class FieldViolation(_message.Message):
    __slots__ = ("path", "description", "manager")
    PATH_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    MANAGER_FIELD_NUMBER: _ClassVar[int]
    path: str
    description: str
    manager: str
    def __init__(self, path: _Optional[str] = ..., description: _Optional[str] = ..., manager: _Optional[str] = ...) -> None: ...

class ErrorDetail(_message.Message):
    __slots__ = ("reason", "fields")
    REASON_FIELD_NUMBER: _ClassVar[int]
    FIELDS_FIELD_NUMBER: _ClassVar[int]
    reason: ErrorReason
    fields: _containers.RepeatedCompositeFieldContainer[FieldViolation]
    def __init__(self, reason: _Optional[_Union[ErrorReason, str]] = ..., fields: _Optional[_Iterable[_Union[FieldViolation, _Mapping]]] = ...) -> None: ...
