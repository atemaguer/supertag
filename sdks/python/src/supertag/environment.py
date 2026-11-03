from __future__ import annotations

import asyncio
import codecs
import collections
import os
import shutil
import signal
import stat
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Mapping, Protocol
from urllib.parse import unquote, urlparse

from .models import (
    CancellationToken,
    Capability,
    EnvironmentPlan,
    TaskAttemptSpec,
    WorkerProfile,
)

_OUTPUT_HIGH_WATER_BYTES = 1024 * 1024
_OUTPUT_LOW_WATER_BYTES = 256 * 1024
_OUTPUT_MAXIMUM_BYTES = 8 * _OUTPUT_HIGH_WATER_BYTES

_SAFE_PROCESS_ENVIRONMENT_KEYS = (
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TERM",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
    "COMSPEC",
)


@dataclass(frozen=True)
class StagedFile:
    path: str
    content: str | bytes
    mode: int | None = None


@dataclass(frozen=True)
class MountSpec:
    source: Mapping[str, Any]
    destination: str
    read_only: bool


@dataclass(frozen=True)
class SecretBinding:
    secret_ref: str
    target: str


@dataclass(frozen=True)
class ProcessSpec:
    command: str
    args: tuple[str, ...] = ()
    cwd: str | None = None
    environment: Mapping[str, str] = field(default_factory=dict)
    stdin: str | None = None
    timeout_ms: int | None = None
    stream_output: bool = False


@dataclass(frozen=True)
class ProcessResult:
    exit_code: int | None
    stdout: str
    stderr: str
    signal: str | None = None


class ExecutionCleanupError(RuntimeError):
    """Execution ownership is unresolved; callers must not report a terminal receipt."""


class ProcessHandle(Protocol):
    pid: int | None

    async def wait(self) -> ProcessResult: ...

    def output(self) -> AsyncIterator[Mapping[str, str]]: ...

    def kill(self, requested_signal: signal.Signals = signal.SIGTERM) -> None: ...


class EnvironmentAccess(Protocol):
    id: str
    placement: str
    root_directory: str

    async def prepare(self, plan: EnvironmentPlan) -> None: ...

    def resolve_path(self, path: str) -> str: ...

    async def read(self, path: str) -> str: ...

    async def spawn(self, process: ProcessSpec) -> ProcessHandle: ...

    async def dispose(self, reason: str = "completed") -> None: ...


class HarnessRuntime(EnvironmentAccess, Protocol):
    """Access used to host a Harness process and its private runtime state."""


class ExecutionEnvironment(EnvironmentAccess, Protocol):
    """Access used for workspace operations requested by a Harness."""


class HarnessRuntimeProvider(Protocol):
    id: str
    capabilities: tuple[Capability, ...]

    async def provision_runtime(
        self,
        task: TaskAttemptSpec,
        profile: WorkerProfile,
        plan: EnvironmentPlan,
        cancellation: CancellationToken,
    ) -> HarnessRuntime: ...


class ExecutionEnvironmentProvider(Protocol):
    id: str
    capabilities: tuple[Capability, ...]

    async def provision(
        self,
        task: TaskAttemptSpec,
        profile: WorkerProfile,
        plan: EnvironmentPlan,
        cancellation: CancellationToken,
    ) -> ExecutionEnvironment: ...


class LocalExecutionEnvironmentProvider:
    id = "local-execution"
    capabilities = (
        Capability("supertag.execution.local-process", 1),
        Capability("supertag.process-output-streaming", 1),
    )

    def __init__(
        self,
        *,
        temporary_directory: str | Path | None = None,
        inherited_environment: Mapping[str, str] | None = None,
        max_output_characters: int = 32_000,
    ) -> None:
        if max_output_characters <= 0:
            raise ValueError("max_output_characters must be positive")
        self._temporary_directory = temporary_directory
        self._inherited_environment = inherited_environment
        self._max_output_characters = max_output_characters

    async def provision(
        self,
        task: TaskAttemptSpec | Mapping[str, Any] | None = None,
        profile: WorkerProfile | None = None,
        plan: EnvironmentPlan | None = None,
        cancellation: CancellationToken | None = None,
    ) -> LocalProcessEnvironment:
        return await self._provision(
            task,
            plan,
            cancellation,
            profile.execution.lifetime.scope if profile is not None else None,
        )

    async def _provision(
        self,
        task: TaskAttemptSpec | Mapping[str, Any] | None,
        plan: EnvironmentPlan | None,
        cancellation: CancellationToken | None,
        scope: str | None,
    ) -> LocalProcessEnvironment:
        del plan
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        if scope is None and isinstance(task, Mapping):
            scope = (
                ((task.get("profile") or {}).get("execution") or {}).get("lifetime") or {}
            ).get("scope", "attempt")
        elif scope is None:
            scope = "attempt"
        if scope != "attempt":
            raise ValueError(
                "The local execution environment provider currently supports only "
                "attempt-scoped environments"
            )
        root = tempfile.mkdtemp(prefix="supertag-attempt-", dir=self._temporary_directory)
        return LocalProcessEnvironment(
            root,
            inherited_environment=self._inherited_environment,
            max_output_characters=self._max_output_characters,
            cancellation=cancellation,
        )


class LocalHarnessRuntimeProvider(LocalExecutionEnvironmentProvider):
    """Host a Harness locally while its tools may run in another environment."""

    id = "local-harness-runtime"

    async def provision_runtime(
        self,
        task: TaskAttemptSpec,
        profile: WorkerProfile,
        plan: EnvironmentPlan,
        cancellation: CancellationToken,
    ) -> HarnessRuntime:
        if profile.runtime is None:
            raise ValueError("A separate Harness runtime requires profile.runtime")
        return await self._provision(
            task,
            plan,
            cancellation,
            profile.runtime.lifetime.scope,
        )


class LocalProcessEnvironment:
    placement = "local"

    def __init__(
        self,
        root: str | Path,
        *,
        inherited_environment: Mapping[str, str] | None,
        max_output_characters: int,
        cancellation: CancellationToken | None = None,
    ) -> None:
        self.root_directory = str(Path(root).resolve())
        self.id = f"local:{self.root_directory}"
        self._inherited_environment = inherited_environment
        self._max_output_characters = max_output_characters
        self._disposed = False
        self._processes: list[_LocalProcessHandle] = []
        self._cancellation = cancellation
        self._cancel_task = (
            asyncio.create_task(self._watch_cancellation()) if cancellation is not None else None
        )

    async def prepare(self, plan: EnvironmentPlan) -> None:
        self._assert_open()
        if plan.secret_bindings:
            raise ValueError(
                "The local execution environment provider requires a Secret Resolver before "
                "secret bindings can be used"
            )
        read_only: list[Path] = []
        for mount in plan.mounts:
            source_value = _field(mount, "source")
            destination_value = _field(mount, "destination")
            read_only_value = _field(mount, "readOnly", _field(mount, "read_only", False))
            if not isinstance(source_value, Mapping) or not isinstance(destination_value, str):
                raise ValueError("Mounts require a source object and destination path")
            source = _local_resource_path(source_value)
            _assert_safe_resource(source)
            destination = Path(self.resolve_path(destination_value))
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                raise FileExistsError(f"Mount destination already exists: {destination_value}")
            if source.is_dir():
                shutil.copytree(source, destination, symlinks=False)
            else:
                shutil.copy2(source, destination)
            if bool(read_only_value):
                read_only.append(destination)
        for staged in plan.files:
            staged_path = _field(staged, "path")
            content = _field(staged, "content")
            mode = _field(staged, "mode")
            if not isinstance(staged_path, str) or not isinstance(content, (str, bytes)):
                raise ValueError("Staged files require a path and text or byte content")
            destination = Path(self.resolve_path(staged_path))
            destination.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, str):
                with destination.open("x", encoding="utf-8") as stream:
                    stream.write(content)
            else:
                with destination.open("xb") as stream:
                    stream.write(content)
            if mode is not None:
                if not isinstance(mode, int):
                    raise ValueError("Staged file mode must be an integer")
                destination.chmod(mode)

        for destination in reversed(read_only):
            _make_tree_read_only(destination)

    def resolve_path(self, path: str) -> str:
        self._assert_open()
        root = Path(self.root_directory)
        destination = (root / path).resolve()
        if not destination.is_relative_to(root):
            raise ValueError(f"Environment path escapes its root: {path}")
        return str(destination)

    async def read(self, path: str) -> str:
        return Path(self.resolve_path(path)).read_text(encoding="utf-8")

    async def read_bytes(self, path: str) -> bytes:
        source = Path(self.resolve_path(path))
        if not source.is_file() or source.stat().st_size > 32 * 1024 * 1024:
            raise ValueError("Artifact must be a regular file under 32 MiB")
        with source.open("rb") as stream:
            data = stream.read(32 * 1024 * 1024 + 1)
        if len(data) > 32 * 1024 * 1024:
            raise ValueError("Artifact exceeds 32 MiB")
        return data

    async def spawn(self, process: ProcessSpec) -> _LocalProcessHandle:
        self._assert_open()
        if self._cancellation is not None:
            self._cancellation.raise_if_cancelled()
        if process.timeout_ms is not None and process.timeout_ms <= 0:
            raise ValueError("Process timeout must be positive")
        cwd = process.cwd or self.root_directory
        cwd_path = Path(cwd)
        if not cwd_path.is_absolute():
            cwd = self.resolve_path(cwd)
        environment = _minimal_process_environment(os.environ)
        if self._inherited_environment is not None:
            environment.update(self._inherited_environment)
        environment.update(process.environment)
        child = await asyncio.create_subprocess_exec(
            process.command,
            *process.args,
            cwd=cwd,
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=os.name == "posix",
        )
        handle = _LocalProcessHandle(child, process, self._max_output_characters)
        self._processes.append(handle)
        if self._disposed or (self._cancellation is not None and self._cancellation.cancelled):
            await handle.terminate()
            raise RuntimeError("Environment closed while starting process")
        return handle

    async def dispose(self, reason: str = "completed") -> None:
        del reason
        if self._disposed:
            return
        self._disposed = True
        if self._cancel_task is not None:
            self._cancel_task.cancel()
            await asyncio.gather(self._cancel_task, return_exceptions=True)
        gone = await asyncio.gather(*(process.terminate() for process in self._processes))
        if not all(gone):
            raise ExecutionCleanupError(
                "Owned process group still exists; preserving attempt directory"
            )
        _make_tree_writable(Path(self.root_directory))
        try:
            shutil.rmtree(self.root_directory)
        except FileNotFoundError:
            pass
        except OSError as error:
            raise ExecutionCleanupError("Attempt directory cleanup failed") from error

    async def _watch_cancellation(self) -> None:
        assert self._cancellation is not None
        await self._cancellation.wait()
        await asyncio.gather(*(process.terminate() for process in self._processes))

    def _assert_open(self) -> None:
        if self._disposed:
            raise RuntimeError(f"Execution Environment {self.id} has been disposed")


class _LocalProcessHandle:
    def __init__(
        self, process: asyncio.subprocess.Process, spec: ProcessSpec, max_output: int
    ) -> None:
        self._process = process
        self._spec = spec
        self._max_output = max_output
        self.pid = process.pid
        self._terminating: asyncio.Task[bool] | None = None
        # Backpressure: past the high-water mark the drains stop reading, so the child blocks on
        # its pipe; they resume at the low-water mark. The hard cap only binds once the process
        # has exited or is terminating, when pausing can no longer hold a writer back.
        self._chunks: collections.deque[tuple[Mapping[str, str], int]] = collections.deque()
        self._buffered_bytes = 0
        self._drained = asyncio.Event()
        self._drained.set()
        self._output_available = asyncio.Event()
        # Drain from spawn, even when a Harness forgets to call wait().
        self._waited = asyncio.create_task(self._communicate())
        self._waited.add_done_callback(lambda _: self._output_available.set())
        self._waited.add_done_callback(
            lambda task: task.exception() if not task.cancelled() else None
        )

    async def wait(self) -> ProcessResult:
        return await asyncio.shield(self._waited)

    async def output(self) -> AsyncIterator[Mapping[str, str]]:
        if not self._spec.stream_output:
            raise ValueError("Process output streaming was not requested")
        while True:
            self._output_available.clear()
            while self._chunks:
                chunk, size = self._chunks.popleft()
                self._buffered_bytes -= size
                if self._buffered_bytes <= _OUTPUT_LOW_WATER_BYTES:
                    self._drained.set()
                yield chunk
            if self._waited.done():
                await self.wait()
                return
            await self._output_available.wait()

    def kill(self, requested_signal: signal.Signals = signal.SIGTERM) -> None:
        try:
            if os.name == "posix":
                os.killpg(self.pid, requested_signal)
            elif self._process.returncode is None:
                self._process.send_signal(requested_signal)
        except ProcessLookupError:
            pass

    def _alive(self) -> bool:
        if os.name != "posix":
            return self._process.returncode is None
        try:
            os.killpg(self.pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    async def terminate(self) -> bool:
        if self._terminating is None:
            self._terminating = asyncio.create_task(self._terminate())
        return await asyncio.shield(self._terminating)

    async def _terminate(self) -> bool:
        self.kill()
        end = asyncio.get_running_loop().time() + 0.25
        while self._alive() and asyncio.get_running_loop().time() < end:
            await asyncio.sleep(0.01)
        if self._alive():
            if os.name == "posix":
                self.kill(signal.SIGKILL)
            elif self._process.returncode is None:
                self._process.kill()
        try:
            await asyncio.wait_for(self._process.wait(), 1)
        except (TimeoutError, asyncio.TimeoutError):
            return False
        end = asyncio.get_running_loop().time() + 1
        while self._alive() and asyncio.get_running_loop().time() < end:
            await asyncio.sleep(0.01)
        return not self._alive()

    async def _drain(self, reader: asyncio.StreamReader | None, stream: str) -> str:
        if reader is None:
            return ""
        tail = b""
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while chunk := await reader.read(8192):
            tail = (tail + chunk)[-self._max_output * 4 :]
            if self._spec.stream_output:
                await self._publish(stream, decoder.decode(chunk))
        if self._spec.stream_output:
            await self._publish(stream, decoder.decode(b"", final=True))
        return tail.decode(errors="replace")[-self._max_output :]

    def _producer_can_pause(self) -> bool:
        return self._process.returncode is None and self._terminating is None

    async def _publish(self, stream: str, text: str) -> None:
        if not text:
            return
        size = len(text.encode())
        if self._buffered_bytes + size > _OUTPUT_MAXIMUM_BYTES:
            await self.terminate()
            raise BufferError(
                f"Process output exceeded its {_OUTPUT_MAXIMUM_BYTES}-byte hard limit of "
                "unconsumed output: the producer could not pause at the "
                f"{_OUTPUT_HIGH_WATER_BYTES}-byte high-water mark"
            )
        self._chunks.append(({"stream": stream, "text": text}, size))
        self._buffered_bytes += size
        self._output_available.set()
        if self._buffered_bytes < _OUTPUT_HIGH_WATER_BYTES:
            return
        self._drained.clear()
        # Stop reading until the consumer drains. Exit and termination are polled, since newer
        # asyncio versions only report exit after the pipes this drain holds have closed.
        while not self._drained.is_set() and self._producer_can_pause():
            try:
                await asyncio.wait_for(self._drained.wait(), 0.05)
            except (TimeoutError, asyncio.TimeoutError):
                pass

    async def _communicate(self) -> ProcessResult:
        stdout_task = asyncio.create_task(self._drain(self._process.stdout, "stdout"))
        stderr_task = asyncio.create_task(self._drain(self._process.stderr, "stderr"))

        async def send_input() -> None:
            if self._process.stdin is None:
                return
            try:
                if self._spec.stdin is not None:
                    self._process.stdin.write(self._spec.stdin.encode())
                    await self._process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                self._process.stdin.close()

        input_task = asyncio.create_task(send_input())
        try:

            async def collect() -> tuple[str, str]:
                await self._process.wait()
                stdout, stderr = await asyncio.gather(stdout_task, stderr_task)
                return stdout, stderr

            if self._spec.timeout_ms is None:
                stdout, stderr = await collect()
            else:
                stdout, stderr = await asyncio.wait_for(collect(), self._spec.timeout_ms / 1000)
            return ProcessResult(
                exit_code=self._process.returncode,
                stdout=stdout,
                stderr=stderr,
                signal=(
                    signal.Signals(-self._process.returncode).name
                    if self._process.returncode is not None and self._process.returncode < 0
                    else None
                ),
            )
        except (TimeoutError, asyncio.TimeoutError) as error:
            await self.terminate()
            # Terminated writers leave bounded pipe contents; read them to EOF so pipes close.
            await asyncio.wait((stdout_task, stderr_task), timeout=1)
            raise TimeoutError(
                f"Process exceeded its {self._spec.timeout_ms}ms execution limit"
            ) from error
        finally:
            for task in (stdout_task, stderr_task, input_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(stdout_task, stderr_task, input_task, return_exceptions=True)


def _local_resource_path(resource: Mapping[str, Any]) -> Path:
    uri = resource.get("uri")
    if not isinstance(uri, str):
        raise ValueError("Mount source requires a URI")
    parsed = urlparse(uri)
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost"):
        raise ValueError("Local mounts require a file: URI")
    return Path(unquote(parsed.path)).absolute()


def _minimal_process_environment(environment: Mapping[str, str]) -> dict[str, str]:
    return {key: environment[key] for key in _SAFE_PROCESS_ENVIRONMENT_KEYS if key in environment}


def _field(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _assert_safe_resource(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(f"Mount source is unavailable: {path}")
    current = path
    while True:
        if current.is_symlink():
            raise ValueError(f"Mount source cannot contain symbolic links: {path}")
        if current.parent == current:
            break
        current = current.parent
    if path.is_dir() and any(item.is_symlink() for item in path.rglob("*")):
        raise ValueError(f"Mount source cannot contain symbolic links: {path}")


def _make_tree_read_only(path: Path) -> None:
    for item in [path, *(path.rglob("*") if path.is_dir() else ())]:
        item.chmod(item.stat().st_mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))


def _make_tree_writable(path: Path) -> None:
    if not path.exists():
        return
    for item in [path, *(path.rglob("*") if path.is_dir() else ())]:
        try:
            if item.is_symlink():
                continue
            item.chmod(item.stat().st_mode | stat.S_IWUSR)
        except FileNotFoundError:
            pass


def _bounded(value: str, maximum: int) -> str:
    return value if len(value) <= maximum else value[-maximum:]
