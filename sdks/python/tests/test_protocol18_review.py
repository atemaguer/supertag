"""Regression coverage for protocol 18 review findings."""

import asyncio
import base64
import importlib.util
import json
from pathlib import Path
from urllib.parse import quote

import pytest
from websockets.asyncio.server import serve

from supertag import DurableLocalWorklet, FileAttemptJournal, LocalWorklet, WorkletConnection

from .helpers import task_attempt
from .test_durable import Worker
from .test_protocol18 import Socket

ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
async def test_redirect_never_sends_credential(tmp_path, status):
    received = []

    async def target(socket):
        received.append(await socket.recv())
        await socket.send(json.dumps({"type": "ready", "protocolVersion": 18}))
        await socket.wait_closed()

    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (Worker(),)), FileAttemptJournal(tmp_path / "journal")
    )
    async with serve(target, "127.0.0.1", 0) as destination:
        port = destination.sockets[0].getsockname()[1]

        def redirect(connection, request):
            response = connection.respond(status, "redirect")
            response.headers["Location"] = f"ws://127.0.0.1:{port}/worklets"
            return response

        async with serve(target, "127.0.0.1", 0, process_request=redirect) as source:
            connection = WorkletConnection(
                f"http://127.0.0.1:{source.sockets[0].getsockname()[1]}", "secret", durable
            )
            try:
                with pytest.raises((RuntimeError, TimeoutError)):
                    await connection.start(timeout=0.2)
                assert received == []
            finally:
                await connection.stop()
                await durable.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("hosts", ["ghost", ["host", 1], {"host": True}, None])
async def test_host_filter_requires_string_list(tmp_path, hosts):
    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (Worker(),)), FileAttemptJournal(tmp_path / "journal")
    )
    try:
        assert (
            await durable.select_placement(
                {}, task_attempt()["contextPlan"], {"allowedWorkerHostIds": hosts}
            )
            is None
        )
    finally:
        await durable.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("hosts", ["ghost", ["host", 1], {"host": True}, None])
async def test_host_binding_requires_string_list(tmp_path, hosts):
    worker = Worker()
    worker.release.set()
    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (worker,)), FileAttemptJournal(tmp_path / "journal")
    )
    spec = task_attempt()
    try:
        placement = await durable.select_placement({}, spec["contextPlan"], {})
        spec["placement"] = {**placement, "allowedWorkerHostIds": hosts}
        with pytest.raises(ValueError, match="not bound"):
            await durable.accept(spec)
        assert await durable.inspect(spec["attemptId"]) is None
    finally:
        await durable.shutdown()


@pytest.mark.asyncio
async def test_completed_placement_request_cannot_allocate_again(tmp_path):
    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (Worker("one"), Worker("two"))),
        FileAttemptJournal(tmp_path / "journal"),
    )
    request = {
        "type": "durable_request",
        "requestId": "same",
        "operation": "select_placement",
        "requirements": {},
        "contextPlan": task_attempt()["contextPlan"],
        "options": {},
    }

    class ReplaySocket(Socket):
        async def __aiter__(self):
            yield json.dumps({"type": "ready", "protocolVersion": 18})
            yield json.dumps(request)
            while len(self.sent) < 2 or connection._subscriptions:
                await asyncio.sleep(0)
            yield json.dumps(request)
            await asyncio.sleep(0)

    try:
        connection = WorkletConnection("https://control.example", "secret", durable)
        with pytest.raises(RuntimeError, match="Duplicate"):
            await connection._session(ReplaySocket([]))
        assert len(durable._placements) == 1
    finally:
        await durable.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["accept", "events"])
async def test_durable_errors_redact_secrets(tmp_path, monkeypatch, operation):
    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (Worker(),)), FileAttemptJournal(tmp_path / "journal")
    )
    monkeypatch.setenv("PROVIDER_API_KEY", "environment-secret")
    encoded_secret = "encoded/secret+value"

    async def fail(*args):
        raise ValueError(
            " ".join(
                [
                    "environment-secret spec-secret host-secret",
                    quote(encoded_secret, safe=""),
                    base64.b64encode(encoded_secret.encode()).decode(),
                ]
            )
        )

    async def fail_events(*args):
        await fail()
        yield None

    monkeypatch.setattr(durable, "accept", fail)
    monkeypatch.setattr(durable, "events", fail_events)
    socket = Socket([])
    try:
        connection = WorkletConnection("https://control.example", "host-secret", durable)
        await connection._durable_request(
            socket,
            {
                "requestId": "error",
                "operation": operation,
                "attemptId": "a",
                "spec": {"nested": {"token": "spec-secret", "apiKey": encoded_secret}},
            },
        )
        assert socket.sent[-1]["error"] == " ".join(["[REDACTED]"] * 5)
    finally:
        await durable.shutdown()


@pytest.mark.parametrize("example", ["codex_worker", "openai_agents_worker"])
@pytest.mark.parametrize("identity", ["../escape", "/absolute", "a/b", "a\\b", "..", ".", ""])
async def test_example_rejects_unsafe_journal_identity(example, identity, monkeypatch, tmp_path):
    module_spec = importlib.util.spec_from_file_location(
        example, ROOT / "sdks/python/examples" / f"{example}.py"
    )
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    monkeypatch.setenv("SUPERTAG_WORKLET_ID", identity)
    monkeypatch.setenv("SUPERTAG_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("SUPERTAG_WORKLET_TOKEN", "token")

    # Keep the unfixed implementation from writing to an unsafe path in the fail-before run.
    monkeypatch.setattr(module, "FileAttemptJournal", lambda directory: directory)
    monkeypatch.setattr(module, "DurableLocalWorklet", lambda worklet, journal: worklet)

    def connect(*args, **kwargs):
        pytest.fail("Unsafe identity reached connection construction")

    monkeypatch.setattr(module, "WorkletConnection", connect)
    with pytest.raises(ValueError, match="SUPERTAG_WORKLET_ID"):
        await module.run()


@pytest.mark.parametrize("example", ["codex_worker", "openai_agents_worker"])
async def test_example_journal_uses_private_state_directory(example, monkeypatch, tmp_path):
    module_spec = importlib.util.spec_from_file_location(
        example, ROOT / "sdks/python/examples" / f"{example}.py"
    )
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    state = tmp_path / "state"
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("SUPERTAG_WORKLET_ID", "safe-worker_1")
    monkeypatch.setenv("SUPERTAG_STATE_DIR", str(state))
    monkeypatch.setenv("SUPERTAG_WORKLET_TOKEN", "token")
    monkeypatch.setattr(asyncio.get_running_loop(), "add_signal_handler", lambda *args: None)

    class Connection:
        def __init__(self, url, credential, worklet):
            self.worklet = worklet

        async def run(self):
            assert self.worklet._journal.directory == state / "python-worklets" / "safe-worker_1"
            assert state.stat().st_mode & 0o777 == 0o700
            assert (state / "python-worklets").stat().st_mode & 0o777 == 0o700

        async def stop(self):
            pass

    monkeypatch.setattr(module, "WorkletConnection", Connection)
    await module.run()


@pytest.mark.asyncio
async def test_durable_error_scrubs_url_credentials_and_basic_auth(tmp_path, monkeypatch):
    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (Worker(),)), FileAttemptJournal(tmp_path / "journal")
    )

    async def fail(*args):
        raise ValueError(
            "https://user:unknown-password@example.test/?token=unknown-token Basic YWJjOmRlZg=="
        )

    monkeypatch.setattr(durable, "inspect", fail)
    socket = Socket([])
    try:
        connection = WorkletConnection("https://control.example", "host-secret", durable)
        await connection._durable_request(
            socket, {"requestId": "error", "operation": "inspect", "attemptId": "a"}
        )
        assert socket.sent[-1]["error"] == (
            "https://[REDACTED]@example.test/?token=[REDACTED] Basic [REDACTED]"
        )
    finally:
        await durable.shutdown()
