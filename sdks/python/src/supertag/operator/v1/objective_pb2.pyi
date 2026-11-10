import datetime

from google.protobuf import timestamp_pb2 as _timestamp_pb2
from supertag.operator.v1 import options_pb2 as _options_pb2
from supertag.operator.v1 import task_pb2 as _task_pb2
from supertag.operator.v1 import team_pb2 as _team_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ObjectiveStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OBJECTIVE_STATUS_UNSPECIFIED: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_WORKING: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_BLOCKED: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_LIMITED: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_READY_FOR_REVIEW: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_COMPLETED: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_CANCELLED: _ClassVar[ObjectiveStatus]

class ObjectiveAttentionKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OBJECTIVE_ATTENTION_KIND_UNSPECIFIED: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_NOT_STARTED: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_PAUSED: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_CANCELLED: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_BLOCKED: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_REVIEW: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_OWNER_QUESTION: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_BUDGET_THRESHOLD: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_BUDGET_EXHAUSTED: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_BUDGET_COVERAGE_INCOMPLETE: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_DEADLINE_APPROACHING: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_DEADLINE_PASSED: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_APPROVALS_PENDING: _ClassVar[ObjectiveAttentionKind]

class BudgetMeasure(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    BUDGET_MEASURE_UNSPECIFIED: _ClassVar[BudgetMeasure]
    BUDGET_MEASURE_PROVIDER_REPORTED_COST: _ClassVar[BudgetMeasure]
    BUDGET_MEASURE_UNMEASURED: _ClassVar[BudgetMeasure]

class ObjectiveConversationAuthor(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OBJECTIVE_CONVERSATION_AUTHOR_UNSPECIFIED: _ClassVar[ObjectiveConversationAuthor]
    OBJECTIVE_CONVERSATION_AUTHOR_OPERATOR: _ClassVar[ObjectiveConversationAuthor]
    OBJECTIVE_CONVERSATION_AUTHOR_SUPERTAG: _ClassVar[ObjectiveConversationAuthor]
    OBJECTIVE_CONVERSATION_AUTHOR_OWNER: _ClassVar[ObjectiveConversationAuthor]

class ObjectiveSessionStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OBJECTIVE_SESSION_STATUS_UNSPECIFIED: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_QUEUED: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_PENDING: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_RUNNING: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_WAITING: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_COMPLETED: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_FAILED: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_CANCELLED: _ClassVar[ObjectiveSessionStatus]

class TaskExplanationKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TASK_EXPLANATION_KIND_UNSPECIFIED: _ClassVar[TaskExplanationKind]
    TASK_EXPLANATION_KIND_OBJECTIVE_PAUSED: _ClassVar[TaskExplanationKind]
    TASK_EXPLANATION_KIND_CONTROLLER: _ClassVar[TaskExplanationKind]
    TASK_EXPLANATION_KIND_WORKER_REQUIREMENTS: _ClassVar[TaskExplanationKind]
    TASK_EXPLANATION_KIND_ATTEMPT_UNCERTAIN: _ClassVar[TaskExplanationKind]
    TASK_EXPLANATION_KIND_EXECUTION_FAILED: _ClassVar[TaskExplanationKind]
OBJECTIVE_STATUS_UNSPECIFIED: ObjectiveStatus
OBJECTIVE_STATUS_WORKING: ObjectiveStatus
OBJECTIVE_STATUS_BLOCKED: ObjectiveStatus
OBJECTIVE_STATUS_LIMITED: ObjectiveStatus
OBJECTIVE_STATUS_READY_FOR_REVIEW: ObjectiveStatus
OBJECTIVE_STATUS_COMPLETED: ObjectiveStatus
OBJECTIVE_STATUS_CANCELLED: ObjectiveStatus
OBJECTIVE_ATTENTION_KIND_UNSPECIFIED: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_NOT_STARTED: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_PAUSED: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_CANCELLED: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_BLOCKED: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_REVIEW: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_OWNER_QUESTION: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_BUDGET_THRESHOLD: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_BUDGET_EXHAUSTED: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_BUDGET_COVERAGE_INCOMPLETE: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_DEADLINE_APPROACHING: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_DEADLINE_PASSED: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_APPROVALS_PENDING: ObjectiveAttentionKind
BUDGET_MEASURE_UNSPECIFIED: BudgetMeasure
BUDGET_MEASURE_PROVIDER_REPORTED_COST: BudgetMeasure
BUDGET_MEASURE_UNMEASURED: BudgetMeasure
OBJECTIVE_CONVERSATION_AUTHOR_UNSPECIFIED: ObjectiveConversationAuthor
OBJECTIVE_CONVERSATION_AUTHOR_OPERATOR: ObjectiveConversationAuthor
OBJECTIVE_CONVERSATION_AUTHOR_SUPERTAG: ObjectiveConversationAuthor
OBJECTIVE_CONVERSATION_AUTHOR_OWNER: ObjectiveConversationAuthor
OBJECTIVE_SESSION_STATUS_UNSPECIFIED: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_QUEUED: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_PENDING: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_RUNNING: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_WAITING: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_COMPLETED: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_FAILED: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_CANCELLED: ObjectiveSessionStatus
TASK_EXPLANATION_KIND_UNSPECIFIED: TaskExplanationKind
TASK_EXPLANATION_KIND_OBJECTIVE_PAUSED: TaskExplanationKind
TASK_EXPLANATION_KIND_CONTROLLER: TaskExplanationKind
TASK_EXPLANATION_KIND_WORKER_REQUIREMENTS: TaskExplanationKind
TASK_EXPLANATION_KIND_ATTEMPT_UNCERTAIN: TaskExplanationKind
TASK_EXPLANATION_KIND_EXECUTION_FAILED: TaskExplanationKind

class CreateObjectiveRequest(_message.Message):
    __slots__ = ("id", "outcome", "owner", "team", "deadline", "budget", "runtime_actions", "workspaces", "ongoing", "dry_run")
    ID_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    OWNER_FIELD_NUMBER: _ClassVar[int]
    TEAM_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_FIELD_NUMBER: _ClassVar[int]
    BUDGET_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    WORKSPACES_FIELD_NUMBER: _ClassVar[int]
    ONGOING_FIELD_NUMBER: _ClassVar[int]
    DRY_RUN_FIELD_NUMBER: _ClassVar[int]
    id: str
    outcome: str
    owner: str
    team: str
    deadline: _timestamp_pb2.Timestamp
    budget: Budget
    runtime_actions: _containers.RepeatedScalarFieldContainer[str]
    workspaces: _containers.RepeatedScalarFieldContainer[str]
    ongoing: bool
    dry_run: bool
    def __init__(self, id: _Optional[str] = ..., outcome: _Optional[str] = ..., owner: _Optional[str] = ..., team: _Optional[str] = ..., deadline: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., budget: _Optional[_Union[Budget, _Mapping]] = ..., runtime_actions: _Optional[_Iterable[str]] = ..., workspaces: _Optional[_Iterable[str]] = ..., ongoing: _Optional[bool] = ..., dry_run: _Optional[bool] = ...) -> None: ...

class CreateObjectiveResponse(_message.Message):
    __slots__ = ("objective", "warnings", "started_task_id", "not_started")
    OBJECTIVE_FIELD_NUMBER: _ClassVar[int]
    WARNINGS_FIELD_NUMBER: _ClassVar[int]
    STARTED_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    NOT_STARTED_FIELD_NUMBER: _ClassVar[int]
    objective: Objective
    warnings: _containers.RepeatedScalarFieldContainer[str]
    started_task_id: str
    not_started: str
    def __init__(self, objective: _Optional[_Union[Objective, _Mapping]] = ..., warnings: _Optional[_Iterable[str]] = ..., started_task_id: _Optional[str] = ..., not_started: _Optional[str] = ...) -> None: ...

class ListObjectivesRequest(_message.Message):
    __slots__ = ("owner", "page_size", "page_token")
    OWNER_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    owner: str
    page_size: int
    page_token: str
    def __init__(self, owner: _Optional[str] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListObjectivesResponse(_message.Message):
    __slots__ = ("objectives", "next_page_token")
    OBJECTIVES_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    objectives: _containers.RepeatedCompositeFieldContainer[Objective]
    next_page_token: str
    def __init__(self, objectives: _Optional[_Iterable[_Union[Objective, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class GetObjectiveRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class DescribeObjectiveRequest(_message.Message):
    __slots__ = ("id", "page_size", "page_token")
    ID_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    id: str
    page_size: int
    page_token: str
    def __init__(self, id: _Optional[str] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class MessageObjectiveRequest(_message.Message):
    __slots__ = ("id", "text", "idempotency_key")
    ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    IDEMPOTENCY_KEY_FIELD_NUMBER: _ClassVar[int]
    id: str
    text: str
    idempotency_key: str
    def __init__(self, id: _Optional[str] = ..., text: _Optional[str] = ..., idempotency_key: _Optional[str] = ...) -> None: ...

class MessageObjectiveResponse(_message.Message):
    __slots__ = ("task_id", "tag", "duplicate", "status_change")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_FIELD_NUMBER: _ClassVar[int]
    DUPLICATE_FIELD_NUMBER: _ClassVar[int]
    STATUS_CHANGE_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    tag: str
    duplicate: bool
    status_change: ObjectiveStatus
    def __init__(self, task_id: _Optional[str] = ..., tag: _Optional[str] = ..., duplicate: _Optional[bool] = ..., status_change: _Optional[_Union[ObjectiveStatus, str]] = ...) -> None: ...

class UpdateObjectiveRequest(_message.Message):
    __slots__ = ("id", "expected_revision", "status", "completion_summary", "deadline", "budget_limit_minor", "runtime_actions")
    ID_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    COMPLETION_SUMMARY_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_FIELD_NUMBER: _ClassVar[int]
    BUDGET_LIMIT_MINOR_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    id: str
    expected_revision: int
    status: ObjectiveStatus
    completion_summary: str
    deadline: _timestamp_pb2.Timestamp
    budget_limit_minor: int
    runtime_actions: RuntimeActions
    def __init__(self, id: _Optional[str] = ..., expected_revision: _Optional[int] = ..., status: _Optional[_Union[ObjectiveStatus, str]] = ..., completion_summary: _Optional[str] = ..., deadline: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., budget_limit_minor: _Optional[int] = ..., runtime_actions: _Optional[_Union[RuntimeActions, _Mapping]] = ...) -> None: ...

class RuntimeActions(_message.Message):
    __slots__ = ("actions",)
    ACTIONS_FIELD_NUMBER: _ClassVar[int]
    actions: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, actions: _Optional[_Iterable[str]] = ...) -> None: ...

class UpdateObjectiveResponse(_message.Message):
    __slots__ = ("objective", "warnings")
    OBJECTIVE_FIELD_NUMBER: _ClassVar[int]
    WARNINGS_FIELD_NUMBER: _ClassVar[int]
    objective: Objective
    warnings: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, objective: _Optional[_Union[Objective, _Mapping]] = ..., warnings: _Optional[_Iterable[str]] = ...) -> None: ...

class ApproveObjectiveRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class CancelObjectiveRequest(_message.Message):
    __slots__ = ("id", "reason")
    ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    id: str
    reason: str
    def __init__(self, id: _Optional[str] = ..., reason: _Optional[str] = ...) -> None: ...

class CancelObjectiveResponse(_message.Message):
    __slots__ = ("objective", "changed", "cancelled_task_ids")
    OBJECTIVE_FIELD_NUMBER: _ClassVar[int]
    CHANGED_FIELD_NUMBER: _ClassVar[int]
    CANCELLED_TASK_IDS_FIELD_NUMBER: _ClassVar[int]
    objective: Objective
    changed: bool
    cancelled_task_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, objective: _Optional[_Union[Objective, _Mapping]] = ..., changed: _Optional[bool] = ..., cancelled_task_ids: _Optional[_Iterable[str]] = ...) -> None: ...

class PauseObjectiveRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class PauseObjectiveResponse(_message.Message):
    __slots__ = ("objective", "changed")
    OBJECTIVE_FIELD_NUMBER: _ClassVar[int]
    CHANGED_FIELD_NUMBER: _ClassVar[int]
    objective: Objective
    changed: bool
    def __init__(self, objective: _Optional[_Union[Objective, _Mapping]] = ..., changed: _Optional[bool] = ...) -> None: ...

class ResumeObjectiveRequest(_message.Message):
    __slots__ = ("id",)
    ID_FIELD_NUMBER: _ClassVar[int]
    id: str
    def __init__(self, id: _Optional[str] = ...) -> None: ...

class ResumeObjectiveResponse(_message.Message):
    __slots__ = ("objective", "changed", "summary")
    OBJECTIVE_FIELD_NUMBER: _ClassVar[int]
    CHANGED_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    objective: Objective
    changed: bool
    summary: str
    def __init__(self, objective: _Optional[_Union[Objective, _Mapping]] = ..., changed: _Optional[bool] = ..., summary: _Optional[str] = ...) -> None: ...

class Budget(_message.Message):
    __slots__ = ("limit_minor", "currency")
    LIMIT_MINOR_FIELD_NUMBER: _ClassVar[int]
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    limit_minor: int
    currency: str
    def __init__(self, limit_minor: _Optional[int] = ..., currency: _Optional[str] = ...) -> None: ...

class Objective(_message.Message):
    __slots__ = ("id", "outcome", "owner_tag_id", "owner_tag", "status", "revision", "ongoing", "deadline", "budget", "spend", "runtime_actions", "workspaces", "team_id", "completion_summary", "limit_summary", "execution_started_at", "paused_at", "cancelled_at", "cancellation_reason", "surface_task_id", "notification_task_id", "created_at", "updated_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    OWNER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    OWNER_TAG_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    ONGOING_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_FIELD_NUMBER: _ClassVar[int]
    BUDGET_FIELD_NUMBER: _ClassVar[int]
    SPEND_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    WORKSPACES_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    COMPLETION_SUMMARY_FIELD_NUMBER: _ClassVar[int]
    LIMIT_SUMMARY_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    PAUSED_AT_FIELD_NUMBER: _ClassVar[int]
    CANCELLED_AT_FIELD_NUMBER: _ClassVar[int]
    CANCELLATION_REASON_FIELD_NUMBER: _ClassVar[int]
    SURFACE_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    NOTIFICATION_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    outcome: str
    owner_tag_id: str
    owner_tag: str
    status: ObjectiveStatus
    revision: int
    ongoing: bool
    deadline: _timestamp_pb2.Timestamp
    budget: Budget
    spend: ObjectiveSpend
    runtime_actions: _containers.RepeatedScalarFieldContainer[str]
    workspaces: _containers.RepeatedScalarFieldContainer[str]
    team_id: str
    completion_summary: str
    limit_summary: LimitSummary
    execution_started_at: _timestamp_pb2.Timestamp
    paused_at: _timestamp_pb2.Timestamp
    cancelled_at: _timestamp_pb2.Timestamp
    cancellation_reason: str
    surface_task_id: str
    notification_task_id: str
    created_at: _timestamp_pb2.Timestamp
    updated_at: _timestamp_pb2.Timestamp
    def __init__(self, id: _Optional[str] = ..., outcome: _Optional[str] = ..., owner_tag_id: _Optional[str] = ..., owner_tag: _Optional[str] = ..., status: _Optional[_Union[ObjectiveStatus, str]] = ..., revision: _Optional[int] = ..., ongoing: _Optional[bool] = ..., deadline: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., budget: _Optional[_Union[Budget, _Mapping]] = ..., spend: _Optional[_Union[ObjectiveSpend, _Mapping]] = ..., runtime_actions: _Optional[_Iterable[str]] = ..., workspaces: _Optional[_Iterable[str]] = ..., team_id: _Optional[str] = ..., completion_summary: _Optional[str] = ..., limit_summary: _Optional[_Union[LimitSummary, _Mapping]] = ..., execution_started_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., paused_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., cancelled_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., cancellation_reason: _Optional[str] = ..., surface_task_id: _Optional[str] = ..., notification_task_id: _Optional[str] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., updated_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class ObjectiveSpend(_message.Message):
    __slots__ = ("amount_minor", "currency", "unknown_cost_attempts", "estimated_cost_attempts", "observed_at")
    AMOUNT_MINOR_FIELD_NUMBER: _ClassVar[int]
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    UNKNOWN_COST_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    ESTIMATED_COST_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    OBSERVED_AT_FIELD_NUMBER: _ClassVar[int]
    amount_minor: int
    currency: str
    unknown_cost_attempts: int
    estimated_cost_attempts: int
    observed_at: _timestamp_pb2.Timestamp
    def __init__(self, amount_minor: _Optional[int] = ..., currency: _Optional[str] = ..., unknown_cost_attempts: _Optional[int] = ..., estimated_cost_attempts: _Optional[int] = ..., observed_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class LimitSummary(_message.Message):
    __slots__ = ("text", "written_at")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    WRITTEN_AT_FIELD_NUMBER: _ClassVar[int]
    text: str
    written_at: _timestamp_pb2.Timestamp
    def __init__(self, text: _Optional[str] = ..., written_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class ObjectiveOverview(_message.Message):
    __slots__ = ("captured_at", "objective", "execution_readiness", "conditions", "attention", "approvals", "tag_names", "team", "limits", "budget", "conversation", "sessions", "high_findings", "posts", "writes", "tasks", "total_tasks", "next_page_token", "commit_reviews")
    class TagNamesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    CAPTURED_AT_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_READINESS_FIELD_NUMBER: _ClassVar[int]
    CONDITIONS_FIELD_NUMBER: _ClassVar[int]
    ATTENTION_FIELD_NUMBER: _ClassVar[int]
    APPROVALS_FIELD_NUMBER: _ClassVar[int]
    TAG_NAMES_FIELD_NUMBER: _ClassVar[int]
    TEAM_FIELD_NUMBER: _ClassVar[int]
    LIMITS_FIELD_NUMBER: _ClassVar[int]
    BUDGET_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_FIELD_NUMBER: _ClassVar[int]
    SESSIONS_FIELD_NUMBER: _ClassVar[int]
    HIGH_FINDINGS_FIELD_NUMBER: _ClassVar[int]
    POSTS_FIELD_NUMBER: _ClassVar[int]
    WRITES_FIELD_NUMBER: _ClassVar[int]
    TASKS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TASKS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    COMMIT_REVIEWS_FIELD_NUMBER: _ClassVar[int]
    captured_at: _timestamp_pb2.Timestamp
    objective: Objective
    execution_readiness: str
    conditions: _containers.RepeatedCompositeFieldContainer[ObjectiveCondition]
    attention: _containers.RepeatedCompositeFieldContainer[ObjectiveAttention]
    approvals: ApprovalCounts
    tag_names: _containers.ScalarMap[str, str]
    team: ObjectiveTeam
    limits: ObjectiveLimits
    budget: ObjectiveBudgetUse
    conversation: _containers.RepeatedCompositeFieldContainer[ObjectiveConversationEntry]
    sessions: _containers.RepeatedCompositeFieldContainer[ObjectiveSession]
    high_findings: _containers.RepeatedCompositeFieldContainer[HighFinding]
    posts: _containers.RepeatedCompositeFieldContainer[_team_pb2.WorkstreamPost]
    writes: _containers.RepeatedCompositeFieldContainer[VolumeWrites]
    tasks: _containers.RepeatedCompositeFieldContainer[ObjectiveTask]
    total_tasks: int
    next_page_token: str
    commit_reviews: _containers.RepeatedCompositeFieldContainer[ObjectiveCommitReview]
    def __init__(self, captured_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., objective: _Optional[_Union[Objective, _Mapping]] = ..., execution_readiness: _Optional[str] = ..., conditions: _Optional[_Iterable[_Union[ObjectiveCondition, _Mapping]]] = ..., attention: _Optional[_Iterable[_Union[ObjectiveAttention, _Mapping]]] = ..., approvals: _Optional[_Union[ApprovalCounts, _Mapping]] = ..., tag_names: _Optional[_Mapping[str, str]] = ..., team: _Optional[_Union[ObjectiveTeam, _Mapping]] = ..., limits: _Optional[_Union[ObjectiveLimits, _Mapping]] = ..., budget: _Optional[_Union[ObjectiveBudgetUse, _Mapping]] = ..., conversation: _Optional[_Iterable[_Union[ObjectiveConversationEntry, _Mapping]]] = ..., sessions: _Optional[_Iterable[_Union[ObjectiveSession, _Mapping]]] = ..., high_findings: _Optional[_Iterable[_Union[HighFinding, _Mapping]]] = ..., posts: _Optional[_Iterable[_Union[_team_pb2.WorkstreamPost, _Mapping]]] = ..., writes: _Optional[_Iterable[_Union[VolumeWrites, _Mapping]]] = ..., tasks: _Optional[_Iterable[_Union[ObjectiveTask, _Mapping]]] = ..., total_tasks: _Optional[int] = ..., next_page_token: _Optional[str] = ..., commit_reviews: _Optional[_Iterable[_Union[ObjectiveCommitReview, _Mapping]]] = ...) -> None: ...

class ObjectiveCommitReview(_message.Message):
    __slots__ = ("request_id", "commit", "reviewer_tag_id", "verdict", "summary", "recorded_at")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    COMMIT_FIELD_NUMBER: _ClassVar[int]
    REVIEWER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    VERDICT_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    RECORDED_AT_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    commit: str
    reviewer_tag_id: str
    verdict: str
    summary: str
    recorded_at: _timestamp_pb2.Timestamp
    def __init__(self, request_id: _Optional[str] = ..., commit: _Optional[str] = ..., reviewer_tag_id: _Optional[str] = ..., verdict: _Optional[str] = ..., summary: _Optional[str] = ..., recorded_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class ObjectiveCondition(_message.Message):
    __slots__ = ("type", "status", "reasons")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    REASONS_FIELD_NUMBER: _ClassVar[int]
    type: str
    status: bool
    reasons: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, type: _Optional[str] = ..., status: _Optional[bool] = ..., reasons: _Optional[_Iterable[str]] = ...) -> None: ...

class ObjectiveAttention(_message.Message):
    __slots__ = ("kind", "message", "next_action", "observed_at")
    KIND_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    NEXT_ACTION_FIELD_NUMBER: _ClassVar[int]
    OBSERVED_AT_FIELD_NUMBER: _ClassVar[int]
    kind: ObjectiveAttentionKind
    message: str
    next_action: str
    observed_at: _timestamp_pb2.Timestamp
    def __init__(self, kind: _Optional[_Union[ObjectiveAttentionKind, str]] = ..., message: _Optional[str] = ..., next_action: _Optional[str] = ..., observed_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class ApprovalCounts(_message.Message):
    __slots__ = ("pending", "approved_last_day", "denied_last_day")
    PENDING_FIELD_NUMBER: _ClassVar[int]
    APPROVED_LAST_DAY_FIELD_NUMBER: _ClassVar[int]
    DENIED_LAST_DAY_FIELD_NUMBER: _ClassVar[int]
    pending: int
    approved_last_day: int
    denied_last_day: int
    def __init__(self, pending: _Optional[int] = ..., approved_last_day: _Optional[int] = ..., denied_last_day: _Optional[int] = ...) -> None: ...

class ObjectiveTeam(_message.Message):
    __slots__ = ("id", "name", "member_tag_ids", "max_concurrency")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    MEMBER_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    MAX_CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    member_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    max_concurrency: int
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., member_tag_ids: _Optional[_Iterable[str]] = ..., max_concurrency: _Optional[int] = ...) -> None: ...

class ObjectiveLimits(_message.Message):
    __slots__ = ("deadline", "budget")
    DEADLINE_FIELD_NUMBER: _ClassVar[int]
    BUDGET_FIELD_NUMBER: _ClassVar[int]
    deadline: DeadlineLimit
    budget: BudgetLimit
    def __init__(self, deadline: _Optional[_Union[DeadlineLimit, _Mapping]] = ..., budget: _Optional[_Union[BudgetLimit, _Mapping]] = ...) -> None: ...

class DeadlineLimit(_message.Message):
    __slots__ = ("at", "minutes_remaining", "remaining", "passed", "grace_minutes", "notices", "guidance")
    AT_FIELD_NUMBER: _ClassVar[int]
    MINUTES_REMAINING_FIELD_NUMBER: _ClassVar[int]
    REMAINING_FIELD_NUMBER: _ClassVar[int]
    PASSED_FIELD_NUMBER: _ClassVar[int]
    GRACE_MINUTES_FIELD_NUMBER: _ClassVar[int]
    NOTICES_FIELD_NUMBER: _ClassVar[int]
    GUIDANCE_FIELD_NUMBER: _ClassVar[int]
    at: _timestamp_pb2.Timestamp
    minutes_remaining: int
    remaining: str
    passed: bool
    grace_minutes: int
    notices: _containers.RepeatedCompositeFieldContainer[LimitNotice]
    guidance: str
    def __init__(self, at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., minutes_remaining: _Optional[int] = ..., remaining: _Optional[str] = ..., passed: _Optional[bool] = ..., grace_minutes: _Optional[int] = ..., notices: _Optional[_Iterable[_Union[LimitNotice, _Mapping]]] = ..., guidance: _Optional[str] = ...) -> None: ...

class LimitNotice(_message.Message):
    __slots__ = ("kind", "at", "message")
    KIND_FIELD_NUMBER: _ClassVar[int]
    AT_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    kind: str
    at: _timestamp_pb2.Timestamp
    message: str
    def __init__(self, kind: _Optional[str] = ..., at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., message: _Optional[str] = ...) -> None: ...

class BudgetLimit(_message.Message):
    __slots__ = ("measure", "limit", "reported_spent_minor", "overrun_minor", "reported_spend_observed_at", "unknown_cost_attempts", "exhausted", "guidance")
    MEASURE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    REPORTED_SPENT_MINOR_FIELD_NUMBER: _ClassVar[int]
    OVERRUN_MINOR_FIELD_NUMBER: _ClassVar[int]
    REPORTED_SPEND_OBSERVED_AT_FIELD_NUMBER: _ClassVar[int]
    UNKNOWN_COST_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    EXHAUSTED_FIELD_NUMBER: _ClassVar[int]
    GUIDANCE_FIELD_NUMBER: _ClassVar[int]
    measure: BudgetMeasure
    limit: Budget
    reported_spent_minor: int
    overrun_minor: int
    reported_spend_observed_at: _timestamp_pb2.Timestamp
    unknown_cost_attempts: int
    exhausted: bool
    guidance: str
    def __init__(self, measure: _Optional[_Union[BudgetMeasure, str]] = ..., limit: _Optional[_Union[Budget, _Mapping]] = ..., reported_spent_minor: _Optional[int] = ..., overrun_minor: _Optional[int] = ..., reported_spend_observed_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., unknown_cost_attempts: _Optional[int] = ..., exhausted: _Optional[bool] = ..., guidance: _Optional[str] = ...) -> None: ...

class ObjectiveBudgetUse(_message.Message):
    __slots__ = ("currency", "limit_minor", "spent_minor", "available_minor", "attempts", "reported_cost_by_currency", "unknown_cost_attempts", "estimated_cost_attempts", "unpriced_models", "unpriced_tokens", "reported_tokens", "unknown_token_attempts")
    class ReportedCostByCurrencyEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: int
        def __init__(self, key: _Optional[str] = ..., value: _Optional[int] = ...) -> None: ...
    class UnpricedModelsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: int
        def __init__(self, key: _Optional[str] = ..., value: _Optional[int] = ...) -> None: ...
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    LIMIT_MINOR_FIELD_NUMBER: _ClassVar[int]
    SPENT_MINOR_FIELD_NUMBER: _ClassVar[int]
    AVAILABLE_MINOR_FIELD_NUMBER: _ClassVar[int]
    ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    REPORTED_COST_BY_CURRENCY_FIELD_NUMBER: _ClassVar[int]
    UNKNOWN_COST_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    ESTIMATED_COST_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    UNPRICED_MODELS_FIELD_NUMBER: _ClassVar[int]
    UNPRICED_TOKENS_FIELD_NUMBER: _ClassVar[int]
    REPORTED_TOKENS_FIELD_NUMBER: _ClassVar[int]
    UNKNOWN_TOKEN_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    currency: str
    limit_minor: int
    spent_minor: int
    available_minor: int
    attempts: int
    reported_cost_by_currency: _containers.ScalarMap[str, int]
    unknown_cost_attempts: int
    estimated_cost_attempts: int
    unpriced_models: _containers.ScalarMap[str, int]
    unpriced_tokens: int
    reported_tokens: int
    unknown_token_attempts: int
    def __init__(self, currency: _Optional[str] = ..., limit_minor: _Optional[int] = ..., spent_minor: _Optional[int] = ..., available_minor: _Optional[int] = ..., attempts: _Optional[int] = ..., reported_cost_by_currency: _Optional[_Mapping[str, int]] = ..., unknown_cost_attempts: _Optional[int] = ..., estimated_cost_attempts: _Optional[int] = ..., unpriced_models: _Optional[_Mapping[str, int]] = ..., unpriced_tokens: _Optional[int] = ..., reported_tokens: _Optional[int] = ..., unknown_token_attempts: _Optional[int] = ...) -> None: ...

class ObjectiveConversationEntry(_message.Message):
    __slots__ = ("task_id", "author", "operator_id", "text", "created_at")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    AUTHOR_FIELD_NUMBER: _ClassVar[int]
    OPERATOR_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    author: ObjectiveConversationAuthor
    operator_id: str
    text: str
    created_at: _timestamp_pb2.Timestamp
    def __init__(self, task_id: _Optional[str] = ..., author: _Optional[_Union[ObjectiveConversationAuthor, str]] = ..., operator_id: _Optional[str] = ..., text: _Optional[str] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class ObjectiveSession(_message.Message):
    __slots__ = ("id", "tag_id", "tag", "owner", "title", "parent_session_id", "status", "question", "approval_request_ids", "task_count", "created_at", "latest_task")
    ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_FIELD_NUMBER: _ClassVar[int]
    OWNER_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    PARENT_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    QUESTION_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_REQUEST_IDS_FIELD_NUMBER: _ClassVar[int]
    TASK_COUNT_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    LATEST_TASK_FIELD_NUMBER: _ClassVar[int]
    id: str
    tag_id: str
    tag: str
    owner: bool
    title: str
    parent_session_id: str
    status: ObjectiveSessionStatus
    question: str
    approval_request_ids: _containers.RepeatedScalarFieldContainer[str]
    task_count: int
    created_at: _timestamp_pb2.Timestamp
    latest_task: ObjectiveSessionTask
    def __init__(self, id: _Optional[str] = ..., tag_id: _Optional[str] = ..., tag: _Optional[str] = ..., owner: _Optional[bool] = ..., title: _Optional[str] = ..., parent_session_id: _Optional[str] = ..., status: _Optional[_Union[ObjectiveSessionStatus, str]] = ..., question: _Optional[str] = ..., approval_request_ids: _Optional[_Iterable[str]] = ..., task_count: _Optional[int] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., latest_task: _Optional[_Union[ObjectiveSessionTask, _Mapping]] = ...) -> None: ...

class ObjectiveSessionTask(_message.Message):
    __slots__ = ("id", "status", "created_at", "updated_at", "question", "workspace", "delivery", "attempt_status", "report", "explanations")
    ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    QUESTION_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_STATUS_FIELD_NUMBER: _ClassVar[int]
    REPORT_FIELD_NUMBER: _ClassVar[int]
    EXPLANATIONS_FIELD_NUMBER: _ClassVar[int]
    id: str
    status: ObjectiveSessionStatus
    created_at: _timestamp_pb2.Timestamp
    updated_at: _timestamp_pb2.Timestamp
    question: str
    workspace: str
    delivery: _task_pb2.TaskDelivery
    attempt_status: _task_pb2.TaskAttemptStatus
    report: str
    explanations: _containers.RepeatedCompositeFieldContainer[TaskExplanation]
    def __init__(self, id: _Optional[str] = ..., status: _Optional[_Union[ObjectiveSessionStatus, str]] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., updated_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., question: _Optional[str] = ..., workspace: _Optional[str] = ..., delivery: _Optional[_Union[_task_pb2.TaskDelivery, _Mapping]] = ..., attempt_status: _Optional[_Union[_task_pb2.TaskAttemptStatus, str]] = ..., report: _Optional[str] = ..., explanations: _Optional[_Iterable[_Union[TaskExplanation, _Mapping]]] = ...) -> None: ...

class TaskExplanation(_message.Message):
    __slots__ = ("kind", "message", "next_action", "observed_at", "harness", "failure_kind")
    KIND_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    NEXT_ACTION_FIELD_NUMBER: _ClassVar[int]
    OBSERVED_AT_FIELD_NUMBER: _ClassVar[int]
    HARNESS_FIELD_NUMBER: _ClassVar[int]
    FAILURE_KIND_FIELD_NUMBER: _ClassVar[int]
    kind: TaskExplanationKind
    message: str
    next_action: str
    observed_at: _timestamp_pb2.Timestamp
    harness: str
    failure_kind: str
    def __init__(self, kind: _Optional[_Union[TaskExplanationKind, str]] = ..., message: _Optional[str] = ..., next_action: _Optional[str] = ..., observed_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., harness: _Optional[str] = ..., failure_kind: _Optional[str] = ...) -> None: ...

class HighFinding(_message.Message):
    __slots__ = ("task_id", "id", "summary", "location")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    LOCATION_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    id: str
    summary: str
    location: str
    def __init__(self, task_id: _Optional[str] = ..., id: _Optional[str] = ..., summary: _Optional[str] = ..., location: _Optional[str] = ...) -> None: ...

class VolumeWrites(_message.Message):
    __slots__ = ("volume", "files", "bytes", "partial", "refused")
    VOLUME_FIELD_NUMBER: _ClassVar[int]
    FILES_FIELD_NUMBER: _ClassVar[int]
    BYTES_FIELD_NUMBER: _ClassVar[int]
    PARTIAL_FIELD_NUMBER: _ClassVar[int]
    REFUSED_FIELD_NUMBER: _ClassVar[int]
    volume: str
    files: int
    bytes: int
    partial: int
    refused: int
    def __init__(self, volume: _Optional[str] = ..., files: _Optional[int] = ..., bytes: _Optional[int] = ..., partial: _Optional[int] = ..., refused: _Optional[int] = ...) -> None: ...

class ObjectiveTask(_message.Message):
    __slots__ = ("id", "session_id", "tag_id", "status", "request", "response", "created_at", "started_at", "ended_at", "attempts")
    ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    REQUEST_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    ENDED_AT_FIELD_NUMBER: _ClassVar[int]
    ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    id: str
    session_id: str
    tag_id: str
    status: _task_pb2.TaskStatus
    request: str
    response: str
    created_at: _timestamp_pb2.Timestamp
    started_at: _timestamp_pb2.Timestamp
    ended_at: _timestamp_pb2.Timestamp
    attempts: _containers.RepeatedCompositeFieldContainer[ObjectiveTaskAttempt]
    def __init__(self, id: _Optional[str] = ..., session_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., status: _Optional[_Union[_task_pb2.TaskStatus, str]] = ..., request: _Optional[str] = ..., response: _Optional[str] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., started_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., ended_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., attempts: _Optional[_Iterable[_Union[ObjectiveTaskAttempt, _Mapping]]] = ...) -> None: ...

class ObjectiveTaskAttempt(_message.Message):
    __slots__ = ("id", "number", "status", "started_at", "ended_at", "worker_profile")
    ID_FIELD_NUMBER: _ClassVar[int]
    NUMBER_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    ENDED_AT_FIELD_NUMBER: _ClassVar[int]
    WORKER_PROFILE_FIELD_NUMBER: _ClassVar[int]
    id: str
    number: int
    status: _task_pb2.TaskAttemptStatus
    started_at: _timestamp_pb2.Timestamp
    ended_at: _timestamp_pb2.Timestamp
    worker_profile: str
    def __init__(self, id: _Optional[str] = ..., number: _Optional[int] = ..., status: _Optional[_Union[_task_pb2.TaskAttemptStatus, str]] = ..., started_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., ended_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., worker_profile: _Optional[str] = ...) -> None: ...
