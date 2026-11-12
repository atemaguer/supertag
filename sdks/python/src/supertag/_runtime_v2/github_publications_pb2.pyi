from . import runtime_pb2 as _runtime_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GithubPublicationState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    GITHUB_PUBLICATION_STATE_UNSPECIFIED: _ClassVar[GithubPublicationState]
    GITHUB_PUBLICATION_STATE_QUEUED: _ClassVar[GithubPublicationState]
    GITHUB_PUBLICATION_STATE_WAITING_APPROVAL: _ClassVar[GithubPublicationState]
    GITHUB_PUBLICATION_STATE_CLAIMED: _ClassVar[GithubPublicationState]
    GITHUB_PUBLICATION_STATE_SENDING: _ClassVar[GithubPublicationState]
    GITHUB_PUBLICATION_STATE_UNCERTAIN: _ClassVar[GithubPublicationState]
    GITHUB_PUBLICATION_STATE_PUBLISHED: _ClassVar[GithubPublicationState]
    GITHUB_PUBLICATION_STATE_HELD: _ClassVar[GithubPublicationState]
    GITHUB_PUBLICATION_STATE_CANCELLED: _ClassVar[GithubPublicationState]

class GithubPublicationPhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    GITHUB_PUBLICATION_PHASE_INSPECT: _ClassVar[GithubPublicationPhase]
    GITHUB_PUBLICATION_PHASE_PUSH: _ClassVar[GithubPublicationPhase]
    GITHUB_PUBLICATION_PHASE_CREATE: _ClassVar[GithubPublicationPhase]
    GITHUB_PUBLICATION_PHASE_UPDATE: _ClassVar[GithubPublicationPhase]
GITHUB_PUBLICATION_STATE_UNSPECIFIED: GithubPublicationState
GITHUB_PUBLICATION_STATE_QUEUED: GithubPublicationState
GITHUB_PUBLICATION_STATE_WAITING_APPROVAL: GithubPublicationState
GITHUB_PUBLICATION_STATE_CLAIMED: GithubPublicationState
GITHUB_PUBLICATION_STATE_SENDING: GithubPublicationState
GITHUB_PUBLICATION_STATE_UNCERTAIN: GithubPublicationState
GITHUB_PUBLICATION_STATE_PUBLISHED: GithubPublicationState
GITHUB_PUBLICATION_STATE_HELD: GithubPublicationState
GITHUB_PUBLICATION_STATE_CANCELLED: GithubPublicationState
GITHUB_PUBLICATION_PHASE_INSPECT: GithubPublicationPhase
GITHUB_PUBLICATION_PHASE_PUSH: GithubPublicationPhase
GITHUB_PUBLICATION_PHASE_CREATE: GithubPublicationPhase
GITHUB_PUBLICATION_PHASE_UPDATE: GithubPublicationPhase

class GithubPullRequestReceipt(_message.Message):
    __slots__ = ("number", "url", "repository_id", "repository", "head_branch", "base_branch", "head_commit", "open", "merged", "draft", "title", "body")
    NUMBER_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    REPOSITORY_ID_FIELD_NUMBER: _ClassVar[int]
    REPOSITORY_FIELD_NUMBER: _ClassVar[int]
    HEAD_BRANCH_FIELD_NUMBER: _ClassVar[int]
    BASE_BRANCH_FIELD_NUMBER: _ClassVar[int]
    HEAD_COMMIT_FIELD_NUMBER: _ClassVar[int]
    OPEN_FIELD_NUMBER: _ClassVar[int]
    MERGED_FIELD_NUMBER: _ClassVar[int]
    DRAFT_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    BODY_FIELD_NUMBER: _ClassVar[int]
    number: int
    url: str
    repository_id: int
    repository: str
    head_branch: str
    base_branch: str
    head_commit: str
    open: bool
    merged: bool
    draft: bool
    title: str
    body: str
    def __init__(self, number: _Optional[int] = ..., url: _Optional[str] = ..., repository_id: _Optional[int] = ..., repository: _Optional[str] = ..., head_branch: _Optional[str] = ..., base_branch: _Optional[str] = ..., head_commit: _Optional[str] = ..., open: _Optional[bool] = ..., merged: _Optional[bool] = ..., draft: _Optional[bool] = ..., title: _Optional[str] = ..., body: _Optional[str] = ...) -> None: ...

class GithubPublication(_message.Message):
    __slots__ = ("publication_id", "task_id", "tag_id", "session_id", "account_id", "repository_id", "repository", "delivery", "head_branch", "base_branch", "title", "body", "state", "phase", "approval_id", "pull_request", "reason", "created_order", "cancel_requested")
    PUBLICATION_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    REPOSITORY_ID_FIELD_NUMBER: _ClassVar[int]
    REPOSITORY_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_FIELD_NUMBER: _ClassVar[int]
    HEAD_BRANCH_FIELD_NUMBER: _ClassVar[int]
    BASE_BRANCH_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    BODY_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_ID_FIELD_NUMBER: _ClassVar[int]
    PULL_REQUEST_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    CREATED_ORDER_FIELD_NUMBER: _ClassVar[int]
    CANCEL_REQUESTED_FIELD_NUMBER: _ClassVar[int]
    publication_id: str
    task_id: str
    tag_id: str
    session_id: str
    account_id: str
    repository_id: int
    repository: str
    delivery: _runtime_pb2.WorkspaceDeliveryReference
    head_branch: str
    base_branch: str
    title: str
    body: str
    state: GithubPublicationState
    phase: GithubPublicationPhase
    approval_id: str
    pull_request: GithubPullRequestReceipt
    reason: str
    created_order: int
    cancel_requested: bool
    def __init__(self, publication_id: _Optional[str] = ..., task_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., account_id: _Optional[str] = ..., repository_id: _Optional[int] = ..., repository: _Optional[str] = ..., delivery: _Optional[_Union[_runtime_pb2.WorkspaceDeliveryReference, _Mapping]] = ..., head_branch: _Optional[str] = ..., base_branch: _Optional[str] = ..., title: _Optional[str] = ..., body: _Optional[str] = ..., state: _Optional[_Union[GithubPublicationState, str]] = ..., phase: _Optional[_Union[GithubPublicationPhase, str]] = ..., approval_id: _Optional[str] = ..., pull_request: _Optional[_Union[GithubPullRequestReceipt, _Mapping]] = ..., reason: _Optional[str] = ..., created_order: _Optional[int] = ..., cancel_requested: _Optional[bool] = ...) -> None: ...

class GetGithubPublicationRequest(_message.Message):
    __slots__ = ("publication_id",)
    PUBLICATION_ID_FIELD_NUMBER: _ClassVar[int]
    publication_id: str
    def __init__(self, publication_id: _Optional[str] = ...) -> None: ...

class ListGithubPublicationsRequest(_message.Message):
    __slots__ = ("task_id", "limit", "before_order")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    limit: int
    before_order: int
    def __init__(self, task_id: _Optional[str] = ..., limit: _Optional[int] = ..., before_order: _Optional[int] = ...) -> None: ...

class ListGithubPublicationsResponse(_message.Message):
    __slots__ = ("publications", "next_before_order")
    PUBLICATIONS_FIELD_NUMBER: _ClassVar[int]
    NEXT_BEFORE_ORDER_FIELD_NUMBER: _ClassVar[int]
    publications: _containers.RepeatedCompositeFieldContainer[GithubPublication]
    next_before_order: int
    def __init__(self, publications: _Optional[_Iterable[_Union[GithubPublication, _Mapping]]] = ..., next_before_order: _Optional[int] = ...) -> None: ...

class CancelGithubPublicationRequest(_message.Message):
    __slots__ = ("publication_id", "operation_id", "reason")
    PUBLICATION_ID_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    publication_id: str
    operation_id: str
    reason: str
    def __init__(self, publication_id: _Optional[str] = ..., operation_id: _Optional[str] = ..., reason: _Optional[str] = ...) -> None: ...

class ClaimGithubPublicationRequest(_message.Message):
    __slots__ = ("operation_id",)
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    def __init__(self, operation_id: _Optional[str] = ...) -> None: ...

class GithubPublicationLease(_message.Message):
    __slots__ = ("publication_id", "lease_token")
    PUBLICATION_ID_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    publication_id: str
    lease_token: str
    def __init__(self, publication_id: _Optional[str] = ..., lease_token: _Optional[str] = ...) -> None: ...

class ClaimGithubPublicationResponse(_message.Message):
    __slots__ = ("publication", "lease_token", "valid_for_ms", "read_only")
    PUBLICATION_FIELD_NUMBER: _ClassVar[int]
    LEASE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    VALID_FOR_MS_FIELD_NUMBER: _ClassVar[int]
    READ_ONLY_FIELD_NUMBER: _ClassVar[int]
    publication: GithubPublication
    lease_token: str
    valid_for_ms: int
    read_only: bool
    def __init__(self, publication: _Optional[_Union[GithubPublication, _Mapping]] = ..., lease_token: _Optional[str] = ..., valid_for_ms: _Optional[int] = ..., read_only: _Optional[bool] = ...) -> None: ...

class PlanGithubPublicationRequest(_message.Message):
    __slots__ = ("lease", "operation_id", "existing", "pushed_commit")
    LEASE_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    EXISTING_FIELD_NUMBER: _ClassVar[int]
    PUSHED_COMMIT_FIELD_NUMBER: _ClassVar[int]
    lease: GithubPublicationLease
    operation_id: str
    existing: GithubPullRequestReceipt
    pushed_commit: str
    def __init__(self, lease: _Optional[_Union[GithubPublicationLease, _Mapping]] = ..., operation_id: _Optional[str] = ..., existing: _Optional[_Union[GithubPullRequestReceipt, _Mapping]] = ..., pushed_commit: _Optional[str] = ...) -> None: ...

class BeginGithubPublicationEffectRequest(_message.Message):
    __slots__ = ("lease", "operation_id", "phase")
    LEASE_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    lease: GithubPublicationLease
    operation_id: str
    phase: GithubPublicationPhase
    def __init__(self, lease: _Optional[_Union[GithubPublicationLease, _Mapping]] = ..., operation_id: _Optional[str] = ..., phase: _Optional[_Union[GithubPublicationPhase, str]] = ...) -> None: ...

class RecordGithubPublicationEffectRequest(_message.Message):
    __slots__ = ("lease", "operation_id", "phase", "state", "pull_request", "pushed_commit", "reason")
    LEASE_FIELD_NUMBER: _ClassVar[int]
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    PULL_REQUEST_FIELD_NUMBER: _ClassVar[int]
    PUSHED_COMMIT_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    lease: GithubPublicationLease
    operation_id: str
    phase: GithubPublicationPhase
    state: GithubPublicationState
    pull_request: GithubPullRequestReceipt
    pushed_commit: str
    reason: str
    def __init__(self, lease: _Optional[_Union[GithubPublicationLease, _Mapping]] = ..., operation_id: _Optional[str] = ..., phase: _Optional[_Union[GithubPublicationPhase, str]] = ..., state: _Optional[_Union[GithubPublicationState, str]] = ..., pull_request: _Optional[_Union[GithubPullRequestReceipt, _Mapping]] = ..., pushed_commit: _Optional[str] = ..., reason: _Optional[str] = ...) -> None: ...
