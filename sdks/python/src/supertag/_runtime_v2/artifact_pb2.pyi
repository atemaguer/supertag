from . import runtime_pb2 as _runtime_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ArtifactDelivery(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ARTIFACT_DELIVERY_UNSPECIFIED: _ClassVar[ArtifactDelivery]
    ARTIFACT_DELIVERY_READ: _ClassVar[ArtifactDelivery]
    ARTIFACT_DELIVERY_MATERIALIZE: _ClassVar[ArtifactDelivery]

class ArtifactAcquisitionState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ARTIFACT_ACQUISITION_STATE_UNSPECIFIED: _ClassVar[ArtifactAcquisitionState]
    ARTIFACT_ACQUISITION_STATE_AUTHORIZED: _ClassVar[ArtifactAcquisitionState]
    ARTIFACT_ACQUISITION_STATE_DELIVERED: _ClassVar[ArtifactAcquisitionState]
    ARTIFACT_ACQUISITION_STATE_FAILED: _ClassVar[ArtifactAcquisitionState]
    ARTIFACT_ACQUISITION_STATE_UNCERTAIN: _ClassVar[ArtifactAcquisitionState]

class ArtifactVolumeCopyState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ARTIFACT_VOLUME_COPY_STATE_UNSPECIFIED: _ClassVar[ArtifactVolumeCopyState]
    ARTIFACT_VOLUME_COPY_STATE_RESERVED: _ClassVar[ArtifactVolumeCopyState]
    ARTIFACT_VOLUME_COPY_STATE_VERIFIED: _ClassVar[ArtifactVolumeCopyState]
ARTIFACT_DELIVERY_UNSPECIFIED: ArtifactDelivery
ARTIFACT_DELIVERY_READ: ArtifactDelivery
ARTIFACT_DELIVERY_MATERIALIZE: ArtifactDelivery
ARTIFACT_ACQUISITION_STATE_UNSPECIFIED: ArtifactAcquisitionState
ARTIFACT_ACQUISITION_STATE_AUTHORIZED: ArtifactAcquisitionState
ARTIFACT_ACQUISITION_STATE_DELIVERED: ArtifactAcquisitionState
ARTIFACT_ACQUISITION_STATE_FAILED: ArtifactAcquisitionState
ARTIFACT_ACQUISITION_STATE_UNCERTAIN: ArtifactAcquisitionState
ARTIFACT_VOLUME_COPY_STATE_UNSPECIFIED: ArtifactVolumeCopyState
ARTIFACT_VOLUME_COPY_STATE_RESERVED: ArtifactVolumeCopyState
ARTIFACT_VOLUME_COPY_STATE_VERIFIED: ArtifactVolumeCopyState

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
    __slots__ = ("path", "blob", "git_output")
    PATH_FIELD_NUMBER: _ClassVar[int]
    BLOB_FIELD_NUMBER: _ClassVar[int]
    GIT_OUTPUT_FIELD_NUMBER: _ClassVar[int]
    path: str
    blob: _runtime_pb2.BlobReference
    git_output: GitOutputSnapshot
    def __init__(self, path: _Optional[str] = ..., blob: _Optional[_Union[_runtime_pb2.BlobReference, _Mapping]] = ..., git_output: _Optional[_Union[GitOutputSnapshot, _Mapping]] = ...) -> None: ...

class GitOutputSnapshot(_message.Message):
    __slots__ = ("start_commit", "head_commit", "remote", "tracked_paths", "deleted_paths", "referenced_paths")
    START_COMMIT_FIELD_NUMBER: _ClassVar[int]
    HEAD_COMMIT_FIELD_NUMBER: _ClassVar[int]
    REMOTE_FIELD_NUMBER: _ClassVar[int]
    TRACKED_PATHS_FIELD_NUMBER: _ClassVar[int]
    DELETED_PATHS_FIELD_NUMBER: _ClassVar[int]
    REFERENCED_PATHS_FIELD_NUMBER: _ClassVar[int]
    start_commit: str
    head_commit: str
    remote: str
    tracked_paths: _containers.RepeatedScalarFieldContainer[str]
    deleted_paths: _containers.RepeatedScalarFieldContainer[str]
    referenced_paths: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, start_commit: _Optional[str] = ..., head_commit: _Optional[str] = ..., remote: _Optional[str] = ..., tracked_paths: _Optional[_Iterable[str]] = ..., deleted_paths: _Optional[_Iterable[str]] = ..., referenced_paths: _Optional[_Iterable[str]] = ...) -> None: ...

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
    __slots__ = ("artifact_id", "description", "producer", "file_count", "byte_length", "captured_at_ms", "declared_task_output")
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    PRODUCER_FIELD_NUMBER: _ClassVar[int]
    FILE_COUNT_FIELD_NUMBER: _ClassVar[int]
    BYTE_LENGTH_FIELD_NUMBER: _ClassVar[int]
    CAPTURED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    DECLARED_TASK_OUTPUT_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    description: ArtifactDescription
    producer: ArtifactProducer
    file_count: int
    byte_length: int
    captured_at_ms: int
    declared_task_output: bool
    def __init__(self, artifact_id: _Optional[str] = ..., description: _Optional[_Union[ArtifactDescription, _Mapping]] = ..., producer: _Optional[_Union[ArtifactProducer, _Mapping]] = ..., file_count: _Optional[int] = ..., byte_length: _Optional[int] = ..., captured_at_ms: _Optional[int] = ..., declared_task_output: _Optional[bool] = ...) -> None: ...

class CapturedArtifact(_message.Message):
    __slots__ = ("summary", "files", "inputs")
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    FILES_FIELD_NUMBER: _ClassVar[int]
    INPUTS_FIELD_NUMBER: _ClassVar[int]
    summary: ArtifactSummary
    files: _containers.RepeatedCompositeFieldContainer[ArtifactFile]
    inputs: _containers.RepeatedCompositeFieldContainer[_runtime_pb2.ArtifactSelection]
    def __init__(self, summary: _Optional[_Union[ArtifactSummary, _Mapping]] = ..., files: _Optional[_Iterable[_Union[ArtifactFile, _Mapping]]] = ..., inputs: _Optional[_Iterable[_Union[_runtime_pb2.ArtifactSelection, _Mapping]]] = ...) -> None: ...

class ArtifactAcquisition(_message.Message):
    __slots__ = ("acquisition_id", "operation_id", "task_id", "attempt_id", "artifact_id", "files", "delivery", "destination", "state", "created_at_ms", "updated_at_ms")
    ACQUISITION_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    FILES_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_FIELD_NUMBER: _ClassVar[int]
    DESTINATION_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    acquisition_id: str
    operation_id: str
    task_id: str
    attempt_id: str
    artifact_id: str
    files: _containers.RepeatedCompositeFieldContainer[ArtifactFile]
    delivery: ArtifactDelivery
    destination: str
    state: ArtifactAcquisitionState
    created_at_ms: int
    updated_at_ms: int
    def __init__(self, acquisition_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., artifact_id: _Optional[str] = ..., files: _Optional[_Iterable[_Union[ArtifactFile, _Mapping]]] = ..., delivery: _Optional[_Union[ArtifactDelivery, str]] = ..., destination: _Optional[str] = ..., state: _Optional[_Union[ArtifactAcquisitionState, str]] = ..., created_at_ms: _Optional[int] = ..., updated_at_ms: _Optional[int] = ...) -> None: ...

class FindAttemptArtifactsRequest(_message.Message):
    __slots__ = ("attempt", "query", "kind", "task_id", "limit", "before_order")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    QUERY_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    query: str
    kind: str
    task_id: str
    limit: int
    before_order: int
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., query: _Optional[str] = ..., kind: _Optional[str] = ..., task_id: _Optional[str] = ..., limit: _Optional[int] = ..., before_order: _Optional[int] = ...) -> None: ...

class InspectAttemptArtifactRequest(_message.Message):
    __slots__ = ("attempt", "artifact_id")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    artifact_id: str
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., artifact_id: _Optional[str] = ...) -> None: ...

class AcquireArtifactRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "artifact_id", "paths", "delivery", "destination")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    PATHS_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_FIELD_NUMBER: _ClassVar[int]
    DESTINATION_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    operation_id: str
    artifact_id: str
    paths: _containers.RepeatedScalarFieldContainer[str]
    delivery: ArtifactDelivery
    destination: str
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., artifact_id: _Optional[str] = ..., paths: _Optional[_Iterable[str]] = ..., delivery: _Optional[_Union[ArtifactDelivery, str]] = ..., destination: _Optional[str] = ...) -> None: ...

class SettleArtifactAcquisitionRequest(_message.Message):
    __slots__ = ("attempt", "acquisition_id", "state")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    ACQUISITION_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    acquisition_id: str
    state: ArtifactAcquisitionState
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., acquisition_id: _Optional[str] = ..., state: _Optional[_Union[ArtifactAcquisitionState, str]] = ...) -> None: ...

class GetAcquiredArtifactFileRequest(_message.Message):
    __slots__ = ("attempt", "acquisition_id", "path")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    ACQUISITION_ID_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    acquisition_id: str
    path: str
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., acquisition_id: _Optional[str] = ..., path: _Optional[str] = ...) -> None: ...

class HarnessFindArtifactsRequest(_message.Message):
    __slots__ = ("query", "kind", "task_id", "limit", "before_order")
    QUERY_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    query: str
    kind: str
    task_id: str
    limit: int
    before_order: int
    def __init__(self, query: _Optional[str] = ..., kind: _Optional[str] = ..., task_id: _Optional[str] = ..., limit: _Optional[int] = ..., before_order: _Optional[int] = ...) -> None: ...

class HarnessReadArtifactRequest(_message.Message):
    __slots__ = ("operation_id", "artifact_id", "path", "offset", "limit")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    artifact_id: str
    path: str
    offset: int
    limit: int
    def __init__(self, operation_id: _Optional[str] = ..., artifact_id: _Optional[str] = ..., path: _Optional[str] = ..., offset: _Optional[int] = ..., limit: _Optional[int] = ...) -> None: ...

class HarnessArtifactPage(_message.Message):
    __slots__ = ("acquisition", "path", "text", "offset", "next_offset", "truncated")
    ACQUISITION_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    NEXT_OFFSET_FIELD_NUMBER: _ClassVar[int]
    TRUNCATED_FIELD_NUMBER: _ClassVar[int]
    acquisition: ArtifactAcquisition
    path: str
    text: str
    offset: int
    next_offset: int
    truncated: bool
    def __init__(self, acquisition: _Optional[_Union[ArtifactAcquisition, _Mapping]] = ..., path: _Optional[str] = ..., text: _Optional[str] = ..., offset: _Optional[int] = ..., next_offset: _Optional[int] = ..., truncated: _Optional[bool] = ...) -> None: ...

class HarnessAttachArtifactRequest(_message.Message):
    __slots__ = ("operation_id", "artifact_id", "paths")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    PATHS_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    artifact_id: str
    paths: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, operation_id: _Optional[str] = ..., artifact_id: _Optional[str] = ..., paths: _Optional[_Iterable[str]] = ...) -> None: ...

class HarnessAttachedArtifact(_message.Message):
    __slots__ = ("acquisition", "local_path")
    ACQUISITION_FIELD_NUMBER: _ClassVar[int]
    LOCAL_PATH_FIELD_NUMBER: _ClassVar[int]
    acquisition: ArtifactAcquisition
    local_path: str
    def __init__(self, acquisition: _Optional[_Union[ArtifactAcquisition, _Mapping]] = ..., local_path: _Optional[str] = ...) -> None: ...

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
    __slots__ = ("attempt", "operation_id", "description", "files", "native_session_id", "managed_task_output", "declared_task_output")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    FILES_FIELD_NUMBER: _ClassVar[int]
    NATIVE_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    MANAGED_TASK_OUTPUT_FIELD_NUMBER: _ClassVar[int]
    DECLARED_TASK_OUTPUT_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    operation_id: str
    description: ArtifactDescription
    files: _containers.RepeatedCompositeFieldContainer[ArtifactFile]
    native_session_id: str
    managed_task_output: bool
    declared_task_output: bool
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., description: _Optional[_Union[ArtifactDescription, _Mapping]] = ..., files: _Optional[_Iterable[_Union[ArtifactFile, _Mapping]]] = ..., native_session_id: _Optional[str] = ..., managed_task_output: _Optional[bool] = ..., declared_task_output: _Optional[bool] = ...) -> None: ...

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

class ArtifactVolume(_message.Message):
    __slots__ = ("volume_id", "source", "revision")
    VOLUME_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    volume_id: str
    source: str
    revision: int
    def __init__(self, volume_id: _Optional[str] = ..., source: _Optional[str] = ..., revision: _Optional[int] = ...) -> None: ...

class PutArtifactVolumeRequest(_message.Message):
    __slots__ = ("operation_id", "volume_id", "source", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    VOLUME_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    volume_id: str
    source: str
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., volume_id: _Optional[str] = ..., source: _Optional[str] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class GetArtifactVolumeRequest(_message.Message):
    __slots__ = ("volume_id",)
    VOLUME_ID_FIELD_NUMBER: _ClassVar[int]
    volume_id: str
    def __init__(self, volume_id: _Optional[str] = ...) -> None: ...

class ListArtifactVolumesRequest(_message.Message):
    __slots__ = ("limit", "after_id")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    AFTER_ID_FIELD_NUMBER: _ClassVar[int]
    limit: int
    after_id: str
    def __init__(self, limit: _Optional[int] = ..., after_id: _Optional[str] = ...) -> None: ...

class ListArtifactVolumesResponse(_message.Message):
    __slots__ = ("volumes", "next_after_id")
    VOLUMES_FIELD_NUMBER: _ClassVar[int]
    NEXT_AFTER_ID_FIELD_NUMBER: _ClassVar[int]
    volumes: _containers.RepeatedCompositeFieldContainer[ArtifactVolume]
    next_after_id: str
    def __init__(self, volumes: _Optional[_Iterable[_Union[ArtifactVolume, _Mapping]]] = ..., next_after_id: _Optional[str] = ...) -> None: ...

class DeleteArtifactVolumeRequest(_message.Message):
    __slots__ = ("operation_id", "volume_id", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    VOLUME_ID_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    volume_id: str
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., volume_id: _Optional[str] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class DeleteArtifactVolumeResponse(_message.Message):
    __slots__ = ("deleted",)
    DELETED_FIELD_NUMBER: _ClassVar[int]
    deleted: bool
    def __init__(self, deleted: _Optional[bool] = ...) -> None: ...

class CopyArtifactToVolumeRequest(_message.Message):
    __slots__ = ("operation_id", "volume_id", "expected_revision", "artifact_id", "path", "expected_blob")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    VOLUME_ID_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_BLOB_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    volume_id: str
    expected_revision: int
    artifact_id: str
    path: str
    expected_blob: _runtime_pb2.BlobReference
    def __init__(self, operation_id: _Optional[str] = ..., volume_id: _Optional[str] = ..., expected_revision: _Optional[int] = ..., artifact_id: _Optional[str] = ..., path: _Optional[str] = ..., expected_blob: _Optional[_Union[_runtime_pb2.BlobReference, _Mapping]] = ...) -> None: ...

class ArtifactVolumeCopy(_message.Message):
    __slots__ = ("copy_id", "operation_id", "volume", "artifact_id", "file", "storage_key", "state", "created_at_ms", "verified_at_ms")
    COPY_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    VOLUME_FIELD_NUMBER: _ClassVar[int]
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    FILE_FIELD_NUMBER: _ClassVar[int]
    STORAGE_KEY_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    VERIFIED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    copy_id: str
    operation_id: str
    volume: ArtifactVolume
    artifact_id: str
    file: ArtifactFile
    storage_key: str
    state: ArtifactVolumeCopyState
    created_at_ms: int
    verified_at_ms: int
    def __init__(self, copy_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., volume: _Optional[_Union[ArtifactVolume, _Mapping]] = ..., artifact_id: _Optional[str] = ..., file: _Optional[_Union[ArtifactFile, _Mapping]] = ..., storage_key: _Optional[str] = ..., state: _Optional[_Union[ArtifactVolumeCopyState, str]] = ..., created_at_ms: _Optional[int] = ..., verified_at_ms: _Optional[int] = ...) -> None: ...

class CommitArtifactVolumeCopyRequest(_message.Message):
    __slots__ = ("copy_id", "verified_blob")
    COPY_ID_FIELD_NUMBER: _ClassVar[int]
    VERIFIED_BLOB_FIELD_NUMBER: _ClassVar[int]
    copy_id: str
    verified_blob: _runtime_pb2.BlobReference
    def __init__(self, copy_id: _Optional[str] = ..., verified_blob: _Optional[_Union[_runtime_pb2.BlobReference, _Mapping]] = ...) -> None: ...

class GetArtifactVolumeCopyRequest(_message.Message):
    __slots__ = ("copy_id",)
    COPY_ID_FIELD_NUMBER: _ClassVar[int]
    copy_id: str
    def __init__(self, copy_id: _Optional[str] = ...) -> None: ...

class ListArtifactVolumeCopiesRequest(_message.Message):
    __slots__ = ("volume_id", "limit", "before_order")
    VOLUME_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    volume_id: str
    limit: int
    before_order: int
    def __init__(self, volume_id: _Optional[str] = ..., limit: _Optional[int] = ..., before_order: _Optional[int] = ...) -> None: ...

class ListArtifactVolumeCopiesResponse(_message.Message):
    __slots__ = ("copies", "next_before_order")
    COPIES_FIELD_NUMBER: _ClassVar[int]
    NEXT_BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    copies: _containers.RepeatedCompositeFieldContainer[ArtifactVolumeCopy]
    next_before_order: int
    def __init__(self, copies: _Optional[_Iterable[_Union[ArtifactVolumeCopy, _Mapping]]] = ..., next_before_order: _Optional[int] = ...) -> None: ...
