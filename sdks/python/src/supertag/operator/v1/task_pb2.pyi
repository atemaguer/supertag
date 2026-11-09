import datetime

from google.protobuf import timestamp_pb2 as _timestamp_pb2
from supertag.operator.v1 import options_pb2 as _options_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class TaskStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TASK_STATUS_UNSPECIFIED: _ClassVar[TaskStatus]
    TASK_STATUS_PENDING: _ClassVar[TaskStatus]
    TASK_STATUS_RUNNING: _ClassVar[TaskStatus]
    TASK_STATUS_COMPLETED: _ClassVar[TaskStatus]
    TASK_STATUS_FAILED: _ClassVar[TaskStatus]
    TASK_STATUS_CANCELLED: _ClassVar[TaskStatus]

class TaskAttemptStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TASK_ATTEMPT_STATUS_UNSPECIFIED: _ClassVar[TaskAttemptStatus]
    TASK_ATTEMPT_STATUS_RUNNING: _ClassVar[TaskAttemptStatus]
    TASK_ATTEMPT_STATUS_COMPLETED: _ClassVar[TaskAttemptStatus]
    TASK_ATTEMPT_STATUS_FAILED: _ClassVar[TaskAttemptStatus]
    TASK_ATTEMPT_STATUS_CANCELLED: _ClassVar[TaskAttemptStatus]

class WorkspaceDeliveryMode(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WORKSPACE_DELIVERY_MODE_UNSPECIFIED: _ClassVar[WorkspaceDeliveryMode]
    WORKSPACE_DELIVERY_MODE_PATCH: _ClassVar[WorkspaceDeliveryMode]
    WORKSPACE_DELIVERY_MODE_BRANCH: _ClassVar[WorkspaceDeliveryMode]
    WORKSPACE_DELIVERY_MODE_PULL_REQUEST: _ClassVar[WorkspaceDeliveryMode]

class PullRequestState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    PULL_REQUEST_STATE_UNSPECIFIED: _ClassVar[PullRequestState]
    PULL_REQUEST_STATE_DRAFT: _ClassVar[PullRequestState]
    PULL_REQUEST_STATE_READY: _ClassVar[PullRequestState]
    PULL_REQUEST_STATE_CLOSED: _ClassVar[PullRequestState]
TASK_STATUS_UNSPECIFIED: TaskStatus
TASK_STATUS_PENDING: TaskStatus
TASK_STATUS_RUNNING: TaskStatus
TASK_STATUS_COMPLETED: TaskStatus
TASK_STATUS_FAILED: TaskStatus
TASK_STATUS_CANCELLED: TaskStatus
TASK_ATTEMPT_STATUS_UNSPECIFIED: TaskAttemptStatus
TASK_ATTEMPT_STATUS_RUNNING: TaskAttemptStatus
TASK_ATTEMPT_STATUS_COMPLETED: TaskAttemptStatus
TASK_ATTEMPT_STATUS_FAILED: TaskAttemptStatus
TASK_ATTEMPT_STATUS_CANCELLED: TaskAttemptStatus
WORKSPACE_DELIVERY_MODE_UNSPECIFIED: WorkspaceDeliveryMode
WORKSPACE_DELIVERY_MODE_PATCH: WorkspaceDeliveryMode
WORKSPACE_DELIVERY_MODE_BRANCH: WorkspaceDeliveryMode
WORKSPACE_DELIVERY_MODE_PULL_REQUEST: WorkspaceDeliveryMode
PULL_REQUEST_STATE_UNSPECIFIED: PullRequestState
PULL_REQUEST_STATE_DRAFT: PullRequestState
PULL_REQUEST_STATE_READY: PullRequestState
PULL_REQUEST_STATE_CLOSED: PullRequestState

class TaskDelivery(_message.Message):
    __slots__ = ("workspace", "patches", "pull_request", "outputs")
    WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    PATCHES_FIELD_NUMBER: _ClassVar[int]
    PULL_REQUEST_FIELD_NUMBER: _ClassVar[int]
    OUTPUTS_FIELD_NUMBER: _ClassVar[int]
    workspace: WorkspaceDelivery
    patches: _containers.RepeatedCompositeFieldContainer[PatchDelivery]
    pull_request: PullRequestDelivery
    outputs: _containers.RepeatedCompositeFieldContainer[OutputDelivery]
    def __init__(self, workspace: _Optional[_Union[WorkspaceDelivery, _Mapping]] = ..., patches: _Optional[_Iterable[_Union[PatchDelivery, _Mapping]]] = ..., pull_request: _Optional[_Union[PullRequestDelivery, _Mapping]] = ..., outputs: _Optional[_Iterable[_Union[OutputDelivery, _Mapping]]] = ...) -> None: ...

class WorkspaceDelivery(_message.Message):
    __slots__ = ("name", "mode", "branch", "ref", "head", "changed_files", "base")
    NAME_FIELD_NUMBER: _ClassVar[int]
    MODE_FIELD_NUMBER: _ClassVar[int]
    BRANCH_FIELD_NUMBER: _ClassVar[int]
    REF_FIELD_NUMBER: _ClassVar[int]
    HEAD_FIELD_NUMBER: _ClassVar[int]
    CHANGED_FILES_FIELD_NUMBER: _ClassVar[int]
    BASE_FIELD_NUMBER: _ClassVar[int]
    name: str
    mode: WorkspaceDeliveryMode
    branch: str
    ref: str
    head: str
    changed_files: int
    base: str
    def __init__(self, name: _Optional[str] = ..., mode: _Optional[_Union[WorkspaceDeliveryMode, str]] = ..., branch: _Optional[str] = ..., ref: _Optional[str] = ..., head: _Optional[str] = ..., changed_files: _Optional[int] = ..., base: _Optional[str] = ...) -> None: ...

class PatchDelivery(_message.Message):
    __slots__ = ("artifact_id", "path")
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    path: str
    def __init__(self, artifact_id: _Optional[str] = ..., path: _Optional[str] = ...) -> None: ...

class PullRequestDelivery(_message.Message):
    __slots__ = ("surface_account_id", "repository", "number", "url", "state", "last_error", "next_attempt_at")
    SURFACE_ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    REPOSITORY_FIELD_NUMBER: _ClassVar[int]
    NUMBER_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    LAST_ERROR_FIELD_NUMBER: _ClassVar[int]
    NEXT_ATTEMPT_AT_FIELD_NUMBER: _ClassVar[int]
    surface_account_id: str
    repository: str
    number: int
    url: str
    state: PullRequestState
    last_error: str
    next_attempt_at: _timestamp_pb2.Timestamp
    def __init__(self, surface_account_id: _Optional[str] = ..., repository: _Optional[str] = ..., number: _Optional[int] = ..., url: _Optional[str] = ..., state: _Optional[_Union[PullRequestState, str]] = ..., last_error: _Optional[str] = ..., next_attempt_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class OutputDelivery(_message.Message):
    __slots__ = ("artifact_id", "paths")
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    PATHS_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    paths: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, artifact_id: _Optional[str] = ..., paths: _Optional[_Iterable[str]] = ...) -> None: ...
