from . import runtime_pb2 as _runtime_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class MemoryState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    MEMORY_STATE_UNSPECIFIED: _ClassVar[MemoryState]
    MEMORY_STATE_STAGED: _ClassVar[MemoryState]
    MEMORY_STATE_ACTIVE: _ClassVar[MemoryState]
    MEMORY_STATE_FORGETTING: _ClassVar[MemoryState]
MEMORY_STATE_UNSPECIFIED: MemoryState
MEMORY_STATE_STAGED: MemoryState
MEMORY_STATE_ACTIVE: MemoryState
MEMORY_STATE_FORGETTING: MemoryState

class Memory(_message.Message):
    __slots__ = ("memory_id", "tag_id", "text", "audience", "state", "created_by", "source_task_id", "created_at_ms", "updated_at_ms", "last_seen_at_ms")
    MEMORY_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    AUDIENCE_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    CREATED_BY_FIELD_NUMBER: _ClassVar[int]
    SOURCE_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    LAST_SEEN_AT_MS_FIELD_NUMBER: _ClassVar[int]
    memory_id: str
    tag_id: str
    text: str
    audience: str
    state: MemoryState
    created_by: str
    source_task_id: str
    created_at_ms: int
    updated_at_ms: int
    last_seen_at_ms: int
    def __init__(self, memory_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., text: _Optional[str] = ..., audience: _Optional[str] = ..., state: _Optional[_Union[MemoryState, str]] = ..., created_by: _Optional[str] = ..., source_task_id: _Optional[str] = ..., created_at_ms: _Optional[int] = ..., updated_at_ms: _Optional[int] = ..., last_seen_at_ms: _Optional[int] = ...) -> None: ...

class ListMemoriesRequest(_message.Message):
    __slots__ = ("tag_id",)
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    def __init__(self, tag_id: _Optional[str] = ...) -> None: ...

class ListMemoriesResponse(_message.Message):
    __slots__ = ("memories",)
    MEMORIES_FIELD_NUMBER: _ClassVar[int]
    memories: _containers.RepeatedCompositeFieldContainer[Memory]
    def __init__(self, memories: _Optional[_Iterable[_Union[Memory, _Mapping]]] = ...) -> None: ...

class GetMemoryRequest(_message.Message):
    __slots__ = ("memory_id",)
    MEMORY_ID_FIELD_NUMBER: _ClassVar[int]
    memory_id: str
    def __init__(self, memory_id: _Optional[str] = ...) -> None: ...

class AttemptRememberRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "text", "replaces")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    REPLACES_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    operation_id: str
    text: str
    replaces: str
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., text: _Optional[str] = ..., replaces: _Optional[str] = ...) -> None: ...

class AttemptForgetRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "memory_id")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    MEMORY_ID_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    operation_id: str
    memory_id: str
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., memory_id: _Optional[str] = ...) -> None: ...

class AttemptMemoryResponse(_message.Message):
    __slots__ = ("memory", "notes")
    MEMORY_FIELD_NUMBER: _ClassVar[int]
    NOTES_FIELD_NUMBER: _ClassVar[int]
    memory: Memory
    notes: _containers.RepeatedCompositeFieldContainer[Memory]
    def __init__(self, memory: _Optional[_Union[Memory, _Mapping]] = ..., notes: _Optional[_Iterable[_Union[Memory, _Mapping]]] = ...) -> None: ...

class ResetNativeMemoryRequest(_message.Message):
    __slots__ = ("tag_id",)
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    def __init__(self, tag_id: _Optional[str] = ...) -> None: ...

class ResetNativeMemoryResponse(_message.Message):
    __slots__ = ("stores", "reset_generation")
    STORES_FIELD_NUMBER: _ClassVar[int]
    RESET_GENERATION_FIELD_NUMBER: _ClassVar[int]
    stores: _containers.RepeatedCompositeFieldContainer[_runtime_pb2.NativeMemoryStore]
    reset_generation: int
    def __init__(self, stores: _Optional[_Iterable[_Union[_runtime_pb2.NativeMemoryStore, _Mapping]]] = ..., reset_generation: _Optional[int] = ...) -> None: ...

class ReportNativeMemoryRequest(_message.Message):
    __slots__ = ("attempt", "revision", "files", "bytes", "digest", "reset_generation")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    FILES_FIELD_NUMBER: _ClassVar[int]
    BYTES_FIELD_NUMBER: _ClassVar[int]
    DIGEST_FIELD_NUMBER: _ClassVar[int]
    RESET_GENERATION_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    revision: int
    files: int
    bytes: int
    digest: str
    reset_generation: int
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., revision: _Optional[int] = ..., files: _Optional[int] = ..., bytes: _Optional[int] = ..., digest: _Optional[str] = ..., reset_generation: _Optional[int] = ...) -> None: ...

class ReportNativeMemoryResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class AdvanceNativeMemoryRequest(_message.Message):
    __slots__ = ("attempt", "expected_revision", "manifest", "files", "bytes", "reset_generation", "objects")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    MANIFEST_FIELD_NUMBER: _ClassVar[int]
    FILES_FIELD_NUMBER: _ClassVar[int]
    BYTES_FIELD_NUMBER: _ClassVar[int]
    RESET_GENERATION_FIELD_NUMBER: _ClassVar[int]
    OBJECTS_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    expected_revision: int
    manifest: _runtime_pb2.BlobReference
    files: int
    bytes: int
    reset_generation: int
    objects: _containers.RepeatedCompositeFieldContainer[_runtime_pb2.BlobReference]
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., expected_revision: _Optional[int] = ..., manifest: _Optional[_Union[_runtime_pb2.BlobReference, _Mapping]] = ..., files: _Optional[int] = ..., bytes: _Optional[int] = ..., reset_generation: _Optional[int] = ..., objects: _Optional[_Iterable[_Union[_runtime_pb2.BlobReference, _Mapping]]] = ...) -> None: ...

class AdvanceNativeMemoryResponse(_message.Message):
    __slots__ = ("advanced", "head")
    ADVANCED_FIELD_NUMBER: _ClassVar[int]
    HEAD_FIELD_NUMBER: _ClassVar[int]
    advanced: bool
    head: _runtime_pb2.NativeMemoryVolumeHead
    def __init__(self, advanced: _Optional[bool] = ..., head: _Optional[_Union[_runtime_pb2.NativeMemoryVolumeHead, _Mapping]] = ...) -> None: ...
