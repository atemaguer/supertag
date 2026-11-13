from . import runtime_pb2 as _runtime_pb2
from . import spend_pb2 as _spend_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GetMetricsRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class MetricSnapshot(_message.Message):
    __slots__ = ("captured_at_ms", "resources", "tasks", "usage", "scheduling", "mailbox", "reply_delivery")
    CAPTURED_AT_MS_FIELD_NUMBER: _ClassVar[int]
    RESOURCES_FIELD_NUMBER: _ClassVar[int]
    TASKS_FIELD_NUMBER: _ClassVar[int]
    USAGE_FIELD_NUMBER: _ClassVar[int]
    SCHEDULING_FIELD_NUMBER: _ClassVar[int]
    MAILBOX_FIELD_NUMBER: _ClassVar[int]
    REPLY_DELIVERY_FIELD_NUMBER: _ClassVar[int]
    captured_at_ms: int
    resources: MetricResources
    tasks: MetricTaskCounts
    usage: MetricUsage
    scheduling: MetricScheduling
    mailbox: MetricBacklog
    reply_delivery: MetricReplyDelivery
    def __init__(self, captured_at_ms: _Optional[int] = ..., resources: _Optional[_Union[MetricResources, _Mapping]] = ..., tasks: _Optional[_Union[MetricTaskCounts, _Mapping]] = ..., usage: _Optional[_Union[MetricUsage, _Mapping]] = ..., scheduling: _Optional[_Union[MetricScheduling, _Mapping]] = ..., mailbox: _Optional[_Union[MetricBacklog, _Mapping]] = ..., reply_delivery: _Optional[_Union[MetricReplyDelivery, _Mapping]] = ...) -> None: ...

class MetricResources(_message.Message):
    __slots__ = ("tags", "roles", "role_assignments", "surface_accounts", "permission_sets", "context_sets", "sessions")
    TAGS_FIELD_NUMBER: _ClassVar[int]
    ROLES_FIELD_NUMBER: _ClassVar[int]
    ROLE_ASSIGNMENTS_FIELD_NUMBER: _ClassVar[int]
    SURFACE_ACCOUNTS_FIELD_NUMBER: _ClassVar[int]
    PERMISSION_SETS_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_SETS_FIELD_NUMBER: _ClassVar[int]
    SESSIONS_FIELD_NUMBER: _ClassVar[int]
    tags: int
    roles: int
    role_assignments: int
    surface_accounts: int
    permission_sets: int
    context_sets: int
    sessions: int
    def __init__(self, tags: _Optional[int] = ..., roles: _Optional[int] = ..., role_assignments: _Optional[int] = ..., surface_accounts: _Optional[int] = ..., permission_sets: _Optional[int] = ..., context_sets: _Optional[int] = ..., sessions: _Optional[int] = ...) -> None: ...

class MetricTaskCounts(_message.Message):
    __slots__ = ("total", "queued", "claimed", "running", "uncertain", "succeeded", "failed", "cancelled")
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    QUEUED_FIELD_NUMBER: _ClassVar[int]
    CLAIMED_FIELD_NUMBER: _ClassVar[int]
    RUNNING_FIELD_NUMBER: _ClassVar[int]
    UNCERTAIN_FIELD_NUMBER: _ClassVar[int]
    SUCCEEDED_FIELD_NUMBER: _ClassVar[int]
    FAILED_FIELD_NUMBER: _ClassVar[int]
    CANCELLED_FIELD_NUMBER: _ClassVar[int]
    total: int
    queued: int
    claimed: int
    running: int
    uncertain: int
    succeeded: int
    failed: int
    cancelled: int
    def __init__(self, total: _Optional[int] = ..., queued: _Optional[int] = ..., claimed: _Optional[int] = ..., running: _Optional[int] = ..., uncertain: _Optional[int] = ..., succeeded: _Optional[int] = ..., failed: _Optional[int] = ..., cancelled: _Optional[int] = ...) -> None: ...

class MetricUsage(_message.Message):
    __slots__ = ("attempts", "reported_tokens", "unknown_token_attempts", "reported_cost", "unknown_cost_attempts", "estimated_cost_attempts")
    ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    REPORTED_TOKENS_FIELD_NUMBER: _ClassVar[int]
    UNKNOWN_TOKEN_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    REPORTED_COST_FIELD_NUMBER: _ClassVar[int]
    UNKNOWN_COST_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    ESTIMATED_COST_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    attempts: int
    reported_tokens: int
    unknown_token_attempts: int
    reported_cost: _containers.RepeatedCompositeFieldContainer[_spend_pb2.SpendAmount]
    unknown_cost_attempts: int
    estimated_cost_attempts: int
    def __init__(self, attempts: _Optional[int] = ..., reported_tokens: _Optional[int] = ..., unknown_token_attempts: _Optional[int] = ..., reported_cost: _Optional[_Iterable[_Union[_spend_pb2.SpendAmount, _Mapping]]] = ..., unknown_cost_attempts: _Optional[int] = ..., estimated_cost_attempts: _Optional[int] = ...) -> None: ...

class MetricScheduling(_message.Message):
    __slots__ = ("queued", "worker_hosts")
    QUEUED_FIELD_NUMBER: _ClassVar[int]
    WORKER_HOSTS_FIELD_NUMBER: _ClassVar[int]
    queued: int
    worker_hosts: _containers.RepeatedCompositeFieldContainer[MetricWorkerHost]
    def __init__(self, queued: _Optional[int] = ..., worker_hosts: _Optional[_Iterable[_Union[MetricWorkerHost, _Mapping]]] = ...) -> None: ...

class MetricWorkerHost(_message.Message):
    __slots__ = ("host_id", "phase", "draining", "capacity", "available_slots", "active_attempts")
    HOST_ID_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    DRAINING_FIELD_NUMBER: _ClassVar[int]
    CAPACITY_FIELD_NUMBER: _ClassVar[int]
    AVAILABLE_SLOTS_FIELD_NUMBER: _ClassVar[int]
    ACTIVE_ATTEMPTS_FIELD_NUMBER: _ClassVar[int]
    host_id: str
    phase: _runtime_pb2.HostPhase
    draining: bool
    capacity: int
    available_slots: int
    active_attempts: int
    def __init__(self, host_id: _Optional[str] = ..., phase: _Optional[_Union[_runtime_pb2.HostPhase, str]] = ..., draining: _Optional[bool] = ..., capacity: _Optional[int] = ..., available_slots: _Optional[int] = ..., active_attempts: _Optional[int] = ...) -> None: ...

class MetricBacklog(_message.Message):
    __slots__ = ("pending", "oldest_pending_at_ms")
    PENDING_FIELD_NUMBER: _ClassVar[int]
    OLDEST_PENDING_AT_MS_FIELD_NUMBER: _ClassVar[int]
    pending: int
    oldest_pending_at_ms: int
    def __init__(self, pending: _Optional[int] = ..., oldest_pending_at_ms: _Optional[int] = ...) -> None: ...

class MetricReplyDelivery(_message.Message):
    __slots__ = ("backlog", "failed")
    BACKLOG_FIELD_NUMBER: _ClassVar[int]
    FAILED_FIELD_NUMBER: _ClassVar[int]
    backlog: int
    failed: int
    def __init__(self, backlog: _Optional[int] = ..., failed: _Optional[int] = ...) -> None: ...
