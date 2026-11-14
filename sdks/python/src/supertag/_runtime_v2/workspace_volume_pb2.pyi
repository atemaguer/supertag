from . import runtime_pb2 as _runtime_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class PutWorkspaceVolumeRequest(_message.Message):
    __slots__ = ("volume_id", "source", "expected_revision", "credential")
    VOLUME_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    CREDENTIAL_FIELD_NUMBER: _ClassVar[int]
    volume_id: str
    source: str
    expected_revision: int
    credential: str
    def __init__(self, volume_id: _Optional[str] = ..., source: _Optional[str] = ..., expected_revision: _Optional[int] = ..., credential: _Optional[str] = ...) -> None: ...

class GetWorkspaceVolumeRequest(_message.Message):
    __slots__ = ("volume_id",)
    VOLUME_ID_FIELD_NUMBER: _ClassVar[int]
    volume_id: str
    def __init__(self, volume_id: _Optional[str] = ...) -> None: ...

class RecordWorkspaceMountWritesRequest(_message.Message):
    __slots__ = ("task_id", "attempt_id", "lease_token", "writes")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    WRITES_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    lease_token: str
    writes: _containers.RepeatedCompositeFieldContainer[_runtime_pb2.WorkspaceMountWrite]
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., lease_token: _Optional[str] = ..., writes: _Optional[_Iterable[_Union[_runtime_pb2.WorkspaceMountWrite, _Mapping]]] = ...) -> None: ...

class RecordWorkspaceMountWritesResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class WorkspaceMountPreflight(_message.Message):
    __slots__ = ("protected_file_sources",)
    PROTECTED_FILE_SOURCES_FIELD_NUMBER: _ClassVar[int]
    protected_file_sources: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, protected_file_sources: _Optional[_Iterable[str]] = ...) -> None: ...
