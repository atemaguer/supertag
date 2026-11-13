from . import runtime_pb2 as _runtime_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable
from typing import ClassVar as _ClassVar, Optional as _Optional

DESCRIPTOR: _descriptor.FileDescriptor

class PutWorkspaceVolumeRequest(_message.Message):
    __slots__ = ("volume_id", "source", "expected_revision")
    VOLUME_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    volume_id: str
    source: str
    expected_revision: int
    def __init__(self, volume_id: _Optional[str] = ..., source: _Optional[str] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class GetWorkspaceVolumeRequest(_message.Message):
    __slots__ = ("volume_id",)
    VOLUME_ID_FIELD_NUMBER: _ClassVar[int]
    volume_id: str
    def __init__(self, volume_id: _Optional[str] = ...) -> None: ...

class WorkspaceMountPreflight(_message.Message):
    __slots__ = ("protected_file_sources",)
    PROTECTED_FILE_SOURCES_FIELD_NUMBER: _ClassVar[int]
    protected_file_sources: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, protected_file_sources: _Optional[_Iterable[str]] = ...) -> None: ...
