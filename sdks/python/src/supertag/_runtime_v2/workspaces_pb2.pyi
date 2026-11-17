from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class WorkspaceCheckStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WORKSPACE_CHECK_STATUS_UNSPECIFIED: _ClassVar[WorkspaceCheckStatus]
    WORKSPACE_CHECK_STATUS_OK: _ClassVar[WorkspaceCheckStatus]
    WORKSPACE_CHECK_STATUS_FAILED: _ClassVar[WorkspaceCheckStatus]
    WORKSPACE_CHECK_STATUS_WARNING: _ClassVar[WorkspaceCheckStatus]
    WORKSPACE_CHECK_STATUS_NOT_APPLICABLE: _ClassVar[WorkspaceCheckStatus]
    WORKSPACE_CHECK_STATUS_UNKNOWN: _ClassVar[WorkspaceCheckStatus]

class WorkspaceCredentialKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WORKSPACE_CREDENTIAL_KIND_UNSPECIFIED: _ClassVar[WorkspaceCredentialKind]
    WORKSPACE_CREDENTIAL_KIND_SSH_KEY: _ClassVar[WorkspaceCredentialKind]
    WORKSPACE_CREDENTIAL_KIND_HTTPS_TOKEN: _ClassVar[WorkspaceCredentialKind]
    WORKSPACE_CREDENTIAL_KIND_CREDENTIAL_HELPER: _ClassVar[WorkspaceCredentialKind]
WORKSPACE_CHECK_STATUS_UNSPECIFIED: WorkspaceCheckStatus
WORKSPACE_CHECK_STATUS_OK: WorkspaceCheckStatus
WORKSPACE_CHECK_STATUS_FAILED: WorkspaceCheckStatus
WORKSPACE_CHECK_STATUS_WARNING: WorkspaceCheckStatus
WORKSPACE_CHECK_STATUS_NOT_APPLICABLE: WorkspaceCheckStatus
WORKSPACE_CHECK_STATUS_UNKNOWN: WorkspaceCheckStatus
WORKSPACE_CREDENTIAL_KIND_UNSPECIFIED: WorkspaceCredentialKind
WORKSPACE_CREDENTIAL_KIND_SSH_KEY: WorkspaceCredentialKind
WORKSPACE_CREDENTIAL_KIND_HTTPS_TOKEN: WorkspaceCredentialKind
WORKSPACE_CREDENTIAL_KIND_CREDENTIAL_HELPER: WorkspaceCredentialKind

class Workspace(_message.Message):
    __slots__ = ("workspace_id", "remote", "ref", "credentials", "land", "revision", "commit", "resolved_ref")
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    REMOTE_FIELD_NUMBER: _ClassVar[int]
    REF_FIELD_NUMBER: _ClassVar[int]
    CREDENTIALS_FIELD_NUMBER: _ClassVar[int]
    LAND_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    COMMIT_FIELD_NUMBER: _ClassVar[int]
    RESOLVED_REF_FIELD_NUMBER: _ClassVar[int]
    workspace_id: str
    remote: str
    ref: str
    credentials: WorkspaceCredentialNames
    land: WorkspaceLand
    revision: int
    commit: str
    resolved_ref: str
    def __init__(self, workspace_id: _Optional[str] = ..., remote: _Optional[str] = ..., ref: _Optional[str] = ..., credentials: _Optional[_Union[WorkspaceCredentialNames, _Mapping]] = ..., land: _Optional[_Union[WorkspaceLand, _Mapping]] = ..., revision: _Optional[int] = ..., commit: _Optional[str] = ..., resolved_ref: _Optional[str] = ...) -> None: ...

class WorkspaceCredentialNames(_message.Message):
    __slots__ = ("read", "push")
    READ_FIELD_NUMBER: _ClassVar[int]
    PUSH_FIELD_NUMBER: _ClassVar[int]
    read: str
    push: str
    def __init__(self, read: _Optional[str] = ..., push: _Optional[str] = ...) -> None: ...

class WorkspaceLand(_message.Message):
    __slots__ = ("branch", "merge")
    BRANCH_FIELD_NUMBER: _ClassVar[int]
    MERGE_FIELD_NUMBER: _ClassVar[int]
    branch: WorkspaceLandBranch
    merge: WorkspaceLandMerge
    def __init__(self, branch: _Optional[_Union[WorkspaceLandBranch, _Mapping]] = ..., merge: _Optional[_Union[WorkspaceLandMerge, _Mapping]] = ...) -> None: ...

class WorkspaceLandBranch(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class WorkspaceLandMerge(_message.Message):
    __slots__ = ("target",)
    TARGET_FIELD_NUMBER: _ClassVar[int]
    target: str
    def __init__(self, target: _Optional[str] = ...) -> None: ...

class PutWorkspaceRequest(_message.Message):
    __slots__ = ("operation_id", "workspace", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    workspace: Workspace
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., workspace: _Optional[_Union[Workspace, _Mapping]] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class GetWorkspaceRequest(_message.Message):
    __slots__ = ("workspace_id",)
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    workspace_id: str
    def __init__(self, workspace_id: _Optional[str] = ...) -> None: ...

class ListWorkspacesRequest(_message.Message):
    __slots__ = ("after_id", "limit")
    AFTER_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    after_id: str
    limit: int
    def __init__(self, after_id: _Optional[str] = ..., limit: _Optional[int] = ...) -> None: ...

class ListWorkspacesResponse(_message.Message):
    __slots__ = ("workspaces", "next_cursor")
    WORKSPACES_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    workspaces: _containers.RepeatedCompositeFieldContainer[Workspace]
    next_cursor: str
    def __init__(self, workspaces: _Optional[_Iterable[_Union[Workspace, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class DeleteWorkspaceRequest(_message.Message):
    __slots__ = ("operation_id", "workspace_id", "expected_revision", "dry_run")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    DRY_RUN_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    workspace_id: str
    expected_revision: int
    dry_run: bool
    def __init__(self, operation_id: _Optional[str] = ..., workspace_id: _Optional[str] = ..., expected_revision: _Optional[int] = ..., dry_run: _Optional[bool] = ...) -> None: ...

class DeleteWorkspaceResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class CheckWorkspaceRequest(_message.Message):
    __slots__ = ("workspace_id",)
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    workspace_id: str
    def __init__(self, workspace_id: _Optional[str] = ...) -> None: ...

class WorkspaceCheckStep(_message.Message):
    __slots__ = ("step", "status", "detail")
    STEP_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    DETAIL_FIELD_NUMBER: _ClassVar[int]
    step: str
    status: WorkspaceCheckStatus
    detail: str
    def __init__(self, step: _Optional[str] = ..., status: _Optional[_Union[WorkspaceCheckStatus, str]] = ..., detail: _Optional[str] = ...) -> None: ...

class WorkspaceCheck(_message.Message):
    __slots__ = ("workspace_id", "steps")
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    STEPS_FIELD_NUMBER: _ClassVar[int]
    workspace_id: str
    steps: _containers.RepeatedCompositeFieldContainer[WorkspaceCheckStep]
    def __init__(self, workspace_id: _Optional[str] = ..., steps: _Optional[_Iterable[_Union[WorkspaceCheckStep, _Mapping]]] = ...) -> None: ...

class WorkspaceCredential(_message.Message):
    __slots__ = ("name", "kind", "identifier", "revision")
    NAME_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    IDENTIFIER_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    name: str
    kind: WorkspaceCredentialKind
    identifier: str
    revision: int
    def __init__(self, name: _Optional[str] = ..., kind: _Optional[_Union[WorkspaceCredentialKind, str]] = ..., identifier: _Optional[str] = ..., revision: _Optional[int] = ...) -> None: ...

class PutWorkspaceCredentialRequest(_message.Message):
    __slots__ = ("operation_id", "credential", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    CREDENTIAL_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    credential: WorkspaceCredential
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., credential: _Optional[_Union[WorkspaceCredential, _Mapping]] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class GetWorkspaceCredentialRequest(_message.Message):
    __slots__ = ("name",)
    NAME_FIELD_NUMBER: _ClassVar[int]
    name: str
    def __init__(self, name: _Optional[str] = ...) -> None: ...

class ListWorkspaceCredentialsRequest(_message.Message):
    __slots__ = ("after_name", "limit")
    AFTER_NAME_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    after_name: str
    limit: int
    def __init__(self, after_name: _Optional[str] = ..., limit: _Optional[int] = ...) -> None: ...

class ListWorkspaceCredentialsResponse(_message.Message):
    __slots__ = ("credentials", "next_cursor")
    CREDENTIALS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    credentials: _containers.RepeatedCompositeFieldContainer[WorkspaceCredential]
    next_cursor: str
    def __init__(self, credentials: _Optional[_Iterable[_Union[WorkspaceCredential, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class DeleteWorkspaceCredentialRequest(_message.Message):
    __slots__ = ("operation_id", "name", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    name: str
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., name: _Optional[str] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class DeleteWorkspaceCredentialResponse(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...
