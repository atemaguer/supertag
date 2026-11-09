import datetime

from google.protobuf import timestamp_pb2 as _timestamp_pb2
from supertag.operator.v1 import options_pb2 as _options_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class CreateTeamRequest(_message.Message):
    __slots__ = ("id", "name", "members", "max_concurrency")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    MEMBERS_FIELD_NUMBER: _ClassVar[int]
    MAX_CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    members: _containers.RepeatedScalarFieldContainer[str]
    max_concurrency: int
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., members: _Optional[_Iterable[str]] = ..., max_concurrency: _Optional[int] = ...) -> None: ...

class ListTeamsRequest(_message.Message):
    __slots__ = ("member", "page_size", "page_token")
    MEMBER_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    member: str
    page_size: int
    page_token: str
    def __init__(self, member: _Optional[str] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListTeamsResponse(_message.Message):
    __slots__ = ("teams", "next_page_token")
    TEAMS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    teams: _containers.RepeatedCompositeFieldContainer[Team]
    next_page_token: str
    def __init__(self, teams: _Optional[_Iterable[_Union[Team, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class GetTeamRequest(_message.Message):
    __slots__ = ("team",)
    TEAM_FIELD_NUMBER: _ClassVar[int]
    team: str
    def __init__(self, team: _Optional[str] = ...) -> None: ...

class UpdateTeamRequest(_message.Message):
    __slots__ = ("team", "expected_revision", "name", "members", "concurrency")
    TEAM_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    MEMBERS_FIELD_NUMBER: _ClassVar[int]
    CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    team: str
    expected_revision: int
    name: str
    members: TeamMembers
    concurrency: TeamConcurrency
    def __init__(self, team: _Optional[str] = ..., expected_revision: _Optional[int] = ..., name: _Optional[str] = ..., members: _Optional[_Union[TeamMembers, _Mapping]] = ..., concurrency: _Optional[_Union[TeamConcurrency, _Mapping]] = ...) -> None: ...

class TeamMembers(_message.Message):
    __slots__ = ("tags",)
    TAGS_FIELD_NUMBER: _ClassVar[int]
    tags: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, tags: _Optional[_Iterable[str]] = ...) -> None: ...

class TeamConcurrency(_message.Message):
    __slots__ = ("max_concurrency",)
    MAX_CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    max_concurrency: int
    def __init__(self, max_concurrency: _Optional[int] = ...) -> None: ...

class DeleteTeamRequest(_message.Message):
    __slots__ = ("team",)
    TEAM_FIELD_NUMBER: _ClassVar[int]
    team: str
    def __init__(self, team: _Optional[str] = ...) -> None: ...

class DeleteTeamResponse(_message.Message):
    __slots__ = ("id", "name")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ...) -> None: ...

class Team(_message.Message):
    __slots__ = ("id", "name", "members", "max_concurrency", "revision", "created_at", "updated_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    MEMBERS_FIELD_NUMBER: _ClassVar[int]
    MAX_CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    members: _containers.RepeatedCompositeFieldContainer[TeamMember]
    max_concurrency: int
    revision: int
    created_at: _timestamp_pb2.Timestamp
    updated_at: _timestamp_pb2.Timestamp
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., members: _Optional[_Iterable[_Union[TeamMember, _Mapping]]] = ..., max_concurrency: _Optional[int] = ..., revision: _Optional[int] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., updated_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class TeamMember(_message.Message):
    __slots__ = ("tag_id", "tag")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    tag: str
    def __init__(self, tag_id: _Optional[str] = ..., tag: _Optional[str] = ...) -> None: ...

class WorkstreamPost(_message.Message):
    __slots__ = ("id", "team_id", "author_tag_id", "to_tag_ids", "body", "source_task_id", "sequence", "created_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    AUTHOR_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    TO_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    BODY_FIELD_NUMBER: _ClassVar[int]
    SOURCE_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    team_id: str
    author_tag_id: str
    to_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    body: str
    source_task_id: str
    sequence: int
    created_at: _timestamp_pb2.Timestamp
    def __init__(self, id: _Optional[str] = ..., team_id: _Optional[str] = ..., author_tag_id: _Optional[str] = ..., to_tag_ids: _Optional[_Iterable[str]] = ..., body: _Optional[str] = ..., source_task_id: _Optional[str] = ..., sequence: _Optional[int] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...
