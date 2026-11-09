import datetime

from google.protobuf import struct_pb2 as _struct_pb2
from google.protobuf import timestamp_pb2 as _timestamp_pb2
from supertag.operator.v1 import common_pb2 as _common_pb2
from supertag.operator.v1 import host_pb2 as _host_pb2
from supertag.operator.v1 import options_pb2 as _options_pb2
from supertag.operator.v1 import surface_pb2 as _surface_pb2
from supertag.operator.v1 import task_pb2 as _task_pb2
from supertag.operator.v1 import work_pb2 as _work_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ResourceKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    RESOURCE_KIND_UNSPECIFIED: _ClassVar[ResourceKind]
    RESOURCE_KIND_TAG: _ClassVar[ResourceKind]
    RESOURCE_KIND_ROLE: _ClassVar[ResourceKind]
    RESOURCE_KIND_PERMISSION_SET: _ClassVar[ResourceKind]
    RESOURCE_KIND_CONTEXT_SET: _ClassVar[ResourceKind]
    RESOURCE_KIND_VOLUME: _ClassVar[ResourceKind]
    RESOURCE_KIND_WORKSPACE: _ClassVar[ResourceKind]
    RESOURCE_KIND_SURFACE_ACCOUNT: _ClassVar[ResourceKind]
    RESOURCE_KIND_OBJECTIVE: _ClassVar[ResourceKind]
    RESOURCE_KIND_WORKER_PROFILE: _ClassVar[ResourceKind]

class PlanAction(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    PLAN_ACTION_UNSPECIFIED: _ClassVar[PlanAction]
    PLAN_ACTION_CREATE: _ClassVar[PlanAction]
    PLAN_ACTION_UPDATE: _ClassVar[PlanAction]
    PLAN_ACTION_UNCHANGED: _ClassVar[PlanAction]

class FieldChangeAction(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    FIELD_CHANGE_ACTION_UNSPECIFIED: _ClassVar[FieldChangeAction]
    FIELD_CHANGE_ACTION_ADD: _ClassVar[FieldChangeAction]
    FIELD_CHANGE_ACTION_REMOVE: _ClassVar[FieldChangeAction]
    FIELD_CHANGE_ACTION_CHANGE: _ClassVar[FieldChangeAction]

class ManifestOutcome(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    MANIFEST_OUTCOME_UNSPECIFIED: _ClassVar[ManifestOutcome]
    MANIFEST_OUTCOME_APPLIED: _ClassVar[ManifestOutcome]
    MANIFEST_OUTCOME_EXISTED: _ClassVar[ManifestOutcome]
    MANIFEST_OUTCOME_FAILED: _ClassVar[ManifestOutcome]
    MANIFEST_OUTCOME_NOT_APPLIED: _ClassVar[ManifestOutcome]

class PruneAction(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    PRUNE_ACTION_UNSPECIFIED: _ClassVar[PruneAction]
    PRUNE_ACTION_DELETE: _ClassVar[PruneAction]
    PRUNE_ACTION_CANCEL: _ClassVar[PruneAction]
    PRUNE_ACTION_KEEP: _ClassVar[PruneAction]

class DeletionAction(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    DELETION_ACTION_UNSPECIFIED: _ClassVar[DeletionAction]
    DELETION_ACTION_RETIRE: _ClassVar[DeletionAction]
    DELETION_ACTION_DELETE: _ClassVar[DeletionAction]

class ExecutionEffort(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    EXECUTION_EFFORT_UNSPECIFIED: _ClassVar[ExecutionEffort]
    EXECUTION_EFFORT_LOW: _ClassVar[ExecutionEffort]
    EXECUTION_EFFORT_MEDIUM: _ClassVar[ExecutionEffort]
    EXECUTION_EFFORT_HIGH: _ClassVar[ExecutionEffort]

class TagPhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TAG_PHASE_UNSPECIFIED: _ClassVar[TagPhase]
    TAG_PHASE_ACTIVE: _ClassVar[TagPhase]
    TAG_PHASE_RETIRED: _ClassVar[TagPhase]

class RolePhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    ROLE_PHASE_UNSPECIFIED: _ClassVar[RolePhase]
    ROLE_PHASE_ACTIVE: _ClassVar[RolePhase]
    ROLE_PHASE_RETIRED: _ClassVar[RolePhase]

class PermissionApproval(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    PERMISSION_APPROVAL_UNSPECIFIED: _ClassVar[PermissionApproval]
    PERMISSION_APPROVAL_REQUIRED: _ClassVar[PermissionApproval]

class WorkspaceMountStrategy(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WORKSPACE_MOUNT_STRATEGY_UNSPECIFIED: _ClassVar[WorkspaceMountStrategy]
    WORKSPACE_MOUNT_STRATEGY_COPY: _ClassVar[WorkspaceMountStrategy]
    WORKSPACE_MOUNT_STRATEGY_MOUNT: _ClassVar[WorkspaceMountStrategy]

class WorkerProfilePhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    WORKER_PROFILE_PHASE_UNSPECIFIED: _ClassVar[WorkerProfilePhase]
    WORKER_PROFILE_PHASE_AVAILABLE: _ClassVar[WorkerProfilePhase]
    WORKER_PROFILE_PHASE_UNAVAILABLE: _ClassVar[WorkerProfilePhase]

class SlackTransport(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SLACK_TRANSPORT_UNSPECIFIED: _ClassVar[SlackTransport]
    SLACK_TRANSPORT_SOCKET: _ClassVar[SlackTransport]
    SLACK_TRANSPORT_HTTP: _ClassVar[SlackTransport]

class GithubAuth(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    GITHUB_AUTH_UNSPECIFIED: _ClassVar[GithubAuth]
    GITHUB_AUTH_TOKEN: _ClassVar[GithubAuth]
    GITHUB_AUTH_APP: _ClassVar[GithubAuth]

class LarkDomain(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    LARK_DOMAIN_UNSPECIFIED: _ClassVar[LarkDomain]
    LARK_DOMAIN_LARK: _ClassVar[LarkDomain]
    LARK_DOMAIN_FEISHU: _ClassVar[LarkDomain]
RESOURCE_KIND_UNSPECIFIED: ResourceKind
RESOURCE_KIND_TAG: ResourceKind
RESOURCE_KIND_ROLE: ResourceKind
RESOURCE_KIND_PERMISSION_SET: ResourceKind
RESOURCE_KIND_CONTEXT_SET: ResourceKind
RESOURCE_KIND_VOLUME: ResourceKind
RESOURCE_KIND_WORKSPACE: ResourceKind
RESOURCE_KIND_SURFACE_ACCOUNT: ResourceKind
RESOURCE_KIND_OBJECTIVE: ResourceKind
RESOURCE_KIND_WORKER_PROFILE: ResourceKind
PLAN_ACTION_UNSPECIFIED: PlanAction
PLAN_ACTION_CREATE: PlanAction
PLAN_ACTION_UPDATE: PlanAction
PLAN_ACTION_UNCHANGED: PlanAction
FIELD_CHANGE_ACTION_UNSPECIFIED: FieldChangeAction
FIELD_CHANGE_ACTION_ADD: FieldChangeAction
FIELD_CHANGE_ACTION_REMOVE: FieldChangeAction
FIELD_CHANGE_ACTION_CHANGE: FieldChangeAction
MANIFEST_OUTCOME_UNSPECIFIED: ManifestOutcome
MANIFEST_OUTCOME_APPLIED: ManifestOutcome
MANIFEST_OUTCOME_EXISTED: ManifestOutcome
MANIFEST_OUTCOME_FAILED: ManifestOutcome
MANIFEST_OUTCOME_NOT_APPLIED: ManifestOutcome
PRUNE_ACTION_UNSPECIFIED: PruneAction
PRUNE_ACTION_DELETE: PruneAction
PRUNE_ACTION_CANCEL: PruneAction
PRUNE_ACTION_KEEP: PruneAction
DELETION_ACTION_UNSPECIFIED: DeletionAction
DELETION_ACTION_RETIRE: DeletionAction
DELETION_ACTION_DELETE: DeletionAction
EXECUTION_EFFORT_UNSPECIFIED: ExecutionEffort
EXECUTION_EFFORT_LOW: ExecutionEffort
EXECUTION_EFFORT_MEDIUM: ExecutionEffort
EXECUTION_EFFORT_HIGH: ExecutionEffort
TAG_PHASE_UNSPECIFIED: TagPhase
TAG_PHASE_ACTIVE: TagPhase
TAG_PHASE_RETIRED: TagPhase
ROLE_PHASE_UNSPECIFIED: RolePhase
ROLE_PHASE_ACTIVE: RolePhase
ROLE_PHASE_RETIRED: RolePhase
PERMISSION_APPROVAL_UNSPECIFIED: PermissionApproval
PERMISSION_APPROVAL_REQUIRED: PermissionApproval
WORKSPACE_MOUNT_STRATEGY_UNSPECIFIED: WorkspaceMountStrategy
WORKSPACE_MOUNT_STRATEGY_COPY: WorkspaceMountStrategy
WORKSPACE_MOUNT_STRATEGY_MOUNT: WorkspaceMountStrategy
WORKER_PROFILE_PHASE_UNSPECIFIED: WorkerProfilePhase
WORKER_PROFILE_PHASE_AVAILABLE: WorkerProfilePhase
WORKER_PROFILE_PHASE_UNAVAILABLE: WorkerProfilePhase
SLACK_TRANSPORT_UNSPECIFIED: SlackTransport
SLACK_TRANSPORT_SOCKET: SlackTransport
SLACK_TRANSPORT_HTTP: SlackTransport
GITHUB_AUTH_UNSPECIFIED: GithubAuth
GITHUB_AUTH_TOKEN: GithubAuth
GITHUB_AUTH_APP: GithubAuth
LARK_DOMAIN_UNSPECIFIED: LarkDomain
LARK_DOMAIN_LARK: LarkDomain
LARK_DOMAIN_FEISHU: LarkDomain

class GetResourceRequest(_message.Message):
    __slots__ = ("kind", "name", "manifest")
    KIND_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    MANIFEST_FIELD_NUMBER: _ClassVar[int]
    kind: ResourceKind
    name: str
    manifest: bool
    def __init__(self, kind: _Optional[_Union[ResourceKind, str]] = ..., name: _Optional[str] = ..., manifest: _Optional[bool] = ...) -> None: ...

class ListResourcesRequest(_message.Message):
    __slots__ = ("kind", "page_size", "page_token", "manifest")
    KIND_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    MANIFEST_FIELD_NUMBER: _ClassVar[int]
    kind: ResourceKind
    page_size: int
    page_token: str
    manifest: bool
    def __init__(self, kind: _Optional[_Union[ResourceKind, str]] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ..., manifest: _Optional[bool] = ...) -> None: ...

class ListResourcesResponse(_message.Message):
    __slots__ = ("resources", "next_page_token")
    RESOURCES_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    resources: _containers.RepeatedCompositeFieldContainer[Resource]
    next_page_token: str
    def __init__(self, resources: _Optional[_Iterable[_Union[Resource, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class Resource(_message.Message):
    __slots__ = ("tag", "role", "permission_set", "context_set", "volume", "workspace", "surface_account", "objective", "worker_profile", "manifest")
    TAG_FIELD_NUMBER: _ClassVar[int]
    ROLE_FIELD_NUMBER: _ClassVar[int]
    PERMISSION_SET_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_SET_FIELD_NUMBER: _ClassVar[int]
    VOLUME_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_FIELD_NUMBER: _ClassVar[int]
    SURFACE_ACCOUNT_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVE_FIELD_NUMBER: _ClassVar[int]
    WORKER_PROFILE_FIELD_NUMBER: _ClassVar[int]
    MANIFEST_FIELD_NUMBER: _ClassVar[int]
    tag: Tag
    role: Role
    permission_set: PermissionSet
    context_set: ContextSet
    volume: Volume
    workspace: Workspace
    surface_account: _surface_pb2.SurfaceAccount
    objective: DeclaredObjective
    worker_profile: WorkerProfile
    manifest: _struct_pb2.Struct
    def __init__(self, tag: _Optional[_Union[Tag, _Mapping]] = ..., role: _Optional[_Union[Role, _Mapping]] = ..., permission_set: _Optional[_Union[PermissionSet, _Mapping]] = ..., context_set: _Optional[_Union[ContextSet, _Mapping]] = ..., volume: _Optional[_Union[Volume, _Mapping]] = ..., workspace: _Optional[_Union[Workspace, _Mapping]] = ..., surface_account: _Optional[_Union[_surface_pb2.SurfaceAccount, _Mapping]] = ..., objective: _Optional[_Union[DeclaredObjective, _Mapping]] = ..., worker_profile: _Optional[_Union[WorkerProfile, _Mapping]] = ..., manifest: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ...) -> None: ...

class ManifestDocument(_message.Message):
    __slots__ = ("manifest", "source", "secrets")
    class SecretsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    MANIFEST_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    SECRETS_FIELD_NUMBER: _ClassVar[int]
    manifest: _struct_pb2.Struct
    source: str
    secrets: _containers.ScalarMap[str, str]
    def __init__(self, manifest: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., source: _Optional[str] = ..., secrets: _Optional[_Mapping[str, str]] = ...) -> None: ...

class DiffManifestsRequest(_message.Message):
    __slots__ = ("documents", "apply_set", "prune", "force_conflicts")
    DOCUMENTS_FIELD_NUMBER: _ClassVar[int]
    APPLY_SET_FIELD_NUMBER: _ClassVar[int]
    PRUNE_FIELD_NUMBER: _ClassVar[int]
    FORCE_CONFLICTS_FIELD_NUMBER: _ClassVar[int]
    documents: _containers.RepeatedCompositeFieldContainer[ManifestDocument]
    apply_set: str
    prune: bool
    force_conflicts: bool
    def __init__(self, documents: _Optional[_Iterable[_Union[ManifestDocument, _Mapping]]] = ..., apply_set: _Optional[str] = ..., prune: _Optional[bool] = ..., force_conflicts: _Optional[bool] = ...) -> None: ...

class DiffManifestsResponse(_message.Message):
    __slots__ = ("plans", "pruned")
    PLANS_FIELD_NUMBER: _ClassVar[int]
    PRUNED_FIELD_NUMBER: _ClassVar[int]
    plans: _containers.RepeatedCompositeFieldContainer[ManifestPlan]
    pruned: _containers.RepeatedCompositeFieldContainer[PruneResult]
    def __init__(self, plans: _Optional[_Iterable[_Union[ManifestPlan, _Mapping]]] = ..., pruned: _Optional[_Iterable[_Union[PruneResult, _Mapping]]] = ...) -> None: ...

class ApplyManifestsRequest(_message.Message):
    __slots__ = ("documents", "apply_set", "prune", "force_conflicts", "create_only", "imperative")
    DOCUMENTS_FIELD_NUMBER: _ClassVar[int]
    APPLY_SET_FIELD_NUMBER: _ClassVar[int]
    PRUNE_FIELD_NUMBER: _ClassVar[int]
    FORCE_CONFLICTS_FIELD_NUMBER: _ClassVar[int]
    CREATE_ONLY_FIELD_NUMBER: _ClassVar[int]
    IMPERATIVE_FIELD_NUMBER: _ClassVar[int]
    documents: _containers.RepeatedCompositeFieldContainer[ManifestDocument]
    apply_set: str
    prune: bool
    force_conflicts: bool
    create_only: bool
    imperative: bool
    def __init__(self, documents: _Optional[_Iterable[_Union[ManifestDocument, _Mapping]]] = ..., apply_set: _Optional[str] = ..., prune: _Optional[bool] = ..., force_conflicts: _Optional[bool] = ..., create_only: _Optional[bool] = ..., imperative: _Optional[bool] = ...) -> None: ...

class ApplyManifestsResponse(_message.Message):
    __slots__ = ("results", "complete", "pruned")
    RESULTS_FIELD_NUMBER: _ClassVar[int]
    COMPLETE_FIELD_NUMBER: _ClassVar[int]
    PRUNED_FIELD_NUMBER: _ClassVar[int]
    results: _containers.RepeatedCompositeFieldContainer[ManifestResult]
    complete: bool
    pruned: _containers.RepeatedCompositeFieldContainer[PruneResult]
    def __init__(self, results: _Optional[_Iterable[_Union[ManifestResult, _Mapping]]] = ..., complete: _Optional[bool] = ..., pruned: _Optional[_Iterable[_Union[PruneResult, _Mapping]]] = ...) -> None: ...

class ManifestPlan(_message.Message):
    __slots__ = ("document", "kind", "name", "action", "changes", "conflicts", "refusals", "starts_objective", "held")
    DOCUMENT_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    CHANGES_FIELD_NUMBER: _ClassVar[int]
    CONFLICTS_FIELD_NUMBER: _ClassVar[int]
    REFUSALS_FIELD_NUMBER: _ClassVar[int]
    STARTS_OBJECTIVE_FIELD_NUMBER: _ClassVar[int]
    HELD_FIELD_NUMBER: _ClassVar[int]
    document: int
    kind: ResourceKind
    name: str
    action: PlanAction
    changes: _containers.RepeatedCompositeFieldContainer[FieldChange]
    conflicts: _containers.RepeatedCompositeFieldContainer[FieldConflict]
    refusals: _containers.RepeatedCompositeFieldContainer[FieldRefusal]
    starts_objective: bool
    held: str
    def __init__(self, document: _Optional[int] = ..., kind: _Optional[_Union[ResourceKind, str]] = ..., name: _Optional[str] = ..., action: _Optional[_Union[PlanAction, str]] = ..., changes: _Optional[_Iterable[_Union[FieldChange, _Mapping]]] = ..., conflicts: _Optional[_Iterable[_Union[FieldConflict, _Mapping]]] = ..., refusals: _Optional[_Iterable[_Union[FieldRefusal, _Mapping]]] = ..., starts_objective: _Optional[bool] = ..., held: _Optional[str] = ...) -> None: ...

class FieldChange(_message.Message):
    __slots__ = ("path", "action", "before", "after")
    PATH_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    BEFORE_FIELD_NUMBER: _ClassVar[int]
    AFTER_FIELD_NUMBER: _ClassVar[int]
    path: str
    action: FieldChangeAction
    before: _struct_pb2.Value
    after: _struct_pb2.Value
    def __init__(self, path: _Optional[str] = ..., action: _Optional[_Union[FieldChangeAction, str]] = ..., before: _Optional[_Union[_struct_pb2.Value, _Mapping]] = ..., after: _Optional[_Union[_struct_pb2.Value, _Mapping]] = ...) -> None: ...

class FieldConflict(_message.Message):
    __slots__ = ("path", "manager")
    PATH_FIELD_NUMBER: _ClassVar[int]
    MANAGER_FIELD_NUMBER: _ClassVar[int]
    path: str
    manager: str
    def __init__(self, path: _Optional[str] = ..., manager: _Optional[str] = ...) -> None: ...

class FieldRefusal(_message.Message):
    __slots__ = ("path", "reason")
    PATH_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    path: str
    reason: str
    def __init__(self, path: _Optional[str] = ..., reason: _Optional[str] = ...) -> None: ...

class ManifestResult(_message.Message):
    __slots__ = ("document", "kind", "name", "outcome", "action", "warnings", "started_task_id", "not_started", "verification", "failure_message", "failure")
    DOCUMENT_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    WARNINGS_FIELD_NUMBER: _ClassVar[int]
    STARTED_TASK_ID_FIELD_NUMBER: _ClassVar[int]
    NOT_STARTED_FIELD_NUMBER: _ClassVar[int]
    VERIFICATION_FIELD_NUMBER: _ClassVar[int]
    FAILURE_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    FAILURE_FIELD_NUMBER: _ClassVar[int]
    document: int
    kind: ResourceKind
    name: str
    outcome: ManifestOutcome
    action: PlanAction
    warnings: _containers.RepeatedScalarFieldContainer[str]
    started_task_id: str
    not_started: str
    verification: SurfaceVerification
    failure_message: str
    failure: _common_pb2.ErrorDetail
    def __init__(self, document: _Optional[int] = ..., kind: _Optional[_Union[ResourceKind, str]] = ..., name: _Optional[str] = ..., outcome: _Optional[_Union[ManifestOutcome, str]] = ..., action: _Optional[_Union[PlanAction, str]] = ..., warnings: _Optional[_Iterable[str]] = ..., started_task_id: _Optional[str] = ..., not_started: _Optional[str] = ..., verification: _Optional[_Union[SurfaceVerification, _Mapping]] = ..., failure_message: _Optional[str] = ..., failure: _Optional[_Union[_common_pb2.ErrorDetail, _Mapping]] = ...) -> None: ...

class SurfaceVerification(_message.Message):
    __slots__ = ("provider", "display_name", "external_account_id")
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    DISPLAY_NAME_FIELD_NUMBER: _ClassVar[int]
    EXTERNAL_ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    provider: _surface_pb2.SurfaceProvider
    display_name: str
    external_account_id: str
    def __init__(self, provider: _Optional[_Union[_surface_pb2.SurfaceProvider, str]] = ..., display_name: _Optional[str] = ..., external_account_id: _Optional[str] = ...) -> None: ...

class PruneResult(_message.Message):
    __slots__ = ("kind", "name", "action", "reason")
    KIND_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    kind: ResourceKind
    name: str
    action: PruneAction
    reason: str
    def __init__(self, kind: _Optional[_Union[ResourceKind, str]] = ..., name: _Optional[str] = ..., action: _Optional[_Union[PruneAction, str]] = ..., reason: _Optional[str] = ...) -> None: ...

class DeleteResourceRequest(_message.Message):
    __slots__ = ("kind", "name", "dry_run")
    KIND_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    DRY_RUN_FIELD_NUMBER: _ClassVar[int]
    kind: ResourceKind
    name: str
    dry_run: bool
    def __init__(self, kind: _Optional[_Union[ResourceKind, str]] = ..., name: _Optional[str] = ..., dry_run: _Optional[bool] = ...) -> None: ...

class DeleteResourceResponse(_message.Message):
    __slots__ = ("kind", "name", "dry_run", "action", "removed", "notes")
    KIND_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    DRY_RUN_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    REMOVED_FIELD_NUMBER: _ClassVar[int]
    NOTES_FIELD_NUMBER: _ClassVar[int]
    kind: ResourceKind
    name: str
    dry_run: bool
    action: DeletionAction
    removed: _containers.RepeatedScalarFieldContainer[str]
    notes: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, kind: _Optional[_Union[ResourceKind, str]] = ..., name: _Optional[str] = ..., dry_run: _Optional[bool] = ..., action: _Optional[_Union[DeletionAction, str]] = ..., removed: _Optional[_Iterable[str]] = ..., notes: _Optional[_Iterable[str]] = ...) -> None: ...

class ExecutionSettings(_message.Message):
    __slots__ = ("harness", "model", "effort")
    HARNESS_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    EFFORT_FIELD_NUMBER: _ClassVar[int]
    harness: str
    model: _containers.RepeatedScalarFieldContainer[str]
    effort: _containers.RepeatedScalarFieldContainer[ExecutionEffort]
    def __init__(self, harness: _Optional[str] = ..., model: _Optional[_Iterable[str]] = ..., effort: _Optional[_Iterable[_Union[ExecutionEffort, str]]] = ...) -> None: ...

class Tag(_message.Message):
    __slots__ = ("metadata", "spec", "status")
    METADATA_FIELD_NUMBER: _ClassVar[int]
    SPEC_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    metadata: _common_pb2.Metadata
    spec: TagSpec
    status: TagStatus
    def __init__(self, metadata: _Optional[_Union[_common_pb2.Metadata, _Mapping]] = ..., spec: _Optional[_Union[TagSpec, _Mapping]] = ..., status: _Optional[_Union[TagStatus, _Mapping]] = ...) -> None: ...

class TagSpec(_message.Message):
    __slots__ = ("roles", "worker_hosts", "runs_on", "execution", "locations", "accepts_messages_from")
    ROLES_FIELD_NUMBER: _ClassVar[int]
    WORKER_HOSTS_FIELD_NUMBER: _ClassVar[int]
    RUNS_ON_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_FIELD_NUMBER: _ClassVar[int]
    LOCATIONS_FIELD_NUMBER: _ClassVar[int]
    ACCEPTS_MESSAGES_FROM_FIELD_NUMBER: _ClassVar[int]
    roles: _containers.RepeatedScalarFieldContainer[str]
    worker_hosts: _containers.RepeatedScalarFieldContainer[str]
    runs_on: _containers.RepeatedScalarFieldContainer[str]
    execution: ExecutionSettings
    locations: _containers.RepeatedCompositeFieldContainer[TagLocation]
    accepts_messages_from: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, roles: _Optional[_Iterable[str]] = ..., worker_hosts: _Optional[_Iterable[str]] = ..., runs_on: _Optional[_Iterable[str]] = ..., execution: _Optional[_Union[ExecutionSettings, _Mapping]] = ..., locations: _Optional[_Iterable[_Union[TagLocation, _Mapping]]] = ..., accepts_messages_from: _Optional[_Iterable[str]] = ...) -> None: ...

class TagLocation(_message.Message):
    __slots__ = ("slack", "github", "lark", "linear", "teams", "account", "permission_sets", "context_sets", "workspaces")
    SLACK_FIELD_NUMBER: _ClassVar[int]
    GITHUB_FIELD_NUMBER: _ClassVar[int]
    LARK_FIELD_NUMBER: _ClassVar[int]
    LINEAR_FIELD_NUMBER: _ClassVar[int]
    TEAMS_FIELD_NUMBER: _ClassVar[int]
    ACCOUNT_FIELD_NUMBER: _ClassVar[int]
    PERMISSION_SETS_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_SETS_FIELD_NUMBER: _ClassVar[int]
    WORKSPACES_FIELD_NUMBER: _ClassVar[int]
    slack: SlackLocation
    github: GithubLocation
    lark: LarkLocation
    linear: LinearLocation
    teams: TeamsLocation
    account: str
    permission_sets: _containers.RepeatedScalarFieldContainer[str]
    context_sets: _containers.RepeatedScalarFieldContainer[str]
    workspaces: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, slack: _Optional[_Union[SlackLocation, _Mapping]] = ..., github: _Optional[_Union[GithubLocation, _Mapping]] = ..., lark: _Optional[_Union[LarkLocation, _Mapping]] = ..., linear: _Optional[_Union[LinearLocation, _Mapping]] = ..., teams: _Optional[_Union[TeamsLocation, _Mapping]] = ..., account: _Optional[str] = ..., permission_sets: _Optional[_Iterable[str]] = ..., context_sets: _Optional[_Iterable[str]] = ..., workspaces: _Optional[_Iterable[str]] = ...) -> None: ...

class SlackLocation(_message.Message):
    __slots__ = ("channel_id",)
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    channel_id: str
    def __init__(self, channel_id: _Optional[str] = ...) -> None: ...

class GithubLocation(_message.Message):
    __slots__ = ("repo", "repo_id")
    REPO_FIELD_NUMBER: _ClassVar[int]
    REPO_ID_FIELD_NUMBER: _ClassVar[int]
    repo: str
    repo_id: str
    def __init__(self, repo: _Optional[str] = ..., repo_id: _Optional[str] = ...) -> None: ...

class LarkLocation(_message.Message):
    __slots__ = ("chat_id",)
    CHAT_ID_FIELD_NUMBER: _ClassVar[int]
    chat_id: str
    def __init__(self, chat_id: _Optional[str] = ...) -> None: ...

class LinearLocation(_message.Message):
    __slots__ = ("team", "team_id")
    TEAM_FIELD_NUMBER: _ClassVar[int]
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    team: str
    team_id: str
    def __init__(self, team: _Optional[str] = ..., team_id: _Optional[str] = ...) -> None: ...

class TeamsLocation(_message.Message):
    __slots__ = ("team_id", "channel_id")
    TEAM_ID_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_ID_FIELD_NUMBER: _ClassVar[int]
    team_id: str
    channel_id: str
    def __init__(self, team_id: _Optional[str] = ..., channel_id: _Optional[str] = ...) -> None: ...

class TagStatus(_message.Message):
    __slots__ = ("phase", "retired_at", "execution", "locations")
    PHASE_FIELD_NUMBER: _ClassVar[int]
    RETIRED_AT_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_FIELD_NUMBER: _ClassVar[int]
    LOCATIONS_FIELD_NUMBER: _ClassVar[int]
    phase: TagPhase
    retired_at: _timestamp_pb2.Timestamp
    execution: ExecutionSettings
    locations: _containers.RepeatedCompositeFieldContainer[TagLocationStatus]
    def __init__(self, phase: _Optional[_Union[TagPhase, str]] = ..., retired_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., execution: _Optional[_Union[ExecutionSettings, _Mapping]] = ..., locations: _Optional[_Iterable[_Union[TagLocationStatus, _Mapping]]] = ...) -> None: ...

class TagLocationStatus(_message.Message):
    __slots__ = ("provider", "account", "target", "enabled")
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    ACCOUNT_FIELD_NUMBER: _ClassVar[int]
    TARGET_FIELD_NUMBER: _ClassVar[int]
    ENABLED_FIELD_NUMBER: _ClassVar[int]
    provider: _surface_pb2.SurfaceProvider
    account: str
    target: str
    enabled: bool
    def __init__(self, provider: _Optional[_Union[_surface_pb2.SurfaceProvider, str]] = ..., account: _Optional[str] = ..., target: _Optional[str] = ..., enabled: _Optional[bool] = ...) -> None: ...

class Role(_message.Message):
    __slots__ = ("metadata", "spec", "status")
    METADATA_FIELD_NUMBER: _ClassVar[int]
    SPEC_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    metadata: _common_pb2.Metadata
    spec: RoleSpec
    status: RoleStatus
    def __init__(self, metadata: _Optional[_Union[_common_pb2.Metadata, _Mapping]] = ..., spec: _Optional[_Union[RoleSpec, _Mapping]] = ..., status: _Optional[_Union[RoleStatus, _Mapping]] = ...) -> None: ...

class RoleSpec(_message.Message):
    __slots__ = ("purpose", "instructions", "context_sets", "permission_sets", "execution")
    PURPOSE_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTIONS_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_SETS_FIELD_NUMBER: _ClassVar[int]
    PERMISSION_SETS_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_FIELD_NUMBER: _ClassVar[int]
    purpose: str
    instructions: str
    context_sets: _containers.RepeatedScalarFieldContainer[str]
    permission_sets: _containers.RepeatedScalarFieldContainer[str]
    execution: ExecutionSettings
    def __init__(self, purpose: _Optional[str] = ..., instructions: _Optional[str] = ..., context_sets: _Optional[_Iterable[str]] = ..., permission_sets: _Optional[_Iterable[str]] = ..., execution: _Optional[_Union[ExecutionSettings, _Mapping]] = ...) -> None: ...

class RoleStatus(_message.Message):
    __slots__ = ("phase", "assigned_tags")
    PHASE_FIELD_NUMBER: _ClassVar[int]
    ASSIGNED_TAGS_FIELD_NUMBER: _ClassVar[int]
    phase: RolePhase
    assigned_tags: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, phase: _Optional[_Union[RolePhase, str]] = ..., assigned_tags: _Optional[_Iterable[str]] = ...) -> None: ...

class PermissionSet(_message.Message):
    __slots__ = ("metadata", "spec", "status")
    METADATA_FIELD_NUMBER: _ClassVar[int]
    SPEC_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    metadata: _common_pb2.Metadata
    spec: PermissionSetSpec
    status: PermissionSetStatus
    def __init__(self, metadata: _Optional[_Union[_common_pb2.Metadata, _Mapping]] = ..., spec: _Optional[_Union[PermissionSetSpec, _Mapping]] = ..., status: _Optional[_Union[PermissionSetStatus, _Mapping]] = ...) -> None: ...

class PermissionSetSpec(_message.Message):
    __slots__ = ("approvers", "permissions")
    APPROVERS_FIELD_NUMBER: _ClassVar[int]
    PERMISSIONS_FIELD_NUMBER: _ClassVar[int]
    approvers: _containers.RepeatedScalarFieldContainer[str]
    permissions: _containers.RepeatedCompositeFieldContainer[Permission]
    def __init__(self, approvers: _Optional[_Iterable[str]] = ..., permissions: _Optional[_Iterable[_Union[Permission, _Mapping]]] = ...) -> None: ...

class Permission(_message.Message):
    __slots__ = ("id", "surface", "runtime", "mcp", "action", "approval", "created_by", "created_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    SURFACE_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_FIELD_NUMBER: _ClassVar[int]
    MCP_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    APPROVAL_FIELD_NUMBER: _ClassVar[int]
    CREATED_BY_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    surface: SurfacePermission
    runtime: RuntimePermission
    mcp: McpPermission
    action: str
    approval: PermissionApproval
    created_by: str
    created_at: _timestamp_pb2.Timestamp
    def __init__(self, id: _Optional[str] = ..., surface: _Optional[_Union[SurfacePermission, _Mapping]] = ..., runtime: _Optional[_Union[RuntimePermission, _Mapping]] = ..., mcp: _Optional[_Union[McpPermission, _Mapping]] = ..., action: _Optional[str] = ..., approval: _Optional[_Union[PermissionApproval, str]] = ..., created_by: _Optional[str] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class SurfacePermission(_message.Message):
    __slots__ = ("surface_account_id", "scope", "reference")
    SURFACE_ACCOUNT_ID_FIELD_NUMBER: _ClassVar[int]
    SCOPE_FIELD_NUMBER: _ClassVar[int]
    REFERENCE_FIELD_NUMBER: _ClassVar[int]
    surface_account_id: str
    scope: str
    reference: str
    def __init__(self, surface_account_id: _Optional[str] = ..., scope: _Optional[str] = ..., reference: _Optional[str] = ...) -> None: ...

class RuntimePermission(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class McpPermission(_message.Message):
    __slots__ = ("resource",)
    RESOURCE_FIELD_NUMBER: _ClassVar[int]
    resource: str
    def __init__(self, resource: _Optional[str] = ...) -> None: ...

class PermissionSetStatus(_message.Message):
    __slots__ = ("bindings",)
    BINDINGS_FIELD_NUMBER: _ClassVar[int]
    bindings: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, bindings: _Optional[_Iterable[str]] = ...) -> None: ...

class ContextSet(_message.Message):
    __slots__ = ("metadata", "spec", "status")
    METADATA_FIELD_NUMBER: _ClassVar[int]
    SPEC_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    metadata: _common_pb2.Metadata
    spec: ContextSetSpec
    status: ContextSetStatus
    def __init__(self, metadata: _Optional[_Union[_common_pb2.Metadata, _Mapping]] = ..., spec: _Optional[_Union[ContextSetSpec, _Mapping]] = ..., status: _Optional[_Union[ContextSetStatus, _Mapping]] = ...) -> None: ...

class ContextSetSpec(_message.Message):
    __slots__ = ("items",)
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    items: _containers.RepeatedCompositeFieldContainer[ContextItem]
    def __init__(self, items: _Optional[_Iterable[_Union[ContextItem, _Mapping]]] = ...) -> None: ...

class ContextItem(_message.Message):
    __slots__ = ("id", "item_key", "type", "version", "required", "config", "created_by", "created_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    ITEM_KEY_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    CONFIG_FIELD_NUMBER: _ClassVar[int]
    CREATED_BY_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    item_key: str
    type: str
    version: int
    required: bool
    config: _struct_pb2.Struct
    created_by: str
    created_at: _timestamp_pb2.Timestamp
    def __init__(self, id: _Optional[str] = ..., item_key: _Optional[str] = ..., type: _Optional[str] = ..., version: _Optional[int] = ..., required: _Optional[bool] = ..., config: _Optional[_Union[_struct_pb2.Struct, _Mapping]] = ..., created_by: _Optional[str] = ..., created_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class ContextSetStatus(_message.Message):
    __slots__ = ("bindings",)
    BINDINGS_FIELD_NUMBER: _ClassVar[int]
    bindings: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, bindings: _Optional[_Iterable[str]] = ...) -> None: ...

class Volume(_message.Message):
    __slots__ = ("metadata", "spec")
    METADATA_FIELD_NUMBER: _ClassVar[int]
    SPEC_FIELD_NUMBER: _ClassVar[int]
    metadata: _common_pb2.Metadata
    spec: VolumeSpec
    def __init__(self, metadata: _Optional[_Union[_common_pb2.Metadata, _Mapping]] = ..., spec: _Optional[_Union[VolumeSpec, _Mapping]] = ...) -> None: ...

class VolumeSpec(_message.Message):
    __slots__ = ("source", "credential")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    CREDENTIAL_FIELD_NUMBER: _ClassVar[int]
    source: str
    credential: str
    def __init__(self, source: _Optional[str] = ..., credential: _Optional[str] = ...) -> None: ...

class Workspace(_message.Message):
    __slots__ = ("metadata", "spec", "status")
    METADATA_FIELD_NUMBER: _ClassVar[int]
    SPEC_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    metadata: _common_pb2.Metadata
    spec: WorkspaceSpec
    status: WorkspaceStatus
    def __init__(self, metadata: _Optional[_Union[_common_pb2.Metadata, _Mapping]] = ..., spec: _Optional[_Union[WorkspaceSpec, _Mapping]] = ..., status: _Optional[_Union[WorkspaceStatus, _Mapping]] = ...) -> None: ...

class WorkspaceSpec(_message.Message):
    __slots__ = ("source", "ref", "setup", "mcp", "skills", "skill_catalog", "mounts", "delivery")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    REF_FIELD_NUMBER: _ClassVar[int]
    SETUP_FIELD_NUMBER: _ClassVar[int]
    MCP_FIELD_NUMBER: _ClassVar[int]
    SKILLS_FIELD_NUMBER: _ClassVar[int]
    SKILL_CATALOG_FIELD_NUMBER: _ClassVar[int]
    MOUNTS_FIELD_NUMBER: _ClassVar[int]
    DELIVERY_FIELD_NUMBER: _ClassVar[int]
    source: str
    ref: str
    setup: str
    mcp: _containers.RepeatedScalarFieldContainer[str]
    skills: _containers.RepeatedScalarFieldContainer[str]
    skill_catalog: WorkspaceSkillCatalog
    mounts: _containers.RepeatedCompositeFieldContainer[WorkspaceMount]
    delivery: _task_pb2.WorkspaceDeliveryMode
    def __init__(self, source: _Optional[str] = ..., ref: _Optional[str] = ..., setup: _Optional[str] = ..., mcp: _Optional[_Iterable[str]] = ..., skills: _Optional[_Iterable[str]] = ..., skill_catalog: _Optional[_Union[WorkspaceSkillCatalog, _Mapping]] = ..., mounts: _Optional[_Iterable[_Union[WorkspaceMount, _Mapping]]] = ..., delivery: _Optional[_Union[_task_pb2.WorkspaceDeliveryMode, str]] = ...) -> None: ...

class WorkspaceSkillCatalog(_message.Message):
    __slots__ = ("repository", "path", "revision", "skills")
    REPOSITORY_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    REVISION_FIELD_NUMBER: _ClassVar[int]
    SKILLS_FIELD_NUMBER: _ClassVar[int]
    repository: str
    path: str
    revision: str
    skills: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, repository: _Optional[str] = ..., path: _Optional[str] = ..., revision: _Optional[str] = ..., skills: _Optional[_Iterable[str]] = ...) -> None: ...

class WorkspaceMount(_message.Message):
    __slots__ = ("volume", "path", "access", "strategy", "max_bytes")
    VOLUME_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    ACCESS_FIELD_NUMBER: _ClassVar[int]
    STRATEGY_FIELD_NUMBER: _ClassVar[int]
    MAX_BYTES_FIELD_NUMBER: _ClassVar[int]
    volume: str
    path: str
    access: _work_pb2.MountAccess
    strategy: WorkspaceMountStrategy
    max_bytes: int
    def __init__(self, volume: _Optional[str] = ..., path: _Optional[str] = ..., access: _Optional[_Union[_work_pb2.MountAccess, str]] = ..., strategy: _Optional[_Union[WorkspaceMountStrategy, str]] = ..., max_bytes: _Optional[int] = ...) -> None: ...

class WorkspaceStatus(_message.Message):
    __slots__ = ("worker_hosts", "environments")
    WORKER_HOSTS_FIELD_NUMBER: _ClassVar[int]
    ENVIRONMENTS_FIELD_NUMBER: _ClassVar[int]
    worker_hosts: _containers.RepeatedCompositeFieldContainer[WorkspaceWorkerHost]
    environments: _containers.RepeatedCompositeFieldContainer[WorkspaceEnvironment]
    def __init__(self, worker_hosts: _Optional[_Iterable[_Union[WorkspaceWorkerHost, _Mapping]]] = ..., environments: _Optional[_Iterable[_Union[WorkspaceEnvironment, _Mapping]]] = ...) -> None: ...

class WorkspaceWorkerHost(_message.Message):
    __slots__ = ("id", "connection")
    ID_FIELD_NUMBER: _ClassVar[int]
    CONNECTION_FIELD_NUMBER: _ClassVar[int]
    id: str
    connection: _host_pb2.WorkerHostConnection
    def __init__(self, id: _Optional[str] = ..., connection: _Optional[_Union[_host_pb2.WorkerHostConnection, str]] = ...) -> None: ...

class WorkspaceEnvironment(_message.Message):
    __slots__ = ("worker_host_id", "connection", "provider", "prepared", "prepared_at", "refusal")
    WORKER_HOST_ID_FIELD_NUMBER: _ClassVar[int]
    CONNECTION_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    PREPARED_FIELD_NUMBER: _ClassVar[int]
    PREPARED_AT_FIELD_NUMBER: _ClassVar[int]
    REFUSAL_FIELD_NUMBER: _ClassVar[int]
    worker_host_id: str
    connection: _host_pb2.WorkerHostConnection
    provider: str
    prepared: _work_pb2.PreparedWorkspace
    prepared_at: _timestamp_pb2.Timestamp
    refusal: str
    def __init__(self, worker_host_id: _Optional[str] = ..., connection: _Optional[_Union[_host_pb2.WorkerHostConnection, str]] = ..., provider: _Optional[str] = ..., prepared: _Optional[_Union[_work_pb2.PreparedWorkspace, _Mapping]] = ..., prepared_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., refusal: _Optional[str] = ...) -> None: ...

class WorkerProfile(_message.Message):
    __slots__ = ("metadata", "spec", "status")
    METADATA_FIELD_NUMBER: _ClassVar[int]
    SPEC_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    metadata: _common_pb2.Metadata
    spec: WorkerProfileSpec
    status: WorkerProfileStatus
    def __init__(self, metadata: _Optional[_Union[_common_pb2.Metadata, _Mapping]] = ..., spec: _Optional[_Union[WorkerProfileSpec, _Mapping]] = ..., status: _Optional[_Union[WorkerProfileStatus, _Mapping]] = ...) -> None: ...

class WorkerProfileSpec(_message.Message):
    __slots__ = ("ref",)
    REF_FIELD_NUMBER: _ClassVar[int]
    ref: _work_pb2.WorkerProfileRef
    def __init__(self, ref: _Optional[_Union[_work_pb2.WorkerProfileRef, _Mapping]] = ...) -> None: ...

class WorkerProfileStatus(_message.Message):
    __slots__ = ("phase", "worker_host_id", "worklet_id", "worker_id")
    PHASE_FIELD_NUMBER: _ClassVar[int]
    WORKER_HOST_ID_FIELD_NUMBER: _ClassVar[int]
    WORKLET_ID_FIELD_NUMBER: _ClassVar[int]
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    phase: WorkerProfilePhase
    worker_host_id: str
    worklet_id: str
    worker_id: str
    def __init__(self, phase: _Optional[_Union[WorkerProfilePhase, str]] = ..., worker_host_id: _Optional[str] = ..., worklet_id: _Optional[str] = ..., worker_id: _Optional[str] = ...) -> None: ...

class SurfaceAccountManifestSpec(_message.Message):
    __slots__ = ("slack", "github", "lark", "linear", "teams")
    SLACK_FIELD_NUMBER: _ClassVar[int]
    GITHUB_FIELD_NUMBER: _ClassVar[int]
    LARK_FIELD_NUMBER: _ClassVar[int]
    LINEAR_FIELD_NUMBER: _ClassVar[int]
    TEAMS_FIELD_NUMBER: _ClassVar[int]
    slack: SlackAccountSpec
    github: GithubAccountSpec
    lark: LarkAccountSpec
    linear: LinearAccountSpec
    teams: TeamsAccountSpec
    def __init__(self, slack: _Optional[_Union[SlackAccountSpec, _Mapping]] = ..., github: _Optional[_Union[GithubAccountSpec, _Mapping]] = ..., lark: _Optional[_Union[LarkAccountSpec, _Mapping]] = ..., linear: _Optional[_Union[LinearAccountSpec, _Mapping]] = ..., teams: _Optional[_Union[TeamsAccountSpec, _Mapping]] = ...) -> None: ...

class SlackAccountSpec(_message.Message):
    __slots__ = ("display_name", "configuration", "secrets")
    DISPLAY_NAME_FIELD_NUMBER: _ClassVar[int]
    CONFIGURATION_FIELD_NUMBER: _ClassVar[int]
    SECRETS_FIELD_NUMBER: _ClassVar[int]
    display_name: str
    configuration: SlackAccountConfiguration
    secrets: SlackAccountSecrets
    def __init__(self, display_name: _Optional[str] = ..., configuration: _Optional[_Union[SlackAccountConfiguration, _Mapping]] = ..., secrets: _Optional[_Union[SlackAccountSecrets, _Mapping]] = ...) -> None: ...

class SlackAccountConfiguration(_message.Message):
    __slots__ = ("transport",)
    TRANSPORT_FIELD_NUMBER: _ClassVar[int]
    transport: SlackTransport
    def __init__(self, transport: _Optional[_Union[SlackTransport, str]] = ...) -> None: ...

class SlackAccountSecrets(_message.Message):
    __slots__ = ("bot_token", "app_token", "signing_secret")
    BOT_TOKEN_FIELD_NUMBER: _ClassVar[int]
    APP_TOKEN_FIELD_NUMBER: _ClassVar[int]
    SIGNING_SECRET_FIELD_NUMBER: _ClassVar[int]
    bot_token: _surface_pb2.SurfaceSecretReference
    app_token: _surface_pb2.SurfaceSecretReference
    signing_secret: _surface_pb2.SurfaceSecretReference
    def __init__(self, bot_token: _Optional[_Union[_surface_pb2.SurfaceSecretReference, _Mapping]] = ..., app_token: _Optional[_Union[_surface_pb2.SurfaceSecretReference, _Mapping]] = ..., signing_secret: _Optional[_Union[_surface_pb2.SurfaceSecretReference, _Mapping]] = ...) -> None: ...

class GithubAccountSpec(_message.Message):
    __slots__ = ("display_name", "configuration", "secrets")
    DISPLAY_NAME_FIELD_NUMBER: _ClassVar[int]
    CONFIGURATION_FIELD_NUMBER: _ClassVar[int]
    SECRETS_FIELD_NUMBER: _ClassVar[int]
    display_name: str
    configuration: GithubAccountConfiguration
    secrets: GithubAccountSecrets
    def __init__(self, display_name: _Optional[str] = ..., configuration: _Optional[_Union[GithubAccountConfiguration, _Mapping]] = ..., secrets: _Optional[_Union[GithubAccountSecrets, _Mapping]] = ...) -> None: ...

class GithubAccountConfiguration(_message.Message):
    __slots__ = ("auth", "api_base_url", "app_id", "installation_id")
    AUTH_FIELD_NUMBER: _ClassVar[int]
    API_BASE_URL_FIELD_NUMBER: _ClassVar[int]
    APP_ID_FIELD_NUMBER: _ClassVar[int]
    INSTALLATION_ID_FIELD_NUMBER: _ClassVar[int]
    auth: GithubAuth
    api_base_url: str
    app_id: str
    installation_id: str
    def __init__(self, auth: _Optional[_Union[GithubAuth, str]] = ..., api_base_url: _Optional[str] = ..., app_id: _Optional[str] = ..., installation_id: _Optional[str] = ...) -> None: ...

class GithubAccountSecrets(_message.Message):
    __slots__ = ("token", "private_key", "webhook_secret")
    TOKEN_FIELD_NUMBER: _ClassVar[int]
    PRIVATE_KEY_FIELD_NUMBER: _ClassVar[int]
    WEBHOOK_SECRET_FIELD_NUMBER: _ClassVar[int]
    token: _surface_pb2.SurfaceSecretReference
    private_key: _surface_pb2.SurfaceSecretReference
    webhook_secret: _surface_pb2.SurfaceSecretReference
    def __init__(self, token: _Optional[_Union[_surface_pb2.SurfaceSecretReference, _Mapping]] = ..., private_key: _Optional[_Union[_surface_pb2.SurfaceSecretReference, _Mapping]] = ..., webhook_secret: _Optional[_Union[_surface_pb2.SurfaceSecretReference, _Mapping]] = ...) -> None: ...

class LarkAccountSpec(_message.Message):
    __slots__ = ("display_name", "configuration", "secrets")
    DISPLAY_NAME_FIELD_NUMBER: _ClassVar[int]
    CONFIGURATION_FIELD_NUMBER: _ClassVar[int]
    SECRETS_FIELD_NUMBER: _ClassVar[int]
    display_name: str
    configuration: LarkAccountConfiguration
    secrets: LarkAccountSecrets
    def __init__(self, display_name: _Optional[str] = ..., configuration: _Optional[_Union[LarkAccountConfiguration, _Mapping]] = ..., secrets: _Optional[_Union[LarkAccountSecrets, _Mapping]] = ...) -> None: ...

class LarkAccountConfiguration(_message.Message):
    __slots__ = ("app_id", "domain")
    APP_ID_FIELD_NUMBER: _ClassVar[int]
    DOMAIN_FIELD_NUMBER: _ClassVar[int]
    app_id: str
    domain: LarkDomain
    def __init__(self, app_id: _Optional[str] = ..., domain: _Optional[_Union[LarkDomain, str]] = ...) -> None: ...

class LarkAccountSecrets(_message.Message):
    __slots__ = ("app_secret",)
    APP_SECRET_FIELD_NUMBER: _ClassVar[int]
    app_secret: _surface_pb2.SurfaceSecretReference
    def __init__(self, app_secret: _Optional[_Union[_surface_pb2.SurfaceSecretReference, _Mapping]] = ...) -> None: ...

class LinearAccountSpec(_message.Message):
    __slots__ = ("display_name", "configuration", "secrets")
    DISPLAY_NAME_FIELD_NUMBER: _ClassVar[int]
    CONFIGURATION_FIELD_NUMBER: _ClassVar[int]
    SECRETS_FIELD_NUMBER: _ClassVar[int]
    display_name: str
    configuration: LinearAccountConfiguration
    secrets: LinearAccountSecrets
    def __init__(self, display_name: _Optional[str] = ..., configuration: _Optional[_Union[LinearAccountConfiguration, _Mapping]] = ..., secrets: _Optional[_Union[LinearAccountSecrets, _Mapping]] = ...) -> None: ...

class LinearAccountConfiguration(_message.Message):
    __slots__ = ("api_base_url",)
    API_BASE_URL_FIELD_NUMBER: _ClassVar[int]
    api_base_url: str
    def __init__(self, api_base_url: _Optional[str] = ...) -> None: ...

class LinearAccountSecrets(_message.Message):
    __slots__ = ("api_key", "webhook_secret")
    API_KEY_FIELD_NUMBER: _ClassVar[int]
    WEBHOOK_SECRET_FIELD_NUMBER: _ClassVar[int]
    api_key: _surface_pb2.SurfaceSecretReference
    webhook_secret: _surface_pb2.SurfaceSecretReference
    def __init__(self, api_key: _Optional[_Union[_surface_pb2.SurfaceSecretReference, _Mapping]] = ..., webhook_secret: _Optional[_Union[_surface_pb2.SurfaceSecretReference, _Mapping]] = ...) -> None: ...

class TeamsAccountSpec(_message.Message):
    __slots__ = ("display_name", "configuration", "secrets")
    DISPLAY_NAME_FIELD_NUMBER: _ClassVar[int]
    CONFIGURATION_FIELD_NUMBER: _ClassVar[int]
    SECRETS_FIELD_NUMBER: _ClassVar[int]
    display_name: str
    configuration: TeamsAccountConfiguration
    secrets: TeamsAccountSecrets
    def __init__(self, display_name: _Optional[str] = ..., configuration: _Optional[_Union[TeamsAccountConfiguration, _Mapping]] = ..., secrets: _Optional[_Union[TeamsAccountSecrets, _Mapping]] = ...) -> None: ...

class TeamsAccountConfiguration(_message.Message):
    __slots__ = ("app_id", "tenant_id")
    APP_ID_FIELD_NUMBER: _ClassVar[int]
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    app_id: str
    tenant_id: str
    def __init__(self, app_id: _Optional[str] = ..., tenant_id: _Optional[str] = ...) -> None: ...

class TeamsAccountSecrets(_message.Message):
    __slots__ = ("app_secret",)
    APP_SECRET_FIELD_NUMBER: _ClassVar[int]
    app_secret: _surface_pb2.SurfaceSecretReference
    def __init__(self, app_secret: _Optional[_Union[_surface_pb2.SurfaceSecretReference, _Mapping]] = ...) -> None: ...

class DeclaredObjective(_message.Message):
    __slots__ = ("metadata", "spec")
    METADATA_FIELD_NUMBER: _ClassVar[int]
    SPEC_FIELD_NUMBER: _ClassVar[int]
    metadata: _common_pb2.Metadata
    spec: ObjectiveDeclaration
    def __init__(self, metadata: _Optional[_Union[_common_pb2.Metadata, _Mapping]] = ..., spec: _Optional[_Union[ObjectiveDeclaration, _Mapping]] = ...) -> None: ...

class ObjectiveDeclaration(_message.Message):
    __slots__ = ("owner", "outcome", "ongoing", "workspaces", "budget", "deadline", "runtime_actions", "team_name", "own_team")
    OWNER_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    ONGOING_FIELD_NUMBER: _ClassVar[int]
    WORKSPACES_FIELD_NUMBER: _ClassVar[int]
    BUDGET_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_ACTIONS_FIELD_NUMBER: _ClassVar[int]
    TEAM_NAME_FIELD_NUMBER: _ClassVar[int]
    OWN_TEAM_FIELD_NUMBER: _ClassVar[int]
    owner: str
    outcome: str
    ongoing: bool
    workspaces: _containers.RepeatedScalarFieldContainer[str]
    budget: ObjectiveBudgetDeclaration
    deadline: _timestamp_pb2.Timestamp
    runtime_actions: _containers.RepeatedScalarFieldContainer[str]
    team_name: str
    own_team: ObjectiveTeamDeclaration
    def __init__(self, owner: _Optional[str] = ..., outcome: _Optional[str] = ..., ongoing: _Optional[bool] = ..., workspaces: _Optional[_Iterable[str]] = ..., budget: _Optional[_Union[ObjectiveBudgetDeclaration, _Mapping]] = ..., deadline: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., runtime_actions: _Optional[_Iterable[str]] = ..., team_name: _Optional[str] = ..., own_team: _Optional[_Union[ObjectiveTeamDeclaration, _Mapping]] = ...) -> None: ...

class ObjectiveBudgetDeclaration(_message.Message):
    __slots__ = ("minor", "currency")
    MINOR_FIELD_NUMBER: _ClassVar[int]
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    minor: int
    currency: str
    def __init__(self, minor: _Optional[int] = ..., currency: _Optional[str] = ...) -> None: ...

class ObjectiveTeamDeclaration(_message.Message):
    __slots__ = ("name", "members", "max_concurrency")
    NAME_FIELD_NUMBER: _ClassVar[int]
    MEMBERS_FIELD_NUMBER: _ClassVar[int]
    MAX_CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    name: str
    members: _containers.RepeatedScalarFieldContainer[str]
    max_concurrency: int
    def __init__(self, name: _Optional[str] = ..., members: _Optional[_Iterable[str]] = ..., max_concurrency: _Optional[int] = ...) -> None: ...
