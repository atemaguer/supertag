from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GithubWorkspaceSource(_message.Message):
    __slots__ = ("account_id", "repository_id", "repository", "commit_sha")
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    REPOSITORY_ID_FIELD_NUMBER: _ClassVar[int]
    REPOSITORY_FIELD_NUMBER: _ClassVar[int]
    COMMIT_SHA_FIELD_NUMBER: _ClassVar[int]
    account_id: str
    repository_id: int
    repository: str
    commit_sha: str
    def __init__(self, account_id: _Optional[str] = ..., repository_id: _Optional[int] = ..., repository: _Optional[str] = ..., commit_sha: _Optional[str] = ...) -> None: ...

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
