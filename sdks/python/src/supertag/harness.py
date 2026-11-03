"""Canonical Harness contracts shared by built-in and custom Python Workers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator, Mapping, Protocol

from .environment import ExecutionEnvironment, HarnessRuntime
from .models import (
    CancellationToken,
    ExecutionContext,
    HarnessCapabilities,
    HarnessPlan,
    SessionStateRef,
)


@dataclass(frozen=True)
class HarnessEnvironmentAccesses:
    runtime: HarnessRuntime
    execution: ExecutionEnvironment


class HarnessExecution(Protocol):
    def run(self, cancellation: CancellationToken) -> AsyncIterator[Mapping[str, object]]: ...

    async def session_state(self) -> SessionStateRef | None: ...

    async def close(self) -> None: ...


class Harness(Protocol):
    id: str

    async def describe(self) -> HarnessCapabilities: ...

    async def plan(self, context: ExecutionContext) -> HarnessPlan: ...

    async def start(
        self,
        plan: HarnessPlan,
        environments: HarnessEnvironmentAccesses,
        context: ExecutionContext,
    ) -> HarnessExecution: ...


__all__ = [
    "Harness",
    "HarnessCapabilities",
    "HarnessEnvironmentAccesses",
    "HarnessExecution",
    "HarnessPlan",
]
