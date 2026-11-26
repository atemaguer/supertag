from supertag.runtime.v2 import runtime_pb2 as _runtime_pb2
from supertag.runtime.v2 import workspaces_pb2 as _workspaces_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class WorkspaceLandingMode(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WORKSPACE_LANDING_MODE_UNSPECIFIED: _ClassVar[WorkspaceLandingMode]
    WORKSPACE_LANDING_MODE_BRANCH: _ClassVar[WorkspaceLandingMode]
    WORKSPACE_LANDING_MODE_MERGE: _ClassVar[WorkspaceLandingMode]
    WORKSPACE_LANDING_MODE_REVIEW: _ClassVar[WorkspaceLandingMode]

class WorkspaceLandingState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WORKSPACE_LANDING_STATE_UNSPECIFIED: _ClassVar[WorkspaceLandingState]
    WORKSPACE_LANDING_STATE_QUEUED: _ClassVar[WorkspaceLandingState]
    WORKSPACE_LANDING_STATE_CLAIMED: _ClassVar[WorkspaceLandingState]
    WORKSPACE_LANDING_STATE_LANDED: _ClassVar[WorkspaceLandingState]
    WORKSPACE_LANDING_STATE_CONFLICT: _ClassVar[WorkspaceLandingState]
    WORKSPACE_LANDING_STATE_HELD: _ClassVar[WorkspaceLandingState]
    WORKSPACE_LANDING_STATE_SUPERSEDED: _ClassVar[WorkspaceLandingState]
WORKSPACE_LANDING_MODE_UNSPECIFIED: WorkspaceLandingMode
WORKSPACE_LANDING_MODE_BRANCH: WorkspaceLandingMode
WORKSPACE_LANDING_MODE_MERGE: WorkspaceLandingMode
WORKSPACE_LANDING_MODE_REVIEW: WorkspaceLandingMode
WORKSPACE_LANDING_STATE_UNSPECIFIED: WorkspaceLandingState
WORKSPACE_LANDING_STATE_QUEUED: WorkspaceLandingState
WORKSPACE_LANDING_STATE_CLAIMED: WorkspaceLandingState
WORKSPACE_LANDING_STATE_LANDED: WorkspaceLandingState
WORKSPACE_LANDING_STATE_CONFLICT: WorkspaceLandingState
WORKSPACE_LANDING_STATE_HELD: WorkspaceLandingState
WORKSPACE_LANDING_STATE_SUPERSEDED: WorkspaceLandingState

class WorkspaceLanding(_message.Message):
    __slots__ = ("landing_id", "task_id", "tag_id", "session_id", "workspace_id", "remote", "mode", "branch", "target", "delivery", "state", "reason", "landed_commit", "target_commit", "conflicts", "follow_up_task_id", "created_order", "author_name", "author_email", "co_author", "title", "body", "pull_request")
    LANDING_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    REMOTE_FIELD_NUMBER: _ClassVar[int]
    MODE_FIELD_NUMBER: _ClassVar[int]
    BRANCH_FIELD_NUMBER: _ClassVar[int]
    TARGET_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    LANDED_COMMIT_FIELD_NUMBER: _ClassVar[int]
    TARGET_COMMIT_FIELD_NUMBER: _ClassVar[int]
    CONFLICTS_FIELD_NUMBER: _ClassVar[int]
    FOLLOW_UP_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    CREATED_ORDER_FIELD_NUMBER: _ClassVar[int]
    AUTHOR_NAME_FIELD_NUMBER: _ClassVar[int]
    AUTHOR_EMAIL_FIELD_NUMBER: _ClassVar[int]
    CO_AUTHOR_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    BODY_FIELD_NUMBER: _ClassVar[int]
    PULL_REQUEST_FIELD_NUMBER: _ClassVar[int]
    landing_id: str
    task_id: str
    tag_id: str
    session_id: str
    workspace_id: str
    remote: str
    mode: WorkspaceLandingMode
    branch: str
    target: str
    delivery: _runtime_pb2.WorkspaceDeliveryReference
    state: WorkspaceLandingState
    reason: str
    landed_commit: str
    target_commit: str
    conflicts: _containers.RepeatedScalarFieldContainer[str]
    follow_up_task_id: str
    created_order: int
    author_name: str
    author_email: str
    co_author: str
    title: str
    body: str
    pull_request: WorkspacePullRequest
    def __init__(self, landing_id: _Optional[str] = ..., task_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., workspace_id: _Optional[str] = ..., remote: _Optional[str] = ..., mode: _Optional[_Union[WorkspaceLandingMode, str]] = ..., branch: _Optional[str] = ..., target: _Optional[str] = ..., delivery: _Optional[_Union[_runtime_pb2.WorkspaceDeliveryReference, _Mapping]] = ..., state: _Optional[_Union[WorkspaceLandingState, str]] = ..., reason: _Optional[str] = ..., landed_commit: _Optional[str] = ..., target_commit: _Optional[str] = ..., conflicts: _Optional[_Iterable[str]] = ..., follow_up_task_id: _Optional[str] = ..., created_order: _Optional[int] = ..., author_name: _Optional[str] = ..., author_email: _Optional[str] = ..., co_author: _Optional[str] = ..., title: _Optional[str] = ..., body: _Optional[str] = ..., pull_request: _Optional[_Union[WorkspacePullRequest, _Mapping]] = ...) -> None: ...

class WorkspacePullRequest(_message.Message):
    __slots__ = ("repository", "repository_id", "number", "url")
    REPOSITORY_FIELD_NUMBER: _ClassVar[int]
    REPOSITORY_ID_FIELD_NUMBER: _ClassVar[int]
    NUMBER_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    repository: str
    repository_id: int
    number: int
    url: str
    def __init__(self, repository: _Optional[str] = ..., repository_id: _Optional[int] = ..., number: _Optional[int] = ..., url: _Optional[str] = ...) -> None: ...

class GetWorkspaceLandingRequest(_message.Message):
    __slots__ = ("landing_id",)
    LANDING_ID_FIELD_NUMBER: _ClassVar[int]
    landing_id: str
    def __init__(self, landing_id: _Optional[str] = ...) -> None: ...

class ReturnLandingConflictRequest(_message.Message):
    __slots__ = ("operation_id", "tag_id", "session_id", "target", "target_commit", "conflicts")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TARGET_FIELD_NUMBER: _ClassVar[int]
    TARGET_COMMIT_FIELD_NUMBER: _ClassVar[int]
    CONFLICTS_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    tag_id: str
    session_id: str
    target: str
    target_commit: str
    conflicts: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, operation_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., target: _Optional[str] = ..., target_commit: _Optional[str] = ..., conflicts: _Optional[_Iterable[str]] = ...) -> None: ...

class ListWorkspaceLandingsRequest(_message.Message):
    __slots__ = ("task_id", "limit", "before_order", "session_id")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    limit: int
    before_order: int
    session_id: str
    def __init__(self, task_id: _Optional[str] = ..., limit: _Optional[int] = ..., before_order: _Optional[int] = ..., session_id: _Optional[str] = ...) -> None: ...

class ListWorkspaceLandingsResponse(_message.Message):
    __slots__ = ("landings", "next_before_order")
    LANDINGS_FIELD_NUMBER: _ClassVar[int]
    NEXT_BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    landings: _containers.RepeatedCompositeFieldContainer[WorkspaceLanding]
    next_before_order: int
    def __init__(self, landings: _Optional[_Iterable[_Union[WorkspaceLanding, _Mapping]]] = ..., next_before_order: _Optional[int] = ...) -> None: ...

class WorkspaceSourcePin(_message.Message):
    __slots__ = ("pin_id", "tag_id", "session_id", "selector", "selector_digest", "resolved", "created_order")
    PIN_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    SELECTOR_FIELD_NUMBER: _ClassVar[int]
    SELECTOR_DIGEST_FIELD_NUMBER: _ClassVar[int]
    RESOLVED_FIELD_NUMBER: _ClassVar[int]
    CREATED_ORDER_FIELD_NUMBER: _ClassVar[int]
    pin_id: str
    tag_id: str
    session_id: str
    selector: _workspaces_pb2.Workspace
    selector_digest: str
    resolved: _workspaces_pb2.Workspace
    created_order: int
    def __init__(self, pin_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., selector: _Optional[_Union[_workspaces_pb2.Workspace, _Mapping]] = ..., selector_digest: _Optional[str] = ..., resolved: _Optional[_Union[_workspaces_pb2.Workspace, _Mapping]] = ..., created_order: _Optional[int] = ...) -> None: ...

class ListPendingWorkspaceSourcesRequest(_message.Message):
    __slots__ = ("after_order", "limit")
    AFTER_ORDER_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    after_order: int
    limit: int
    def __init__(self, after_order: _Optional[int] = ..., limit: _Optional[int] = ...) -> None: ...

class ListPendingWorkspaceSourcesResponse(_message.Message):
    __slots__ = ("pins", "next_after_order")
    PINS_FIELD_NUMBER: _ClassVar[int]
    NEXT_AFTER_ORDER_FIELD_NUMBER: _ClassVar[int]
    pins: _containers.RepeatedCompositeFieldContainer[WorkspaceSourcePin]
    next_after_order: int
    def __init__(self, pins: _Optional[_Iterable[_Union[WorkspaceSourcePin, _Mapping]]] = ..., next_after_order: _Optional[int] = ...) -> None: ...

class PinWorkspaceSourceRequest(_message.Message):
    __slots__ = ("pin_id", "selector_digest", "resolved_ref", "commit", "error")
    PIN_ID_FIELD_NUMBER: _ClassVar[int]
    SELECTOR_DIGEST_FIELD_NUMBER: _ClassVar[int]
    RESOLVED_REF_FIELD_NUMBER: _ClassVar[int]
    COMMIT_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    pin_id: str
    selector_digest: str
    resolved_ref: str
    commit: str
    error: str
    def __init__(self, pin_id: _Optional[str] = ..., selector_digest: _Optional[str] = ..., resolved_ref: _Optional[str] = ..., commit: _Optional[str] = ..., error: _Optional[str] = ...) -> None: ...

class ListUnverifiedLandingsRequest(_message.Message):
    __slots__ = ("limit",)
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    limit: int
    def __init__(self, limit: _Optional[int] = ...) -> None: ...

class ListUnverifiedLandingsResponse(_message.Message):
    __slots__ = ("landings",)
    LANDINGS_FIELD_NUMBER: _ClassVar[int]
    landings: _containers.RepeatedCompositeFieldContainer[UnverifiedLanding]
    def __init__(self, landings: _Optional[_Iterable[_Union[UnverifiedLanding, _Mapping]]] = ...) -> None: ...

class UnverifiedLanding(_message.Message):
    __slots__ = ("landing", "workspace")
    LANDING_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    landing: WorkspaceLanding
    workspace: _workspaces_pb2.Workspace
    def __init__(self, landing: _Optional[_Union[WorkspaceLanding, _Mapping]] = ..., workspace: _Optional[_Union[_workspaces_pb2.Workspace, _Mapping]] = ...) -> None: ...

class RecordLandingVerificationRequest(_message.Message):
    __slots__ = ("landing_id", "remote_commit")
    LANDING_ID_FIELD_NUMBER: _ClassVar[int]
    REMOTE_COMMIT_FIELD_NUMBER: _ClassVar[int]
    landing_id: str
    remote_commit: str
    def __init__(self, landing_id: _Optional[str] = ..., remote_commit: _Optional[str] = ...) -> None: ...

class ClaimWorkspaceLandingRequest(_message.Message):
    __slots__ = ("operation_id",)
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    def __init__(self, operation_id: _Optional[str] = ...) -> None: ...

class WorkspaceLandingLease(_message.Message):
    __slots__ = ("landing_id", "lease_token")
    LANDING_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    landing_id: str
    lease_token: str
    def __init__(self, landing_id: _Optional[str] = ..., lease_token: _Optional[str] = ...) -> None: ...

class ClaimWorkspaceLandingResponse(_message.Message):
    __slots__ = ("landing", "lease_token", "valid_for_ms", "holder", "credential", "workspace", "minted_credentials_only")
    LANDING_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    VALID_FOR_MS_FIELD_NUMBER: _ClassVar[int]
    HOLDER_FIELD_NUMBER: _ClassVar[int]
    CREDENTIAL_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    MINTED_CREDENTIALS_ONLY_FIELD_NUMBER: _ClassVar[int]
    landing: WorkspaceLanding
    lease_token: str
    valid_for_ms: int
    holder: _runtime_pb2.BlobHolder
    credential: str
    workspace: _workspaces_pb2.Workspace
    minted_credentials_only: bool
    def __init__(self, landing: _Optional[_Union[WorkspaceLanding, _Mapping]] = ..., lease_token: _Optional[str] = ..., valid_for_ms: _Optional[int] = ..., holder: _Optional[_Union[_runtime_pb2.BlobHolder, _Mapping]] = ..., credential: _Optional[str] = ..., workspace: _Optional[_Union[_workspaces_pb2.Workspace, _Mapping]] = ..., minted_credentials_only: _Optional[bool] = ...) -> None: ...

class RecordWorkspaceLandingRequest(_message.Message):
    __slots__ = ("lease", "operation_id", "state", "reason", "landed_commit", "target_commit", "conflicts", "retry_after_ms", "pull_request")
    LEASE_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    LANDED_COMMIT_FIELD_NUMBER: _ClassVar[int]
    TARGET_COMMIT_FIELD_NUMBER: _ClassVar[int]
    CONFLICTS_FIELD_NUMBER: _ClassVar[int]
    RETRY_AFTER_MS_FIELD_NUMBER: _ClassVar[int]
    PULL_REQUEST_FIELD_NUMBER: _ClassVar[int]
    lease: WorkspaceLandingLease
    operation_id: str
    state: WorkspaceLandingState
    reason: str
    landed_commit: str
    target_commit: str
    conflicts: _containers.RepeatedScalarFieldContainer[str]
    retry_after_ms: int
    pull_request: WorkspacePullRequest
    def __init__(self, lease: _Optional[_Union[WorkspaceLandingLease, _Mapping]] = ..., operation_id: _Optional[str] = ..., state: _Optional[_Union[WorkspaceLandingState, str]] = ..., reason: _Optional[str] = ..., landed_commit: _Optional[str] = ..., target_commit: _Optional[str] = ..., conflicts: _Optional[_Iterable[str]] = ..., retry_after_ms: _Optional[int] = ..., pull_request: _Optional[_Union[WorkspacePullRequest, _Mapping]] = ...) -> None: ...
