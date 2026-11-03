"""A small attempt-scoped Environment Provider for a custom Python Harness."""

from __future__ import annotations

import asyncio
import os
import shutil
import signal
import tempfile
from pathlib import Path
from typing import Any

from supertag import CancellationToken, Capability
from supertag.environment import ProcessResult, ProcessSpec


class ExampleEnvironmentProvider:
    """Prepare a local filesystem boundary for one Task Attempt.

    This teaches the lifecycle expected of a remote or managed provider. It is
    not a security sandbox; production providers enforce their own network,
    mount, and secret policies.
    """

    id = "example-python-local-environment"
    capabilities = (Capability("example.execution.local", 1),)

    async def provision(
        self,
        task: Any,
        profile: Any,
        plan: Any,
        cancellation: CancellationToken,
    ) -> ExampleEnvironment:
        del task, profile, plan
        cancellation.raise_if_cancelled()
        return ExampleEnvironment(Path(tempfile.mkdtemp(prefix="supertag-example-")))


class ExampleEnvironment:
    placement = "local"

    def __init__(self, root_directory: Path) -> None:
        self.root_directory = str(root_directory.resolve())
        self.id = f"example-python-local:{self.root_directory}"
        self._disposed = False

    async def prepare(self, plan: Any) -> None:
        self._assert_open()
        if plan.mounts or plan.secret_bindings:
            raise ValueError("Example Environment supports staged files only")
        for staged in plan.files:
            destination = Path(self.resolve_path(staged.path))
            destination.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(staged.content, bytes):
                destination.write_bytes(staged.content)
            else:
                destination.write_text(staged.content, encoding="utf-8")
            if staged.mode is not None:
                destination.chmod(staged.mode)

    def resolve_path(self, path: str) -> str:
        self._assert_open()
        root = Path(self.root_directory)
        destination = (root / path).resolve()
        if not destination.is_relative_to(root):
            raise ValueError(f"Environment path escapes its root: {path}")
        return str(destination)

    async def read(self, path: str) -> str:
        return Path(self.resolve_path(path)).read_text(encoding="utf-8")

    async def spawn(self, process: ProcessSpec) -> ExampleProcess:
        self._assert_open()
        child = await asyncio.create_subprocess_exec(
            process.command,
            *process.args,
            cwd=process.cwd or self.root_directory,
            env={**os.environ, **process.environment},
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        return ExampleProcess(child, process.stdin)

    async def dispose(self, reason: str = "completed") -> None:
        del reason
        if self._disposed:
            return
        self._disposed = True
        shutil.rmtree(self.root_directory, ignore_errors=True)

    def _assert_open(self) -> None:
        if self._disposed:
            raise RuntimeError(f"Execution Environment {self.id} has been disposed")


class ExampleProcess:
    def __init__(self, process: asyncio.subprocess.Process, stdin: str | None) -> None:
        self._process = process
        self._stdin = stdin
        self.pid = process.pid

    async def wait(self) -> ProcessResult:
        stdin = None if self._stdin is None else self._stdin.encode()
        stdout, stderr = await self._process.communicate(stdin)
        return ProcessResult(
            exit_code=self._process.returncode,
            stdout=stdout.decode(errors="replace"),
            stderr=stderr.decode(errors="replace"),
        )

    def kill(self, requested_signal: signal.Signals = signal.SIGTERM) -> None:
        if self._process.returncode is None:
            self._process.send_signal(requested_signal)
