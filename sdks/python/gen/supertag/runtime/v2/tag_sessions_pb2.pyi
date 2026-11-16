from supertag.runtime.v2 import runtime_pb2 as _runtime_pb2
from supertag.runtime.v2 import objective_overview_pb2 as _objective_overview_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class TagSessionAudience(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TAG_SESSION_AUDIENCE_UNSPECIFIED: _ClassVar[TagSessionAudience]
    TAG_SESSION_AUDIENCE_SHARED: _ClassVar[TagSessionAudience]
    TAG_SESSION_AUDIENCE_PRIVATE: _ClassVar[TagSessionAudience]
TAG_SESSION_AUDIENCE_UNSPECIFIED: TagSessionAudience
TAG_SESSION_AUDIENCE_SHARED: TagSessionAudience
TAG_SESSION_AUDIENCE_PRIVATE: TagSessionAudience

class TagSessionSummary(_message.Message):
    __slots__ = ("session_id", "audience", "provider", "scope", "first_request", "last_interaction_at_ms")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    AUDIENCE_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    SCOPE_FIELD_NUMBER: _ClassVar[int]
    FIRST_REQUEST_FIELD_NUMBER: _ClassVar[int]
    LAST_INTERACTION_AT_MS_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    audience: TagSessionAudience
    provider: str
    scope: str
    first_request: str
    last_interaction_at_ms: int
    def __init__(self, session_id: _Optional[str] = ..., audience: _Optional[_Union[TagSessionAudience, str]] = ..., provider: _Optional[str] = ..., scope: _Optional[str] = ..., first_request: _Optional[str] = ..., last_interaction_at_ms: _Optional[int] = ...) -> None: ...

class ListTagSessionsRequest(_message.Message):
    __slots__ = ("attempt", "limit", "offset")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    limit: int
    offset: int
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., limit: _Optional[int] = ..., offset: _Optional[int] = ...) -> None: ...

class ListTagSessionsResponse(_message.Message):
    __slots__ = ("sessions",)
    SESSIONS_FIELD_NUMBER: _ClassVar[int]
    sessions: _containers.RepeatedCompositeFieldContainer[TagSessionSummary]
    def __init__(self, sessions: _Optional[_Iterable[_Union[TagSessionSummary, _Mapping]]] = ...) -> None: ...

class SearchTagSessionsRequest(_message.Message):
    __slots__ = ("attempt", "query", "limit")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    QUERY_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    query: str
    limit: int
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., query: _Optional[str] = ..., limit: _Optional[int] = ...) -> None: ...

class TagSessionSearchHit(_message.Message):
    __slots__ = ("session_id", "task_id", "completed_at_ms", "provider", "scope", "request_excerpt", "result_excerpt")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    SCOPE_FIELD_NUMBER: _ClassVar[int]
    REQUEST_EXCERPT_FIELD_NUMBER: _ClassVar[int]
    RESULT_EXCERPT_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    task_id: str
    completed_at_ms: int
    provider: str
    scope: str
    request_excerpt: str
    result_excerpt: str
    def __init__(self, session_id: _Optional[str] = ..., task_id: _Optional[str] = ..., completed_at_ms: _Optional[int] = ..., provider: _Optional[str] = ..., scope: _Optional[str] = ..., request_excerpt: _Optional[str] = ..., result_excerpt: _Optional[str] = ...) -> None: ...

class SearchTagSessionsResponse(_message.Message):
    __slots__ = ("matches",)
    MATCHES_FIELD_NUMBER: _ClassVar[int]
    matches: _containers.RepeatedCompositeFieldContainer[TagSessionSearchHit]
    def __init__(self, matches: _Optional[_Iterable[_Union[TagSessionSearchHit, _Mapping]]] = ...) -> None: ...

class ReadTagSessionRequest(_message.Message):
    __slots__ = ("attempt", "session_id", "limit", "before")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    BEFORE_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    session_id: str
    limit: int
    before: int
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., session_id: _Optional[str] = ..., limit: _Optional[int] = ..., before: _Optional[int] = ...) -> None: ...

class TagSessionEntry(_message.Message):
    __slots__ = ("task_id", "state", "request", "result", "completed_at_ms")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    REQUEST_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    state: _runtime_pb2.TaskState
    request: str
    result: str
    completed_at_ms: int
    def __init__(self, task_id: _Optional[str] = ..., state: _Optional[_Union[_runtime_pb2.TaskState, str]] = ..., request: _Optional[str] = ..., result: _Optional[str] = ..., completed_at_ms: _Optional[int] = ...) -> None: ...

class ReadTagSessionResponse(_message.Message):
    __slots__ = ("session", "entries", "next_before")
    SESSION_FIELD_NUMBER: _ClassVar[int]
    ENTRIES_FIELD_NUMBER: _ClassVar[int]
    NEXT_BEFORE_FIELD_NUMBER: _ClassVar[int]
    session: TagSessionSummary
    entries: _containers.RepeatedCompositeFieldContainer[TagSessionEntry]
    next_before: int
    def __init__(self, session: _Optional[_Union[TagSessionSummary, _Mapping]] = ..., entries: _Optional[_Iterable[_Union[TagSessionEntry, _Mapping]]] = ..., next_before: _Optional[int] = ...) -> None: ...

class TagObjectiveSummary(_message.Message):
    __slots__ = ("objective_id", "status", "outcome", "deadline_ms", "updated_at_ms", "home_provider", "home_scope")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_MS_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    HOME_PROVIDER_FIELD_NUMBER: _ClassVar[int]
    HOME_SCOPE_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    status: _runtime_pb2.ObjectiveStatus
    outcome: str
    deadline_ms: int
    updated_at_ms: int
    home_provider: str
    home_scope: str
    def __init__(self, objective_id: _Optional[str] = ..., status: _Optional[_Union[_runtime_pb2.ObjectiveStatus, str]] = ..., outcome: _Optional[str] = ..., deadline_ms: _Optional[int] = ..., updated_at_ms: _Optional[int] = ..., home_provider: _Optional[str] = ..., home_scope: _Optional[str] = ...) -> None: ...

class ListTagObjectivesRequest(_message.Message):
    __slots__ = ("attempt", "limit", "offset")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    limit: int
    offset: int
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., limit: _Optional[int] = ..., offset: _Optional[int] = ...) -> None: ...

class ListTagObjectivesResponse(_message.Message):
    __slots__ = ("objectives", "total")
    OBJECTIVES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    objectives: _containers.RepeatedCompositeFieldContainer[TagObjectiveSummary]
    total: int
    def __init__(self, objectives: _Optional[_Iterable[_Union[TagObjectiveSummary, _Mapping]]] = ..., total: _Optional[int] = ...) -> None: ...

class ReadTagObjectiveRequest(_message.Message):
    __slots__ = ("attempt", "objective_id")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    objective_id: str
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., objective_id: _Optional[str] = ...) -> None: ...

class TagObjectiveView(_message.Message):
    __slots__ = ("objective", "team", "pool", "deadline", "notices", "sessions", "total_sessions", "as_of_ms")
    OBJECTIVE_FIELD_NUMBER: _ClassVar[int]
    TEAM_FIELD_NUMBER: _ClassVar[int]
    POOL_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_FIELD_NUMBER: _ClassVar[int]
    NOTICES_FIELD_NUMBER: _ClassVar[int]
    SESSIONS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_SESSIONS_FIELD_NUMBER: _ClassVar[int]
    AS_OF_MS_FIELD_NUMBER: _ClassVar[int]
    objective: _runtime_pb2.Objective
    team: _objective_overview_pb2.ObjectiveOverviewTeam
    pool: _objective_overview_pb2.ObjectiveBudgetPool
    deadline: _objective_overview_pb2.ObjectiveDeadlineView
    notices: _containers.RepeatedCompositeFieldContainer[_objective_overview_pb2.ObjectiveLimitNotice]
    sessions: _containers.RepeatedCompositeFieldContainer[_objective_overview_pb2.ObjectiveSessionView]
    total_sessions: int
    as_of_ms: int
    def __init__(self, objective: _Optional[_Union[_runtime_pb2.Objective, _Mapping]] = ..., team: _Optional[_Union[_objective_overview_pb2.ObjectiveOverviewTeam, _Mapping]] = ..., pool: _Optional[_Union[_objective_overview_pb2.ObjectiveBudgetPool, _Mapping]] = ..., deadline: _Optional[_Union[_objective_overview_pb2.ObjectiveDeadlineView, _Mapping]] = ..., notices: _Optional[_Iterable[_Union[_objective_overview_pb2.ObjectiveLimitNotice, _Mapping]]] = ..., sessions: _Optional[_Iterable[_Union[_objective_overview_pb2.ObjectiveSessionView, _Mapping]]] = ..., total_sessions: _Optional[int] = ..., as_of_ms: _Optional[int] = ...) -> None: ...
