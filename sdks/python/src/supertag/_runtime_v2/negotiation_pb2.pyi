from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ServiceRole(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SERVICE_ROLE_UNSPECIFIED: _ClassVar[ServiceRole]
    SERVICE_ROLE_CONTROL_PLANE: _ClassVar[ServiceRole]
    SERVICE_ROLE_GATEWAY: _ClassVar[ServiceRole]
    SERVICE_ROLE_WORKER_HOST: _ClassVar[ServiceRole]
    SERVICE_ROLE_OPERATOR: _ClassVar[ServiceRole]
SERVICE_ROLE_UNSPECIFIED: ServiceRole
SERVICE_ROLE_CONTROL_PLANE: ServiceRole
SERVICE_ROLE_GATEWAY: ServiceRole
SERVICE_ROLE_WORKER_HOST: ServiceRole
SERVICE_ROLE_OPERATOR: ServiceRole

class NegotiateProtocolRequest(_message.Message):
    __slots__ = ("role", "protocol_versions", "build_version")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    PROTOCOL_VERSIONS_FIELD_NUMBER: _ClassVar[int]
    BUILD_VERSION_FIELD_NUMBER: _ClassVar[int]
    role: ServiceRole
    protocol_versions: _containers.RepeatedScalarFieldContainer[int]
    build_version: str
    def __init__(self, role: _Optional[_Union[ServiceRole, str]] = ..., protocol_versions: _Optional[_Iterable[int]] = ..., build_version: _Optional[str] = ...) -> None: ...

class NegotiateProtocolResponse(_message.Message):
    __slots__ = ("role", "protocol_version", "protocol_versions", "build_version")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    PROTOCOL_VERSION_FIELD_NUMBER: _ClassVar[int]
    PROTOCOL_VERSIONS_FIELD_NUMBER: _ClassVar[int]
    BUILD_VERSION_FIELD_NUMBER: _ClassVar[int]
    role: ServiceRole
    protocol_version: int
    protocol_versions: _containers.RepeatedScalarFieldContainer[int]
    build_version: str
    def __init__(self, role: _Optional[_Union[ServiceRole, str]] = ..., protocol_version: _Optional[int] = ..., protocol_versions: _Optional[_Iterable[int]] = ..., build_version: _Optional[str] = ...) -> None: ...
