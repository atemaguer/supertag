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
REPLY_STATE_UNSPECIFIED: ReplyState
REPLY_STATE_PENDING: ReplyState
REPLY_STATE_CLAIMED: ReplyState
REPLY_STATE_DELIVERED: ReplyState
REPLY_STATE_FAILED: ReplyState
REPLY_STATE_UNCERTAIN: ReplyState

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
    __slots__ = ("task_id", "attempt_id", "lease_token", "result", "succeeded")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    SUCCEEDED_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    lease_token: str
    result: str
    succeeded: bool
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., lease_token: _Optional[str] = ..., result: _Optional[str] = ..., succeeded: _Optional[bool] = ...) -> None: ...

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
    __slots__ = ("task", "attempt_id")
    TASK_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    task: Task
    attempt_id: str
    def __init__(self, task: _Optional[_Union[Task, _Mapping]] = ..., attempt_id: _Optional[str] = ...) -> None: ...

class HarnessPublishRequest(_message.Message):
    __slots__ = ("sequence", "text")
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    sequence: int
    text: str
    def __init__(self, sequence: _Optional[int] = ..., text: _Optional[str] = ...) -> None: ...

class HarnessCompleteRequest(_message.Message):
    __slots__ = ("result", "succeeded")
    RESULT_FIELD_NUMBER: _ClassVar[int]
    SUCCEEDED_FIELD_NUMBER: _ClassVar[int]
    result: str
    succeeded: bool
    def __init__(self, result: _Optional[str] = ..., succeeded: _Optional[bool] = ...) -> None: ...

class HarnessCompleteResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

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
