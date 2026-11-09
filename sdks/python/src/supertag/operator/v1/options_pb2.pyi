from google.protobuf import descriptor_pb2 as _descriptor_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor
ACTION_FIELD_NUMBER: _ClassVar[int]
action: _descriptor.FieldDescriptor
ALLOW_ANONYMOUS_FIELD_NUMBER: _ClassVar[int]
allow_anonymous: _descriptor.FieldDescriptor
REQUIRES_ADMIN_TOKEN_FIELD_NUMBER: _ClassVar[int]
requires_admin_token: _descriptor.FieldDescriptor
AUDIT_ACTION_FIELD_NUMBER: _ClassVar[int]
audit_action: _descriptor.FieldDescriptor
ALLOW_SCOPED_CREDENTIAL_FIELD_NUMBER: _ClassVar[int]
allow_scoped_credential: _descriptor.FieldDescriptor
REQUIRES_AUTH_KEY_FIELD_NUMBER: _ClassVar[int]
requires_auth_key: _descriptor.FieldDescriptor
ALLOW_WORKER_HOST_CREDENTIAL_FIELD_NUMBER: _ClassVar[int]
allow_worker_host_credential: _descriptor.FieldDescriptor
MANIFEST_FIELD_NUMBER: _ClassVar[int]
manifest: _descriptor.FieldDescriptor
MANIFEST_REQUIREMENTS_FIELD_NUMBER: _ClassVar[int]
manifest_requirements: _descriptor.FieldDescriptor
MANIFEST_FIELD_FIELD_NUMBER: _ClassVar[int]
manifest_field: _descriptor.FieldDescriptor
MANIFEST_ONEOF_FIELD_NUMBER: _ClassVar[int]
manifest_oneof: _descriptor.FieldDescriptor
MANIFEST_VALUE_FIELD_NUMBER: _ClassVar[int]
manifest_value: _descriptor.FieldDescriptor

class ManifestKind(_message.Message):
    __slots__ = ("kind", "name", "spec_optional")
    KIND_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    SPEC_OPTIONAL_FIELD_NUMBER: _ClassVar[int]
    kind: str
    name: ManifestField
    spec_optional: bool
    def __init__(self, kind: _Optional[str] = ..., name: _Optional[_Union[ManifestField, _Mapping]] = ..., spec_optional: _Optional[bool] = ...) -> None: ...

class ManifestField(_message.Message):
    __slots__ = ("required", "output_only", "pattern", "min_length", "max_length", "minimum", "maximum", "min_items", "max_items", "accepts_single")
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_ONLY_FIELD_NUMBER: _ClassVar[int]
    PATTERN_FIELD_NUMBER: _ClassVar[int]
    MIN_LENGTH_FIELD_NUMBER: _ClassVar[int]
    MAX_LENGTH_FIELD_NUMBER: _ClassVar[int]
    MINIMUM_FIELD_NUMBER: _ClassVar[int]
    MAXIMUM_FIELD_NUMBER: _ClassVar[int]
    MIN_ITEMS_FIELD_NUMBER: _ClassVar[int]
    MAX_ITEMS_FIELD_NUMBER: _ClassVar[int]
    ACCEPTS_SINGLE_FIELD_NUMBER: _ClassVar[int]
    required: bool
    output_only: bool
    pattern: str
    min_length: int
    max_length: int
    minimum: int
    maximum: int
    min_items: int
    max_items: int
    accepts_single: bool
    def __init__(self, required: _Optional[bool] = ..., output_only: _Optional[bool] = ..., pattern: _Optional[str] = ..., min_length: _Optional[int] = ..., max_length: _Optional[int] = ..., minimum: _Optional[int] = ..., maximum: _Optional[int] = ..., min_items: _Optional[int] = ..., max_items: _Optional[int] = ..., accepts_single: _Optional[bool] = ...) -> None: ...

class ManifestOneof(_message.Message):
    __slots__ = ("required", "field", "discriminator")
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    FIELD_FIELD_NUMBER: _ClassVar[int]
    DISCRIMINATOR_FIELD_NUMBER: _ClassVar[int]
    required: bool
    field: str
    discriminator: str
    def __init__(self, required: _Optional[bool] = ..., field: _Optional[str] = ..., discriminator: _Optional[str] = ...) -> None: ...

class ManifestRequirement(_message.Message):
    __slots__ = ("path", "equals", "required", "otherwise_required")
    PATH_FIELD_NUMBER: _ClassVar[int]
    EQUALS_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    OTHERWISE_REQUIRED_FIELD_NUMBER: _ClassVar[int]
    path: str
    equals: str
    required: _containers.RepeatedScalarFieldContainer[str]
    otherwise_required: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, path: _Optional[str] = ..., equals: _Optional[str] = ..., required: _Optional[_Iterable[str]] = ..., otherwise_required: _Optional[_Iterable[str]] = ...) -> None: ...
