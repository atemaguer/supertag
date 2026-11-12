from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GithubWorkspaceSource(_message.Message):
    __slots__ = ("account_id", "repository_id", "repository", "commit_sha", "revision", "resolved_revision")
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    REPOSITORY_ID_FIELD_NUMBER: _ClassVar[int]
    REPOSITORY_FIELD_NUMBER: _ClassVar[int]
    COMMIT_SHA_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    RESOLVED_REVISION_FIELD_NUMBER: _ClassVar[int]
    account_id: str
    repository_id: int
    repository: str
    commit_sha: str
    revision: str
    resolved_revision: str
    def __init__(self, account_id: _Optional[str] = ..., repository_id: _Optional[int] = ..., repository: _Optional[str] = ..., commit_sha: _Optional[str] = ..., revision: _Optional[str] = ..., resolved_revision: _Optional[str] = ...) -> None: ...

class GithubWorkspace(_message.Message):
    __slots__ = ("workspace_id", "source", "revision", "pull_request")
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    PULL_REQUEST_FIELD_NUMBER: _ClassVar[int]
    workspace_id: str
    source: GithubWorkspaceSource
    revision: int
    pull_request: GithubPullRequestDelivery
    def __init__(self, workspace_id: _Optional[str] = ..., source: _Optional[_Union[GithubWorkspaceSource, _Mapping]] = ..., revision: _Optional[int] = ..., pull_request: _Optional[_Union[GithubPullRequestDelivery, _Mapping]] = ...) -> None: ...

class GithubPullRequestDelivery(_message.Message):
    __slots__ = ("base_branch",)
    BASE_BRANCH_FIELD_NUMBER: _ClassVar[int]
    base_branch: str
    def __init__(self, base_branch: _Optional[str] = ...) -> None: ...

class PutGithubWorkspaceRequest(_message.Message):
    __slots__ = ("operation_id", "workspace", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    workspace: GithubWorkspace
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., workspace: _Optional[_Union[GithubWorkspace, _Mapping]] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class GetGithubWorkspaceRequest(_message.Message):
    __slots__ = ("workspace_id",)
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    workspace_id: str
    def __init__(self, workspace_id: _Optional[str] = ...) -> None: ...

class ListGithubWorkspacesRequest(_message.Message):
    __slots__ = ("after_id", "limit")
    AFTER_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    after_id: str
    limit: int
    def __init__(self, after_id: _Optional[str] = ..., limit: _Optional[int] = ...) -> None: ...

class ListGithubWorkspacesResponse(_message.Message):
    __slots__ = ("workspaces", "next_cursor")
    WORKSPACES_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    workspaces: _containers.RepeatedCompositeFieldContainer[GithubWorkspace]
    next_cursor: str
    def __init__(self, workspaces: _Optional[_Iterable[_Union[GithubWorkspace, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class DeleteGithubWorkspaceRequest(_message.Message):
    __slots__ = ("operation_id", "workspace_id", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    workspace_id: str
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., workspace_id: _Optional[str] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class DeleteGithubWorkspaceResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class GithubSourcePin(_message.Message):
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
    selector: GithubWorkspace
    selector_digest: str
    resolved: GithubWorkspace
    created_order: int
    def __init__(self, pin_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., selector: _Optional[_Union[GithubWorkspace, _Mapping]] = ..., selector_digest: _Optional[str] = ..., resolved: _Optional[_Union[GithubWorkspace, _Mapping]] = ..., created_order: _Optional[int] = ...) -> None: ...

class ListPendingGithubSourcesRequest(_message.Message):
    __slots__ = ("after_order", "limit")
    AFTER_ORDER_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    after_order: int
    limit: int
    def __init__(self, after_order: _Optional[int] = ..., limit: _Optional[int] = ...) -> None: ...

class ListPendingGithubSourcesResponse(_message.Message):
    __slots__ = ("pins", "next_after_order")
    PINS_FIELD_NUMBER: _ClassVar[int]
    NEXT_AFTER_ORDER_FIELD_NUMBER: _ClassVar[int]
    pins: _containers.RepeatedCompositeFieldContainer[GithubSourcePin]
    next_after_order: int
    def __init__(self, pins: _Optional[_Iterable[_Union[GithubSourcePin, _Mapping]]] = ..., next_after_order: _Optional[int] = ...) -> None: ...

class PinGithubSourceRequest(_message.Message):
    __slots__ = ("pin_id", "selector_digest", "resolved_revision", "commit_sha")
    PIN_ID_FIELD_NUMBER: _ClassVar[int]
    SELECTOR_DIGEST_FIELD_NUMBER: _ClassVar[int]
    RESOLVED_REVISION_FIELD_NUMBER: _ClassVar[int]
    COMMIT_SHA_FIELD_NUMBER: _ClassVar[int]
    pin_id: str
    selector_digest: str
    resolved_revision: str
    commit_sha: str
    def __init__(self, pin_id: _Optional[str] = ..., selector_digest: _Optional[str] = ..., resolved_revision: _Optional[str] = ..., commit_sha: _Optional[str] = ...) -> None: ...
