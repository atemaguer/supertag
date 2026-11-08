from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

import pytest
from websockets.asyncio.server import ServerConnection, serve

from supertag import (
    CancellationToken,
    Capability,
    ContextTypeSupport,
    DurableLocalWorklet,
    FileAttemptJournal,
    LocalWorklet,
    WorkerDescriptor,
    WorkerProfileCapabilities,
    WorkerProfileRef,
    WorkletConnection,
)
from supertag.models import task_event


class StaticWorker:
    async def describe(self) -> WorkerDescriptor:
        return WorkerDescriptor(
            profile_capabilities=tuple(
                WorkerProfileCapabilities(
                    profile=profile,
                    capabilities=(Capability("supertag.task-attempt.events", 1),),
                    context_types=(ContextTypeSupport("supertag/skill", (1,)),),
                )
                for profile in (WorkerProfileRef("static", "1"),)
            ),
            id="python-static",
            type="static",
            profiles=(WorkerProfileRef("static", "1"),),
            capabilities=(Capability("supertag.task-attempt.events", 1),),
            context_types=(ContextTypeSupport("supertag/skill", (1,)),),
        )

    async def execute(
        self, attempt: dict[str, Any], cancellation: CancellationToken
    ) -> AsyncIterator[dict[str, Any]]:
        cancellation.raise_if_cancelled()
        yield task_event(attempt, "execution.started", workerId="python-static")
        yield task_event(
            attempt,
            "output.message",
            message={"role": "teammate", "text": "Python transport works."},
        )
        yield task_event(attempt, "execution.completed")


@pytest.mark.asyncio
async def test_worklet_connection_stops_after_permanent_registration_failure(
    durable_worklet,
) -> None:
    attempts = 0

    async def api_server(socket: ServerConnection) -> None:
        nonlocal attempts
        attempts += 1
        await socket.recv()
        await socket.close(4003, "Authentication failed")

    async with serve(api_server, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        worklet = durable_worklet
        connection = WorkletConnection(
            f"ws://127.0.0.1:{port}",
            "wrong-secret",
            worklet,
            reconnect_min_seconds=0.01,
        )
        with pytest.raises(RuntimeError, match="Authentication failed"):
            await connection.start(timeout=1)
        await asyncio.sleep(0.05)

    assert attempts == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("close_code", (4007, 4008))
async def test_worklet_connection_stops_after_host_authority_is_fenced(
    close_code: int, durable_worklet
) -> None:
    attempts = 0

    async def api_server(socket: ServerConnection) -> None:
        nonlocal attempts
        attempts += 1
        await socket.recv()
        await socket.send(
            json.dumps(
                {
                    "type": "ready",
                    "protocolVersion": 18,
                    "heartbeatIntervalMs": 1000,
                    "connectionGeneration": 2,
                }
            )
        )
        await socket.close(close_code, "Worker Host authority fenced")

    async with serve(api_server, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        worklet = durable_worklet
        connection = WorkletConnection(
            f"ws://127.0.0.1:{port}",
            "host-credential",
            worklet,
            reconnect_min_seconds=0.01,
        )
        await connection.start(timeout=1)
        await asyncio.sleep(0.05)
        await connection.stop()

    assert attempts == 1


def test_worklet_connection_requires_durable_execution() -> None:
    worklet = LocalWorklet("python-worklet", "python-host", (StaticWorker(),))
    with pytest.raises(ValueError, match="DurableLocalWorklet"):
        WorkletConnection("ws://127.0.0.1:1", "secret", worklet)


async def test_worklet_connection_requires_encrypted_remote_transport(durable_worklet) -> None:
    worklet = durable_worklet
    assert WorkletConnection("https://control.example.com", "secret", worklet)
    assert WorkletConnection("wss://control.example.com/worklets", "secret", worklet)
    with pytest.raises(ValueError, match="HTTPS or WSS"):
        WorkletConnection("http://control.example.com", "secret", worklet)
    with pytest.raises(ValueError, match="HTTPS or WSS"):
        WorkletConnection("ws://control.example.com/worklets", "secret", worklet)
    with pytest.raises(ValueError, match="must not contain credentials"):
        WorkletConnection("https://operator:secret@control.example.com", "secret", worklet)
    with pytest.raises(ValueError, match="query parameters"):
        WorkletConnection("https://control.example.com?credential=secret", "secret", worklet)


@pytest.mark.asyncio
async def test_python_durable_transport_explicitly_rejects_native_control(tmp_path) -> None:
    from supertag import DurableLocalWorklet, FileAttemptJournal

    responses: list[dict[str, Any]] = []
    finished = asyncio.Event()

    async def api_server(socket: ServerConnection) -> None:
        hello = json.loads(await socket.recv())
        assert hello["protocolVersions"] == [18]
        assert hello["worklet"]["durableProtocolVersion"] == 1
        assert "controlProtocolVersion" not in hello["worklet"]
        await socket.send(
            json.dumps({"type": "ready", "protocolVersion": 18, "heartbeatIntervalMs": 1000})
        )
        await socket.send(
            json.dumps(
                {
                    "type": "durable_request",
                    "requestId": "capabilities",
                    "operation": "control_capabilities",
                    "taskId": "task",
                    "attemptId": "attempt",
                }
            )
        )
        responses.append(json.loads(await socket.recv()))
        await socket.send(
            json.dumps(
                {
                    "type": "durable_request",
                    "requestId": "control",
                    "operation": "control",
                    "attemptId": "attempt",
                    "command": {
                        "id": "input",
                        "taskId": "task",
                        "attemptId": "attempt",
                        "type": "input",
                        "text": "Do something",
                    },
                }
            )
        )
        responses.append(json.loads(await socket.recv()))
        finished.set()
        await asyncio.sleep(0.05)

    worklet = LocalWorklet("python-control", "python-host", (StaticWorker(),))
    durable = DurableLocalWorklet(worklet, FileAttemptJournal(tmp_path / "journal"))
    assert durable.durable_protocol_version == 18
    try:
        async with serve(api_server, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            connection = WorkletConnection(f"ws://127.0.0.1:{port}", "host-secret", durable)
            await connection.start()
            await asyncio.wait_for(finished.wait(), 3)
            await connection.stop()
        assert responses[0].get("result") is None
        assert responses[1]["result"]["status"] == "rejected"
        assert responses[1]["result"]["reason"] == "Python Worklet control unsupported"
    finally:
        await durable.close()


@pytest.fixture
async def durable_worklet(tmp_path):
    durable = DurableLocalWorklet(
        LocalWorklet("python-worklet", "python-host", (StaticWorker(),)),
        FileAttemptJournal(tmp_path / "journal"),
    )
    try:
        yield durable
    finally:
        await durable.shutdown()
