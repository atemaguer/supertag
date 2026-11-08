from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any, AsyncIterator, Literal, Mapping, Protocol, Sequence

from .continuity import InMemorySessionStateStore
from .environment import (
    ExecutionCleanupError,
    ExecutionEnvironment,
    ExecutionEnvironmentProvider,
    HarnessRuntime,
    HarnessRuntimeProvider,
)
from .harness import Harness, HarnessEnvironmentAccesses, HarnessExecution
from .models import (
    CANCELLATION_CAPABILITY,
    EVENT_STREAM_CAPABILITY,
    CancellationToken,
    Capability,
    ContextTypeSupport,
    EnvironmentPlan,
    ExecutionContext,
    ExtensionInput,
    HarnessCapabilities,
    HarnessContinuity,
    HistoryInput,
    InstructionInput,
    OmittedRuntimeInput,
    ResolutionContext,
    ResolvedRuntimeInput,
    ResourceInput,
    ResourceRef,
    RuntimeInput,
    RuntimeInputManifest,
    RuntimeInputProviderResult,
    SecretInput,
    SessionStateInput,
    SessionStateRef,
    SessionStateStore,
    SkillInput,
    TaskAttemptSpec,
    TaskProgress,
    Worker,
    WorkerDescriptor,
    WorkerProfile,
    WorkerProfileCapabilities,
    WorkspaceInput,
    _supports_required_context,
    default_task_result,
    task_event,
    wire,
)
from .tools import ToolInput, tool_input_from_execution


class RuntimeInputProvider(Protocol):
    """Primitive extension point for every Task-scoped execution input."""

    id: str
    scope: Literal["context", "workspace", "authorization", "custom"]

    async def resolve(
        self, context: ResolutionContext
    ) -> Sequence[Any] | RuntimeInputProviderResult: ...


class RuntimeInputPipeline:
    def __init__(self, providers: Sequence[RuntimeInputProvider] = ()) -> None:
        self.providers = tuple(providers)
        identifiers = [provider.id for provider in self.providers]
        if any(not identifier.strip() for identifier in identifiers):
            raise ValueError("Runtime Input Provider ids must be non-empty")
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("Runtime Input Provider ids must be unique")
        allowed_scopes = {"context", "workspace", "authorization", "custom"}
        if any(provider.scope not in allowed_scopes for provider in self.providers):
            raise ValueError("Runtime Input Provider scope is not recognized")

    def has_scope(self, scope: str) -> bool:
        return any(provider.scope == scope for provider in self.providers)

    async def resolve(self, context: ResolutionContext) -> RuntimeInputProviderResult:
        inputs: list[Any] = []
        omitted: list[OmittedRuntimeInput] = []
        for provider in self.providers:
            result = await provider.resolve(context)
            if isinstance(result, RuntimeInputProviderResult):
                inputs.extend(result.inputs)
                omitted.extend(result.omitted)
            else:
                inputs.extend(result)
        return RuntimeInputProviderResult(tuple(inputs), tuple(omitted))


class SessionStatePromotionHook(Protocol):
    """Called only for a session_state produced after a successful harness run."""

    async def promote(self, task: TaskAttemptSpec, session_state: SessionStateRef) -> None: ...


@dataclass(frozen=True)
class WorkerOptions:
    """Components used by ``create_worker`` to build an ordinary Worker."""

    id: str
    profiles: tuple[WorkerProfile, ...]
    harnesses: tuple[Harness, ...]
    environments: tuple[ExecutionEnvironmentProvider, ...]
    harness_runtimes: tuple[HarnessRuntimeProvider, ...] = ()
    runtime_input_providers: tuple[RuntimeInputProvider, ...] = ()
    session_state_store: SessionStateStore | None = None
    session_state_promotion_hooks: tuple[SessionStatePromotionHook, ...] = ()
    max_concurrency: int = 1


class _ConfiguredWorker:
    """SDK implementation behind the public Worker factory."""

    def __init__(self, options: WorkerOptions) -> None:
        if not options.id.strip():
            raise ValueError("Worker requires a non-empty ID")
        self.id = options.id
        self._options = options
        self._cleanup_failure: ExecutionCleanupError | None = None
        self._session_state_store = options.session_state_store or InMemorySessionStateStore()
        self._inputs = RuntimeInputPipeline(options.runtime_input_providers)

    async def describe(self) -> WorkerDescriptor:
        harness_capabilities = [await harness.describe() for harness in self._options.harnesses]
        capabilities = [Capability(EVENT_STREAM_CAPABILITY, 1)]
        if harness_capabilities and all(item.cancellation for item in harness_capabilities):
            capabilities.append(Capability(CANCELLATION_CAPABILITY, 1))
        for provider in self._options.environments:
            capabilities.extend(provider.capabilities)
        context_types = _unique_context_types(
            tuple(
                support
                for provider in self._options.runtime_input_providers
                for support in getattr(provider, "context_types", ())
            )
        )
        profile_capabilities = []
        for profile in self._options.profiles:
            harness = self._harness(profile.harness.provider)
            effective = await harness.describe()
            execution_provider = self._environment(profile.execution.provider)
            if profile.runtime is not None:
                self._harness_runtime(profile.runtime.provider)
            if profile.runtime is not None and not effective.split_execution:
                raise ValueError(
                    f"Harness {harness.id} does not support split runtime and "
                    "execution environments"
                )
            supported = [
                Capability(EVENT_STREAM_CAPABILITY, 1),
                *execution_provider.capabilities,
            ]
            if effective.cancellation:
                supported.append(Capability(CANCELLATION_CAPABILITY, 1))
            profile_capabilities.append(
                WorkerProfileCapabilities(
                    profile=profile.ref,
                    harness=harness.id,
                    capabilities=_unique_capabilities(supported),
                    context_types=context_types,
                )
            )
        return WorkerDescriptor(
            id=self.id,
            type="supertag",
            profiles=tuple(profile.ref for profile in self._options.profiles),
            capabilities=_unique_capabilities(capabilities),
            context_types=context_types,
            max_concurrency=self._options.max_concurrency,
            profile_capabilities=tuple(profile_capabilities),
        )

    async def execute(
        self, attempt: dict[str, Any], cancellation: CancellationToken
    ) -> AsyncIterator[dict[str, Any]]:
        if self._cleanup_failure is not None:
            raise self._cleanup_failure
        spec = TaskAttemptSpec.from_wire(attempt)
        if not _supports_required_context(await self.describe(), attempt):
            raise ValueError("Worker does not satisfy Task execution requirements")
        yield task_event(attempt, "execution.started", workerId=self.id)
        runtime_environment: HarnessRuntime | None = None
        execution_environment: ExecutionEnvironment | None = None
        execution: HarnessExecution | None = None
        sensitive_values = _session_sensitive_values(spec)
        reason = "failed"
        try:
            cancellation.raise_if_cancelled()
            profile = self._profile(spec)
            harness = self._harness(profile.harness.provider)
            execution_provider = self._environment(profile.execution.provider)
            runtime_provider = (
                execution_provider
                if profile.runtime is None
                else self._harness_runtime(profile.runtime.provider)
            )
            capabilities = await harness.describe()
            if profile.runtime is not None and not capabilities.split_execution:
                raise ValueError(
                    f"Harness {harness.id} does not support split runtime and "
                    "execution environments"
                )
            available = {(cap.id, cap.version) for cap in runtime_provider.capabilities}
            if any(
                (cap.id, cap.version) not in available
                for cap in capabilities.required_runtime_capabilities
            ):
                raise ValueError("Environment does not satisfy Harness required capabilities")
            inputs = list(profile.instructions)
            inputs.extend(_role_instruction_inputs(spec))
            replay_input = _session_replay(spec)
            if replay_input is not None:
                inputs.append(replay_input)
            provider_resolution = await self._inputs.resolve(ResolutionContext(spec, profile))
            context_fallback = (
                RuntimeInputProviderResult(())
                if self._inputs.has_scope("context")
                else _resolve_without_context_provider(spec)
            )
            resolution = RuntimeInputProviderResult(
                (*provider_resolution.inputs, *context_fallback.inputs),
                (*provider_resolution.omitted, *context_fallback.omitted),
            )
            inputs.extend(_runtime_input(item) for item in resolution.inputs)
            accepted, unsupported = _select_inputs(tuple(inputs), capabilities)
            sensitive_values = (*sensitive_values, *_runtime_input_sensitive_values(accepted))
            omitted = (*resolution.omitted, *unsupported)
            context = ExecutionContext(
                attempt=spec,
                profile=profile,
                inputs=accepted,
                session_state_store=self._session_state_store,
                continuity=_continuity(spec, replay_input),
            )
            plan = await harness.plan(context)
            cancellation.raise_if_cancelled()
            if profile.runtime is None:
                combined_plan = _merge_environment_plans(plan.runtime, plan.execution)
                runtime_environment = await execution_provider.provision(
                    spec, profile, combined_plan, cancellation
                )
                execution_environment = runtime_environment
                await runtime_environment.prepare(combined_plan)
            else:
                runtime_environment = await runtime_provider.provision_runtime(
                    spec, profile, plan.runtime, cancellation
                )
                await runtime_environment.prepare(plan.runtime)
                cancellation.raise_if_cancelled()
                execution_environment = await execution_provider.provision(
                    spec, profile, plan.execution, cancellation
                )
                await execution_environment.prepare(plan.execution)
            if (
                capabilities.runtime_placements is not None
                and runtime_environment.placement not in capabilities.runtime_placements
            ):
                raise ValueError(
                    f"Harness {harness.id} cannot run in a {runtime_environment.placement} "
                    "Harness runtime"
                )
            execution = await harness.start(
                plan,
                HarnessEnvironmentAccesses(
                    runtime=runtime_environment,
                    execution=execution_environment,
                ),
                context,
            )
            manifest = RuntimeInputManifest(
                worker_profile=profile.ref,
                harness={"id": harness.id, "version": capabilities.version},
                execution_environment={
                    "id": execution_environment.id,
                    "provider": execution_provider.id,
                    "placement": execution_environment.placement,
                },
                inputs=tuple(_manifest(item) for item in accepted),
                omitted=omitted,
                harness_runtime=(
                    {
                        "id": runtime_environment.id,
                        "provider": runtime_provider.id,
                        "placement": runtime_environment.placement,
                    }
                    if profile.runtime is not None
                    else None
                ),
            )
            yield task_event(attempt, "runtime-inputs.resolved", manifest=wire(manifest))

            final_output: str | None = None
            result_seen = False
            async for event in _supervised_events(execution, cancellation):
                cancellation.raise_if_cancelled()
                safe_event = _redact_json_value(event, sensitive_values)
                if not isinstance(safe_event, Mapping):
                    raise ValueError("Harness event must be an object")
                event_type = safe_event.get("type")
                if event_type == "output.message":
                    final_output = str(safe_event.get("text", ""))
                elif event_type == "result":
                    result_seen = True
                yield _normalize_harness_event(attempt, safe_event)
            if not result_seen and final_output is not None:
                yield task_event(attempt, "result", result=default_task_result(final_output))

            session_state = await execution.session_state()
            if session_state is not None:
                for hook in self._options.session_state_promotion_hooks:
                    await hook.promote(spec, session_state)
                yield task_event(attempt, "session.updated", sessionState=wire(session_state))
            cancellation.raise_if_cancelled()
            reason = "completed"
            await execution.close()
            execution = None
            await execution_environment.dispose(reason)
            if runtime_environment is execution_environment:
                runtime_environment = None
            execution_environment = None
            if runtime_environment is not None:
                await runtime_environment.dispose(reason)
                runtime_environment = None
            yield task_event(attempt, "execution.completed")
        except Exception as error:
            reason = "cancelled" if cancellation.cancelled else "failed"
            cleanup_errors: list[str] = []
            if execution is not None:
                try:
                    await asyncio.wait_for(execution.close(), 5)
                except Exception as cleanup_error:
                    cleanup_errors.append(str(cleanup_error))
                execution = None
            if execution_environment is not None:
                try:
                    await asyncio.wait_for(execution_environment.dispose(reason), 5)
                except Exception as cleanup_error:
                    cleanup_errors.append(str(cleanup_error))
                if runtime_environment is execution_environment:
                    runtime_environment = None
                execution_environment = None
            if runtime_environment is not None:
                try:
                    await asyncio.wait_for(runtime_environment.dispose(reason), 5)
                except Exception as cleanup_error:
                    cleanup_errors.append(str(cleanup_error))
                runtime_environment = None
            if cleanup_errors or isinstance(error, ExecutionCleanupError):
                self._cleanup_failure = ExecutionCleanupError(
                    "; ".join(cleanup_errors) or str(error)
                )
                raise self._cleanup_failure from error
            yield task_event(
                attempt,
                "execution.failed",
                error={
                    "name": type(error).__name__,
                    "message": _redact_text(str(error), sensitive_values),
                    **(
                        {
                            "cleanupIncomplete": True,
                            "cleanupErrors": [
                                _redact_text(item, sensitive_values) for item in cleanup_errors
                            ],
                        }
                        if cleanup_errors
                        else {}
                    ),
                },
            )
        finally:
            if execution is not None:
                try:
                    await execution.close()
                except Exception:
                    pass
            if execution_environment is not None:
                try:
                    await execution_environment.dispose(reason)
                except Exception:
                    pass
                if runtime_environment is execution_environment:
                    runtime_environment = None
            if runtime_environment is not None:
                try:
                    await runtime_environment.dispose(reason)
                except Exception:
                    pass

    def _profile(self, spec: TaskAttemptSpec) -> WorkerProfile:
        for profile in self._options.profiles:
            if profile.ref == spec.worker_profile:
                return profile
        raise ValueError(
            "Worker Profile "
            f"{spec.worker_profile.id}@{spec.worker_profile.revision} is not available"
        )

    def _harness(self, provider: str) -> Harness:
        for harness in self._options.harnesses:
            if harness.id == provider:
                return harness
        raise ValueError(f"Harness {provider} is not installed")

    def _environment(self, provider: str) -> ExecutionEnvironmentProvider:
        for environment in self._options.environments:
            if environment.id == provider:
                return environment
        raise ValueError(f"Execution Environment Provider {provider} is not installed")

    def _harness_runtime(self, provider: str) -> HarnessRuntimeProvider:
        for runtime in self._options.harness_runtimes:
            if runtime.id == provider:
                return runtime
        raise ValueError(f"Harness Runtime Provider {provider} is not installed")


def create_worker(options: WorkerOptions) -> Worker:
    """Create a Worker from Harnesses, environments, and Task input providers."""

    return _ConfiguredWorker(options)


def _role_instruction_inputs(spec: TaskAttemptSpec) -> tuple[InstructionInput, ...]:
    roles = spec.authorization.get("roles", [])
    if not isinstance(roles, list):
        raise ValueError("authorization.roles must be an array")
    seen: set[str] = set()
    inputs: list[InstructionInput] = []
    for assignment in roles:
        if not isinstance(assignment, Mapping):
            raise ValueError("Role assignment snapshot must be an object")
        role = assignment.get("role")
        if not isinstance(role, Mapping):
            raise ValueError("Role snapshot must be an object")
        role_id = role.get("id")
        revision = role.get("revision")
        name = role.get("name")
        purpose = role.get("purpose")
        instructions = role.get("instructions")
        if (
            not isinstance(role_id, str)
            or not role_id
            or type(revision) is not int
            or revision < 1
            or not isinstance(name, str)
            or not name
            or not isinstance(purpose, str)
            or not purpose
            or not isinstance(instructions, str)
        ):
            raise ValueError("Role snapshot is invalid")
        key = f"{role_id}@{revision}"
        if key in seen:
            continue
        seen.add(key)
        details = [f"You are acting in the {name} Role.", f"Purpose: {purpose}"]
        if instructions.strip():
            details.append(instructions.strip())
        inputs.append(
            InstructionInput(
                id=f"role:{role_id}:{revision}",
                content="\n".join(details),
                scope="task",
                priority=50,
                required=True,
            )
        )
    return tuple(inputs)


def _continuity(spec: TaskAttemptSpec, replay: RuntimeInput | None) -> HarnessContinuity | None:
    if spec.session is None:
        return None
    session_state_value = spec.session.get("sessionState")
    session_state = (
        _session_state_ref(session_state_value)
        if isinstance(session_state_value, Mapping)
        else None
    )
    return HarnessContinuity(
        session_id=str(spec.session["id"]),
        prior_session_state=session_state,
        replay_input=replay,
    )


def _session_replay(spec: TaskAttemptSpec) -> RuntimeInput | None:
    if spec.session is None:
        return None
    history = spec.session.get("history")
    if not isinstance(history, list) or not history:
        return None
    session_id = str(spec.session["id"])
    records = tuple(history)
    return HistoryInput(
        id=f"session-continuity:{session_id}",
        required=False,
        content=json.dumps(records, separators=(",", ":")),
        source=ResourceRef(
            uri=f"supertag://sessions/{session_id}/continuity",
            media_type="application/vnd.supertag.task-history+json;version=1",
            provenance={"sessionId": session_id, "automatic": True},
        ),
    )


def _session_state_ref(value: Mapping[str, Any]) -> SessionStateRef:
    return SessionStateRef(
        uri=str(value["uri"]),
        media_type=value.get("mediaType") if isinstance(value.get("mediaType"), str) else None,
        digest=value.get("digest") if isinstance(value.get("digest"), str) else None,
        provenance=value.get("provenance")
        if isinstance(value.get("provenance"), Mapping)
        else None,
        id=str(value["id"]),
        format=str(value["format"]),
    )


def _select_inputs(
    inputs: tuple[Any, ...], capabilities: HarnessCapabilities
) -> tuple[tuple[Any, ...], tuple[OmittedRuntimeInput, ...]]:
    accepted: list[Any] = []
    omitted: list[OmittedRuntimeInput] = []
    for runtime_input in inputs:
        if runtime_input.kind in capabilities.input_kinds:
            accepted.append(runtime_input)
        elif runtime_input.required:
            raise ValueError(
                f"Harness {capabilities.id} does not support required {runtime_input.kind} "
                f"input {runtime_input.id}"
            )
        else:
            manifest = _manifest(runtime_input)
            omitted.append(
                OmittedRuntimeInput(
                    id=manifest.id,
                    kind=manifest.kind,
                    source_item_key=manifest.source_item_key,
                    resource=manifest.resource,
                    reason="unsupported-by-harness",
                )
            )
    return tuple(accepted), tuple(omitted)


def _manifest(runtime_input: Any) -> ResolvedRuntimeInput:
    source = getattr(runtime_input, "source", None)
    resource = None
    if isinstance(source, ResourceRef):
        resource = {
            key: value
            for key, value in {
                "mediaType": source.media_type,
                "digest": source.digest,
                "provenance": source.provenance,
            }.items()
            if value is not None
        }
    return ResolvedRuntimeInput(
        id=runtime_input.id,
        kind=runtime_input.kind,
        source_item_key=getattr(runtime_input, "source_item_key", None),
        resource=resource or None,
    )


def _runtime_input(value: Any) -> Any:
    if isinstance(value, (RuntimeInput, ToolInput)):
        return value
    if not isinstance(value, Mapping):
        raise ValueError("Runtime Input Providers must return Runtime Inputs")
    identifier = value.get("id")
    kind = value.get("kind")
    if not isinstance(identifier, str) or not identifier.strip():
        raise ValueError("Runtime Input requires a non-empty id")
    if not isinstance(kind, str) or not kind.strip():
        raise ValueError("Runtime Input requires a non-empty kind")
    common = {
        "id": identifier,
        "required": bool(value.get("required", True)),
        "source_item_key": value.get("sourceItemKey")
        if isinstance(value.get("sourceItemKey"), str)
        else None,
    }
    if kind == "tool":
        return tool_input_from_execution(value)
    if kind == "instruction":
        return InstructionInput(
            **common,
            content=str(value.get("content", "")),
            scope=value.get("scope", "task"),
            priority=int(value.get("priority", 0)),
        )
    source = _resource_ref(value.get("source"))
    if kind == "skill":
        return SkillInput(**common, source=source)
    if kind == "workspace":
        return WorkspaceInput(
            **common,
            source=source,
            mount_path=value.get("mountPath") if isinstance(value.get("mountPath"), str) else None,
            read_only=bool(value.get("readOnly", True)),
        )
    if kind == "resource":
        return ResourceInput(**common, source=source)
    if kind == "history":
        return HistoryInput(
            **common,
            content=str(value.get("content", "")),
            source=source,
        )
    if kind == "secret":
        return SecretInput(
            **common,
            secret_ref=str(value.get("secretRef", "")),
            target=str(value.get("target", "")),
        )
    if kind == "sessionState":
        session_state = value.get("sessionState")
        if not isinstance(session_state, Mapping):
            raise ValueError("SessionState input requires a session_state object")
        return SessionStateInput(**common, session_state=SessionStateRef.from_wire(session_state))
    if kind == "harness-specific":
        configuration = value.get("configuration")
        if not isinstance(configuration, Mapping):
            raise ValueError("Harness-specific input requires configuration")
        return ExtensionInput(
            **common,
            harness=str(value.get("harness", "")),
            schema_version=int(value.get("schemaVersion", 0)),
            configuration=configuration,
        )
    raise ValueError(f"Unsupported runtime input kind {kind!r}")


def _normalize_harness_event(attempt: dict[str, Any], event: Mapping[str, Any]) -> dict[str, Any]:
    event_type = event.get("type")
    if not isinstance(event_type, str):
        raise ValueError("Harness event requires a type")
    fields = {key: value for key, value in event.items() if key != "type"}
    if event_type == "output.message":
        fields = {"message": {"role": "teammate", "text": str(event.get("text", ""))}}
    elif event_type == "progress.updated":
        progress = event.get("progress")
        if not isinstance(progress, Mapping):
            raise ValueError("progress.updated requires a progress object")
        fields = {"progress": TaskProgress.from_wire(progress).to_wire()}
    return task_event(attempt, event_type, **fields)


_SENSITIVE_HEADER_NAME = re.compile(
    r"^(authorization|proxy-authorization|cookie|set-cookie)$", re.IGNORECASE
)
_SENSITIVE_ENVIRONMENT_NAME = re.compile(
    r"(token|secret|password|api[_-]?key|private[_-]?key|app[_-]?id)", re.IGNORECASE
)
_BEARER_VALUE = re.compile(r"^Bearer\s+(.+)$", re.IGNORECASE)
_REDACTED_VALUE = "[REDACTED]"


def _session_sensitive_values(spec: TaskAttemptSpec) -> tuple[str, ...]:
    persistence = spec.session.get("persistence") if spec.session is not None else None
    token = persistence.get("token") if isinstance(persistence, Mapping) else None
    return (token,) if isinstance(token, str) and token else ()


def _runtime_input_sensitive_values(inputs: tuple[Any, ...]) -> tuple[str, ...]:
    values: list[str] = []
    for runtime_input in inputs:
        if not isinstance(runtime_input, ToolInput):
            continue
        binding = runtime_input.binding
        values.extend(
            value
            for key, value in binding.runtime_headers.items()
            if isinstance(key, str)
            and isinstance(value, str)
            and _SENSITIVE_HEADER_NAME.search(key)
        )
        values.extend(
            value
            for key, value in binding.runtime_environment.items()
            if isinstance(key, str)
            and isinstance(value, str)
            and _SENSITIVE_ENVIRONMENT_NAME.search(key)
        )
    bearer_values = [
        match.group(1) for value in values if (match := _BEARER_VALUE.match(value)) is not None
    ]
    return tuple(
        sorted(
            {value for value in (*values, *bearer_values) if len(value) >= 6},
            key=len,
            reverse=True,
        )
    )


def _redact_text(value: str, sensitive_values: tuple[str, ...]) -> str:
    for sensitive in sensitive_values:
        value = value.replace(sensitive, _REDACTED_VALUE)
    return value


def _redact_json_value(value: Any, sensitive_values: tuple[str, ...]) -> Any:
    if isinstance(value, str):
        return _redact_text(value, sensitive_values)
    if isinstance(value, Mapping):
        return {key: _redact_json_value(item, sensitive_values) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_json_value(item, sensitive_values) for item in value]
    if isinstance(value, tuple):
        return tuple(_redact_json_value(item, sensitive_values) for item in value)
    return value


def _resolve_without_context_provider(spec: TaskAttemptSpec) -> RuntimeInputProviderResult:
    sets = spec.context_plan.get("sets", [])
    if not isinstance(sets, list):
        raise ValueError("contextPlan.sets must be an array")
    items: list[Mapping[str, Any]] = []
    for context_set in sets:
        if not isinstance(context_set, Mapping) or not isinstance(context_set.get("items"), list):
            raise ValueError("Each Context Set must contain an items array")
        items.extend(item for item in context_set["items"] if isinstance(item, Mapping))
    required = next((item for item in items if item.get("required") is True), None)
    if required is not None:
        raise ValueError(
            "No Context Resolver is installed for "
            f"{required.get('type')}@{required.get('version')}:{required.get('itemKey')}"
        )
    return RuntimeInputProviderResult(
        (),
        tuple(
            OmittedRuntimeInput(
                id=str(item.get("id", "")),
                kind=str(item.get("type", "")),
                source_item_key=str(item.get("itemKey", "")),
                reason=(
                    f"No Context Resolver is installed for {item.get('type')}@{item.get('version')}"
                ),
            )
            for item in items
        ),
    )


def _merge_environment_plans(
    runtime: EnvironmentPlan, execution: EnvironmentPlan
) -> EnvironmentPlan:
    """Merge plans only for the colocated compatibility path."""

    files = (*execution.files, *runtime.files)
    mounts = (*execution.mounts, *runtime.mounts)
    secrets = (*runtime.secret_bindings, *execution.secret_bindings)
    _reject_duplicate_targets(files, "path", "file")
    _reject_duplicate_targets(mounts, "destination", "mount")
    _reject_duplicate_targets(secrets, "target", "secret binding")

    environment_variables = dict(runtime.environment_variables or {})
    for key, value in (execution.environment_variables or {}).items():
        current = environment_variables.get(key)
        if current is not None and current != value:
            raise ValueError(f"Colocated environment variable {key!r} has conflicting values")
        environment_variables[key] = value
    return EnvironmentPlan(
        files=files,
        mounts=mounts,
        environment_variables=environment_variables or None,
        secret_bindings=secrets,
        network=_merge_network_policies(runtime.network, execution.network),
    )


def _reject_duplicate_targets(values: tuple[Any, ...], field_name: str, label: str) -> None:
    seen: set[str] = set()
    for value in values:
        target = (
            value.get(field_name)
            if isinstance(value, Mapping)
            else getattr(value, field_name, None)
        )
        if isinstance(target, str) and target in seen:
            raise ValueError(f"Colocated {label} target {target!r} is declared more than once")
        if isinstance(target, str):
            seen.add(target)


def _merge_network_policies(
    runtime: Mapping[str, Any] | None,
    execution: Mapping[str, Any] | None,
) -> Mapping[str, Any] | None:
    if execution is None:
        return runtime
    if runtime is None:
        return execution
    modes = {str(execution.get("mode", "none")), str(runtime.get("mode", "none"))}
    if "unrestricted" in modes:
        return {"mode": "unrestricted"}
    allowed_hosts = tuple(
        dict.fromkeys(
            (
                *(execution.get("allowedHosts") or execution.get("allowed_hosts") or ()),
                *(runtime.get("allowedHosts") or runtime.get("allowed_hosts") or ()),
            )
        )
    )
    if "allowlist" in modes or allowed_hosts:
        return {"mode": "allowlist", "allowed_hosts": allowed_hosts}
    return {"mode": "none"}


def _unique_capabilities(values: list[Capability]) -> tuple[Capability, ...]:
    unique: dict[tuple[str, int], Capability] = {}
    for value in values:
        unique[(value.id, value.version)] = value
    return tuple(unique.values())


def _unique_context_types(
    values: tuple[ContextTypeSupport, ...],
) -> tuple[ContextTypeSupport, ...]:
    contracts: dict[str, set[int]] = {}
    for support in values:
        contracts.setdefault(support.type, set()).update(support.versions)
    return tuple(
        ContextTypeSupport(type=type_name, versions=tuple(sorted(versions)))
        for type_name, versions in sorted(contracts.items())
    )


__all__ = [
    "SessionStatePromotionHook",
    "SessionStateStore",
    "RuntimeInputProvider",
    "ExecutionEnvironment",
    "ExecutionEnvironmentProvider",
    "HarnessRuntime",
    "HarnessRuntimeProvider",
    "Harness",
    "HarnessExecution",
    "InMemorySessionStateStore",
    "WorkerOptions",
    "create_worker",
]


def _resource_ref(value: Any) -> ResourceRef:
    if not isinstance(value, Mapping):
        raise ValueError("Runtime input requires a source object")
    return ResourceRef.from_wire(value)


async def _supervised_events(
    execution: HarnessExecution, cancellation: CancellationToken
) -> AsyncIterator[Mapping[str, object]]:
    """Interrupt in-flight async iteration; this is an SDK-local lifecycle operation."""
    iterator = execution.run(cancellation).__aiter__()
    cancelled = asyncio.create_task(cancellation.wait())
    pending = None
    try:
        while True:
            cancellation.raise_if_cancelled()
            pending = asyncio.create_task(iterator.__anext__())
            done, _ = await asyncio.wait((pending, cancelled), return_when=asyncio.FIRST_COMPLETED)
            if cancelled in done:
                # Give adapters a bounded chance to invoke their native cancellation API.
                await asyncio.wait((pending,), timeout=0.05)
                pending.cancel()
                stopped, _ = await asyncio.wait((pending,), timeout=1)
                if not stopped:
                    raise ExecutionCleanupError(
                        "Harness ignored cancellation; execution unresolved"
                    )
                cancellation.raise_if_cancelled()
            try:
                yield pending.result()
            except StopAsyncIteration:
                return
    finally:
        cancelled.cancel()
        if pending is not None and not pending.done():
            pending.cancel()
        await asyncio.gather(cancelled, return_exceptions=True)
        if pending is not None:
            stopped, _ = await asyncio.wait((pending,), timeout=1)
            if not stopped:
                pending.add_done_callback(
                    lambda task: task.exception() if not task.cancelled() else None
                )
                raise ExecutionCleanupError("Harness iteration did not stop; execution unresolved")
            await asyncio.gather(pending, return_exceptions=True)
        close = getattr(iterator, "aclose", None)
        if close is not None:
            await asyncio.wait_for(close(), 5)
