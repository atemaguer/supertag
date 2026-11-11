"""Live Python Codex SDK adapter supervised by the Rust interoperability Worker."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import re
import sys

import grpc
from openai_codex import ApprovalMode, AsyncCodex, CodexConfig, Sandbox
from openai_codex.types import ReasoningEffort

sys.path.insert(0, str(Path(__file__).resolve().parent / "generated"))
import harness_pb2 as wire
import harness_pb2_grpc as services


MAX_PAYLOAD_BYTES = 128 * 1024


class AdapterFailure(RuntimeError):
    """A local failure whose diagnostic never contains credentials or RPC metadata."""


def value(item):
    return getattr(item, "value", item)


def clipped(text: str | None, limit: int) -> str:
    return (text or "").encode("utf-8")[:limit].decode("utf-8", errors="ignore")


def payload_json(payload: dict) -> str:
    payload = dict(payload)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    # JSON escaping can expand command output even after its UTF-8 bytes were bounded.
    while len(encoded.encode("utf-8")) > MAX_PAYLOAD_BYTES and payload.get("output"):
        payload["output"] = clipped(payload["output"], len(payload["output"].encode("utf-8")) // 2)
        payload["truncated"] = True
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise AdapterFailure("Native event exceeds the bounded payload size")
    return encoded


class CodexAdapter:
    def __init__(self, bootstrap: dict) -> None:
        self.bootstrap = bootstrap
        self.timeout = int(bootstrap.get("timeoutSeconds", 600))
        if self.timeout < 1 or self.timeout > 3600:
            raise AdapterFailure("Execution timeout must be between 1 and 3600 seconds")
        self.identity = wire.Identity(
            execution_id=bootstrap["executionId"], generation=bootstrap["generation"]
        )
        # Python's native Unix-socket authority is rejected by tonic's HTTP/2 parser.
        self.channel = grpc.aio.insecure_channel(
            bootstrap["target"], options=(("grpc.default_authority", "localhost"),)
        )
        self.stub = services.HarnessBridgeStub(self.channel)
        self.metadata = (("authorization", f"Bearer {bootstrap['token']}"),)
        self.control = self.stub.Attach(metadata=self.metadata, timeout=self.timeout)
        self.events = None
        self.offer = None
        self.client = None
        self.turn = None
        self.native_session_id = ""
        self.sequence = 0
        self.final_response = ""
        self.terminal = False
        self.welcomed = False
        self.cancelled = False
        self.quiesced = False
        self.closed = False
        self.received_outcome = False
        self.stopping = asyncio.Event()
        self.write_lock = asyncio.Lock()
        self.close_lock = asyncio.Lock()
        self.queue = asyncio.Queue(maxsize=16)
        self.acknowledgements = asyncio.Queue(maxsize=1)
        self.failure = asyncio.get_running_loop().create_future()
        self.execution_task = None
        self.publisher_task = None
        self.ack_task = None
        self.control_task = None

    async def send(self, **body) -> None:
        async with self.write_lock:
            await self.control.write(wire.AdapterFrame(identity=self.identity, **body))

    def supervise(self, coroutine):
        task = asyncio.create_task(coroutine)

        def finished(completed):
            if completed.cancelled():
                return
            error = completed.exception()
            if error is not None and not self.failure.done():
                self.failure.set_result(error)

        task.add_done_callback(finished)
        return task

    async def emit(self, kind: str, *, text: str = "", payload: dict | None = None) -> None:
        if self.stopping.is_set():
            return
        # The control reader must also unblock a native reader waiting on a full queue.
        event = (kind, clipped(text, 32 * 1024), payload_json(payload or {}))
        queued = asyncio.create_task(self.queue.put(event))
        stopped = asyncio.create_task(self.stopping.wait())
        try:
            await asyncio.wait((queued, stopped), return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in (queued, stopped):
                if not task.done():
                    task.cancel()
            await asyncio.gather(queued, stopped, return_exceptions=True)

    async def read_acknowledgements(self) -> None:
        async for acknowledgement in self.events:
            await self.acknowledgements.put(acknowledgement)
        if not self.closed:
            raise AdapterFailure("Event stream ended before shutdown")

    async def publish(self) -> None:
        while (event := await self.queue.get()) is not None:
            kind, text, payload = event
            self.sequence += 1
            await self.events.write(
                wire.HarnessEvent(
                    identity=self.identity,
                    sequence=self.sequence,
                    text=text,
                    kind=kind,
                    payload_json=payload,
                )
            )
            acknowledgement = await self.acknowledgements.get()
            if acknowledgement.through_sequence != self.sequence:
                raise AdapterFailure("Unexpected event acknowledgement sequence")

    async def native_event(self, event) -> None:
        if event.method == "item/agentMessage/delta":
            await self.emit(
                "assistant", text=event.payload.delta, payload={"eventType": "delta"}
            )
        elif event.method == "item/completed":
            item = getattr(event.payload.item, "root", event.payload.item)
            if item.type == "agentMessage":
                self.final_response = item.text
                await self.emit(
                    "assistant",
                    payload={
                        "eventType": "completed",
                        "id": item.id,
                        "phase": value(item.phase),
                    },
                )
            elif item.type == "commandExecution":
                await self.emit(
                    "command",
                    payload={
                        "id": item.id,
                        "command": clipped(item.command, 16 * 1024),
                        "cwd": clipped(str(item.cwd), 4 * 1024),
                        "status": value(item.status),
                        "exitCode": item.exit_code,
                        "output": clipped(item.aggregated_output, 96 * 1024),
                    },
                )
            elif item.type == "fileChange":
                changes = []
                for change in item.changes[:64]:
                    kind = getattr(change.kind, "root", change.kind)
                    changes.append(
                        {"path": clipped(change.path, 1024), "kind": getattr(kind, "type", "")}
                    )
                await self.emit(
                    "file_change",
                    payload={
                        "id": item.id,
                        "status": value(item.status),
                        "changes": changes,
                        "truncated": len(item.changes) > len(changes),
                    },
                )
        elif event.method == "turn/completed":
            self.terminal = True
            status = value(event.payload.turn.status)
            await self.emit("status", payload={"eventType": "turn.completed", "status": status})
            if status != "completed" and not self.stopping.is_set():
                raise AdapterFailure(f"Codex turn ended with status {status}")
        # Reasoning notifications and unrestricted native payloads never cross this boundary.

    async def close_client(self) -> None:
        async with self.close_lock:
            if self.client is not None:
                client, self.client = self.client, None
                await client.close()

    async def git_commit(self) -> str:
        process = await asyncio.create_subprocess_exec(
            "git", "rev-parse", "HEAD", cwd=self.offer.workspace,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=5)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        commit = stdout.decode().strip()
        if process.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40,64}", commit):
            raise AdapterFailure("Workspace has no reviewable Git commit")
        return commit

    async def execute(self) -> None:
        workspace = str(Path(self.offer.workspace).resolve(strict=True))
        self.events = self.stub.PublishEvents(metadata=self.metadata, timeout=self.timeout)
        self.ack_task = self.supervise(self.read_acknowledgements())
        self.publisher_task = self.supervise(self.publish())
        self.client = AsyncCodex(
            CodexConfig(codex_bin=self.bootstrap["codexPath"], cwd=workspace)
        )
        try:
            await self.client.__aenter__()
            if self.stopping.is_set():
                return
            thread = await self.client.thread_start(
                cwd=workspace,
                model=self.offer.model,
                approval_mode=ApprovalMode.deny_all,
                sandbox=Sandbox.workspace_write,
                config={
                    "model_reasoning_effort": self.offer.reasoning_effort,
                    "web_search": "disabled",
                    "agents": {"enabled": False},
                    "features": {
                        "multi_agent": False,
                        "multi_agent_v2": False,
                        "enable_fanout": False,
                    },
                    "shell_environment_policy": {
                        "inherit": "none",
                        "set": {key: os.environ[key] for key in ("HOME", "PATH") if key in os.environ},
                    },
                    "sandbox_workspace_write": {"writable_roots": [str(Path(workspace) / ".git")]},
                },
                developer_instructions=(
                    "Complete the requested work only in the supplied workspace. "
                    "Run the project's checks and deliver a Git commit. Do not inspect credentials, "
                    "use web search, or delegate to other agents."
                ),
            )
            self.native_session_id = thread.id
            if self.stopping.is_set():
                return
            await self.emit(
                "status",
                payload={"eventType": "thread.started", "nativeSessionId": thread.id,
                         "model": self.offer.model, "reasoningEffort": self.offer.reasoning_effort},
            )
            if self.stopping.is_set():
                return
            # Inherit the thread's sandbox: a turn preset would erase its explicit .git root.
            self.turn = await thread.turn(
                self.offer.prompt, model=self.offer.model,
                effort=ReasoningEffort.medium, approval_mode=ApprovalMode.deny_all,
            )
            if self.stopping.is_set():
                await self.turn.interrupt()
            stream = self.turn.stream()
            try:
                async for event in stream:
                    await self.native_event(event)
            finally:
                await stream.aclose()
            if not self.terminal:
                raise AdapterFailure("Native stream ended without a terminal turn")
            if self.stopping.is_set():
                return
            await self.queue.put(None)
            await self.publisher_task
            if not self.final_response:
                raise AdapterFailure("Codex completed without an assistant result")
            commit = await self.git_commit()
            if self.stopping.is_set():
                return
            await self.send(
                outcome=wire.Outcome(
                    id="final", text=clipped(self.final_response, MAX_PAYLOAD_BYTES),
                    through_sequence=self.sequence, commit=commit,
                    native_session_id=self.native_session_id,
                )
            )
        except asyncio.CancelledError:
            if not self.stopping.is_set():
                raise
        finally:
            await self.close_client()

    async def stop_execution(self) -> None:
        self.stopping.set()
        if self.publisher_task is not None and not self.publisher_task.done():
            self.publisher_task.cancel()
            await asyncio.gather(self.publisher_task, return_exceptions=True)
        try:
            if (self.turn is not None and not self.terminal and self.client is not None
                    and self.execution_task is not None and not self.execution_task.done()):
                await asyncio.wait_for(self.turn.interrupt(), timeout=10)
            if self.execution_task is not None:
                await asyncio.wait_for(asyncio.shield(self.execution_task), timeout=20)
        except BaseException:
            # Native interruption must finish before reporting quiescence. On failure the
            # adapter fails; the Rust Worker owns the process-group kill fallback.
            await self.close_client()
            if self.execution_task is not None and not self.execution_task.done():
                self.execution_task.cancel()
                await asyncio.gather(self.execution_task, return_exceptions=True)
            raise

    async def read_control(self) -> None:
        async for frame in self.control:
            if frame.identity != self.identity:
                raise AdapterFailure("Worker sent a different execution identity")
            kind = frame.WhichOneof("body")
            if kind == "welcome":
                if self.welcomed or frame.welcome.protocol_version != 1:
                    raise AdapterFailure("Unexpected protocol negotiation")
                self.welcomed = True
            elif kind == "offer":
                if not self.welcomed or self.offer is not None:
                    raise AdapterFailure("Offer arrived outside negotiation")
                if frame.offer.model != "gpt-6.1-sol" or frame.offer.reasoning_effort != "medium":
                    raise AdapterFailure("Live spike requires gpt-6.1-sol at medium effort")
                if not Path(frame.offer.workspace).is_dir():
                    raise AdapterFailure("Worker offered a missing workspace")
                self.offer = frame.offer
                await self.send(ready=wire.Ready())
            elif kind == "begin":
                if self.offer is None or self.execution_task is not None:
                    raise AdapterFailure("Begin arrived without an offer or was duplicated")
                await self.send(started=wire.Started())
                self.execution_task = self.supervise(self.execute())
            elif kind == "receipt":
                if frame.receipt.outcome_id != "final" or (
                    not frame.receipt.accepted and not self.cancelled
                ):
                    raise AdapterFailure("Worker rejected the native outcome")
                self.received_outcome = True
            elif kind in ("cancel", "quiesce"):
                self.cancelled = self.cancelled or kind == "cancel"
                await self.stop_execution()
                if not self.quiesced:
                    self.quiesced = True
                    await self.send(quiesced=wire.Quiesced(last_sequence=self.sequence))
            elif kind == "close":
                if not self.quiesced or self.closed:
                    raise AdapterFailure("Worker closed before quiescence")
                if not self.cancelled and not self.received_outcome:
                    raise AdapterFailure("Worker closed without an outcome receipt")
                await self.send(closed=wire.Closed())
                self.closed = True
                await self.control.done_writing()
            else:
                raise AdapterFailure("Worker sent an unknown control operation")
        if not self.closed:
            raise AdapterFailure("Control stream ended before shutdown")

    async def run(self) -> None:
        try:
            await self.send(hello=wire.Hello(protocol_version=1, language="python"))
            self.control_task = asyncio.create_task(self.read_control())
            done, _ = await asyncio.wait(
                (self.control_task, self.failure), return_when=asyncio.FIRST_COMPLETED
            )
            if self.failure in done:
                raise self.failure.result()
            await self.control_task
        finally:
            try:
                await self.stop_execution()
            finally:
                tasks = (self.control_task, self.publisher_task, self.ack_task)
                for task in tasks:
                    if task is not None and not task.done():
                        task.cancel()
                await asyncio.gather(*(t for t in tasks if t is not None), return_exceptions=True)
                self.failure.cancel()
                self.control.cancel()
                if self.events is not None:
                    self.events.cancel()
                await self.channel.close()


async def main() -> None:
    bootstrap = json.loads(sys.stdin.readline())
    # CodexConfig.env merges inherited variables, so strip the adapter environment too.
    native_environment = {key: os.environ[key] for key in ("HOME", "PATH", "CODEX_HOME") if key in os.environ}
    if not native_environment.get("CODEX_HOME"):
        raise AdapterFailure("An isolated CODEX_HOME is required")
    os.environ.clear()
    os.environ.update(native_environment)
    adapter = CodexAdapter(bootstrap)
    async with asyncio.timeout(adapter.timeout):
        await adapter.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        detail = str(error) if isinstance(error, AdapterFailure) else type(error).__name__
        print(f"Live Python adapter failed: {detail}", file=sys.stderr)
        raise SystemExit(1) from None
