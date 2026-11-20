from . import runtime_pb2 as _runtime_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

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
    __slots__ = ("revision", "files", "bytes", "digest", "reset_generation")
    REVISION_FIELD_NUMBER: _ClassVar[int]
    FILES_FIELD_NUMBER: _ClassVar[int]
    BYTES_FIELD_NUMBER: _ClassVar[int]
    DIGEST_FIELD_NUMBER: _ClassVar[int]
    RESET_GENERATION_FIELD_NUMBER: _ClassVar[int]
    revision: int
    files: int
    bytes: int
    digest: str
    reset_generation: int
    def __init__(self, revision: _Optional[int] = ..., files: _Optional[int] = ..., bytes: _Optional[int] = ..., digest: _Optional[str] = ..., reset_generation: _Optional[int] = ...) -> None: ...

class ReportNativeMemoryResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class AdvanceNativeMemoryRequest(_message.Message):
    __slots__ = ("expected_revision", "manifest", "files", "bytes", "reset_generation", "objects")
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    MANIFEST_FIELD_NUMBER: _ClassVar[int]
    FILES_FIELD_NUMBER: _ClassVar[int]
    BYTES_FIELD_NUMBER: _ClassVar[int]
    RESET_GENERATION_FIELD_NUMBER: _ClassVar[int]
    OBJECTS_FIELD_NUMBER: _ClassVar[int]
    expected_revision: int
    manifest: _runtime_pb2.BlobReference
    files: int
    bytes: int
    reset_generation: int
    objects: _containers.RepeatedCompositeFieldContainer[_runtime_pb2.BlobReference]
    def __init__(self, expected_revision: _Optional[int] = ..., manifest: _Optional[_Union[_runtime_pb2.BlobReference, _Mapping]] = ..., files: _Optional[int] = ..., bytes: _Optional[int] = ..., reset_generation: _Optional[int] = ..., objects: _Optional[_Iterable[_Union[_runtime_pb2.BlobReference, _Mapping]]] = ...) -> None: ...

class AdvanceNativeMemoryResponse(_message.Message):
    __slots__ = ("advanced", "head")
    ADVANCED_FIELD_NUMBER: _ClassVar[int]
    HEAD_FIELD_NUMBER: _ClassVar[int]
    advanced: bool
    head: _runtime_pb2.NativeMemoryVolumeHead
    def __init__(self, advanced: _Optional[bool] = ..., head: _Optional[_Union[_runtime_pb2.NativeMemoryVolumeHead, _Mapping]] = ...) -> None: ...

class AcknowledgeNativeMemorySeedsRequest(_message.Message):
    __slots__ = ("seed_ids",)
    SEED_IDS_FIELD_NUMBER: _ClassVar[int]
    seed_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, seed_ids: _Optional[_Iterable[str]] = ...) -> None: ...

class AcknowledgeNativeMemorySeedsResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...
