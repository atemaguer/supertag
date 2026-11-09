import datetime

from google.protobuf import timestamp_pb2 as _timestamp_pb2
from supertag.operator.v1 import common_pb2 as _common_pb2
from supertag.operator.v1 import options_pb2 as _options_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class WatchKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WATCH_KIND_UNSPECIFIED: _ClassVar[WatchKind]
    WATCH_KIND_TAG: _ClassVar[WatchKind]
    WATCH_KIND_SESSION: _ClassVar[WatchKind]
    WATCH_KIND_TASK: _ClassVar[WatchKind]
    WATCH_KIND_OBJECTIVE: _ClassVar[WatchKind]
    WATCH_KIND_INBOX_ITEM: _ClassVar[WatchKind]
    WATCH_KIND_APPROVAL: _ClassVar[WatchKind]
    WATCH_KIND_CONVERSATION_MESSAGE: _ClassVar[WatchKind]
    WATCH_KIND_WORKSTREAM_POST: _ClassVar[WatchKind]
WATCH_KIND_UNSPECIFIED: WatchKind
WATCH_KIND_TAG: WatchKind
WATCH_KIND_SESSION: WatchKind
WATCH_KIND_TASK: WatchKind
WATCH_KIND_OBJECTIVE: WatchKind
WATCH_KIND_INBOX_ITEM: WatchKind
WATCH_KIND_APPROVAL: WatchKind
WATCH_KIND_CONVERSATION_MESSAGE: WatchKind
WATCH_KIND_WORKSTREAM_POST: WatchKind

class WatchRequest(_message.Message):
    __slots__ = ("resume_token", "kinds")
    RESUME_TOKEN_FIELD_NUMBER: _ClassVar[int]
    KINDS_FIELD_NUMBER: _ClassVar[int]
    resume_token: str
    kinds: _containers.RepeatedScalarFieldContainer[WatchKind]
    def __init__(self, resume_token: _Optional[str] = ..., kinds: _Optional[_Iterable[_Union[WatchKind, str]]] = ...) -> None: ...

class WatchEvent(_message.Message):
    __slots__ = ("resume_token", "change", "resync", "heartbeat")
    RESUME_TOKEN_FIELD_NUMBER: _ClassVar[int]
    CHANGE_FIELD_NUMBER: _ClassVar[int]
    RESYNC_FIELD_NUMBER: _ClassVar[int]
    HEARTBEAT_FIELD_NUMBER: _ClassVar[int]
    resume_token: str
    change: WatchChange
    resync: WatchResync
    heartbeat: _common_pb2.Heartbeat
    def __init__(self, resume_token: _Optional[str] = ..., change: _Optional[_Union[WatchChange, _Mapping]] = ..., resync: _Optional[_Union[WatchResync, _Mapping]] = ..., heartbeat: _Optional[_Union[_common_pb2.Heartbeat, _Mapping]] = ...) -> None: ...

class WatchChange(_message.Message):
    __slots__ = ("kind", "id", "tag", "session_id", "task_id", "objective_id", "conversation", "reason", "changed_at", "team_id")
    KIND_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    TAG_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    CHANGED_AT_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    kind: WatchKind
    id: str
    tag: str
    session_id: str
    task_id: str
    objective_id: str
    conversation: str
    reason: str
    changed_at: _timestamp_pb2.Timestamp
    team_id: str
    def __init__(self, kind: _Optional[_Union[WatchKind, str]] = ..., id: _Optional[str] = ..., tag: _Optional[str] = ..., session_id: _Optional[str] = ..., task_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., conversation: _Optional[str] = ..., reason: _Optional[str] = ..., changed_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., team_id: _Optional[str] = ...) -> None: ...

class WatchResync(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...
