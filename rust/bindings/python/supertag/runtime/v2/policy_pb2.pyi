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
    __slots__ = ("item_id", "item_key", "type", "version", "required", "config_json")
    ITEM_ID_FIELD_NUMBER: _ClassVar[int]
    ITEM_KEY_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    CONFIG_JSON_FIELD_NUMBER: _ClassVar[int]
    item_id: str
    item_key: str
    type: str
    version: int
    required: bool
    config_json: str
    def __init__(self, item_id: _Optional[str] = ..., item_key: _Optional[str] = ..., type: _Optional[str] = ..., version: _Optional[int] = ..., required: _Optional[bool] = ..., config_json: _Optional[str] = ...) -> None: ...

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
    __slots__ = ("harness", "models", "efforts")
    HARNESS_FIELD_NUMBER: _ClassVar[int]
    MODELS_FIELD_NUMBER: _ClassVar[int]
    EFFORTS_FIELD_NUMBER: _ClassVar[int]
    harness: str
    models: _containers.RepeatedScalarFieldContainer[str]
    efforts: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, harness: _Optional[str] = ..., models: _Optional[_Iterable[str]] = ..., efforts: _Optional[_Iterable[str]] = ...) -> None: ...

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
    __slots__ = ("version", "roles", "permission_sets", "context_sets", "execution")
    VERSION_FIELD_NUMBER: _ClassVar[int]
    ROLES_FIELD_NUMBER: _ClassVar[int]
    PERMISSION_SETS_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_SETS_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_FIELD_NUMBER: _ClassVar[int]
    version: int
    roles: _containers.RepeatedCompositeFieldContainer[PolicyRoleSnapshot]
    permission_sets: _containers.RepeatedCompositeFieldContainer[PermissionSet]
    context_sets: _containers.RepeatedCompositeFieldContainer[ContextSet]
    execution: PolicyExecutionSettings
    def __init__(self, version: _Optional[int] = ..., roles: _Optional[_Iterable[_Union[PolicyRoleSnapshot, _Mapping]]] = ..., permission_sets: _Optional[_Iterable[_Union[PermissionSet, _Mapping]]] = ..., context_sets: _Optional[_Iterable[_Union[ContextSet, _Mapping]]] = ..., execution: _Optional[_Union[PolicyExecutionSettings, _Mapping]] = ...) -> None: ...

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
