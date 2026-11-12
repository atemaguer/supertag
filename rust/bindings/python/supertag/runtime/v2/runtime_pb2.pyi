from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class TaskState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TASK_STATE_UNSPECIFIED: _ClassVar[TaskState]
    TASK_STATE_QUEUED: _ClassVar[TaskState]
    TASK_STATE_RUNNING: _ClassVar[TaskState]
    TASK_STATE_SUCCEEDED: _ClassVar[TaskState]
    TASK_STATE_FAILED: _ClassVar[TaskState]
    TASK_STATE_CANCELLED: _ClassVar[TaskState]
    TASK_STATE_CLAIMED: _ClassVar[TaskState]
    TASK_STATE_UNCERTAIN: _ClassVar[TaskState]

class AttemptDecision(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ATTEMPT_DECISION_UNSPECIFIED: _ClassVar[AttemptDecision]
    ATTEMPT_DECISION_FAILED: _ClassVar[AttemptDecision]
    ATTEMPT_DECISION_RETRY: _ClassVar[AttemptDecision]

class ObjectiveStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OBJECTIVE_STATUS_UNSPECIFIED: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_WORKING: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_BLOCKED: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_LIMITED: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_READY_FOR_REVIEW: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_COMPLETED: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_CANCELLED: _ClassVar[ObjectiveStatus]

class ObjectiveSignal(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OBJECTIVE_SIGNAL_PROGRESS: _ClassVar[ObjectiveSignal]
    OBJECTIVE_SIGNAL_READY_FOR_REVIEW: _ClassVar[ObjectiveSignal]
    OBJECTIVE_SIGNAL_COMPLETED: _ClassVar[ObjectiveSignal]
    OBJECTIVE_SIGNAL_BLOCKED: _ClassVar[ObjectiveSignal]

class ReplyState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    REPLY_STATE_UNSPECIFIED: _ClassVar[ReplyState]
    REPLY_STATE_PENDING: _ClassVar[ReplyState]
    REPLY_STATE_CLAIMED: _ClassVar[ReplyState]
    REPLY_STATE_DELIVERED: _ClassVar[ReplyState]
    REPLY_STATE_FAILED: _ClassVar[ReplyState]
    REPLY_STATE_UNCERTAIN: _ClassVar[ReplyState]
TASK_STATE_UNSPECIFIED: TaskState
TASK_STATE_QUEUED: TaskState
TASK_STATE_RUNNING: TaskState
TASK_STATE_SUCCEEDED: TaskState
TASK_STATE_FAILED: TaskState
TASK_STATE_CANCELLED: TaskState
TASK_STATE_CLAIMED: TaskState
TASK_STATE_UNCERTAIN: TaskState
ATTEMPT_DECISION_UNSPECIFIED: AttemptDecision
ATTEMPT_DECISION_FAILED: AttemptDecision
ATTEMPT_DECISION_RETRY: AttemptDecision
OBJECTIVE_STATUS_UNSPECIFIED: ObjectiveStatus
OBJECTIVE_STATUS_WORKING: ObjectiveStatus
OBJECTIVE_STATUS_BLOCKED: ObjectiveStatus
OBJECTIVE_STATUS_LIMITED: ObjectiveStatus
OBJECTIVE_STATUS_READY_FOR_REVIEW: ObjectiveStatus
OBJECTIVE_STATUS_COMPLETED: ObjectiveStatus
OBJECTIVE_STATUS_CANCELLED: ObjectiveStatus
OBJECTIVE_SIGNAL_PROGRESS: ObjectiveSignal
OBJECTIVE_SIGNAL_READY_FOR_REVIEW: ObjectiveSignal
OBJECTIVE_SIGNAL_COMPLETED: ObjectiveSignal
OBJECTIVE_SIGNAL_BLOCKED: ObjectiveSignal
REPLY_STATE_UNSPECIFIED: ReplyState
REPLY_STATE_PENDING: ReplyState
REPLY_STATE_CLAIMED: ReplyState
REPLY_STATE_DELIVERED: ReplyState
REPLY_STATE_FAILED: ReplyState
REPLY_STATE_UNCERTAIN: ReplyState

class CreateAuthKeyRequest(_message.Message):
    __slots__ = ("host_id", "operation_id", "key_digest", "expires_in_ms", "allowed_tag_ids", "all_tags")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    KEY_DIGEST_FIELD_NUMBER: _ClassVar[int]
    EXPIRES_IN_MS_FIELD_NUMBER: _ClassVar[int]
    ALLOWED_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    ALL_TAGS_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    operation_id: str
    key_digest: bytes
    expires_in_ms: int
    allowed_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    all_tags: bool
    def __init__(self, host_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., key_digest: _Optional[bytes] = ..., expires_in_ms: _Optional[int] = ..., allowed_tag_ids: _Optional[_Iterable[str]] = ..., all_tags: _Optional[bool] = ...) -> None: ...

class AuthKey(_message.Message):
    __slots__ = ("host_id", "expires_at_ms", "allowed_tag_ids", "all_tags")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    EXPIRES_AT_MS_FIELD_NUMBER: _ClassVar[int]
    ALLOWED_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    ALL_TAGS_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    expires_at_ms: int
    allowed_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    all_tags: bool
    def __init__(self, host_id: _Optional[str] = ..., expires_at_ms: _Optional[int] = ..., allowed_tag_ids: _Optional[_Iterable[str]] = ..., all_tags: _Optional[bool] = ...) -> None: ...

class RevokeHostRequest(_message.Message):
    __slots__ = ("host_id",)
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    def __init__(self, host_id: _Optional[str] = ...) -> None: ...

class RegisterHostRequest(_message.Message):
    __slots__ = ("incarnation_id",)
    INCARNATION_ID_FIELD_NUMBER: _ClassVar[int]
    incarnation_id: str
    def __init__(self, incarnation_id: _Optional[str] = ...) -> None: ...

class HostRecord(_message.Message):
    __slots__ = ("host_id", "generation", "revoked")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    REVOKED_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    generation: int
    revoked: bool
    def __init__(self, host_id: _Optional[str] = ..., generation: _Optional[int] = ..., revoked: _Optional[bool] = ...) -> None: ...

class EnrollHostRequest(_message.Message):
    __slots__ = ("host_id", "operation_id", "token_digest")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TOKEN_DIGEST_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    operation_id: str
    token_digest: bytes
    def __init__(self, host_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., token_digest: _Optional[bytes] = ...) -> None: ...

class PrivateEnrollHostRequest(_message.Message):
    __slots__ = ("enrollment", "key_digest")
    ENROLLMENT_FIELD_NUMBER: _ClassVar[int]
    KEY_DIGEST_FIELD_NUMBER: _ClassVar[int]
    enrollment: EnrollHostRequest
    key_digest: bytes
    def __init__(self, enrollment: _Optional[_Union[EnrollHostRequest, _Mapping]] = ..., key_digest: _Optional[bytes] = ...) -> None: ...

class AuthenticateHostRequest(_message.Message):
    __slots__ = ("token_digest",)
    TOKEN_DIGEST_FIELD_NUMBER: _ClassVar[int]
    token_digest: bytes
    def __init__(self, token_digest: _Optional[bytes] = ...) -> None: ...

class PutTagRequest(_message.Message):
    __slots__ = ("tag_id", "instructions", "allowed_actions")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTIONS_FIELD_NUMBER: _ClassVar[int]
    ALLOWED_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    instructions: str
    allowed_actions: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, tag_id: _Optional[str] = ..., instructions: _Optional[str] = ..., allowed_actions: _Optional[_Iterable[str]] = ...) -> None: ...

class Tag(_message.Message):
    __slots__ = ("tag_id", "instructions", "allowed_actions", "revision")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTIONS_FIELD_NUMBER: _ClassVar[int]
    ALLOWED_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    instructions: str
    allowed_actions: _containers.RepeatedScalarFieldContainer[str]
    revision: int
    def __init__(self, tag_id: _Optional[str] = ..., instructions: _Optional[str] = ..., allowed_actions: _Optional[_Iterable[str]] = ..., revision: _Optional[int] = ...) -> None: ...

class SubmitTaskRequest(_message.Message):
    __slots__ = ("tag_id", "session_id", "operation_id", "prompt")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    session_id: str
    operation_id: str
    prompt: str
    def __init__(self, tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., prompt: _Optional[str] = ...) -> None: ...

class Task(_message.Message):
    __slots__ = ("task_id", "tag_id", "session_id", "prompt", "instructions", "allowed_actions", "tag_revision", "state", "result", "attempt_id")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTIONS_FIELD_NUMBER: _ClassVar[int]
    ALLOWED_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    TAG_REVISION_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    tag_id: str
    session_id: str
    prompt: str
    instructions: str
    allowed_actions: _containers.RepeatedScalarFieldContainer[str]
    tag_revision: int
    state: TaskState
    result: str
    attempt_id: str
    def __init__(self, task_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., prompt: _Optional[str] = ..., instructions: _Optional[str] = ..., allowed_actions: _Optional[_Iterable[str]] = ..., tag_revision: _Optional[int] = ..., state: _Optional[_Union[TaskState, str]] = ..., result: _Optional[str] = ..., attempt_id: _Optional[str] = ...) -> None: ...

class GetTaskRequest(_message.Message):
    __slots__ = ("task_id",)
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    def __init__(self, task_id: _Optional[str] = ...) -> None: ...

class ListEventsRequest(_message.Message):
    __slots__ = ("task_id", "after_sequence", "limit")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    AFTER_SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    after_sequence: int
    limit: int
    def __init__(self, task_id: _Optional[str] = ..., after_sequence: _Optional[int] = ..., limit: _Optional[int] = ...) -> None: ...

class ListEventsResponse(_message.Message):
    __slots__ = ("events",)
    EVENTS_FIELD_NUMBER: _ClassVar[int]
    events: _containers.RepeatedCompositeFieldContainer[TaskEvent]
    def __init__(self, events: _Optional[_Iterable[_Union[TaskEvent, _Mapping]]] = ...) -> None: ...

class CancelTaskRequest(_message.Message):
    __slots__ = ("task_id",)
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    def __init__(self, task_id: _Optional[str] = ...) -> None: ...

class ClaimTaskRequest(_message.Message):
    __slots__ = ("operation_id",)
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    def __init__(self, operation_id: _Optional[str] = ...) -> None: ...

class ClaimTaskResponse(_message.Message):
    __slots__ = ("assignment",)
    ASSIGNMENT_FIELD_NUMBER: _ClassVar[int]
    assignment: Assignment
    def __init__(self, assignment: _Optional[_Union[Assignment, _Mapping]] = ...) -> None: ...

class Assignment(_message.Message):
    __slots__ = ("task", "attempt_id", "lease_token")
    TASK_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    task: Task
    attempt_id: str
    lease_token: str
    def __init__(self, task: _Optional[_Union[Task, _Mapping]] = ..., attempt_id: _Optional[str] = ..., lease_token: _Optional[str] = ...) -> None: ...

class StartTaskRequest(_message.Message):
    __slots__ = ("task_id", "attempt_id", "lease_token")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    lease_token: str
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., lease_token: _Optional[str] = ...) -> None: ...

class InspectAttemptRequest(_message.Message):
    __slots__ = ("task_id", "attempt_id", "lease_token")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    lease_token: str
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., lease_token: _Optional[str] = ...) -> None: ...

class AttemptAuthority(_message.Message):
    __slots__ = ("task", "valid_for_ms")
    TASK_FIELD_NUMBER: _ClassVar[int]
    VALID_FOR_MS_FIELD_NUMBER: _ClassVar[int]
    task: Task
    valid_for_ms: int
    def __init__(self, task: _Optional[_Union[Task, _Mapping]] = ..., valid_for_ms: _Optional[int] = ...) -> None: ...

class ResolveAttemptRequest(_message.Message):
    __slots__ = ("task_id", "attempt_id", "operation_id", "decision", "evidence", "confirmed_stopped")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    DECISION_FIELD_NUMBER: _ClassVar[int]
    EVIDENCE_FIELD_NUMBER: _ClassVar[int]
    CONFIRMED_STOPPED_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    operation_id: str
    decision: AttemptDecision
    evidence: str
    confirmed_stopped: bool
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., decision: _Optional[_Union[AttemptDecision, str]] = ..., evidence: _Optional[str] = ..., confirmed_stopped: _Optional[bool] = ...) -> None: ...

class AttemptResolution(_message.Message):
    __slots__ = ("task_id", "attempt_id", "decision", "operator_id", "evidence", "resolved_at_ms")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    DECISION_FIELD_NUMBER: _ClassVar[int]
    OPERATOR_ID_FIELD_NUMBER: _ClassVar[int]
    EVIDENCE_FIELD_NUMBER: _ClassVar[int]
    RESOLVED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    decision: AttemptDecision
    operator_id: str
    evidence: str
    resolved_at_ms: int
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., decision: _Optional[_Union[AttemptDecision, str]] = ..., operator_id: _Optional[str] = ..., evidence: _Optional[str] = ..., resolved_at_ms: _Optional[int] = ...) -> None: ...

class GetAttemptResolutionResponse(_message.Message):
    __slots__ = ("resolution",)
    RESOLUTION_FIELD_NUMBER: _ClassVar[int]
    resolution: AttemptResolution
    def __init__(self, resolution: _Optional[_Union[AttemptResolution, _Mapping]] = ...) -> None: ...

class ReportAttemptUsageRequest(_message.Message):
    __slots__ = ("attempt", "sequence", "amount_minor", "currency", "estimated", "native_usage")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    AMOUNT_MINOR_FIELD_NUMBER: _ClassVar[int]
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    ESTIMATED_FIELD_NUMBER: _ClassVar[int]
    NATIVE_USAGE_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    sequence: int
    amount_minor: int
    currency: str
    estimated: bool
    native_usage: NativeTokenUsage
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., sequence: _Optional[int] = ..., amount_minor: _Optional[int] = ..., currency: _Optional[str] = ..., estimated: _Optional[bool] = ..., native_usage: _Optional[_Union[NativeTokenUsage, _Mapping]] = ...) -> None: ...

class ReportAttemptUsageResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class NativeTokenUsage(_message.Message):
    __slots__ = ("input_tokens", "cached_input_tokens", "output_tokens", "observed_model")
    INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    CACHED_INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    OBSERVED_MODEL_FIELD_NUMBER: _ClassVar[int]
    input_tokens: int
    cached_input_tokens: int
    output_tokens: int
    observed_model: str
    def __init__(self, input_tokens: _Optional[int] = ..., cached_input_tokens: _Optional[int] = ..., output_tokens: _Optional[int] = ..., observed_model: _Optional[str] = ...) -> None: ...

class ListNativeUsageRequest(_message.Message):
    __slots__ = ("task_id", "attempt_id", "after_sequence", "limit")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    AFTER_SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    after_sequence: int
    limit: int
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., after_sequence: _Optional[int] = ..., limit: _Optional[int] = ...) -> None: ...

class ListNativeUsageResponse(_message.Message):
    __slots__ = ("reports",)
    REPORTS_FIELD_NUMBER: _ClassVar[int]
    reports: _containers.RepeatedCompositeFieldContainer[HarnessUsageRequest]
    def __init__(self, reports: _Optional[_Iterable[_Union[HarnessUsageRequest, _Mapping]]] = ...) -> None: ...

class HarnessUsageRequest(_message.Message):
    __slots__ = ("sequence", "native_usage")
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    NATIVE_USAGE_FIELD_NUMBER: _ClassVar[int]
    sequence: int
    native_usage: NativeTokenUsage
    def __init__(self, sequence: _Optional[int] = ..., native_usage: _Optional[_Union[NativeTokenUsage, _Mapping]] = ...) -> None: ...

class AppendEventRequest(_message.Message):
    __slots__ = ("task_id", "attempt_id", "lease_token", "sequence", "text")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    lease_token: str
    sequence: int
    text: str
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., lease_token: _Optional[str] = ..., sequence: _Optional[int] = ..., text: _Optional[str] = ...) -> None: ...

class TaskEvent(_message.Message):
    __slots__ = ("sequence", "text")
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    sequence: int
    text: str
    def __init__(self, sequence: _Optional[int] = ..., text: _Optional[str] = ...) -> None: ...

class FinishTaskRequest(_message.Message):
    __slots__ = ("task_id", "attempt_id", "lease_token", "result", "succeeded", "objective_signal", "checkpoint_sha256")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    SUCCEEDED_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_SIGNAL_FIELD_NUMBER: _ClassVar[int]
    CHECKPOINT_SHA256_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    lease_token: str
    result: str
    succeeded: bool
    objective_signal: ObjectiveSignal
    checkpoint_sha256: str
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., lease_token: _Optional[str] = ..., result: _Optional[str] = ..., succeeded: _Optional[bool] = ..., objective_signal: _Optional[_Union[ObjectiveSignal, str]] = ..., checkpoint_sha256: _Optional[str] = ...) -> None: ...

class HarnessAttachRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class AdapterBootstrap(_message.Message):
    __slots__ = ("endpoint", "token")
    ENDPOINT_FIELD_NUMBER: _ClassVar[int]
    TOKEN_FIELD_NUMBER: _ClassVar[int]
    endpoint: str
    token: str
    def __init__(self, endpoint: _Optional[str] = ..., token: _Optional[str] = ...) -> None: ...

class HarnessRun(_message.Message):
    __slots__ = ("task", "attempt_id", "checkpoint")
    TASK_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    CHECKPOINT_FIELD_NUMBER: _ClassVar[int]
    task: Task
    attempt_id: str
    checkpoint: SessionCheckpoint
    def __init__(self, task: _Optional[_Union[Task, _Mapping]] = ..., attempt_id: _Optional[str] = ..., checkpoint: _Optional[_Union[SessionCheckpoint, _Mapping]] = ...) -> None: ...

class SessionCheckpoint(_message.Message):
    __slots__ = ("harness", "format", "payload", "sha256")
    HARNESS_FIELD_NUMBER: _ClassVar[int]
    FORMAT_FIELD_NUMBER: _ClassVar[int]
    PAYLOAD_FIELD_NUMBER: _ClassVar[int]
    SHA256_FIELD_NUMBER: _ClassVar[int]
    harness: str
    format: str
    payload: bytes
    sha256: str
    def __init__(self, harness: _Optional[str] = ..., format: _Optional[str] = ..., payload: _Optional[bytes] = ..., sha256: _Optional[str] = ...) -> None: ...

class CheckpointReference(_message.Message):
    __slots__ = ("harness", "format", "byte_length", "sha256")
    HARNESS_FIELD_NUMBER: _ClassVar[int]
    FORMAT_FIELD_NUMBER: _ClassVar[int]
    BYTE_LENGTH_FIELD_NUMBER: _ClassVar[int]
    SHA256_FIELD_NUMBER: _ClassVar[int]
    harness: str
    format: str
    byte_length: int
    sha256: str
    def __init__(self, harness: _Optional[str] = ..., format: _Optional[str] = ..., byte_length: _Optional[int] = ..., sha256: _Optional[str] = ...) -> None: ...

class GetCheckpointResponse(_message.Message):
    __slots__ = ("reference",)
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    reference: CheckpointReference
    def __init__(self, reference: _Optional[_Union[CheckpointReference, _Mapping]] = ...) -> None: ...

class CommitCheckpointRequest(_message.Message):
    __slots__ = ("attempt", "reference")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    reference: CheckpointReference
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., reference: _Optional[_Union[CheckpointReference, _Mapping]] = ...) -> None: ...

class CheckpointUpload(_message.Message):
    __slots__ = ("begin", "chunk")
    BEGIN_FIELD_NUMBER: _ClassVar[int]
    CHUNK_FIELD_NUMBER: _ClassVar[int]
    begin: CommitCheckpointRequest
    chunk: bytes
    def __init__(self, begin: _Optional[_Union[CommitCheckpointRequest, _Mapping]] = ..., chunk: _Optional[bytes] = ...) -> None: ...

class CheckpointDownload(_message.Message):
    __slots__ = ("reference", "chunk")
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    CHUNK_FIELD_NUMBER: _ClassVar[int]
    reference: CheckpointReference
    chunk: bytes
    def __init__(self, reference: _Optional[_Union[CheckpointReference, _Mapping]] = ..., chunk: _Optional[bytes] = ...) -> None: ...

class HarnessPublishRequest(_message.Message):
    __slots__ = ("sequence", "text")
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    sequence: int
    text: str
    def __init__(self, sequence: _Optional[int] = ..., text: _Optional[str] = ...) -> None: ...

class HarnessCompleteRequest(_message.Message):
    __slots__ = ("result", "succeeded", "objective_signal", "checkpoint")
    RESULT_FIELD_NUMBER: _ClassVar[int]
    SUCCEEDED_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_SIGNAL_FIELD_NUMBER: _ClassVar[int]
    CHECKPOINT_FIELD_NUMBER: _ClassVar[int]
    result: str
    succeeded: bool
    objective_signal: ObjectiveSignal
    checkpoint: SessionCheckpoint
    def __init__(self, result: _Optional[str] = ..., succeeded: _Optional[bool] = ..., objective_signal: _Optional[_Union[ObjectiveSignal, str]] = ..., checkpoint: _Optional[_Union[SessionCheckpoint, _Mapping]] = ...) -> None: ...

class HarnessCompleteResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class CreateObjectiveRequest(_message.Message):
    __slots__ = ("operation_id", "objective_id", "owner_tag_id", "outcome", "ongoing", "deadline_ms", "budget_limit_minor", "budget_currency")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    OWNER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    ONGOING_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_MS_FIELD_NUMBER: _ClassVar[int]
    BUDGET_LIMIT_MINOR_FIELD_NUMBER: _ClassVar[int]
    BUDGET_CURRENCY_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    objective_id: str
    owner_tag_id: str
    outcome: str
    ongoing: bool
    deadline_ms: int
    budget_limit_minor: int
    budget_currency: str
    def __init__(self, operation_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., owner_tag_id: _Optional[str] = ..., outcome: _Optional[str] = ..., ongoing: _Optional[bool] = ..., deadline_ms: _Optional[int] = ..., budget_limit_minor: _Optional[int] = ..., budget_currency: _Optional[str] = ...) -> None: ...

class Objective(_message.Message):
    __slots__ = ("objective_id", "owner_tag_id", "session_id", "outcome", "ongoing", "starting_task_id", "status", "revision", "deadline_ms", "budget_limit_minor", "budget_currency", "paused_at_ms", "reported_spend_minor")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    OWNER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    ONGOING_FIELD_NUMBER: _ClassVar[int]
    STARTING_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_MS_FIELD_NUMBER: _ClassVar[int]
    BUDGET_LIMIT_MINOR_FIELD_NUMBER: _ClassVar[int]
    BUDGET_CURRENCY_FIELD_NUMBER: _ClassVar[int]
    PAUSED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    REPORTED_SPEND_MINOR_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    owner_tag_id: str
    session_id: str
    outcome: str
    ongoing: bool
    starting_task_id: str
    status: ObjectiveStatus
    revision: int
    deadline_ms: int
    budget_limit_minor: int
    budget_currency: str
    paused_at_ms: int
    reported_spend_minor: int
    def __init__(self, objective_id: _Optional[str] = ..., owner_tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., outcome: _Optional[str] = ..., ongoing: _Optional[bool] = ..., starting_task_id: _Optional[str] = ..., status: _Optional[_Union[ObjectiveStatus, str]] = ..., revision: _Optional[int] = ..., deadline_ms: _Optional[int] = ..., budget_limit_minor: _Optional[int] = ..., budget_currency: _Optional[str] = ..., paused_at_ms: _Optional[int] = ..., reported_spend_minor: _Optional[int] = ...) -> None: ...

class GetObjectiveRequest(_message.Message):
    __slots__ = ("objective_id",)
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    def __init__(self, objective_id: _Optional[str] = ...) -> None: ...

class ListObjectivesRequest(_message.Message):
    __slots__ = ("limit", "after_id")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    AFTER_ID_FIELD_NUMBER: _ClassVar[int]
    limit: int
    after_id: str
    def __init__(self, limit: _Optional[int] = ..., after_id: _Optional[str] = ...) -> None: ...

class ListObjectivesResponse(_message.Message):
    __slots__ = ("objectives",)
    OBJECTIVES_FIELD_NUMBER: _ClassVar[int]
    objectives: _containers.RepeatedCompositeFieldContainer[Objective]
    def __init__(self, objectives: _Optional[_Iterable[_Union[Objective, _Mapping]]] = ...) -> None: ...

class SetObjectiveLimitsRequest(_message.Message):
    __slots__ = ("objective_id", "operation_id", "deadline_ms", "clear_deadline", "budget_limit_minor", "budget_currency", "clear_budget", "expected_revision")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_MS_FIELD_NUMBER: _ClassVar[int]
    CLEAR_DEADLINE_FIELD_NUMBER: _ClassVar[int]
    BUDGET_LIMIT_MINOR_FIELD_NUMBER: _ClassVar[int]
    BUDGET_CURRENCY_FIELD_NUMBER: _ClassVar[int]
    CLEAR_BUDGET_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    operation_id: str
    deadline_ms: int
    clear_deadline: bool
    budget_limit_minor: int
    budget_currency: str
    clear_budget: bool
    expected_revision: int
    def __init__(self, objective_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., deadline_ms: _Optional[int] = ..., clear_deadline: _Optional[bool] = ..., budget_limit_minor: _Optional[int] = ..., budget_currency: _Optional[str] = ..., clear_budget: _Optional[bool] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class ObjectiveActionRequest(_message.Message):
    __slots__ = ("objective_id", "operation_id", "reason")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    operation_id: str
    reason: str
    def __init__(self, objective_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., reason: _Optional[str] = ...) -> None: ...

class ReviewObjectiveRequest(_message.Message):
    __slots__ = ("objective_id", "operation_id", "approved", "feedback")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    APPROVED_FIELD_NUMBER: _ClassVar[int]
    FEEDBACK_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    operation_id: str
    approved: bool
    feedback: str
    def __init__(self, objective_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., approved: _Optional[bool] = ..., feedback: _Optional[str] = ...) -> None: ...

class ReplyDestination(_message.Message):
    __slots__ = ("conversation_id", "thread_id")
    CONVERSATION_ID_FIELD_NUMBER: _ClassVar[int]
    THREAD_ID_FIELD_NUMBER: _ClassVar[int]
    conversation_id: str
    thread_id: str
    def __init__(self, conversation_id: _Optional[str] = ..., thread_id: _Optional[str] = ...) -> None: ...

class AcceptEventRequest(_message.Message):
    __slots__ = ("account_id", "event_id", "tag_id", "session_id", "prompt", "destination")
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    EVENT_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    DESTINATION_FIELD_NUMBER: _ClassVar[int]
    account_id: str
    event_id: str
    tag_id: str
    session_id: str
    prompt: str
    destination: ReplyDestination
    def __init__(self, account_id: _Optional[str] = ..., event_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., prompt: _Optional[str] = ..., destination: _Optional[_Union[ReplyDestination, _Mapping]] = ...) -> None: ...

class Reply(_message.Message):
    __slots__ = ("reply_id", "task_id", "account_id", "destination", "text", "state", "provider_receipt")
    REPLY_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    DESTINATION_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_RECEIPT_FIELD_NUMBER: _ClassVar[int]
    reply_id: str
    task_id: str
    account_id: str
    destination: ReplyDestination
    text: str
    state: ReplyState
    provider_receipt: str
    def __init__(self, reply_id: _Optional[str] = ..., task_id: _Optional[str] = ..., account_id: _Optional[str] = ..., destination: _Optional[_Union[ReplyDestination, _Mapping]] = ..., text: _Optional[str] = ..., state: _Optional[_Union[ReplyState, str]] = ..., provider_receipt: _Optional[str] = ...) -> None: ...

class ClaimReplyRequest(_message.Message):
    __slots__ = ("operation_id",)
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    def __init__(self, operation_id: _Optional[str] = ...) -> None: ...

class ClaimReplyResponse(_message.Message):
    __slots__ = ("reply", "lease_token")
    REPLY_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    reply: Reply
    lease_token: str
    def __init__(self, reply: _Optional[_Union[Reply, _Mapping]] = ..., lease_token: _Optional[str] = ...) -> None: ...

class SettleReplyRequest(_message.Message):
    __slots__ = ("reply_id", "lease_token", "state", "provider_receipt")
    REPLY_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_RECEIPT_FIELD_NUMBER: _ClassVar[int]
    reply_id: str
    lease_token: str
    state: ReplyState
    provider_receipt: str
    def __init__(self, reply_id: _Optional[str] = ..., lease_token: _Optional[str] = ..., state: _Optional[_Union[ReplyState, str]] = ..., provider_receipt: _Optional[str] = ...) -> None: ...
