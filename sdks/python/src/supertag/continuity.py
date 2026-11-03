from __future__ import annotations

import asyncio
import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal

from .models import (
    HarnessContinuity,
    RuntimeInput,
    SessionStateRef,
    SessionStateStore,
    StoredHarnessSessionState,
    wire,
)


class InMemorySessionStateStore:
    def __init__(self) -> None:
        self._session_states: dict[str, StoredHarnessSessionState] = {}
        self._lock = asyncio.Lock()

    async def load(self, ref: SessionStateRef) -> StoredHarnessSessionState | None:
        async with self._lock:
            session_state = self._session_states.get(ref.id)
            return session_state if session_state is not None and session_state.ref == ref else None

    async def save(self, session_state: StoredHarnessSessionState) -> None:
        _validate_session_state(session_state)
        async with self._lock:
            self._session_states[session_state.ref.id] = session_state

    async def delete(self, ref: SessionStateRef) -> None:
        async with self._lock:
            self._session_states.pop(ref.id, None)


class FileSessionStateStore:
    def __init__(self, directory: str | Path) -> None:
        self._directory = Path(directory).expanduser().resolve()
        self._lock = asyncio.Lock()

    async def load(self, ref: SessionStateRef) -> StoredHarnessSessionState | None:
        try:
            value = json.loads(await asyncio.to_thread(self._path(ref).read_text, encoding="utf-8"))
        except FileNotFoundError:
            return None
        session_state = _session_state_from_wire(value)
        return session_state if session_state.ref == ref else None

    async def save(self, session_state: StoredHarnessSessionState) -> None:
        _validate_session_state(session_state)
        async with self._lock:
            await asyncio.to_thread(self._directory.mkdir, parents=True, exist_ok=True, mode=0o700)
            await asyncio.to_thread(os.chmod, self._directory, 0o700)
            path = self._path(session_state.ref)
            temporary = path.with_suffix(f"{path.suffix}.{os.getpid()}.tmp")
            value = {
                "ref": wire(session_state.ref),
                "harnessId": session_state.harness_id,
                "data": wire(session_state.data),
            }
            await asyncio.to_thread(
                temporary.write_text,
                json.dumps(value, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            await asyncio.to_thread(temporary.chmod, 0o600)
            await asyncio.to_thread(os.replace, temporary, path)

    async def delete(self, ref: SessionStateRef) -> None:
        async with self._lock:
            try:
                await asyncio.to_thread(self._path(ref).unlink)
            except FileNotFoundError:
                pass

    def _path(self, ref: SessionStateRef) -> Path:
        return self._directory / f"{hashlib.sha256(ref.id.encode()).hexdigest()}.json"


@dataclass(frozen=True)
class HarnessContinuityResolution:
    mode: Literal["resume", "replay", "fresh"]
    session_id: str | None = None
    session_state: SessionStateRef | None = None
    replay_input: RuntimeInput | None = None


def resolve_harness_continuity(
    continuity: HarnessContinuity | None,
    accepts_session_state: Callable[[SessionStateRef], bool],
) -> HarnessContinuityResolution:
    if continuity is None:
        return HarnessContinuityResolution("fresh")
    if continuity.prior_session_state is not None and accepts_session_state(
        continuity.prior_session_state
    ):
        return HarnessContinuityResolution(
            "resume",
            continuity.session_id,
            continuity.prior_session_state,
            continuity.replay_input,
        )
    if continuity.replay_input is not None:
        return HarnessContinuityResolution(
            "replay",
            continuity.session_id,
            replay_input=continuity.replay_input,
        )
    return HarnessContinuityResolution("fresh", continuity.session_id)


def _validate_session_state(session_state: StoredHarnessSessionState) -> None:
    if not session_state.ref.id or not session_state.ref.uri or not session_state.ref.format:
        raise ValueError("Stored session_state requires ref id, URI, and format")
    if not session_state.harness_id.strip():
        raise ValueError("Stored session_state requires a Harness ID")


def _session_state_from_wire(value: object) -> StoredHarnessSessionState:
    if not isinstance(value, dict) or not isinstance(value.get("ref"), dict):
        raise ValueError("Stored session_state must contain a ref object")
    if not isinstance(value.get("data"), dict):
        raise ValueError("Stored session_state must contain a data object")
    harness_id = value.get("harnessId")
    if not isinstance(harness_id, str) or not harness_id.strip():
        raise ValueError("Stored session_state must contain harnessId")
    return StoredHarnessSessionState(
        ref=SessionStateRef.from_wire(value["ref"]),
        harness_id=harness_id,
        data=value["data"],
    )


__all__ = [
    "SessionStateStore",
    "FileSessionStateStore",
    "HarnessContinuityResolution",
    "InMemorySessionStateStore",
    "resolve_harness_continuity",
]
