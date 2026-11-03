from __future__ import annotations

import inspect
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping, Sequence

from .harness import HarnessEnvironmentAccesses
from .models import (
    CANCELLATION_CAPABILITY,
    EVENT_STREAM_CAPABILITY,
    CancellationToken,
    ResolutionContext,
    TaskProgress,
    Worker,
    WorkerDescriptor,
)
from .tools import (
    ToolAdapter,
    ToolInput,
    ToolInvocationRequest,
    ToolInvoker,
)


@dataclass(frozen=True)
class Finding:
    code: str
    message: str


@dataclass(frozen=True)
class ConformanceReport:
    subject: str
    findings: tuple[Finding, ...]

    @property
    def passed(self) -> bool:
        return not self.findings

    def assert_passed(self) -> None:
        if not self.passed:
            details = "\n".join(f"- [{item.code}] {item.message}" for item in self.findings)
            raise AssertionError(f"{self.subject} failed conformance:\n{details}")


def assert_conformance(report: ConformanceReport) -> None:
    """Raise one compact assertion suitable for any Python test runner."""
    report.assert_passed()


def validate_descriptor(descriptor: WorkerDescriptor) -> ConformanceReport:
    findings: list[Finding] = []
    if not descriptor.id.strip() or not descriptor.type.strip():
        findings.append(Finding("worker.descriptor.identity", "Worker ID and type are required"))
    if not descriptor.profiles:
        findings.append(Finding("worker.descriptor.profiles", "At least one profile is required"))
    keys = [(profile.id, profile.revision) for profile in descriptor.profiles]
    if len(keys) != len(set(keys)):
        findings.append(Finding("worker.descriptor.profiles.duplicate", "Profiles must be unique"))
    if descriptor.max_concurrency < 1:
        findings.append(Finding("worker.descriptor.capacity", "maxConcurrency must be positive"))
    context_contracts = [
        (support.type, version)
        for support in descriptor.context_types
        for version in support.versions
    ]
    if len(context_contracts) != len(set(context_contracts)):
        findings.append(
            Finding("worker.descriptor.context-types.duplicate", "Context types must be unique")
        )
    if any(
        not support.type.strip()
        or not support.versions
        or any(not isinstance(version, int) or version < 1 for version in support.versions)
        for support in descriptor.context_types
    ):
        findings.append(
            Finding(
                "worker.descriptor.context-types.invalid",
                "Context types need a type and positive integer versions",
            )
        )
    if EVENT_STREAM_CAPABILITY not in {item.id for item in descriptor.capabilities}:
        findings.append(Finding("worker.descriptor.events", "Event stream capability is required"))
    return ConformanceReport(f"Worker {descriptor.id}", tuple(findings))


def validate_events(events: list[dict[str, Any]], attempt: dict[str, Any]) -> ConformanceReport:
    findings: list[Finding] = []
    if not events:
        return ConformanceReport("Task Attempt", (Finding("events.empty", "No events emitted"),))
    terminal_indexes: list[int] = []
    for index, event in enumerate(events):
        if event.get("taskId") != attempt.get("taskId") or event.get("attemptId") != attempt.get(
            "attemptId"
        ):
            findings.append(Finding("events.identity", f"Event {index} changed Task identity"))
        try:
            datetime.fromisoformat(str(event.get("at", "")).replace("Z", "+00:00"))
        except ValueError:
            findings.append(Finding("events.timestamp", f"Event {index} has an invalid timestamp"))
        event_type = event.get("type")
        if event_type in ("execution.completed", "execution.failed"):
            terminal_indexes.append(index)
        if event_type == "execution.started" and not isinstance(event.get("workerId"), str):
            findings.append(Finding("events.started.worker", "execution.started needs workerId"))
        if event_type == "output.message":
            message = event.get("message")
            if not isinstance(message, dict) or message.get("role") != "teammate":
                findings.append(
                    Finding("events.output.message", "output.message needs a teammate message")
                )
        if event_type == "progress.updated":
            progress = event.get("progress")
            try:
                if not isinstance(progress, Mapping):
                    raise ValueError("progress.updated requires a progress object")
                TaskProgress.from_wire(progress)
            except ValueError as error:
                findings.append(Finding("events.progress.invalid", str(error)))
    types = [event.get("type") for event in events]
    if types[0] != "execution.started" or types.count("execution.started") != 1:
        findings.append(Finding("events.started", "execution.started must occur first and once"))
    if len(terminal_indexes) != 1 or terminal_indexes[0] != len(events) - 1:
        findings.append(Finding("events.terminal", "Exactly one terminal event must occur last"))
    return ConformanceReport(f"Task Attempt {attempt.get('attemptId')}", tuple(findings))


async def run_worker_conformance(worker: Worker, attempt: dict[str, Any]) -> ConformanceReport:
    findings = list(validate_descriptor(await worker.describe()).findings)
    token = CancellationToken()
    events = [event async for event in worker.execute(attempt, token)]
    findings.extend(validate_events(events, attempt).findings)
    return ConformanceReport("Worker", tuple(findings))


async def run_cancellation_conformance(
    worker: Worker, attempt: dict[str, Any]
) -> ConformanceReport:
    descriptor = await worker.describe()
    if CANCELLATION_CAPABILITY not in {item.id for item in descriptor.capabilities}:
        return ConformanceReport("Worker cancellation", ())
    token = CancellationToken()
    token.cancel("conformance probe")
    events = [event async for event in worker.execute(attempt, token)]
    terminal = events[-1].get("type") if events else None
    findings = (
        ()
        if terminal == "execution.failed"
        else (Finding("worker.cancellation", "Cancelled execution must emit execution.failed"),)
    )
    return ConformanceReport("Worker cancellation", findings)


def validate_harness_descriptor(
    harness: Any,
    descriptor: Any,
    expected_input_kinds: Sequence[str] | None = None,
) -> ConformanceReport:
    findings: list[Finding] = []
    harness_id = str(getattr(harness, "id", ""))
    described_id = str(getattr(descriptor, "id", ""))
    version = str(getattr(descriptor, "version", ""))
    if not described_id.strip() or not version.strip():
        findings.append(
            Finding("harness.capabilities.identity", "Harness ID and version are required")
        )
    if harness_id != described_id:
        findings.append(
            Finding(
                "harness.capabilities.identity",
                f"Harness id {harness_id} does not match described id {described_id}",
            )
        )
    kinds = tuple(descriptor.input_kinds)
    if len(kinds) != len(set(kinds)):
        findings.append(
            Finding(
                "harness.capabilities.input-duplicate",
                "Harness input kinds must be unique",
            )
        )
    placements = tuple(descriptor.runtime_placements or ())
    if len(placements) != len(set(placements)):
        findings.append(
            Finding(
                "harness.capabilities.placement-duplicate",
                "Harness execution placements must be unique",
            )
        )
    if expected_input_kinds is not None:
        expected = set(expected_input_kinds)
        actual = set(kinds)
        for kind in sorted(expected - actual):
            findings.append(
                Finding(
                    "harness.capabilities.input-missing",
                    f"Harness does not declare expected input kind {kind}",
                )
            )
        for kind in sorted(actual - expected):
            findings.append(
                Finding(
                    "harness.capabilities.input-unexpected",
                    f"Harness declares unexpected input kind {kind}",
                )
            )
    return ConformanceReport(f"Harness {harness_id or '<unknown>'}", tuple(findings))


def validate_harness_events(events: Sequence[dict[str, Any]], descriptor: Any) -> ConformanceReport:
    findings: list[Finding] = []
    if not bool(getattr(descriptor, "streaming", False)) and any(
        event.get("type") == "output.delta" for event in events
    ):
        findings.append(
            Finding(
                "harness.capabilities.streaming",
                "Harness emitted output.delta while declaring streaming=False",
            )
        )
    open_calls: set[str] = set()
    for event in events:
        event_type = event.get("type")
        call = event.get("call")
        call_id = _call_id(call)
        if event_type == "tool.call.started":
            if call_id is None:
                findings.append(Finding("harness.tools.call", "Tool event has no call ID"))
            elif call_id in open_calls:
                findings.append(
                    Finding(
                        "harness.tools.duplicate-start",
                        f"Tool call {call_id} was started more than once",
                    )
                )
            else:
                open_calls.add(call_id)
        if event_type in ("tool.call.completed", "tool.call.failed"):
            if call_id is None or call_id not in open_calls:
                findings.append(
                    Finding(
                        "harness.tools.terminal-without-start",
                        f"Tool call {call_id or '<unknown>'} ended without a matching start",
                    )
                )
            else:
                open_calls.remove(call_id)
    findings.extend(
        Finding("harness.tools.unfinished", f"Tool call {call_id} has no terminal event")
        for call_id in sorted(open_calls)
    )
    return ConformanceReport(f"Harness {getattr(descriptor, 'id', '<unknown>')}", tuple(findings))


async def run_harness_conformance(
    harness: Any,
    context: Any,
    execution_environment: Any | None = None,
    expected_input_kinds: Sequence[str] | None = None,
    verify_cancellation: bool = False,
) -> ConformanceReport:
    findings: list[Finding] = []
    try:
        descriptor = await harness.describe()
    except Exception as error:
        return ConformanceReport(
            f"Harness {getattr(harness, 'id', '<unknown>')}",
            (Finding("harness.describe.threw", f"describe() threw: {error}"),),
        )
    findings.extend(validate_harness_descriptor(harness, descriptor, expected_input_kinds).findings)
    placement = getattr(execution_environment, "placement", None)
    placements = tuple(descriptor.runtime_placements or ())
    if placement is not None and placements and placement not in placements:
        findings.append(
            Finding(
                "harness.capabilities.placement",
                f"Harness does not declare support for the exercised {placement} placement",
            )
        )
    try:
        events = await _exercise_harness(
            harness, context, execution_environment, CancellationToken()
        )
        findings.extend(validate_harness_events(events, descriptor).findings)
    except Exception as error:
        findings.append(Finding("harness.execute.threw", f"Harness execution threw: {error}"))
    if verify_cancellation and bool(getattr(descriptor, "cancellation", False)):
        token = CancellationToken()
        token.cancel("SuperTag conformance cancellation probe")
        try:
            cancelled = await _exercise_harness(harness, context, execution_environment, token)
            if cancelled:
                findings.append(
                    Finding(
                        "harness.cancellation.not-honored",
                        "Harness emitted events after receiving a pre-cancelled token",
                    )
                )
        except Exception:
            pass
    return ConformanceReport(f"Harness {getattr(harness, 'id', '<unknown>')}", tuple(findings))


async def run_environment_conformance(
    provider: Any, spec: Any, expected_placement: str | None = None
) -> ConformanceReport:
    findings: list[Finding] = []
    provider_id = str(getattr(provider, "id", ""))
    if not provider_id.strip():
        findings.append(Finding("environment.provider.id", "Environment provider ID is required"))
    capabilities = tuple(getattr(provider, "capabilities", ()))
    keys = [(_attribute(item, "id"), _attribute(item, "version")) for item in capabilities]
    if len(keys) != len(set(keys)):
        findings.append(
            Finding(
                "environment.provider.capability-duplicate",
                "Environment provider capabilities must be unique",
            )
        )
    environment: Any | None = None
    try:
        environment = await _provision_environment(provider, spec)
        if not str(getattr(environment, "id", "")).strip():
            findings.append(Finding("environment.id", "Environment ID is required"))
        if not str(getattr(environment, "root_directory", "")).strip():
            findings.append(Finding("environment.root", "Environment root directory is required"))
        placement = getattr(environment, "placement", None)
        if expected_placement is not None and placement != expected_placement:
            findings.append(
                Finding(
                    "environment.placement",
                    f"Expected {expected_placement} placement, received {placement}",
                )
            )
        prepared = environment.prepare(getattr(spec, "plan", spec))
        if inspect.isawaitable(prepared):
            await prepared
    except Exception as error:
        findings.append(
            Finding("environment.lifecycle.threw", f"Environment lifecycle threw: {error}")
        )
    finally:
        if environment is not None:
            try:
                disposed = environment.dispose("completed" if not findings else "failed")
                if inspect.isawaitable(disposed):
                    await disposed
            except Exception as error:
                findings.append(Finding("environment.dispose.threw", f"dispose() threw: {error}"))
    return ConformanceReport(f"Environment provider {provider_id or '<unknown>'}", tuple(findings))


async def run_tool_adapter_conformance(
    adapter: ToolAdapter[Any], tool_input: ToolInput, context: ResolutionContext
) -> ConformanceReport:
    findings: list[Finding] = []
    adapter_id = str(getattr(adapter, "id", ""))
    if not adapter_id.strip():
        findings.append(Finding("tool.adapter.id", "Tool Adapter ID is required"))
    try:
        if not adapter.supports(tool_input, context):
            findings.append(
                Finding(
                    "tool.adapter.unsupported",
                    f"Adapter does not support the supplied {tool_input.binding.kind} tool input",
                )
            )
        else:
            adapted = adapter.adapt(tool_input, context)
            if inspect.isawaitable(adapted):
                adapted = await adapted
            if adapted is None:
                findings.append(
                    Finding("tool.adapter.empty", "Adapter returned None for a supported tool")
                )
    except Exception as error:
        findings.append(Finding("tool.adapter.threw", f"adapt() threw: {error}"))
    return ConformanceReport(f"Tool Adapter {adapter_id or '<unknown>'}", tuple(findings))


async def run_tool_invoker_conformance(
    invoker: ToolInvoker,
    tool_input: ToolInput,
    request: ToolInvocationRequest,
) -> ConformanceReport:
    findings: list[Finding] = []
    invoker_id = str(getattr(invoker, "id", ""))
    if not invoker_id.strip():
        findings.append(Finding("tool.invoker.id", "Tool Invoker ID is required"))
    try:
        if not invoker.supports(tool_input):
            findings.append(
                Finding(
                    "tool.invoker.unsupported",
                    f"Invoker does not support the supplied {tool_input.binding.kind} tool_input",
                )
            )
        else:
            result = await invoker.invoke(tool_input, request, None)
            if not isinstance(result.content, Mapping):
                findings.append(
                    Finding("tool.invoker.result", "Invoker result content must be a JSON object")
                )
    except Exception as error:
        findings.append(Finding("tool.invoker.threw", f"invoke() threw: {error}"))
    return ConformanceReport(f"Tool Invoker {invoker_id or '<unknown>'}", tuple(findings))


async def _exercise_harness(
    harness: Any, context: Any, execution_environment: Any | None, token: CancellationToken
) -> list[dict[str, Any]]:
    if hasattr(harness, "plan") and hasattr(harness, "start"):
        plan = await harness.plan(context)
        execution = await harness.start(
            plan,
            HarnessEnvironmentAccesses(
                runtime=execution_environment,
                execution=execution_environment,
            ),
            context,
        )
        try:
            stream = execution.run(token)
            return [event async for event in stream]
        finally:
            closed = execution.close()
            if inspect.isawaitable(closed):
                await closed
    attempt = context.get("attempt", context) if isinstance(context, dict) else context
    return [event async for event in harness.execute(attempt, token)]


def _call_id(call: Any) -> str | None:
    if isinstance(call, dict):
        value = call.get("id")
    else:
        value = getattr(call, "id", None)
    return value if isinstance(value, str) and value else None


def _attribute(value: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(value, dict) and name in value:
            return value[name]
        if hasattr(value, name):
            return getattr(value, name)
    return default


async def _provision_environment(provider: Any, spec: Any) -> Any:
    """Exercise both the combined-spec API and Python's decomposed runtime API."""
    signature = inspect.signature(provider.provision)
    positional = [
        parameter
        for parameter in signature.parameters.values()
        if parameter.kind
        in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    if len(positional) <= 1:
        return await provider.provision(spec)
    task = _attribute(spec, "task")
    profile = _attribute(spec, "profile")
    plan = _attribute(spec, "plan")
    cancellation = _attribute(spec, "cancellation", default=CancellationToken())
    return await provider.provision(task, profile, plan, cancellation)
