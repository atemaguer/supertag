from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import re
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Mapping, Protocol, Sequence, TypeVar, runtime_checkable
from urllib.parse import urlsplit, urlunsplit

from .models import ResolutionContext

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class ToolAuthorizationResource:
    surface_account_id: str
    scope: str
    reference: str | None = None


@dataclass(frozen=True)
class ToolAuthorization:
    provider: str
    resources: tuple[ToolAuthorizationResource, ...]


@dataclass(frozen=True)
class ToolOperation:
    name: str
    effect: str
    actions: tuple[str, ...]
    input_schema: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class ToolCapability:
    id: str
    provider: str
    operations: tuple[ToolOperation, ...]
    authorization: ToolAuthorization


@dataclass(frozen=True)
class McpHttpToolBinding:
    name: str
    url: str
    kind: str = field(default="mcp-http", init=False)
    secret_refs: tuple[str, ...] = ()
    runtime_environment: Mapping[str, str] = field(default_factory=dict)
    runtime_headers: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class McpStdioToolBinding:
    name: str
    command: str
    args: tuple[str, ...] = ()
    kind: str = field(default="mcp-stdio", init=False)
    secret_refs: tuple[str, ...] = ()
    runtime_environment: Mapping[str, str] = field(default_factory=dict)
    runtime_headers: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class NativeToolBinding:
    name: str
    adapter: str
    configuration: Mapping[str, Any] = field(default_factory=dict)
    kind: str = field(default="native", init=False)
    secret_refs: tuple[str, ...] = ()
    runtime_environment: Mapping[str, str] = field(default_factory=dict)
    runtime_headers: Mapping[str, str] = field(default_factory=dict)


ToolRuntimeBinding = McpHttpToolBinding | McpStdioToolBinding | NativeToolBinding


@dataclass(frozen=True)
class ToolInput:
    id: str
    capability: ToolCapability
    binding: ToolRuntimeBinding
    required: bool = True
    source_item_key: str | None = None
    kind: str = field(default="tool", init=False)

    def to_wire(self) -> JsonObject:
        return tool_input_to_execution(self)


def validate_tool_input(tool_input: ToolInput) -> None:
    """Validate the non-secret capability and authorization envelope."""
    if not tool_input.id.strip():
        raise ValueError("Tool tool_input must have an ID")
    capability = tool_input.capability
    if not capability.id.strip() or not capability.provider.strip():
        raise ValueError(f"Tool tool_input {tool_input.id} must identify its capability")
    if capability.authorization.provider != capability.provider:
        raise ValueError(
            f"Tool tool_input {tool_input.id} authorization belongs to "
            f"{capability.authorization.provider}, not {capability.provider}"
        )
    if not capability.authorization.resources:
        raise ValueError(f"Tool tool_input {tool_input.id} must declare authorized resources")
    if not capability.operations:
        raise ValueError(f"Tool tool_input {tool_input.id} must declare operations")
    names = [operation.name for operation in capability.operations]
    if len(names) != len(set(names)):
        raise ValueError(f"Tool tool_input {tool_input.id} operation names must be unique")
    for operation in capability.operations:
        if not operation.name.strip():
            raise ValueError(f"Tool tool_input {tool_input.id} has an unnamed operation")
        if operation.effect not in ("read", "write"):
            raise ValueError(
                f"Tool tool_input {tool_input.id} operation {operation.name} "
                "effect must be read or write"
            )
        if not operation.actions or any(not action.strip() for action in operation.actions):
            raise ValueError(
                f"Tool tool_input {tool_input.id} operation {operation.name} "
                "must declare authorized actions"
            )
    if not tool_input.binding.name.strip():
        raise ValueError(f"Tool tool_input {tool_input.id} has no binding name")


@dataclass(frozen=True)
class ToolBundle:
    provider: str
    inputs: tuple[ToolInput, ...]


@runtime_checkable
class ToolProvider(Protocol):
    provider: str

    async def resolve(self, context: ResolutionContext) -> ToolBundle | None: ...


class ToolProviderRegistry:
    id = "tools"
    scope = "authorization"

    def __init__(self, providers: Sequence[ToolProvider]) -> None:
        provider_ids = [item.provider for item in providers]
        if len(provider_ids) != len(set(provider_ids)):
            raise ValueError("Only one Tool Provider may be installed for each provider")
        self._providers = tuple(providers)

    async def resolve(self, context: ResolutionContext) -> tuple[ToolInput, ...]:
        inputs: list[ToolInput] = []
        for provider in self._providers:
            bundle = await provider.resolve(context)
            if bundle is None:
                continue
            if bundle.provider != provider.provider:
                raise ValueError(
                    f"Tool Provider {provider.provider} returned bundle for {bundle.provider}"
                )
            for tool_input in bundle.inputs:
                validate_tool_input(tool_input)
                if tool_input.capability.provider != provider.provider:
                    raise ValueError(
                        f"Tool input {tool_input.id} capability belongs to "
                        f"{tool_input.capability.provider}, not {provider.provider}"
                    )
            inputs.extend(bundle.inputs)
        return tuple(inputs)


def tool_input_to_execution(tool_input: ToolInput) -> JsonObject:
    validate_tool_input(tool_input)
    capability = tool_input.capability
    binding = tool_input.binding
    binding_wire: JsonObject = {
        "kind": binding.kind,
        "name": binding.name,
        **({} if not binding.secret_refs else {"secretRefs": list(binding.secret_refs)}),
        **(
            {}
            if not binding.runtime_environment
            else {"runtimeEnvironment": dict(binding.runtime_environment)}
        ),
        **(
            {} if not binding.runtime_headers else {"runtimeHeaders": dict(binding.runtime_headers)}
        ),
    }
    if isinstance(binding, McpHttpToolBinding):
        binding_wire["url"] = binding.url
    elif isinstance(binding, McpStdioToolBinding):
        binding_wire.update({"command": binding.command, "args": list(binding.args)})
    else:
        binding_wire.update(
            {"adapter": binding.adapter, "configuration": dict(binding.configuration)}
        )
    return {
        "id": tool_input.id,
        "kind": "tool",
        "required": tool_input.required,
        **(
            {}
            if tool_input.source_item_key is None
            else {"sourceItemKey": tool_input.source_item_key}
        ),
        "capability": {
            "id": capability.id,
            "provider": capability.provider,
            "operations": [
                {
                    "name": operation.name,
                    "effect": operation.effect,
                    "actions": list(operation.actions),
                    **(
                        {}
                        if operation.input_schema is None
                        else {"inputSchema": dict(operation.input_schema)}
                    ),
                }
                for operation in capability.operations
            ],
            "authorization": {
                "provider": capability.authorization.provider,
                "resources": [
                    {
                        "surfaceAccountId": resource.surface_account_id,
                        "scope": resource.scope,
                        **({} if resource.reference is None else {"reference": resource.reference}),
                    }
                    for resource in capability.authorization.resources
                ],
            },
        },
        "binding": binding_wire,
    }


def tool_input_from_execution(value: Mapping[str, Any]) -> ToolInput:
    capability_value = value.get("capability")
    binding_value = value.get("binding")
    if not isinstance(capability_value, Mapping) or not isinstance(binding_value, Mapping):
        raise ValueError("Tool Execution Input requires capability and binding objects")
    authorization_value = capability_value.get("authorization")
    operations_value = capability_value.get("operations")
    if not isinstance(authorization_value, Mapping) or not isinstance(operations_value, list):
        raise ValueError("Tool capability requires authorization and operations")
    resources_value = authorization_value.get("resources")
    if not isinstance(resources_value, list):
        raise ValueError("Tool authorization requires resources")
    binding_kind = binding_value.get("kind")
    common = {
        "name": str(binding_value.get("name") or ""),
        "secret_refs": tuple(str(item) for item in binding_value.get("secretRefs", [])),
        "runtime_environment": dict(binding_value.get("runtimeEnvironment") or {}),
        "runtime_headers": dict(binding_value.get("runtimeHeaders") or {}),
    }
    if binding_kind == "mcp-http":
        binding: ToolRuntimeBinding = McpHttpToolBinding(
            **common, url=str(binding_value.get("url") or "")
        )
    elif binding_kind == "mcp-stdio":
        binding = McpStdioToolBinding(
            **common,
            command=str(binding_value.get("command") or ""),
            args=tuple(str(item) for item in binding_value.get("args", [])),
        )
    elif binding_kind == "native":
        binding = NativeToolBinding(
            **common,
            adapter=str(binding_value.get("adapter") or ""),
            configuration=dict(binding_value.get("configuration") or {}),
        )
    else:
        raise ValueError(f"Unsupported tool binding kind {binding_kind!r}")
    tool_input = ToolInput(
        id=str(value.get("id") or ""),
        required=bool(value.get("required", True)),
        source_item_key=(
            str(value["sourceItemKey"]) if isinstance(value.get("sourceItemKey"), str) else None
        ),
        capability=ToolCapability(
            id=str(capability_value.get("id") or ""),
            provider=str(capability_value.get("provider") or ""),
            operations=tuple(
                ToolOperation(
                    name=str(operation.get("name") or ""),
                    effect=str(operation.get("effect") or ""),
                    actions=tuple(str(item) for item in operation.get("actions", [])),
                    input_schema=(
                        dict(operation["inputSchema"])
                        if isinstance(operation.get("inputSchema"), Mapping)
                        else None
                    ),
                )
                for operation in operations_value
                if isinstance(operation, Mapping)
            ),
            authorization=ToolAuthorization(
                provider=str(authorization_value.get("provider") or ""),
                resources=tuple(
                    ToolAuthorizationResource(
                        surface_account_id=str(resource.get("surfaceAccountId") or ""),
                        scope=str(resource.get("scope") or ""),
                        reference=(
                            str(resource["reference"])
                            if isinstance(resource.get("reference"), str)
                            else None
                        ),
                    )
                    for resource in resources_value
                    if isinstance(resource, Mapping)
                ),
            ),
        ),
        binding=binding,
    )
    validate_tool_input(tool_input)
    return tool_input


@dataclass(frozen=True)
class McpHttpToolConfiguration:
    server_name: str
    url: str
    tool_names: tuple[str, ...]
    transport: str = field(default="mcp-http", init=False)


@dataclass(frozen=True)
class McpStdioToolConfiguration:
    server_name: str
    command: str
    args: tuple[str, ...]
    tool_names: tuple[str, ...]
    transport: str = field(default="mcp-stdio", init=False)


McpToolConfiguration = McpHttpToolConfiguration | McpStdioToolConfiguration


def read_mcp_tool_configuration(tool_input: ToolInput) -> McpToolConfiguration:
    validate_tool_input(tool_input)
    binding = tool_input.binding
    tool_names = tuple(operation.name for operation in tool_input.capability.operations)
    if isinstance(binding, McpHttpToolBinding):
        parsed = urlsplit(binding.url)
        loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
            raise ValueError(
                f"Tool tool_input {tool_input.id} MCP URL must use HTTPS unless it is "
                "a loopback development server"
            )
        if not parsed.netloc:
            raise ValueError(f"Tool tool_input {tool_input.id} has an invalid MCP URL")
        normalized = urlunsplit(
            (parsed.scheme, parsed.netloc, parsed.path or "/", parsed.query, parsed.fragment)
        )
        return McpHttpToolConfiguration(binding.name.strip(), normalized, tool_names)
    if isinstance(binding, McpStdioToolBinding):
        if not binding.command.strip():
            raise ValueError(f"Tool tool_input {tool_input.id} has no MCP command")
        return McpStdioToolConfiguration(
            binding.name.strip(), binding.command, binding.args, tool_names
        )
    raise ValueError(f"Tool tool_input {tool_input.id} does not use an MCP transport")


AdaptedT = TypeVar("AdaptedT")


@runtime_checkable
class ToolAdapter(Protocol[AdaptedT]):
    id: str

    def supports(self, tool_input: ToolInput, context: ResolutionContext) -> bool: ...

    def adapt(
        self, tool_input: ToolInput, context: ResolutionContext
    ) -> AdaptedT | Awaitable[AdaptedT]: ...


class ToolAdapterRegistry:
    def __init__(self, adapters: Sequence[ToolAdapter[Any]]) -> None:
        ids = [adapter.id for adapter in adapters]
        if len(ids) != len(set(ids)):
            raise ValueError("Tool Adapter IDs must be unique")
        self._adapters = tuple(adapters)

    async def adapt(
        self, inputs: Sequence[ToolInput], context: ResolutionContext
    ) -> tuple[Any, ...]:
        adapted: list[Any] = []
        for tool_input in inputs:
            adapter = next(
                (
                    candidate
                    for candidate in self._adapters
                    if candidate.supports(tool_input, context)
                ),
                None,
            )
            if adapter is None:
                if tool_input.required:
                    raise ValueError(
                        f"Harness {context.profile.harness.provider} cannot adapt required "
                        f"{tool_input.binding.kind} tool {tool_input.id}"
                    )
                continue
            result = adapter.adapt(tool_input, context)
            adapted.append(await result if inspect.isawaitable(result) else result)
        return tuple(adapted)


@dataclass(frozen=True)
class AdaptedMcpTool:
    tool_input_id: str
    transport: str
    name: str
    tool_names: tuple[str, ...]
    headers: Mapping[str, str]
    environment: Mapping[str, str]
    url: str | None = None
    command: str | None = None
    args: tuple[str, ...] = ()


class McpToolAdapter:
    id = "mcp"

    def supports(self, tool_input: ToolInput, context: ResolutionContext) -> bool:
        del context
        return isinstance(tool_input.binding, (McpHttpToolBinding, McpStdioToolBinding))

    def adapt(self, tool_input: ToolInput, context: ResolutionContext) -> AdaptedMcpTool:
        del context
        configuration = read_mcp_tool_configuration(tool_input)
        binding = tool_input.binding
        common = {
            "tool_input_id": tool_input.id,
            "transport": configuration.transport,
            "name": configuration.server_name,
            "tool_names": configuration.tool_names,
            "headers": dict(binding.runtime_headers),
            "environment": dict(binding.runtime_environment),
        }
        if isinstance(configuration, McpHttpToolConfiguration):
            return AdaptedMcpTool(**common, url=configuration.url)
        return AdaptedMcpTool(**common, command=configuration.command, args=configuration.args)


@dataclass(frozen=True)
class ToolInvocationRequest:
    id: str
    binding_kind: str
    binding_name: str
    operation: str
    arguments: Mapping[str, Any] | None = None
    idempotency_key: str | None = None


@dataclass(frozen=True)
class ToolInvocationResult:
    content: Mapping[str, Any]
    is_error: bool = False


@dataclass(frozen=True)
class ToolCall:
    id: str
    capability_id: str
    provider: str
    binding_kind: str
    binding_name: str
    operation: str
    effect: str
    actions: tuple[str, ...]
    resources: tuple[ToolAuthorizationResource, ...]
    arguments: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class ToolCallOutcome:
    references: tuple[str, ...]


def describe_tool_call(inputs: Sequence[ToolInput], request: ToolInvocationRequest) -> ToolCall:
    tool_input = next(
        (
            candidate
            for candidate in inputs
            if candidate.binding.kind == request.binding_kind
            and candidate.binding.name == request.binding_name
            and any(item.name == request.operation for item in candidate.capability.operations)
        ),
        None,
    )
    if tool_input is None:
        raise ValueError(
            f"Harness called unprovisioned {request.binding_kind} operation "
            f"{request.binding_name}/{request.operation}"
        )
    validate_tool_input(tool_input)
    operation = next(
        item for item in tool_input.capability.operations if item.name == request.operation
    )
    arguments = _bounded_json_object(request.arguments)
    return ToolCall(
        id=request.id,
        capability_id=tool_input.capability.id,
        provider=tool_input.capability.provider,
        binding_kind=request.binding_kind,
        binding_name=request.binding_name,
        operation=request.operation,
        effect=operation.effect,
        actions=operation.actions,
        resources=tool_input.capability.authorization.resources,
        arguments=arguments,
    )


_REFERENCE_PATTERN = re.compile(r"https?://[^\s<>\"')\]]+", re.IGNORECASE)


def tool_call_outcome_from_text(values: Sequence[str]) -> ToolCallOutcome | None:
    references: list[str] = []
    for value in values:
        for match in _REFERENCE_PATTERN.findall(value):
            reference = match.rstrip(".,;:!?")
            if len(reference) <= 2048 and reference not in references:
                references.append(reference)
            if len(references) == 10:
                return ToolCallOutcome(tuple(references))
    return ToolCallOutcome(tuple(references)) if references else None


@runtime_checkable
class ToolInvoker(Protocol):
    id: str

    def supports(self, tool_input: ToolInput) -> bool: ...

    async def invoke(
        self,
        tool_input: ToolInput,
        request: ToolInvocationRequest,
        cancellation: Any | None = None,
    ) -> ToolInvocationResult: ...


class ToolInvokerRegistry:
    def __init__(self, invokers: Sequence[ToolInvoker]) -> None:
        ids = [invoker.id for invoker in invokers]
        if len(ids) != len(set(ids)):
            raise ValueError("Tool Invoker IDs must be unique")
        self._invokers = tuple(invokers)

    async def invoke(
        self,
        inputs: Sequence[ToolInput],
        request: ToolInvocationRequest,
        cancellation: Any | None = None,
    ) -> tuple[ToolCall, ToolInvocationResult]:
        call = describe_tool_call(inputs, request)
        tool_input = next(
            (
                candidate
                for candidate in inputs
                if candidate.capability.id == call.capability_id
                and candidate.binding.kind == request.binding_kind
                and candidate.binding.name == request.binding_name
            ),
            None,
        )
        if tool_input is None:
            raise ValueError(f"Missing capability {call.capability_id}")
        invoker = next((item for item in self._invokers if item.supports(tool_input)), None)
        if invoker is None:
            raise ValueError(
                f"No Worker tool invoker supports {tool_input.binding.kind} binding "
                f"{tool_input.binding.name}"
            )
        result = await invoker.invoke(tool_input, request, cancellation)
        if not isinstance(result.content, Mapping):
            raise ValueError("Tool invocation result content must be a JSON object")
        return call, result


@dataclass(frozen=True)
class ToolEffectRecord:
    state: str
    key: str
    fingerprint: str
    started_at: str
    completed_at: str | None = None
    failed_at: str | None = None
    result: ToolInvocationResult | None = None
    error: str | None = None
    retryable: bool | None = None


@runtime_checkable
class ToolEffectJournal(Protocol):
    async def begin(
        self, key: str, fingerprint: str, started_at: str
    ) -> tuple[bool, ToolEffectRecord]: ...

    async def complete(
        self, key: str, fingerprint: str, completed_at: str, result: ToolInvocationResult
    ) -> ToolEffectRecord: ...

    async def fail(
        self,
        key: str,
        fingerprint: str,
        failed_at: str,
        error: str,
        retryable: bool,
    ) -> ToolEffectRecord: ...


class MemoryToolEffectJournal:
    def __init__(self) -> None:
        self.records: dict[str, ToolEffectRecord] = {}
        self._lock = asyncio.Lock()

    async def begin(
        self, key: str, fingerprint: str, started_at: str
    ) -> tuple[bool, ToolEffectRecord]:
        async with self._lock:
            existing = self.records.get(key)
            if existing is not None:
                return False, existing
            record = ToolEffectRecord("started", key, fingerprint, started_at)
            self.records[key] = record
            return True, record

    async def complete(
        self, key: str, fingerprint: str, completed_at: str, result: ToolInvocationResult
    ) -> ToolEffectRecord:
        async with self._lock:
            started = self._started(key, fingerprint)
            record = ToolEffectRecord(
                "completed",
                key,
                fingerprint,
                started.started_at,
                completed_at=completed_at,
                result=result,
            )
            self.records[key] = record
            return record

    async def fail(
        self,
        key: str,
        fingerprint: str,
        failed_at: str,
        error: str,
        retryable: bool,
    ) -> ToolEffectRecord:
        async with self._lock:
            started = self._started(key, fingerprint)
            record = ToolEffectRecord(
                "failed",
                key,
                fingerprint,
                started.started_at,
                failed_at=failed_at,
                error=error,
                retryable=retryable,
            )
            self.records[key] = record
            return record

    def _started(self, key: str, fingerprint: str) -> ToolEffectRecord:
        record = self.records.get(key)
        if record is None:
            raise ValueError(f"Tool effect {key!r} was not started")
        if record.fingerprint != fingerprint:
            raise ValueError(f"Tool effect {key!r} fingerprint changed")
        return record


class FileToolEffectJournal:
    """Local atomic journal. Distributed Worklets should supply a shared store."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        if not self.path.is_absolute():
            raise ValueError("Tool effect journal path must be absolute")
        self._lock = asyncio.Lock()

    async def begin(
        self, key: str, fingerprint: str, started_at: str
    ) -> tuple[bool, ToolEffectRecord]:
        async with self._lock:
            records = await asyncio.to_thread(self._read)
            existing = records.get(key)
            if existing is not None:
                return False, existing
            record = ToolEffectRecord("started", key, fingerprint, started_at)
            records[key] = record
            await asyncio.to_thread(self._write, records)
            return True, record

    async def complete(
        self, key: str, fingerprint: str, completed_at: str, result: ToolInvocationResult
    ) -> ToolEffectRecord:
        return await self._transition(
            key,
            fingerprint,
            lambda started: ToolEffectRecord(
                "completed", key, fingerprint, started, completed_at=completed_at, result=result
            ),
        )

    async def fail(
        self,
        key: str,
        fingerprint: str,
        failed_at: str,
        error: str,
        retryable: bool,
    ) -> ToolEffectRecord:
        return await self._transition(
            key,
            fingerprint,
            lambda started: ToolEffectRecord(
                "failed",
                key,
                fingerprint,
                started,
                failed_at=failed_at,
                error=error,
                retryable=retryable,
            ),
        )

    async def _transition(self, key: str, fingerprint: str, create: Any) -> ToolEffectRecord:
        async with self._lock:
            records = await asyncio.to_thread(self._read)
            existing = records.get(key)
            if existing is None:
                raise ValueError(f"Tool effect {key!r} was not started")
            if existing.fingerprint != fingerprint:
                raise ValueError(f"Tool effect {key!r} fingerprint changed")
            record = create(existing.started_at)
            records[key] = record
            await asyncio.to_thread(self._write, records)
            return record

    def _read(self) -> dict[str, ToolEffectRecord]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        if not isinstance(raw, dict):
            return {}
        return {key: _effect_record_from_json(value) for key, value in raw.items()}

    def _write(self, records: Mapping[str, ToolEffectRecord]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        payload = {key: _effect_record_to_json(value) for key, value in records.items()}
        descriptor, temporary = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, sort_keys=True)
                handle.write("\n")
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
            os.chmod(self.path, 0o600)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


class ToolEffectInDoubtError(RuntimeError):
    def __init__(self, key: str) -> None:
        super().__init__(f"Tool effect {key!r} is in doubt and requires reconciliation")
        self.key = key


class ReliableToolInvokerRegistry:
    def __init__(self, invokers: Sequence[ToolInvoker], journal: ToolEffectJournal) -> None:
        self._registry = ToolInvokerRegistry(invokers)
        self._journal = journal

    async def invoke(
        self,
        inputs: Sequence[ToolInput],
        request: ToolInvocationRequest,
        cancellation: Any | None = None,
    ) -> tuple[ToolCall, ToolInvocationResult, bool]:
        call = describe_tool_call(inputs, request)
        if call.effect != "write":
            executed_call, result = await self._registry.invoke(inputs, request, cancellation)
            return executed_call, result, False
        key = (request.idempotency_key or "").strip()
        if not key:
            raise ValueError(f"Write operation {request.operation} requires an idempotency_key")
        fingerprint = _tool_effect_fingerprint(call)
        acquired, record = await self._journal.begin(key, fingerprint, _utc_now())
        if record.fingerprint != fingerprint:
            raise ValueError(f"Idempotency key {key!r} was reused for another tool effect")
        if not acquired:
            if record.state == "completed" and record.result is not None:
                return call, record.result, True
            if record.state == "started":
                raise ToolEffectInDoubtError(key)
        try:
            executed_call, result = await self._registry.invoke(inputs, request, cancellation)
        except Exception as error:
            await self._journal.fail(key, fingerprint, _utc_now(), str(error), False)
            raise
        await self._journal.complete(key, fingerprint, _utc_now(), result)
        return executed_call, result, False


def _bounded_json_object(value: Mapping[str, Any] | None) -> Mapping[str, Any] | None:
    if value is None:
        return None
    try:
        serialized = json.dumps(value, separators=(",", ":"), sort_keys=True)
    except (TypeError, ValueError) as error:
        raise ValueError("Tool arguments must be JSON serializable") from error
    if len(serialized.encode("utf-8")) > 16_000:
        return {"omitted": "arguments exceeded 16000 bytes"}
    loaded = json.loads(serialized)
    if not isinstance(loaded, dict):
        return None
    return loaded


def _tool_effect_fingerprint(call: ToolCall) -> str:
    payload = asdict(call)
    return hashlib.sha256(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).hexdigest()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _effect_record_to_json(record: ToolEffectRecord) -> JsonObject:
    payload = asdict(record)
    return {key: value for key, value in payload.items() if value is not None}


def _effect_record_from_json(value: Any) -> ToolEffectRecord:
    if not isinstance(value, dict):
        raise ValueError("Tool effect journal contains an invalid record")
    result = value.get("result")
    invocation_result = None
    if isinstance(result, dict) and isinstance(result.get("content"), dict):
        invocation_result = ToolInvocationResult(
            result["content"], bool(result.get("is_error", False))
        )
    return ToolEffectRecord(
        state=str(value["state"]),
        key=str(value["key"]),
        fingerprint=str(value["fingerprint"]),
        started_at=str(value["started_at"]),
        completed_at=value.get("completed_at"),
        failed_at=value.get("failed_at"),
        result=invocation_result,
        error=value.get("error"),
        retryable=value.get("retryable"),
    )
