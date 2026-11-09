import datetime

from google.protobuf import timestamp_pb2 as _timestamp_pb2
from supertag.operator.v1 import common_pb2 as _common_pb2
from supertag.operator.v1 import host_pb2 as _host_pb2
from supertag.operator.v1 import objective_pb2 as _objective_pb2
from supertag.operator.v1 import options_pb2 as _options_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ControlPlanePhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    CONTROL_PLANE_PHASE_UNSPECIFIED: _ClassVar[ControlPlanePhase]
    CONTROL_PLANE_PHASE_ACCEPTING: _ClassVar[ControlPlanePhase]
    CONTROL_PLANE_PHASE_DRAINING: _ClassVar[ControlPlanePhase]

class ControllerPhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    CONTROLLER_PHASE_UNSPECIFIED: _ClassVar[ControllerPhase]
    CONTROLLER_PHASE_RUNNING: _ClassVar[ControllerPhase]
    CONTROLLER_PHASE_DEGRADED: _ClassVar[ControllerPhase]
    CONTROLLER_PHASE_DRAINING: _ClassVar[ControllerPhase]
    CONTROLLER_PHASE_STOPPED: _ClassVar[ControllerPhase]
    CONTROLLER_PHASE_DISABLED: _ClassVar[ControllerPhase]

class SpendGrouping(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    SPEND_GROUPING_UNSPECIFIED: _ClassVar[SpendGrouping]
    SPEND_GROUPING_OBJECTIVE: _ClassVar[SpendGrouping]
    SPEND_GROUPING_TAG: _ClassVar[SpendGrouping]
    SPEND_GROUPING_DAY: _ClassVar[SpendGrouping]

class AuditOutcome(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    AUDIT_OUTCOME_UNSPECIFIED: _ClassVar[AuditOutcome]
    AUDIT_OUTCOME_SUCCEEDED: _ClassVar[AuditOutcome]
    AUDIT_OUTCOME_FAILED: _ClassVar[AuditOutcome]

class AuditSource(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    AUDIT_SOURCE_UNSPECIFIED: _ClassVar[AuditSource]
    AUDIT_SOURCE_API: _ClassVar[AuditSource]
    AUDIT_SOURCE_GATEWAY: _ClassVar[AuditSource]
CONTROL_PLANE_PHASE_UNSPECIFIED: ControlPlanePhase
CONTROL_PLANE_PHASE_ACCEPTING: ControlPlanePhase
CONTROL_PLANE_PHASE_DRAINING: ControlPlanePhase
CONTROLLER_PHASE_UNSPECIFIED: ControllerPhase
CONTROLLER_PHASE_RUNNING: ControllerPhase
CONTROLLER_PHASE_DEGRADED: ControllerPhase
CONTROLLER_PHASE_DRAINING: ControllerPhase
CONTROLLER_PHASE_STOPPED: ControllerPhase
CONTROLLER_PHASE_DISABLED: ControllerPhase
SPEND_GROUPING_UNSPECIFIED: SpendGrouping
SPEND_GROUPING_OBJECTIVE: SpendGrouping
SPEND_GROUPING_TAG: SpendGrouping
SPEND_GROUPING_DAY: SpendGrouping
AUDIT_OUTCOME_UNSPECIFIED: AuditOutcome
AUDIT_OUTCOME_SUCCEEDED: AuditOutcome
AUDIT_OUTCOME_FAILED: AuditOutcome
AUDIT_SOURCE_UNSPECIFIED: AuditSource
AUDIT_SOURCE_API: AuditSource
AUDIT_SOURCE_GATEWAY: AuditSource

class GetStatusRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class GetStatusResponse(_message.Message):
    __slots__ = ("metadata", "phase", "controllers")
    METADATA_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    CONTROLLERS_FIELD_NUMBER: _ClassVar[int]
    metadata: _common_pb2.Metadata
    phase: ControlPlanePhase
    controllers: _containers.RepeatedCompositeFieldContainer[Controller]
    def __init__(self, metadata: _Optional[_Union[_common_pb2.Metadata, _Mapping]] = ..., phase: _Optional[_Union[ControlPlanePhase, str]] = ..., controllers: _Optional[_Iterable[_Union[Controller, _Mapping]]] = ...) -> None: ...

class Controller(_message.Message):
    __slots__ = ("name", "phase")
    NAME_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    name: str
    phase: ControllerPhase
    def __init__(self, name: _Optional[str] = ..., phase: _Optional[_Union[ControllerPhase, str]] = ...) -> None: ...

class GetOrganizationRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class OrganizationOverview(_message.Message):
    __slots__ = ("captured_at", "worker_hosts", "tags", "objectives")
    CAPTURED_AT_FIELD_NUMBER: _ClassVar[int]
    WORKER_HOSTS_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    OBJECTIVES_FIELD_NUMBER: _ClassVar[int]
    captured_at: _timestamp_pb2.Timestamp
    worker_hosts: _containers.RepeatedCompositeFieldContainer[OrganizationWorkerHost]
    tags: _containers.RepeatedCompositeFieldContainer[OrganizationTag]
    objectives: _containers.RepeatedCompositeFieldContainer[OrganizationObjective]
    def __init__(self, captured_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., worker_hosts: _Optional[_Iterable[_Union[OrganizationWorkerHost, _Mapping]]] = ..., tags: _Optional[_Iterable[_Union[OrganizationTag, _Mapping]]] = ..., objectives: _Optional[_Iterable[_Union[OrganizationObjective, _Mapping]]] = ...) -> None: ...

class OrganizationWorkerHost(_message.Message):
    __slots__ = ("id", "phase", "running", "capacity", "coordination_capacity", "harnesses", "disk_space", "disk_warning")
    ID_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    RUNNING_FIELD_NUMBER: _ClassVar[int]
    CAPACITY_FIELD_NUMBER: _ClassVar[int]
    COORDINATION_CAPACITY_FIELD_NUMBER: _ClassVar[int]
    HARNESSES_FIELD_NUMBER: _ClassVar[int]
    DISK_SPACE_FIELD_NUMBER: _ClassVar[int]
    DISK_WARNING_FIELD_NUMBER: _ClassVar[int]
    id: str
    phase: _host_pb2.WorkerHostPhase
    running: int
    capacity: int
    coordination_capacity: int
    harnesses: _containers.RepeatedCompositeFieldContainer[HarnessLoad]
    disk_space: _host_pb2.DiskSpace
    disk_warning: str
    def __init__(self, id: _Optional[str] = ..., phase: _Optional[_Union[_host_pb2.WorkerHostPhase, str]] = ..., running: _Optional[int] = ..., capacity: _Optional[int] = ..., coordination_capacity: _Optional[int] = ..., harnesses: _Optional[_Iterable[_Union[HarnessLoad, _Mapping]]] = ..., disk_space: _Optional[_Union[_host_pb2.DiskSpace, _Mapping]] = ..., disk_warning: _Optional[str] = ...) -> None: ...

class HarnessLoad(_message.Message):
    __slots__ = ("harness", "running", "capacity", "coordination_capacity")
    HARNESS_FIELD_NUMBER: _ClassVar[int]
    RUNNING_FIELD_NUMBER: _ClassVar[int]
    CAPACITY_FIELD_NUMBER: _ClassVar[int]
    COORDINATION_CAPACITY_FIELD_NUMBER: _ClassVar[int]
    harness: str
    running: int
    capacity: int
    coordination_capacity: int
    def __init__(self, harness: _Optional[str] = ..., running: _Optional[int] = ..., capacity: _Optional[int] = ..., coordination_capacity: _Optional[int] = ...) -> None: ...

class OrganizationTag(_message.Message):
    __slots__ = ("id", "name", "running_task_ids", "running_commands")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    RUNNING_TASK_IDS_FIELD_NUMBER: _ClassVar[int]
    RUNNING_COMMANDS_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    running_task_ids: _containers.RepeatedScalarFieldContainer[str]
    running_commands: _containers.RepeatedCompositeFieldContainer[TagRunningCommand]
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., running_task_ids: _Optional[_Iterable[str]] = ..., running_commands: _Optional[_Iterable[_Union[TagRunningCommand, _Mapping]]] = ...) -> None: ...

class TagRunningCommand(_message.Message):
    __slots__ = ("task_id", "command", "started_at")
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    COMMAND_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    task_id: str
    command: str
    started_at: _timestamp_pb2.Timestamp
    def __init__(self, task_id: _Optional[str] = ..., command: _Optional[str] = ..., started_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class OrganizationObjective(_message.Message):
    __slots__ = ("id", "status", "owner_tag_id", "owner", "deadline", "spent_minor", "budget_limit_minor", "currency", "spend_currency", "unpriced_attempts", "unpriced_tokens", "high_findings")
    ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    OWNER_TAG_ID_FIELD_NUMBER: _ClassVar[int]
    OWNER_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_FIELD_NUMBER: _ClassVar[int]
    SPENT_MINOR_FIELD_NUMBER: _ClassVar[int]
    BUDGET_LIMIT_MINOR_FIELD_NUMBER: _ClassVar[int]
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    SPEND_CURRENCY_FIELD_NUMBER: _ClassVar[int]
    UNPRICED_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    UNPRICED_TOKENS_FIELD_NUMBER: _ClassVar[int]
    HIGH_FINDINGS_FIELD_NUMBER: _ClassVar[int]
    id: str
    status: _objective_pb2.ObjectiveStatus
    owner_tag_id: str
    owner: str
    deadline: _timestamp_pb2.Timestamp
    spent_minor: int
    budget_limit_minor: int
    currency: str
    spend_currency: str
    unpriced_attempts: int
    unpriced_tokens: int
    high_findings: _containers.RepeatedCompositeFieldContainer[_objective_pb2.HighFinding]
    def __init__(self, id: _Optional[str] = ..., status: _Optional[_Union[_objective_pb2.ObjectiveStatus, str]] = ..., owner_tag_id: _Optional[str] = ..., owner: _Optional[str] = ..., deadline: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., spent_minor: _Optional[int] = ..., budget_limit_minor: _Optional[int] = ..., currency: _Optional[str] = ..., spend_currency: _Optional[str] = ..., unpriced_attempts: _Optional[int] = ..., unpriced_tokens: _Optional[int] = ..., high_findings: _Optional[_Iterable[_Union[_objective_pb2.HighFinding, _Mapping]]] = ...) -> None: ...

class GetSpendRequest(_message.Message):
    __slots__ = ("by", "since")
    BY_FIELD_NUMBER: _ClassVar[int]
    SINCE_FIELD_NUMBER: _ClassVar[int]
    by: SpendGrouping
    since: _timestamp_pb2.Timestamp
    def __init__(self, by: _Optional[_Union[SpendGrouping, str]] = ..., since: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class SpendReport(_message.Message):
    __slots__ = ("by", "since", "groups")
    BY_FIELD_NUMBER: _ClassVar[int]
    SINCE_FIELD_NUMBER: _ClassVar[int]
    GROUPS_FIELD_NUMBER: _ClassVar[int]
    by: SpendGrouping
    since: _timestamp_pb2.Timestamp
    groups: _containers.RepeatedCompositeFieldContainer[SpendGroup]
    def __init__(self, by: _Optional[_Union[SpendGrouping, str]] = ..., since: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., groups: _Optional[_Iterable[_Union[SpendGroup, _Mapping]]] = ...) -> None: ...

class SpendGroup(_message.Message):
    __slots__ = ("key", "name", "budget", "attempts", "reported_cost_by_currency", "unknown_cost_attempts", "estimated_cost_attempts", "unpriced_models", "unpriced_tokens", "reported_tokens", "unknown_token_attempts")
    class ReportedCostByCurrencyEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: int
        def __init__(self, key: _Optional[str] = ..., value: _Optional[int] = ...) -> None: ...
    class UnpricedModelsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: int
        def __init__(self, key: _Optional[str] = ..., value: _Optional[int] = ...) -> None: ...
    KEY_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    BUDGET_FIELD_NUMBER: _ClassVar[int]
    ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    REPORTED_COST_BY_CURRENCY_FIELD_NUMBER: _ClassVar[int]
    UNKNOWN_COST_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    ESTIMATED_COST_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    UNPRICED_MODELS_FIELD_NUMBER: _ClassVar[int]
    UNPRICED_TOKENS_FIELD_NUMBER: _ClassVar[int]
    REPORTED_TOKENS_FIELD_NUMBER: _ClassVar[int]
    UNKNOWN_TOKEN_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    key: str
    name: str
    budget: _objective_pb2.Budget
    attempts: int
    reported_cost_by_currency: _containers.ScalarMap[str, int]
    unknown_cost_attempts: int
    estimated_cost_attempts: int
    unpriced_models: _containers.ScalarMap[str, int]
    unpriced_tokens: int
    reported_tokens: int
    unknown_token_attempts: int
    def __init__(self, key: _Optional[str] = ..., name: _Optional[str] = ..., budget: _Optional[_Union[_objective_pb2.Budget, _Mapping]] = ..., attempts: _Optional[int] = ..., reported_cost_by_currency: _Optional[_Mapping[str, int]] = ..., unknown_cost_attempts: _Optional[int] = ..., estimated_cost_attempts: _Optional[int] = ..., unpriced_models: _Optional[_Mapping[str, int]] = ..., unpriced_tokens: _Optional[int] = ..., reported_tokens: _Optional[int] = ..., unknown_token_attempts: _Optional[int] = ...) -> None: ...

class ListAuditEntriesRequest(_message.Message):
    __slots__ = ("since", "actor", "page_size", "page_token")
    SINCE_FIELD_NUMBER: _ClassVar[int]
    ACTOR_FIELD_NUMBER: _ClassVar[int]
    PAGE_SIZE_FIELD_NUMBER: _ClassVar[int]
    PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    since: _timestamp_pb2.Timestamp
    actor: str
    page_size: int
    page_token: str
    def __init__(self, since: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., actor: _Optional[str] = ..., page_size: _Optional[int] = ..., page_token: _Optional[str] = ...) -> None: ...

class ListAuditEntriesResponse(_message.Message):
    __slots__ = ("entries", "next_page_token")
    ENTRIES_FIELD_NUMBER: _ClassVar[int]
    NEXT_PAGE_TOKEN_FIELD_NUMBER: _ClassVar[int]
    entries: _containers.RepeatedCompositeFieldContainer[AuditEntry]
    next_page_token: str
    def __init__(self, entries: _Optional[_Iterable[_Union[AuditEntry, _Mapping]]] = ..., next_page_token: _Optional[str] = ...) -> None: ...

class AuditEntry(_message.Message):
    __slots__ = ("id", "at", "actor", "action", "target", "outcome", "status", "source", "method", "path")
    ID_FIELD_NUMBER: _ClassVar[int]
    AT_FIELD_NUMBER: _ClassVar[int]
    ACTOR_FIELD_NUMBER: _ClassVar[int]
    ACTION_FIELD_NUMBER: _ClassVar[int]
    TARGET_FIELD_NUMBER: _ClassVar[int]
    OUTCOME_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    METHOD_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    id: str
    at: _timestamp_pb2.Timestamp
    actor: str
    action: str
    target: str
    outcome: AuditOutcome
    status: int
    source: AuditSource
    method: str
    path: str
    def __init__(self, id: _Optional[str] = ..., at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., actor: _Optional[str] = ..., action: _Optional[str] = ..., target: _Optional[str] = ..., outcome: _Optional[_Union[AuditOutcome, str]] = ..., status: _Optional[int] = ..., source: _Optional[_Union[AuditSource, str]] = ..., method: _Optional[str] = ..., path: _Optional[str] = ...) -> None: ...

class GetMetricsRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class MetricSnapshot(_message.Message):
    __slots__ = ("captured_at", "tags", "roles", "role_assignments", "surface_accounts", "permission_sets", "context_sets", "sessions", "tasks", "recovery", "coordination_inbox", "usage", "native_agents", "scheduling", "mailbox", "reply_delivery", "rpc")
    CAPTURED_AT_FIELD_NUMBER: _ClassVar[int]
    TAGS_FIELD_NUMBER: _ClassVar[int]
    ROLES_FIELD_NUMBER: _ClassVar[int]
    ROLE_ASSIGNMENTS_FIELD_NUMBER: _ClassVar[int]
    SURFACE_ACCOUNTS_FIELD_NUMBER: _ClassVar[int]
    PERMISSION_SETS_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_SETS_FIELD_NUMBER: _ClassVar[int]
    SESSIONS_FIELD_NUMBER: _ClassVar[int]
    TASKS_FIELD_NUMBER: _ClassVar[int]
    RECOVERY_FIELD_NUMBER: _ClassVar[int]
    COORDINATION_INBOX_FIELD_NUMBER: _ClassVar[int]
    USAGE_FIELD_NUMBER: _ClassVar[int]
    NATIVE_AGENTS_FIELD_NUMBER: _ClassVar[int]
    SCHEDULING_FIELD_NUMBER: _ClassVar[int]
    MAILBOX_FIELD_NUMBER: _ClassVar[int]
    REPLY_DELIVERY_FIELD_NUMBER: _ClassVar[int]
    RPC_FIELD_NUMBER: _ClassVar[int]
    captured_at: _timestamp_pb2.Timestamp
    tags: int
    roles: int
    role_assignments: int
    surface_accounts: int
    permission_sets: int
    context_sets: int
    sessions: int
    tasks: TaskCounts
    recovery: RecoveryMetrics
    coordination_inbox: InboxMetrics
    usage: UsageMetrics
    native_agents: NativeAgentMetrics
    scheduling: SchedulingMetrics
    mailbox: BacklogMetrics
    reply_delivery: ReplyDeliveryMetrics
    rpc: RpcMetrics
    def __init__(self, captured_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., tags: _Optional[int] = ..., roles: _Optional[int] = ..., role_assignments: _Optional[int] = ..., surface_accounts: _Optional[int] = ..., permission_sets: _Optional[int] = ..., context_sets: _Optional[int] = ..., sessions: _Optional[int] = ..., tasks: _Optional[_Union[TaskCounts, _Mapping]] = ..., recovery: _Optional[_Union[RecoveryMetrics, _Mapping]] = ..., coordination_inbox: _Optional[_Union[InboxMetrics, _Mapping]] = ..., usage: _Optional[_Union[UsageMetrics, _Mapping]] = ..., native_agents: _Optional[_Union[NativeAgentMetrics, _Mapping]] = ..., scheduling: _Optional[_Union[SchedulingMetrics, _Mapping]] = ..., mailbox: _Optional[_Union[BacklogMetrics, _Mapping]] = ..., reply_delivery: _Optional[_Union[ReplyDeliveryMetrics, _Mapping]] = ..., rpc: _Optional[_Union[RpcMetrics, _Mapping]] = ...) -> None: ...

class TaskCounts(_message.Message):
    __slots__ = ("total", "pending", "running", "completed", "failed", "cancelled")
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    PENDING_FIELD_NUMBER: _ClassVar[int]
    RUNNING_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_FIELD_NUMBER: _ClassVar[int]
    FAILED_FIELD_NUMBER: _ClassVar[int]
    CANCELLED_FIELD_NUMBER: _ClassVar[int]
    total: int
    pending: int
    running: int
    completed: int
    failed: int
    cancelled: int
    def __init__(self, total: _Optional[int] = ..., pending: _Optional[int] = ..., running: _Optional[int] = ..., completed: _Optional[int] = ..., failed: _Optional[int] = ..., cancelled: _Optional[int] = ...) -> None: ...

class RecoveryMetrics(_message.Message):
    __slots__ = ("unknown_control_deliveries", "blocked_sessions", "durable_executions_awaiting_reconciliation")
    UNKNOWN_CONTROL_DELIVERIES_FIELD_NUMBER: _ClassVar[int]
    BLOCKED_SESSIONS_FIELD_NUMBER: _ClassVar[int]
    DURABLE_EXECUTIONS_AWAITING_RECONCILIATION_FIELD_NUMBER: _ClassVar[int]
    unknown_control_deliveries: int
    blocked_sessions: int
    durable_executions_awaiting_reconciliation: int
    def __init__(self, unknown_control_deliveries: _Optional[int] = ..., blocked_sessions: _Optional[int] = ..., durable_executions_awaiting_reconciliation: _Optional[int] = ...) -> None: ...

class InboxMetrics(_message.Message):
    __slots__ = ("pending", "by_kind", "oldest_actionable_at", "oldest_actionable_age_seconds")
    class ByKindEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: int
        def __init__(self, key: _Optional[str] = ..., value: _Optional[int] = ...) -> None: ...
    PENDING_FIELD_NUMBER: _ClassVar[int]
    BY_KIND_FIELD_NUMBER: _ClassVar[int]
    OLDEST_ACTIONABLE_AT_FIELD_NUMBER: _ClassVar[int]
    OLDEST_ACTIONABLE_AGE_SECONDS_FIELD_NUMBER: _ClassVar[int]
    pending: int
    by_kind: _containers.ScalarMap[str, int]
    oldest_actionable_at: _timestamp_pb2.Timestamp
    oldest_actionable_age_seconds: int
    def __init__(self, pending: _Optional[int] = ..., by_kind: _Optional[_Mapping[str, int]] = ..., oldest_actionable_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., oldest_actionable_age_seconds: _Optional[int] = ...) -> None: ...

class UsageMetrics(_message.Message):
    __slots__ = ("reporting_attempts", "total_tokens", "incomplete_attempts", "reported_cost_by_currency")
    class ReportedCostByCurrencyEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: int
        def __init__(self, key: _Optional[str] = ..., value: _Optional[int] = ...) -> None: ...
    REPORTING_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TOKENS_FIELD_NUMBER: _ClassVar[int]
    INCOMPLETE_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    REPORTED_COST_BY_CURRENCY_FIELD_NUMBER: _ClassVar[int]
    reporting_attempts: int
    total_tokens: int
    incomplete_attempts: int
    reported_cost_by_currency: _containers.ScalarMap[str, int]
    def __init__(self, reporting_attempts: _Optional[int] = ..., total_tokens: _Optional[int] = ..., incomplete_attempts: _Optional[int] = ..., reported_cost_by_currency: _Optional[_Mapping[str, int]] = ...) -> None: ...

class NativeAgentMetrics(_message.Message):
    __slots__ = ("peak_concurrent", "token_limit_interruptions", "agent_limit_interruptions")
    PEAK_CONCURRENT_FIELD_NUMBER: _ClassVar[int]
    TOKEN_LIMIT_INTERRUPTIONS_FIELD_NUMBER: _ClassVar[int]
    AGENT_LIMIT_INTERRUPTIONS_FIELD_NUMBER: _ClassVar[int]
    peak_concurrent: int
    token_limit_interruptions: int
    agent_limit_interruptions: int
    def __init__(self, peak_concurrent: _Optional[int] = ..., token_limit_interruptions: _Optional[int] = ..., agent_limit_interruptions: _Optional[int] = ...) -> None: ...

class SchedulingMetrics(_message.Message):
    __slots__ = ("queued", "oldest_queued_at", "oldest_queued_age_seconds", "placed_attempts", "average_queue_duration_ms", "maximum_queue_duration_ms", "average_placement_duration_ms", "maximum_placement_duration_ms", "admission_rejections", "reservations", "worker_hosts")
    QUEUED_FIELD_NUMBER: _ClassVar[int]
    OLDEST_QUEUED_AT_FIELD_NUMBER: _ClassVar[int]
    OLDEST_QUEUED_AGE_SECONDS_FIELD_NUMBER: _ClassVar[int]
    PLACED_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    AVERAGE_QUEUE_DURATION_MS_FIELD_NUMBER: _ClassVar[int]
    MAXIMUM_QUEUE_DURATION_MS_FIELD_NUMBER: _ClassVar[int]
    AVERAGE_PLACEMENT_DURATION_MS_FIELD_NUMBER: _ClassVar[int]
    MAXIMUM_PLACEMENT_DURATION_MS_FIELD_NUMBER: _ClassVar[int]
    ADMISSION_REJECTIONS_FIELD_NUMBER: _ClassVar[int]
    RESERVATIONS_FIELD_NUMBER: _ClassVar[int]
    WORKER_HOSTS_FIELD_NUMBER: _ClassVar[int]
    queued: int
    oldest_queued_at: _timestamp_pb2.Timestamp
    oldest_queued_age_seconds: int
    placed_attempts: int
    average_queue_duration_ms: float
    maximum_queue_duration_ms: float
    average_placement_duration_ms: float
    maximum_placement_duration_ms: float
    admission_rejections: int
    reservations: ReservationMetrics
    worker_hosts: _containers.RepeatedCompositeFieldContainer[WorkerHostUtilization]
    def __init__(self, queued: _Optional[int] = ..., oldest_queued_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., oldest_queued_age_seconds: _Optional[int] = ..., placed_attempts: _Optional[int] = ..., average_queue_duration_ms: _Optional[float] = ..., maximum_queue_duration_ms: _Optional[float] = ..., average_placement_duration_ms: _Optional[float] = ..., maximum_placement_duration_ms: _Optional[float] = ..., admission_rejections: _Optional[int] = ..., reservations: _Optional[_Union[ReservationMetrics, _Mapping]] = ..., worker_hosts: _Optional[_Iterable[_Union[WorkerHostUtilization, _Mapping]]] = ...) -> None: ...

class ReservationMetrics(_message.Message):
    __slots__ = ("consumed", "active", "expired")
    CONSUMED_FIELD_NUMBER: _ClassVar[int]
    ACTIVE_FIELD_NUMBER: _ClassVar[int]
    EXPIRED_FIELD_NUMBER: _ClassVar[int]
    consumed: int
    active: int
    expired: int
    def __init__(self, consumed: _Optional[int] = ..., active: _Optional[int] = ..., expired: _Optional[int] = ...) -> None: ...

class WorkerHostUtilization(_message.Message):
    __slots__ = ("id", "phase", "active_attempts", "capacity", "available_slots", "utilization")
    ID_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    ACTIVE_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    CAPACITY_FIELD_NUMBER: _ClassVar[int]
    AVAILABLE_SLOTS_FIELD_NUMBER: _ClassVar[int]
    UTILIZATION_FIELD_NUMBER: _ClassVar[int]
    id: str
    phase: _host_pb2.WorkerHostPhase
    active_attempts: int
    capacity: int
    available_slots: int
    utilization: float
    def __init__(self, id: _Optional[str] = ..., phase: _Optional[_Union[_host_pb2.WorkerHostPhase, str]] = ..., active_attempts: _Optional[int] = ..., capacity: _Optional[int] = ..., available_slots: _Optional[int] = ..., utilization: _Optional[float] = ...) -> None: ...

class BacklogMetrics(_message.Message):
    __slots__ = ("pending", "oldest_pending_at")
    PENDING_FIELD_NUMBER: _ClassVar[int]
    OLDEST_PENDING_AT_FIELD_NUMBER: _ClassVar[int]
    pending: int
    oldest_pending_at: _timestamp_pb2.Timestamp
    def __init__(self, pending: _Optional[int] = ..., oldest_pending_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class ReplyDeliveryMetrics(_message.Message):
    __slots__ = ("backlog", "retrying", "retry_attempts", "failed", "oldest_pending_at")
    BACKLOG_FIELD_NUMBER: _ClassVar[int]
    RETRYING_FIELD_NUMBER: _ClassVar[int]
    RETRY_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    FAILED_FIELD_NUMBER: _ClassVar[int]
    OLDEST_PENDING_AT_FIELD_NUMBER: _ClassVar[int]
    backlog: int
    retrying: int
    retry_attempts: int
    failed: int
    oldest_pending_at: _timestamp_pb2.Timestamp
    def __init__(self, backlog: _Optional[int] = ..., retrying: _Optional[int] = ..., retry_attempts: _Optional[int] = ..., failed: _Optional[int] = ..., oldest_pending_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class RpcMetrics(_message.Message):
    __slots__ = ("started_at", "captured_at", "methods", "channels", "queues", "close_codes", "trace_errors")
    class CloseCodesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: int
        def __init__(self, key: _Optional[str] = ..., value: _Optional[int] = ...) -> None: ...
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    CAPTURED_AT_FIELD_NUMBER: _ClassVar[int]
    METHODS_FIELD_NUMBER: _ClassVar[int]
    CHANNELS_FIELD_NUMBER: _ClassVar[int]
    QUEUES_FIELD_NUMBER: _ClassVar[int]
    CLOSE_CODES_FIELD_NUMBER: _ClassVar[int]
    TRACE_ERRORS_FIELD_NUMBER: _ClassVar[int]
    started_at: _timestamp_pb2.Timestamp
    captured_at: _timestamp_pb2.Timestamp
    methods: _containers.RepeatedCompositeFieldContainer[RpcMethodMetrics]
    channels: RpcChannelMetrics
    queues: RpcQueueMetrics
    close_codes: _containers.ScalarMap[str, int]
    trace_errors: int
    def __init__(self, started_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., captured_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., methods: _Optional[_Iterable[_Union[RpcMethodMetrics, _Mapping]]] = ..., channels: _Optional[_Union[RpcChannelMetrics, _Mapping]] = ..., queues: _Optional[_Union[RpcQueueMetrics, _Mapping]] = ..., close_codes: _Optional[_Mapping[str, int]] = ..., trace_errors: _Optional[int] = ...) -> None: ...

class RpcMethodMetrics(_message.Message):
    __slots__ = ("service", "method", "started", "completed", "active", "active_streams", "errors", "status_codes", "duration")
    SERVICE_FIELD_NUMBER: _ClassVar[int]
    METHOD_FIELD_NUMBER: _ClassVar[int]
    STARTED_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_FIELD_NUMBER: _ClassVar[int]
    ACTIVE_FIELD_NUMBER: _ClassVar[int]
    ACTIVE_STREAMS_FIELD_NUMBER: _ClassVar[int]
    ERRORS_FIELD_NUMBER: _ClassVar[int]
    STATUS_CODES_FIELD_NUMBER: _ClassVar[int]
    DURATION_FIELD_NUMBER: _ClassVar[int]
    service: str
    method: str
    started: int
    completed: int
    active: int
    active_streams: int
    errors: int
    status_codes: _containers.RepeatedScalarFieldContainer[int]
    duration: RpcDurationMetrics
    def __init__(self, service: _Optional[str] = ..., method: _Optional[str] = ..., started: _Optional[int] = ..., completed: _Optional[int] = ..., active: _Optional[int] = ..., active_streams: _Optional[int] = ..., errors: _Optional[int] = ..., status_codes: _Optional[_Iterable[int]] = ..., duration: _Optional[_Union[RpcDurationMetrics, _Mapping]] = ...) -> None: ...

class RpcDurationMetrics(_message.Message):
    __slots__ = ("count", "total", "max", "buckets")
    COUNT_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    MAX_FIELD_NUMBER: _ClassVar[int]
    BUCKETS_FIELD_NUMBER: _ClassVar[int]
    count: int
    total: float
    max: float
    buckets: _containers.RepeatedCompositeFieldContainer[RpcDurationBucket]
    def __init__(self, count: _Optional[int] = ..., total: _Optional[float] = ..., max: _Optional[float] = ..., buckets: _Optional[_Iterable[_Union[RpcDurationBucket, _Mapping]]] = ...) -> None: ...

class RpcDurationBucket(_message.Message):
    __slots__ = ("le", "count")
    LE_FIELD_NUMBER: _ClassVar[int]
    COUNT_FIELD_NUMBER: _ClassVar[int]
    le: float
    count: int
    def __init__(self, le: _Optional[float] = ..., count: _Optional[int] = ...) -> None: ...

class RpcChannelMetrics(_message.Message):
    __slots__ = ("active", "opened", "closed")
    ACTIVE_FIELD_NUMBER: _ClassVar[int]
    OPENED_FIELD_NUMBER: _ClassVar[int]
    CLOSED_FIELD_NUMBER: _ClassVar[int]
    active: int
    opened: int
    closed: int
    def __init__(self, active: _Optional[int] = ..., opened: _Optional[int] = ..., closed: _Optional[int] = ...) -> None: ...

class RpcQueueMetrics(_message.Message):
    __slots__ = ("active", "frames", "bytes", "capacity_frames", "capacity_bytes", "peak_frames", "peak_bytes", "rejections")
    ACTIVE_FIELD_NUMBER: _ClassVar[int]
    FRAMES_FIELD_NUMBER: _ClassVar[int]
    BYTES_FIELD_NUMBER: _ClassVar[int]
    CAPACITY_FRAMES_FIELD_NUMBER: _ClassVar[int]
    CAPACITY_BYTES_FIELD_NUMBER: _ClassVar[int]
    PEAK_FRAMES_FIELD_NUMBER: _ClassVar[int]
    PEAK_BYTES_FIELD_NUMBER: _ClassVar[int]
    REJECTIONS_FIELD_NUMBER: _ClassVar[int]
    active: int
    frames: int
    bytes: int
    capacity_frames: int
    capacity_bytes: int
    peak_frames: int
    peak_bytes: int
    rejections: int
    def __init__(self, active: _Optional[int] = ..., frames: _Optional[int] = ..., bytes: _Optional[int] = ..., capacity_frames: _Optional[int] = ..., capacity_bytes: _Optional[int] = ..., peak_frames: _Optional[int] = ..., peak_bytes: _Optional[int] = ..., rejections: _Optional[int] = ...) -> None: ...
