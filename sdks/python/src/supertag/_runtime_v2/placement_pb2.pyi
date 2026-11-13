from . import runtime_pb2 as _runtime_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class RevokeAuthKeyRequest(_message.Message):
    __slots__ = ("key_id",)
    KEY_ID_FIELD_NUMBER: _ClassVar[int]
    key_id: str
    def __init__(self, key_id: _Optional[str] = ...) -> None: ...

class SetTagRunsOnRequest(_message.Message):
    __slots__ = ("tag_id", "runs_on")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    RUNS_ON_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    runs_on: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, tag_id: _Optional[str] = ..., runs_on: _Optional[_Iterable[str]] = ...) -> None: ...

class DiagnoseTaskPlacementRequest(_message.Message):
    __slots__ = ("task_id",)
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    def __init__(self, task_id: _Optional[str] = ...) -> None: ...

class HostPlacement(_message.Message):
    __slots__ = ("host_id", "phase", "labels", "missing_labels", "eligible")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    LABELS_FIELD_NUMBER: _ClassVar[int]
    MISSING_LABELS_FIELD_NUMBER: _ClassVar[int]
    ELIGIBLE_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    phase: _runtime_pb2.HostPhase
    labels: _containers.RepeatedScalarFieldContainer[str]
    missing_labels: _containers.RepeatedScalarFieldContainer[str]
    eligible: bool
    def __init__(self, host_id: _Optional[str] = ..., phase: _Optional[_Union[_runtime_pb2.HostPhase, str]] = ..., labels: _Optional[_Iterable[str]] = ..., missing_labels: _Optional[_Iterable[str]] = ..., eligible: _Optional[bool] = ...) -> None: ...

class TaskPlacementDiagnosis(_message.Message):
    __slots__ = ("task_id", "tag_id", "state", "required_labels", "missing_labels", "requirement", "summary", "hosts")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_LABELS_FIELD_NUMBER: _ClassVar[int]
    MISSING_LABELS_FIELD_NUMBER: _ClassVar[int]
    REQUIREMENT_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    HOSTS_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    tag_id: str
    state: _runtime_pb2.TaskState
    required_labels: _containers.RepeatedScalarFieldContainer[str]
    missing_labels: _containers.RepeatedScalarFieldContainer[str]
    requirement: str
    summary: str
    hosts: _containers.RepeatedCompositeFieldContainer[HostPlacement]
    def __init__(self, task_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., state: _Optional[_Union[_runtime_pb2.TaskState, str]] = ..., required_labels: _Optional[_Iterable[str]] = ..., missing_labels: _Optional[_Iterable[str]] = ..., requirement: _Optional[str] = ..., summary: _Optional[str] = ..., hosts: _Optional[_Iterable[_Union[HostPlacement, _Mapping]]] = ...) -> None: ...
