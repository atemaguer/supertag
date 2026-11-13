from . import policy_pb2 as _policy_pb2
from . import github_workspaces_pb2 as _github_workspaces_pb2
from . import mcp_pb2 as _mcp_pb2
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
    WATCH_KIND_TASK: _ClassVar[WatchKind]
    WATCH_KIND_CONVERSATION_MESSAGE: _ClassVar[WatchKind]
    WATCH_KIND_OBJECTIVE: _ClassVar[WatchKind]
    WATCH_KIND_TEAM: _ClassVar[WatchKind]
    WATCH_KIND_WORKSTREAM_POST: _ClassVar[WatchKind]

class WatchReason(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WATCH_REASON_UNSPECIFIED: _ClassVar[WatchReason]
    WATCH_REASON_CREATED: _ClassVar[WatchReason]
    WATCH_REASON_CHANGED: _ClassVar[WatchReason]
    WATCH_REASON_DELETED: _ClassVar[WatchReason]

class InboxItemKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    INBOX_ITEM_KIND_UNSPECIFIED: _ClassVar[InboxItemKind]
    INBOX_ITEM_KIND_QUESTION: _ClassVar[InboxItemKind]
    INBOX_ITEM_KIND_OBJECTIVE_BUDGET: _ClassVar[InboxItemKind]
    INBOX_ITEM_KIND_OBJECTIVE_LIMIT: _ClassVar[InboxItemKind]
    INBOX_ITEM_KIND_TASK_ATTENTION: _ClassVar[InboxItemKind]
    INBOX_ITEM_KIND_APPROVAL: _ClassVar[InboxItemKind]

class ApprovalState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    APPROVAL_STATE_UNSPECIFIED: _ClassVar[ApprovalState]
    APPROVAL_STATE_PENDING: _ClassVar[ApprovalState]
    APPROVAL_STATE_APPROVED: _ClassVar[ApprovalState]
    APPROVAL_STATE_DENIED: _ClassVar[ApprovalState]
    APPROVAL_STATE_EXPIRED: _ClassVar[ApprovalState]

class ApprovalScope(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    APPROVAL_SCOPE_UNSPECIFIED: _ClassVar[ApprovalScope]
    APPROVAL_SCOPE_ONCE: _ClassVar[ApprovalScope]
    APPROVAL_SCOPE_OBJECTIVE: _ClassVar[ApprovalScope]

class TagMessageOrigin(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TAG_MESSAGE_ORIGIN_UNSPECIFIED: _ClassVar[TagMessageOrigin]
    TAG_MESSAGE_ORIGIN_DIRECT: _ClassVar[TagMessageOrigin]
    TAG_MESSAGE_ORIGIN_WORKSTREAM: _ClassVar[TagMessageOrigin]

class TagMessageState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TAG_MESSAGE_STATE_UNSPECIFIED: _ClassVar[TagMessageState]
    TAG_MESSAGE_STATE_PENDING: _ClassVar[TagMessageState]
    TAG_MESSAGE_STATE_HANDLED: _ClassVar[TagMessageState]
    TAG_MESSAGE_STATE_FAILED: _ClassVar[TagMessageState]

class CommitReviewDecision(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    COMMIT_REVIEW_DECISION_UNSPECIFIED: _ClassVar[CommitReviewDecision]
    COMMIT_REVIEW_DECISION_APPROVED: _ClassVar[CommitReviewDecision]
    COMMIT_REVIEW_DECISION_CHANGES_REQUESTED: _ClassVar[CommitReviewDecision]

class HostPhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    HOST_PHASE_UNSPECIFIED: _ClassVar[HostPhase]
    HOST_PHASE_PENDING: _ClassVar[HostPhase]
    HOST_PHASE_READY: _ClassVar[HostPhase]
    HOST_PHASE_BUSY: _ClassVar[HostPhase]
    HOST_PHASE_SUPPRESSED: _ClassVar[HostPhase]
    HOST_PHASE_OFFLINE: _ClassVar[HostPhase]
    HOST_PHASE_DRAINING: _ClassVar[HostPhase]
    HOST_PHASE_REVOKED: _ClassVar[HostPhase]

class HostReadiness(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    HOST_READINESS_UNSPECIFIED: _ClassVar[HostReadiness]
    HOST_READINESS_PENDING: _ClassVar[HostReadiness]
    HOST_READINESS_READY: _ClassVar[HostReadiness]
    HOST_READINESS_SUPPRESSED: _ClassVar[HostReadiness]

class HostReadinessReason(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    HOST_READINESS_REASON_UNSPECIFIED: _ClassVar[HostReadinessReason]
    HOST_READINESS_REASON_STARTING: _ClassVar[HostReadinessReason]
    HOST_READINESS_REASON_RECOVERY_REQUIRED: _ClassVar[HostReadinessReason]
    HOST_READINESS_REASON_STOPPING: _ClassVar[HostReadinessReason]

class WorkspaceGrepMode(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WORKSPACE_GREP_MODE_UNSPECIFIED: _ClassVar[WorkspaceGrepMode]
    WORKSPACE_GREP_MODE_CONTENT: _ClassVar[WorkspaceGrepMode]
    WORKSPACE_GREP_MODE_FILES_WITH_MATCHES: _ClassVar[WorkspaceGrepMode]
    WORKSPACE_GREP_MODE_COUNT: _ClassVar[WorkspaceGrepMode]

class LiveInputState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LIVE_INPUT_STATE_UNSPECIFIED: _ClassVar[LiveInputState]
    LIVE_INPUT_STATE_PENDING: _ClassVar[LiveInputState]
    LIVE_INPUT_STATE_DISPATCHING: _ClassVar[LiveInputState]
    LIVE_INPUT_STATE_ACCEPTED: _ClassVar[LiveInputState]
    LIVE_INPUT_STATE_REJECTED: _ClassVar[LiveInputState]
    LIVE_INPUT_STATE_UNKNOWN: _ClassVar[LiveInputState]
    LIVE_INPUT_STATE_WITHDRAWN: _ClassVar[LiveInputState]
    LIVE_INPUT_STATE_FAILED: _ClassVar[LiveInputState]
    LIVE_INPUT_STATE_RETRIED: _ClassVar[LiveInputState]

class LiveInputDecision(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LIVE_INPUT_DECISION_UNSPECIFIED: _ClassVar[LiveInputDecision]
    LIVE_INPUT_DECISION_FAIL: _ClassVar[LiveInputDecision]
    LIVE_INPUT_DECISION_RETRY: _ClassVar[LiveInputDecision]

class LiveInputReceipt(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LIVE_INPUT_RECEIPT_UNSPECIFIED: _ClassVar[LiveInputReceipt]
    LIVE_INPUT_RECEIPT_ACCEPTED: _ClassVar[LiveInputReceipt]
    LIVE_INPUT_RECEIPT_REJECTED: _ClassVar[LiveInputReceipt]
    LIVE_INPUT_RECEIPT_UNKNOWN: _ClassVar[LiveInputReceipt]
    LIVE_INPUT_RECEIPT_WITHDRAWN: _ClassVar[LiveInputReceipt]

class TaskState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TASK_STATE_UNSPECIFIED: _ClassVar[TaskState]
    TASK_STATE_QUEUED: _ClassVar[TaskState]
    TASK_STATE_RUNNING: _ClassVar[TaskState]
    TASK_STATE_SUCCEEDED: _ClassVar[TaskState]
    TASK_STATE_FAILED: _ClassVar[TaskState]
    TASK_STATE_CANCELLED: _ClassVar[TaskState]
    TASK_STATE_CLAIMED: _ClassVar[TaskState]
    TASK_STATE_UNCERTAIN: _ClassVar[TaskState]

class HarnessKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    HARNESS_KIND_UNSPECIFIED: _ClassVar[HarnessKind]
    HARNESS_KIND_CODEX: _ClassVar[HarnessKind]
    HARNESS_KIND_CLAUDE_CODE: _ClassVar[HarnessKind]
    HARNESS_KIND_OPENAI_AGENTS: _ClassVar[HarnessKind]
    HARNESS_KIND_OPENCODE: _ClassVar[HarnessKind]
    HARNESS_KIND_CURSOR: _ClassVar[HarnessKind]

class OutputGitMode(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OUTPUT_GIT_MODE_UNSPECIFIED: _ClassVar[OutputGitMode]
    OUTPUT_GIT_MODE_REFERENCE: _ClassVar[OutputGitMode]
    OUTPUT_GIT_MODE_CAPTURE: _ClassVar[OutputGitMode]
    OUTPUT_GIT_MODE_IGNORE: _ClassVar[OutputGitMode]

class SharedExecutionTool(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SHARED_EXECUTION_TOOL_UNSPECIFIED: _ClassVar[SharedExecutionTool]
    SHARED_EXECUTION_TOOL_READ: _ClassVar[SharedExecutionTool]
    SHARED_EXECUTION_TOOL_WRITE: _ClassVar[SharedExecutionTool]
    SHARED_EXECUTION_TOOL_COMMAND: _ClassVar[SharedExecutionTool]

class ModelSource(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    MODEL_SOURCE_UNSPECIFIED: _ClassVar[ModelSource]
    MODEL_SOURCE_TASK: _ClassVar[ModelSource]
    MODEL_SOURCE_HOST_DEFAULT: _ClassVar[ModelSource]
    MODEL_SOURCE_HARNESS_DEFAULT: _ClassVar[ModelSource]

class AttemptDecision(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ATTEMPT_DECISION_UNSPECIFIED: _ClassVar[AttemptDecision]
    ATTEMPT_DECISION_FAILED: _ClassVar[AttemptDecision]
    ATTEMPT_DECISION_RETRY: _ClassVar[AttemptDecision]

class ExecutionLimitEnforcement(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    EXECUTION_LIMIT_ENFORCEMENT_UNSPECIFIED: _ClassVar[ExecutionLimitEnforcement]
    EXECUTION_LIMIT_ENFORCEMENT_HARNESS_GUARD: _ClassVar[ExecutionLimitEnforcement]
    EXECUTION_LIMIT_ENFORCEMENT_INTERRUPT_ON_REPORT: _ClassVar[ExecutionLimitEnforcement]
    EXECUTION_LIMIT_ENFORCEMENT_PROVIDER_BUDGET: _ClassVar[ExecutionLimitEnforcement]

class WorkspaceArtifactKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WORKSPACE_ARTIFACT_KIND_UNSPECIFIED: _ClassVar[WorkspaceArtifactKind]
    WORKSPACE_ARTIFACT_KIND_PATCH: _ClassVar[WorkspaceArtifactKind]
    WORKSPACE_ARTIFACT_KIND_BUNDLE: _ClassVar[WorkspaceArtifactKind]

class ObjectiveStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OBJECTIVE_STATUS_UNSPECIFIED: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_WORKING: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_BLOCKED: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_LIMITED: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_READY_FOR_REVIEW: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_COMPLETED: _ClassVar[ObjectiveStatus]
    OBJECTIVE_STATUS_CANCELLED: _ClassVar[ObjectiveStatus]

class ObjectiveSignal(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OBJECTIVE_SIGNAL_PROGRESS: _ClassVar[ObjectiveSignal]
    OBJECTIVE_SIGNAL_READY_FOR_REVIEW: _ClassVar[ObjectiveSignal]
    OBJECTIVE_SIGNAL_COMPLETED: _ClassVar[ObjectiveSignal]
    OBJECTIVE_SIGNAL_BLOCKED: _ClassVar[ObjectiveSignal]

class GithubEventKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    GITHUB_EVENT_KIND_UNSPECIFIED: _ClassVar[GithubEventKind]
    GITHUB_EVENT_KIND_ISSUE_COMMENT: _ClassVar[GithubEventKind]
    GITHUB_EVENT_KIND_ISSUE: _ClassVar[GithubEventKind]
    GITHUB_EVENT_KIND_PULL_REQUEST: _ClassVar[GithubEventKind]

class GithubEventAction(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    GITHUB_EVENT_ACTION_UNSPECIFIED: _ClassVar[GithubEventAction]
    GITHUB_EVENT_ACTION_CREATED: _ClassVar[GithubEventAction]
    GITHUB_EVENT_ACTION_EDITED: _ClassVar[GithubEventAction]
    GITHUB_EVENT_ACTION_OPENED: _ClassVar[GithubEventAction]

class LinearEventKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LINEAR_EVENT_KIND_UNSPECIFIED: _ClassVar[LinearEventKind]
    LINEAR_EVENT_KIND_ISSUE: _ClassVar[LinearEventKind]
    LINEAR_EVENT_KIND_ISSUE_COMMENT: _ClassVar[LinearEventKind]

class LinearEventAction(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LINEAR_EVENT_ACTION_UNSPECIFIED: _ClassVar[LinearEventAction]
    LINEAR_EVENT_ACTION_CREATE: _ClassVar[LinearEventAction]
    LINEAR_EVENT_ACTION_UPDATE: _ClassVar[LinearEventAction]

class LarkDomain(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LARK_DOMAIN_UNSPECIFIED: _ClassVar[LarkDomain]
    LARK_DOMAIN_LARK: _ClassVar[LarkDomain]
    LARK_DOMAIN_FEISHU: _ClassVar[LarkDomain]

class ReplyState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    REPLY_STATE_UNSPECIFIED: _ClassVar[ReplyState]
    REPLY_STATE_PENDING: _ClassVar[ReplyState]
    REPLY_STATE_CLAIMED: _ClassVar[ReplyState]
    REPLY_STATE_DELIVERED: _ClassVar[ReplyState]
    REPLY_STATE_FAILED: _ClassVar[ReplyState]
    REPLY_STATE_UNCERTAIN: _ClassVar[ReplyState]
WATCH_KIND_UNSPECIFIED: WatchKind
WATCH_KIND_TAG: WatchKind
WATCH_KIND_TASK: WatchKind
WATCH_KIND_CONVERSATION_MESSAGE: WatchKind
WATCH_KIND_OBJECTIVE: WatchKind
WATCH_KIND_TEAM: WatchKind
WATCH_KIND_WORKSTREAM_POST: WatchKind
WATCH_REASON_UNSPECIFIED: WatchReason
WATCH_REASON_CREATED: WatchReason
WATCH_REASON_CHANGED: WatchReason
WATCH_REASON_DELETED: WatchReason
INBOX_ITEM_KIND_UNSPECIFIED: InboxItemKind
INBOX_ITEM_KIND_QUESTION: InboxItemKind
INBOX_ITEM_KIND_OBJECTIVE_BUDGET: InboxItemKind
INBOX_ITEM_KIND_OBJECTIVE_LIMIT: InboxItemKind
INBOX_ITEM_KIND_TASK_ATTENTION: InboxItemKind
INBOX_ITEM_KIND_APPROVAL: InboxItemKind
APPROVAL_STATE_UNSPECIFIED: ApprovalState
APPROVAL_STATE_PENDING: ApprovalState
APPROVAL_STATE_APPROVED: ApprovalState
APPROVAL_STATE_DENIED: ApprovalState
APPROVAL_STATE_EXPIRED: ApprovalState
APPROVAL_SCOPE_UNSPECIFIED: ApprovalScope
APPROVAL_SCOPE_ONCE: ApprovalScope
APPROVAL_SCOPE_OBJECTIVE: ApprovalScope
TAG_MESSAGE_ORIGIN_UNSPECIFIED: TagMessageOrigin
TAG_MESSAGE_ORIGIN_DIRECT: TagMessageOrigin
TAG_MESSAGE_ORIGIN_WORKSTREAM: TagMessageOrigin
TAG_MESSAGE_STATE_UNSPECIFIED: TagMessageState
TAG_MESSAGE_STATE_PENDING: TagMessageState
TAG_MESSAGE_STATE_HANDLED: TagMessageState
TAG_MESSAGE_STATE_FAILED: TagMessageState
COMMIT_REVIEW_DECISION_UNSPECIFIED: CommitReviewDecision
COMMIT_REVIEW_DECISION_APPROVED: CommitReviewDecision
COMMIT_REVIEW_DECISION_CHANGES_REQUESTED: CommitReviewDecision
HOST_PHASE_UNSPECIFIED: HostPhase
HOST_PHASE_PENDING: HostPhase
HOST_PHASE_READY: HostPhase
HOST_PHASE_BUSY: HostPhase
HOST_PHASE_SUPPRESSED: HostPhase
HOST_PHASE_OFFLINE: HostPhase
HOST_PHASE_DRAINING: HostPhase
HOST_PHASE_REVOKED: HostPhase
HOST_READINESS_UNSPECIFIED: HostReadiness
HOST_READINESS_PENDING: HostReadiness
HOST_READINESS_READY: HostReadiness
HOST_READINESS_SUPPRESSED: HostReadiness
HOST_READINESS_REASON_UNSPECIFIED: HostReadinessReason
HOST_READINESS_REASON_STARTING: HostReadinessReason
HOST_READINESS_REASON_RECOVERY_REQUIRED: HostReadinessReason
HOST_READINESS_REASON_STOPPING: HostReadinessReason
WORKSPACE_GREP_MODE_UNSPECIFIED: WorkspaceGrepMode
WORKSPACE_GREP_MODE_CONTENT: WorkspaceGrepMode
WORKSPACE_GREP_MODE_FILES_WITH_MATCHES: WorkspaceGrepMode
WORKSPACE_GREP_MODE_COUNT: WorkspaceGrepMode
LIVE_INPUT_STATE_UNSPECIFIED: LiveInputState
LIVE_INPUT_STATE_PENDING: LiveInputState
LIVE_INPUT_STATE_DISPATCHING: LiveInputState
LIVE_INPUT_STATE_ACCEPTED: LiveInputState
LIVE_INPUT_STATE_REJECTED: LiveInputState
LIVE_INPUT_STATE_UNKNOWN: LiveInputState
LIVE_INPUT_STATE_WITHDRAWN: LiveInputState
LIVE_INPUT_STATE_FAILED: LiveInputState
LIVE_INPUT_STATE_RETRIED: LiveInputState
LIVE_INPUT_DECISION_UNSPECIFIED: LiveInputDecision
LIVE_INPUT_DECISION_FAIL: LiveInputDecision
LIVE_INPUT_DECISION_RETRY: LiveInputDecision
LIVE_INPUT_RECEIPT_UNSPECIFIED: LiveInputReceipt
LIVE_INPUT_RECEIPT_ACCEPTED: LiveInputReceipt
LIVE_INPUT_RECEIPT_REJECTED: LiveInputReceipt
LIVE_INPUT_RECEIPT_UNKNOWN: LiveInputReceipt
LIVE_INPUT_RECEIPT_WITHDRAWN: LiveInputReceipt
TASK_STATE_UNSPECIFIED: TaskState
TASK_STATE_QUEUED: TaskState
TASK_STATE_RUNNING: TaskState
TASK_STATE_SUCCEEDED: TaskState
TASK_STATE_FAILED: TaskState
TASK_STATE_CANCELLED: TaskState
TASK_STATE_CLAIMED: TaskState
TASK_STATE_UNCERTAIN: TaskState
HARNESS_KIND_UNSPECIFIED: HarnessKind
HARNESS_KIND_CODEX: HarnessKind
HARNESS_KIND_CLAUDE_CODE: HarnessKind
HARNESS_KIND_OPENAI_AGENTS: HarnessKind
HARNESS_KIND_OPENCODE: HarnessKind
HARNESS_KIND_CURSOR: HarnessKind
OUTPUT_GIT_MODE_UNSPECIFIED: OutputGitMode
OUTPUT_GIT_MODE_REFERENCE: OutputGitMode
OUTPUT_GIT_MODE_CAPTURE: OutputGitMode
OUTPUT_GIT_MODE_IGNORE: OutputGitMode
SHARED_EXECUTION_TOOL_UNSPECIFIED: SharedExecutionTool
SHARED_EXECUTION_TOOL_READ: SharedExecutionTool
SHARED_EXECUTION_TOOL_WRITE: SharedExecutionTool
SHARED_EXECUTION_TOOL_COMMAND: SharedExecutionTool
MODEL_SOURCE_UNSPECIFIED: ModelSource
MODEL_SOURCE_TASK: ModelSource
MODEL_SOURCE_HOST_DEFAULT: ModelSource
MODEL_SOURCE_HARNESS_DEFAULT: ModelSource
ATTEMPT_DECISION_UNSPECIFIED: AttemptDecision
ATTEMPT_DECISION_FAILED: AttemptDecision
ATTEMPT_DECISION_RETRY: AttemptDecision
EXECUTION_LIMIT_ENFORCEMENT_UNSPECIFIED: ExecutionLimitEnforcement
EXECUTION_LIMIT_ENFORCEMENT_HARNESS_GUARD: ExecutionLimitEnforcement
EXECUTION_LIMIT_ENFORCEMENT_INTERRUPT_ON_REPORT: ExecutionLimitEnforcement
EXECUTION_LIMIT_ENFORCEMENT_PROVIDER_BUDGET: ExecutionLimitEnforcement
WORKSPACE_ARTIFACT_KIND_UNSPECIFIED: WorkspaceArtifactKind
WORKSPACE_ARTIFACT_KIND_PATCH: WorkspaceArtifactKind
WORKSPACE_ARTIFACT_KIND_BUNDLE: WorkspaceArtifactKind
OBJECTIVE_STATUS_UNSPECIFIED: ObjectiveStatus
OBJECTIVE_STATUS_WORKING: ObjectiveStatus
OBJECTIVE_STATUS_BLOCKED: ObjectiveStatus
OBJECTIVE_STATUS_LIMITED: ObjectiveStatus
OBJECTIVE_STATUS_READY_FOR_REVIEW: ObjectiveStatus
OBJECTIVE_STATUS_COMPLETED: ObjectiveStatus
OBJECTIVE_STATUS_CANCELLED: ObjectiveStatus
OBJECTIVE_SIGNAL_PROGRESS: ObjectiveSignal
OBJECTIVE_SIGNAL_READY_FOR_REVIEW: ObjectiveSignal
OBJECTIVE_SIGNAL_COMPLETED: ObjectiveSignal
OBJECTIVE_SIGNAL_BLOCKED: ObjectiveSignal
GITHUB_EVENT_KIND_UNSPECIFIED: GithubEventKind
GITHUB_EVENT_KIND_ISSUE_COMMENT: GithubEventKind
GITHUB_EVENT_KIND_ISSUE: GithubEventKind
GITHUB_EVENT_KIND_PULL_REQUEST: GithubEventKind
GITHUB_EVENT_ACTION_UNSPECIFIED: GithubEventAction
GITHUB_EVENT_ACTION_CREATED: GithubEventAction
GITHUB_EVENT_ACTION_EDITED: GithubEventAction
GITHUB_EVENT_ACTION_OPENED: GithubEventAction
LINEAR_EVENT_KIND_UNSPECIFIED: LinearEventKind
LINEAR_EVENT_KIND_ISSUE: LinearEventKind
LINEAR_EVENT_KIND_ISSUE_COMMENT: LinearEventKind
LINEAR_EVENT_ACTION_UNSPECIFIED: LinearEventAction
LINEAR_EVENT_ACTION_CREATE: LinearEventAction
LINEAR_EVENT_ACTION_UPDATE: LinearEventAction
LARK_DOMAIN_UNSPECIFIED: LarkDomain
LARK_DOMAIN_LARK: LarkDomain
LARK_DOMAIN_FEISHU: LarkDomain
REPLY_STATE_UNSPECIFIED: ReplyState
REPLY_STATE_PENDING: ReplyState
REPLY_STATE_CLAIMED: ReplyState
REPLY_STATE_DELIVERED: ReplyState
REPLY_STATE_FAILED: ReplyState
REPLY_STATE_UNCERTAIN: ReplyState

class ProvisionTagsRequest(_message.Message):
    __slots__ = ("tags",)
    TAGS_FIELD_NUMBER: _ClassVar[int]
    tags: _containers.RepeatedCompositeFieldContainer[ProvisionTag]
    def __init__(self, tags: _Optional[_Iterable[_Union[ProvisionTag, _Mapping]]] = ...) -> None: ...

class ProvisionTag(_message.Message):
    __slots__ = ("tag", "role_ids", "mailbox_senders")
    TAG_FIELD_NUMBER: _ClassVar[int]
    ROLE_IDS_FIELD_NUMBER: _ClassVar[int]
    MAILBOX_SENDERS_FIELD_NUMBER: _ClassVar[int]
    tag: PutTagRequest
    role_ids: _containers.RepeatedScalarFieldContainer[str]
    mailbox_senders: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, tag: _Optional[_Union[PutTagRequest, _Mapping]] = ..., role_ids: _Optional[_Iterable[str]] = ..., mailbox_senders: _Optional[_Iterable[str]] = ...) -> None: ...

class ProvisionTagsResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ReconcileTagRelationshipsRequest(_message.Message):
    __slots__ = ("tag_id", "manager", "role_ids", "mailbox_senders", "preview")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    MANAGER_FIELD_NUMBER: _ClassVar[int]
    ROLE_IDS_FIELD_NUMBER: _ClassVar[int]
    MAILBOX_SENDERS_FIELD_NUMBER: _ClassVar[int]
    PREVIEW_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    manager: str
    role_ids: _containers.RepeatedScalarFieldContainer[str]
    mailbox_senders: _containers.RepeatedScalarFieldContainer[str]
    preview: bool
    def __init__(self, tag_id: _Optional[str] = ..., manager: _Optional[str] = ..., role_ids: _Optional[_Iterable[str]] = ..., mailbox_senders: _Optional[_Iterable[str]] = ..., preview: _Optional[bool] = ...) -> None: ...

class ManifestRelationshipChange(_message.Message):
    __slots__ = ("path", "present", "ownership_only")
    PATH_FIELD_NUMBER: _ClassVar[int]
    PRESENT_FIELD_NUMBER: _ClassVar[int]
    OWNERSHIP_ONLY_FIELD_NUMBER: _ClassVar[int]
    path: str
    present: bool
    ownership_only: bool
    def __init__(self, path: _Optional[str] = ..., present: _Optional[bool] = ..., ownership_only: _Optional[bool] = ...) -> None: ...

class ReconcileTagRelationshipsResponse(_message.Message):
    __slots__ = ("changes",)
    CHANGES_FIELD_NUMBER: _ClassVar[int]
    changes: _containers.RepeatedCompositeFieldContainer[ManifestRelationshipChange]
    def __init__(self, changes: _Optional[_Iterable[_Union[ManifestRelationshipChange, _Mapping]]] = ...) -> None: ...

class WatchRequest(_message.Message):
    __slots__ = ("resume_token", "kinds")
    RESUME_TOKEN_FIELD_NUMBER: _ClassVar[int]
    KINDS_FIELD_NUMBER: _ClassVar[int]
    resume_token: str
    kinds: _containers.RepeatedScalarFieldContainer[WatchKind]
    def __init__(self, resume_token: _Optional[str] = ..., kinds: _Optional[_Iterable[_Union[WatchKind, str]]] = ...) -> None: ...

class WatchEvent(_message.Message):
    __slots__ = ("resume_token", "heartbeat", "resync", "change")
    RESUME_TOKEN_FIELD_NUMBER: _ClassVar[int]
    HEARTBEAT_FIELD_NUMBER: _ClassVar[int]
    RESYNC_FIELD_NUMBER: _ClassVar[int]
    CHANGE_FIELD_NUMBER: _ClassVar[int]
    resume_token: str
    heartbeat: WatchHeartbeat
    resync: WatchResync
    change: WatchChange
    def __init__(self, resume_token: _Optional[str] = ..., heartbeat: _Optional[_Union[WatchHeartbeat, _Mapping]] = ..., resync: _Optional[_Union[WatchResync, _Mapping]] = ..., change: _Optional[_Union[WatchChange, _Mapping]] = ...) -> None: ...

class WatchHeartbeat(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class WatchResync(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class WatchChange(_message.Message):
    __slots__ = ("kind", "id", "tag_id", "session_id", "objective_id", "team_id", "conversation", "changed_at_ms", "reason")
    KIND_FIELD_NUMBER: _ClassVar[int]
    ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_FIELD_NUMBER: _ClassVar[int]
    CHANGED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    kind: WatchKind
    id: str
    tag_id: str
    session_id: str
    objective_id: str
    team_id: str
    conversation: str
    changed_at_ms: int
    reason: WatchReason
    def __init__(self, kind: _Optional[_Union[WatchKind, str]] = ..., id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., team_id: _Optional[str] = ..., conversation: _Optional[str] = ..., changed_at_ms: _Optional[int] = ..., reason: _Optional[_Union[WatchReason, str]] = ...) -> None: ...

class ListInboxItemsRequest(_message.Message):
    __slots__ = ("objective_id", "kind", "page_size", "cursor")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    kind: InboxItemKind
    page_size: int
    cursor: str
    def __init__(self, objective_id: _Optional[str] = ..., kind: _Optional[_Union[InboxItemKind, str]] = ..., page_size: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListInboxItemsResponse(_message.Message):
    __slots__ = ("as_of_ms", "items", "next_cursor", "truncated_kinds")
    AS_OF_MS_FIELD_NUMBER: _ClassVar[int]
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    TRUNCATED_KINDS_FIELD_NUMBER: _ClassVar[int]
    as_of_ms: int
    items: _containers.RepeatedCompositeFieldContainer[InboxItem]
    next_cursor: str
    truncated_kinds: _containers.RepeatedScalarFieldContainer[InboxItemKind]
    def __init__(self, as_of_ms: _Optional[int] = ..., items: _Optional[_Iterable[_Union[InboxItem, _Mapping]]] = ..., next_cursor: _Optional[str] = ..., truncated_kinds: _Optional[_Iterable[_Union[InboxItemKind, str]]] = ...) -> None: ...

class InboxItem(_message.Message):
    __slots__ = ("key", "occurrence", "kind", "objective_id", "task_id", "attempt_id", "operator_eligible", "actionable_since_ms", "reason", "question", "approval")
    KEY_FIELD_NUMBER: _ClassVar[int]
    OCCURRENCE_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATOR_ELIGIBLE_FIELD_NUMBER: _ClassVar[int]
    ACTIONABLE_SINCE_MS_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    QUESTION_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_FIELD_NUMBER: _ClassVar[int]
    key: str
    occurrence: str
    kind: InboxItemKind
    objective_id: str
    task_id: str
    attempt_id: str
    operator_eligible: bool
    actionable_since_ms: int
    reason: str
    question: InboxQuestion
    approval: InboxApproval
    def __init__(self, key: _Optional[str] = ..., occurrence: _Optional[str] = ..., kind: _Optional[_Union[InboxItemKind, str]] = ..., objective_id: _Optional[str] = ..., task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., operator_eligible: _Optional[bool] = ..., actionable_since_ms: _Optional[int] = ..., reason: _Optional[str] = ..., question: _Optional[_Union[InboxQuestion, _Mapping]] = ..., approval: _Optional[_Union[InboxApproval, _Mapping]] = ...) -> None: ...

class InboxApproval(_message.Message):
    __slots__ = ("approval_id", "tag_id", "action", "resource", "summary")
    APPROVAL_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    RESOURCE_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    approval_id: str
    tag_id: str
    action: str
    resource: str
    summary: str
    def __init__(self, approval_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., action: _Optional[str] = ..., resource: _Optional[str] = ..., summary: _Optional[str] = ...) -> None: ...

class ApprovalRule(_message.Message):
    __slots__ = ("action", "operator_ids")
    ACTION_FIELD_NUMBER: _ClassVar[int]
    OPERATOR_IDS_FIELD_NUMBER: _ClassVar[int]
    action: str
    operator_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, action: _Optional[str] = ..., operator_ids: _Optional[_Iterable[str]] = ...) -> None: ...

class Approval(_message.Message):
    __slots__ = ("approval_id", "task_id", "attempt_id", "tag_id", "session_id", "objective_id", "action", "arguments_digest", "summary", "operator_ids", "state", "scope", "requested_at_ms", "decided_at_ms", "decided_by", "reason", "valid_until_ms", "consumed_at_ms", "continuation_task_id", "resource", "canonical_arguments_json", "grant_approval_id", "covered_at_ms")
    APPROVAL_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_DIGEST_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    OPERATOR_IDS_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    SCOPE_FIELD_NUMBER: _ClassVar[int]
    REQUESTED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    DECIDED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    DECIDED_BY_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    VALID_UNTIL_MS_FIELD_NUMBER: _ClassVar[int]
    CONSUMED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    CONTINUATION_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    RESOURCE_FIELD_NUMBER: _ClassVar[int]
    CANONICAL_ARGUMENTS_JSON_FIELD_NUMBER: _ClassVar[int]
    GRANT_APPROVAL_ID_FIELD_NUMBER: _ClassVar[int]
    COVERED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    approval_id: str
    task_id: str
    attempt_id: str
    tag_id: str
    session_id: str
    objective_id: str
    action: str
    arguments_digest: str
    summary: str
    operator_ids: _containers.RepeatedScalarFieldContainer[str]
    state: ApprovalState
    scope: ApprovalScope
    requested_at_ms: int
    decided_at_ms: int
    decided_by: str
    reason: str
    valid_until_ms: int
    consumed_at_ms: int
    continuation_task_id: str
    resource: str
    canonical_arguments_json: str
    grant_approval_id: str
    covered_at_ms: int
    def __init__(self, approval_id: _Optional[str] = ..., task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., action: _Optional[str] = ..., arguments_digest: _Optional[str] = ..., summary: _Optional[str] = ..., operator_ids: _Optional[_Iterable[str]] = ..., state: _Optional[_Union[ApprovalState, str]] = ..., scope: _Optional[_Union[ApprovalScope, str]] = ..., requested_at_ms: _Optional[int] = ..., decided_at_ms: _Optional[int] = ..., decided_by: _Optional[str] = ..., reason: _Optional[str] = ..., valid_until_ms: _Optional[int] = ..., consumed_at_ms: _Optional[int] = ..., continuation_task_id: _Optional[str] = ..., resource: _Optional[str] = ..., canonical_arguments_json: _Optional[str] = ..., grant_approval_id: _Optional[str] = ..., covered_at_ms: _Optional[int] = ...) -> None: ...

class GetApprovalRequest(_message.Message):
    __slots__ = ("approval_id",)
    APPROVAL_ID_FIELD_NUMBER: _ClassVar[int]
    approval_id: str
    def __init__(self, approval_id: _Optional[str] = ...) -> None: ...

class ListApprovalsRequest(_message.Message):
    __slots__ = ("objective_id", "task_id", "state", "limit", "cursor")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    task_id: str
    state: ApprovalState
    limit: int
    cursor: str
    def __init__(self, objective_id: _Optional[str] = ..., task_id: _Optional[str] = ..., state: _Optional[_Union[ApprovalState, str]] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListApprovalsResponse(_message.Message):
    __slots__ = ("approvals", "next_cursor")
    APPROVALS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    approvals: _containers.RepeatedCompositeFieldContainer[Approval]
    next_cursor: str
    def __init__(self, approvals: _Optional[_Iterable[_Union[Approval, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class DecideApprovalRequest(_message.Message):
    __slots__ = ("approval_id", "operation_id", "approve", "scope", "valid_until_ms", "reason")
    APPROVAL_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    APPROVE_FIELD_NUMBER: _ClassVar[int]
    SCOPE_FIELD_NUMBER: _ClassVar[int]
    VALID_UNTIL_MS_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    approval_id: str
    operation_id: str
    approve: bool
    scope: ApprovalScope
    valid_until_ms: int
    reason: str
    def __init__(self, approval_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., approve: _Optional[bool] = ..., scope: _Optional[_Union[ApprovalScope, str]] = ..., valid_until_ms: _Optional[int] = ..., reason: _Optional[str] = ...) -> None: ...

class RequestApprovalRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "action", "arguments_json", "summary", "resource")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_JSON_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    RESOURCE_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    operation_id: str
    action: str
    arguments_json: str
    summary: str
    resource: str
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., action: _Optional[str] = ..., arguments_json: _Optional[str] = ..., summary: _Optional[str] = ..., resource: _Optional[str] = ...) -> None: ...

class RequestApprovalResponse(_message.Message):
    __slots__ = ("approval", "granted")
    APPROVAL_FIELD_NUMBER: _ClassVar[int]
    GRANTED_FIELD_NUMBER: _ClassVar[int]
    approval: Approval
    granted: bool
    def __init__(self, approval: _Optional[_Union[Approval, _Mapping]] = ..., granted: _Optional[bool] = ...) -> None: ...

class InboxQuestion(_message.Message):
    __slots__ = ("text", "asked_at_ms", "truncated")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    ASKED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    TRUNCATED_FIELD_NUMBER: _ClassVar[int]
    text: str
    asked_at_ms: int
    truncated: bool
    def __init__(self, text: _Optional[str] = ..., asked_at_ms: _Optional[int] = ..., truncated: _Optional[bool] = ...) -> None: ...

class GetQuestionRequest(_message.Message):
    __slots__ = ("task_id",)
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    def __init__(self, task_id: _Optional[str] = ...) -> None: ...

class AnswerQuestionRequest(_message.Message):
    __slots__ = ("task_id", "operation_id", "text")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    operation_id: str
    text: str
    def __init__(self, task_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., text: _Optional[str] = ...) -> None: ...

class ObjectiveQuestion(_message.Message):
    __slots__ = ("task_id", "attempt_id", "objective_id", "text", "asked_at_ms", "published_at_ms", "answer_task_id")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    ASKED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    PUBLISHED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    ANSWER_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    objective_id: str
    text: str
    asked_at_ms: int
    published_at_ms: int
    answer_task_id: str
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., text: _Optional[str] = ..., asked_at_ms: _Optional[int] = ..., published_at_ms: _Optional[int] = ..., answer_task_id: _Optional[str] = ...) -> None: ...

class AskQuestionRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "text")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    operation_id: str
    text: str
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., text: _Optional[str] = ...) -> None: ...

class AttemptCapabilities(_message.Message):
    __slots__ = ("may_ask_objective_question", "may_use_workstream", "may_read_mailbox", "may_send_tag_message", "may_start_work_session", "may_continue_work_session", "may_ask_work_session_question", "may_request_commit_review")
    MAY_ASK_OBJECTIVE_QUESTION_FIELD_NUMBER: _ClassVar[int]
    MAY_USE_WORKSTREAM_FIELD_NUMBER: _ClassVar[int]
    MAY_READ_MAILBOX_FIELD_NUMBER: _ClassVar[int]
    MAY_SEND_TAG_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    MAY_START_WORK_SESSION_FIELD_NUMBER: _ClassVar[int]
    MAY_CONTINUE_WORK_SESSION_FIELD_NUMBER: _ClassVar[int]
    MAY_ASK_WORK_SESSION_QUESTION_FIELD_NUMBER: _ClassVar[int]
    MAY_REQUEST_COMMIT_REVIEW_FIELD_NUMBER: _ClassVar[int]
    may_ask_objective_question: bool
    may_use_workstream: bool
    may_read_mailbox: bool
    may_send_tag_message: bool
    may_start_work_session: bool
    may_continue_work_session: bool
    may_ask_work_session_question: bool
    may_request_commit_review: bool
    def __init__(self, may_ask_objective_question: _Optional[bool] = ..., may_use_workstream: _Optional[bool] = ..., may_read_mailbox: _Optional[bool] = ..., may_send_tag_message: _Optional[bool] = ..., may_start_work_session: _Optional[bool] = ..., may_continue_work_session: _Optional[bool] = ..., may_ask_work_session_question: _Optional[bool] = ..., may_request_commit_review: _Optional[bool] = ...) -> None: ...

class WorkSession(_message.Message):
    __slots__ = ("work_session_id", "title", "parent_tag_id", "parent_session_id", "starter_task_id", "tag_id", "latest_task_id", "latest_task_state", "report_task_id", "report_task_state", "objective_id", "workspace_delivery", "created_order", "question")
    WORK_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    PARENT_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    PARENT_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    STARTER_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    LATEST_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    LATEST_TASK_STATE_FIELD_NUMBER: _ClassVar[int]
    REPORT_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    REPORT_TASK_STATE_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_DELIVERY_FIELD_NUMBER: _ClassVar[int]
    CREATED_ORDER_FIELD_NUMBER: _ClassVar[int]
    QUESTION_FIELD_NUMBER: _ClassVar[int]
    work_session_id: str
    title: str
    parent_tag_id: str
    parent_session_id: str
    starter_task_id: str
    tag_id: str
    latest_task_id: str
    latest_task_state: TaskState
    report_task_id: str
    report_task_state: TaskState
    objective_id: str
    workspace_delivery: WorkspaceDeliveryReference
    created_order: int
    question: WorkSessionQuestion
    def __init__(self, work_session_id: _Optional[str] = ..., title: _Optional[str] = ..., parent_tag_id: _Optional[str] = ..., parent_session_id: _Optional[str] = ..., starter_task_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., latest_task_id: _Optional[str] = ..., latest_task_state: _Optional[_Union[TaskState, str]] = ..., report_task_id: _Optional[str] = ..., report_task_state: _Optional[_Union[TaskState, str]] = ..., objective_id: _Optional[str] = ..., workspace_delivery: _Optional[_Union[WorkspaceDeliveryReference, _Mapping]] = ..., created_order: _Optional[int] = ..., question: _Optional[_Union[WorkSessionQuestion, _Mapping]] = ...) -> None: ...

class WorkSessionQuestion(_message.Message):
    __slots__ = ("work_session_id", "task_id", "attempt_id", "text", "asked_at_ms", "published_at_ms", "answer_task_id")
    WORK_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    ASKED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    PUBLISHED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    ANSWER_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    work_session_id: str
    task_id: str
    attempt_id: str
    text: str
    asked_at_ms: int
    published_at_ms: int
    answer_task_id: str
    def __init__(self, work_session_id: _Optional[str] = ..., task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., text: _Optional[str] = ..., asked_at_ms: _Optional[int] = ..., published_at_ms: _Optional[int] = ..., answer_task_id: _Optional[str] = ...) -> None: ...

class StartWorkSessionRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "title", "instruction", "workspace_id", "target_tag_id")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTION_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    TARGET_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    operation_id: str
    title: str
    instruction: str
    workspace_id: str
    target_tag_id: str
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., title: _Optional[str] = ..., instruction: _Optional[str] = ..., workspace_id: _Optional[str] = ..., target_tag_id: _Optional[str] = ...) -> None: ...

class GetWorkSessionRequest(_message.Message):
    __slots__ = ("work_session_id", "report_task_id")
    WORK_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    REPORT_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    work_session_id: str
    report_task_id: str
    def __init__(self, work_session_id: _Optional[str] = ..., report_task_id: _Optional[str] = ...) -> None: ...

class ContinueWorkSessionRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "work_session_id", "message")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    WORK_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    operation_id: str
    work_session_id: str
    message: str
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., work_session_id: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class AskWorkSessionQuestionRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "text")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    operation_id: str
    text: str
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., text: _Optional[str] = ...) -> None: ...

class ListWorkSessionsRequest(_message.Message):
    __slots__ = ("parent_tag_id", "parent_session_id", "starter_task_id", "limit", "cursor")
    PARENT_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    PARENT_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    STARTER_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    parent_tag_id: str
    parent_session_id: str
    starter_task_id: str
    limit: int
    cursor: str
    def __init__(self, parent_tag_id: _Optional[str] = ..., parent_session_id: _Optional[str] = ..., starter_task_id: _Optional[str] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListWorkSessionsResponse(_message.Message):
    __slots__ = ("work_sessions", "next_cursor")
    WORK_SESSIONS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    work_sessions: _containers.RepeatedCompositeFieldContainer[WorkSession]
    next_cursor: str
    def __init__(self, work_sessions: _Optional[_Iterable[_Union[WorkSession, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class TagMessage(_message.Message):
    __slots__ = ("message_id", "sender_tag_id", "recipient_tag_id", "source_task_id", "workstream_post_id", "objective_id", "text", "hops", "task_id", "state", "created_at_ms", "origin", "review")
    MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    SENDER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    RECIPIENT_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSTREAM_POST_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    HOPS_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    ORIGIN_FIELD_NUMBER: _ClassVar[int]
    REVIEW_FIELD_NUMBER: _ClassVar[int]
    message_id: str
    sender_tag_id: str
    recipient_tag_id: str
    source_task_id: str
    workstream_post_id: str
    objective_id: str
    text: str
    hops: int
    task_id: str
    state: TagMessageState
    created_at_ms: int
    origin: TagMessageOrigin
    review: CommitReview
    def __init__(self, message_id: _Optional[str] = ..., sender_tag_id: _Optional[str] = ..., recipient_tag_id: _Optional[str] = ..., source_task_id: _Optional[str] = ..., workstream_post_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., text: _Optional[str] = ..., hops: _Optional[int] = ..., task_id: _Optional[str] = ..., state: _Optional[_Union[TagMessageState, str]] = ..., created_at_ms: _Optional[int] = ..., origin: _Optional[_Union[TagMessageOrigin, str]] = ..., review: _Optional[_Union[CommitReview, _Mapping]] = ...) -> None: ...

class CommitReviewSubmission(_message.Message):
    __slots__ = ("commit", "response")
    COMMIT_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_FIELD_NUMBER: _ClassVar[int]
    commit: str
    response: CommitReviewResponse
    def __init__(self, commit: _Optional[str] = ..., response: _Optional[_Union[CommitReviewResponse, _Mapping]] = ...) -> None: ...

class CommitReviewResponse(_message.Message):
    __slots__ = ("request_id", "verdict")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    VERDICT_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    verdict: CommitReviewDecision
    def __init__(self, request_id: _Optional[str] = ..., verdict: _Optional[_Union[CommitReviewDecision, str]] = ...) -> None: ...

class CommitReviewVerdict(_message.Message):
    __slots__ = ("decision", "summary", "task_id", "recorded_at_ms")
    DECISION_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    RECORDED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    decision: CommitReviewDecision
    summary: str
    task_id: str
    recorded_at_ms: int
    def __init__(self, decision: _Optional[_Union[CommitReviewDecision, str]] = ..., summary: _Optional[str] = ..., task_id: _Optional[str] = ..., recorded_at_ms: _Optional[int] = ...) -> None: ...

class CommitReview(_message.Message):
    __slots__ = ("request_id", "objective_id", "commit", "workspace_id", "source_task_id", "requester_tag_id", "reviewer_tag_id", "requested_at_ms", "verdict")
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    COMMIT_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    REQUESTER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    REVIEWER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    REQUESTED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    VERDICT_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    objective_id: str
    commit: str
    workspace_id: str
    source_task_id: str
    requester_tag_id: str
    reviewer_tag_id: str
    requested_at_ms: int
    verdict: CommitReviewVerdict
    def __init__(self, request_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., commit: _Optional[str] = ..., workspace_id: _Optional[str] = ..., source_task_id: _Optional[str] = ..., requester_tag_id: _Optional[str] = ..., reviewer_tag_id: _Optional[str] = ..., requested_at_ms: _Optional[int] = ..., verdict: _Optional[_Union[CommitReviewVerdict, _Mapping]] = ...) -> None: ...

class SendAttemptTagMessageRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "recipient_tag_id", "text", "review")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    RECIPIENT_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    REVIEW_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    operation_id: str
    recipient_tag_id: str
    text: str
    review: CommitReviewSubmission
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., recipient_tag_id: _Optional[str] = ..., text: _Optional[str] = ..., review: _Optional[_Union[CommitReviewSubmission, _Mapping]] = ...) -> None: ...

class SendTagMessageResponse(_message.Message):
    __slots__ = ("message", "duplicate", "approval", "review")
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    DUPLICATE_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_FIELD_NUMBER: _ClassVar[int]
    REVIEW_FIELD_NUMBER: _ClassVar[int]
    message: TagMessage
    duplicate: bool
    approval: Approval
    review: CommitReview
    def __init__(self, message: _Optional[_Union[TagMessage, _Mapping]] = ..., duplicate: _Optional[bool] = ..., approval: _Optional[_Union[Approval, _Mapping]] = ..., review: _Optional[_Union[CommitReview, _Mapping]] = ...) -> None: ...

class ChangeMailboxGrantRequest(_message.Message):
    __slots__ = ("operation_id", "sender_tag_id", "recipient_tag_id", "granted")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    SENDER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    RECIPIENT_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    GRANTED_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    sender_tag_id: str
    recipient_tag_id: str
    granted: bool
    def __init__(self, operation_id: _Optional[str] = ..., sender_tag_id: _Optional[str] = ..., recipient_tag_id: _Optional[str] = ..., granted: _Optional[bool] = ...) -> None: ...

class ChangeMailboxGrantResponse(_message.Message):
    __slots__ = ("changed",)
    CHANGED_FIELD_NUMBER: _ClassVar[int]
    changed: bool
    def __init__(self, changed: _Optional[bool] = ...) -> None: ...

class ListMailboxGrantsRequest(_message.Message):
    __slots__ = ("tag_id", "limit", "cursor")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    limit: int
    cursor: str
    def __init__(self, tag_id: _Optional[str] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class MailboxGrant(_message.Message):
    __slots__ = ("sender_tag_id", "recipient_tag_id", "granted_by", "granted_at_ms")
    SENDER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    RECIPIENT_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    GRANTED_BY_FIELD_NUMBER: _ClassVar[int]
    GRANTED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    sender_tag_id: str
    recipient_tag_id: str
    granted_by: str
    granted_at_ms: int
    def __init__(self, sender_tag_id: _Optional[str] = ..., recipient_tag_id: _Optional[str] = ..., granted_by: _Optional[str] = ..., granted_at_ms: _Optional[int] = ...) -> None: ...

class ListMailboxGrantsResponse(_message.Message):
    __slots__ = ("grants", "next_cursor")
    GRANTS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    grants: _containers.RepeatedCompositeFieldContainer[MailboxGrant]
    next_cursor: str
    def __init__(self, grants: _Optional[_Iterable[_Union[MailboxGrant, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class ListMailboxMessagesRequest(_message.Message):
    __slots__ = ("tag_id", "limit", "cursor")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    limit: int
    cursor: str
    def __init__(self, tag_id: _Optional[str] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListMailboxMessagesResponse(_message.Message):
    __slots__ = ("messages", "next_cursor")
    MESSAGES_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    messages: _containers.RepeatedCompositeFieldContainer[TagMessage]
    next_cursor: str
    def __init__(self, messages: _Optional[_Iterable[_Union[TagMessage, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class ReadMailboxRequest(_message.Message):
    __slots__ = ("attempt", "limit", "cursor")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    limit: int
    cursor: str
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ReportHostRequest(_message.Message):
    __slots__ = ("sequence", "capacity", "available_slots", "readiness", "reason", "harness_kind", "workspace_ids", "execution_profile")
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    CAPACITY_FIELD_NUMBER: _ClassVar[int]
    AVAILABLE_SLOTS_FIELD_NUMBER: _ClassVar[int]
    READINESS_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    HARNESS_KIND_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_IDS_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_PROFILE_FIELD_NUMBER: _ClassVar[int]
    sequence: int
    capacity: int
    available_slots: int
    readiness: HostReadiness
    reason: HostReadinessReason
    harness_kind: HarnessKind
    workspace_ids: _containers.RepeatedScalarFieldContainer[str]
    execution_profile: HarnessExecutionProfile
    def __init__(self, sequence: _Optional[int] = ..., capacity: _Optional[int] = ..., available_slots: _Optional[int] = ..., readiness: _Optional[_Union[HostReadiness, str]] = ..., reason: _Optional[_Union[HostReadinessReason, str]] = ..., harness_kind: _Optional[_Union[HarnessKind, str]] = ..., workspace_ids: _Optional[_Iterable[str]] = ..., execution_profile: _Optional[_Union[HarnessExecutionProfile, _Mapping]] = ...) -> None: ...

class WorkerHostStatus(_message.Message):
    __slots__ = ("host_id", "generation", "phase", "draining", "capacity", "available_slots", "active_attempts", "reason", "harness_kind", "workspace_ids", "enrolled_at_ms", "last_seen_at_ms", "presence_expires_at_ms", "revoked_at_ms", "execution_profile")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    DRAINING_FIELD_NUMBER: _ClassVar[int]
    CAPACITY_FIELD_NUMBER: _ClassVar[int]
    AVAILABLE_SLOTS_FIELD_NUMBER: _ClassVar[int]
    ACTIVE_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    HARNESS_KIND_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_IDS_FIELD_NUMBER: _ClassVar[int]
    ENROLLED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    LAST_SEEN_AT_MS_FIELD_NUMBER: _ClassVar[int]
    PRESENCE_EXPIRES_AT_MS_FIELD_NUMBER: _ClassVar[int]
    REVOKED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_PROFILE_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    generation: int
    phase: HostPhase
    draining: bool
    capacity: int
    available_slots: int
    active_attempts: int
    reason: HostReadinessReason
    harness_kind: HarnessKind
    workspace_ids: _containers.RepeatedScalarFieldContainer[str]
    enrolled_at_ms: int
    last_seen_at_ms: int
    presence_expires_at_ms: int
    revoked_at_ms: int
    execution_profile: HarnessExecutionProfile
    def __init__(self, host_id: _Optional[str] = ..., generation: _Optional[int] = ..., phase: _Optional[_Union[HostPhase, str]] = ..., draining: _Optional[bool] = ..., capacity: _Optional[int] = ..., available_slots: _Optional[int] = ..., active_attempts: _Optional[int] = ..., reason: _Optional[_Union[HostReadinessReason, str]] = ..., harness_kind: _Optional[_Union[HarnessKind, str]] = ..., workspace_ids: _Optional[_Iterable[str]] = ..., enrolled_at_ms: _Optional[int] = ..., last_seen_at_ms: _Optional[int] = ..., presence_expires_at_ms: _Optional[int] = ..., revoked_at_ms: _Optional[int] = ..., execution_profile: _Optional[_Union[HarnessExecutionProfile, _Mapping]] = ...) -> None: ...

class ListHostsRequest(_message.Message):
    __slots__ = ("limit", "cursor")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    limit: int
    cursor: str
    def __init__(self, limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListHostsResponse(_message.Message):
    __slots__ = ("hosts", "next_cursor")
    HOSTS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    hosts: _containers.RepeatedCompositeFieldContainer[WorkerHostStatus]
    next_cursor: str
    def __init__(self, hosts: _Optional[_Iterable[_Union[WorkerHostStatus, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class GetHostRequest(_message.Message):
    __slots__ = ("host_id",)
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    def __init__(self, host_id: _Optional[str] = ...) -> None: ...

class SetHostDrainingRequest(_message.Message):
    __slots__ = ("host_id", "draining")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    DRAINING_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    draining: bool
    def __init__(self, host_id: _Optional[str] = ..., draining: _Optional[bool] = ...) -> None: ...

class HarnessWorkspaceRequest(_message.Message):
    __slots__ = ("read", "write", "edit", "glob", "grep", "list", "command")
    READ_FIELD_NUMBER: _ClassVar[int]
    WRITE_FIELD_NUMBER: _ClassVar[int]
    EDIT_FIELD_NUMBER: _ClassVar[int]
    GLOB_FIELD_NUMBER: _ClassVar[int]
    GREP_FIELD_NUMBER: _ClassVar[int]
    LIST_FIELD_NUMBER: _ClassVar[int]
    COMMAND_FIELD_NUMBER: _ClassVar[int]
    read: WorkspaceRead
    write: WorkspaceWrite
    edit: WorkspaceEdit
    glob: WorkspaceGlob
    grep: WorkspaceGrep
    list: WorkspaceList
    command: WorkspaceCommand
    def __init__(self, read: _Optional[_Union[WorkspaceRead, _Mapping]] = ..., write: _Optional[_Union[WorkspaceWrite, _Mapping]] = ..., edit: _Optional[_Union[WorkspaceEdit, _Mapping]] = ..., glob: _Optional[_Union[WorkspaceGlob, _Mapping]] = ..., grep: _Optional[_Union[WorkspaceGrep, _Mapping]] = ..., list: _Optional[_Union[WorkspaceList, _Mapping]] = ..., command: _Optional[_Union[WorkspaceCommand, _Mapping]] = ...) -> None: ...

class WorkspaceRead(_message.Message):
    __slots__ = ("path", "offset", "limit")
    PATH_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    path: str
    offset: int
    limit: int
    def __init__(self, path: _Optional[str] = ..., offset: _Optional[int] = ..., limit: _Optional[int] = ...) -> None: ...

class WorkspaceWrite(_message.Message):
    __slots__ = ("path", "content")
    PATH_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    path: str
    content: str
    def __init__(self, path: _Optional[str] = ..., content: _Optional[str] = ...) -> None: ...

class WorkspaceEdit(_message.Message):
    __slots__ = ("path", "old_text", "new_text", "replace_all")
    PATH_FIELD_NUMBER: _ClassVar[int]
    OLD_TEXT_FIELD_NUMBER: _ClassVar[int]
    NEW_TEXT_FIELD_NUMBER: _ClassVar[int]
    REPLACE_ALL_FIELD_NUMBER: _ClassVar[int]
    path: str
    old_text: str
    new_text: str
    replace_all: bool
    def __init__(self, path: _Optional[str] = ..., old_text: _Optional[str] = ..., new_text: _Optional[str] = ..., replace_all: _Optional[bool] = ...) -> None: ...

class WorkspaceGlob(_message.Message):
    __slots__ = ("pattern", "path")
    PATTERN_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    pattern: str
    path: str
    def __init__(self, pattern: _Optional[str] = ..., path: _Optional[str] = ...) -> None: ...

class WorkspaceGrep(_message.Message):
    __slots__ = ("pattern", "path", "glob", "mode", "head_limit", "offset")
    PATTERN_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    GLOB_FIELD_NUMBER: _ClassVar[int]
    MODE_FIELD_NUMBER: _ClassVar[int]
    HEAD_LIMIT_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    pattern: str
    path: str
    glob: str
    mode: WorkspaceGrepMode
    head_limit: int
    offset: int
    def __init__(self, pattern: _Optional[str] = ..., path: _Optional[str] = ..., glob: _Optional[str] = ..., mode: _Optional[_Union[WorkspaceGrepMode, str]] = ..., head_limit: _Optional[int] = ..., offset: _Optional[int] = ...) -> None: ...

class WorkspaceList(_message.Message):
    __slots__ = ("path",)
    PATH_FIELD_NUMBER: _ClassVar[int]
    path: str
    def __init__(self, path: _Optional[str] = ...) -> None: ...

class WorkspaceCommand(_message.Message):
    __slots__ = ("command", "timeout_ms")
    COMMAND_FIELD_NUMBER: _ClassVar[int]
    TIMEOUT_MS_FIELD_NUMBER: _ClassVar[int]
    command: str
    timeout_ms: int
    def __init__(self, command: _Optional[str] = ..., timeout_ms: _Optional[int] = ...) -> None: ...

class HarnessWorkspaceResult(_message.Message):
    __slots__ = ("text", "is_error")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    IS_ERROR_FIELD_NUMBER: _ClassVar[int]
    text: str
    is_error: bool
    def __init__(self, text: _Optional[str] = ..., is_error: _Optional[bool] = ...) -> None: ...

class RemoteWorkspaceProviderBootstrap(_message.Message):
    __slots__ = ("token",)
    TOKEN_FIELD_NUMBER: _ClassVar[int]
    token: str
    def __init__(self, token: _Optional[str] = ...) -> None: ...

class RemoteWorkspaceOwner(_message.Message):
    __slots__ = ("host_id", "host_generation", "task_id", "attempt_id", "allocation_id")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    HOST_GENERATION_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    ALLOCATION_ID_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    host_generation: int
    task_id: str
    attempt_id: str
    allocation_id: str
    def __init__(self, host_id: _Optional[str] = ..., host_generation: _Optional[int] = ..., task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., allocation_id: _Optional[str] = ...) -> None: ...

class RemoteWorkspaceAllocateRequest(_message.Message):
    __slots__ = ("owner", "timeout_ms", "allowed_actions")
    OWNER_FIELD_NUMBER: _ClassVar[int]
    TIMEOUT_MS_FIELD_NUMBER: _ClassVar[int]
    ALLOWED_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    owner: RemoteWorkspaceOwner
    timeout_ms: int
    allowed_actions: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, owner: _Optional[_Union[RemoteWorkspaceOwner, _Mapping]] = ..., timeout_ms: _Optional[int] = ..., allowed_actions: _Optional[_Iterable[str]] = ...) -> None: ...

class RemoteWorkspaceAllocation(_message.Message):
    __slots__ = ("sandbox_id",)
    SANDBOX_ID_FIELD_NUMBER: _ClassVar[int]
    sandbox_id: str
    def __init__(self, sandbox_id: _Optional[str] = ...) -> None: ...

class RemoteWorkspaceStageHeader(_message.Message):
    __slots__ = ("start_commit", "bundle", "input_files")
    START_COMMIT_FIELD_NUMBER: _ClassVar[int]
    BUNDLE_FIELD_NUMBER: _ClassVar[int]
    INPUT_FILES_FIELD_NUMBER: _ClassVar[int]
    start_commit: str
    bundle: BlobReference
    input_files: _containers.RepeatedCompositeFieldContainer[ArtifactInputFile]
    def __init__(self, start_commit: _Optional[str] = ..., bundle: _Optional[_Union[BlobReference, _Mapping]] = ..., input_files: _Optional[_Iterable[_Union[ArtifactInputFile, _Mapping]]] = ...) -> None: ...

class RemoteWorkspaceStageChunk(_message.Message):
    __slots__ = ("header", "payload")
    HEADER_FIELD_NUMBER: _ClassVar[int]
    PAYLOAD_FIELD_NUMBER: _ClassVar[int]
    header: RemoteWorkspaceStageHeader
    payload: bytes
    def __init__(self, header: _Optional[_Union[RemoteWorkspaceStageHeader, _Mapping]] = ..., payload: _Optional[bytes] = ...) -> None: ...

class RemoteWorkspaceStageResponse(_message.Message):
    __slots__ = ("input_files",)
    INPUT_FILES_FIELD_NUMBER: _ClassVar[int]
    input_files: _containers.RepeatedCompositeFieldContainer[ArtifactInputFile]
    def __init__(self, input_files: _Optional[_Iterable[_Union[ArtifactInputFile, _Mapping]]] = ...) -> None: ...

class RemoteWorkspaceCaptureRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class RemoteWorkspaceCaptureChunk(_message.Message):
    __slots__ = ("tree", "payload")
    TREE_FIELD_NUMBER: _ClassVar[int]
    PAYLOAD_FIELD_NUMBER: _ClassVar[int]
    tree: BlobReference
    payload: bytes
    def __init__(self, tree: _Optional[_Union[BlobReference, _Mapping]] = ..., payload: _Optional[bytes] = ...) -> None: ...

class RemoteWorkspaceStopRequest(_message.Message):
    __slots__ = ("owner", "sandbox_id")
    OWNER_FIELD_NUMBER: _ClassVar[int]
    SANDBOX_ID_FIELD_NUMBER: _ClassVar[int]
    owner: RemoteWorkspaceOwner
    sandbox_id: str
    def __init__(self, owner: _Optional[_Union[RemoteWorkspaceOwner, _Mapping]] = ..., sandbox_id: _Optional[str] = ...) -> None: ...

class RemoteWorkspaceStopResponse(_message.Message):
    __slots__ = ("stopped_sandbox_id",)
    STOPPED_SANDBOX_ID_FIELD_NUMBER: _ClassVar[int]
    stopped_sandbox_id: str
    def __init__(self, stopped_sandbox_id: _Optional[str] = ...) -> None: ...

class HarnessAskQuestionRequest(_message.Message):
    __slots__ = ("operation_id", "text")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    text: str
    def __init__(self, operation_id: _Optional[str] = ..., text: _Optional[str] = ...) -> None: ...

class HarnessReadWorkstreamRequest(_message.Message):
    __slots__ = ("after_sequence", "limit", "cursor")
    AFTER_SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    after_sequence: int
    limit: int
    cursor: str
    def __init__(self, after_sequence: _Optional[int] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class HarnessPostWorkstreamRequest(_message.Message):
    __slots__ = ("operation_id", "body", "to_tag_ids")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    BODY_FIELD_NUMBER: _ClassVar[int]
    TO_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    body: str
    to_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, operation_id: _Optional[str] = ..., body: _Optional[str] = ..., to_tag_ids: _Optional[_Iterable[str]] = ...) -> None: ...

class HarnessContinueWorkSessionRequest(_message.Message):
    __slots__ = ("operation_id", "work_session_id", "message")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    WORK_SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    work_session_id: str
    message: str
    def __init__(self, operation_id: _Optional[str] = ..., work_session_id: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class HarnessAskWorkSessionQuestionRequest(_message.Message):
    __slots__ = ("operation_id", "text")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    text: str
    def __init__(self, operation_id: _Optional[str] = ..., text: _Optional[str] = ...) -> None: ...

class HarnessStartWorkSessionRequest(_message.Message):
    __slots__ = ("operation_id", "title", "instruction", "workspace_id", "target_tag_id")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTION_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    TARGET_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    title: str
    instruction: str
    workspace_id: str
    target_tag_id: str
    def __init__(self, operation_id: _Optional[str] = ..., title: _Optional[str] = ..., instruction: _Optional[str] = ..., workspace_id: _Optional[str] = ..., target_tag_id: _Optional[str] = ...) -> None: ...

class HarnessSendTagMessageRequest(_message.Message):
    __slots__ = ("operation_id", "recipient_tag_id", "text", "review")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    RECIPIENT_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    REVIEW_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    recipient_tag_id: str
    text: str
    review: CommitReviewSubmission
    def __init__(self, operation_id: _Optional[str] = ..., recipient_tag_id: _Optional[str] = ..., text: _Optional[str] = ..., review: _Optional[_Union[CommitReviewSubmission, _Mapping]] = ...) -> None: ...

class HarnessReadMailboxRequest(_message.Message):
    __slots__ = ("limit", "cursor")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    limit: int
    cursor: str
    def __init__(self, limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class HarnessReadReviewPatchRequest(_message.Message):
    __slots__ = ("review_id", "offset")
    REVIEW_ID_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    review_id: str
    offset: int
    def __init__(self, review_id: _Optional[str] = ..., offset: _Optional[int] = ...) -> None: ...

class HarnessReviewPatch(_message.Message):
    __slots__ = ("review_id", "offset", "data", "next_offset", "delivery")
    REVIEW_ID_FIELD_NUMBER: _ClassVar[int]
    OFFSET_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    NEXT_OFFSET_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_FIELD_NUMBER: _ClassVar[int]
    review_id: str
    offset: int
    data: bytes
    next_offset: int
    delivery: WorkspaceDeliveryReference
    def __init__(self, review_id: _Optional[str] = ..., offset: _Optional[int] = ..., data: _Optional[bytes] = ..., next_offset: _Optional[int] = ..., delivery: _Optional[_Union[WorkspaceDeliveryReference, _Mapping]] = ...) -> None: ...

class QueueInputRequest(_message.Message):
    __slots__ = ("task_id", "operation_id", "text")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    operation_id: str
    text: str
    def __init__(self, task_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., text: _Optional[str] = ...) -> None: ...

class GetInputRequest(_message.Message):
    __slots__ = ("input_id",)
    INPUT_ID_FIELD_NUMBER: _ClassVar[int]
    input_id: str
    def __init__(self, input_id: _Optional[str] = ...) -> None: ...

class ResolveInputRequest(_message.Message):
    __slots__ = ("input_id", "operation_id", "decision", "evidence")
    INPUT_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    DECISION_FIELD_NUMBER: _ClassVar[int]
    EVIDENCE_FIELD_NUMBER: _ClassVar[int]
    input_id: str
    operation_id: str
    decision: LiveInputDecision
    evidence: str
    def __init__(self, input_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., decision: _Optional[_Union[LiveInputDecision, str]] = ..., evidence: _Optional[str] = ...) -> None: ...

class LiveInput(_message.Message):
    __slots__ = ("input_id", "task_id", "attempt_id", "follower_task_id", "text", "state", "order")
    INPUT_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    FOLLOWER_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    ORDER_FIELD_NUMBER: _ClassVar[int]
    input_id: str
    task_id: str
    attempt_id: str
    follower_task_id: str
    text: str
    state: LiveInputState
    order: int
    def __init__(self, input_id: _Optional[str] = ..., task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., follower_task_id: _Optional[str] = ..., text: _Optional[str] = ..., state: _Optional[_Union[LiveInputState, str]] = ..., order: _Optional[int] = ...) -> None: ...

class TakeInputRequest(_message.Message):
    __slots__ = ("attempt",)
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ...) -> None: ...

class TakeInputResponse(_message.Message):
    __slots__ = ("input", "valid_for_ms")
    INPUT_FIELD_NUMBER: _ClassVar[int]
    VALID_FOR_MS_FIELD_NUMBER: _ClassVar[int]
    input: LiveInput
    valid_for_ms: int
    def __init__(self, input: _Optional[_Union[LiveInput, _Mapping]] = ..., valid_for_ms: _Optional[int] = ...) -> None: ...

class HarnessTakeLiveInputRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class HarnessSettleLiveInputRequest(_message.Message):
    __slots__ = ("input_id", "receipt")
    INPUT_ID_FIELD_NUMBER: _ClassVar[int]
    RECEIPT_FIELD_NUMBER: _ClassVar[int]
    input_id: str
    receipt: LiveInputReceipt
    def __init__(self, input_id: _Optional[str] = ..., receipt: _Optional[_Union[LiveInputReceipt, str]] = ...) -> None: ...

class SettleInputRequest(_message.Message):
    __slots__ = ("attempt", "input_id", "receipt")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    INPUT_ID_FIELD_NUMBER: _ClassVar[int]
    RECEIPT_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    input_id: str
    receipt: LiveInputReceipt
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., input_id: _Optional[str] = ..., receipt: _Optional[_Union[LiveInputReceipt, str]] = ...) -> None: ...

class CreateAuthKeyRequest(_message.Message):
    __slots__ = ("host_id", "operation_id", "key_digest", "expires_in_ms", "allowed_tag_ids", "all_tags")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    KEY_DIGEST_FIELD_NUMBER: _ClassVar[int]
    EXPIRES_IN_MS_FIELD_NUMBER: _ClassVar[int]
    ALLOWED_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    ALL_TAGS_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    operation_id: str
    key_digest: bytes
    expires_in_ms: int
    allowed_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    all_tags: bool
    def __init__(self, host_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., key_digest: _Optional[bytes] = ..., expires_in_ms: _Optional[int] = ..., allowed_tag_ids: _Optional[_Iterable[str]] = ..., all_tags: _Optional[bool] = ...) -> None: ...

class AuthKey(_message.Message):
    __slots__ = ("host_id", "expires_at_ms", "allowed_tag_ids", "all_tags")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    EXPIRES_AT_MS_FIELD_NUMBER: _ClassVar[int]
    ALLOWED_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    ALL_TAGS_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    expires_at_ms: int
    allowed_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    all_tags: bool
    def __init__(self, host_id: _Optional[str] = ..., expires_at_ms: _Optional[int] = ..., allowed_tag_ids: _Optional[_Iterable[str]] = ..., all_tags: _Optional[bool] = ...) -> None: ...

class RevokeHostRequest(_message.Message):
    __slots__ = ("host_id",)
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    def __init__(self, host_id: _Optional[str] = ...) -> None: ...

class RegisterHostRequest(_message.Message):
    __slots__ = ("incarnation_id",)
    INCARNATION_ID_FIELD_NUMBER: _ClassVar[int]
    incarnation_id: str
    def __init__(self, incarnation_id: _Optional[str] = ...) -> None: ...

class HostRecord(_message.Message):
    __slots__ = ("host_id", "generation", "revoked")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    GENERATION_FIELD_NUMBER: _ClassVar[int]
    REVOKED_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    generation: int
    revoked: bool
    def __init__(self, host_id: _Optional[str] = ..., generation: _Optional[int] = ..., revoked: _Optional[bool] = ...) -> None: ...

class EnrollHostRequest(_message.Message):
    __slots__ = ("host_id", "operation_id", "token_digest")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TOKEN_DIGEST_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    operation_id: str
    token_digest: bytes
    def __init__(self, host_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., token_digest: _Optional[bytes] = ...) -> None: ...

class PrivateEnrollHostRequest(_message.Message):
    __slots__ = ("enrollment", "key_digest")
    ENROLLMENT_FIELD_NUMBER: _ClassVar[int]
    KEY_DIGEST_FIELD_NUMBER: _ClassVar[int]
    enrollment: EnrollHostRequest
    key_digest: bytes
    def __init__(self, enrollment: _Optional[_Union[EnrollHostRequest, _Mapping]] = ..., key_digest: _Optional[bytes] = ...) -> None: ...

class AuthenticateHostRequest(_message.Message):
    __slots__ = ("token_digest",)
    TOKEN_DIGEST_FIELD_NUMBER: _ClassVar[int]
    token_digest: bytes
    def __init__(self, token_digest: _Optional[bytes] = ...) -> None: ...

class PutTagRequest(_message.Message):
    __slots__ = ("tag_id", "instructions", "allowed_actions", "workspace", "harness_kind", "approval_rules", "execution", "name", "expected_revision")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTIONS_FIELD_NUMBER: _ClassVar[int]
    ALLOWED_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    HARNESS_KIND_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_RULES_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    instructions: str
    allowed_actions: _containers.RepeatedScalarFieldContainer[str]
    workspace: WorkspaceSpec
    harness_kind: HarnessKind
    approval_rules: _containers.RepeatedCompositeFieldContainer[ApprovalRule]
    execution: _policy_pb2.PolicyExecutionSettings
    name: str
    expected_revision: int
    def __init__(self, tag_id: _Optional[str] = ..., instructions: _Optional[str] = ..., allowed_actions: _Optional[_Iterable[str]] = ..., workspace: _Optional[_Union[WorkspaceSpec, _Mapping]] = ..., harness_kind: _Optional[_Union[HarnessKind, str]] = ..., approval_rules: _Optional[_Iterable[_Union[ApprovalRule, _Mapping]]] = ..., execution: _Optional[_Union[_policy_pb2.PolicyExecutionSettings, _Mapping]] = ..., name: _Optional[str] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class Tag(_message.Message):
    __slots__ = ("tag_id", "instructions", "allowed_actions", "revision", "workspace", "harness_kind", "approval_rules", "execution", "name", "retired_at_ms")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTIONS_FIELD_NUMBER: _ClassVar[int]
    ALLOWED_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    HARNESS_KIND_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_RULES_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    RETIRED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    instructions: str
    allowed_actions: _containers.RepeatedScalarFieldContainer[str]
    revision: int
    workspace: WorkspaceSpec
    harness_kind: HarnessKind
    approval_rules: _containers.RepeatedCompositeFieldContainer[ApprovalRule]
    execution: _policy_pb2.PolicyExecutionSettings
    name: str
    retired_at_ms: int
    def __init__(self, tag_id: _Optional[str] = ..., instructions: _Optional[str] = ..., allowed_actions: _Optional[_Iterable[str]] = ..., revision: _Optional[int] = ..., workspace: _Optional[_Union[WorkspaceSpec, _Mapping]] = ..., harness_kind: _Optional[_Union[HarnessKind, str]] = ..., approval_rules: _Optional[_Iterable[_Union[ApprovalRule, _Mapping]]] = ..., execution: _Optional[_Union[_policy_pb2.PolicyExecutionSettings, _Mapping]] = ..., name: _Optional[str] = ..., retired_at_ms: _Optional[int] = ...) -> None: ...

class ListTagsRequest(_message.Message):
    __slots__ = ("limit", "cursor", "include_retired")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    INCLUDE_RETIRED_FIELD_NUMBER: _ClassVar[int]
    limit: int
    cursor: str
    include_retired: bool
    def __init__(self, limit: _Optional[int] = ..., cursor: _Optional[str] = ..., include_retired: _Optional[bool] = ...) -> None: ...

class ListTagsResponse(_message.Message):
    __slots__ = ("tags", "next_cursor")
    TAGS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    tags: _containers.RepeatedCompositeFieldContainer[Tag]
    next_cursor: str
    def __init__(self, tags: _Optional[_Iterable[_Union[Tag, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class GetTagRequest(_message.Message):
    __slots__ = ("tag_id",)
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    def __init__(self, tag_id: _Optional[str] = ...) -> None: ...

class RetireTagRequest(_message.Message):
    __slots__ = ("tag_id", "dry_run")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    DRY_RUN_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    dry_run: bool
    def __init__(self, tag_id: _Optional[str] = ..., dry_run: _Optional[bool] = ...) -> None: ...

class RetireTagResponse(_message.Message):
    __slots__ = ("tag", "blockers", "surface_locations", "host_bindings", "mailbox_grants", "role_assignments")
    TAG_FIELD_NUMBER: _ClassVar[int]
    BLOCKERS_FIELD_NUMBER: _ClassVar[int]
    SURFACE_LOCATIONS_FIELD_NUMBER: _ClassVar[int]
    HOST_BINDINGS_FIELD_NUMBER: _ClassVar[int]
    MAILBOX_GRANTS_FIELD_NUMBER: _ClassVar[int]
    ROLE_ASSIGNMENTS_FIELD_NUMBER: _ClassVar[int]
    tag: Tag
    blockers: _containers.RepeatedScalarFieldContainer[str]
    surface_locations: int
    host_bindings: int
    mailbox_grants: int
    role_assignments: int
    def __init__(self, tag: _Optional[_Union[Tag, _Mapping]] = ..., blockers: _Optional[_Iterable[str]] = ..., surface_locations: _Optional[int] = ..., host_bindings: _Optional[int] = ..., mailbox_grants: _Optional[int] = ..., role_assignments: _Optional[int] = ...) -> None: ...

class Conversation(_message.Message):
    __slots__ = ("tag_id", "name", "session_id", "latest_task")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    LATEST_TASK_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    name: str
    session_id: str
    latest_task: Task
    def __init__(self, tag_id: _Optional[str] = ..., name: _Optional[str] = ..., session_id: _Optional[str] = ..., latest_task: _Optional[_Union[Task, _Mapping]] = ...) -> None: ...

class ConversationMessage(_message.Message):
    __slots__ = ("task", "conversation", "live_input", "work_session_report_id")
    TASK_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_FIELD_NUMBER: _ClassVar[int]
    LIVE_INPUT_FIELD_NUMBER: _ClassVar[int]
    WORK_SESSION_REPORT_ID_FIELD_NUMBER: _ClassVar[int]
    task: Task
    conversation: str
    live_input: LiveInput
    work_session_report_id: str
    def __init__(self, task: _Optional[_Union[Task, _Mapping]] = ..., conversation: _Optional[str] = ..., live_input: _Optional[_Union[LiveInput, _Mapping]] = ..., work_session_report_id: _Optional[str] = ...) -> None: ...

class ListConversationsRequest(_message.Message):
    __slots__ = ("tag_id", "limit", "cursor")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    limit: int
    cursor: str
    def __init__(self, tag_id: _Optional[str] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListConversationsResponse(_message.Message):
    __slots__ = ("conversations", "next_cursor")
    CONVERSATIONS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    conversations: _containers.RepeatedCompositeFieldContainer[Conversation]
    next_cursor: str
    def __init__(self, conversations: _Optional[_Iterable[_Union[Conversation, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class ListMessagesRequest(_message.Message):
    __slots__ = ("tag_id", "conversation", "limit", "cursor")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    conversation: str
    limit: int
    cursor: str
    def __init__(self, tag_id: _Optional[str] = ..., conversation: _Optional[str] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListMessagesResponse(_message.Message):
    __slots__ = ("messages", "next_cursor")
    MESSAGES_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    messages: _containers.RepeatedCompositeFieldContainer[ConversationMessage]
    next_cursor: str
    def __init__(self, messages: _Optional[_Iterable[_Union[ConversationMessage, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class SendMessageRequest(_message.Message):
    __slots__ = ("tag_id", "conversation", "text", "operation_id", "execution_limits", "output_policy")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_LIMITS_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_POLICY_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    conversation: str
    text: str
    operation_id: str
    execution_limits: ExecutionLimits
    output_policy: TaskOutputPolicy
    def __init__(self, tag_id: _Optional[str] = ..., conversation: _Optional[str] = ..., text: _Optional[str] = ..., operation_id: _Optional[str] = ..., execution_limits: _Optional[_Union[ExecutionLimits, _Mapping]] = ..., output_policy: _Optional[_Union[TaskOutputPolicy, _Mapping]] = ...) -> None: ...

class GetMessageRequest(_message.Message):
    __slots__ = ("tag_id", "task_id")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    task_id: str
    def __init__(self, tag_id: _Optional[str] = ..., task_id: _Optional[str] = ...) -> None: ...

class ListMessageEventsRequest(_message.Message):
    __slots__ = ("tag_id", "task_id", "after_sequence", "limit")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    AFTER_SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    task_id: str
    after_sequence: int
    limit: int
    def __init__(self, tag_id: _Optional[str] = ..., task_id: _Optional[str] = ..., after_sequence: _Optional[int] = ..., limit: _Optional[int] = ...) -> None: ...

class SubmitTaskRequest(_message.Message):
    __slots__ = ("tag_id", "session_id", "operation_id", "prompt", "execution_limits", "output_policy", "input_artifacts")
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_LIMITS_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_POLICY_FIELD_NUMBER: _ClassVar[int]
    INPUT_ARTIFACTS_FIELD_NUMBER: _ClassVar[int]
    tag_id: str
    session_id: str
    operation_id: str
    prompt: str
    execution_limits: ExecutionLimits
    output_policy: TaskOutputPolicy
    input_artifacts: _containers.RepeatedCompositeFieldContainer[TaskArtifactInputSelection]
    def __init__(self, tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., prompt: _Optional[str] = ..., execution_limits: _Optional[_Union[ExecutionLimits, _Mapping]] = ..., output_policy: _Optional[_Union[TaskOutputPolicy, _Mapping]] = ..., input_artifacts: _Optional[_Iterable[_Union[TaskArtifactInputSelection, _Mapping]]] = ...) -> None: ...

class ReportedCostLimit(_message.Message):
    __slots__ = ("currency", "amount_minor")
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    AMOUNT_MINOR_FIELD_NUMBER: _ClassVar[int]
    currency: str
    amount_minor: int
    def __init__(self, currency: _Optional[str] = ..., amount_minor: _Optional[int] = ...) -> None: ...

class ExecutionLimits(_message.Message):
    __slots__ = ("max_reported_tokens", "max_reported_cost", "max_native_agents")
    MAX_REPORTED_TOKENS_FIELD_NUMBER: _ClassVar[int]
    MAX_REPORTED_COST_FIELD_NUMBER: _ClassVar[int]
    MAX_NATIVE_AGENTS_FIELD_NUMBER: _ClassVar[int]
    max_reported_tokens: int
    max_reported_cost: ReportedCostLimit
    max_native_agents: int
    def __init__(self, max_reported_tokens: _Optional[int] = ..., max_reported_cost: _Optional[_Union[ReportedCostLimit, _Mapping]] = ..., max_native_agents: _Optional[int] = ...) -> None: ...

class Task(_message.Message):
    __slots__ = ("task_id", "tag_id", "session_id", "prompt", "instructions", "allowed_actions", "tag_revision", "state", "result", "attempt_id", "workspace", "workspace_delivery", "harness_kind", "approval_rules", "policy_snapshot", "execution_limits", "execution_selection", "attempt_execution", "artifacts", "output_policy", "input_artifacts")
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
    WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_DELIVERY_FIELD_NUMBER: _ClassVar[int]
    HARNESS_KIND_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_RULES_FIELD_NUMBER: _ClassVar[int]
    POLICY_SNAPSHOT_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_LIMITS_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_SELECTION_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_EXECUTION_FIELD_NUMBER: _ClassVar[int]
    ARTIFACTS_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_POLICY_FIELD_NUMBER: _ClassVar[int]
    INPUT_ARTIFACTS_FIELD_NUMBER: _ClassVar[int]
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
    workspace: WorkspaceSpec
    workspace_delivery: WorkspaceDeliveryReference
    harness_kind: HarnessKind
    approval_rules: _containers.RepeatedCompositeFieldContainer[ApprovalRule]
    policy_snapshot: _policy_pb2.TaskPolicySnapshot
    execution_limits: ExecutionLimits
    execution_selection: ExecutionSelection
    attempt_execution: AttemptExecutionSelection
    artifacts: _containers.RepeatedCompositeFieldContainer[ArtifactSelection]
    output_policy: TaskOutputPolicy
    input_artifacts: _containers.RepeatedCompositeFieldContainer[AcceptedTaskArtifactInput]
    def __init__(self, task_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., prompt: _Optional[str] = ..., instructions: _Optional[str] = ..., allowed_actions: _Optional[_Iterable[str]] = ..., tag_revision: _Optional[int] = ..., state: _Optional[_Union[TaskState, str]] = ..., result: _Optional[str] = ..., attempt_id: _Optional[str] = ..., workspace: _Optional[_Union[WorkspaceSpec, _Mapping]] = ..., workspace_delivery: _Optional[_Union[WorkspaceDeliveryReference, _Mapping]] = ..., harness_kind: _Optional[_Union[HarnessKind, str]] = ..., approval_rules: _Optional[_Iterable[_Union[ApprovalRule, _Mapping]]] = ..., policy_snapshot: _Optional[_Union[_policy_pb2.TaskPolicySnapshot, _Mapping]] = ..., execution_limits: _Optional[_Union[ExecutionLimits, _Mapping]] = ..., execution_selection: _Optional[_Union[ExecutionSelection, _Mapping]] = ..., attempt_execution: _Optional[_Union[AttemptExecutionSelection, _Mapping]] = ..., artifacts: _Optional[_Iterable[_Union[ArtifactSelection, _Mapping]]] = ..., output_policy: _Optional[_Union[TaskOutputPolicy, _Mapping]] = ..., input_artifacts: _Optional[_Iterable[_Union[AcceptedTaskArtifactInput, _Mapping]]] = ...) -> None: ...

class TaskArtifactInputSelection(_message.Message):
    __slots__ = ("artifact_id", "paths", "require_accepted", "publication_approval_id")
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    PATHS_FIELD_NUMBER: _ClassVar[int]
    REQUIRE_ACCEPTED_FIELD_NUMBER: _ClassVar[int]
    PUBLICATION_APPROVAL_ID_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    paths: _containers.RepeatedScalarFieldContainer[str]
    require_accepted: bool
    publication_approval_id: str
    def __init__(self, artifact_id: _Optional[str] = ..., paths: _Optional[_Iterable[str]] = ..., require_accepted: _Optional[bool] = ..., publication_approval_id: _Optional[str] = ...) -> None: ...

class AcceptedTaskArtifactInput(_message.Message):
    __slots__ = ("artifact_id", "source_task_id", "source_attempt_id", "files", "publication")
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    FILES_FIELD_NUMBER: _ClassVar[int]
    PUBLICATION_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    source_task_id: str
    source_attempt_id: str
    files: _containers.RepeatedCompositeFieldContainer[ArtifactInputFile]
    publication: ArtifactPublicationPin
    def __init__(self, artifact_id: _Optional[str] = ..., source_task_id: _Optional[str] = ..., source_attempt_id: _Optional[str] = ..., files: _Optional[_Iterable[_Union[ArtifactInputFile, _Mapping]]] = ..., publication: _Optional[_Union[ArtifactPublicationPin, _Mapping]] = ...) -> None: ...

class ArtifactInputFile(_message.Message):
    __slots__ = ("path", "blob")
    PATH_FIELD_NUMBER: _ClassVar[int]
    BLOB_FIELD_NUMBER: _ClassVar[int]
    path: str
    blob: BlobReference
    def __init__(self, path: _Optional[str] = ..., blob: _Optional[_Union[BlobReference, _Mapping]] = ...) -> None: ...

class AcceptedTaskArtifactInputs(_message.Message):
    __slots__ = ("inputs",)
    INPUTS_FIELD_NUMBER: _ClassVar[int]
    inputs: _containers.RepeatedCompositeFieldContainer[AcceptedTaskArtifactInput]
    def __init__(self, inputs: _Optional[_Iterable[_Union[AcceptedTaskArtifactInput, _Mapping]]] = ...) -> None: ...

class OutputPathPatterns(_message.Message):
    __slots__ = ("patterns",)
    PATTERNS_FIELD_NUMBER: _ClassVar[int]
    patterns: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, patterns: _Optional[_Iterable[str]] = ...) -> None: ...

class TaskOutputPolicy(_message.Message):
    __slots__ = ("directory", "required", "include", "exclude", "git", "max_files", "max_bytes")
    DIRECTORY_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    INCLUDE_FIELD_NUMBER: _ClassVar[int]
    EXCLUDE_FIELD_NUMBER: _ClassVar[int]
    GIT_FIELD_NUMBER: _ClassVar[int]
    MAX_FILES_FIELD_NUMBER: _ClassVar[int]
    MAX_BYTES_FIELD_NUMBER: _ClassVar[int]
    directory: str
    required: _containers.RepeatedScalarFieldContainer[str]
    include: OutputPathPatterns
    exclude: _containers.RepeatedScalarFieldContainer[str]
    git: OutputGitMode
    max_files: int
    max_bytes: int
    def __init__(self, directory: _Optional[str] = ..., required: _Optional[_Iterable[str]] = ..., include: _Optional[_Union[OutputPathPatterns, _Mapping]] = ..., exclude: _Optional[_Iterable[str]] = ..., git: _Optional[_Union[OutputGitMode, str]] = ..., max_files: _Optional[int] = ..., max_bytes: _Optional[int] = ...) -> None: ...

class ArtifactSelection(_message.Message):
    __slots__ = ("artifact_id", "paths")
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    PATHS_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    paths: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, artifact_id: _Optional[str] = ..., paths: _Optional[_Iterable[str]] = ...) -> None: ...

class ExecutionSelection(_message.Message):
    __slots__ = ("model", "effort")
    MODEL_FIELD_NUMBER: _ClassVar[int]
    EFFORT_FIELD_NUMBER: _ClassVar[int]
    model: str
    effort: str
    def __init__(self, model: _Optional[str] = ..., effort: _Optional[str] = ...) -> None: ...

class HarnessExecutionProfile(_message.Message):
    __slots__ = ("model_ids", "default_model", "allow_unsandboxed_commands", "remote_file_workspace", "mcp_servers", "shared_execution", "declared_task_outputs", "task_artifact_inputs", "workspace_mounts")
    MODEL_IDS_FIELD_NUMBER: _ClassVar[int]
    DEFAULT_MODEL_FIELD_NUMBER: _ClassVar[int]
    ALLOW_UNSANDBOXED_COMMANDS_FIELD_NUMBER: _ClassVar[int]
    REMOTE_FILE_WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    MCP_SERVERS_FIELD_NUMBER: _ClassVar[int]
    SHARED_EXECUTION_FIELD_NUMBER: _ClassVar[int]
    DECLARED_TASK_OUTPUTS_FIELD_NUMBER: _ClassVar[int]
    TASK_ARTIFACT_INPUTS_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_MOUNTS_FIELD_NUMBER: _ClassVar[int]
    model_ids: _containers.RepeatedScalarFieldContainer[str]
    default_model: str
    allow_unsandboxed_commands: bool
    remote_file_workspace: bool
    mcp_servers: _containers.RepeatedCompositeFieldContainer[_mcp_pb2.McpServerCapability]
    shared_execution: SharedExecutionCapability
    declared_task_outputs: bool
    task_artifact_inputs: bool
    workspace_mounts: _containers.RepeatedCompositeFieldContainer[WorkspaceMountCapability]
    def __init__(self, model_ids: _Optional[_Iterable[str]] = ..., default_model: _Optional[str] = ..., allow_unsandboxed_commands: _Optional[bool] = ..., remote_file_workspace: _Optional[bool] = ..., mcp_servers: _Optional[_Iterable[_Union[_mcp_pb2.McpServerCapability, _Mapping]]] = ..., shared_execution: _Optional[_Union[SharedExecutionCapability, _Mapping]] = ..., declared_task_outputs: _Optional[bool] = ..., task_artifact_inputs: _Optional[bool] = ..., workspace_mounts: _Optional[_Iterable[_Union[WorkspaceMountCapability, _Mapping]]] = ...) -> None: ...

class SharedExecutionCapability(_message.Message):
    __slots__ = ("environment_id", "tools", "incarnation_id")
    ENVIRONMENT_ID_FIELD_NUMBER: _ClassVar[int]
    TOOLS_FIELD_NUMBER: _ClassVar[int]
    INCARNATION_ID_FIELD_NUMBER: _ClassVar[int]
    environment_id: str
    tools: _containers.RepeatedScalarFieldContainer[SharedExecutionTool]
    incarnation_id: str
    def __init__(self, environment_id: _Optional[str] = ..., tools: _Optional[_Iterable[_Union[SharedExecutionTool, str]]] = ..., incarnation_id: _Optional[str] = ...) -> None: ...

class SharedExecutionAccessSummary(_message.Message):
    __slots__ = ("environment_id", "incarnation_id")
    ENVIRONMENT_ID_FIELD_NUMBER: _ClassVar[int]
    INCARNATION_ID_FIELD_NUMBER: _ClassVar[int]
    environment_id: str
    incarnation_id: str
    def __init__(self, environment_id: _Optional[str] = ..., incarnation_id: _Optional[str] = ...) -> None: ...

class AttemptExecutionSelection(_message.Message):
    __slots__ = ("selection", "model_source", "harness_kind", "effort_applied", "remote_file_workspace", "shared_execution", "mcp_servers", "task_artifact_inputs")
    SELECTION_FIELD_NUMBER: _ClassVar[int]
    MODEL_SOURCE_FIELD_NUMBER: _ClassVar[int]
    HARNESS_KIND_FIELD_NUMBER: _ClassVar[int]
    EFFORT_APPLIED_FIELD_NUMBER: _ClassVar[int]
    REMOTE_FILE_WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    SHARED_EXECUTION_FIELD_NUMBER: _ClassVar[int]
    MCP_SERVERS_FIELD_NUMBER: _ClassVar[int]
    TASK_ARTIFACT_INPUTS_FIELD_NUMBER: _ClassVar[int]
    selection: ExecutionSelection
    model_source: ModelSource
    harness_kind: HarnessKind
    effort_applied: bool
    remote_file_workspace: bool
    shared_execution: SharedExecutionCapability
    mcp_servers: _containers.RepeatedCompositeFieldContainer[_mcp_pb2.McpServerCapability]
    task_artifact_inputs: bool
    def __init__(self, selection: _Optional[_Union[ExecutionSelection, _Mapping]] = ..., model_source: _Optional[_Union[ModelSource, str]] = ..., harness_kind: _Optional[_Union[HarnessKind, str]] = ..., effort_applied: _Optional[bool] = ..., remote_file_workspace: _Optional[bool] = ..., shared_execution: _Optional[_Union[SharedExecutionCapability, _Mapping]] = ..., mcp_servers: _Optional[_Iterable[_Union[_mcp_pb2.McpServerCapability, _Mapping]]] = ..., task_artifact_inputs: _Optional[bool] = ...) -> None: ...

class ReserveMcpEffectRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "server", "tool", "arguments_json", "provider_binding", "tool_schema_sha256")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    SERVER_FIELD_NUMBER: _ClassVar[int]
    TOOL_FIELD_NUMBER: _ClassVar[int]
    ARGUMENTS_JSON_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_BINDING_FIELD_NUMBER: _ClassVar[int]
    TOOL_SCHEMA_SHA256_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    operation_id: str
    server: str
    tool: str
    arguments_json: str
    provider_binding: str
    tool_schema_sha256: str
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., server: _Optional[str] = ..., tool: _Optional[str] = ..., arguments_json: _Optional[str] = ..., provider_binding: _Optional[str] = ..., tool_schema_sha256: _Optional[str] = ...) -> None: ...

class ReserveMcpEffectResponse(_message.Message):
    __slots__ = ("approval", "dispatch_id", "result_json", "unconfirmed", "dispatch_valid_for_ms", "canonical_arguments_json", "ungated")
    APPROVAL_FIELD_NUMBER: _ClassVar[int]
    DISPATCH_ID_FIELD_NUMBER: _ClassVar[int]
    RESULT_JSON_FIELD_NUMBER: _ClassVar[int]
    UNCONFIRMED_FIELD_NUMBER: _ClassVar[int]
    DISPATCH_VALID_FOR_MS_FIELD_NUMBER: _ClassVar[int]
    CANONICAL_ARGUMENTS_JSON_FIELD_NUMBER: _ClassVar[int]
    UNGATED_FIELD_NUMBER: _ClassVar[int]
    approval: Approval
    dispatch_id: str
    result_json: str
    unconfirmed: bool
    dispatch_valid_for_ms: int
    canonical_arguments_json: str
    ungated: bool
    def __init__(self, approval: _Optional[_Union[Approval, _Mapping]] = ..., dispatch_id: _Optional[str] = ..., result_json: _Optional[str] = ..., unconfirmed: _Optional[bool] = ..., dispatch_valid_for_ms: _Optional[int] = ..., canonical_arguments_json: _Optional[str] = ..., ungated: _Optional[bool] = ...) -> None: ...

class SettleMcpEffectRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "dispatch_id", "result_json")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    DISPATCH_ID_FIELD_NUMBER: _ClassVar[int]
    RESULT_JSON_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    operation_id: str
    dispatch_id: str
    result_json: str
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., dispatch_id: _Optional[str] = ..., result_json: _Optional[str] = ...) -> None: ...

class SettleMcpEffectResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

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
    __slots__ = ("operation_id", "workspace_ids", "harness_kind", "context_contracts", "execution_profile", "gateway_workspace_ids")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_IDS_FIELD_NUMBER: _ClassVar[int]
    HARNESS_KIND_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_CONTRACTS_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_PROFILE_FIELD_NUMBER: _ClassVar[int]
    GATEWAY_WORKSPACE_IDS_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    workspace_ids: _containers.RepeatedScalarFieldContainer[str]
    harness_kind: HarnessKind
    context_contracts: _containers.RepeatedCompositeFieldContainer[ContextContract]
    execution_profile: HarnessExecutionProfile
    gateway_workspace_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, operation_id: _Optional[str] = ..., workspace_ids: _Optional[_Iterable[str]] = ..., harness_kind: _Optional[_Union[HarnessKind, str]] = ..., context_contracts: _Optional[_Iterable[_Union[ContextContract, _Mapping]]] = ..., execution_profile: _Optional[_Union[HarnessExecutionProfile, _Mapping]] = ..., gateway_workspace_ids: _Optional[_Iterable[str]] = ...) -> None: ...

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

class AttemptAuthority(_message.Message):
    __slots__ = ("task", "valid_for_ms")
    TASK_FIELD_NUMBER: _ClassVar[int]
    VALID_FOR_MS_FIELD_NUMBER: _ClassVar[int]
    task: Task
    valid_for_ms: int
    def __init__(self, task: _Optional[_Union[Task, _Mapping]] = ..., valid_for_ms: _Optional[int] = ...) -> None: ...

class ResolveAttemptRequest(_message.Message):
    __slots__ = ("task_id", "attempt_id", "operation_id", "decision", "evidence", "confirmed_stopped")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    DECISION_FIELD_NUMBER: _ClassVar[int]
    EVIDENCE_FIELD_NUMBER: _ClassVar[int]
    CONFIRMED_STOPPED_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    operation_id: str
    decision: AttemptDecision
    evidence: str
    confirmed_stopped: bool
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., decision: _Optional[_Union[AttemptDecision, str]] = ..., evidence: _Optional[str] = ..., confirmed_stopped: _Optional[bool] = ...) -> None: ...

class AttemptResolution(_message.Message):
    __slots__ = ("task_id", "attempt_id", "decision", "operator_id", "evidence", "resolved_at_ms")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    DECISION_FIELD_NUMBER: _ClassVar[int]
    OPERATOR_ID_FIELD_NUMBER: _ClassVar[int]
    EVIDENCE_FIELD_NUMBER: _ClassVar[int]
    RESOLVED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    decision: AttemptDecision
    operator_id: str
    evidence: str
    resolved_at_ms: int
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., decision: _Optional[_Union[AttemptDecision, str]] = ..., operator_id: _Optional[str] = ..., evidence: _Optional[str] = ..., resolved_at_ms: _Optional[int] = ...) -> None: ...

class GetAttemptResolutionResponse(_message.Message):
    __slots__ = ("resolution",)
    RESOLUTION_FIELD_NUMBER: _ClassVar[int]
    resolution: AttemptResolution
    def __init__(self, resolution: _Optional[_Union[AttemptResolution, _Mapping]] = ...) -> None: ...

class ReportAttemptUsageRequest(_message.Message):
    __slots__ = ("attempt", "sequence", "amount_minor", "currency", "estimated", "native_usage")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    AMOUNT_MINOR_FIELD_NUMBER: _ClassVar[int]
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    ESTIMATED_FIELD_NUMBER: _ClassVar[int]
    NATIVE_USAGE_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    sequence: int
    amount_minor: int
    currency: str
    estimated: bool
    native_usage: NativeTokenUsage
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., sequence: _Optional[int] = ..., amount_minor: _Optional[int] = ..., currency: _Optional[str] = ..., estimated: _Optional[bool] = ..., native_usage: _Optional[_Union[NativeTokenUsage, _Mapping]] = ...) -> None: ...

class ReportAttemptUsageResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class NativeTokenUsage(_message.Message):
    __slots__ = ("input_tokens", "cached_input_tokens", "output_tokens", "observed_model", "total_tokens")
    INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    CACHED_INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    OBSERVED_MODEL_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TOKENS_FIELD_NUMBER: _ClassVar[int]
    input_tokens: int
    cached_input_tokens: int
    output_tokens: int
    observed_model: str
    total_tokens: int
    def __init__(self, input_tokens: _Optional[int] = ..., cached_input_tokens: _Optional[int] = ..., output_tokens: _Optional[int] = ..., observed_model: _Optional[str] = ..., total_tokens: _Optional[int] = ...) -> None: ...

class ListNativeUsageRequest(_message.Message):
    __slots__ = ("task_id", "attempt_id", "after_sequence", "limit")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    AFTER_SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    after_sequence: int
    limit: int
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., after_sequence: _Optional[int] = ..., limit: _Optional[int] = ...) -> None: ...

class ListNativeUsageResponse(_message.Message):
    __slots__ = ("reports",)
    REPORTS_FIELD_NUMBER: _ClassVar[int]
    reports: _containers.RepeatedCompositeFieldContainer[HarnessUsageRequest]
    def __init__(self, reports: _Optional[_Iterable[_Union[HarnessUsageRequest, _Mapping]]] = ...) -> None: ...

class HarnessUsageRequest(_message.Message):
    __slots__ = ("sequence", "native_usage", "amount_minor", "currency", "estimated")
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    NATIVE_USAGE_FIELD_NUMBER: _ClassVar[int]
    AMOUNT_MINOR_FIELD_NUMBER: _ClassVar[int]
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    ESTIMATED_FIELD_NUMBER: _ClassVar[int]
    sequence: int
    native_usage: NativeTokenUsage
    amount_minor: int
    currency: str
    estimated: bool
    def __init__(self, sequence: _Optional[int] = ..., native_usage: _Optional[_Union[NativeTokenUsage, _Mapping]] = ..., amount_minor: _Optional[int] = ..., currency: _Optional[str] = ..., estimated: _Optional[bool] = ...) -> None: ...

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
    __slots__ = ("task_id", "attempt_id", "lease_token", "result", "succeeded", "objective_signal", "checkpoint_sha256", "workspace_delivery", "waiting_approval_ids", "artifacts")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    SUCCEEDED_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_SIGNAL_FIELD_NUMBER: _ClassVar[int]
    CHECKPOINT_SHA256_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_DELIVERY_FIELD_NUMBER: _ClassVar[int]
    WAITING_APPROVAL_IDS_FIELD_NUMBER: _ClassVar[int]
    ARTIFACTS_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    attempt_id: str
    lease_token: str
    result: str
    succeeded: bool
    objective_signal: ObjectiveSignal
    checkpoint_sha256: str
    workspace_delivery: WorkspaceDeliveryReference
    waiting_approval_ids: _containers.RepeatedScalarFieldContainer[str]
    artifacts: _containers.RepeatedCompositeFieldContainer[ArtifactSelection]
    def __init__(self, task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., lease_token: _Optional[str] = ..., result: _Optional[str] = ..., succeeded: _Optional[bool] = ..., objective_signal: _Optional[_Union[ObjectiveSignal, str]] = ..., checkpoint_sha256: _Optional[str] = ..., workspace_delivery: _Optional[_Union[WorkspaceDeliveryReference, _Mapping]] = ..., waiting_approval_ids: _Optional[_Iterable[str]] = ..., artifacts: _Optional[_Iterable[_Union[ArtifactSelection, _Mapping]]] = ...) -> None: ...

class HarnessAttachRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class AppliedExecutionLimits(_message.Message):
    __slots__ = ("limits", "native_agents", "reported_tokens", "reported_cost")
    LIMITS_FIELD_NUMBER: _ClassVar[int]
    NATIVE_AGENTS_FIELD_NUMBER: _ClassVar[int]
    REPORTED_TOKENS_FIELD_NUMBER: _ClassVar[int]
    REPORTED_COST_FIELD_NUMBER: _ClassVar[int]
    limits: ExecutionLimits
    native_agents: ExecutionLimitEnforcement
    reported_tokens: ExecutionLimitEnforcement
    reported_cost: ExecutionLimitEnforcement
    def __init__(self, limits: _Optional[_Union[ExecutionLimits, _Mapping]] = ..., native_agents: _Optional[_Union[ExecutionLimitEnforcement, str]] = ..., reported_tokens: _Optional[_Union[ExecutionLimitEnforcement, str]] = ..., reported_cost: _Optional[_Union[ExecutionLimitEnforcement, str]] = ...) -> None: ...

class ConfirmExecutionLimitsResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class AdapterBootstrap(_message.Message):
    __slots__ = ("endpoint", "token")
    ENDPOINT_FIELD_NUMBER: _ClassVar[int]
    TOKEN_FIELD_NUMBER: _ClassVar[int]
    endpoint: str
    token: str
    def __init__(self, endpoint: _Optional[str] = ..., token: _Optional[str] = ...) -> None: ...

class AttemptHistoryEntry(_message.Message):
    __slots__ = ("task_id", "prompt", "result")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    prompt: str
    result: str
    def __init__(self, task_id: _Optional[str] = ..., prompt: _Optional[str] = ..., result: _Optional[str] = ...) -> None: ...

class AttemptHistory(_message.Message):
    __slots__ = ("entries",)
    ENTRIES_FIELD_NUMBER: _ClassVar[int]
    entries: _containers.RepeatedCompositeFieldContainer[AttemptHistoryEntry]
    def __init__(self, entries: _Optional[_Iterable[_Union[AttemptHistoryEntry, _Mapping]]] = ...) -> None: ...

class HarnessRun(_message.Message):
    __slots__ = ("task", "attempt_id", "checkpoint", "may_ask_objective_question", "coordination", "resolved_skills", "history", "remote_workspace", "may_capture_artifacts", "shared_execution", "may_acquire_artifacts", "may_materialize_artifacts")
    TASK_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    CHECKPOINT_FIELD_NUMBER: _ClassVar[int]
    MAY_ASK_OBJECTIVE_QUESTION_FIELD_NUMBER: _ClassVar[int]
    COORDINATION_FIELD_NUMBER: _ClassVar[int]
    RESOLVED_SKILLS_FIELD_NUMBER: _ClassVar[int]
    HISTORY_FIELD_NUMBER: _ClassVar[int]
    REMOTE_WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    MAY_CAPTURE_ARTIFACTS_FIELD_NUMBER: _ClassVar[int]
    SHARED_EXECUTION_FIELD_NUMBER: _ClassVar[int]
    MAY_ACQUIRE_ARTIFACTS_FIELD_NUMBER: _ClassVar[int]
    MAY_MATERIALIZE_ARTIFACTS_FIELD_NUMBER: _ClassVar[int]
    task: Task
    attempt_id: str
    checkpoint: SessionCheckpoint
    may_ask_objective_question: bool
    coordination: AttemptCapabilities
    resolved_skills: _containers.RepeatedCompositeFieldContainer[ResolvedSkill]
    history: _containers.RepeatedCompositeFieldContainer[AttemptHistoryEntry]
    remote_workspace: bool
    may_capture_artifacts: bool
    shared_execution: SharedExecutionAccessSummary
    may_acquire_artifacts: bool
    may_materialize_artifacts: bool
    def __init__(self, task: _Optional[_Union[Task, _Mapping]] = ..., attempt_id: _Optional[str] = ..., checkpoint: _Optional[_Union[SessionCheckpoint, _Mapping]] = ..., may_ask_objective_question: _Optional[bool] = ..., coordination: _Optional[_Union[AttemptCapabilities, _Mapping]] = ..., resolved_skills: _Optional[_Iterable[_Union[ResolvedSkill, _Mapping]]] = ..., history: _Optional[_Iterable[_Union[AttemptHistoryEntry, _Mapping]]] = ..., remote_workspace: _Optional[bool] = ..., may_capture_artifacts: _Optional[bool] = ..., shared_execution: _Optional[_Union[SharedExecutionAccessSummary, _Mapping]] = ..., may_acquire_artifacts: _Optional[bool] = ..., may_materialize_artifacts: _Optional[bool] = ...) -> None: ...

class ContextContract(_message.Message):
    __slots__ = ("type", "version")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    type: str
    version: int
    def __init__(self, type: _Optional[str] = ..., version: _Optional[int] = ...) -> None: ...

class ContextPin(_message.Message):
    __slots__ = ("set_id", "item_id", "item_key", "reference", "version", "digest")
    SET_ID_FIELD_NUMBER: _ClassVar[int]
    ITEM_ID_FIELD_NUMBER: _ClassVar[int]
    ITEM_KEY_FIELD_NUMBER: _ClassVar[int]
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    DIGEST_FIELD_NUMBER: _ClassVar[int]
    set_id: str
    item_id: str
    item_key: str
    reference: str
    version: str
    digest: str
    def __init__(self, set_id: _Optional[str] = ..., item_id: _Optional[str] = ..., item_key: _Optional[str] = ..., reference: _Optional[str] = ..., version: _Optional[str] = ..., digest: _Optional[str] = ...) -> None: ...

class OmittedContextItem(_message.Message):
    __slots__ = ("set_id", "item_id", "item_key", "type", "version", "reason")
    SET_ID_FIELD_NUMBER: _ClassVar[int]
    ITEM_ID_FIELD_NUMBER: _ClassVar[int]
    ITEM_KEY_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    set_id: str
    item_id: str
    item_key: str
    type: str
    version: int
    reason: str
    def __init__(self, set_id: _Optional[str] = ..., item_id: _Optional[str] = ..., item_key: _Optional[str] = ..., type: _Optional[str] = ..., version: _Optional[int] = ..., reason: _Optional[str] = ...) -> None: ...

class ContextResolutionManifest(_message.Message):
    __slots__ = ("pins", "omissions")
    PINS_FIELD_NUMBER: _ClassVar[int]
    OMISSIONS_FIELD_NUMBER: _ClassVar[int]
    pins: _containers.RepeatedCompositeFieldContainer[ContextPin]
    omissions: _containers.RepeatedCompositeFieldContainer[OmittedContextItem]
    def __init__(self, pins: _Optional[_Iterable[_Union[ContextPin, _Mapping]]] = ..., omissions: _Optional[_Iterable[_Union[OmittedContextItem, _Mapping]]] = ...) -> None: ...

class ResolvedSkill(_message.Message):
    __slots__ = ("pin", "local_path")
    PIN_FIELD_NUMBER: _ClassVar[int]
    LOCAL_PATH_FIELD_NUMBER: _ClassVar[int]
    pin: ContextPin
    local_path: str
    def __init__(self, pin: _Optional[_Union[ContextPin, _Mapping]] = ..., local_path: _Optional[str] = ...) -> None: ...

class CommitContextResolutionRequest(_message.Message):
    __slots__ = ("attempt", "manifest")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    MANIFEST_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    manifest: ContextResolutionManifest
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., manifest: _Optional[_Union[ContextResolutionManifest, _Mapping]] = ...) -> None: ...

class SessionCheckpoint(_message.Message):
    __slots__ = ("harness", "format", "payload", "sha256")
    HARNESS_FIELD_NUMBER: _ClassVar[int]
    FORMAT_FIELD_NUMBER: _ClassVar[int]
    PAYLOAD_FIELD_NUMBER: _ClassVar[int]
    SHA256_FIELD_NUMBER: _ClassVar[int]
    harness: str
    format: str
    payload: bytes
    sha256: str
    def __init__(self, harness: _Optional[str] = ..., format: _Optional[str] = ..., payload: _Optional[bytes] = ..., sha256: _Optional[str] = ...) -> None: ...

class CheckpointReference(_message.Message):
    __slots__ = ("harness", "format", "byte_length", "sha256")
    HARNESS_FIELD_NUMBER: _ClassVar[int]
    FORMAT_FIELD_NUMBER: _ClassVar[int]
    BYTE_LENGTH_FIELD_NUMBER: _ClassVar[int]
    SHA256_FIELD_NUMBER: _ClassVar[int]
    harness: str
    format: str
    byte_length: int
    sha256: str
    def __init__(self, harness: _Optional[str] = ..., format: _Optional[str] = ..., byte_length: _Optional[int] = ..., sha256: _Optional[str] = ...) -> None: ...

class GetCheckpointResponse(_message.Message):
    __slots__ = ("reference",)
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    reference: CheckpointReference
    def __init__(self, reference: _Optional[_Union[CheckpointReference, _Mapping]] = ...) -> None: ...

class CommitCheckpointRequest(_message.Message):
    __slots__ = ("attempt", "reference")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    reference: CheckpointReference
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., reference: _Optional[_Union[CheckpointReference, _Mapping]] = ...) -> None: ...

class CheckpointUpload(_message.Message):
    __slots__ = ("begin", "chunk")
    BEGIN_FIELD_NUMBER: _ClassVar[int]
    CHUNK_FIELD_NUMBER: _ClassVar[int]
    begin: CommitCheckpointRequest
    chunk: bytes
    def __init__(self, begin: _Optional[_Union[CommitCheckpointRequest, _Mapping]] = ..., chunk: _Optional[bytes] = ...) -> None: ...

class CheckpointDownload(_message.Message):
    __slots__ = ("reference", "chunk")
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    CHUNK_FIELD_NUMBER: _ClassVar[int]
    reference: CheckpointReference
    chunk: bytes
    def __init__(self, reference: _Optional[_Union[CheckpointReference, _Mapping]] = ..., chunk: _Optional[bytes] = ...) -> None: ...

class WorkspaceSpec(_message.Message):
    __slots__ = ("workspace_id", "base_commit", "github_source", "mounts")
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    BASE_COMMIT_FIELD_NUMBER: _ClassVar[int]
    GITHUB_SOURCE_FIELD_NUMBER: _ClassVar[int]
    MOUNTS_FIELD_NUMBER: _ClassVar[int]
    workspace_id: str
    base_commit: str
    github_source: _github_workspaces_pb2.GithubWorkspace
    mounts: _containers.RepeatedCompositeFieldContainer[WorkspaceCopyMount]
    def __init__(self, workspace_id: _Optional[str] = ..., base_commit: _Optional[str] = ..., github_source: _Optional[_Union[_github_workspaces_pb2.GithubWorkspace, _Mapping]] = ..., mounts: _Optional[_Iterable[_Union[WorkspaceCopyMount, _Mapping]]] = ...) -> None: ...

class WorkspaceCopyMount(_message.Message):
    __slots__ = ("volume_id", "destination", "max_bytes", "volume")
    VOLUME_ID_FIELD_NUMBER: _ClassVar[int]
    DESTINATION_FIELD_NUMBER: _ClassVar[int]
    MAX_BYTES_FIELD_NUMBER: _ClassVar[int]
    VOLUME_FIELD_NUMBER: _ClassVar[int]
    volume_id: str
    destination: str
    max_bytes: int
    volume: WorkspaceVolume
    def __init__(self, volume_id: _Optional[str] = ..., destination: _Optional[str] = ..., max_bytes: _Optional[int] = ..., volume: _Optional[_Union[WorkspaceVolume, _Mapping]] = ...) -> None: ...

class WorkspaceMountCapability(_message.Message):
    __slots__ = ("volume_id", "source", "destination_root")
    VOLUME_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    DESTINATION_ROOT_FIELD_NUMBER: _ClassVar[int]
    volume_id: str
    source: str
    destination_root: str
    def __init__(self, volume_id: _Optional[str] = ..., source: _Optional[str] = ..., destination_root: _Optional[str] = ...) -> None: ...

class WorkspaceVolume(_message.Message):
    __slots__ = ("volume_id", "source", "revision")
    VOLUME_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    volume_id: str
    source: str
    revision: int
    def __init__(self, volume_id: _Optional[str] = ..., source: _Optional[str] = ..., revision: _Optional[int] = ...) -> None: ...

class GithubWorkspaceBundle(_message.Message):
    __slots__ = ("workspace", "bundle")
    WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    BUNDLE_FIELD_NUMBER: _ClassVar[int]
    workspace: _github_workspaces_pb2.GithubWorkspace
    bundle: BlobReference
    def __init__(self, workspace: _Optional[_Union[_github_workspaces_pb2.GithubWorkspace, _Mapping]] = ..., bundle: _Optional[_Union[BlobReference, _Mapping]] = ...) -> None: ...

class VerifyWorkspaceOutputRemoteRequest(_message.Message):
    __slots__ = ("attempt", "commit")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    COMMIT_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    commit: str
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., commit: _Optional[str] = ...) -> None: ...

class VerifyWorkspaceOutputRemoteResponse(_message.Message):
    __slots__ = ("remote",)
    REMOTE_FIELD_NUMBER: _ClassVar[int]
    remote: str
    def __init__(self, remote: _Optional[str] = ...) -> None: ...

class GithubWorkspaceDownload(_message.Message):
    __slots__ = ("reference", "chunk")
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    CHUNK_FIELD_NUMBER: _ClassVar[int]
    reference: GithubWorkspaceBundle
    chunk: bytes
    def __init__(self, reference: _Optional[_Union[GithubWorkspaceBundle, _Mapping]] = ..., chunk: _Optional[bytes] = ...) -> None: ...

class BlobReference(_message.Message):
    __slots__ = ("sha256", "byte_length")
    SHA256_FIELD_NUMBER: _ClassVar[int]
    BYTE_LENGTH_FIELD_NUMBER: _ClassVar[int]
    sha256: str
    byte_length: int
    def __init__(self, sha256: _Optional[str] = ..., byte_length: _Optional[int] = ...) -> None: ...

class WorkspaceDeliveryReference(_message.Message):
    __slots__ = ("workspace_id", "delivery_id", "base_commit", "start_commit", "head_commit", "committed", "changed_files", "patch", "bundle")
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_ID_FIELD_NUMBER: _ClassVar[int]
    BASE_COMMIT_FIELD_NUMBER: _ClassVar[int]
    START_COMMIT_FIELD_NUMBER: _ClassVar[int]
    HEAD_COMMIT_FIELD_NUMBER: _ClassVar[int]
    COMMITTED_FIELD_NUMBER: _ClassVar[int]
    CHANGED_FILES_FIELD_NUMBER: _ClassVar[int]
    PATCH_FIELD_NUMBER: _ClassVar[int]
    BUNDLE_FIELD_NUMBER: _ClassVar[int]
    workspace_id: str
    delivery_id: str
    base_commit: str
    start_commit: str
    head_commit: str
    committed: bool
    changed_files: int
    patch: BlobReference
    bundle: BlobReference
    def __init__(self, workspace_id: _Optional[str] = ..., delivery_id: _Optional[str] = ..., base_commit: _Optional[str] = ..., start_commit: _Optional[str] = ..., head_commit: _Optional[str] = ..., committed: _Optional[bool] = ..., changed_files: _Optional[int] = ..., patch: _Optional[_Union[BlobReference, _Mapping]] = ..., bundle: _Optional[_Union[BlobReference, _Mapping]] = ...) -> None: ...

class WorkspaceDeliveryRequest(_message.Message):
    __slots__ = ("attempt", "delivery")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    delivery: WorkspaceDeliveryReference
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., delivery: _Optional[_Union[WorkspaceDeliveryReference, _Mapping]] = ...) -> None: ...

class WorkspaceContinuation(_message.Message):
    __slots__ = ("delivery",)
    DELIVERY_FIELD_NUMBER: _ClassVar[int]
    delivery: WorkspaceDeliveryReference
    def __init__(self, delivery: _Optional[_Union[WorkspaceDeliveryReference, _Mapping]] = ...) -> None: ...

class WorkspaceUpload(_message.Message):
    __slots__ = ("begin", "patch_chunk", "bundle_chunk")
    BEGIN_FIELD_NUMBER: _ClassVar[int]
    PATCH_CHUNK_FIELD_NUMBER: _ClassVar[int]
    BUNDLE_CHUNK_FIELD_NUMBER: _ClassVar[int]
    begin: WorkspaceDeliveryRequest
    patch_chunk: bytes
    bundle_chunk: bytes
    def __init__(self, begin: _Optional[_Union[WorkspaceDeliveryRequest, _Mapping]] = ..., patch_chunk: _Optional[bytes] = ..., bundle_chunk: _Optional[bytes] = ...) -> None: ...

class WorkspaceDownload(_message.Message):
    __slots__ = ("reference", "chunk")
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    CHUNK_FIELD_NUMBER: _ClassVar[int]
    reference: WorkspaceDeliveryReference
    chunk: bytes
    def __init__(self, reference: _Optional[_Union[WorkspaceDeliveryReference, _Mapping]] = ..., chunk: _Optional[bytes] = ...) -> None: ...

class GetWorkspaceArtifactRequest(_message.Message):
    __slots__ = ("task_id", "kind")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    kind: WorkspaceArtifactKind
    def __init__(self, task_id: _Optional[str] = ..., kind: _Optional[_Union[WorkspaceArtifactKind, str]] = ...) -> None: ...

class GetReviewArtifactRequest(_message.Message):
    __slots__ = ("attempt", "review_id")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    REVIEW_ID_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    review_id: str
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., review_id: _Optional[str] = ...) -> None: ...

class HarnessPublishRequest(_message.Message):
    __slots__ = ("sequence", "text")
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    sequence: int
    text: str
    def __init__(self, sequence: _Optional[int] = ..., text: _Optional[str] = ...) -> None: ...

class HarnessCompleteRequest(_message.Message):
    __slots__ = ("result", "succeeded", "objective_signal", "checkpoint", "waiting_approval_ids")
    RESULT_FIELD_NUMBER: _ClassVar[int]
    SUCCEEDED_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_SIGNAL_FIELD_NUMBER: _ClassVar[int]
    CHECKPOINT_FIELD_NUMBER: _ClassVar[int]
    WAITING_APPROVAL_IDS_FIELD_NUMBER: _ClassVar[int]
    result: str
    succeeded: bool
    objective_signal: ObjectiveSignal
    checkpoint: SessionCheckpoint
    waiting_approval_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, result: _Optional[str] = ..., succeeded: _Optional[bool] = ..., objective_signal: _Optional[_Union[ObjectiveSignal, str]] = ..., checkpoint: _Optional[_Union[SessionCheckpoint, _Mapping]] = ..., waiting_approval_ids: _Optional[_Iterable[str]] = ...) -> None: ...

class HarnessCompleteResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class CreateObjectiveRequest(_message.Message):
    __slots__ = ("operation_id", "objective_id", "owner_tag_id", "outcome", "ongoing", "deadline_ms", "budget_limit_minor", "budget_currency", "team_id", "runtime_actions")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    OWNER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    ONGOING_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_MS_FIELD_NUMBER: _ClassVar[int]
    BUDGET_LIMIT_MINOR_FIELD_NUMBER: _ClassVar[int]
    BUDGET_CURRENCY_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    objective_id: str
    owner_tag_id: str
    outcome: str
    ongoing: bool
    deadline_ms: int
    budget_limit_minor: int
    budget_currency: str
    team_id: str
    runtime_actions: RuntimeActions
    def __init__(self, operation_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., owner_tag_id: _Optional[str] = ..., outcome: _Optional[str] = ..., ongoing: _Optional[bool] = ..., deadline_ms: _Optional[int] = ..., budget_limit_minor: _Optional[int] = ..., budget_currency: _Optional[str] = ..., team_id: _Optional[str] = ..., runtime_actions: _Optional[_Union[RuntimeActions, _Mapping]] = ...) -> None: ...

class RuntimeActions(_message.Message):
    __slots__ = ("actions",)
    ACTIONS_FIELD_NUMBER: _ClassVar[int]
    actions: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, actions: _Optional[_Iterable[str]] = ...) -> None: ...

class Objective(_message.Message):
    __slots__ = ("objective_id", "owner_tag_id", "session_id", "outcome", "ongoing", "starting_task_id", "status", "revision", "deadline_ms", "budget_limit_minor", "budget_currency", "paused_at_ms", "reported_spend_minor", "team_id", "runtime_actions")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    OWNER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    ONGOING_FIELD_NUMBER: _ClassVar[int]
    STARTING_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_MS_FIELD_NUMBER: _ClassVar[int]
    BUDGET_LIMIT_MINOR_FIELD_NUMBER: _ClassVar[int]
    BUDGET_CURRENCY_FIELD_NUMBER: _ClassVar[int]
    PAUSED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    REPORTED_SPEND_MINOR_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    owner_tag_id: str
    session_id: str
    outcome: str
    ongoing: bool
    starting_task_id: str
    status: ObjectiveStatus
    revision: int
    deadline_ms: int
    budget_limit_minor: int
    budget_currency: str
    paused_at_ms: int
    reported_spend_minor: int
    team_id: str
    runtime_actions: RuntimeActions
    def __init__(self, objective_id: _Optional[str] = ..., owner_tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., outcome: _Optional[str] = ..., ongoing: _Optional[bool] = ..., starting_task_id: _Optional[str] = ..., status: _Optional[_Union[ObjectiveStatus, str]] = ..., revision: _Optional[int] = ..., deadline_ms: _Optional[int] = ..., budget_limit_minor: _Optional[int] = ..., budget_currency: _Optional[str] = ..., paused_at_ms: _Optional[int] = ..., reported_spend_minor: _Optional[int] = ..., team_id: _Optional[str] = ..., runtime_actions: _Optional[_Union[RuntimeActions, _Mapping]] = ...) -> None: ...

class Team(_message.Message):
    __slots__ = ("team_id", "name", "member_tag_ids", "max_concurrency", "revision", "created_at_ms", "updated_at_ms")
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    MEMBER_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    MAX_CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    UPDATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    team_id: str
    name: str
    member_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    max_concurrency: int
    revision: int
    created_at_ms: int
    updated_at_ms: int
    def __init__(self, team_id: _Optional[str] = ..., name: _Optional[str] = ..., member_tag_ids: _Optional[_Iterable[str]] = ..., max_concurrency: _Optional[int] = ..., revision: _Optional[int] = ..., created_at_ms: _Optional[int] = ..., updated_at_ms: _Optional[int] = ...) -> None: ...

class CreateTeamRequest(_message.Message):
    __slots__ = ("operation_id", "team_id", "name", "member_tag_ids", "max_concurrency")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    MEMBER_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    MAX_CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    team_id: str
    name: str
    member_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    max_concurrency: int
    def __init__(self, operation_id: _Optional[str] = ..., team_id: _Optional[str] = ..., name: _Optional[str] = ..., member_tag_ids: _Optional[_Iterable[str]] = ..., max_concurrency: _Optional[int] = ...) -> None: ...

class GetTeamRequest(_message.Message):
    __slots__ = ("team",)
    TEAM_FIELD_NUMBER: _ClassVar[int]
    team: str
    def __init__(self, team: _Optional[str] = ...) -> None: ...

class ListTeamsRequest(_message.Message):
    __slots__ = ("member_tag_id", "limit", "cursor")
    MEMBER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    member_tag_id: str
    limit: int
    cursor: str
    def __init__(self, member_tag_id: _Optional[str] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListTeamsResponse(_message.Message):
    __slots__ = ("teams", "next_cursor")
    TEAMS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    teams: _containers.RepeatedCompositeFieldContainer[Team]
    next_cursor: str
    def __init__(self, teams: _Optional[_Iterable[_Union[Team, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class TeamMembers(_message.Message):
    __slots__ = ("tag_ids",)
    TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    tag_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, tag_ids: _Optional[_Iterable[str]] = ...) -> None: ...

class UpdateTeamRequest(_message.Message):
    __slots__ = ("operation_id", "team", "expected_revision", "name", "members", "max_concurrency")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TEAM_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    MEMBERS_FIELD_NUMBER: _ClassVar[int]
    MAX_CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    team: str
    expected_revision: int
    name: str
    members: TeamMembers
    max_concurrency: int
    def __init__(self, operation_id: _Optional[str] = ..., team: _Optional[str] = ..., expected_revision: _Optional[int] = ..., name: _Optional[str] = ..., members: _Optional[_Union[TeamMembers, _Mapping]] = ..., max_concurrency: _Optional[int] = ...) -> None: ...

class DeleteTeamRequest(_message.Message):
    __slots__ = ("operation_id", "team")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TEAM_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    team: str
    def __init__(self, operation_id: _Optional[str] = ..., team: _Optional[str] = ...) -> None: ...

class WorkstreamPost(_message.Message):
    __slots__ = ("post_id", "team_id", "author_tag_id", "to_tag_ids", "body", "source_task_id", "sequence", "created_at_ms")
    POST_ID_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    AUTHOR_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    TO_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    BODY_FIELD_NUMBER: _ClassVar[int]
    SOURCE_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    post_id: str
    team_id: str
    author_tag_id: str
    to_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    body: str
    source_task_id: str
    sequence: int
    created_at_ms: int
    def __init__(self, post_id: _Optional[str] = ..., team_id: _Optional[str] = ..., author_tag_id: _Optional[str] = ..., to_tag_ids: _Optional[_Iterable[str]] = ..., body: _Optional[str] = ..., source_task_id: _Optional[str] = ..., sequence: _Optional[int] = ..., created_at_ms: _Optional[int] = ...) -> None: ...

class ListWorkstreamPostsRequest(_message.Message):
    __slots__ = ("team", "after_sequence", "limit", "cursor")
    TEAM_FIELD_NUMBER: _ClassVar[int]
    AFTER_SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    team: str
    after_sequence: int
    limit: int
    cursor: str
    def __init__(self, team: _Optional[str] = ..., after_sequence: _Optional[int] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListWorkstreamPostsResponse(_message.Message):
    __slots__ = ("posts", "next_cursor")
    POSTS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    posts: _containers.RepeatedCompositeFieldContainer[WorkstreamPost]
    next_cursor: str
    def __init__(self, posts: _Optional[_Iterable[_Union[WorkstreamPost, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class ReadAttemptWorkstreamRequest(_message.Message):
    __slots__ = ("attempt", "after_sequence", "limit", "cursor")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    AFTER_SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    after_sequence: int
    limit: int
    cursor: str
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., after_sequence: _Optional[int] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ReadAttemptWorkstreamResponse(_message.Message):
    __slots__ = ("team", "page")
    TEAM_FIELD_NUMBER: _ClassVar[int]
    PAGE_FIELD_NUMBER: _ClassVar[int]
    team: Team
    page: ListWorkstreamPostsResponse
    def __init__(self, team: _Optional[_Union[Team, _Mapping]] = ..., page: _Optional[_Union[ListWorkstreamPostsResponse, _Mapping]] = ...) -> None: ...

class PostAttemptWorkstreamRequest(_message.Message):
    __slots__ = ("attempt", "operation_id", "body", "to_tag_ids")
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    BODY_FIELD_NUMBER: _ClassVar[int]
    TO_TAG_IDS_FIELD_NUMBER: _ClassVar[int]
    attempt: InspectAttemptRequest
    operation_id: str
    body: str
    to_tag_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, attempt: _Optional[_Union[InspectAttemptRequest, _Mapping]] = ..., operation_id: _Optional[str] = ..., body: _Optional[str] = ..., to_tag_ids: _Optional[_Iterable[str]] = ...) -> None: ...

class PostAttemptWorkstreamResponse(_message.Message):
    __slots__ = ("post", "duplicate", "approval")
    POST_FIELD_NUMBER: _ClassVar[int]
    DUPLICATE_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_FIELD_NUMBER: _ClassVar[int]
    post: WorkstreamPost
    duplicate: bool
    approval: Approval
    def __init__(self, post: _Optional[_Union[WorkstreamPost, _Mapping]] = ..., duplicate: _Optional[bool] = ..., approval: _Optional[_Union[Approval, _Mapping]] = ...) -> None: ...

class GetObjectiveRequest(_message.Message):
    __slots__ = ("objective_id",)
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    def __init__(self, objective_id: _Optional[str] = ...) -> None: ...

class ListObjectivesRequest(_message.Message):
    __slots__ = ("limit", "after_id")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    AFTER_ID_FIELD_NUMBER: _ClassVar[int]
    limit: int
    after_id: str
    def __init__(self, limit: _Optional[int] = ..., after_id: _Optional[str] = ...) -> None: ...

class ListObjectivesResponse(_message.Message):
    __slots__ = ("objectives",)
    OBJECTIVES_FIELD_NUMBER: _ClassVar[int]
    objectives: _containers.RepeatedCompositeFieldContainer[Objective]
    def __init__(self, objectives: _Optional[_Iterable[_Union[Objective, _Mapping]]] = ...) -> None: ...

class ListObjectiveCommitReviewsRequest(_message.Message):
    __slots__ = ("objective_id", "limit", "before_order")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    limit: int
    before_order: int
    def __init__(self, objective_id: _Optional[str] = ..., limit: _Optional[int] = ..., before_order: _Optional[int] = ...) -> None: ...

class ListObjectiveCommitReviewsResponse(_message.Message):
    __slots__ = ("reviews", "next_before_order")
    REVIEWS_FIELD_NUMBER: _ClassVar[int]
    NEXT_BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    reviews: _containers.RepeatedCompositeFieldContainer[CommitReview]
    next_before_order: int
    def __init__(self, reviews: _Optional[_Iterable[_Union[CommitReview, _Mapping]]] = ..., next_before_order: _Optional[int] = ...) -> None: ...

class SetObjectiveLimitsRequest(_message.Message):
    __slots__ = ("objective_id", "operation_id", "deadline_ms", "clear_deadline", "budget_limit_minor", "budget_currency", "clear_budget", "expected_revision")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_MS_FIELD_NUMBER: _ClassVar[int]
    CLEAR_DEADLINE_FIELD_NUMBER: _ClassVar[int]
    BUDGET_LIMIT_MINOR_FIELD_NUMBER: _ClassVar[int]
    BUDGET_CURRENCY_FIELD_NUMBER: _ClassVar[int]
    CLEAR_BUDGET_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    operation_id: str
    deadline_ms: int
    clear_deadline: bool
    budget_limit_minor: int
    budget_currency: str
    clear_budget: bool
    expected_revision: int
    def __init__(self, objective_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., deadline_ms: _Optional[int] = ..., clear_deadline: _Optional[bool] = ..., budget_limit_minor: _Optional[int] = ..., budget_currency: _Optional[str] = ..., clear_budget: _Optional[bool] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class SetObjectiveRuntimeActionsRequest(_message.Message):
    __slots__ = ("objective_id", "operation_id", "expected_revision", "runtime_actions")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    operation_id: str
    expected_revision: int
    runtime_actions: RuntimeActions
    def __init__(self, objective_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., expected_revision: _Optional[int] = ..., runtime_actions: _Optional[_Union[RuntimeActions, _Mapping]] = ...) -> None: ...

class ObjectiveActionRequest(_message.Message):
    __slots__ = ("objective_id", "operation_id", "reason")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    operation_id: str
    reason: str
    def __init__(self, objective_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., reason: _Optional[str] = ...) -> None: ...

class ReviewObjectiveRequest(_message.Message):
    __slots__ = ("objective_id", "operation_id", "approved", "feedback")
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    APPROVED_FIELD_NUMBER: _ClassVar[int]
    FEEDBACK_FIELD_NUMBER: _ClassVar[int]
    objective_id: str
    operation_id: str
    approved: bool
    feedback: str
    def __init__(self, objective_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., approved: _Optional[bool] = ..., feedback: _Optional[str] = ...) -> None: ...

class ReplyDestination(_message.Message):
    __slots__ = ("conversation_id", "thread_id")
    CONVERSATION_ID_FIELD_NUMBER: _ClassVar[int]
    THREAD_ID_FIELD_NUMBER: _ClassVar[int]
    conversation_id: str
    thread_id: str
    def __init__(self, conversation_id: _Optional[str] = ..., thread_id: _Optional[str] = ...) -> None: ...

class AcceptEventRequest(_message.Message):
    __slots__ = ("account_id", "event_id", "tag_id", "session_id", "prompt", "destination", "requested_execution")
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    EVENT_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    DESTINATION_FIELD_NUMBER: _ClassVar[int]
    REQUESTED_EXECUTION_FIELD_NUMBER: _ClassVar[int]
    account_id: str
    event_id: str
    tag_id: str
    session_id: str
    prompt: str
    destination: ReplyDestination
    requested_execution: ExecutionSelection
    def __init__(self, account_id: _Optional[str] = ..., event_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., prompt: _Optional[str] = ..., destination: _Optional[_Union[ReplyDestination, _Mapping]] = ..., requested_execution: _Optional[_Union[ExecutionSelection, _Mapping]] = ...) -> None: ...

class AcceptSlackEventRequest(_message.Message):
    __slots__ = ("account_id", "event_id", "team_id", "channel_id", "message_ts", "thread_ts", "prompt", "mention_tag_id")
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    EVENT_ID_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_TS_FIELD_NUMBER: _ClassVar[int]
    THREAD_TS_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    MENTION_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    account_id: str
    event_id: str
    team_id: str
    channel_id: str
    message_ts: str
    thread_ts: str
    prompt: str
    mention_tag_id: str
    def __init__(self, account_id: _Optional[str] = ..., event_id: _Optional[str] = ..., team_id: _Optional[str] = ..., channel_id: _Optional[str] = ..., message_ts: _Optional[str] = ..., thread_ts: _Optional[str] = ..., prompt: _Optional[str] = ..., mention_tag_id: _Optional[str] = ...) -> None: ...

class AcceptSlackEventResponse(_message.Message):
    __slots__ = ("task",)
    TASK_FIELD_NUMBER: _ClassVar[int]
    task: Task
    def __init__(self, task: _Optional[_Union[Task, _Mapping]] = ...) -> None: ...

class AcceptGithubEventRequest(_message.Message):
    __slots__ = ("account_id", "delivery_id", "repository_id", "repository", "number", "source_id", "kind", "action", "prompt", "tag_id", "is_pull_request")
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_ID_FIELD_NUMBER: _ClassVar[int]
    REPOSITORY_ID_FIELD_NUMBER: _ClassVar[int]
    REPOSITORY_FIELD_NUMBER: _ClassVar[int]
    NUMBER_FIELD_NUMBER: _ClassVar[int]
    SOURCE_ID_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    IS_PULL_REQUEST_FIELD_NUMBER: _ClassVar[int]
    account_id: str
    delivery_id: str
    repository_id: int
    repository: str
    number: int
    source_id: int
    kind: GithubEventKind
    action: GithubEventAction
    prompt: str
    tag_id: str
    is_pull_request: bool
    def __init__(self, account_id: _Optional[str] = ..., delivery_id: _Optional[str] = ..., repository_id: _Optional[int] = ..., repository: _Optional[str] = ..., number: _Optional[int] = ..., source_id: _Optional[int] = ..., kind: _Optional[_Union[GithubEventKind, str]] = ..., action: _Optional[_Union[GithubEventAction, str]] = ..., prompt: _Optional[str] = ..., tag_id: _Optional[str] = ..., is_pull_request: _Optional[bool] = ...) -> None: ...

class AcceptGithubEventResponse(_message.Message):
    __slots__ = ("task",)
    TASK_FIELD_NUMBER: _ClassVar[int]
    task: Task
    def __init__(self, task: _Optional[_Union[Task, _Mapping]] = ...) -> None: ...

class AcceptLinearEventRequest(_message.Message):
    __slots__ = ("account_id", "delivery_id", "workspace_id", "team_id", "issue_id", "source_id", "kind", "action", "prompt", "tag_id")
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    ISSUE_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_ID_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    account_id: str
    delivery_id: str
    workspace_id: str
    team_id: str
    issue_id: str
    source_id: str
    kind: LinearEventKind
    action: LinearEventAction
    prompt: str
    tag_id: str
    def __init__(self, account_id: _Optional[str] = ..., delivery_id: _Optional[str] = ..., workspace_id: _Optional[str] = ..., team_id: _Optional[str] = ..., issue_id: _Optional[str] = ..., source_id: _Optional[str] = ..., kind: _Optional[_Union[LinearEventKind, str]] = ..., action: _Optional[_Union[LinearEventAction, str]] = ..., prompt: _Optional[str] = ..., tag_id: _Optional[str] = ...) -> None: ...

class AcceptLinearEventResponse(_message.Message):
    __slots__ = ("task",)
    TASK_FIELD_NUMBER: _ClassVar[int]
    task: Task
    def __init__(self, task: _Optional[_Union[Task, _Mapping]] = ...) -> None: ...

class AcceptLarkEventRequest(_message.Message):
    __slots__ = ("account_id", "domain", "app_id", "tenant_key", "event_id", "chat_id", "message_id", "root_message_id", "actor_id", "prompt", "mention_tag_id", "direct")
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    DOMAIN_FIELD_NUMBER: _ClassVar[int]
    APP_ID_FIELD_NUMBER: _ClassVar[int]
    TENANT_KEY_FIELD_NUMBER: _ClassVar[int]
    EVENT_ID_FIELD_NUMBER: _ClassVar[int]
    CHAT_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    ROOT_MESSAGE_ID_FIELD_NUMBER: _ClassVar[int]
    ACTOR_ID_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    MENTION_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    DIRECT_FIELD_NUMBER: _ClassVar[int]
    account_id: str
    domain: LarkDomain
    app_id: str
    tenant_key: str
    event_id: str
    chat_id: str
    message_id: str
    root_message_id: str
    actor_id: str
    prompt: str
    mention_tag_id: str
    direct: bool
    def __init__(self, account_id: _Optional[str] = ..., domain: _Optional[_Union[LarkDomain, str]] = ..., app_id: _Optional[str] = ..., tenant_key: _Optional[str] = ..., event_id: _Optional[str] = ..., chat_id: _Optional[str] = ..., message_id: _Optional[str] = ..., root_message_id: _Optional[str] = ..., actor_id: _Optional[str] = ..., prompt: _Optional[str] = ..., mention_tag_id: _Optional[str] = ..., direct: _Optional[bool] = ...) -> None: ...

class AcceptLarkEventResponse(_message.Message):
    __slots__ = ("task",)
    TASK_FIELD_NUMBER: _ClassVar[int]
    task: Task
    def __init__(self, task: _Optional[_Union[Task, _Mapping]] = ...) -> None: ...

class AcceptMicrosoftTeamsActivityRequest(_message.Message):
    __slots__ = ("account_id", "app_id", "tenant_id", "team_id", "channel_id", "conversation_id", "activity_id", "root_activity_id", "actor_id", "service_url", "prompt", "tag_id")
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    APP_ID_FIELD_NUMBER: _ClassVar[int]
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_ID_FIELD_NUMBER: _ClassVar[int]
    ACTIVITY_ID_FIELD_NUMBER: _ClassVar[int]
    ROOT_ACTIVITY_ID_FIELD_NUMBER: _ClassVar[int]
    ACTOR_ID_FIELD_NUMBER: _ClassVar[int]
    SERVICE_URL_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    account_id: str
    app_id: str
    tenant_id: str
    team_id: str
    channel_id: str
    conversation_id: str
    activity_id: str
    root_activity_id: str
    actor_id: str
    service_url: str
    prompt: str
    tag_id: str
    def __init__(self, account_id: _Optional[str] = ..., app_id: _Optional[str] = ..., tenant_id: _Optional[str] = ..., team_id: _Optional[str] = ..., channel_id: _Optional[str] = ..., conversation_id: _Optional[str] = ..., activity_id: _Optional[str] = ..., root_activity_id: _Optional[str] = ..., actor_id: _Optional[str] = ..., service_url: _Optional[str] = ..., prompt: _Optional[str] = ..., tag_id: _Optional[str] = ...) -> None: ...

class AcceptMicrosoftTeamsActivityResponse(_message.Message):
    __slots__ = ("task",)
    TASK_FIELD_NUMBER: _ClassVar[int]
    task: Task
    def __init__(self, task: _Optional[_Union[Task, _Mapping]] = ...) -> None: ...

class GetMicrosoftTeamsReplyRouteRequest(_message.Message):
    __slots__ = ("reply_id", "lease_token")
    REPLY_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    reply_id: str
    lease_token: str
    def __init__(self, reply_id: _Optional[str] = ..., lease_token: _Optional[str] = ...) -> None: ...

class MicrosoftTeamsReplyRoute(_message.Message):
    __slots__ = ("service_url", "conversation_id", "root_activity_id", "app_id", "tenant_id", "team_id", "channel_id")
    SERVICE_URL_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_ID_FIELD_NUMBER: _ClassVar[int]
    ROOT_ACTIVITY_ID_FIELD_NUMBER: _ClassVar[int]
    APP_ID_FIELD_NUMBER: _ClassVar[int]
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    service_url: str
    conversation_id: str
    root_activity_id: str
    app_id: str
    tenant_id: str
    team_id: str
    channel_id: str
    def __init__(self, service_url: _Optional[str] = ..., conversation_id: _Optional[str] = ..., root_activity_id: _Optional[str] = ..., app_id: _Optional[str] = ..., tenant_id: _Optional[str] = ..., team_id: _Optional[str] = ..., channel_id: _Optional[str] = ...) -> None: ...

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

class RenewReplyRequest(_message.Message):
    __slots__ = ("reply_id", "lease_token")
    REPLY_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    reply_id: str
    lease_token: str
    def __init__(self, reply_id: _Optional[str] = ..., lease_token: _Optional[str] = ...) -> None: ...

class ReplyLease(_message.Message):
    __slots__ = ("valid_for_ms",)
    VALID_FOR_MS_FIELD_NUMBER: _ClassVar[int]
    valid_for_ms: int
    def __init__(self, valid_for_ms: _Optional[int] = ...) -> None: ...

class GetReplyDeliveryRequest(_message.Message):
    __slots__ = ("reply_id",)
    REPLY_ID_FIELD_NUMBER: _ClassVar[int]
    reply_id: str
    def __init__(self, reply_id: _Optional[str] = ...) -> None: ...

class ReplyDeliveryAudit(_message.Message):
    __slots__ = ("kind", "principal", "evidence", "recorded_at_ms", "state", "provider_receipt")
    KIND_FIELD_NUMBER: _ClassVar[int]
    PRINCIPAL_FIELD_NUMBER: _ClassVar[int]
    EVIDENCE_FIELD_NUMBER: _ClassVar[int]
    RECORDED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_RECEIPT_FIELD_NUMBER: _ClassVar[int]
    kind: str
    principal: str
    evidence: str
    recorded_at_ms: int
    state: ReplyState
    provider_receipt: str
    def __init__(self, kind: _Optional[str] = ..., principal: _Optional[str] = ..., evidence: _Optional[str] = ..., recorded_at_ms: _Optional[int] = ..., state: _Optional[_Union[ReplyState, str]] = ..., provider_receipt: _Optional[str] = ...) -> None: ...

class ReplyDelivery(_message.Message):
    __slots__ = ("reply", "lease_expires_at_ms", "audit")
    REPLY_FIELD_NUMBER: _ClassVar[int]
    LEASE_EXPIRES_AT_MS_FIELD_NUMBER: _ClassVar[int]
    AUDIT_FIELD_NUMBER: _ClassVar[int]
    reply: Reply
    lease_expires_at_ms: int
    audit: _containers.RepeatedCompositeFieldContainer[ReplyDeliveryAudit]
    def __init__(self, reply: _Optional[_Union[Reply, _Mapping]] = ..., lease_expires_at_ms: _Optional[int] = ..., audit: _Optional[_Iterable[_Union[ReplyDeliveryAudit, _Mapping]]] = ...) -> None: ...

class ListReplyDeliveriesRequest(_message.Message):
    __slots__ = ("account_id", "state", "limit", "before_order")
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    account_id: str
    state: ReplyState
    limit: int
    before_order: int
    def __init__(self, account_id: _Optional[str] = ..., state: _Optional[_Union[ReplyState, str]] = ..., limit: _Optional[int] = ..., before_order: _Optional[int] = ...) -> None: ...

class ListReplyDeliveriesResponse(_message.Message):
    __slots__ = ("deliveries", "next_before_order")
    DELIVERIES_FIELD_NUMBER: _ClassVar[int]
    NEXT_BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    deliveries: _containers.RepeatedCompositeFieldContainer[ReplyDelivery]
    next_before_order: int
    def __init__(self, deliveries: _Optional[_Iterable[_Union[ReplyDelivery, _Mapping]]] = ..., next_before_order: _Optional[int] = ...) -> None: ...

class ResolveReplyRequest(_message.Message):
    __slots__ = ("reply_id", "operation_id", "state", "provider_receipt", "evidence")
    REPLY_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_RECEIPT_FIELD_NUMBER: _ClassVar[int]
    EVIDENCE_FIELD_NUMBER: _ClassVar[int]
    reply_id: str
    operation_id: str
    state: ReplyState
    provider_receipt: str
    evidence: str
    def __init__(self, reply_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., state: _Optional[_Union[ReplyState, str]] = ..., provider_receipt: _Optional[str] = ..., evidence: _Optional[str] = ...) -> None: ...

class ArtifactPublicationPin(_message.Message):
    __slots__ = ("publication_id", "publication_revision", "consumption_id", "consumption_revision", "source_objective_id", "destination_objective_id")
    PUBLICATION_ID_FIELD_NUMBER: _ClassVar[int]
    PUBLICATION_REVISION_FIELD_NUMBER: _ClassVar[int]
    CONSUMPTION_ID_FIELD_NUMBER: _ClassVar[int]
    CONSUMPTION_REVISION_FIELD_NUMBER: _ClassVar[int]
    SOURCE_OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    DESTINATION_OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    publication_id: str
    publication_revision: int
    consumption_id: str
    consumption_revision: int
    source_objective_id: str
    destination_objective_id: str
    def __init__(self, publication_id: _Optional[str] = ..., publication_revision: _Optional[int] = ..., consumption_id: _Optional[str] = ..., consumption_revision: _Optional[int] = ..., source_objective_id: _Optional[str] = ..., destination_objective_id: _Optional[str] = ...) -> None: ...
