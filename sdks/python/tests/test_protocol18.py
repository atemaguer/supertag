from __future__ import annotations

import asyncio
import json

import pytest

import supertag
import supertag.runtime as runtime
from supertag import DurableLocalWorklet, FileAttemptJournal, LocalWorklet, WorkletConnection

from .helpers import task_attempt
from .test_durable import Worker


def test_protocol18_public_contract():
    assert supertag.WORKLET_PROTOCOL_VERSION == 18
    assert DurableLocalWorklet.durable_protocol_version == 18
    assert "RuntimeInputPipeline" not in supertag.__all__
    assert not hasattr(supertag, "RuntimeInputPipeline")
    assert "RuntimeInputPipeline" not in runtime.__all__


class Socket:
    def __init__(self, messages):
        self.messages = messages
        self.sent = []

    async def send(self, message):
        self.sent.append(json.loads(message))

    async def __aiter__(self):
        for message in self.messages:
            yield json.dumps(message)
            await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_only_current_credential_handshake(tmp_path):
    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (Worker(),)), FileAttemptJournal(tmp_path / "journal")
    )
    try:
        socket = Socket([{"type": "ready", "protocolVersion": 18}])
        connection = WorkletConnection("https://control.example", "host-secret", durable)
        await connection._session(socket)
        assert socket.sent == [
            {
                "type": "hello",
                "protocolVersions": [18],
                "credential": "host-secret",
                "worklet": {
                    **supertag.models.wire(await durable.describe()),
                    "durableProtocolVersion": 1,
                },
            }
        ]
    finally:
        await durable.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("version", [12, 13, 14, 15, 16, 17, 19, True, 18.0])
async def test_rejects_server_version_without_downgrading(tmp_path, version):
    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (Worker(),)), FileAttemptJournal(tmp_path / "journal")
    )
    try:
        connection = WorkletConnection("https://control.example", "host-secret", durable)
        with pytest.raises(RuntimeError, match="unsupported protocol"):
            await connection._session(Socket([{"type": "ready", "protocolVersion": version}]))
        assert not connection.connected
    finally:
        await durable.shutdown()


@pytest.mark.asyncio
async def test_placement_holds_capacity_and_pins_acceptance(tmp_path):
    first, second = Worker("first"), Worker("second")
    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (first, second)), FileAttemptJournal(tmp_path / "journal")
    )
    spec = task_attempt()
    options = {"allowedWorkerHostIds": ["host"], "compatibleProfile": spec["workerProfile"]}
    try:
        one = await durable.select_placement({}, spec["contextPlan"], options)
        two = await durable.select_placement({}, spec["contextPlan"], options)
        assert one["workerId"] != two["workerId"]
        assert await durable.select_placement({}, spec["contextPlan"], options) is None
        await durable.release_placement(one)
        spec["placement"] = {**two, "allowedWorkerHostIds": ["host"]}
        receipt = await durable.accept(spec)
        assert receipt["workerId"] == two["workerId"]
        assert await durable.accept(spec) == receipt
        with pytest.raises(ValueError, match="reservation"):
            await durable.accept({**spec, "attemptId": "reused"})
        first.release.set()
        second.release.set()
        assert [item async for item in durable.events(spec["attemptId"])][-1]["event"][
            "type"
        ] == "execution.completed"
    finally:
        first.release.set()
        second.release.set()
        await durable.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field,value",
    [
        ("workerId", "other"),
        ("workletId", "other"),
        ("workerHostId", "other"),
        ("allowedWorkerHostIds", []),
    ],
)
async def test_admission_rejects_mismatched_placement(tmp_path, field, value):
    worker = Worker()
    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (worker,)), FileAttemptJournal(tmp_path / "journal")
    )
    spec = task_attempt()
    try:
        placement = await durable.select_placement({}, spec["contextPlan"], {})
        spec["placement"] = {**placement, "allowedWorkerHostIds": ["host"], field: value}
        with pytest.raises(ValueError, match="reservation|not bound"):
            await durable.accept(spec)
        assert worker.starts == 0
        assert await durable.inspect(spec["attemptId"]) is None
    finally:
        await durable.shutdown()


@pytest.mark.asyncio
async def test_expired_placement_cannot_start_and_frees_capacity(tmp_path, monkeypatch):
    import supertag.durable as module

    now = module.time.time()
    monkeypatch.setattr(module.time, "time", lambda: now)
    worker = Worker()
    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (worker,)), FileAttemptJournal(tmp_path / "journal")
    )
    spec = task_attempt()
    try:
        placement = await durable.select_placement({}, spec["contextPlan"], {})
        spec["placement"] = {**placement, "allowedWorkerHostIds": ["host"]}
        now += 31
        with pytest.raises(ValueError, match="expired"):
            await durable.accept(spec)
        assert worker.starts == 0
        assert await durable.select_placement({}, spec["contextPlan"], {}) is not None
    finally:
        await durable.shutdown()


@pytest.mark.asyncio
async def test_placement_filters_host_profile_and_capabilities(tmp_path):
    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (Worker(),)), FileAttemptJournal(tmp_path / "journal")
    )
    plan = task_attempt()["contextPlan"]
    try:
        for options in [
            {"allowedWorkerHostIds": []},
            {"requiresCoordination": True},
            {"requiresSurfaceCoordination": True},
            {"compatibleProfile": {"id": "other", "revision": "1"}},
        ]:
            assert await durable.select_placement({}, plan, options) is None
        assert (
            await durable.select_placement(
                {"requires": [{"id": "missing", "version": 1}]}, plan, {}
            )
            is None
        )
        assert await durable.select_placement({}, plan, {}) is not None
    finally:
        await durable.shutdown()


@pytest.mark.asyncio
async def test_durable_wire_replies_and_malformed_admission(tmp_path):
    worker = Worker()
    worker.release.set()
    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (worker,)), FileAttemptJournal(tmp_path / "journal")
    )
    connection = WorkletConnection("https://control.example", "host-secret", durable)
    socket = Socket([])
    spec = task_attempt()

    async def request(operation, **payload):
        await connection._durable_request(
            socket,
            {
                "type": "durable_request",
                "requestId": operation,
                "operation": operation,
                **payload,
            },
        )
        return socket.sent[-1]

    try:
        placement = await request(
            "select_placement", requirements={}, contextPlan=spec["contextPlan"], options={}
        )
        assert placement["resultKind"] == "placement"
        assert await request(
            "select_placement", requirements={}, contextPlan=spec["contextPlan"], options={}
        ) == {
            "type": "durable_reply",
            "requestId": "select_placement",
            "resultKind": "no_placement",
        }
        assert await request("release_placement", placement=placement["result"]) == {
            "type": "durable_reply",
            "requestId": "release_placement",
            "resultKind": "placement_release",
            "result": {"released": True},
        }
        invalid = {**spec, "contextPlan": {"version": 3, "sets": []}}
        assert "version 7" in (await request("accept", spec=invalid))["error"]
        assert (await request("accept", spec=spec))["result"]["status"] == "accepted"
        assert await request("events", attemptId=spec["attemptId"], afterSequence=0) == {
            "type": "durable_end",
            "requestId": "events",
        }
        events = [message["item"] for message in socket.sent if message["type"] == "durable_event"]
        assert [item["sequence"] for item in events] == [1, 2, 3]
        assert events[-1]["event"]["type"] == "execution.completed"
    finally:
        await durable.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        {"type": "job", "jobId": "legacy", "spec": task_attempt()},
        {"type": "cancel", "jobId": "legacy"},
    ],
)
async def test_protocol18_has_no_legacy_job_dispatch(tmp_path, message):
    worker = Worker()
    durable = DurableLocalWorklet(
        LocalWorklet("worklet", "host", (worker,)), FileAttemptJournal(tmp_path / "journal")
    )
    try:
        connection = WorkletConnection("https://control.example", "host-secret", durable)
        with pytest.raises(RuntimeError, match="unsupported message"):
            await connection._session(Socket([{"type": "ready", "protocolVersion": 18}, message]))
        assert worker.starts == 0
    finally:
        await durable.shutdown()
