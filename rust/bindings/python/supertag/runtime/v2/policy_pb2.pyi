from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class PolicyPermissionTarget(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    POLICY_PERMISSION_TARGET_UNSPECIFIED: _ClassVar[PolicyPermissionTarget]
    POLICY_PERMISSION_TARGET_RUNTIME: _ClassVar[PolicyPermissionTarget]
    POLICY_PERMISSION_TARGET_SURFACE: _ClassVar[PolicyPermissionTarget]
    POLICY_PERMISSION_TARGET_MCP: _ClassVar[PolicyPermissionTarget]

class RoleStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ROLE_STATUS_UNSPECIFIED: _ClassVar[RoleStatus]
    ROLE_STATUS_ACTIVE: _ClassVar[RoleStatus]
    ROLE_STATUS_RETIRED: _ClassVar[RoleStatus]

class RoleAssignmentStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ROLE_ASSIGNMENT_STATUS_UNSPECIFIED: _ClassVar[RoleAssignmentStatus]
    ROLE_ASSIGNMENT_STATUS_ACTIVE: _ClassVar[RoleAssignmentStatus]
    ROLE_ASSIGNMENT_STATUS_INACTIVE: _ClassVar[RoleAssignmentStatus]
POLICY_PERMISSION_TARGET_UNSPECIFIED: PolicyPermissionTarget
POLICY_PERMISSION_TARGET_RUNTIME: PolicyPermissionTarget
POLICY_PERMISSION_TARGET_SURFACE: PolicyPermissionTarget
POLICY_PERMISSION_TARGET_MCP: PolicyPermissionTarget
ROLE_STATUS_UNSPECIFIED: RoleStatus
ROLE_STATUS_ACTIVE: RoleStatus
ROLE_STATUS_RETIRED: RoleStatus
ROLE_ASSIGNMENT_STATUS_UNSPECIFIED: RoleAssignmentStatus
ROLE_ASSIGNMENT_STATUS_ACTIVE: RoleAssignmentStatus
ROLE_ASSIGNMENT_STATUS_INACTIVE: RoleAssignmentStatus

class SlackSurfaceIdentity(_message.Message):
    __slots__ = ("team_id",)
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    team_id: str
    def __init__(self, team_id: _Optional[str] = ...) -> None: ...

class GithubSurfaceIdentity(_message.Message):
    __slots__ = ("external_account_id",)
    EXTERNAL_ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    external_account_id: str
    def __init__(self, external_account_id: _Optional[str] = ...) -> None: ...

class LinearSurfaceIdentity(_message.Message):
    __slots__ = ("workspace_id",)
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    workspace_id: str
    def __init__(self, workspace_id: _Optional[str] = ...) -> None: ...

class LarkSurfaceIdentity(_message.Message):
    __slots__ = ("feishu", "app_id", "tenant_key")
    FEISHU_FIELD_NUMBER: _ClassVar[int]
    APP_ID_FIELD_NUMBER: _ClassVar[int]
    TENANT_KEY_FIELD_NUMBER: _ClassVar[int]
    feishu: bool
    app_id: str
    tenant_key: str
    def __init__(self, feishu: _Optional[bool] = ..., app_id: _Optional[str] = ..., tenant_key: _Optional[str] = ...) -> None: ...

class MicrosoftTeamsSurfaceIdentity(_message.Message):
    __slots__ = ("app_id", "tenant_id")
    APP_ID_FIELD_NUMBER: _ClassVar[int]
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    app_id: str
    tenant_id: str
    def __init__(self, app_id: _Optional[str] = ..., tenant_id: _Optional[str] = ...) -> None: ...

class SurfaceAccountIdentity(_message.Message):
    __slots__ = ("slack", "github", "linear", "lark", "microsoft_teams")
    SLACK_FIELD_NUMBER: _ClassVar[int]
    GITHUB_FIELD_NUMBER: _ClassVar[int]
    LINEAR_FIELD_NUMBER: _ClassVar[int]
    LARK_FIELD_NUMBER: _ClassVar[int]
    MICROSOFT_TEAMS_FIELD_NUMBER: _ClassVar[int]
    slack: SlackSurfaceIdentity
    github: GithubSurfaceIdentity
    linear: LinearSurfaceIdentity
    lark: LarkSurfaceIdentity
    microsoft_teams: MicrosoftTeamsSurfaceIdentity
    def __init__(self, slack: _Optional[_Union[SlackSurfaceIdentity, _Mapping]] = ..., github: _Optional[_Union[GithubSurfaceIdentity, _Mapping]] = ..., linear: _Optional[_Union[LinearSurfaceIdentity, _Mapping]] = ..., lark: _Optional[_Union[LarkSurfaceIdentity, _Mapping]] = ..., microsoft_teams: _Optional[_Union[MicrosoftTeamsSurfaceIdentity, _Mapping]] = ...) -> None: ...

class SurfaceAccount(_message.Message):
    __slots__ = ("account_id", "identity", "enabled", "revision", "gateway")
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    IDENTITY_FIELD_NUMBER: _ClassVar[int]
    ENABLED_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    GATEWAY_FIELD_NUMBER: _ClassVar[int]
    account_id: str
    identity: SurfaceAccountIdentity
    enabled: bool
    revision: int
    gateway: str
    def __init__(self, account_id: _Optional[str] = ..., identity: _Optional[_Union[SurfaceAccountIdentity, _Mapping]] = ..., enabled: _Optional[bool] = ..., revision: _Optional[int] = ..., gateway: _Optional[str] = ...) -> None: ...

class SlackSurfaceChannel(_message.Message):
    __slots__ = ("channel_id",)
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    channel_id: str
    def __init__(self, channel_id: _Optional[str] = ...) -> None: ...

class GithubSurfaceRepository(_message.Message):
    __slots__ = ("repository_id",)
    REPOSITORY_ID_FIELD_NUMBER: _ClassVar[int]
    repository_id: int
    def __init__(self, repository_id: _Optional[int] = ...) -> None: ...

class LinearSurfaceTeam(_message.Message):
    __slots__ = ("team_id",)
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    team_id: str
    def __init__(self, team_id: _Optional[str] = ...) -> None: ...

class LarkSurfaceChat(_message.Message):
    __slots__ = ("chat_id",)
    CHAT_ID_FIELD_NUMBER: _ClassVar[int]
    chat_id: str
    def __init__(self, chat_id: _Optional[str] = ...) -> None: ...

class MicrosoftTeamsSurfaceChannel(_message.Message):
    __slots__ = ("team_id", "channel_id")
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    team_id: str
    channel_id: str
    def __init__(self, team_id: _Optional[str] = ..., channel_id: _Optional[str] = ...) -> None: ...

class SurfaceLocationScope(_message.Message):
    __slots__ = ("slack", "github", "linear", "lark", "microsoft_teams")
    SLACK_FIELD_NUMBER: _ClassVar[int]
    GITHUB_FIELD_NUMBER: _ClassVar[int]
    LINEAR_FIELD_NUMBER: _ClassVar[int]
    LARK_FIELD_NUMBER: _ClassVar[int]
    MICROSOFT_TEAMS_FIELD_NUMBER: _ClassVar[int]
    slack: SlackSurfaceChannel
    github: GithubSurfaceRepository
    linear: LinearSurfaceTeam
    lark: LarkSurfaceChat
    microsoft_teams: MicrosoftTeamsSurfaceChannel
    def __init__(self, slack: _Optional[_Union[SlackSurfaceChannel, _Mapping]] = ..., github: _Optional[_Union[GithubSurfaceRepository, _Mapping]] = ..., linear: _Optional[_Union[LinearSurfaceTeam, _Mapping]] = ..., lark: _Optional[_Union[LarkSurfaceChat, _Mapping]] = ..., microsoft_teams: _Optional[_Union[MicrosoftTeamsSurfaceChannel, _Mapping]] = ...) -> None: ...

class SurfaceLocation(_message.Message):
    __slots__ = ("location_id", "account_id", "connector_account_id", "scope", "tag_id", "enabled", "revision", "permission_set_ids", "context_set_ids")
    LOCATION_ID_FIELD_NUMBER: _ClassVar[int]
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    CONNECTOR_ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    SCOPE_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    ENABLED_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    PERMISSION_SET_IDS_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_SET_IDS_FIELD_NUMBER: _ClassVar[int]
    location_id: str
    account_id: str
    connector_account_id: str
    scope: SurfaceLocationScope
    tag_id: str
    enabled: bool
    revision: int
    permission_set_ids: _containers.RepeatedScalarFieldContainer[str]
    context_set_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, location_id: _Optional[str] = ..., account_id: _Optional[str] = ..., connector_account_id: _Optional[str] = ..., scope: _Optional[_Union[SurfaceLocationScope, _Mapping]] = ..., tag_id: _Optional[str] = ..., enabled: _Optional[bool] = ..., revision: _Optional[int] = ..., permission_set_ids: _Optional[_Iterable[str]] = ..., context_set_ids: _Optional[_Iterable[str]] = ...) -> None: ...

class SurfacePolicyOrigin(_message.Message):
    __slots__ = ("location_id", "location_revision", "account_id", "connector_account_id", "scope", "origin_actions")
    LOCATION_ID_FIELD_NUMBER: _ClassVar[int]
    LOCATION_REVISION_FIELD_NUMBER: _ClassVar[int]
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    CONNECTOR_ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    SCOPE_FIELD_NUMBER: _ClassVar[int]
    ORIGIN_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    location_id: str
    location_revision: int
    account_id: str
    connector_account_id: str
    scope: SurfaceLocationScope
    origin_actions: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, location_id: _Optional[str] = ..., location_revision: _Optional[int] = ..., account_id: _Optional[str] = ..., connector_account_id: _Optional[str] = ..., scope: _Optional[_Union[SurfaceLocationScope, _Mapping]] = ..., origin_actions: _Optional[_Iterable[str]] = ...) -> None: ...

class PutSurfaceAccountRequest(_message.Message):
    __slots__ = ("operation_id", "account", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    ACCOUNT_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    account: SurfaceAccount
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., account: _Optional[_Union[SurfaceAccount, _Mapping]] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class GetSurfaceAccountRequest(_message.Message):
    __slots__ = ("account_id",)
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    account_id: str
    def __init__(self, account_id: _Optional[str] = ...) -> None: ...

class ListSurfaceAccountsRequest(_message.Message):
    __slots__ = ("limit", "cursor")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    limit: int
    cursor: str
    def __init__(self, limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListSurfaceAccountsResponse(_message.Message):
    __slots__ = ("accounts", "next_cursor")
    ACCOUNTS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    accounts: _containers.RepeatedCompositeFieldContainer[SurfaceAccount]
    next_cursor: str
    def __init__(self, accounts: _Optional[_Iterable[_Union[SurfaceAccount, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class PutSurfaceLocationRequest(_message.Message):
    __slots__ = ("operation_id", "location", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    LOCATION_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    location: SurfaceLocation
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., location: _Optional[_Union[SurfaceLocation, _Mapping]] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class GetSurfaceLocationRequest(_message.Message):
    __slots__ = ("location_id",)
    LOCATION_ID_FIELD_NUMBER: _ClassVar[int]
    location_id: str
    def __init__(self, location_id: _Optional[str] = ...) -> None: ...

class ListSurfaceLocationsRequest(_message.Message):
    __slots__ = ("account_id", "limit", "cursor")
    ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    account_id: str
    limit: int
    cursor: str
    def __init__(self, account_id: _Optional[str] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListSurfaceLocationsResponse(_message.Message):
    __slots__ = ("locations", "next_cursor")
    LOCATIONS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    locations: _containers.RepeatedCompositeFieldContainer[SurfaceLocation]
    next_cursor: str
    def __init__(self, locations: _Optional[_Iterable[_Union[SurfaceLocation, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class DeleteSurfaceLocationRequest(_message.Message):
    __slots__ = ("operation_id", "location_id", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    LOCATION_ID_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    location_id: str
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., location_id: _Optional[str] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class PolicyPermission(_message.Message):
    __slots__ = ("permission_id", "target", "action", "surface_account_id", "scope", "reference", "resource", "approval_required")
    PERMISSION_ID_FIELD_NUMBER: _ClassVar[int]
    TARGET_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    SURFACE_ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    SCOPE_FIELD_NUMBER: _ClassVar[int]
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    RESOURCE_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_REQUIRED_FIELD_NUMBER: _ClassVar[int]
    permission_id: str
    target: PolicyPermissionTarget
    action: str
    surface_account_id: str
    scope: str
    reference: str
    resource: str
    approval_required: bool
    def __init__(self, permission_id: _Optional[str] = ..., target: _Optional[_Union[PolicyPermissionTarget, str]] = ..., action: _Optional[str] = ..., surface_account_id: _Optional[str] = ..., scope: _Optional[str] = ..., reference: _Optional[str] = ..., resource: _Optional[str] = ..., approval_required: _Optional[bool] = ...) -> None: ...

class PermissionSet(_message.Message):
    __slots__ = ("set_id", "name", "revision", "approvers", "permissions")
    SET_ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    APPROVERS_FIELD_NUMBER: _ClassVar[int]
    PERMISSIONS_FIELD_NUMBER: _ClassVar[int]
    set_id: str
    name: str
    revision: int
    approvers: _containers.RepeatedScalarFieldContainer[str]
    permissions: _containers.RepeatedCompositeFieldContainer[PolicyPermission]
    def __init__(self, set_id: _Optional[str] = ..., name: _Optional[str] = ..., revision: _Optional[int] = ..., approvers: _Optional[_Iterable[str]] = ..., permissions: _Optional[_Iterable[_Union[PolicyPermission, _Mapping]]] = ...) -> None: ...

class PolicyContextItem(_message.Message):
    __slots__ = ("item_id", "item_key", "type", "version", "required", "config_json", "artifact_snapshot")
    ITEM_ID_FIELD_NUMBER: _ClassVar[int]
    ITEM_KEY_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    CONFIG_JSON_FIELD_NUMBER: _ClassVar[int]
    ARTIFACT_SNAPSHOT_FIELD_NUMBER: _ClassVar[int]
    item_id: str
    item_key: str
    type: str
    version: int
    required: bool
    config_json: str
    artifact_snapshot: PolicyArtifactContextSnapshot
    def __init__(self, item_id: _Optional[str] = ..., item_key: _Optional[str] = ..., type: _Optional[str] = ..., version: _Optional[int] = ..., required: _Optional[bool] = ..., config_json: _Optional[str] = ..., artifact_snapshot: _Optional[_Union[PolicyArtifactContextSnapshot, _Mapping]] = ...) -> None: ...

class ContextSet(_message.Message):
    __slots__ = ("set_id", "name", "revision", "items")
    SET_ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    set_id: str
    name: str
    revision: int
    items: _containers.RepeatedCompositeFieldContainer[PolicyContextItem]
    def __init__(self, set_id: _Optional[str] = ..., name: _Optional[str] = ..., revision: _Optional[int] = ..., items: _Optional[_Iterable[_Union[PolicyContextItem, _Mapping]]] = ...) -> None: ...

class PolicyExecutionSettings(_message.Message):
    __slots__ = ("harness", "models", "efforts", "shared_execution_environment_id")
    HARNESS_FIELD_NUMBER: _ClassVar[int]
    MODELS_FIELD_NUMBER: _ClassVar[int]
    EFFORTS_FIELD_NUMBER: _ClassVar[int]
    SHARED_EXECUTION_ENVIRONMENT_ID_FIELD_NUMBER: _ClassVar[int]
    harness: str
    models: _containers.RepeatedScalarFieldContainer[str]
    efforts: _containers.RepeatedScalarFieldContainer[str]
    shared_execution_environment_id: str
    def __init__(self, harness: _Optional[str] = ..., models: _Optional[_Iterable[str]] = ..., efforts: _Optional[_Iterable[str]] = ..., shared_execution_environment_id: _Optional[str] = ...) -> None: ...

class Role(_message.Message):
    __slots__ = ("role_id", "name", "purpose", "instructions", "permission_set_ids", "context_set_ids", "status", "revision", "execution")
    ROLE_ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    PURPOSE_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTIONS_FIELD_NUMBER: _ClassVar[int]
    PERMISSION_SET_IDS_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_SET_IDS_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_FIELD_NUMBER: _ClassVar[int]
    role_id: str
    name: str
    purpose: str
    instructions: str
    permission_set_ids: _containers.RepeatedScalarFieldContainer[str]
    context_set_ids: _containers.RepeatedScalarFieldContainer[str]
    status: RoleStatus
    revision: int
    execution: PolicyExecutionSettings
    def __init__(self, role_id: _Optional[str] = ..., name: _Optional[str] = ..., purpose: _Optional[str] = ..., instructions: _Optional[str] = ..., permission_set_ids: _Optional[_Iterable[str]] = ..., context_set_ids: _Optional[_Iterable[str]] = ..., status: _Optional[_Union[RoleStatus, str]] = ..., revision: _Optional[int] = ..., execution: _Optional[_Union[PolicyExecutionSettings, _Mapping]] = ...) -> None: ...

class RoleAssignment(_message.Message):
    __slots__ = ("assignment_id", "role_id", "tag_id", "status", "revision")
    ASSIGNMENT_ID_FIELD_NUMBER: _ClassVar[int]
    ROLE_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    assignment_id: str
    role_id: str
    tag_id: str
    status: RoleAssignmentStatus
    revision: int
    def __init__(self, assignment_id: _Optional[str] = ..., role_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., status: _Optional[_Union[RoleAssignmentStatus, str]] = ..., revision: _Optional[int] = ...) -> None: ...

class PolicyRoleSnapshot(_message.Message):
    __slots__ = ("assignment", "role")
    ASSIGNMENT_FIELD_NUMBER: _ClassVar[int]
    ROLE_FIELD_NUMBER: _ClassVar[int]
    assignment: RoleAssignment
    role: Role
    def __init__(self, assignment: _Optional[_Union[RoleAssignment, _Mapping]] = ..., role: _Optional[_Union[Role, _Mapping]] = ...) -> None: ...

class TaskPolicySnapshot(_message.Message):
    __slots__ = ("version", "roles", "permission_sets", "context_sets", "execution", "origin", "runtime_authority")
    VERSION_FIELD_NUMBER: _ClassVar[int]
    ROLES_FIELD_NUMBER: _ClassVar[int]
    PERMISSION_SETS_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_SETS_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_FIELD_NUMBER: _ClassVar[int]
    ORIGIN_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_AUTHORITY_FIELD_NUMBER: _ClassVar[int]
    version: int
    roles: _containers.RepeatedCompositeFieldContainer[PolicyRoleSnapshot]
    permission_sets: _containers.RepeatedCompositeFieldContainer[PermissionSet]
    context_sets: _containers.RepeatedCompositeFieldContainer[ContextSet]
    execution: PolicyExecutionSettings
    origin: SurfacePolicyOrigin
    runtime_authority: TaskRuntimeAuthority
    def __init__(self, version: _Optional[int] = ..., roles: _Optional[_Iterable[_Union[PolicyRoleSnapshot, _Mapping]]] = ..., permission_sets: _Optional[_Iterable[_Union[PermissionSet, _Mapping]]] = ..., context_sets: _Optional[_Iterable[_Union[ContextSet, _Mapping]]] = ..., execution: _Optional[_Union[PolicyExecutionSettings, _Mapping]] = ..., origin: _Optional[_Union[SurfacePolicyOrigin, _Mapping]] = ..., runtime_authority: _Optional[_Union[TaskRuntimeAuthority, _Mapping]] = ...) -> None: ...

class RuntimeApprovalRequirement(_message.Message):
    __slots__ = ("action", "permission_set_ids", "approvers")
    ACTION_FIELD_NUMBER: _ClassVar[int]
    PERMISSION_SET_IDS_FIELD_NUMBER: _ClassVar[int]
    APPROVERS_FIELD_NUMBER: _ClassVar[int]
    action: str
    permission_set_ids: _containers.RepeatedScalarFieldContainer[str]
    approvers: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, action: _Optional[str] = ..., permission_set_ids: _Optional[_Iterable[str]] = ..., approvers: _Optional[_Iterable[str]] = ...) -> None: ...

class TaskRuntimeAuthority(_message.Message):
    __slots__ = ("actions", "approvals", "objective_id", "objective_revision", "delegating_task_id")
    ACTIONS_FIELD_NUMBER: _ClassVar[int]
    APPROVALS_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_REVISION_FIELD_NUMBER: _ClassVar[int]
    DELEGATING_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    actions: _containers.RepeatedScalarFieldContainer[str]
    approvals: _containers.RepeatedCompositeFieldContainer[RuntimeApprovalRequirement]
    objective_id: str
    objective_revision: int
    delegating_task_id: str
    def __init__(self, actions: _Optional[_Iterable[str]] = ..., approvals: _Optional[_Iterable[_Union[RuntimeApprovalRequirement, _Mapping]]] = ..., objective_id: _Optional[str] = ..., objective_revision: _Optional[int] = ..., delegating_task_id: _Optional[str] = ...) -> None: ...

class PutPermissionSetRequest(_message.Message):
    __slots__ = ("operation_id", "permission_set", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    PERMISSION_SET_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    permission_set: PermissionSet
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., permission_set: _Optional[_Union[PermissionSet, _Mapping]] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class PutContextSetRequest(_message.Message):
    __slots__ = ("operation_id", "context_set", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_SET_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    context_set: ContextSet
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., context_set: _Optional[_Union[ContextSet, _Mapping]] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class PutRoleRequest(_message.Message):
    __slots__ = ("operation_id", "role", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    ROLE_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    role: Role
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., role: _Optional[_Union[Role, _Mapping]] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class GetPolicyResourceRequest(_message.Message):
    __slots__ = ("reference",)
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    reference: str
    def __init__(self, reference: _Optional[str] = ...) -> None: ...

class ListPolicyResourcesRequest(_message.Message):
    __slots__ = ("limit", "cursor")
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    limit: int
    cursor: str
    def __init__(self, limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListPermissionSetsResponse(_message.Message):
    __slots__ = ("permission_sets", "next_cursor")
    PERMISSION_SETS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    permission_sets: _containers.RepeatedCompositeFieldContainer[PermissionSet]
    next_cursor: str
    def __init__(self, permission_sets: _Optional[_Iterable[_Union[PermissionSet, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class ListContextSetsResponse(_message.Message):
    __slots__ = ("context_sets", "next_cursor")
    CONTEXT_SETS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    context_sets: _containers.RepeatedCompositeFieldContainer[ContextSet]
    next_cursor: str
    def __init__(self, context_sets: _Optional[_Iterable[_Union[ContextSet, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class ListRolesResponse(_message.Message):
    __slots__ = ("roles", "next_cursor")
    ROLES_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    roles: _containers.RepeatedCompositeFieldContainer[Role]
    next_cursor: str
    def __init__(self, roles: _Optional[_Iterable[_Union[Role, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class DeletePolicyResourceRequest(_message.Message):
    __slots__ = ("operation_id", "reference", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    reference: str
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., reference: _Optional[str] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class DeletePolicyResourceResponse(_message.Message):
    __slots__ = ("deleted",)
    DELETED_FIELD_NUMBER: _ClassVar[int]
    deleted: bool
    def __init__(self, deleted: _Optional[bool] = ...) -> None: ...

class AssignRoleRequest(_message.Message):
    __slots__ = ("operation_id", "role", "tag_id")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    ROLE_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    role: str
    tag_id: str
    def __init__(self, operation_id: _Optional[str] = ..., role: _Optional[str] = ..., tag_id: _Optional[str] = ...) -> None: ...

class ListRoleAssignmentsRequest(_message.Message):
    __slots__ = ("role", "tag_id", "status", "limit", "cursor")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    LIMIT_FIELD_NUMBER: _ClassVar[int]
    CURSOR_FIELD_NUMBER: _ClassVar[int]
    role: str
    tag_id: str
    status: RoleAssignmentStatus
    limit: int
    cursor: str
    def __init__(self, role: _Optional[str] = ..., tag_id: _Optional[str] = ..., status: _Optional[_Union[RoleAssignmentStatus, str]] = ..., limit: _Optional[int] = ..., cursor: _Optional[str] = ...) -> None: ...

class ListRoleAssignmentsResponse(_message.Message):
    __slots__ = ("assignments", "next_cursor")
    ASSIGNMENTS_FIELD_NUMBER: _ClassVar[int]
    NEXT_CURSOR_FIELD_NUMBER: _ClassVar[int]
    assignments: _containers.RepeatedCompositeFieldContainer[RoleAssignment]
    next_cursor: str
    def __init__(self, assignments: _Optional[_Iterable[_Union[RoleAssignment, _Mapping]]] = ..., next_cursor: _Optional[str] = ...) -> None: ...

class DeactivateRoleAssignmentRequest(_message.Message):
    __slots__ = ("operation_id", "assignment_id", "expected_revision")
    OPERATION_ID_FIELD_NUMBER: _ClassVar[int]
    ASSIGNMENT_ID_FIELD_NUMBER: _ClassVar[int]
    EXPECTED_REVISION_FIELD_NUMBER: _ClassVar[int]
    operation_id: str
    assignment_id: str
    expected_revision: int
    def __init__(self, operation_id: _Optional[str] = ..., assignment_id: _Optional[str] = ..., expected_revision: _Optional[int] = ...) -> None: ...

class PolicyArtifactContextSnapshot(_message.Message):
    __slots__ = ("source", "artifacts")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    ARTIFACTS_FIELD_NUMBER: _ClassVar[int]
    source: SurfacePolicyOrigin
    artifacts: _containers.RepeatedCompositeFieldContainer[PolicyArtifactContextEntry]
    def __init__(self, source: _Optional[_Union[SurfacePolicyOrigin, _Mapping]] = ..., artifacts: _Optional[_Iterable[_Union[PolicyArtifactContextEntry, _Mapping]]] = ...) -> None: ...

class PolicyArtifactContextEntry(_message.Message):
    __slots__ = ("artifact_id", "title", "kind", "summary", "task_id", "attempt_id", "tag_id", "session_id", "objective_id", "captured_at_ms", "file_count", "byte_length")
    ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_ID_FIELD_NUMBER: _ClassVar[int]
    TAG_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_ID_FIELD_NUMBER: _ClassVar[int]
    CAPTURED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    FILE_COUNT_FIELD_NUMBER: _ClassVar[int]
    BYTE_LENGTH_FIELD_NUMBER: _ClassVar[int]
    artifact_id: str
    title: str
    kind: str
    summary: str
    task_id: str
    attempt_id: str
    tag_id: str
    session_id: str
    objective_id: str
    captured_at_ms: int
    file_count: int
    byte_length: int
    def __init__(self, artifact_id: _Optional[str] = ..., title: _Optional[str] = ..., kind: _Optional[str] = ..., summary: _Optional[str] = ..., task_id: _Optional[str] = ..., attempt_id: _Optional[str] = ..., tag_id: _Optional[str] = ..., session_id: _Optional[str] = ..., objective_id: _Optional[str] = ..., captured_at_ms: _Optional[int] = ..., file_count: _Optional[int] = ..., byte_length: _Optional[int] = ...) -> None: ...
