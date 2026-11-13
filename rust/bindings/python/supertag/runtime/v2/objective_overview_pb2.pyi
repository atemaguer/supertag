from supertag.runtime.v2 import runtime_pb2 as _runtime_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ObjectiveBudgetMeasure(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OBJECTIVE_BUDGET_MEASURE_UNSPECIFIED: _ClassVar[ObjectiveBudgetMeasure]
    OBJECTIVE_BUDGET_MEASURE_UNLIMITED: _ClassVar[ObjectiveBudgetMeasure]
    OBJECTIVE_BUDGET_MEASURE_UNMEASURED: _ClassVar[ObjectiveBudgetMeasure]
    OBJECTIVE_BUDGET_MEASURE_PROVIDER_REPORTED_COST: _ClassVar[ObjectiveBudgetMeasure]

class ObjectiveAttentionKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OBJECTIVE_ATTENTION_KIND_UNSPECIFIED: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_QUESTION: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_REVIEW: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_LIMITED: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_PAUSED: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_BLOCKED: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_APPROVALS: _ClassVar[ObjectiveAttentionKind]
    OBJECTIVE_ATTENTION_KIND_CANCELLED: _ClassVar[ObjectiveAttentionKind]

class ObjectiveSessionStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OBJECTIVE_SESSION_STATUS_UNSPECIFIED: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_NOT_STARTED: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_QUEUED: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_RUNNING: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_WAITING: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_SUCCEEDED: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_FAILED: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_CANCELLED: _ClassVar[ObjectiveSessionStatus]
    OBJECTIVE_SESSION_STATUS_UNCERTAIN: _ClassVar[ObjectiveSessionStatus]
OBJECTIVE_BUDGET_MEASURE_UNSPECIFIED: ObjectiveBudgetMeasure
OBJECTIVE_BUDGET_MEASURE_UNLIMITED: ObjectiveBudgetMeasure
OBJECTIVE_BUDGET_MEASURE_UNMEASURED: ObjectiveBudgetMeasure
OBJECTIVE_BUDGET_MEASURE_PROVIDER_REPORTED_COST: ObjectiveBudgetMeasure
OBJECTIVE_ATTENTION_KIND_UNSPECIFIED: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_QUESTION: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_REVIEW: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_LIMITED: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_PAUSED: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_BLOCKED: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_APPROVALS: ObjectiveAttentionKind
OBJECTIVE_ATTENTION_KIND_CANCELLED: ObjectiveAttentionKind
OBJECTIVE_SESSION_STATUS_UNSPECIFIED: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_NOT_STARTED: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_QUEUED: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_RUNNING: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_WAITING: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_SUCCEEDED: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_FAILED: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_CANCELLED: ObjectiveSessionStatus
OBJECTIVE_SESSION_STATUS_UNCERTAIN: ObjectiveSessionStatus

class GetObjectiveOverviewRequest(_message.Message):
    __slots__ = ("objective_id", "limit", "offset")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    limit: int
    offset: int
    def __init__(self, objective_id: _Optional[str] = ..., limit: _Optional[int] = ..., offset: _Optional[int] = ...) -> None: ...

class ObjectiveOverview(_message.Message):
    __slots__ = ("objective", "as_of_ms", "team", "pool", "deadline", "attention", "sessions", "conversation", "posts", "tasks", "total_tasks", "next_offset", "notices", "pending_approvals", "total_sessions")
    OBJECTIVE_FIELD_NUMBER: _ClassVar[int]
    AS_OF_MS_FIELD_NUMBER: _ClassVar[int]
    TEAM_FIELD_NUMBER: _ClassVar[int]
    POOL_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_FIELD_NUMBER: _ClassVar[int]
    ATTENTION_FIELD_NUMBER: _ClassVar[int]
    SESSIONS_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_FIELD_NUMBER: _ClassVar[int]
    POSTS_FIELD_NUMBER: _ClassVar[int]
    TASKS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TASKS_FIELD_NUMBER: _ClassVar[int]
    NEXT_OFFSET_FIELD_NUMBER: _ClassVar[int]
    NOTICES_FIELD_NUMBER: _ClassVar[int]
    PENDING_APPROVALS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_SESSIONS_FIELD_NUMBER: _ClassVar[int]
    objective: _runtime_pb2.Objective
    as_of_ms: int
    team: ObjectiveOverviewTeam
    pool: ObjectiveBudgetPool
    deadline: ObjectiveDeadlineView
    attention: _containers.RepeatedCompositeFieldContainer[ObjectiveAttention]
    sessions: _containers.RepeatedCompositeFieldContainer[ObjectiveSessionView]
    conversation: _containers.RepeatedCompositeFieldContainer[ObjectiveTurn]
    posts: _containers.RepeatedCompositeFieldContainer[ObjectiveTeamPost]
    tasks: _containers.RepeatedCompositeFieldContainer[ObjectiveTurn]
    total_tasks: int
    next_offset: int
    notices: _containers.RepeatedCompositeFieldContainer[ObjectiveLimitNotice]
    pending_approvals: int
    total_sessions: int
    def __init__(self, objective: _Optional[_Union[_runtime_pb2.Objective, _Mapping]] = ..., as_of_ms: _Optional[int] = ..., team: _Optional[_Union[ObjectiveOverviewTeam, _Mapping]] = ..., pool: _Optional[_Union[ObjectiveBudgetPool, _Mapping]] = ..., deadline: _Optional[_Union[ObjectiveDeadlineView, _Mapping]] = ..., attention: _Optional[_Iterable[_Union[ObjectiveAttention, _Mapping]]] = ..., sessions: _Optional[_Iterable[_Union[ObjectiveSessionView, _Mapping]]] = ..., conversation: _Optional[_Iterable[_Union[ObjectiveTurn, _Mapping]]] = ..., posts: _Optional[_Iterable[_Union[ObjectiveTeamPost, _Mapping]]] = ..., tasks: _Optional[_Iterable[_Union[ObjectiveTurn, _Mapping]]] = ..., total_tasks: _Optional[int] = ..., next_offset: _Optional[int] = ..., notices: _Optional[_Iterable[_Union[ObjectiveLimitNotice, _Mapping]]] = ..., pending_approvals: _Optional[int] = ..., total_sessions: _Optional[int] = ...) -> None: ...

class ObjectiveOverviewTeam(_message.Message):
    __slots__ = ("team_id", "name", "member_tag_ids", "max_concurrency", "running_turns")
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    MEMBER_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    MAX_CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    RUNNING_TURNS_FIELD_NUMBER: _ClassVar[int]
    team_id: str
    name: str
    member_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    max_concurrency: int
    running_turns: int
    def __init__(self, team_id: _Optional[str] = ..., name: _Optional[str] = ..., member_tag_ids: _Optional[_Iterable[str]] = ..., max_concurrency: _Optional[int] = ..., running_turns: _Optional[int] = ...) -> None: ...

class ObjectiveBudgetPool(_message.Message):
    __slots__ = ("measure", "currency", "limit_minor", "spent_minor", "available_minor", "overrun_minor", "exhausted", "unknown_cost_attempts", "estimated_cost_attempts")
    MEASURE_FIELD_NUMBER: _ClassVar[int]
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    LIMIT_MINOR_FIELD_NUMBER: _ClassVar[int]
    SPENT_MINOR_FIELD_NUMBER: _ClassVar[int]
    AVAILABLE_MINOR_FIELD_NUMBER: _ClassVar[int]
    OVERRUN_MINOR_FIELD_NUMBER: _ClassVar[int]
    EXHAUSTED_FIELD_NUMBER: _ClassVar[int]
    UNKNOWN_COST_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    ESTIMATED_COST_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    measure: ObjectiveBudgetMeasure
    currency: str
    limit_minor: int
    spent_minor: int
    available_minor: int
    overrun_minor: int
    exhausted: bool
    unknown_cost_attempts: int
    estimated_cost_attempts: int
    def __init__(self, measure: _Optional[_Union[ObjectiveBudgetMeasure, str]] = ..., currency: _Optional[str] = ..., limit_minor: _Optional[int] = ..., spent_minor: _Optional[int] = ..., available_minor: _Optional[int] = ..., overrun_minor: _Optional[int] = ..., exhausted: _Optional[bool] = ..., unknown_cost_attempts: _Optional[int] = ..., estimated_cost_attempts: _Optional[int] = ...) -> None: ...

class ObjectiveDeadlineView(_message.Message):
    __slots__ = ("at_ms", "passed", "grace_ends_at_ms", "remaining")
    AT_MS_FIELD_NUMBER: _ClassVar[int]
    PASSED_FIELD_NUMBER: _ClassVar[int]
    GRACE_ENDS_AT_MS_FIELD_NUMBER: _ClassVar[int]
    REMAINING_FIELD_NUMBER: _ClassVar[int]
    at_ms: int
    passed: bool
    grace_ends_at_ms: int
    remaining: str
    def __init__(self, at_ms: _Optional[int] = ..., passed: _Optional[bool] = ..., grace_ends_at_ms: _Optional[int] = ..., remaining: _Optional[str] = ...) -> None: ...

class ObjectiveLimitNotice(_message.Message):
    __slots__ = ("key", "kind", "at_ms", "message")
    KEY_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    AT_MS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    key: str
    kind: str
    at_ms: int
    message: str
    def __init__(self, key: _Optional[str] = ..., kind: _Optional[str] = ..., at_ms: _Optional[int] = ..., message: _Optional[str] = ...) -> None: ...

class ObjectiveAttention(_message.Message):
    __slots__ = ("kind", "message", "next_actions", "task_id", "tag_id")
    KIND_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    NEXT_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    kind: ObjectiveAttentionKind
    message: str
    next_actions: _containers.RepeatedScalarFieldContainer[str]
    task_id: str
    tag_id: str
    def __init__(self, kind: _Optional[_Union[ObjectiveAttentionKind, str]] = ..., message: _Optional[str] = ..., next_actions: _Optional[_Iterable[str]] = ..., task_id: _Optional[str] = ..., tag_id: _Optional[str] = ...) -> None: ...

class ObjectiveSessionView(_message.Message):
    __slots__ = ("session_id", "tag_id", "owner", "title", "parent_session_id", "status", "question", "task_count", "latest_task_id")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    OWNER_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    PARENT_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    QUESTION_FIELD_NUMBER: _ClassVar[int]
    TASK_COUNT_FIELD_NUMBER: _ClassVar[int]
    LATEST_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    tag_id: str
    owner: bool
    title: str
    parent_session_id: str
    status: ObjectiveSessionStatus
    question: str
    task_count: int
    latest_task_id: str
    def __init__(self, session_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., owner: _Optional[bool] = ..., title: _Optional[str] = ..., parent_session_id: _Optional[str] = ..., status: _Optional[_Union[ObjectiveSessionStatus, str]] = ..., question: _Optional[str] = ..., task_count: _Optional[int] = ..., latest_task_id: _Optional[str] = ...) -> None: ...

class ObjectiveTurn(_message.Message):
    __slots__ = ("task_id", "tag_id", "session_id", "state", "kind", "prompt", "result", "completed_at_ms")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    tag_id: str
    session_id: str
    state: _runtime_pb2.TaskState
    kind: str
    prompt: str
    result: str
    completed_at_ms: int
    def __init__(self, task_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., state: _Optional[_Union[_runtime_pb2.TaskState, str]] = ..., kind: _Optional[str] = ..., prompt: _Optional[str] = ..., result: _Optional[str] = ..., completed_at_ms: _Optional[int] = ...) -> None: ...

class ObjectiveTeamPost(_message.Message):
    __slots__ = ("sequence", "author_tag_id", "to_tag_ids", "body", "created_at_ms")
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    AUTHOR_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    TO_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    BODY_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    sequence: int
    author_tag_id: str
    to_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    body: str
    created_at_ms: int
    def __init__(self, sequence: _Optional[int] = ..., author_tag_id: _Optional[str] = ..., to_tag_ids: _Optional[_Iterable[str]] = ..., body: _Optional[str] = ..., created_at_ms: _Optional[int] = ...) -> None: ...
