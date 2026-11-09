import datetime

from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf import timestamp_pb2 as _timestamp_pb2
from supertag.operator.v1 import common_pb2 as _common_pb2
from supertag.operator.v1 import options_pb2 as _options_pb2
from supertag.operator.v1 import task_pb2 as _task_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class OutputGitMode(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OUTPUT_GIT_MODE_UNSPECIFIED: _ClassVar[OutputGitMode]
    OUTPUT_GIT_MODE_REFERENCE: _ClassVar[OutputGitMode]
    OUTPUT_GIT_MODE_CAPTURE: _ClassVar[OutputGitMode]
    OUTPUT_GIT_MODE_IGNORE: _ClassVar[OutputGitMode]

class TaskFindingSeverity(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TASK_FINDING_SEVERITY_UNSPECIFIED: _ClassVar[TaskFindingSeverity]
    TASK_FINDING_SEVERITY_HIGH: _ClassVar[TaskFindingSeverity]
    TASK_FINDING_SEVERITY_MEDIUM: _ClassVar[TaskFindingSeverity]
    TASK_FINDING_SEVERITY_LOW: _ClassVar[TaskFindingSeverity]

class ExecutionSource(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    EXECUTION_SOURCE_UNSPECIFIED: _ClassVar[ExecutionSource]
    EXECUTION_SOURCE_DEFAULT: _ClassVar[ExecutionSource]
    EXECUTION_SOURCE_CHOSEN: _ClassVar[ExecutionSource]

class ModelSource(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    MODEL_SOURCE_UNSPECIFIED: _ClassVar[ModelSource]
    MODEL_SOURCE_TASK: _ClassVar[ModelSource]
    MODEL_SOURCE_HOST_DEFAULT: _ClassVar[ModelSource]

class MountAccess(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    MOUNT_ACCESS_UNSPECIFIED: _ClassVar[MountAccess]
    MOUNT_ACCESS_READ_ONLY: _ClassVar[MountAccess]
    MOUNT_ACCESS_READ_WRITE: _ClassVar[MountAccess]

class MountOutputStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    MOUNT_OUTPUT_STATUS_UNSPECIFIED: _ClassVar[MountOutputStatus]
    MOUNT_OUTPUT_STATUS_COMPLETE: _ClassVar[MountOutputStatus]
    MOUNT_OUTPUT_STATUS_PARTIAL: _ClassVar[MountOutputStatus]
    MOUNT_OUTPUT_STATUS_REFUSED: _ClassVar[MountOutputStatus]

class PlacementReservationPhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    PLACEMENT_RESERVATION_PHASE_UNSPECIFIED: _ClassVar[PlacementReservationPhase]
    PLACEMENT_RESERVATION_PHASE_RESERVED: _ClassVar[PlacementReservationPhase]
    PLACEMENT_RESERVATION_PHASE_CONSUMED: _ClassVar[PlacementReservationPhase]
    PLACEMENT_RESERVATION_PHASE_EXPIRED: _ClassVar[PlacementReservationPhase]

class PlacementStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    PLACEMENT_STATUS_UNSPECIFIED: _ClassVar[PlacementStatus]
    PLACEMENT_STATUS_NOT_STARTED: _ClassVar[PlacementStatus]
    PLACEMENT_STATUS_PENDING: _ClassVar[PlacementStatus]
    PLACEMENT_STATUS_AVAILABLE: _ClassVar[PlacementStatus]
    PLACEMENT_STATUS_UNKNOWN: _ClassVar[PlacementStatus]

class PlacementMode(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    PLACEMENT_MODE_UNSPECIFIED: _ClassVar[PlacementMode]
    PLACEMENT_MODE_COLOCATED: _ClassVar[PlacementMode]
    PLACEMENT_MODE_SPLIT: _ClassVar[PlacementMode]

class CleanupStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    CLEANUP_STATUS_UNSPECIFIED: _ClassVar[CleanupStatus]
    CLEANUP_STATUS_NOT_STARTED: _ClassVar[CleanupStatus]
    CLEANUP_STATUS_PENDING: _ClassVar[CleanupStatus]
    CLEANUP_STATUS_CONFIRMED: _ClassVar[CleanupStatus]
    CLEANUP_STATUS_UNKNOWN: _ClassVar[CleanupStatus]

class EnvironmentPlacement(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ENVIRONMENT_PLACEMENT_UNSPECIFIED: _ClassVar[EnvironmentPlacement]
    ENVIRONMENT_PLACEMENT_LOCAL: _ClassVar[EnvironmentPlacement]
    ENVIRONMENT_PLACEMENT_REMOTE: _ClassVar[EnvironmentPlacement]
    ENVIRONMENT_PLACEMENT_MANAGED: _ClassVar[EnvironmentPlacement]

class SchedulingStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SCHEDULING_STATUS_UNSPECIFIED: _ClassVar[SchedulingStatus]
    SCHEDULING_STATUS_COMPATIBLE: _ClassVar[SchedulingStatus]
    SCHEDULING_STATUS_INCOMPATIBLE: _ClassVar[SchedulingStatus]

class TaskExecutionAvailability(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TASK_EXECUTION_AVAILABILITY_UNSPECIFIED: _ClassVar[TaskExecutionAvailability]
    TASK_EXECUTION_AVAILABILITY_NOT_STARTED: _ClassVar[TaskExecutionAvailability]
    TASK_EXECUTION_AVAILABILITY_UNSUPPORTED: _ClassVar[TaskExecutionAvailability]
    TASK_EXECUTION_AVAILABILITY_UNAVAILABLE: _ClassVar[TaskExecutionAvailability]
    TASK_EXECUTION_AVAILABILITY_AVAILABLE: _ClassVar[TaskExecutionAvailability]

class LimitOutcomeStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LIMIT_OUTCOME_STATUS_UNSPECIFIED: _ClassVar[LimitOutcomeStatus]
    LIMIT_OUTCOME_STATUS_NOT_REQUESTED: _ClassVar[LimitOutcomeStatus]
    LIMIT_OUTCOME_STATUS_PENDING: _ClassVar[LimitOutcomeStatus]
    LIMIT_OUTCOME_STATUS_WITHIN_LIMITS: _ClassVar[LimitOutcomeStatus]
    LIMIT_OUTCOME_STATUS_THRESHOLD_REACHED: _ClassVar[LimitOutcomeStatus]
    LIMIT_OUTCOME_STATUS_UNKNOWN: _ClassVar[LimitOutcomeStatus]

class SessionPhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SESSION_PHASE_UNSPECIFIED: _ClassVar[SessionPhase]
    SESSION_PHASE_OPEN: _ClassVar[SessionPhase]

class SessionAudience(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SESSION_AUDIENCE_UNSPECIFIED: _ClassVar[SessionAudience]
    SESSION_AUDIENCE_SHARED: _ClassVar[SessionAudience]
    SESSION_AUDIENCE_PRIVATE: _ClassVar[SessionAudience]

class SessionStateStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SESSION_STATE_STATUS_UNSPECIFIED: _ClassVar[SessionStateStatus]
    SESSION_STATE_STATUS_STORED: _ClassVar[SessionStateStatus]
    SESSION_STATE_STATUS_RESUMABLE: _ClassVar[SessionStateStatus]
OUTPUT_GIT_MODE_UNSPECIFIED: OutputGitMode
OUTPUT_GIT_MODE_REFERENCE: OutputGitMode
OUTPUT_GIT_MODE_CAPTURE: OutputGitMode
OUTPUT_GIT_MODE_IGNORE: OutputGitMode
TASK_FINDING_SEVERITY_UNSPECIFIED: TaskFindingSeverity
TASK_FINDING_SEVERITY_HIGH: TaskFindingSeverity
TASK_FINDING_SEVERITY_MEDIUM: TaskFindingSeverity
TASK_FINDING_SEVERITY_LOW: TaskFindingSeverity
EXECUTION_SOURCE_UNSPECIFIED: ExecutionSource
EXECUTION_SOURCE_DEFAULT: ExecutionSource
EXECUTION_SOURCE_CHOSEN: ExecutionSource
MODEL_SOURCE_UNSPECIFIED: ModelSource
MODEL_SOURCE_TASK: ModelSource
MODEL_SOURCE_HOST_DEFAULT: ModelSource
MOUNT_ACCESS_UNSPECIFIED: MountAccess
MOUNT_ACCESS_READ_ONLY: MountAccess
MOUNT_ACCESS_READ_WRITE: MountAccess
MOUNT_OUTPUT_STATUS_UNSPECIFIED: MountOutputStatus
MOUNT_OUTPUT_STATUS_COMPLETE: MountOutputStatus
MOUNT_OUTPUT_STATUS_PARTIAL: MountOutputStatus
MOUNT_OUTPUT_STATUS_REFUSED: MountOutputStatus
PLACEMENT_RESERVATION_PHASE_UNSPECIFIED: PlacementReservationPhase
PLACEMENT_RESERVATION_PHASE_RESERVED: PlacementReservationPhase
PLACEMENT_RESERVATION_PHASE_CONSUMED: PlacementReservationPhase
PLACEMENT_RESERVATION_PHASE_EXPIRED: PlacementReservationPhase
PLACEMENT_STATUS_UNSPECIFIED: PlacementStatus
PLACEMENT_STATUS_NOT_STARTED: PlacementStatus
PLACEMENT_STATUS_PENDING: PlacementStatus
PLACEMENT_STATUS_AVAILABLE: PlacementStatus
PLACEMENT_STATUS_UNKNOWN: PlacementStatus
PLACEMENT_MODE_UNSPECIFIED: PlacementMode
PLACEMENT_MODE_COLOCATED: PlacementMode
PLACEMENT_MODE_SPLIT: PlacementMode
CLEANUP_STATUS_UNSPECIFIED: CleanupStatus
CLEANUP_STATUS_NOT_STARTED: CleanupStatus
CLEANUP_STATUS_PENDING: CleanupStatus
CLEANUP_STATUS_CONFIRMED: CleanupStatus
CLEANUP_STATUS_UNKNOWN: CleanupStatus
ENVIRONMENT_PLACEMENT_UNSPECIFIED: EnvironmentPlacement
ENVIRONMENT_PLACEMENT_LOCAL: EnvironmentPlacement
ENVIRONMENT_PLACEMENT_REMOTE: EnvironmentPlacement
ENVIRONMENT_PLACEMENT_MANAGED: EnvironmentPlacement
SCHEDULING_STATUS_UNSPECIFIED: SchedulingStatus
SCHEDULING_STATUS_COMPATIBLE: SchedulingStatus
SCHEDULING_STATUS_INCOMPATIBLE: SchedulingStatus
TASK_EXECUTION_AVAILABILITY_UNSPECIFIED: TaskExecutionAvailability
TASK_EXECUTION_AVAILABILITY_NOT_STARTED: TaskExecutionAvailability
TASK_EXECUTION_AVAILABILITY_UNSUPPORTED: TaskExecutionAvailability
TASK_EXECUTION_AVAILABILITY_UNAVAILABLE: TaskExecutionAvailability
TASK_EXECUTION_AVAILABILITY_AVAILABLE: TaskExecutionAvailability
LIMIT_OUTCOME_STATUS_UNSPECIFIED: LimitOutcomeStatus
LIMIT_OUTCOME_STATUS_NOT_REQUESTED: LimitOutcomeStatus
LIMIT_OUTCOME_STATUS_PENDING: LimitOutcomeStatus
LIMIT_OUTCOME_STATUS_WITHIN_LIMITS: LimitOutcomeStatus
LIMIT_OUTCOME_STATUS_THRESHOLD_REACHED: LimitOutcomeStatus
LIMIT_OUTCOME_STATUS_UNKNOWN: LimitOutcomeStatus
SESSION_PHASE_UNSPECIFIED: SessionPhase
SESSION_PHASE_OPEN: SessionPhase
SESSION_AUDIENCE_UNSPECIFIED: SessionAudience
SESSION_AUDIENCE_SHARED: SessionAudience
SESSION_AUDIENCE_PRIVATE: SessionAudience
SESSION_STATE_STATUS_UNSPECIFIED: SessionStateStatus
SESSION_STATE_STATUS_STORED: SessionStateStatus
SESSION_STATE_STATUS_RESUMABLE: SessionStateStatus

class ListTasksRequest(_message.Message):
    __slots__ = ("tag", "session_id", "objective_id", "statuses", "page_size", "page_token")
    TAG_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    STATUSES_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    tag: str
    session_id: str
    objective_id: str
    statuses: _containers.RepeatedScalarFieldContainer[_task_pb2.TaskStatus]
    page_size: int
    page_token: str
    def __init__(self, tag: _Optional[str] = ..., session_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., statuses: _Optional[_Iterable[_Union[_task_pb2.TaskStatus, str]]] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListTasksResponse(_message.Message):
    __slots__ = ("tasks", "next_page_token")
    TASKS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    tasks: _containers.RepeatedCompositeFieldContainer[Task]
    next_page_token: str
    def __init__(self, tasks: _Optional[_Iterable[_Union[Task, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class GetTaskRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class ListTaskEventsRequest(_message.Message):
    __slots__ = ("task_id", "after_sequence", "page_size", "page_token")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    AFTER_SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    after_sequence: int
    page_size: int
    page_token: str
    def __init__(self, task_id: _Optional[str] = ..., after_sequence: _Optional[int] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListTaskEventsResponse(_message.Message):
    __slots__ = ("events", "next_page_token")
    EVENTS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    events: _containers.RepeatedCompositeFieldContainer[TaskEvent]
    next_page_token: str
    def __init__(self, events: _Optional[_Iterable[_Union[TaskEvent, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class InspectTaskExecutionRequest(_message.Message):
    __slots__ = ("task_id",)
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    def __init__(self, task_id: _Optional[str] = ...) -> None: ...

class CancelTaskRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class CancelTaskResponse(_message.Message):
    __slots__ = ("task_id", "accepted", "status")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ACCEPTED_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    accepted: bool
    status: _task_pb2.TaskStatus
    def __init__(self, task_id: _Optional[str] = ..., accepted: _Optional[bool] = ..., status: _Optional[_Union[_task_pb2.TaskStatus, str]] = ...) -> None: ...

class ListSessionsRequest(_message.Message):
    __slots__ = ("tag", "parent_session_id", "objective_id", "page_size", "page_token")
    TAG_FIELD_NUMBER: _ClassVar[int]
    PARENT_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    tag: str
    parent_session_id: str
    objective_id: str
    page_size: int
    page_token: str
    def __init__(self, tag: _Optional[str] = ..., parent_session_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListSessionsResponse(_message.Message):
    __slots__ = ("sessions", "next_page_token")
    SESSIONS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    sessions: _containers.RepeatedCompositeFieldContainer[Session]
    next_page_token: str
    def __init__(self, sessions: _Optional[_Iterable[_Union[Session, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class GetSessionRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class ListSessionStatesRequest(_message.Message):
    __slots__ = ("session_id", "native_id", "page_size", "page_token")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    NATIVE_ID_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    native_id: str
    page_size: int
    page_token: str
    def __init__(self, session_id: _Optional[str] = ..., native_id: _Optional[str] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListSessionStatesResponse(_message.Message):
    __slots__ = ("states", "next_page_token")
    STATES_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    states: _containers.RepeatedCompositeFieldContainer[SessionState]
    next_page_token: str
    def __init__(self, states: _Optional[_Iterable[_Union[SessionState, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class GetSessionStateRequest(_message.Message):
    __slots__ = ("session_id", "id")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    id: str
    def __init__(self, session_id: _Optional[str] = ..., id: _Optional[str] = ...) -> None: ...

class ListArtifactsRequest(_message.Message):
    __slots__ = ("task_id", "page_size", "page_token")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    page_size: int
    page_token: str
    def __init__(self, task_id: _Optional[str] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListArtifactsResponse(_message.Message):
    __slots__ = ("artifacts", "next_page_token")
    ARTIFACTS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    artifacts: _containers.RepeatedCompositeFieldContainer[Artifact]
    next_page_token: str
    def __init__(self, artifacts: _Optional[_Iterable[_Union[Artifact, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class GetArtifactRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class ResolveArtifactDownloadRequest(_message.Message):
    __slots__ = ("artifact_id", "path")
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    path: str
    def __init__(self, artifact_id: _Optional[str] = ..., path: _Optional[str] = ...) -> None: ...

class Task(_message.Message):
    __slots__ = ("id", "resource_version", "tag_id", "tag", "session_id", "objective_id", "status", "created_at", "updated_at", "started_at", "ended_at", "execution", "trigger", "workspace", "outcome", "findings", "resolution", "skills", "prepared_workspace", "attempts", "latest_attempt", "scheduling", "pull_request", "delivery", "storage")
    ID_FIELD_NUMBER: _ClassVar[int]
    RESOURCE_VERSION_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    ENDED_AT_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_FIELD_NUMBER: _ClassVar[int]
    TRIGGER_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    FINDINGS_FIELD_NUMBER: _ClassVar[int]
    RESOLUTION_FIELD_NUMBER: _ClassVar[int]
    SKILLS_FIELD_NUMBER: _ClassVar[int]
    PREPARED_WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    LATEST_ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    SCHEDULING_FIELD_NUMBER: _ClassVar[int]
    PULL_REQUEST_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_FIELD_NUMBER: _ClassVar[int]
    STORAGE_FIELD_NUMBER: _ClassVar[int]
    id: str
    resource_version: str
    tag_id: str
    tag: str
    session_id: str
    objective_id: str
    status: _task_pb2.TaskStatus
    created_at: _timestamp_pb2.Timestamp
    updated_at: _timestamp_pb2.Timestamp
    started_at: _timestamp_pb2.Timestamp
    ended_at: _timestamp_pb2.Timestamp
    execution: TaskExecution
    trigger: _struct_pb2.Struct
    workspace: TaskWorkspace
    outcome: _struct_pb2.Struct
    findings: TaskFindings
    resolution: ExecutionResolution
    skills: _containers.RepeatedCompositeFieldContainer[DeliveredSkill]
    prepared_workspace: PreparedWorkspace
    attempts: _containers.RepeatedCompositeFieldContainer[TaskAttempt]
    latest_attempt: LatestTaskAttempt
    scheduling: SchedulingCheck
    pull_request: _task_pb2.PullRequestDelivery
    delivery: _task_pb2.TaskDelivery
    storage: TaskStorage
    def __init__(self, id: _Optional[str] = ..., resource_version: _Optional[str] = ..., tag_id: _Optional[str] = ..., tag: _Optional[str] = ..., session_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., status: _Optional[_Union[_task_pb2.TaskStatus, str]] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., updated_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., started_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., ended_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., execution: _Optional[_Union[TaskExecution, _Mapping]] = ..., trigger: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., workspace: _Optional[_Union[TaskWorkspace, _Mapping]] = ..., outcome: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., findings: _Optional[_Union[TaskFindings, _Mapping]] = ..., resolution: _Optional[_Union[ExecutionResolution, _Mapping]] = ..., skills: _Optional[_Iterable[_Union[DeliveredSkill, _Mapping]]] = ..., prepared_workspace: _Optional[_Union[PreparedWorkspace, _Mapping]] = ..., attempts: _Optional[_Iterable[_Union[TaskAttempt, _Mapping]]] = ..., latest_attempt: _Optional[_Union[LatestTaskAttempt, _Mapping]] = ..., scheduling: _Optional[_Union[SchedulingCheck, _Mapping]] = ..., pull_request: _Optional[_Union[_task_pb2.PullRequestDelivery, _Mapping]] = ..., delivery: _Optional[_Union[_task_pb2.TaskDelivery, _Mapping]] = ..., storage: _Optional[_Union[TaskStorage, _Mapping]] = ...) -> None: ...

class TaskExecution(_message.Message):
    __slots__ = ("harness", "model", "effort", "profile", "requires", "prefers", "outputs", "limits")
    HARNESS_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    EFFORT_FIELD_NUMBER: _ClassVar[int]
    PROFILE_FIELD_NUMBER: _ClassVar[int]
    REQUIRES_FIELD_NUMBER: _ClassVar[int]
    PREFERS_FIELD_NUMBER: _ClassVar[int]
    OUTPUTS_FIELD_NUMBER: _ClassVar[int]
    LIMITS_FIELD_NUMBER: _ClassVar[int]
    harness: str
    model: str
    effort: str
    profile: WorkerProfileRef
    requires: _containers.RepeatedCompositeFieldContainer[CapabilityRequirement]
    prefers: _containers.RepeatedCompositeFieldContainer[CapabilityRequirement]
    outputs: OutputPolicy
    limits: ExecutionLimits
    def __init__(self, harness: _Optional[str] = ..., model: _Optional[str] = ..., effort: _Optional[str] = ..., profile: _Optional[_Union[WorkerProfileRef, _Mapping]] = ..., requires: _Optional[_Iterable[_Union[CapabilityRequirement, _Mapping]]] = ..., prefers: _Optional[_Iterable[_Union[CapabilityRequirement, _Mapping]]] = ..., outputs: _Optional[_Union[OutputPolicy, _Mapping]] = ..., limits: _Optional[_Union[ExecutionLimits, _Mapping]] = ...) -> None: ...

class WorkerProfileRef(_message.Message):
    __slots__ = ("id", "revision")
    ID_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    id: str
    revision: str
    def __init__(self, id: _Optional[str] = ..., revision: _Optional[str] = ...) -> None: ...

class CapabilityRequirement(_message.Message):
    __slots__ = ("id", "version")
    ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    id: str
    version: int
    def __init__(self, id: _Optional[str] = ..., version: _Optional[int] = ...) -> None: ...

class OutputPolicy(_message.Message):
    __slots__ = ("directory", "required", "include", "exclude", "git", "max_files", "max_bytes")
    DIRECTORY_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    INCLUDE_FIELD_NUMBER: _ClassVar[int]
    EXCLUDE_FIELD_NUMBER: _ClassVar[int]
    GIT_FIELD_NUMBER: _ClassVar[int]
    MAX_FILES_FIELD_NUMBER: _ClassVar[int]
    MAX_BYTES_FIELD_NUMBER: _ClassVar[int]
    directory: str
    required: _containers.RepeatedScalarFieldContainer[str]
    include: _containers.RepeatedScalarFieldContainer[str]
    exclude: _containers.RepeatedScalarFieldContainer[str]
    git: OutputGitMode
    max_files: int
    max_bytes: int
    def __init__(self, directory: _Optional[str] = ..., required: _Optional[_Iterable[str]] = ..., include: _Optional[_Iterable[str]] = ..., exclude: _Optional[_Iterable[str]] = ..., git: _Optional[_Union[OutputGitMode, str]] = ..., max_files: _Optional[int] = ..., max_bytes: _Optional[int] = ...) -> None: ...

class ExecutionLimits(_message.Message):
    __slots__ = ("max_native_agents", "max_reported_tokens", "max_reported_cost")
    MAX_NATIVE_AGENTS_FIELD_NUMBER: _ClassVar[int]
    MAX_REPORTED_TOKENS_FIELD_NUMBER: _ClassVar[int]
    MAX_REPORTED_COST_FIELD_NUMBER: _ClassVar[int]
    max_native_agents: int
    max_reported_tokens: int
    max_reported_cost: _common_pb2.Money
    def __init__(self, max_native_agents: _Optional[int] = ..., max_reported_tokens: _Optional[int] = ..., max_reported_cost: _Optional[_Union[_common_pb2.Money, _Mapping]] = ...) -> None: ...

class TaskWorkspace(_message.Message):
    __slots__ = ("name", "branch", "ref", "delivery")
    NAME_FIELD_NUMBER: _ClassVar[int]
    BRANCH_FIELD_NUMBER: _ClassVar[int]
    REF_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_FIELD_NUMBER: _ClassVar[int]
    name: str
    branch: str
    ref: str
    delivery: _task_pb2.WorkspaceDeliveryMode
    def __init__(self, name: _Optional[str] = ..., branch: _Optional[str] = ..., ref: _Optional[str] = ..., delivery: _Optional[_Union[_task_pb2.WorkspaceDeliveryMode, str]] = ...) -> None: ...

class TaskFinding(_message.Message):
    __slots__ = ("id", "severity", "summary", "location")
    ID_FIELD_NUMBER: _ClassVar[int]
    SEVERITY_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    LOCATION_FIELD_NUMBER: _ClassVar[int]
    id: str
    severity: TaskFindingSeverity
    summary: str
    location: str
    def __init__(self, id: _Optional[str] = ..., severity: _Optional[_Union[TaskFindingSeverity, str]] = ..., summary: _Optional[str] = ..., location: _Optional[str] = ...) -> None: ...

class TaskFindings(_message.Message):
    __slots__ = ("findings", "unreadable")
    FINDINGS_FIELD_NUMBER: _ClassVar[int]
    UNREADABLE_FIELD_NUMBER: _ClassVar[int]
    findings: _containers.RepeatedCompositeFieldContainer[TaskFinding]
    unreadable: str
    def __init__(self, findings: _Optional[_Iterable[_Union[TaskFinding, _Mapping]]] = ..., unreadable: _Optional[str] = ...) -> None: ...

class ExecutionResolution(_message.Message):
    __slots__ = ("source", "chosen_by_tag_id", "chosen_by_tag", "harness", "model", "effort", "latest_attempt")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    CHOSEN_BY_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    CHOSEN_BY_TAG_FIELD_NUMBER: _ClassVar[int]
    HARNESS_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    EFFORT_FIELD_NUMBER: _ClassVar[int]
    LATEST_ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    source: ExecutionSource
    chosen_by_tag_id: str
    chosen_by_tag: str
    harness: str
    model: str
    effort: str
    latest_attempt: AttemptExecution
    def __init__(self, source: _Optional[_Union[ExecutionSource, str]] = ..., chosen_by_tag_id: _Optional[str] = ..., chosen_by_tag: _Optional[str] = ..., harness: _Optional[str] = ..., model: _Optional[str] = ..., effort: _Optional[str] = ..., latest_attempt: _Optional[_Union[AttemptExecution, _Mapping]] = ...) -> None: ...

class AttemptExecution(_message.Message):
    __slots__ = ("harness", "model", "model_source", "effort", "effort_ignored")
    HARNESS_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    MODEL_SOURCE_FIELD_NUMBER: _ClassVar[int]
    EFFORT_FIELD_NUMBER: _ClassVar[int]
    EFFORT_IGNORED_FIELD_NUMBER: _ClassVar[int]
    harness: str
    model: str
    model_source: ModelSource
    effort: str
    effort_ignored: str
    def __init__(self, harness: _Optional[str] = ..., model: _Optional[str] = ..., model_source: _Optional[_Union[ModelSource, str]] = ..., effort: _Optional[str] = ..., effort_ignored: _Optional[str] = ...) -> None: ...

class DeliveredSkill(_message.Message):
    __slots__ = ("name", "source", "digest")
    NAME_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    DIGEST_FIELD_NUMBER: _ClassVar[int]
    name: str
    source: str
    digest: str
    def __init__(self, name: _Optional[str] = ..., source: _Optional[str] = ..., digest: _Optional[str] = ...) -> None: ...

class PreparedWorkspace(_message.Message):
    __slots__ = ("digest", "provider", "trusted_commit")
    DIGEST_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    TRUSTED_COMMIT_FIELD_NUMBER: _ClassVar[int]
    digest: str
    provider: str
    trusted_commit: str
    def __init__(self, digest: _Optional[str] = ..., provider: _Optional[str] = ..., trusted_commit: _Optional[str] = ...) -> None: ...

class ReportedCost(_message.Message):
    __slots__ = ("cost", "estimated")
    COST_FIELD_NUMBER: _ClassVar[int]
    ESTIMATED_FIELD_NUMBER: _ClassVar[int]
    cost: _common_pb2.Money
    estimated: bool
    def __init__(self, cost: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., estimated: _Optional[bool] = ...) -> None: ...

class TaskAttempt(_message.Message):
    __slots__ = ("id", "number", "status", "started_at", "ended_at", "reported_cost", "live_mounts", "mount_manifests", "mount_output_manifests")
    ID_FIELD_NUMBER: _ClassVar[int]
    NUMBER_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    ENDED_AT_FIELD_NUMBER: _ClassVar[int]
    REPORTED_COST_FIELD_NUMBER: _ClassVar[int]
    LIVE_MOUNTS_FIELD_NUMBER: _ClassVar[int]
    MOUNT_MANIFESTS_FIELD_NUMBER: _ClassVar[int]
    MOUNT_OUTPUT_MANIFESTS_FIELD_NUMBER: _ClassVar[int]
    id: str
    number: int
    status: _task_pb2.TaskAttemptStatus
    started_at: _timestamp_pb2.Timestamp
    ended_at: _timestamp_pb2.Timestamp
    reported_cost: ReportedCost
    live_mounts: _containers.RepeatedCompositeFieldContainer[LiveMount]
    mount_manifests: _containers.RepeatedCompositeFieldContainer[MountManifest]
    mount_output_manifests: _containers.RepeatedCompositeFieldContainer[MountOutputManifest]
    def __init__(self, id: _Optional[str] = ..., number: _Optional[int] = ..., status: _Optional[_Union[_task_pb2.TaskAttemptStatus, str]] = ..., started_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., ended_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., reported_cost: _Optional[_Union[ReportedCost, _Mapping]] = ..., live_mounts: _Optional[_Iterable[_Union[LiveMount, _Mapping]]] = ..., mount_manifests: _Optional[_Iterable[_Union[MountManifest, _Mapping]]] = ..., mount_output_manifests: _Optional[_Iterable[_Union[MountOutputManifest, _Mapping]]] = ...) -> None: ...

class LiveMount(_message.Message):
    __slots__ = ("volume", "source", "prefix", "path", "access", "attached_at")
    VOLUME_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    PREFIX_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    ACCESS_FIELD_NUMBER: _ClassVar[int]
    ATTACHED_AT_FIELD_NUMBER: _ClassVar[int]
    volume: str
    source: str
    prefix: str
    path: str
    access: MountAccess
    attached_at: _timestamp_pb2.Timestamp
    def __init__(self, volume: _Optional[str] = ..., source: _Optional[str] = ..., prefix: _Optional[str] = ..., path: _Optional[str] = ..., access: _Optional[_Union[MountAccess, str]] = ..., attached_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class MountManifest(_message.Message):
    __slots__ = ("volume", "source", "path", "access", "object_count", "total_bytes", "digest", "copied_at", "objects")
    VOLUME_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    ACCESS_FIELD_NUMBER: _ClassVar[int]
    OBJECT_COUNT_FIELD_NUMBER: _ClassVar[int]
    TOTAL_BYTES_FIELD_NUMBER: _ClassVar[int]
    DIGEST_FIELD_NUMBER: _ClassVar[int]
    COPIED_AT_FIELD_NUMBER: _ClassVar[int]
    OBJECTS_FIELD_NUMBER: _ClassVar[int]
    volume: str
    source: str
    path: str
    access: MountAccess
    object_count: int
    total_bytes: int
    digest: str
    copied_at: _timestamp_pb2.Timestamp
    objects: _containers.RepeatedCompositeFieldContainer[MountObject]
    def __init__(self, volume: _Optional[str] = ..., source: _Optional[str] = ..., path: _Optional[str] = ..., access: _Optional[_Union[MountAccess, str]] = ..., object_count: _Optional[int] = ..., total_bytes: _Optional[int] = ..., digest: _Optional[str] = ..., copied_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., objects: _Optional[_Iterable[_Union[MountObject, _Mapping]]] = ...) -> None: ...

class MountObject(_message.Message):
    __slots__ = ("key", "size", "etag", "version_id", "sha256")
    KEY_FIELD_NUMBER: _ClassVar[int]
    SIZE_FIELD_NUMBER: _ClassVar[int]
    ETAG_FIELD_NUMBER: _ClassVar[int]
    VERSION_ID_FIELD_NUMBER: _ClassVar[int]
    SHA256_FIELD_NUMBER: _ClassVar[int]
    key: str
    size: int
    etag: str
    version_id: str
    sha256: str
    def __init__(self, key: _Optional[str] = ..., size: _Optional[int] = ..., etag: _Optional[str] = ..., version_id: _Optional[str] = ..., sha256: _Optional[str] = ...) -> None: ...

class MountOutputManifest(_message.Message):
    __slots__ = ("volume", "source", "path", "status", "uploaded_at", "objects", "skipped", "error", "not_attempted")
    VOLUME_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    UPLOADED_AT_FIELD_NUMBER: _ClassVar[int]
    OBJECTS_FIELD_NUMBER: _ClassVar[int]
    SKIPPED_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    NOT_ATTEMPTED_FIELD_NUMBER: _ClassVar[int]
    volume: str
    source: str
    path: str
    status: MountOutputStatus
    uploaded_at: _timestamp_pb2.Timestamp
    objects: _containers.RepeatedCompositeFieldContainer[MountUpload]
    skipped: int
    error: MountUploadError
    not_attempted: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, volume: _Optional[str] = ..., source: _Optional[str] = ..., path: _Optional[str] = ..., status: _Optional[_Union[MountOutputStatus, str]] = ..., uploaded_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., objects: _Optional[_Iterable[_Union[MountUpload, _Mapping]]] = ..., skipped: _Optional[int] = ..., error: _Optional[_Union[MountUploadError, _Mapping]] = ..., not_attempted: _Optional[_Iterable[str]] = ...) -> None: ...

class MountUpload(_message.Message):
    __slots__ = ("key", "size", "sha256")
    KEY_FIELD_NUMBER: _ClassVar[int]
    SIZE_FIELD_NUMBER: _ClassVar[int]
    SHA256_FIELD_NUMBER: _ClassVar[int]
    key: str
    size: int
    sha256: str
    def __init__(self, key: _Optional[str] = ..., size: _Optional[int] = ..., sha256: _Optional[str] = ...) -> None: ...

class MountUploadError(_message.Message):
    __slots__ = ("key", "reason")
    KEY_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    key: str
    reason: str
    def __init__(self, key: _Optional[str] = ..., reason: _Optional[str] = ...) -> None: ...

class LatestTaskAttempt(_message.Message):
    __slots__ = ("id", "number", "status", "worker_profile", "durable_execution", "failure", "warnings", "running_command", "worker_id", "worker_host_id", "worklet_id", "selection", "last_event", "placement")
    ID_FIELD_NUMBER: _ClassVar[int]
    NUMBER_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    WORKER_PROFILE_FIELD_NUMBER: _ClassVar[int]
    DURABLE_EXECUTION_FIELD_NUMBER: _ClassVar[int]
    FAILURE_FIELD_NUMBER: _ClassVar[int]
    WARNINGS_FIELD_NUMBER: _ClassVar[int]
    RUNNING_COMMAND_FIELD_NUMBER: _ClassVar[int]
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    WORKER_HOST_ID_FIELD_NUMBER: _ClassVar[int]
    WORKLET_ID_FIELD_NUMBER: _ClassVar[int]
    SELECTION_FIELD_NUMBER: _ClassVar[int]
    LAST_EVENT_FIELD_NUMBER: _ClassVar[int]
    PLACEMENT_FIELD_NUMBER: _ClassVar[int]
    id: str
    number: int
    status: _task_pb2.TaskAttemptStatus
    worker_profile: WorkerProfileRef
    durable_execution: bool
    failure: RecordedEvent
    warnings: _containers.RepeatedCompositeFieldContainer[RecordedEvent]
    running_command: RunningCommand
    worker_id: str
    worker_host_id: str
    worklet_id: str
    selection: PlacementSelection
    last_event: TaskEventRef
    placement: ExecutionPlacement
    def __init__(self, id: _Optional[str] = ..., number: _Optional[int] = ..., status: _Optional[_Union[_task_pb2.TaskAttemptStatus, str]] = ..., worker_profile: _Optional[_Union[WorkerProfileRef, _Mapping]] = ..., durable_execution: _Optional[bool] = ..., failure: _Optional[_Union[RecordedEvent, _Mapping]] = ..., warnings: _Optional[_Iterable[_Union[RecordedEvent, _Mapping]]] = ..., running_command: _Optional[_Union[RunningCommand, _Mapping]] = ..., worker_id: _Optional[str] = ..., worker_host_id: _Optional[str] = ..., worklet_id: _Optional[str] = ..., selection: _Optional[_Union[PlacementSelection, _Mapping]] = ..., last_event: _Optional[_Union[TaskEventRef, _Mapping]] = ..., placement: _Optional[_Union[ExecutionPlacement, _Mapping]] = ...) -> None: ...

class RecordedEvent(_message.Message):
    __slots__ = ("message", "at", "sequence")
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    AT_FIELD_NUMBER: _ClassVar[int]
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    message: str
    at: _timestamp_pb2.Timestamp
    sequence: int
    def __init__(self, message: _Optional[str] = ..., at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., sequence: _Optional[int] = ...) -> None: ...

class RunningCommand(_message.Message):
    __slots__ = ("command", "started_at")
    COMMAND_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    command: str
    started_at: _timestamp_pb2.Timestamp
    def __init__(self, command: _Optional[str] = ..., started_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class PlacementSelection(_message.Message):
    __slots__ = ("allowed_worker_host_ids", "reservation")
    ALLOWED_WORKER_HOST_IDS_FIELD_NUMBER: _ClassVar[int]
    RESERVATION_FIELD_NUMBER: _ClassVar[int]
    allowed_worker_host_ids: _containers.RepeatedScalarFieldContainer[str]
    reservation: PlacementReservation
    def __init__(self, allowed_worker_host_ids: _Optional[_Iterable[str]] = ..., reservation: _Optional[_Union[PlacementReservation, _Mapping]] = ...) -> None: ...

class PlacementReservation(_message.Message):
    __slots__ = ("id", "expires_at", "phase")
    ID_FIELD_NUMBER: _ClassVar[int]
    EXPIRES_AT_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    id: str
    expires_at: _timestamp_pb2.Timestamp
    phase: PlacementReservationPhase
    def __init__(self, id: _Optional[str] = ..., expires_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., phase: _Optional[_Union[PlacementReservationPhase, str]] = ...) -> None: ...

class TaskEventRef(_message.Message):
    __slots__ = ("type", "sequence", "at")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    AT_FIELD_NUMBER: _ClassVar[int]
    type: str
    sequence: int
    at: _timestamp_pb2.Timestamp
    def __init__(self, type: _Optional[str] = ..., sequence: _Optional[int] = ..., at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class ExecutionPlacement(_message.Message):
    __slots__ = ("status", "mode", "cleanup", "cleanup_failure", "harness", "harness_runtime", "execution_environment")
    STATUS_FIELD_NUMBER: _ClassVar[int]
    MODE_FIELD_NUMBER: _ClassVar[int]
    CLEANUP_FIELD_NUMBER: _ClassVar[int]
    CLEANUP_FAILURE_FIELD_NUMBER: _ClassVar[int]
    HARNESS_FIELD_NUMBER: _ClassVar[int]
    HARNESS_RUNTIME_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_ENVIRONMENT_FIELD_NUMBER: _ClassVar[int]
    status: PlacementStatus
    mode: PlacementMode
    cleanup: CleanupStatus
    cleanup_failure: CleanupFailure
    harness: HarnessIdentity
    harness_runtime: ExecutionEnvironment
    execution_environment: ExecutionEnvironment
    def __init__(self, status: _Optional[_Union[PlacementStatus, str]] = ..., mode: _Optional[_Union[PlacementMode, str]] = ..., cleanup: _Optional[_Union[CleanupStatus, str]] = ..., cleanup_failure: _Optional[_Union[CleanupFailure, _Mapping]] = ..., harness: _Optional[_Union[HarnessIdentity, _Mapping]] = ..., harness_runtime: _Optional[_Union[ExecutionEnvironment, _Mapping]] = ..., execution_environment: _Optional[_Union[ExecutionEnvironment, _Mapping]] = ...) -> None: ...

class CleanupFailure(_message.Message):
    __slots__ = ("sequence", "at", "summary", "items")
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    AT_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    sequence: int
    at: _timestamp_pb2.Timestamp
    summary: str
    items: _containers.RepeatedCompositeFieldContainer[CleanupItem]
    def __init__(self, sequence: _Optional[int] = ..., at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., summary: _Optional[str] = ..., items: _Optional[_Iterable[_Union[CleanupItem, _Mapping]]] = ...) -> None: ...

class CleanupItem(_message.Message):
    __slots__ = ("id", "text")
    ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    id: str
    text: str
    def __init__(self, id: _Optional[str] = ..., text: _Optional[str] = ...) -> None: ...

class HarnessIdentity(_message.Message):
    __slots__ = ("id", "version", "provenance")
    ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    PROVENANCE_FIELD_NUMBER: _ClassVar[int]
    id: str
    version: str
    provenance: _struct_pb2.Struct
    def __init__(self, id: _Optional[str] = ..., version: _Optional[str] = ..., provenance: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class ExecutionEnvironment(_message.Message):
    __slots__ = ("id", "provider", "placement", "provenance")
    ID_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    PLACEMENT_FIELD_NUMBER: _ClassVar[int]
    PROVENANCE_FIELD_NUMBER: _ClassVar[int]
    id: str
    provider: str
    placement: EnvironmentPlacement
    provenance: _struct_pb2.Struct
    def __init__(self, id: _Optional[str] = ..., provider: _Optional[str] = ..., placement: _Optional[_Union[EnvironmentPlacement, str]] = ..., provenance: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class SchedulingCheck(_message.Message):
    __slots__ = ("status", "unmet_requirements", "reason", "unsandboxed_commands", "workspace_refusals", "observed_at", "sequence")
    STATUS_FIELD_NUMBER: _ClassVar[int]
    UNMET_REQUIREMENTS_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    UNSANDBOXED_COMMANDS_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_REFUSALS_FIELD_NUMBER: _ClassVar[int]
    OBSERVED_AT_FIELD_NUMBER: _ClassVar[int]
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    status: SchedulingStatus
    unmet_requirements: _containers.RepeatedScalarFieldContainer[str]
    reason: str
    unsandboxed_commands: _containers.RepeatedCompositeFieldContainer[UnsandboxedCommandHold]
    workspace_refusals: _containers.RepeatedScalarFieldContainer[str]
    observed_at: _timestamp_pb2.Timestamp
    sequence: int
    def __init__(self, status: _Optional[_Union[SchedulingStatus, str]] = ..., unmet_requirements: _Optional[_Iterable[str]] = ..., reason: _Optional[str] = ..., unsandboxed_commands: _Optional[_Iterable[_Union[UnsandboxedCommandHold, _Mapping]]] = ..., workspace_refusals: _Optional[_Iterable[str]] = ..., observed_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., sequence: _Optional[int] = ...) -> None: ...

class UnsandboxedCommandHold(_message.Message):
    __slots__ = ("worker_host_id", "harnesses")
    WORKER_HOST_ID_FIELD_NUMBER: _ClassVar[int]
    HARNESSES_FIELD_NUMBER: _ClassVar[int]
    worker_host_id: str
    harnesses: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, worker_host_id: _Optional[str] = ..., harnesses: _Optional[_Iterable[str]] = ...) -> None: ...

class TaskStorage(_message.Message):
    __slots__ = ("task_files", "artifacts", "more_artifacts")
    TASK_FILES_FIELD_NUMBER: _ClassVar[int]
    ARTIFACTS_FIELD_NUMBER: _ClassVar[int]
    MORE_ARTIFACTS_FIELD_NUMBER: _ClassVar[int]
    task_files: TaskFiles
    artifacts: _containers.RepeatedCompositeFieldContainer[TaskArtifactStorage]
    more_artifacts: bool
    def __init__(self, task_files: _Optional[_Union[TaskFiles, _Mapping]] = ..., artifacts: _Optional[_Iterable[_Union[TaskArtifactStorage, _Mapping]]] = ..., more_artifacts: _Optional[bool] = ...) -> None: ...

class TaskFiles(_message.Message):
    __slots__ = ("worker_host_id", "ephemeral", "sandbox", "placement_unknown")
    WORKER_HOST_ID_FIELD_NUMBER: _ClassVar[int]
    EPHEMERAL_FIELD_NUMBER: _ClassVar[int]
    SANDBOX_FIELD_NUMBER: _ClassVar[int]
    PLACEMENT_UNKNOWN_FIELD_NUMBER: _ClassVar[int]
    worker_host_id: str
    ephemeral: bool
    sandbox: str
    placement_unknown: bool
    def __init__(self, worker_host_id: _Optional[str] = ..., ephemeral: _Optional[bool] = ..., sandbox: _Optional[str] = ..., placement_unknown: _Optional[bool] = ...) -> None: ...

class TaskArtifactStorage(_message.Message):
    __slots__ = ("artifact_id", "title", "files", "copies", "ephemeral_only")
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    FILES_FIELD_NUMBER: _ClassVar[int]
    COPIES_FIELD_NUMBER: _ClassVar[int]
    EPHEMERAL_ONLY_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    title: str
    files: int
    copies: _containers.RepeatedCompositeFieldContainer[ArtifactCopy]
    ephemeral_only: bool
    def __init__(self, artifact_id: _Optional[str] = ..., title: _Optional[str] = ..., files: _Optional[int] = ..., copies: _Optional[_Iterable[_Union[ArtifactCopy, _Mapping]]] = ..., ephemeral_only: _Optional[bool] = ...) -> None: ...

class ArtifactCopy(_message.Message):
    __slots__ = ("worker_host", "volume")
    WORKER_HOST_FIELD_NUMBER: _ClassVar[int]
    VOLUME_FIELD_NUMBER: _ClassVar[int]
    worker_host: WorkerHostCopy
    volume: VolumeCopy
    def __init__(self, worker_host: _Optional[_Union[WorkerHostCopy, _Mapping]] = ..., volume: _Optional[_Union[VolumeCopy, _Mapping]] = ...) -> None: ...

class WorkerHostCopy(_message.Message):
    __slots__ = ("worker_host_id", "ephemeral", "removed")
    WORKER_HOST_ID_FIELD_NUMBER: _ClassVar[int]
    EPHEMERAL_FIELD_NUMBER: _ClassVar[int]
    REMOVED_FIELD_NUMBER: _ClassVar[int]
    worker_host_id: str
    ephemeral: bool
    removed: bool
    def __init__(self, worker_host_id: _Optional[str] = ..., ephemeral: _Optional[bool] = ..., removed: _Optional[bool] = ...) -> None: ...

class VolumeCopy(_message.Message):
    __slots__ = ("volume",)
    VOLUME_FIELD_NUMBER: _ClassVar[int]
    volume: str
    def __init__(self, volume: _Optional[str] = ...) -> None: ...

class TaskEvent(_message.Message):
    __slots__ = ("id", "task_id", "attempt_id", "sequence", "type", "payload", "created_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    PAYLOAD_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    task_id: str
    attempt_id: str
    sequence: int
    type: str
    payload: _struct_pb2.Struct
    created_at: _timestamp_pb2.Timestamp
    def __init__(self, id: _Optional[str] = ..., task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., sequence: _Optional[int] = ..., type: _Optional[str] = ..., payload: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class InspectTaskExecutionResponse(_message.Message):
    __slots__ = ("availability", "attempt_id", "receipt", "limits", "placement")
    AVAILABILITY_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    RECEIPT_FIELD_NUMBER: _ClassVar[int]
    LIMITS_FIELD_NUMBER: _ClassVar[int]
    PLACEMENT_FIELD_NUMBER: _ClassVar[int]
    availability: TaskExecutionAvailability
    attempt_id: str
    receipt: _struct_pb2.Struct
    limits: ExecutionLimitReport
    placement: ExecutionPlacement
    def __init__(self, availability: _Optional[_Union[TaskExecutionAvailability, str]] = ..., attempt_id: _Optional[str] = ..., receipt: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., limits: _Optional[_Union[ExecutionLimitReport, _Mapping]] = ..., placement: _Optional[_Union[ExecutionPlacement, _Mapping]] = ...) -> None: ...

class ExecutionLimitReport(_message.Message):
    __slots__ = ("requested", "applied", "observed", "completeness", "outcome")
    REQUESTED_FIELD_NUMBER: _ClassVar[int]
    APPLIED_FIELD_NUMBER: _ClassVar[int]
    OBSERVED_FIELD_NUMBER: _ClassVar[int]
    COMPLETENESS_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    requested: ExecutionLimits
    applied: AppliedExecutionLimits
    observed: ExecutionObservation
    completeness: LimitCompleteness
    outcome: LimitOutcome
    def __init__(self, requested: _Optional[_Union[ExecutionLimits, _Mapping]] = ..., applied: _Optional[_Union[AppliedExecutionLimits, _Mapping]] = ..., observed: _Optional[_Union[ExecutionObservation, _Mapping]] = ..., completeness: _Optional[_Union[LimitCompleteness, _Mapping]] = ..., outcome: _Optional[_Union[LimitOutcome, _Mapping]] = ...) -> None: ...

class AppliedExecutionLimits(_message.Message):
    __slots__ = ("max_native_agents", "max_reported_tokens", "max_reported_cost")
    MAX_NATIVE_AGENTS_FIELD_NUMBER: _ClassVar[int]
    MAX_REPORTED_TOKENS_FIELD_NUMBER: _ClassVar[int]
    MAX_REPORTED_COST_FIELD_NUMBER: _ClassVar[int]
    max_native_agents: AppliedLimit
    max_reported_tokens: AppliedLimit
    max_reported_cost: AppliedCostLimit
    def __init__(self, max_native_agents: _Optional[_Union[AppliedLimit, _Mapping]] = ..., max_reported_tokens: _Optional[_Union[AppliedLimit, _Mapping]] = ..., max_reported_cost: _Optional[_Union[AppliedCostLimit, _Mapping]] = ...) -> None: ...

class AppliedLimit(_message.Message):
    __slots__ = ("limit", "method")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    METHOD_FIELD_NUMBER: _ClassVar[int]
    limit: int
    method: str
    def __init__(self, limit: _Optional[int] = ..., method: _Optional[str] = ...) -> None: ...

class AppliedCostLimit(_message.Message):
    __slots__ = ("limit", "method")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    METHOD_FIELD_NUMBER: _ClassVar[int]
    limit: _common_pb2.Money
    method: str
    def __init__(self, limit: _Optional[_Union[_common_pb2.Money, _Mapping]] = ..., method: _Optional[str] = ...) -> None: ...

class ExecutionObservation(_message.Message):
    __slots__ = ("usage", "peak_native_agents")
    USAGE_FIELD_NUMBER: _ClassVar[int]
    PEAK_NATIVE_AGENTS_FIELD_NUMBER: _ClassVar[int]
    usage: ExecutionUsage
    peak_native_agents: int
    def __init__(self, usage: _Optional[_Union[ExecutionUsage, _Mapping]] = ..., peak_native_agents: _Optional[int] = ...) -> None: ...

class ExecutionUsage(_message.Message):
    __slots__ = ("input_tokens", "output_tokens", "cached_input_tokens", "cache_write_tokens", "reasoning_tokens", "total_tokens", "complete", "reported_cost", "unpriced_model")
    INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    CACHED_INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    CACHE_WRITE_TOKENS_FIELD_NUMBER: _ClassVar[int]
    REASONING_TOKENS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TOKENS_FIELD_NUMBER: _ClassVar[int]
    COMPLETE_FIELD_NUMBER: _ClassVar[int]
    REPORTED_COST_FIELD_NUMBER: _ClassVar[int]
    UNPRICED_MODEL_FIELD_NUMBER: _ClassVar[int]
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int
    cache_write_tokens: int
    reasoning_tokens: int
    total_tokens: int
    complete: bool
    reported_cost: ReportedCost
    unpriced_model: str
    def __init__(self, input_tokens: _Optional[int] = ..., output_tokens: _Optional[int] = ..., cached_input_tokens: _Optional[int] = ..., cache_write_tokens: _Optional[int] = ..., reasoning_tokens: _Optional[int] = ..., total_tokens: _Optional[int] = ..., complete: _Optional[bool] = ..., reported_cost: _Optional[_Union[ReportedCost, _Mapping]] = ..., unpriced_model: _Optional[str] = ...) -> None: ...

class LimitCompleteness(_message.Message):
    __slots__ = ("applied", "usage", "terminal", "complete")
    APPLIED_FIELD_NUMBER: _ClassVar[int]
    USAGE_FIELD_NUMBER: _ClassVar[int]
    TERMINAL_FIELD_NUMBER: _ClassVar[int]
    COMPLETE_FIELD_NUMBER: _ClassVar[int]
    applied: bool
    usage: bool
    terminal: bool
    complete: bool
    def __init__(self, applied: _Optional[bool] = ..., usage: _Optional[bool] = ..., terminal: _Optional[bool] = ..., complete: _Optional[bool] = ...) -> None: ...

class LimitOutcome(_message.Message):
    __slots__ = ("status", "threshold_reached")
    STATUS_FIELD_NUMBER: _ClassVar[int]
    THRESHOLD_REACHED_FIELD_NUMBER: _ClassVar[int]
    status: LimitOutcomeStatus
    threshold_reached: LimitThresholds
    def __init__(self, status: _Optional[_Union[LimitOutcomeStatus, str]] = ..., threshold_reached: _Optional[_Union[LimitThresholds, _Mapping]] = ...) -> None: ...

class LimitThresholds(_message.Message):
    __slots__ = ("max_native_agents", "max_reported_tokens", "max_reported_cost")
    MAX_NATIVE_AGENTS_FIELD_NUMBER: _ClassVar[int]
    MAX_REPORTED_TOKENS_FIELD_NUMBER: _ClassVar[int]
    MAX_REPORTED_COST_FIELD_NUMBER: _ClassVar[int]
    max_native_agents: bool
    max_reported_tokens: bool
    max_reported_cost: bool
    def __init__(self, max_native_agents: _Optional[bool] = ..., max_reported_tokens: _Optional[bool] = ..., max_reported_cost: _Optional[bool] = ...) -> None: ...

class Session(_message.Message):
    __slots__ = ("id", "resource_version", "tag_id", "tag", "session_key", "origin", "phase", "audience", "parent_session_id", "objective_id", "title", "latest_task_id", "latest_task_status", "last_interaction_at", "created_at", "updated_at", "delivery")
    ID_FIELD_NUMBER: _ClassVar[int]
    RESOURCE_VERSION_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_FIELD_NUMBER: _ClassVar[int]
    SESSION_KEY_FIELD_NUMBER: _ClassVar[int]
    ORIGIN_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    AUDIENCE_FIELD_NUMBER: _ClassVar[int]
    PARENT_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    LATEST_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    LATEST_TASK_STATUS_FIELD_NUMBER: _ClassVar[int]
    LAST_INTERACTION_AT_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_FIELD_NUMBER: _ClassVar[int]
    id: str
    resource_version: str
    tag_id: str
    tag: str
    session_key: str
    origin: _struct_pb2.Struct
    phase: SessionPhase
    audience: SessionAudience
    parent_session_id: str
    objective_id: str
    title: str
    latest_task_id: str
    latest_task_status: _task_pb2.TaskStatus
    last_interaction_at: _timestamp_pb2.Timestamp
    created_at: _timestamp_pb2.Timestamp
    updated_at: _timestamp_pb2.Timestamp
    delivery: SessionDelivery
    def __init__(self, id: _Optional[str] = ..., resource_version: _Optional[str] = ..., tag_id: _Optional[str] = ..., tag: _Optional[str] = ..., session_key: _Optional[str] = ..., origin: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., phase: _Optional[_Union[SessionPhase, str]] = ..., audience: _Optional[_Union[SessionAudience, str]] = ..., parent_session_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., title: _Optional[str] = ..., latest_task_id: _Optional[str] = ..., latest_task_status: _Optional[_Union[_task_pb2.TaskStatus, str]] = ..., last_interaction_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., updated_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., delivery: _Optional[_Union[SessionDelivery, _Mapping]] = ...) -> None: ...

class SessionDelivery(_message.Message):
    __slots__ = ("task_id", "delivery", "checkout")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_FIELD_NUMBER: _ClassVar[int]
    CHECKOUT_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    delivery: _task_pb2.TaskDelivery
    checkout: TaskFiles
    def __init__(self, task_id: _Optional[str] = ..., delivery: _Optional[_Union[_task_pb2.TaskDelivery, _Mapping]] = ..., checkout: _Optional[_Union[TaskFiles, _Mapping]] = ...) -> None: ...

class SessionState(_message.Message):
    __slots__ = ("id", "session_id", "task_id", "attempt_id", "harness_id", "native_id", "ref", "status", "write_version", "compatibility", "worker_profile", "created_at", "updated_at", "data")
    ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    HARNESS_ID_FIELD_NUMBER: _ClassVar[int]
    NATIVE_ID_FIELD_NUMBER: _ClassVar[int]
    REF_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    WRITE_VERSION_FIELD_NUMBER: _ClassVar[int]
    COMPATIBILITY_FIELD_NUMBER: _ClassVar[int]
    WORKER_PROFILE_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    id: str
    session_id: str
    task_id: str
    attempt_id: str
    harness_id: str
    native_id: str
    ref: _struct_pb2.Struct
    status: SessionStateStatus
    write_version: int
    compatibility: str
    worker_profile: WorkerProfileRef
    created_at: _timestamp_pb2.Timestamp
    updated_at: _timestamp_pb2.Timestamp
    data: _struct_pb2.Struct
    def __init__(self, id: _Optional[str] = ..., session_id: _Optional[str] = ..., task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., harness_id: _Optional[str] = ..., native_id: _Optional[str] = ..., ref: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., status: _Optional[_Union[SessionStateStatus, str]] = ..., write_version: _Optional[int] = ..., compatibility: _Optional[str] = ..., worker_profile: _Optional[_Union[WorkerProfileRef, _Mapping]] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., updated_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., data: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class Artifact(_message.Message):
    __slots__ = ("id", "task_id", "attempt_id", "tag_id", "objective_id", "session_id", "operation_id", "harness_session", "title", "summary", "kind", "entries", "inputs", "created_at", "copies", "ephemeral_only")
    ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    HARNESS_SESSION_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    ENTRIES_FIELD_NUMBER: _ClassVar[int]
    INPUTS_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    COPIES_FIELD_NUMBER: _ClassVar[int]
    EPHEMERAL_ONLY_FIELD_NUMBER: _ClassVar[int]
    id: str
    task_id: str
    attempt_id: str
    tag_id: str
    objective_id: str
    session_id: str
    operation_id: str
    harness_session: HarnessSession
    title: str
    summary: str
    kind: str
    entries: _containers.RepeatedCompositeFieldContainer[ArtifactEntry]
    inputs: _containers.RepeatedCompositeFieldContainer[ArtifactSelection]
    created_at: _timestamp_pb2.Timestamp
    copies: _containers.RepeatedCompositeFieldContainer[ArtifactCopy]
    ephemeral_only: bool
    def __init__(self, id: _Optional[str] = ..., task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., session_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., harness_session: _Optional[_Union[HarnessSession, _Mapping]] = ..., title: _Optional[str] = ..., summary: _Optional[str] = ..., kind: _Optional[str] = ..., entries: _Optional[_Iterable[_Union[ArtifactEntry, _Mapping]]] = ..., inputs: _Optional[_Iterable[_Union[ArtifactSelection, _Mapping]]] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., copies: _Optional[_Iterable[_Union[ArtifactCopy, _Mapping]]] = ..., ephemeral_only: _Optional[bool] = ...) -> None: ...

class HarnessSession(_message.Message):
    __slots__ = ("harness_id", "id")
    HARNESS_ID_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    harness_id: str
    id: str
    def __init__(self, harness_id: _Optional[str] = ..., id: _Optional[str] = ...) -> None: ...

class ArtifactEntry(_message.Message):
    __slots__ = ("path", "uri", "digest", "size_bytes", "media_type")
    PATH_FIELD_NUMBER: _ClassVar[int]
    URI_FIELD_NUMBER: _ClassVar[int]
    DIGEST_FIELD_NUMBER: _ClassVar[int]
    SIZE_BYTES_FIELD_NUMBER: _ClassVar[int]
    MEDIA_TYPE_FIELD_NUMBER: _ClassVar[int]
    path: str
    uri: str
    digest: str
    size_bytes: int
    media_type: str
    def __init__(self, path: _Optional[str] = ..., uri: _Optional[str] = ..., digest: _Optional[str] = ..., size_bytes: _Optional[int] = ..., media_type: _Optional[str] = ...) -> None: ...

class ArtifactSelection(_message.Message):
    __slots__ = ("artifact_id", "paths")
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    PATHS_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    paths: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, artifact_id: _Optional[str] = ..., paths: _Optional[_Iterable[str]] = ...) -> None: ...

class ArtifactDownload(_message.Message):
    __slots__ = ("artifact_id", "path", "digest", "size_bytes", "transfers", "volumes", "holders", "expires_at")
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    DIGEST_FIELD_NUMBER: _ClassVar[int]
    SIZE_BYTES_FIELD_NUMBER: _ClassVar[int]
    TRANSFERS_FIELD_NUMBER: _ClassVar[int]
    VOLUMES_FIELD_NUMBER: _ClassVar[int]
    HOLDERS_FIELD_NUMBER: _ClassVar[int]
    EXPIRES_AT_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    path: str
    digest: str
    size_bytes: int
    transfers: _containers.RepeatedCompositeFieldContainer[ArtifactTransfer]
    volumes: _containers.RepeatedCompositeFieldContainer[ArtifactVolumeLocation]
    holders: ArtifactHolders
    expires_at: _timestamp_pb2.Timestamp
    def __init__(self, artifact_id: _Optional[str] = ..., path: _Optional[str] = ..., digest: _Optional[str] = ..., size_bytes: _Optional[int] = ..., transfers: _Optional[_Iterable[_Union[ArtifactTransfer, _Mapping]]] = ..., volumes: _Optional[_Iterable[_Union[ArtifactVolumeLocation, _Mapping]]] = ..., holders: _Optional[_Union[ArtifactHolders, _Mapping]] = ..., expires_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class ArtifactTransfer(_message.Message):
    __slots__ = ("worker_host_id", "transfer_url", "grant")
    WORKER_HOST_ID_FIELD_NUMBER: _ClassVar[int]
    TRANSFER_URL_FIELD_NUMBER: _ClassVar[int]
    GRANT_FIELD_NUMBER: _ClassVar[int]
    worker_host_id: str
    transfer_url: str
    grant: str
    def __init__(self, worker_host_id: _Optional[str] = ..., transfer_url: _Optional[str] = ..., grant: _Optional[str] = ...) -> None: ...

class ArtifactVolumeLocation(_message.Message):
    __slots__ = ("volume", "source", "credential", "key")
    VOLUME_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    CREDENTIAL_FIELD_NUMBER: _ClassVar[int]
    KEY_FIELD_NUMBER: _ClassVar[int]
    volume: str
    source: str
    credential: str
    key: str
    def __init__(self, volume: _Optional[str] = ..., source: _Optional[str] = ..., credential: _Optional[str] = ..., key: _Optional[str] = ...) -> None: ...

class ArtifactHolders(_message.Message):
    __slots__ = ("worker_host_ids", "volumes")
    WORKER_HOST_IDS_FIELD_NUMBER: _ClassVar[int]
    VOLUMES_FIELD_NUMBER: _ClassVar[int]
    worker_host_ids: _containers.RepeatedScalarFieldContainer[str]
    volumes: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, worker_host_ids: _Optional[_Iterable[str]] = ..., volumes: _Optional[_Iterable[str]] = ...) -> None: ...
