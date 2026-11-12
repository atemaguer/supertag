from . import runtime_pb2 as _runtime_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ArtifactDescription(_message.Message):
    __slots__ = ("title", "kind", "summary")
    TITLE_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    title: str
    kind: str
    summary: str
    def __init__(self, title: _Optional[str] = ..., kind: _Optional[str] = ..., summary: _Optional[str] = ...) -> None: ...

class ArtifactFile(_message.Message):
    __slots__ = ("path", "blob")
    PATH_FIELD_NUMBER: _ClassVar[int]
    BLOB_FIELD_NUMBER: _ClassVar[int]
    path: str
    blob: _runtime_pb2.BlobReference
    def __init__(self, path: _Optional[str] = ..., blob: _Optional[_Union[_runtime_pb2.BlobReference, _Mapping]] = ...) -> None: ...

class ArtifactProducer(_message.Message):
    __slots__ = ("task_id", "attempt_id", "tag_id", "session_id", "objective_id", "harness_kind", "native_session_id")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    HARNESS_KIND_FIELD_NUMBER: _ClassVar[int]
    NATIVE_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    tag_id: str
    session_id: str
    objective_id: str
    harness_kind: _runtime_pb2.HarnessKind
    native_session_id: str
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., harness_kind: _Optional[_Union[_runtime_pb2.HarnessKind, str]] = ..., native_session_id: _Optional[str] = ...) -> None: ...

class ArtifactSummary(_message.Message):
    __slots__ = ("artifact_id", "description", "producer", "file_count", "byte_length", "captured_at_ms")
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    PRODUCER_FIELD_NUMBER: _ClassVar[int]
    FILE_COUNT_FIELD_NUMBER: _ClassVar[int]
    BYTE_LENGTH_FIELD_NUMBER: _ClassVar[int]
    CAPTURED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    description: ArtifactDescription
    producer: ArtifactProducer
    file_count: int
    byte_length: int
    captured_at_ms: int
    def __init__(self, artifact_id: _Optional[str] = ..., description: _Optional[_Union[ArtifactDescription, _Mapping]] = ..., producer: _Optional[_Union[ArtifactProducer, _Mapping]] = ..., file_count: _Optional[int] = ..., byte_length: _Optional[int] = ..., captured_at_ms: _Optional[int] = ...) -> None: ...

class CapturedArtifact(_message.Message):
    __slots__ = ("summary", "files")
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    FILES_FIELD_NUMBER: _ClassVar[int]
    summary: ArtifactSummary
    files: _containers.RepeatedCompositeFieldContainer[ArtifactFile]
    def __init__(self, summary: _Optional[_Union[ArtifactSummary, _Mapping]] = ..., files: _Optional[_Iterable[_Union[ArtifactFile, _Mapping]]] = ...) -> None: ...

class HarnessCaptureArtifactRequest(_message.Message):
    __slots__ = ("operation_id", "description", "paths", "native_session_id")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    PATHS_FIELD_NUMBER: _ClassVar[int]
    NATIVE_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    description: ArtifactDescription
    paths: _containers.RepeatedScalarFieldContainer[str]
    native_session_id: str
    def __init__(self, operation_id: _Optional[str] = ..., description: _Optional[_Union[ArtifactDescription, _Mapping]] = ..., paths: _Optional[_Iterable[str]] = ..., native_session_id: _Optional[str] = ...) -> None: ...

class CommitArtifactCaptureRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "description", "files", "native_session_id")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    FILES_FIELD_NUMBER: _ClassVar[int]
    NATIVE_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    operation_id: str
    description: ArtifactDescription
    files: _containers.RepeatedCompositeFieldContainer[ArtifactFile]
    native_session_id: str
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., description: _Optional[_Union[ArtifactDescription, _Mapping]] = ..., files: _Optional[_Iterable[_Union[ArtifactFile, _Mapping]]] = ..., native_session_id: _Optional[str] = ...) -> None: ...

class GetCapturedArtifactRequest(_message.Message):
    __slots__ = ("artifact_id",)
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    def __init__(self, artifact_id: _Optional[str] = ...) -> None: ...

class ListCapturedArtifactsRequest(_message.Message):
    __slots__ = ("task_id", "limit", "before_order")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    limit: int
    before_order: int
    def __init__(self, task_id: _Optional[str] = ..., limit: _Optional[int] = ..., before_order: _Optional[int] = ...) -> None: ...

class ListCapturedArtifactsResponse(_message.Message):
    __slots__ = ("artifacts", "next_before_order")
    ARTIFACTS_FIELD_NUMBER: _ClassVar[int]
    NEXT_BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    artifacts: _containers.RepeatedCompositeFieldContainer[ArtifactSummary]
    next_before_order: int
    def __init__(self, artifacts: _Optional[_Iterable[_Union[ArtifactSummary, _Mapping]]] = ..., next_before_order: _Optional[int] = ...) -> None: ...

class ArtifactUpload(_message.Message):
    __slots__ = ("begin", "chunk")
    BEGIN_FIELD_NUMBER: _ClassVar[int]
    CHUNK_FIELD_NUMBER: _ClassVar[int]
    begin: CommitArtifactCaptureRequest
    chunk: ArtifactChunk
    def __init__(self, begin: _Optional[_Union[CommitArtifactCaptureRequest, _Mapping]] = ..., chunk: _Optional[_Union[ArtifactChunk, _Mapping]] = ...) -> None: ...

class ArtifactChunk(_message.Message):
    __slots__ = ("file_index", "data")
    FILE_INDEX_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    file_index: int
    data: bytes
    def __init__(self, file_index: _Optional[int] = ..., data: _Optional[bytes] = ...) -> None: ...

class DownloadArtifactFileRequest(_message.Message):
    __slots__ = ("artifact_id", "path")
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    path: str
    def __init__(self, artifact_id: _Optional[str] = ..., path: _Optional[str] = ...) -> None: ...

class ArtifactDownload(_message.Message):
    __slots__ = ("file", "chunk")
    FILE_FIELD_NUMBER: _ClassVar[int]
    CHUNK_FIELD_NUMBER: _ClassVar[int]
    file: ArtifactFile
    chunk: bytes
    def __init__(self, file: _Optional[_Union[ArtifactFile, _Mapping]] = ..., chunk: _Optional[bytes] = ...) -> None: ...
