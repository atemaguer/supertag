import datetime

from google.protobuf import timestamp_pb2 as _timestamp_pb2
from supertag.operator.v1 import options_pb2 as _options_pb2
from supertag.operator.v1 import team_pb2 as _team_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class TagMessageStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TAG_MESSAGE_STATUS_UNSPECIFIED: _ClassVar[TagMessageStatus]
    TAG_MESSAGE_STATUS_PENDING: _ClassVar[TagMessageStatus]
    TAG_MESSAGE_STATUS_HANDLED: _ClassVar[TagMessageStatus]
    TAG_MESSAGE_STATUS_FAILED: _ClassVar[TagMessageStatus]
TAG_MESSAGE_STATUS_UNSPECIFIED: TagMessageStatus
TAG_MESSAGE_STATUS_PENDING: TagMessageStatus
TAG_MESSAGE_STATUS_HANDLED: TagMessageStatus
TAG_MESSAGE_STATUS_FAILED: TagMessageStatus

class ListTagMessagesRequest(_message.Message):
    __slots__ = ("tag", "page_size", "page_token")
    TAG_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    tag: str
    page_size: int
    page_token: str
    def __init__(self, tag: _Optional[str] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListTagMessagesResponse(_message.Message):
    __slots__ = ("messages", "tag_names", "next_page_token")
    class TagNamesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    MESSAGES_FIELD_NUMBER: _ClassVar[int]
    TAG_NAMES_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    messages: _containers.RepeatedCompositeFieldContainer[TagMessage]
    tag_names: _containers.ScalarMap[str, str]
    next_page_token: str
    def __init__(self, messages: _Optional[_Iterable[_Union[TagMessage, _Mapping]]] = ..., tag_names: _Optional[_Mapping[str, str]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class TagMessage(_message.Message):
    __slots__ = ("id", "sender_tag_id", "recipient_tag_id", "objective_id", "source_task_id", "workstream_post_id", "text", "hops", "task_id", "status", "created_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    SENDER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    RECIPIENT_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSTREAM_POST_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    HOPS_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    sender_tag_id: str
    recipient_tag_id: str
    objective_id: str
    source_task_id: str
    workstream_post_id: str
    text: str
    hops: int
    task_id: str
    status: TagMessageStatus
    created_at: _timestamp_pb2.Timestamp
    def __init__(self, id: _Optional[str] = ..., sender_tag_id: _Optional[str] = ..., recipient_tag_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., source_task_id: _Optional[str] = ..., workstream_post_id: _Optional[str] = ..., text: _Optional[str] = ..., hops: _Optional[int] = ..., task_id: _Optional[str] = ..., status: _Optional[_Union[TagMessageStatus, str]] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class GrantMailboxRequest(_message.Message):
    __slots__ = ("sender", "recipient")
    SENDER_FIELD_NUMBER: _ClassVar[int]
    RECIPIENT_FIELD_NUMBER: _ClassVar[int]
    sender: str
    recipient: str
    def __init__(self, sender: _Optional[str] = ..., recipient: _Optional[str] = ...) -> None: ...

class RevokeMailboxRequest(_message.Message):
    __slots__ = ("sender", "recipient")
    SENDER_FIELD_NUMBER: _ClassVar[int]
    RECIPIENT_FIELD_NUMBER: _ClassVar[int]
    sender: str
    recipient: str
    def __init__(self, sender: _Optional[str] = ..., recipient: _Optional[str] = ...) -> None: ...

class MailboxGrantChange(_message.Message):
    __slots__ = ("grant", "changed")
    GRANT_FIELD_NUMBER: _ClassVar[int]
    CHANGED_FIELD_NUMBER: _ClassVar[int]
    grant: MailboxGrant
    changed: bool
    def __init__(self, grant: _Optional[_Union[MailboxGrant, _Mapping]] = ..., changed: _Optional[bool] = ...) -> None: ...

class MailboxGrant(_message.Message):
    __slots__ = ("sender_tag_id", "recipient_tag_id")
    SENDER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    RECIPIENT_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    sender_tag_id: str
    recipient_tag_id: str
    def __init__(self, sender_tag_id: _Optional[str] = ..., recipient_tag_id: _Optional[str] = ...) -> None: ...

class ListMailboxGrantsRequest(_message.Message):
    __slots__ = ("tag", "page_size", "page_token")
    TAG_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    tag: str
    page_size: int
    page_token: str
    def __init__(self, tag: _Optional[str] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListMailboxGrantsResponse(_message.Message):
    __slots__ = ("grants", "tag_names", "next_page_token")
    class TagNamesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    GRANTS_FIELD_NUMBER: _ClassVar[int]
    TAG_NAMES_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    grants: _containers.RepeatedCompositeFieldContainer[MailboxGrant]
    tag_names: _containers.ScalarMap[str, str]
    next_page_token: str
    def __init__(self, grants: _Optional[_Iterable[_Union[MailboxGrant, _Mapping]]] = ..., tag_names: _Optional[_Mapping[str, str]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class ListWorkstreamPostsRequest(_message.Message):
    __slots__ = ("team", "after_sequence", "page_size", "page_token")
    TEAM_FIELD_NUMBER: _ClassVar[int]
    AFTER_SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    team: str
    after_sequence: int
    page_size: int
    page_token: str
    def __init__(self, team: _Optional[str] = ..., after_sequence: _Optional[int] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListWorkstreamPostsResponse(_message.Message):
    __slots__ = ("posts", "tag_names", "next_page_token")
    class TagNamesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    POSTS_FIELD_NUMBER: _ClassVar[int]
    TAG_NAMES_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    posts: _containers.RepeatedCompositeFieldContainer[_team_pb2.WorkstreamPost]
    tag_names: _containers.ScalarMap[str, str]
    next_page_token: str
    def __init__(self, posts: _Optional[_Iterable[_Union[_team_pb2.WorkstreamPost, _Mapping]]] = ..., tag_names: _Optional[_Mapping[str, str]] = ..., next_page_token: _Optional[str] = ...) -> None: ...
