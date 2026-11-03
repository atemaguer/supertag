from __future__ import annotations

from pathlib import Path

import pytest

from supertag.continuity import (
    FileSessionStateStore,
    InMemorySessionStateStore,
    resolve_harness_continuity,
)
from supertag.models import (
    HarnessContinuity,
    HistoryInput,
    ResourceRef,
    SessionStateRef,
    StoredHarnessSessionState,
)


def _ref(identifier: str = "session_state-1") -> SessionStateRef:
    return SessionStateRef(
        id=identifier,
        uri=f"supertag://session_states/{identifier}",
        format="codex-thread-v1",
    )


def _session_state() -> StoredHarnessSessionState:
    return StoredHarnessSessionState(_ref(), "codex", {"threadId": "thread-1"})


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["memory", "file"])
async def test_session_state_stores_validate_match_save_load_delete(
    kind: str, tmp_path: Path
) -> None:
    store = InMemorySessionStateStore() if kind == "memory" else FileSessionStateStore(tmp_path)
    await store.save(_session_state())
    loaded = await store.load(_ref())
    assert loaded is not None
    assert loaded.data == {"threadId": "thread-1"}
    assert await store.load(SessionStateRef(_ref().uri, id=_ref().id, format="other")) is None
    await store.delete(_ref())
    assert await store.load(_ref()) is None


@pytest.mark.asyncio
async def test_file_session_state_store_rejects_invalid_records(tmp_path: Path) -> None:
    store = FileSessionStateStore(tmp_path)
    invalid = StoredHarnessSessionState(SessionStateRef("", id="", format=""), "codex", {})
    with pytest.raises(ValueError, match="requires ref"):
        await store.save(invalid)


def test_continuity_prefers_resume_then_replay_then_fresh() -> None:
    replay = HistoryInput(
        id="history",
        content="[]",
        source=ResourceRef(uri="supertag://sessions/session-1/continuity"),
    )
    continuity = HarnessContinuity("session-1", _ref(), replay)
    resumed = resolve_harness_continuity(
        continuity, lambda session_state: session_state.format == "codex-thread-v1"
    )
    assert resumed.mode == "resume"
    assert resumed.session_state == _ref()
    assert resolve_harness_continuity(continuity, lambda _session_state: False).mode == "replay"
    assert (
        resolve_harness_continuity(
            HarnessContinuity("session-1", _ref()), lambda _session_state: False
        ).mode
        == "fresh"
    )
    assert resolve_harness_continuity(None, lambda _session_state: True).mode == "fresh"


def test_session_state_python_names_use_shared_wire_contract() -> None:
    from supertag.models import HarnessCapabilities, SessionStateInput, wire

    state = SessionStateInput(id="native", session_state=_ref())
    assert wire(state)["kind"] == "sessionState"
    assert wire(state)["sessionState"] == wire(_ref())
    capabilities = HarnessCapabilities(
        id="test",
        version="1",
        input_kinds=("sessionState",),
        streaming=True,
        cancellation=True,
        session_persistence="native",
    )
    assert wire(capabilities)["sessionPersistence"] == "native"
    assert "session_persistence" not in wire(capabilities)


def test_session_persistence_credentials_roundtrip_without_coordination() -> None:
    from supertag.models import TaskAttemptSpec, wire

    from .helpers import task_attempt

    attempt = task_attempt()
    persistence = {"controlPlaneUrl": "https://control-plane.example", "token": "session-only"}
    attempt["session"]["persistence"] = persistence
    restored = wire(TaskAttemptSpec.from_wire(attempt))
    assert restored["session"]["persistence"] == persistence
    assert "coordination" not in restored
    for invalid in (None, {}, {**persistence, "token": ""}, {**persistence, "extra": True}):
        attempt["session"]["persistence"] = invalid
        with pytest.raises(ValueError):
            TaskAttemptSpec.from_wire(attempt)
