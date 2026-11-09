import datetime

from google.protobuf import timestamp_pb2 as _timestamp_pb2
from supertag.operator.v1 import objective_pb2 as _objective_pb2
from supertag.operator.v1 import options_pb2 as _options_pb2
from supertag.operator.v1 import task_pb2 as _task_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class InboxItemKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    INBOX_ITEM_KIND_UNSPECIFIED: _ClassVar[InboxItemKind]
    INBOX_ITEM_KIND_APPROVAL: _ClassVar[InboxItemKind]
    INBOX_ITEM_KIND_QUESTION: _ClassVar[InboxItemKind]
    INBOX_ITEM_KIND_OBJECTIVE_BUDGET: _ClassVar[InboxItemKind]
    INBOX_ITEM_KIND_OBJECTIVE_LIMIT: _ClassVar[InboxItemKind]
    INBOX_ITEM_KIND_TASK_ATTENTION: _ClassVar[InboxItemKind]
    INBOX_ITEM_KIND_MCP_LOGIN: _ClassVar[InboxItemKind]

class InboxNotificationStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    INBOX_NOTIFICATION_STATUS_UNSPECIFIED: _ClassVar[InboxNotificationStatus]
    INBOX_NOTIFICATION_STATUS_NOT_CONFIGURED: _ClassVar[InboxNotificationStatus]
    INBOX_NOTIFICATION_STATUS_PENDING: _ClassVar[InboxNotificationStatus]
    INBOX_NOTIFICATION_STATUS_DELIVERING: _ClassVar[InboxNotificationStatus]
    INBOX_NOTIFICATION_STATUS_DELIVERED: _ClassVar[InboxNotificationStatus]
    INBOX_NOTIFICATION_STATUS_FAILED: _ClassVar[InboxNotificationStatus]
    INBOX_NOTIFICATION_STATUS_UNAVAILABLE: _ClassVar[InboxNotificationStatus]

class ApprovalKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    APPROVAL_KIND_UNSPECIFIED: _ClassVar[ApprovalKind]
    APPROVAL_KIND_SURFACE_ACTION: _ClassVar[ApprovalKind]

class ApprovalStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    APPROVAL_STATUS_UNSPECIFIED: _ClassVar[ApprovalStatus]
    APPROVAL_STATUS_PENDING: _ClassVar[ApprovalStatus]
    APPROVAL_STATUS_APPROVED: _ClassVar[ApprovalStatus]
    APPROVAL_STATUS_DENIED: _ClassVar[ApprovalStatus]
    APPROVAL_STATUS_EXPIRED: _ClassVar[ApprovalStatus]

class ApprovalScope(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    APPROVAL_SCOPE_UNSPECIFIED: _ClassVar[ApprovalScope]
    APPROVAL_SCOPE_ONCE: _ClassVar[ApprovalScope]
    APPROVAL_SCOPE_OBJECTIVE: _ClassVar[ApprovalScope]

class ApprovalDecider(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    APPROVAL_DECIDER_UNSPECIFIED: _ClassVar[ApprovalDecider]
    APPROVAL_DECIDER_OPERATOR: _ClassVar[ApprovalDecider]
    APPROVAL_DECIDER_TAG: _ClassVar[ApprovalDecider]

class ApprovalTarget(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    APPROVAL_TARGET_UNSPECIFIED: _ClassVar[ApprovalTarget]
    APPROVAL_TARGET_SURFACE: _ClassVar[ApprovalTarget]
    APPROVAL_TARGET_RUNTIME: _ClassVar[ApprovalTarget]
    APPROVAL_TARGET_MCP: _ClassVar[ApprovalTarget]
INBOX_ITEM_KIND_UNSPECIFIED: InboxItemKind
INBOX_ITEM_KIND_APPROVAL: InboxItemKind
INBOX_ITEM_KIND_QUESTION: InboxItemKind
INBOX_ITEM_KIND_OBJECTIVE_BUDGET: InboxItemKind
INBOX_ITEM_KIND_OBJECTIVE_LIMIT: InboxItemKind
INBOX_ITEM_KIND_TASK_ATTENTION: InboxItemKind
INBOX_ITEM_KIND_MCP_LOGIN: InboxItemKind
INBOX_NOTIFICATION_STATUS_UNSPECIFIED: InboxNotificationStatus
INBOX_NOTIFICATION_STATUS_NOT_CONFIGURED: InboxNotificationStatus
INBOX_NOTIFICATION_STATUS_PENDING: InboxNotificationStatus
INBOX_NOTIFICATION_STATUS_DELIVERING: InboxNotificationStatus
INBOX_NOTIFICATION_STATUS_DELIVERED: InboxNotificationStatus
INBOX_NOTIFICATION_STATUS_FAILED: InboxNotificationStatus
INBOX_NOTIFICATION_STATUS_UNAVAILABLE: InboxNotificationStatus
APPROVAL_KIND_UNSPECIFIED: ApprovalKind
APPROVAL_KIND_SURFACE_ACTION: ApprovalKind
APPROVAL_STATUS_UNSPECIFIED: ApprovalStatus
APPROVAL_STATUS_PENDING: ApprovalStatus
APPROVAL_STATUS_APPROVED: ApprovalStatus
APPROVAL_STATUS_DENIED: ApprovalStatus
APPROVAL_STATUS_EXPIRED: ApprovalStatus
APPROVAL_SCOPE_UNSPECIFIED: ApprovalScope
APPROVAL_SCOPE_ONCE: ApprovalScope
APPROVAL_SCOPE_OBJECTIVE: ApprovalScope
APPROVAL_DECIDER_UNSPECIFIED: ApprovalDecider
APPROVAL_DECIDER_OPERATOR: ApprovalDecider
APPROVAL_DECIDER_TAG: ApprovalDecider
APPROVAL_TARGET_UNSPECIFIED: ApprovalTarget
APPROVAL_TARGET_SURFACE: ApprovalTarget
APPROVAL_TARGET_RUNTIME: ApprovalTarget
APPROVAL_TARGET_MCP: ApprovalTarget

class ListInboxItemsRequest(_message.Message):
    __slots__ = ("objective_id", "kind", "next_actor_tag_id", "page_size", "page_token")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    NEXT_ACTOR_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    kind: InboxItemKind
    next_actor_tag_id: str
    page_size: int
    page_token: str
    def __init__(self, objective_id: _Optional[str] = ..., kind: _Optional[_Union[InboxItemKind, str]] = ..., next_actor_tag_id: _Optional[str] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListInboxItemsResponse(_message.Message):
    __slots__ = ("as_of", "items", "tag_names", "truncated_kinds", "next_page_token")
    class TagNamesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    AS_OF_FIELD_NUMBER: _ClassVar[int]
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    TAG_NAMES_FIELD_NUMBER: _ClassVar[int]
    TRUNCATED_KINDS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    as_of: _timestamp_pb2.Timestamp
    items: _containers.RepeatedCompositeFieldContainer[InboxItem]
    tag_names: _containers.ScalarMap[str, str]
    truncated_kinds: _containers.RepeatedScalarFieldContainer[InboxItemKind]
    next_page_token: str
    def __init__(self, as_of: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., items: _Optional[_Iterable[_Union[InboxItem, _Mapping]]] = ..., tag_names: _Optional[_Mapping[str, str]] = ..., truncated_kinds: _Optional[_Iterable[_Union[InboxItemKind, str]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class InboxItem(_message.Message):
    __slots__ = ("key", "occurrence", "kind", "reason", "objective_id", "next_actor_tag_ids", "excluded_actor_tag_ids", "operator_eligible", "actionable_since", "deadline", "evidence", "approval", "question", "uncertain_attempt", "commands", "notification")
    KEY_FIELD_NUMBER: _ClassVar[int]
    OCCURRENCE_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    NEXT_ACTOR_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    EXCLUDED_ACTOR_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    OPERATOR_ELIGIBLE_FIELD_NUMBER: _ClassVar[int]
    ACTIONABLE_SINCE_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_FIELD_NUMBER: _ClassVar[int]
    EVIDENCE_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_FIELD_NUMBER: _ClassVar[int]
    QUESTION_FIELD_NUMBER: _ClassVar[int]
    UNCERTAIN_ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    COMMANDS_FIELD_NUMBER: _ClassVar[int]
    NOTIFICATION_FIELD_NUMBER: _ClassVar[int]
    key: str
    occurrence: str
    kind: InboxItemKind
    reason: str
    objective_id: str
    next_actor_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    excluded_actor_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    operator_eligible: bool
    actionable_since: _timestamp_pb2.Timestamp
    deadline: _timestamp_pb2.Timestamp
    evidence: _containers.RepeatedCompositeFieldContainer[InboxEvidence]
    approval: InboxApproval
    question: InboxQuestion
    uncertain_attempt: UncertainAttempt
    commands: _containers.RepeatedScalarFieldContainer[str]
    notification: InboxNotification
    def __init__(self, key: _Optional[str] = ..., occurrence: _Optional[str] = ..., kind: _Optional[_Union[InboxItemKind, str]] = ..., reason: _Optional[str] = ..., objective_id: _Optional[str] = ..., next_actor_tag_ids: _Optional[_Iterable[str]] = ..., excluded_actor_tag_ids: _Optional[_Iterable[str]] = ..., operator_eligible: _Optional[bool] = ..., actionable_since: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., deadline: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., evidence: _Optional[_Iterable[_Union[InboxEvidence, _Mapping]]] = ..., approval: _Optional[_Union[InboxApproval, _Mapping]] = ..., question: _Optional[_Union[InboxQuestion, _Mapping]] = ..., uncertain_attempt: _Optional[_Union[UncertainAttempt, _Mapping]] = ..., commands: _Optional[_Iterable[str]] = ..., notification: _Optional[_Union[InboxNotification, _Mapping]] = ...) -> None: ...

class InboxEvidence(_message.Message):
    __slots__ = ("task", "objective", "approval_request_id")
    TASK_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    task: TaskEvidence
    objective: ObjectiveEvidence
    approval_request_id: str
    def __init__(self, task: _Optional[_Union[TaskEvidence, _Mapping]] = ..., objective: _Optional[_Union[ObjectiveEvidence, _Mapping]] = ..., approval_request_id: _Optional[str] = ...) -> None: ...

class TaskEvidence(_message.Message):
    __slots__ = ("id", "status", "attempt_count", "updated_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_COUNT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    status: _task_pb2.TaskStatus
    attempt_count: int
    updated_at: _timestamp_pb2.Timestamp
    def __init__(self, id: _Optional[str] = ..., status: _Optional[_Union[_task_pb2.TaskStatus, str]] = ..., attempt_count: _Optional[int] = ..., updated_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class ObjectiveEvidence(_message.Message):
    __slots__ = ("id", "revision")
    ID_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    id: str
    revision: int
    def __init__(self, id: _Optional[str] = ..., revision: _Optional[int] = ...) -> None: ...

class InboxApproval(_message.Message):
    __slots__ = ("request_id", "kind", "summary", "requesting_tag_id", "requesting_tag", "task_id", "blocking")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    REQUESTING_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    REQUESTING_TAG_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    BLOCKING_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    kind: ApprovalKind
    summary: str
    requesting_tag_id: str
    requesting_tag: str
    task_id: str
    blocking: bool
    def __init__(self, request_id: _Optional[str] = ..., kind: _Optional[_Union[ApprovalKind, str]] = ..., summary: _Optional[str] = ..., requesting_tag_id: _Optional[str] = ..., requesting_tag: _Optional[str] = ..., task_id: _Optional[str] = ..., blocking: _Optional[bool] = ...) -> None: ...

class InboxQuestion(_message.Message):
    __slots__ = ("text", "asked_at", "truncated")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    ASKED_AT_FIELD_NUMBER: _ClassVar[int]
    TRUNCATED_FIELD_NUMBER: _ClassVar[int]
    text: str
    asked_at: _timestamp_pb2.Timestamp
    truncated: bool
    def __init__(self, text: _Optional[str] = ..., asked_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., truncated: _Optional[bool] = ...) -> None: ...

class UncertainAttempt(_message.Message):
    __slots__ = ("attempt_id", "worker_host_id", "worker_id")
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    WORKER_HOST_ID_FIELD_NUMBER: _ClassVar[int]
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    attempt_id: str
    worker_host_id: str
    worker_id: str
    def __init__(self, attempt_id: _Optional[str] = ..., worker_host_id: _Optional[str] = ..., worker_id: _Optional[str] = ...) -> None: ...

class InboxNotification(_message.Message):
    __slots__ = ("status", "reason")
    STATUS_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    status: InboxNotificationStatus
    reason: str
    def __init__(self, status: _Optional[_Union[InboxNotificationStatus, str]] = ..., reason: _Optional[str] = ...) -> None: ...

class ListApprovalsRequest(_message.Message):
    __slots__ = ("objective_id", "status", "page_size", "page_token")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    status: ApprovalStatus
    page_size: int
    page_token: str
    def __init__(self, objective_id: _Optional[str] = ..., status: _Optional[_Union[ApprovalStatus, str]] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListApprovalsResponse(_message.Message):
    __slots__ = ("approvals", "next_page_token")
    APPROVALS_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    approvals: _containers.RepeatedCompositeFieldContainer[Approval]
    next_page_token: str
    def __init__(self, approvals: _Optional[_Iterable[_Union[Approval, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class ApproveRequest(_message.Message):
    __slots__ = ("id", "scope", "valid_until")
    ID_FIELD_NUMBER: _ClassVar[int]
    SCOPE_FIELD_NUMBER: _ClassVar[int]
    VALID_UNTIL_FIELD_NUMBER: _ClassVar[int]
    id: str
    scope: ApprovalScope
    valid_until: _timestamp_pb2.Timestamp
    def __init__(self, id: _Optional[str] = ..., scope: _Optional[_Union[ApprovalScope, str]] = ..., valid_until: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class DenyRequest(_message.Message):
    __slots__ = ("id", "reason")
    ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    id: str
    reason: str
    def __init__(self, id: _Optional[str] = ..., reason: _Optional[str] = ...) -> None: ...

class AnswerQuestionRequest(_message.Message):
    __slots__ = ("key", "text", "idempotency_key")
    KEY_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    IDEMPOTENCY_KEY_FIELD_NUMBER: _ClassVar[int]
    key: str
    text: str
    idempotency_key: str
    def __init__(self, key: _Optional[str] = ..., text: _Optional[str] = ..., idempotency_key: _Optional[str] = ...) -> None: ...

class ApprovalAction(_message.Message):
    __slots__ = ("target", "action", "surface_account_id", "scope", "resource", "provider", "tool_name")
    TARGET_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    SURFACE_ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    SCOPE_FIELD_NUMBER: _ClassVar[int]
    RESOURCE_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    TOOL_NAME_FIELD_NUMBER: _ClassVar[int]
    target: ApprovalTarget
    action: str
    surface_account_id: str
    scope: str
    resource: str
    provider: str
    tool_name: str
    def __init__(self, target: _Optional[_Union[ApprovalTarget, str]] = ..., action: _Optional[str] = ..., surface_account_id: _Optional[str] = ..., scope: _Optional[str] = ..., resource: _Optional[str] = ..., provider: _Optional[str] = ..., tool_name: _Optional[str] = ...) -> None: ...

class Approval(_message.Message):
    __slots__ = ("id", "objective_id", "task_id", "attempt_id", "requesting_tag_id", "kind", "actions", "arguments_digest", "summary", "rule_sources", "approvers", "status", "scope", "valid_until", "decided_by", "decided_by_kind", "decided_at", "reason", "consumed_at", "created_at", "updated_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    REQUESTING_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    ACTIONS_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_DIGEST_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    RULE_SOURCES_FIELD_NUMBER: _ClassVar[int]
    APPROVERS_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    SCOPE_FIELD_NUMBER: _ClassVar[int]
    VALID_UNTIL_FIELD_NUMBER: _ClassVar[int]
    DECIDED_BY_FIELD_NUMBER: _ClassVar[int]
    DECIDED_BY_KIND_FIELD_NUMBER: _ClassVar[int]
    DECIDED_AT_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    CONSUMED_AT_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    objective_id: str
    task_id: str
    attempt_id: str
    requesting_tag_id: str
    kind: ApprovalKind
    actions: _containers.RepeatedCompositeFieldContainer[ApprovalAction]
    arguments_digest: str
    summary: str
    rule_sources: _containers.RepeatedScalarFieldContainer[str]
    approvers: _containers.RepeatedScalarFieldContainer[str]
    status: ApprovalStatus
    scope: ApprovalScope
    valid_until: _timestamp_pb2.Timestamp
    decided_by: str
    decided_by_kind: ApprovalDecider
    decided_at: _timestamp_pb2.Timestamp
    reason: str
    consumed_at: _timestamp_pb2.Timestamp
    created_at: _timestamp_pb2.Timestamp
    updated_at: _timestamp_pb2.Timestamp
    def __init__(self, id: _Optional[str] = ..., objective_id: _Optional[str] = ..., task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., requesting_tag_id: _Optional[str] = ..., kind: _Optional[_Union[ApprovalKind, str]] = ..., actions: _Optional[_Iterable[_Union[ApprovalAction, _Mapping]]] = ..., arguments_digest: _Optional[str] = ..., summary: _Optional[str] = ..., rule_sources: _Optional[_Iterable[str]] = ..., approvers: _Optional[_Iterable[str]] = ..., status: _Optional[_Union[ApprovalStatus, str]] = ..., scope: _Optional[_Union[ApprovalScope, str]] = ..., valid_until: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., decided_by: _Optional[str] = ..., decided_by_kind: _Optional[_Union[ApprovalDecider, str]] = ..., decided_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., reason: _Optional[str] = ..., consumed_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., updated_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...
