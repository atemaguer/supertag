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

class ConversationAuthor(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    CONVERSATION_AUTHOR_UNSPECIFIED: _ClassVar[ConversationAuthor]
    CONVERSATION_AUTHOR_OPERATOR: _ClassVar[ConversationAuthor]
    CONVERSATION_AUTHOR_TAG: _ClassVar[ConversationAuthor]

class ReplyStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    REPLY_STATUS_UNSPECIFIED: _ClassVar[ReplyStatus]
    REPLY_STATUS_WAITING: _ClassVar[ReplyStatus]
    REPLY_STATUS_REPLIED: _ClassVar[ReplyStatus]

class ReplyPresentation(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    REPLY_PRESENTATION_UNSPECIFIED: _ClassVar[ReplyPresentation]
    REPLY_PRESENTATION_FINAL_RESULT: _ClassVar[ReplyPresentation]
    REPLY_PRESENTATION_ERROR: _ClassVar[ReplyPresentation]
    REPLY_PRESENTATION_STATUS: _ClassVar[ReplyPresentation]
    REPLY_PRESENTATION_ACKNOWLEDGEMENT: _ClassVar[ReplyPresentation]

class WorkSessionStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WORK_SESSION_STATUS_UNSPECIFIED: _ClassVar[WorkSessionStatus]
    WORK_SESSION_STATUS_PENDING: _ClassVar[WorkSessionStatus]
    WORK_SESSION_STATUS_RUNNING: _ClassVar[WorkSessionStatus]
    WORK_SESSION_STATUS_COMPLETED: _ClassVar[WorkSessionStatus]
    WORK_SESSION_STATUS_FAILED: _ClassVar[WorkSessionStatus]
    WORK_SESSION_STATUS_CANCELLED: _ClassVar[WorkSessionStatus]
    WORK_SESSION_STATUS_WAITING: _ClassVar[WorkSessionStatus]

class ActivityStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ACTIVITY_STATUS_UNSPECIFIED: _ClassVar[ActivityStatus]
    ACTIVITY_STATUS_RUNNING: _ClassVar[ActivityStatus]
    ACTIVITY_STATUS_COMPLETED: _ClassVar[ActivityStatus]
    ACTIVITY_STATUS_FAILED: _ClassVar[ActivityStatus]
CONVERSATION_AUTHOR_UNSPECIFIED: ConversationAuthor
CONVERSATION_AUTHOR_OPERATOR: ConversationAuthor
CONVERSATION_AUTHOR_TAG: ConversationAuthor
REPLY_STATUS_UNSPECIFIED: ReplyStatus
REPLY_STATUS_WAITING: ReplyStatus
REPLY_STATUS_REPLIED: ReplyStatus
REPLY_PRESENTATION_UNSPECIFIED: ReplyPresentation
REPLY_PRESENTATION_FINAL_RESULT: ReplyPresentation
REPLY_PRESENTATION_ERROR: ReplyPresentation
REPLY_PRESENTATION_STATUS: ReplyPresentation
REPLY_PRESENTATION_ACKNOWLEDGEMENT: ReplyPresentation
WORK_SESSION_STATUS_UNSPECIFIED: WorkSessionStatus
WORK_SESSION_STATUS_PENDING: WorkSessionStatus
WORK_SESSION_STATUS_RUNNING: WorkSessionStatus
WORK_SESSION_STATUS_COMPLETED: WorkSessionStatus
WORK_SESSION_STATUS_FAILED: WorkSessionStatus
WORK_SESSION_STATUS_CANCELLED: WorkSessionStatus
WORK_SESSION_STATUS_WAITING: WorkSessionStatus
ACTIVITY_STATUS_UNSPECIFIED: ActivityStatus
ACTIVITY_STATUS_RUNNING: ActivityStatus
ACTIVITY_STATUS_COMPLETED: ActivityStatus
ACTIVITY_STATUS_FAILED: ActivityStatus

class SendMessageRequest(_message.Message):
    __slots__ = ("tag", "conversation", "text", "idempotency_key")
    TAG_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    IDEMPOTENCY_KEY_FIELD_NUMBER: _ClassVar[int]
    tag: str
    conversation: str
    text: str
    idempotency_key: str
    def __init__(self, tag: _Optional[str] = ..., conversation: _Optional[str] = ..., text: _Optional[str] = ..., idempotency_key: _Optional[str] = ...) -> None: ...

class GetMessageRequest(_message.Message):
    __slots__ = ("tag", "task_id")
    TAG_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    tag: str
    task_id: str
    def __init__(self, tag: _Optional[str] = ..., task_id: _Optional[str] = ...) -> None: ...

class FollowMessageRequest(_message.Message):
    __slots__ = ("tag", "task_id", "after_sequence")
    TAG_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    AFTER_SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    tag: str
    task_id: str
    after_sequence: int
    def __init__(self, tag: _Optional[str] = ..., task_id: _Optional[str] = ..., after_sequence: _Optional[int] = ...) -> None: ...

class ListConversationsRequest(_message.Message):
    __slots__ = ("tag", "page_size", "page_token")
    TAG_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    tag: str
    page_size: int
    page_token: str
    def __init__(self, tag: _Optional[str] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListConversationsResponse(_message.Message):
    __slots__ = ("conversations", "next_page_token")
    CONVERSATIONS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    conversations: _containers.RepeatedCompositeFieldContainer[Conversation]
    next_page_token: str
    def __init__(self, conversations: _Optional[_Iterable[_Union[Conversation, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class ListMessagesRequest(_message.Message):
    __slots__ = ("tag", "conversation", "page_size", "page_token")
    TAG_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    tag: str
    conversation: str
    page_size: int
    page_token: str
    def __init__(self, tag: _Optional[str] = ..., conversation: _Optional[str] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListMessagesResponse(_message.Message):
    __slots__ = ("messages", "next_page_token")
    MESSAGES_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    messages: _containers.RepeatedCompositeFieldContainer[Message]
    next_page_token: str
    def __init__(self, messages: _Optional[_Iterable[_Union[Message, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class Conversation(_message.Message):
    __slots__ = ("tag", "name", "session_id", "last_message_text", "last_message_author", "last_message_at", "open_work_session_count")
    TAG_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    LAST_MESSAGE_TEXT_FIELD_NUMBER: _ClassVar[int]
    LAST_MESSAGE_AUTHOR_FIELD_NUMBER: _ClassVar[int]
    LAST_MESSAGE_AT_FIELD_NUMBER: _ClassVar[int]
    OPEN_WORK_SESSION_COUNT_FIELD_NUMBER: _ClassVar[int]
    tag: str
    name: str
    session_id: str
    last_message_text: str
    last_message_author: ConversationAuthor
    last_message_at: _timestamp_pb2.Timestamp
    open_work_session_count: int
    def __init__(self, tag: _Optional[str] = ..., name: _Optional[str] = ..., session_id: _Optional[str] = ..., last_message_text: _Optional[str] = ..., last_message_author: _Optional[_Union[ConversationAuthor, str]] = ..., last_message_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., open_work_session_count: _Optional[int] = ...) -> None: ...

class Message(_message.Message):
    __slots__ = ("task_id", "tag", "conversation", "session_id", "text", "created_at", "status", "waiting_reason", "reply", "joined_task_id", "work_sessions")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    WAITING_REASON_FIELD_NUMBER: _ClassVar[int]
    REPLY_FIELD_NUMBER: _ClassVar[int]
    JOINED_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    WORK_SESSIONS_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    tag: str
    conversation: str
    session_id: str
    text: str
    created_at: _timestamp_pb2.Timestamp
    status: ReplyStatus
    waiting_reason: str
    reply: Reply
    joined_task_id: str
    work_sessions: _containers.RepeatedCompositeFieldContainer[WorkSession]
    def __init__(self, task_id: _Optional[str] = ..., tag: _Optional[str] = ..., conversation: _Optional[str] = ..., session_id: _Optional[str] = ..., text: _Optional[str] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., status: _Optional[_Union[ReplyStatus, str]] = ..., waiting_reason: _Optional[str] = ..., reply: _Optional[_Union[Reply, _Mapping]] = ..., joined_task_id: _Optional[str] = ..., work_sessions: _Optional[_Iterable[_Union[WorkSession, _Mapping]]] = ...) -> None: ...

class Reply(_message.Message):
    __slots__ = ("presentation", "text")
    PRESENTATION_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    presentation: ReplyPresentation
    text: str
    def __init__(self, presentation: _Optional[_Union[ReplyPresentation, str]] = ..., text: _Optional[str] = ...) -> None: ...

class WorkSession(_message.Message):
    __slots__ = ("id", "title", "task_id", "status", "question", "approvals", "not_continued", "report_status", "report_task_id", "report")
    ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    QUESTION_FIELD_NUMBER: _ClassVar[int]
    APPROVALS_FIELD_NUMBER: _ClassVar[int]
    NOT_CONTINUED_FIELD_NUMBER: _ClassVar[int]
    REPORT_STATUS_FIELD_NUMBER: _ClassVar[int]
    REPORT_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    REPORT_FIELD_NUMBER: _ClassVar[int]
    id: str
    title: str
    task_id: str
    status: WorkSessionStatus
    question: str
    approvals: _containers.RepeatedCompositeFieldContainer[ApprovalNotice]
    not_continued: str
    report_status: ReplyStatus
    report_task_id: str
    report: Reply
    def __init__(self, id: _Optional[str] = ..., title: _Optional[str] = ..., task_id: _Optional[str] = ..., status: _Optional[_Union[WorkSessionStatus, str]] = ..., question: _Optional[str] = ..., approvals: _Optional[_Iterable[_Union[ApprovalNotice, _Mapping]]] = ..., not_continued: _Optional[str] = ..., report_status: _Optional[_Union[ReplyStatus, str]] = ..., report_task_id: _Optional[str] = ..., report: _Optional[_Union[Reply, _Mapping]] = ...) -> None: ...

class ApprovalNotice(_message.Message):
    __slots__ = ("request_id", "text")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    text: str
    def __init__(self, request_id: _Optional[str] = ..., text: _Optional[str] = ...) -> None: ...

class FollowEvent(_message.Message):
    __slots__ = ("sequence", "joined", "waiting", "text_delta", "activity", "finish", "error", "work_session_changed", "end", "heartbeat")
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    JOINED_FIELD_NUMBER: _ClassVar[int]
    WAITING_FIELD_NUMBER: _ClassVar[int]
    TEXT_DELTA_FIELD_NUMBER: _ClassVar[int]
    ACTIVITY_FIELD_NUMBER: _ClassVar[int]
    FINISH_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    WORK_SESSION_CHANGED_FIELD_NUMBER: _ClassVar[int]
    END_FIELD_NUMBER: _ClassVar[int]
    HEARTBEAT_FIELD_NUMBER: _ClassVar[int]
    sequence: int
    joined: JoinedTurn
    waiting: PlacementWait
    text_delta: TextDelta
    activity: Activity
    finish: Finish
    error: TurnError
    work_session_changed: WorkSessionChanged
    end: FollowEnd
    heartbeat: _common_pb2.Heartbeat
    def __init__(self, sequence: _Optional[int] = ..., joined: _Optional[_Union[JoinedTurn, _Mapping]] = ..., waiting: _Optional[_Union[PlacementWait, _Mapping]] = ..., text_delta: _Optional[_Union[TextDelta, _Mapping]] = ..., activity: _Optional[_Union[Activity, _Mapping]] = ..., finish: _Optional[_Union[Finish, _Mapping]] = ..., error: _Optional[_Union[TurnError, _Mapping]] = ..., work_session_changed: _Optional[_Union[WorkSessionChanged, _Mapping]] = ..., end: _Optional[_Union[FollowEnd, _Mapping]] = ..., heartbeat: _Optional[_Union[_common_pb2.Heartbeat, _Mapping]] = ...) -> None: ...

class JoinedTurn(_message.Message):
    __slots__ = ("task_id",)
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    def __init__(self, task_id: _Optional[str] = ...) -> None: ...

class PlacementWait(_message.Message):
    __slots__ = ("reason",)
    REASON_FIELD_NUMBER: _ClassVar[int]
    reason: str
    def __init__(self, reason: _Optional[str] = ...) -> None: ...

class TextDelta(_message.Message):
    __slots__ = ("text",)
    TEXT_FIELD_NUMBER: _ClassVar[int]
    text: str
    def __init__(self, text: _Optional[str] = ...) -> None: ...

class Activity(_message.Message):
    __slots__ = ("work_session_id", "text", "command", "tool", "retry")
    WORK_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    COMMAND_FIELD_NUMBER: _ClassVar[int]
    TOOL_FIELD_NUMBER: _ClassVar[int]
    RETRY_FIELD_NUMBER: _ClassVar[int]
    work_session_id: str
    text: str
    command: CommandActivity
    tool: ToolActivity
    retry: RetryActivity
    def __init__(self, work_session_id: _Optional[str] = ..., text: _Optional[str] = ..., command: _Optional[_Union[CommandActivity, _Mapping]] = ..., tool: _Optional[_Union[ToolActivity, _Mapping]] = ..., retry: _Optional[_Union[RetryActivity, _Mapping]] = ...) -> None: ...

class CommandActivity(_message.Message):
    __slots__ = ("id", "command", "status")
    ID_FIELD_NUMBER: _ClassVar[int]
    COMMAND_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    id: str
    command: str
    status: ActivityStatus
    def __init__(self, id: _Optional[str] = ..., command: _Optional[str] = ..., status: _Optional[_Union[ActivityStatus, str]] = ...) -> None: ...

class ToolActivity(_message.Message):
    __slots__ = ("id", "tool", "status")
    ID_FIELD_NUMBER: _ClassVar[int]
    TOOL_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    id: str
    tool: str
    status: ActivityStatus
    def __init__(self, id: _Optional[str] = ..., tool: _Optional[str] = ..., status: _Optional[_Union[ActivityStatus, str]] = ...) -> None: ...

class RetryActivity(_message.Message):
    __slots__ = ("attempt",)
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    attempt: int
    def __init__(self, attempt: _Optional[int] = ...) -> None: ...

class Finish(_message.Message):
    __slots__ = ("reply", "message")
    REPLY_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    reply: Reply
    message: Message
    def __init__(self, reply: _Optional[_Union[Reply, _Mapping]] = ..., message: _Optional[_Union[Message, _Mapping]] = ...) -> None: ...

class TurnError(_message.Message):
    __slots__ = ("text",)
    TEXT_FIELD_NUMBER: _ClassVar[int]
    text: str
    def __init__(self, text: _Optional[str] = ...) -> None: ...

class WorkSessionChanged(_message.Message):
    __slots__ = ("work_session",)
    WORK_SESSION_FIELD_NUMBER: _ClassVar[int]
    work_session: WorkSession
    def __init__(self, work_session: _Optional[_Union[WorkSession, _Mapping]] = ...) -> None: ...

class FollowEnd(_message.Message):
    __slots__ = ("message",)
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    message: Message
    def __init__(self, message: _Optional[_Union[Message, _Mapping]] = ...) -> None: ...
