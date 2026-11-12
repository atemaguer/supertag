"""An ordinary Python application for the Worklet's local OpenAI Agents Harness."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import ipaddress
import json
import math
import os
import re
import signal
import sys
from contextlib import suppress
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .openai_agents import (
    OpenAIAgentsRunner,
    OpenAIAgentsUsage,
    _normalize_response,
    _OfficialOpenAIAgentsRunner,
)

HARNESS = "openai-agents"
CHECKPOINT_FORMAT = "session-items-v1"
MAX_BOOTSTRAP_BYTES = 4_096
MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024
MAX_MESSAGE_BYTES = MAX_CHECKPOINT_BYTES + 1024 * 1024
MAX_OUTPUT_BYTES = 262_144
MAX_EVENT_CHARACTERS = 4_096  # A Unicode scalar occupies at most four UTF-8 bytes.
RPC_TIMEOUT_SECONDS = 5


class _AdapterFailure(Exception):
    """A controlled failure whose text is safe to record as a Task result."""


class _Harness:
    def __init__(self, channel: Any, pb: Any, token: str) -> None:
        service = pb.DESCRIPTOR.services_by_name["Harness"].full_name
        self.pb = pb
        self.metadata = (("authorization", f"Bearer {token}"),)
        self.attach = _unary(channel, service, "Attach", pb.HarnessRun)
        self.publish = _unary(channel, service, "Publish", pb.TaskEvent)
        self.report_usage = _unary(channel, service, "ReportUsage", pb.ReportAttemptUsageResponse)
        self.complete = _unary(channel, service, "Complete", pb.HarnessCompleteResponse)
        self.sequence = 0
        self.usage_sequence = 0
        self.last_usage: OpenAIAgentsUsage | None = None

    async def call(self, method: Any, request: Any) -> Any:
        return await method(request, metadata=self.metadata, timeout=RPC_TIMEOUT_SECONDS)

    async def emit(self, text: str) -> None:
        for offset in range(0, len(text), MAX_EVENT_CHARACTERS):
            self.sequence += 1
            await self.call(
                self.publish,
                self.pb.HarnessPublishRequest(
                    sequence=self.sequence, text=text[offset : offset + MAX_EVENT_CHARACTERS]
                ),
            )

    async def meter(self, usage: OpenAIAgentsUsage, redactor: _Redactor) -> None:
        if self.last_usage == usage:
            return
        self.usage_sequence += 1
        observed = usage.observed_model
        native = self.pb.NativeTokenUsage(
            input_tokens=usage.input_tokens,
            cached_input_tokens=usage.cached_input_tokens,
            output_tokens=usage.output_tokens,
        )
        if observed and redactor.redact(observed) == observed:
            native.observed_model = observed
        await self.call(
            self.report_usage,
            self.pb.HarnessUsageRequest(sequence=self.usage_sequence, native_usage=native),
        )
        self.last_usage = usage


def _unary(channel: Any, service: str, method: str, response: Any) -> Any:
    return channel.unary_unary(
        f"/{service}/{method}",
        request_serializer=lambda request: request.SerializeToString(),
        response_deserializer=response.FromString,
    )


class _Redactor:
    def __init__(self, secrets: tuple[str, ...]) -> None:
        values = sorted({secret for secret in secrets if secret}, key=len, reverse=True)
        self._pattern = re.compile("|".join(re.escape(value) for value in values) or r"(?!)")
        self._tail = max(map(len, values), default=1) - 1
        self._pending = ""

    def redact(self, text: str) -> str:
        return self._pattern.sub("[REDACTED]", text)

    def records(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.redact(value)
        if isinstance(value, list):
            return [self.records(item) for item in value]
        if isinstance(value, dict):
            return {self.redact(key): self.records(item) for key, item in value.items()}
        return value

    def stream(self, text: str, *, final: bool = False) -> str:
        self._pending += text
        limit = len(self._pending) if final else max(0, len(self._pending) - self._tail)
        for match in self._pattern.finditer(self._pending):
            if match.start() >= limit:
                break
            # Retain a split credential until it can be redacted as one value.
            limit = max(limit, match.end())
        safe, self._pending = self._pending[:limit], self._pending[limit:]
        return self.redact(safe)


def _bootstrap_target(bootstrap: Any) -> str:
    try:
        endpoint = urlsplit(bootstrap.endpoint)
        host = ipaddress.ip_address(endpoint.hostname or "")
        port = endpoint.port
    except ValueError as error:
        raise _AdapterFailure("invalid Worklet bootstrap endpoint") from error
    if (
        endpoint.scheme != "http"
        or not host.is_loopback
        or port is None
        or port == 0
        or endpoint.username is not None
        or endpoint.password is not None
        or endpoint.path not in ("", "/")
        or endpoint.query
        or endpoint.fragment
        or not re.fullmatch(r"[A-Za-z0-9._~-]{1,512}", bootstrap.token)
    ):
        raise _AdapterFailure("invalid Worklet bootstrap identity")
    return endpoint.netloc


def _scope(task: Any) -> dict[str, Any]:
    return {
        "tag_id": task.tag_id,
        "session_id": task.session_id,
        "workspace": (
            {"id": task.workspace.workspace_id, "base": task.workspace.base_commit}
            if task.HasField("workspace")
            else None
        ),
    }


def _restore(attached: Any, redactor: _Redactor) -> list[dict[str, Any]]:
    if not attached.HasField("checkpoint"):
        return []
    checkpoint = attached.checkpoint
    if (
        checkpoint.harness != HARNESS
        or checkpoint.format != CHECKPOINT_FORMAT
        or not 0 < len(checkpoint.payload) <= MAX_CHECKPOINT_BYTES
        or hashlib.sha256(checkpoint.payload).hexdigest() != checkpoint.sha256
    ):
        raise _AdapterFailure("OpenAI Agents Session checkpoint is invalid")
    try:
        serialized = checkpoint.payload.decode("utf-8")
        envelope = json.loads(serialized)
        if redactor.records(envelope) != envelope:
            raise ValueError("credential in checkpoint")
    except (ValueError, RecursionError) as error:
        raise _AdapterFailure("OpenAI Agents Session checkpoint is invalid") from error
    if (
        not isinstance(envelope, dict)
        or envelope.get("scope") != _scope(attached.task)
        or not isinstance(envelope.get("items"), list)
        or not all(isinstance(item, dict) for item in envelope["items"])
    ):
        raise _AdapterFailure("OpenAI Agents Session checkpoint does not match this Task")
    return envelope["items"]


def _capture(pb: Any, task: Any, items: list[dict[str, Any]], redactor: _Redactor) -> Any:
    serialized = json.dumps(
        {"scope": _scope(task), "items": redactor.records(items)},
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )
    payload = serialized.encode("utf-8")
    if len(payload) > MAX_CHECKPOINT_BYTES:
        raise _AdapterFailure("OpenAI Agents Session checkpoint exceeds its size limit")
    return pb.SessionCheckpoint(
        harness=HARNESS,
        format=CHECKPOINT_FORMAT,
        payload=payload,
        sha256=hashlib.sha256(payload).hexdigest(),
    )


async def _execute(
    harness: _Harness,
    attached: Any,
    workspace: Path,
    model: str | None,
    max_turns: int,
    redactor: _Redactor,
    runner: OpenAIAgentsRunner | None,
    model_provider: Any,
) -> Any:
    pb = harness.pb
    task = attached.task
    if (
        not attached.HasField("task")
        or not attached.attempt_id
        or task.attempt_id != attached.attempt_id
        or task.state != pb.TASK_STATE_RUNNING
        or not task.tag_id
        or not task.session_id
    ):
        raise _AdapterFailure("Worklet returned an invalid running Attempt")
    actions = set(task.allowed_actions)
    if actions - {"files:read"}:
        raise _AdapterFailure("OpenAI Agents cannot enforce the Task's allowed actions")
    if not workspace.is_dir():
        raise _AdapterFailure("OpenAI Agents workspace is unavailable")
    session_items = _restore(attached, redactor)
    runner = runner or _OfficialOpenAIAgentsRunner(
        allow_workspace_read="files:read" in actions, model_provider=model_provider
    )
    instructions = (
        "You are a SuperTag teammate. Use only the tools provided for this Task. "
        "Return a concise response suitable for the requester."
    )
    if task.instructions:
        instructions += f"\n\n{task.instructions}"
    run = runner.start(
        name=task.tag_id,
        instructions=instructions,
        prompt=task.prompt,
        model=model,
        max_turns=max_turns,
        workspace=workspace,
        session_items=session_items,
    )
    stream = run.stream()
    deltas = []
    total = 0
    try:
        async for event in stream:
            if event.usage is not None:
                await harness.meter(event.usage, redactor)
            if event.type != "output.delta" or not event.text:
                continue
            total += len(event.text.encode("utf-8"))
            if total > MAX_OUTPUT_BYTES:
                raise _AdapterFailure("OpenAI Agents output exceeds its size limit")
            deltas.append(event.text)
            await harness.emit(redactor.stream(event.text))
    except BaseException:
        await run.cancel()
        raise
    finally:
        close = getattr(stream, "aclose", None)
        if close is not None:
            await close()
    await harness.emit(redactor.stream("", final=True))
    usage = getattr(run, "usage", None)
    if usage is not None:
        await harness.meter(usage, redactor)
    result = _normalize_response(redactor.redact(run.final_output or "".join(deltas)))
    checkpoint = _capture(pb, task, run.session_items, redactor)
    return pb.HarnessCompleteRequest(succeeded=True, result=result, checkpoint=checkpoint)


async def run_adapter(
    bootstrap_bytes: bytes,
    *,
    workspace: Path | None = None,
    model: str | None = None,
    timeout_seconds: float = 300,
    max_turns: int = 10,
    runner: OpenAIAgentsRunner | None = None,
    model_provider: Any = None,
) -> None:
    """Execute a single Worklet-authorized Attempt using its private bootstrap frame."""
    import grpc

    from ._runtime_v2 import runtime_pb2 as pb

    if not 0 < len(bootstrap_bytes) <= MAX_BOOTSTRAP_BYTES:
        raise _AdapterFailure("invalid Worklet bootstrap size")
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0 or max_turns < 1:
        raise _AdapterFailure("invalid OpenAI Agents execution limits")
    bootstrap = pb.AdapterBootstrap.FromString(bootstrap_bytes)
    target = _bootstrap_target(bootstrap)
    redactor = _Redactor((bootstrap.token, os.environ.get("OPENAI_API_KEY", "")))
    workspace = (
        workspace or Path(os.environ.get("SUPERTAG_WORKSPACE_DIRECTORY") or Path.cwd())
    ).resolve()
    options = (
        ("grpc.enable_http_proxy", 0),
        ("grpc.max_receive_message_length", MAX_MESSAGE_BYTES),
        ("grpc.max_send_message_length", MAX_MESSAGE_BYTES),
    )
    async with grpc.aio.insecure_channel(target, options=options) as channel:
        harness = _Harness(channel, pb, bootstrap.token)
        attached = await harness.call(harness.attach, pb.HarnessAttachRequest())
        try:
            result = await asyncio.wait_for(
                _execute(
                    harness, attached, workspace, model, max_turns, redactor, runner, model_provider
                ),
                timeout_seconds,
            )
        except (TimeoutError, asyncio.TimeoutError):
            result = pb.HarnessCompleteRequest(result="OpenAI Agents execution timed out")
        except _AdapterFailure as error:
            result = pb.HarnessCompleteRequest(result=str(error))
        except grpc.aio.AioRpcError:
            raise
        except Exception:
            result = pb.HarnessCompleteRequest(result="OpenAI Agents execution failed")
        await harness.call(harness.complete, result)


def main(*, runner: OpenAIAgentsRunner | None = None, model_provider: Any = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=os.environ.get("SUPERTAG_OPENAI_MODEL"))
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=os.environ.get("SUPERTAG_WORKER_TIMEOUT_SECONDS", "300"),
    )
    parser.add_argument(
        "--max-turns", type=int, default=os.environ.get("SUPERTAG_OPENAI_MAX_TURNS", "10")
    )
    arguments = parser.parse_args()
    bootstrap = sys.stdin.buffer.read(MAX_BOOTSTRAP_BYTES + 1)

    async def serve() -> None:
        loop = asyncio.get_running_loop()
        task = asyncio.current_task()
        assert task is not None
        for signum in (signal.SIGINT, signal.SIGTERM):
            with suppress(NotImplementedError):
                loop.add_signal_handler(signum, task.cancel)
        try:
            await run_adapter(
                bootstrap,
                model=arguments.model,
                timeout_seconds=arguments.timeout_seconds,
                max_turns=arguments.max_turns,
                runner=runner,
                model_provider=model_provider,
            )
        finally:
            for signum in (signal.SIGINT, signal.SIGTERM):
                with suppress(NotImplementedError):
                    loop.remove_signal_handler(signum)

    try:
        asyncio.run(serve())
    except asyncio.CancelledError:
        raise SystemExit(130) from None
    except ImportError:
        raise SystemExit(
            "Install the SuperTag agents and runtime extras to run this adapter."
        ) from None
    except Exception:
        raise SystemExit(
            "OpenAI Agents adapter could not attach or complete the Attempt."
        ) from None


if __name__ == "__main__":
    main()
