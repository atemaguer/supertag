from supertag.runtime.v2 import runtime_pb2 as _runtime_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ScheduleState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SCHEDULE_STATE_UNSPECIFIED: _ClassVar[ScheduleState]
    SCHEDULE_STATE_STAGED: _ClassVar[ScheduleState]
    SCHEDULE_STATE_ACTIVE: _ClassVar[ScheduleState]
    SCHEDULE_STATE_PAUSED: _ClassVar[ScheduleState]
    SCHEDULE_STATE_DONE: _ClassVar[ScheduleState]
    SCHEDULE_STATE_CANCELLED: _ClassVar[ScheduleState]
SCHEDULE_STATE_UNSPECIFIED: ScheduleState
SCHEDULE_STATE_STAGED: ScheduleState
SCHEDULE_STATE_ACTIVE: ScheduleState
SCHEDULE_STATE_PAUSED: ScheduleState
SCHEDULE_STATE_DONE: ScheduleState
SCHEDULE_STATE_CANCELLED: ScheduleState

class ScheduleRecurrence(_message.Message):
    __slots__ = ("cron", "time_zone")
    CRON_FIELD_NUMBER: _ClassVar[int]
    TIME_ZONE_FIELD_NUMBER: _ClassVar[int]
    cron: str
    time_zone: str
    def __init__(self, cron: _Optional[str] = ..., time_zone: _Optional[str] = ...) -> None: ...

class Schedule(_message.Message):
    __slots__ = ("schedule_id", "tag_id", "session_id", "note", "at_ms", "every", "state", "next_due_at_ms", "created_by", "created_at_ms", "objective_id", "fire_count", "missed_count", "last_task_id", "last_fired_at_ms", "audience")
    SCHEDULE_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    NOTE_FIELD_NUMBER: _ClassVar[int]
    AT_MS_FIELD_NUMBER: _ClassVar[int]
    EVERY_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    NEXT_DUE_AT_MS_FIELD_NUMBER: _ClassVar[int]
    CREATED_BY_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    FIRE_COUNT_FIELD_NUMBER: _ClassVar[int]
    MISSED_COUNT_FIELD_NUMBER: _ClassVar[int]
    LAST_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    LAST_FIRED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    AUDIENCE_FIELD_NUMBER: _ClassVar[int]
    schedule_id: str
    tag_id: str
    session_id: str
    note: str
    at_ms: int
    every: ScheduleRecurrence
    state: ScheduleState
    next_due_at_ms: int
    created_by: str
    created_at_ms: int
    objective_id: str
    fire_count: int
    missed_count: int
    last_task_id: str
    last_fired_at_ms: int
    audience: str
    def __init__(self, schedule_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., note: _Optional[str] = ..., at_ms: _Optional[int] = ..., every: _Optional[_Union[ScheduleRecurrence, _Mapping]] = ..., state: _Optional[_Union[ScheduleState, str]] = ..., next_due_at_ms: _Optional[int] = ..., created_by: _Optional[str] = ..., created_at_ms: _Optional[int] = ..., objective_id: _Optional[str] = ..., fire_count: _Optional[int] = ..., missed_count: _Optional[int] = ..., last_task_id: _Optional[str] = ..., last_fired_at_ms: _Optional[int] = ..., audience: _Optional[str] = ...) -> None: ...

class CreateScheduleRequest(_message.Message):
    __slots__ = ("operation_id", "tag_id", "note", "at", "every", "time_zone")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    NOTE_FIELD_NUMBER: _ClassVar[int]
    AT_FIELD_NUMBER: _ClassVar[int]
    EVERY_FIELD_NUMBER: _ClassVar[int]
    TIME_ZONE_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    tag_id: str
    note: str
    at: str
    every: str
    time_zone: str
    def __init__(self, operation_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., note: _Optional[str] = ..., at: _Optional[str] = ..., every: _Optional[str] = ..., time_zone: _Optional[str] = ...) -> None: ...

class GetScheduleRequest(_message.Message):
    __slots__ = ("schedule_id",)
    SCHEDULE_ID_FIELD_NUMBER: _ClassVar[int]
    schedule_id: str
    def __init__(self, schedule_id: _Optional[str] = ...) -> None: ...

class PutScheduleRequest(_message.Message):
    __slots__ = ("schedule_id", "tag_id", "note", "every", "time_zone")
    SCHEDULE_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    NOTE_FIELD_NUMBER: _ClassVar[int]
    EVERY_FIELD_NUMBER: _ClassVar[int]
    TIME_ZONE_FIELD_NUMBER: _ClassVar[int]
    schedule_id: str
    tag_id: str
    note: str
    every: str
    time_zone: str
    def __init__(self, schedule_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., note: _Optional[str] = ..., every: _Optional[str] = ..., time_zone: _Optional[str] = ...) -> None: ...

class BackfillScheduleRequest(_message.Message):
    __slots__ = ("schedule_id", "from_ms")
    SCHEDULE_ID_FIELD_NUMBER: _ClassVar[int]
    FROM_MS_FIELD_NUMBER: _ClassVar[int]
    schedule_id: str
    from_ms: int
    def __init__(self, schedule_id: _Optional[str] = ..., from_ms: _Optional[int] = ...) -> None: ...

class BackfillScheduleResponse(_message.Message):
    __slots__ = ("schedule", "task_ids", "skipped")
    SCHEDULE_FIELD_NUMBER: _ClassVar[int]
    TASK_IDS_FIELD_NUMBER: _ClassVar[int]
    SKIPPED_FIELD_NUMBER: _ClassVar[int]
    schedule: Schedule
    task_ids: _containers.RepeatedScalarFieldContainer[str]
    skipped: int
    def __init__(self, schedule: _Optional[_Union[Schedule, _Mapping]] = ..., task_ids: _Optional[_Iterable[str]] = ..., skipped: _Optional[int] = ...) -> None: ...

class ListSchedulesRequest(_message.Message):
    __slots__ = ("tag_id", "include_finished")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    INCLUDE_FINISHED_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    include_finished: bool
    def __init__(self, tag_id: _Optional[str] = ..., include_finished: _Optional[bool] = ...) -> None: ...

class ListSchedulesResponse(_message.Message):
    __slots__ = ("schedules",)
    SCHEDULES_FIELD_NUMBER: _ClassVar[int]
    schedules: _containers.RepeatedCompositeFieldContainer[Schedule]
    def __init__(self, schedules: _Optional[_Iterable[_Union[Schedule, _Mapping]]] = ...) -> None: ...

class CreateAttemptScheduleRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "note", "at", "every", "time_zone")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    NOTE_FIELD_NUMBER: _ClassVar[int]
    AT_FIELD_NUMBER: _ClassVar[int]
    EVERY_FIELD_NUMBER: _ClassVar[int]
    TIME_ZONE_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    operation_id: str
    note: str
    at: str
    every: str
    time_zone: str
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., note: _Optional[str] = ..., at: _Optional[str] = ..., every: _Optional[str] = ..., time_zone: _Optional[str] = ...) -> None: ...

class CancelAttemptScheduleRequest(_message.Message):
    __slots__ = ("attempt", "schedule_id")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    SCHEDULE_ID_FIELD_NUMBER: _ClassVar[int]
    attempt: _runtime_pb2.InspectAttemptRequest
    schedule_id: str
    def __init__(self, attempt: _Optional[_Union[_runtime_pb2.InspectAttemptRequest, _Mapping]] = ..., schedule_id: _Optional[str] = ...) -> None: ...

class AttemptScheduleResponse(_message.Message):
    __slots__ = ("schedule", "pending", "time_zone")
    SCHEDULE_FIELD_NUMBER: _ClassVar[int]
    PENDING_FIELD_NUMBER: _ClassVar[int]
    TIME_ZONE_FIELD_NUMBER: _ClassVar[int]
    schedule: Schedule
    pending: _containers.RepeatedCompositeFieldContainer[Schedule]
    time_zone: str
    def __init__(self, schedule: _Optional[_Union[Schedule, _Mapping]] = ..., pending: _Optional[_Iterable[_Union[Schedule, _Mapping]]] = ..., time_zone: _Optional[str] = ...) -> None: ...
