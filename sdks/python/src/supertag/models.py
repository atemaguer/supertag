from __future__ import annotations

from dataclasses import dataclass, field, fields
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Literal, Mapping, Protocol, runtime_checkable

EVENT_STREAM_CAPABILITY = "supertag.task-attempt.events"
CANCELLATION_CAPABILITY = "supertag.task-attempt.cancellation"
JsonRecord = dict[str, Any]


@dataclass(frozen=True)
class TaskProgressItem:
    id: str
    text: str
    status: Literal["active", "blocked", "completed", "pending"]

    @classmethod
    def from_wire(cls, value: Mapping[str, Any]) -> TaskProgressItem:
        status = required_text(value, "status")
        if status not in {"active", "blocked", "completed", "pending"}:
            raise ValueError(f"Unsupported Task progress item status: {status}")
        return cls(
            id=_bounded_progress_text(required_text(value, "id"), "Task progress item id", 128),
            text=_bounded_progress_text(
                required_text(value, "text"), "Task progress item text", 160
            ),
            status=status,
        )

    def to_wire(self) -> JsonRecord:
        return {"id": self.id, "text": self.text, "status": self.status}


@dataclass(frozen=True)
class TaskProgress:
    summary: str
    items: tuple[TaskProgressItem, ...] = ()

    @classmethod
    def from_wire(cls, value: Mapping[str, Any]) -> TaskProgress:
        raw_items = value.get("items", [])
        if not isinstance(raw_items, (list, tuple)):
            raise ValueError("Task progress items must be a list")
        if len(raw_items) > 8:
            raise ValueError("Task progress cannot contain more than 8 items")
        items = tuple(
            TaskProgressItem.from_wire(item) for item in raw_items if isinstance(item, Mapping)
        )
        if len(items) != len(raw_items):
            raise ValueError("Task progress items must be objects")
        if len({item.id for item in items}) != len(items):
            raise ValueError("Task progress item ids must be unique")
        return cls(
            summary=_bounded_progress_text(
                required_text(value, "summary"), "Task progress summary", 240
            ),
            items=items,
        )

    def to_wire(self) -> JsonRecord:
        return {
            "summary": self.summary,
            **({} if not self.items else {"items": [item.to_wire() for item in self.items]}),
        }

    def event(self) -> JsonRecord:
        return {"type": "progress.updated", "progress": self.to_wire()}


def _bounded_progress_text(value: str, label: str, maximum: int) -> str:
    text = " ".join(value.split())
    if not text:
        raise ValueError(f"{label} must not be empty")
    if len(text) > maximum:
        raise ValueError(f"{label} must not exceed {maximum} characters")
    return text


@dataclass(frozen=True)
class WorkerProfileRef:
    id: str
    revision: str

    def to_wire(self) -> JsonRecord:
        return {"id": self.id, "revision": self.revision}


@dataclass(frozen=True)
class ArtifactSelection:
    """Exact captured artifact entries submitted or selected as Task work."""

    artifact_id: str
    paths: tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.artifact_id or not 1 <= len(self.paths) <= 100:
            raise ValueError("Artifact selection requires an identity and 1 through 100 paths")
        if len(set(self.paths)) != len(self.paths):
            raise ValueError("Artifact selection paths must be unique")
        for path in self.paths:
            if (
                not path
                or path.startswith("/")
                or "\\" in path
                or any(part in {"", ".", ".."} for part in path.split("/"))
            ):
                raise ValueError("Artifact path must be a canonical relative path")

    @classmethod
    def from_wire(cls, value: Mapping[str, Any]) -> ArtifactSelection:
        paths = value.get("paths")
        if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths):
            raise ValueError("Artifact selection paths must be strings")
        if set(value) != {"artifactId", "paths"}:
            raise ValueError("Artifact selection accepts only artifactId and paths")
        return cls(required_text(value, "artifactId"), tuple(paths))

    def to_wire(self) -> JsonRecord:
        return {"artifactId": self.artifact_id, "paths": list(self.paths)}


@dataclass(frozen=True)
class ResourceRef:
    uri: str
    media_type: str | None = None
    digest: str | None = None
    provenance: Mapping[str, Any] | None = None
    artifact_id: str | None = None
    path: str | None = None

    @classmethod
    def from_wire(cls, value: Mapping[str, Any]) -> ResourceRef:
        return cls(
            artifact_id=_optional_text(value, "artifactId"),
            path=_optional_text(value, "path"),
            uri=required_text(value, "uri"),
            media_type=_optional_text(value, "mediaType"),
            digest=_optional_text(value, "digest"),
            provenance=value.get("provenance")
            if isinstance(value.get("provenance"), Mapping)
            else None,
        )

    def to_wire(self) -> JsonRecord:
        return _without_none(
            {
                "artifactId": self.artifact_id,
                "path": self.path,
                "uri": self.uri,
                "mediaType": self.media_type,
                "digest": self.digest,
                "provenance": wire(self.provenance),
            }
        )


@dataclass(frozen=True)
class SessionStateRef(ResourceRef):
    id: str = ""
    format: str = ""

    @classmethod
    def from_wire(cls, value: Mapping[str, Any]) -> SessionStateRef:
        resource = ResourceRef.from_wire(value)
        return cls(
            uri=resource.uri,
            media_type=resource.media_type,
            digest=resource.digest,
            provenance=resource.provenance,
            id=required_text(value, "id"),
            format=required_text(value, "format"),
        )

    def to_wire(self) -> JsonRecord:
        return {**super().to_wire(), "id": self.id, "format": self.format}


@dataclass(frozen=True)
class StoredHarnessSessionState:
    ref: SessionStateRef
    harness_id: str
    data: Mapping[str, Any]


class SessionStateStore(Protocol):
    async def load(self, ref: SessionStateRef) -> StoredHarnessSessionState | None: ...

    async def save(self, session_state: StoredHarnessSessionState) -> None: ...

    async def delete(self, ref: SessionStateRef) -> None: ...


@dataclass(frozen=True)
class ProviderConfiguration:
    provider: str
    configuration: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class EnvironmentLifetime:
    scope: Literal["attempt", "session", "host"] = "attempt"
    idle_timeout_seconds: int | None = None


@dataclass(frozen=True)
class ExecutionConfiguration:
    provider: str
    lifetime: EnvironmentLifetime = EnvironmentLifetime()
    configuration: Mapping[str, Any] | None = None


@dataclass(frozen=True, kw_only=True)
class RuntimeInput:
    """Common fields for typed, Worker-local runtime inputs."""

    id: str
    required: bool = True
    source_item_key: str | None = None
    kind: str = field(default="", init=False)


@dataclass(frozen=True, kw_only=True)
class InstructionInput(RuntimeInput):
    content: str
    scope: Literal["task", "workspace", "project"] = "task"
    priority: int = 0
    kind: Literal["instruction"] = field(default="instruction", init=False)


@dataclass(frozen=True, kw_only=True)
class SkillInput(RuntimeInput):
    source: ResourceRef
    kind: Literal["skill"] = field(default="skill", init=False)


@dataclass(frozen=True, kw_only=True)
class WorkspaceInput(RuntimeInput):
    source: ResourceRef
    mount_path: str | None = None
    read_only: bool = True
    kind: Literal["workspace"] = field(default="workspace", init=False)


@dataclass(frozen=True, kw_only=True)
class ResourceInput(RuntimeInput):
    source: ResourceRef
    kind: Literal["resource"] = field(default="resource", init=False)


@dataclass(frozen=True, kw_only=True)
class HistoryInput(RuntimeInput):
    content: str
    source: ResourceRef
    trust: Literal["untrusted-history"] = "untrusted-history"
    kind: Literal["history"] = field(default="history", init=False)


@dataclass(frozen=True, kw_only=True)
class SecretInput(RuntimeInput):
    secret_ref: str
    target: str
    kind: Literal["secret"] = field(default="secret", init=False)


@dataclass(frozen=True, kw_only=True)
class SessionStateInput(RuntimeInput):
    session_state: SessionStateRef
    kind: Literal["sessionState"] = field(default="sessionState", init=False)


@dataclass(frozen=True, kw_only=True)
class ExtensionInput(RuntimeInput):
    """Experimental namespaced payload understood by one Harness implementation."""

    harness: str
    schema_version: int
    configuration: Mapping[str, Any]
    kind: Literal["harness-specific"] = field(default="harness-specific", init=False)


@dataclass(frozen=True)
class WorkerProfile:
    ref: WorkerProfileRef
    worker_type: str
    harness: ProviderConfiguration
    execution: ExecutionConfiguration
    instructions: tuple[RuntimeInput, ...] = ()
    limits: Mapping[str, int | float] | None = None
    runtime: ExecutionConfiguration | None = None


def validate_task_execution(value: Mapping[str, Any]) -> Mapping[str, Any]:
    if set(value) - {"requires", "prefers", "profile", "harness", "outputs"}:
        raise ValueError("Unknown Task execution requirement")
    for field_name in ("requires", "prefers"):
        if field_name not in value:
            continue
        items = value[field_name]
        if not isinstance(items, list):
            raise ValueError(f"Task execution {field_name} must be an array")
        for item in items:
            if not isinstance(item, dict) or set(item) != {"id", "version"}:
                raise ValueError("Invalid execution capability")
            required_text(item, "id")
            if type(item["version"]) is not int or item["version"] < 1:
                raise ValueError("Execution capability version must be a positive integer")
    if "profile" in value:
        profile = required_record(value, "profile")
        if set(profile) != {"id", "revision"}:
            raise ValueError("Invalid execution profile")
        required_text(profile, "id")
        required_text(profile, "revision")
    if "harness" in value:
        required_text(value, "harness")
    if "outputs" in value:
        validate_task_output_policy(required_record(value, "outputs"))
    return value


def validate_task_output_policy(value: Mapping[str, Any]) -> None:
    if set(value) - {"directory", "required", "include", "exclude", "git", "maxFiles", "maxBytes"}:
        raise ValueError("Unknown Task output policy field")

    def path(candidate: Any, pattern: bool) -> None:
        if (
            not isinstance(candidate, str)
            or not candidate
            or len(candidate) > 1024
            or candidate.startswith("/")
            or any(ord(char) < 32 or ord(char) == 127 or char in "\\:!{}[]" for char in candidate)
            or any(part in ("", ".", "..") for part in candidate.split("/"))
            or (not pattern and any(char in "*?" for char in candidate))
        ):
            raise ValueError("Output paths must be safe relative POSIX paths")

    path(value.get("directory", "outputs"), False)
    for key in ("required", "include", "exclude"):
        if key not in value:
            continue
        patterns = value[key]
        if not isinstance(patterns, list) or len(patterns) > 100:
            raise ValueError("Output patterns must be bounded arrays")
        for item in patterns:
            path(item, True)
    if value.get("git", "reference") not in ("reference", "capture", "ignore"):
        raise ValueError("Invalid output Git mode")
    for key, maximum in (("maxFiles", 100), ("maxBytes", 67108864)):
        number = value.get(key, maximum)
        if type(number) is not int or not 1 <= number <= maximum:
            raise ValueError("Invalid output collection limit")


@dataclass(frozen=True)
class TaskAttemptSpec:
    """Immutable Control Plane input with an explicit camelCase wire boundary."""

    task_id: str
    attempt_id: str
    tag: Mapping[str, Any]
    input: Mapping[str, Any]
    authorization: Mapping[str, Any]
    context_plan: Mapping[str, Any]
    workspace_plan: Mapping[str, Any]
    worker_profile: WorkerProfileRef
    execution: Mapping[str, Any]
    session: Mapping[str, Any] | None = None
    extensions: Mapping[str, Any] | None = None
    version: Literal[2] = 2

    @classmethod
    def from_wire(cls, value: Mapping[str, Any]) -> TaskAttemptSpec:
        if value.get("version") != 2:
            raise ValueError("Task Attempt version must be 2")
        profile = required_record(value, "workerProfile")
        authorization = required_record(value, "authorization")
        for identity in (
            required_record(value, "tag"),
            required_record(authorization, "tag"),
            optional_record(value, "session"),
        ):
            if identity is not None and "workerProfile" in identity:
                raise ValueError("Worker Profile belongs to the Attempt, not Tag or Session")
        session = optional_record(value, "session")
        if session is not None and "persistence" in session:
            persistence = required_record(session, "persistence")
            required_text(persistence, "controlPlaneUrl")
            required_text(persistence, "token")
            if set(persistence) != {"controlPlaneUrl", "token"}:
                raise ValueError("Unknown Session persistence field")
        return cls(
            version=2,
            execution=validate_task_execution(required_record(value, "execution")),
            task_id=required_text(value, "taskId"),
            attempt_id=required_text(value, "attemptId"),
            tag=required_record(value, "tag"),
            input=required_record(value, "input"),
            authorization=required_record(value, "authorization"),
            context_plan=required_record(value, "contextPlan"),
            workspace_plan=required_record(value, "workspacePlan"),
            worker_profile=WorkerProfileRef(
                required_text(profile, "id"), required_text(profile, "revision")
            ),
            session=optional_record(value, "session"),
            extensions={
                key: item
                for key, item in value.items()
                if key
                not in {
                    "version",
                    "taskId",
                    "attemptId",
                    "tag",
                    "input",
                    "authorization",
                    "contextPlan",
                    "workspacePlan",
                    "workerProfile",
                    "execution",
                    "session",
                }
            }
            or None,
        )

    def to_wire(self) -> JsonRecord:
        return {
            **({} if self.extensions is None else wire(self.extensions)),
            **_without_none(
                {
                    "version": self.version,
                    "taskId": self.task_id,
                    "attemptId": self.attempt_id,
                    "tag": wire(self.tag),
                    "input": wire(self.input),
                    "authorization": wire(self.authorization),
                    "contextPlan": wire(self.context_plan),
                    "workspacePlan": wire(self.workspace_plan),
                    "workerProfile": self.worker_profile.to_wire(),
                    "execution": wire(validate_task_execution(self.execution)),
                    "session": wire(self.session),
                }
            ),
        }


@dataclass(frozen=True)
class EnvironmentPlan:
    files: tuple[Any, ...] = ()
    mounts: tuple[Any, ...] = ()
    environment_variables: Mapping[str, str] | None = None
    secret_bindings: tuple[Any, ...] = ()
    network: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class HarnessPlan:
    runtime: EnvironmentPlan = EnvironmentPlan()
    execution: EnvironmentPlan = EnvironmentPlan()
    metadata: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class HarnessCapabilities:
    id: str
    version: str
    input_kinds: tuple[str, ...]
    streaming: bool
    cancellation: bool
    session_persistence: Literal["none", "native", "filesystem"]
    runtime_placements: tuple[Literal["local", "remote", "managed"], ...] | None = None
    requires_pty: bool | None = None
    required_runtime_capabilities: tuple[Capability, ...] = ()
    split_execution: bool | None = None


@dataclass(frozen=True)
class HarnessContinuity:
    session_id: str
    prior_session_state: SessionStateRef | None = None
    replay_input: RuntimeInput | None = None


@dataclass(frozen=True)
class ResolutionContext:
    task: TaskAttemptSpec
    profile: WorkerProfile


@dataclass(frozen=True)
class ContextInputs:
    instructions: tuple[RuntimeInput, ...]
    skills: tuple[RuntimeInput, ...]
    history: tuple[RuntimeInput, ...]
    resources: tuple[RuntimeInput, ...]


@dataclass(frozen=True)
class ExecutionContext:
    attempt: TaskAttemptSpec
    profile: WorkerProfile
    inputs: tuple[Any, ...]
    session_state_store: SessionStateStore
    continuity: HarnessContinuity | None = None

    def by_kind(self, kind: str) -> tuple[Any, ...]:
        return tuple(item for item in self.inputs if item.kind == kind)

    @property
    def context(self) -> ContextInputs:
        return ContextInputs(
            instructions=self.by_kind("instruction"),
            skills=self.by_kind("skill"),
            history=self.by_kind("history"),
            resources=self.by_kind("resource"),
        )

    @property
    def workspace(self) -> Any | None:
        return next(iter(self.by_kind("workspace")), None)

    @property
    def tools(self) -> tuple[Any, ...]:
        return self.by_kind("tool")

    @property
    def secrets(self) -> tuple[Any, ...]:
        return self.by_kind("secret")

    @property
    def extensions(self) -> tuple[Any, ...]:
        return self.by_kind("harness-specific")


@dataclass(frozen=True)
class ResolvedRuntimeInput:
    id: str
    kind: str
    source_item_key: str | None = None
    resource: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class OmittedRuntimeInput(ResolvedRuntimeInput):
    reason: str = ""


@dataclass(frozen=True)
class RuntimeInputManifest:
    worker_profile: WorkerProfileRef
    harness: Mapping[str, str]
    execution_environment: Mapping[str, str]
    inputs: tuple[ResolvedRuntimeInput, ...]
    omitted: tuple[OmittedRuntimeInput, ...]
    harness_runtime: Mapping[str, str] | None = None


@dataclass(frozen=True)
class RuntimeInputProviderResult:
    inputs: tuple[Any, ...]
    omitted: tuple[OmittedRuntimeInput, ...] = ()


@dataclass(frozen=True)
class Capability:
    id: str
    version: int


@dataclass(frozen=True)
class ContextTypeSupport:
    type: str
    versions: tuple[int, ...]


@dataclass(frozen=True)
class WorkerProfileCapabilities:
    profile: WorkerProfileRef
    capabilities: tuple[Capability, ...]
    context_types: tuple[ContextTypeSupport, ...]
    harness: str | None = None


@dataclass(frozen=True)
class WorkerDescriptor:
    id: str
    type: str
    profiles: tuple[WorkerProfileRef, ...]
    capabilities: tuple[Capability, ...]
    context_types: tuple[ContextTypeSupport, ...]
    profile_capabilities: tuple[WorkerProfileCapabilities, ...]
    max_concurrency: int = 1

    def __post_init__(self) -> None:
        if self.profile_capabilities is None:
            raise ValueError("Worker must declare profile_capabilities")


@dataclass(frozen=True)
class WorkerHostDescriptor:
    id: str
    workers: tuple[WorkerDescriptor, ...]


@dataclass(frozen=True)
class WorkletDescriptor:
    id: str
    host: WorkerHostDescriptor
    protocol_version: int = 1


@runtime_checkable
class Worker(Protocol):
    async def describe(self) -> WorkerDescriptor: ...

    def execute(
        self, attempt: dict[str, Any], cancellation: CancellationToken
    ) -> AsyncIterator[dict[str, Any]]: ...


@runtime_checkable
class Worklet(Protocol):
    """Persistent supervisor running on a Worker Host."""

    async def describe(self) -> WorkletDescriptor: ...

    def execute(
        self, attempt: dict[str, Any], cancellation: CancellationToken
    ) -> AsyncIterator[dict[str, Any]]: ...


class CancellationToken:
    def __init__(self) -> None:
        import asyncio

        self._event = asyncio.Event()
        self._reason = "Task Attempt cancelled"

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    @property
    def reason(self) -> str:
        return self._reason

    def cancel(self, reason: str = "Task Attempt cancelled") -> None:
        self._reason = reason
        self._event.set()

    async def wait(self) -> None:
        await self._event.wait()

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise TaskCancelledError(self.reason)


class TaskCancelledError(Exception):
    pass


class LocalWorklet:
    """In-process Worklet supervising Workers on one Worker Host."""

    def __init__(self, worklet_id: str, worker_host_id: str, workers: tuple[Worker, ...]) -> None:
        if not worklet_id.strip() or not worker_host_id.strip() or not workers:
            raise ValueError("Worklet requires Worklet and Worker Host IDs and at least one Worker")
        self.id = worklet_id
        self.worker_host_id = worker_host_id
        self._workers = workers

    async def describe(self) -> WorkletDescriptor:
        return WorkletDescriptor(
            id=self.id,
            host=WorkerHostDescriptor(
                id=self.worker_host_id,
                workers=tuple([await worker.describe() for worker in self._workers]),
            ),
        )

    async def _select(self, attempt: dict[str, Any]) -> Worker:
        profile = required_record(attempt, "workerProfile")
        profile_id = required_text(profile, "id")
        revision = required_text(profile, "revision")
        for worker in self._workers:
            descriptor = await worker.describe()
            if any(
                candidate.id == profile_id and candidate.revision == revision
                for candidate in descriptor.profiles
            ) and _supports_required_context(descriptor, attempt):
                return worker
        raise ValueError(f"No Worker supports {profile_id}@{revision}")

    async def execute(
        self, attempt: dict[str, Any], cancellation: CancellationToken
    ) -> AsyncIterator[dict[str, Any]]:
        worker = await self._select(attempt)
        async for event in worker.execute(attempt, cancellation):
            yield event

    async def execute_on_worker(
        self, worker_id: str, attempt: dict[str, Any], cancellation: CancellationToken
    ) -> AsyncIterator[dict[str, Any]]:
        for worker in self._workers:
            descriptor = await worker.describe()
            if descriptor.id != worker_id:
                continue
            if not any(
                profile.to_wire() == attempt.get("workerProfile") for profile in descriptor.profiles
            ) or not _supports_required_context(descriptor, attempt):
                raise ValueError("Reserved Worker no longer supports this Attempt")
            async for event in worker.execute(attempt, cancellation):
                yield event
            return
        raise ValueError("Reserved Worker is unavailable")


def task_event(attempt: Mapping[str, Any], event_type: str, **fields: Any) -> dict[str, Any]:
    return {"type": event_type, **event_identity(attempt), **fields}


def default_task_result(summary: str) -> dict[str, Any]:
    return {
        "summary": summary,
        "decisions": [],
        "changes": [],
        "unresolved": [],
        "findings": [],
        "references": [],
        "artifacts": [],
    }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def event_identity(attempt: Mapping[str, Any]) -> dict[str, str]:
    return {
        "taskId": required_text(attempt, "taskId"),
        "attemptId": required_text(attempt, "attemptId"),
        "at": utc_now(),
    }


def wire(value: Any) -> Any:
    """Encode SDK values at the camelCase protocol boundary."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "to_wire"):
        return value.to_wire()
    if isinstance(value, RuntimeInput):
        result = {
            "id": value.id,
            "kind": value.kind,
            "required": value.required,
        }
        if value.source_item_key is not None:
            result["sourceItemKey"] = value.source_item_key
        for descriptor in fields(value):
            key = descriptor.name
            item = getattr(value, key)
            if key not in {"id", "kind", "required", "source_item_key"} and item is not None:
                result[_WIRE_KEYS.get(key, key)] = wire(item)
        return result
    if isinstance(value, RuntimeInputManifest):
        return _without_none(
            {
                "workerProfile": wire(value.worker_profile),
                "harness": wire(value.harness),
                "executionEnvironment": wire(value.execution_environment),
                "inputs": wire(value.inputs),
                "omitted": wire(value.omitted),
                "harnessRuntime": wire(value.harness_runtime),
            }
        )
    if isinstance(value, (ResolvedRuntimeInput, OmittedRuntimeInput)):
        result = {
            "id": value.id,
            "kind": value.kind,
            "sourceItemKey": value.source_item_key,
            "resource": wire(value.resource),
        }
        if isinstance(value, OmittedRuntimeInput):
            result["reason"] = value.reason
        return result
    if isinstance(value, (list, tuple)):
        return [wire(item) for item in value]
    if isinstance(value, Mapping):
        return {key: wire(item) for key, item in value.items()}
    if hasattr(value, "__dataclass_fields__"):
        return {
            _WIRE_KEYS.get(descriptor.name, descriptor.name): wire(getattr(value, descriptor.name))
            for descriptor in fields(value)
        }
    return value


_WIRE_KEYS = {
    "session_state": "sessionState",
    "session_persistence": "sessionPersistence",
    "prior_session_state": "priorSessionState",
    "media_type": "mediaType",
    "mount_path": "mountPath",
    "read_only": "readOnly",
    "secret_ref": "secretRef",
    "schema_version": "schemaVersion",
    "worker_type": "workerType",
    "environment_variables": "environmentVariables",
    "secret_bindings": "secretBindings",
    "idle_timeout_seconds": "idleTimeoutSeconds",
    "input_kinds": "inputKinds",
    "runtime_placements": "runtimePlacements",
    "requires_pty": "requiresPty",
    "split_execution": "splitExecution",
    "harness_runtime": "harnessRuntime",
    "max_concurrency": "maxConcurrency",
    "protocol_version": "protocolVersion",
    "context_types": "contextTypes",
    "profile_capabilities": "profileCapabilities",
}


def _capabilities_for_attempt(
    descriptor: WorkerDescriptor, attempt: Mapping[str, Any]
) -> tuple[Capability, ...]:
    return next(
        (
            entry.capabilities
            for entry in descriptor.profile_capabilities
            if entry.profile.to_wire() == attempt.get("workerProfile")
        ),
        (),
    )


def _supports_required_context(descriptor: WorkerDescriptor, attempt: Mapping[str, Any]) -> bool:
    execution = validate_task_execution(required_record(attempt, "execution"))
    selected = attempt.get("workerProfile")
    if execution.get("profile") is not None and execution["profile"] != selected:
        return False
    entry = next(
        (entry for entry in descriptor.profile_capabilities if entry.profile.to_wire() == selected),
        None,
    )
    if entry is None:
        return False
    context_types = entry.context_types
    harness = entry.harness
    if execution.get("harness") is not None and execution["harness"] != harness:
        return False
    capabilities = {
        (item.id, item.version) for item in _capabilities_for_attempt(descriptor, attempt)
    }
    if "outputs" in execution and ("supertag.artifacts.output-policy", 1) not in capabilities:
        return False
    if any(
        (item["id"], item["version"]) not in capabilities for item in execution.get("requires", [])
    ):
        return False
    context_plan = required_record(attempt, "contextPlan")
    sets = context_plan.get("sets")
    if not isinstance(sets, list):
        raise ValueError("contextPlan.sets must be an array")
    supported = {(item.type, version) for item in context_types for version in item.versions}
    for context_set in sets:
        if not isinstance(context_set, Mapping) or not isinstance(context_set.get("items"), list):
            raise ValueError("Each Context Set must contain an items array")
        for item in context_set["items"]:
            if not isinstance(item, Mapping):
                raise ValueError("Context Items must be objects")
            contract = (item.get("type"), item.get("version"))
            if item.get("required") is True and contract not in supported:
                return False
    return True


def required_record(value: Mapping[str, Any], key: str) -> dict[str, Any]:
    candidate = value.get(key)
    if not isinstance(candidate, dict):
        raise ValueError(f"{key} must be an object")
    return candidate


def optional_record(value: Mapping[str, Any], key: str) -> dict[str, Any] | None:
    candidate = value.get(key)
    if candidate is None:
        return None
    if not isinstance(candidate, dict):
        raise ValueError(f"{key} must be an object")
    return candidate


def required_text(value: Mapping[str, Any], key: str) -> str:
    candidate = value.get(key)
    if not isinstance(candidate, str) or not candidate.strip():
        raise ValueError(f"{key} must be a non-empty string")
    return candidate


def _optional_text(value: Mapping[str, Any], key: str) -> str | None:
    candidate = value.get(key)
    return candidate if isinstance(candidate, str) else None


def _without_none(value: Mapping[str, Any]) -> JsonRecord:
    return {key: item for key, item in value.items() if item is not None}
