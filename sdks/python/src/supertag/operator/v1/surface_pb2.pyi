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

class SetKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SET_KIND_UNSPECIFIED: _ClassVar[SetKind]
    SET_KIND_CONTEXT_SET: _ClassVar[SetKind]
    SET_KIND_PERMISSION_SET: _ClassVar[SetKind]

class SurfaceProvider(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SURFACE_PROVIDER_UNSPECIFIED: _ClassVar[SurfaceProvider]
    SURFACE_PROVIDER_SLACK: _ClassVar[SurfaceProvider]
    SURFACE_PROVIDER_GITHUB: _ClassVar[SurfaceProvider]
    SURFACE_PROVIDER_LARK: _ClassVar[SurfaceProvider]
    SURFACE_PROVIDER_LINEAR: _ClassVar[SurfaceProvider]
    SURFACE_PROVIDER_TEAMS: _ClassVar[SurfaceProvider]

class SurfaceAccountPhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SURFACE_ACCOUNT_PHASE_UNSPECIFIED: _ClassVar[SurfaceAccountPhase]
    SURFACE_ACCOUNT_PHASE_CONNECTED: _ClassVar[SurfaceAccountPhase]
    SURFACE_ACCOUNT_PHASE_RETIRED: _ClassVar[SurfaceAccountPhase]
SET_KIND_UNSPECIFIED: SetKind
SET_KIND_CONTEXT_SET: SetKind
SET_KIND_PERMISSION_SET: SetKind
SURFACE_PROVIDER_UNSPECIFIED: SurfaceProvider
SURFACE_PROVIDER_SLACK: SurfaceProvider
SURFACE_PROVIDER_GITHUB: SurfaceProvider
SURFACE_PROVIDER_LARK: SurfaceProvider
SURFACE_PROVIDER_LINEAR: SurfaceProvider
SURFACE_PROVIDER_TEAMS: SurfaceProvider
SURFACE_ACCOUNT_PHASE_UNSPECIFIED: SurfaceAccountPhase
SURFACE_ACCOUNT_PHASE_CONNECTED: SurfaceAccountPhase
SURFACE_ACCOUNT_PHASE_RETIRED: SurfaceAccountPhase

class SetUpSurfaceRequest(_message.Message):
    __slots__ = ("provider", "external_account_id", "display_name", "auth_method", "configuration", "secrets")
    class SecretsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    EXTERNAL_ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    DISPLAY_NAME_FIELD_NUMBER: _ClassVar[int]
    AUTH_METHOD_FIELD_NUMBER: _ClassVar[int]
    CONFIGURATION_FIELD_NUMBER: _ClassVar[int]
    SECRETS_FIELD_NUMBER: _ClassVar[int]
    provider: SurfaceProvider
    external_account_id: str
    display_name: str
    auth_method: str
    configuration: _struct_pb2.Struct
    secrets: _containers.ScalarMap[str, str]
    def __init__(self, provider: _Optional[_Union[SurfaceProvider, str]] = ..., external_account_id: _Optional[str] = ..., display_name: _Optional[str] = ..., auth_method: _Optional[str] = ..., configuration: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., secrets: _Optional[_Mapping[str, str]] = ...) -> None: ...

class ListSurfaceAccountsRequest(_message.Message):
    __slots__ = ("page_size", "page_token")
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    page_size: int
    page_token: str
    def __init__(self, page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListSurfaceAccountsResponse(_message.Message):
    __slots__ = ("surface_accounts", "next_page_token")
    SURFACE_ACCOUNTS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    surface_accounts: _containers.RepeatedCompositeFieldContainer[SurfaceAccount]
    next_page_token: str
    def __init__(self, surface_accounts: _Optional[_Iterable[_Union[SurfaceAccount, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class GetSurfaceAccountRequest(_message.Message):
    __slots__ = ("name",)
    NAME_FIELD_NUMBER: _ClassVar[int]
    name: str
    def __init__(self, name: _Optional[str] = ...) -> None: ...

class AddTagLocationRequest(_message.Message):
    __slots__ = ("tag", "location")
    TAG_FIELD_NUMBER: _ClassVar[int]
    LOCATION_FIELD_NUMBER: _ClassVar[int]
    tag: str
    location: SurfaceLocation
    def __init__(self, tag: _Optional[str] = ..., location: _Optional[_Union[SurfaceLocation, _Mapping]] = ...) -> None: ...

class RemoveTagLocationRequest(_message.Message):
    __slots__ = ("tag", "location")
    TAG_FIELD_NUMBER: _ClassVar[int]
    LOCATION_FIELD_NUMBER: _ClassVar[int]
    tag: str
    location: SurfaceLocation
    def __init__(self, tag: _Optional[str] = ..., location: _Optional[_Union[SurfaceLocation, _Mapping]] = ...) -> None: ...

class ActivateSetRequest(_message.Message):
    __slots__ = ("kind", "set", "tag", "location")
    KIND_FIELD_NUMBER: _ClassVar[int]
    SET_FIELD_NUMBER: _ClassVar[int]
    TAG_FIELD_NUMBER: _ClassVar[int]
    LOCATION_FIELD_NUMBER: _ClassVar[int]
    kind: SetKind
    set: str
    tag: str
    location: SurfaceLocation
    def __init__(self, kind: _Optional[_Union[SetKind, str]] = ..., set: _Optional[str] = ..., tag: _Optional[str] = ..., location: _Optional[_Union[SurfaceLocation, _Mapping]] = ...) -> None: ...

class DeactivateSetRequest(_message.Message):
    __slots__ = ("kind", "set", "tag", "location")
    KIND_FIELD_NUMBER: _ClassVar[int]
    SET_FIELD_NUMBER: _ClassVar[int]
    TAG_FIELD_NUMBER: _ClassVar[int]
    LOCATION_FIELD_NUMBER: _ClassVar[int]
    kind: SetKind
    set: str
    tag: str
    location: SurfaceLocation
    def __init__(self, kind: _Optional[_Union[SetKind, str]] = ..., set: _Optional[str] = ..., tag: _Optional[str] = ..., location: _Optional[_Union[SurfaceLocation, _Mapping]] = ...) -> None: ...

class SurfaceLocation(_message.Message):
    __slots__ = ("provider", "account", "channel_id", "chat_id", "team_id", "team", "repo_id", "repo")
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    ACCOUNT_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    CHAT_ID_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    TEAM_FIELD_NUMBER: _ClassVar[int]
    REPO_ID_FIELD_NUMBER: _ClassVar[int]
    REPO_FIELD_NUMBER: _ClassVar[int]
    provider: SurfaceProvider
    account: str
    channel_id: str
    chat_id: str
    team_id: str
    team: str
    repo_id: str
    repo: str
    def __init__(self, provider: _Optional[_Union[SurfaceProvider, str]] = ..., account: _Optional[str] = ..., channel_id: _Optional[str] = ..., chat_id: _Optional[str] = ..., team_id: _Optional[str] = ..., team: _Optional[str] = ..., repo_id: _Optional[str] = ..., repo: _Optional[str] = ...) -> None: ...

class TagLocationChange(_message.Message):
    __slots__ = ("tag", "tag_id", "provider", "location", "surface_account_id", "account_display_name", "changed")
    TAG_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    LOCATION_FIELD_NUMBER: _ClassVar[int]
    SURFACE_ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    ACCOUNT_DISPLAY_NAME_FIELD_NUMBER: _ClassVar[int]
    CHANGED_FIELD_NUMBER: _ClassVar[int]
    tag: str
    tag_id: str
    provider: SurfaceProvider
    location: str
    surface_account_id: str
    account_display_name: str
    changed: bool
    def __init__(self, tag: _Optional[str] = ..., tag_id: _Optional[str] = ..., provider: _Optional[_Union[SurfaceProvider, str]] = ..., location: _Optional[str] = ..., surface_account_id: _Optional[str] = ..., account_display_name: _Optional[str] = ..., changed: _Optional[bool] = ...) -> None: ...

class SetActivationChange(_message.Message):
    __slots__ = ("kind", "set", "tag", "provider", "location", "surface_account_id")
    KIND_FIELD_NUMBER: _ClassVar[int]
    SET_FIELD_NUMBER: _ClassVar[int]
    TAG_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    LOCATION_FIELD_NUMBER: _ClassVar[int]
    SURFACE_ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    kind: SetKind
    set: str
    tag: str
    provider: SurfaceProvider
    location: str
    surface_account_id: str
    def __init__(self, kind: _Optional[_Union[SetKind, str]] = ..., set: _Optional[str] = ..., tag: _Optional[str] = ..., provider: _Optional[_Union[SurfaceProvider, str]] = ..., location: _Optional[str] = ..., surface_account_id: _Optional[str] = ...) -> None: ...

class SurfaceAccount(_message.Message):
    __slots__ = ("metadata", "provider", "external_account_id", "display_name", "auth_method", "configuration", "secrets", "phase", "last_verified_at")
    METADATA_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    EXTERNAL_ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    DISPLAY_NAME_FIELD_NUMBER: _ClassVar[int]
    AUTH_METHOD_FIELD_NUMBER: _ClassVar[int]
    CONFIGURATION_FIELD_NUMBER: _ClassVar[int]
    SECRETS_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    LAST_VERIFIED_AT_FIELD_NUMBER: _ClassVar[int]
    metadata: _common_pb2.Metadata
    provider: SurfaceProvider
    external_account_id: str
    display_name: str
    auth_method: str
    configuration: _struct_pb2.Struct
    secrets: SurfaceSecretReferences
    phase: SurfaceAccountPhase
    last_verified_at: _timestamp_pb2.Timestamp
    def __init__(self, metadata: _Optional[_Union[_common_pb2.Metadata, _Mapping]] = ..., provider: _Optional[_Union[SurfaceProvider, str]] = ..., external_account_id: _Optional[str] = ..., display_name: _Optional[str] = ..., auth_method: _Optional[str] = ..., configuration: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., secrets: _Optional[_Union[SurfaceSecretReferences, _Mapping]] = ..., phase: _Optional[_Union[SurfaceAccountPhase, str]] = ..., last_verified_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class SurfaceSecretReferences(_message.Message):
    __slots__ = ("references",)
    class ReferencesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: SurfaceSecretReference
        def __init__(self, key: _Optional[str] = ..., value: _Optional[_Union[SurfaceSecretReference, _Mapping]] = ...) -> None: ...
    REFERENCES_FIELD_NUMBER: _ClassVar[int]
    references: _containers.MessageMap[str, SurfaceSecretReference]
    def __init__(self, references: _Optional[_Mapping[str, SurfaceSecretReference]] = ...) -> None: ...

class SurfaceSecretReference(_message.Message):
    __slots__ = ("secret_ref", "env", "file")
    SECRET_REF_FIELD_NUMBER: _ClassVar[int]
    ENV_FIELD_NUMBER: _ClassVar[int]
    FILE_FIELD_NUMBER: _ClassVar[int]
    secret_ref: str
    env: str
    file: str
    def __init__(self, secret_ref: _Optional[str] = ..., env: _Optional[str] = ..., file: _Optional[str] = ...) -> None: ...
