from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

from supertag.environment import (
    EnvironmentPlan,
    LocalExecutionEnvironmentProvider,
    MountSpec,
    ProcessSpec,
    SecretBinding,
    StagedFile,
)


@pytest.mark.asyncio
async def test_local_environment_stages_mounts_runs_and_disposes(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    (source / "skill.md").write_text("shared skill", encoding="utf-8")
    provider = LocalExecutionEnvironmentProvider(temporary_directory=tmp_path)
    environment = await provider.provision()

    await environment.prepare(
        EnvironmentPlan(
            files=(StagedFile("input/request.txt", "hello", 0o600),),
            mounts=(MountSpec({"uri": source.as_uri()}, "skills/demo", True),),
        )
    )
    assert await environment.read("input/request.txt") == "hello"
    assert await environment.read("skills/demo/skill.md") == "shared skill"

    handle = await environment.spawn(
        ProcessSpec(
            sys.executable,
            ("-c", "import os; print(open('input/request.txt').read(), os.environ['TAG'])"),
            environment={"TAG": "engineering"},
        )
    )
    result = await handle.wait()
    assert result.exit_code == 0
    assert result.stdout.strip() == "hello engineering"

    root = Path(environment.root_directory)
    await environment.dispose()
    assert not root.exists()
    with pytest.raises(RuntimeError, match="disposed"):
        environment.resolve_path("anything")


@pytest.mark.asyncio
async def test_local_environment_enforces_boundaries_and_lifetime(tmp_path: Path) -> None:
    provider = LocalExecutionEnvironmentProvider(temporary_directory=tmp_path)
    with pytest.raises(ValueError, match="attempt-scoped"):
        await provider.provision({"profile": {"execution": {"lifetime": {"scope": "session"}}}})

    environment = await provider.provision()
    with pytest.raises(ValueError, match="escapes"):
        environment.resolve_path("../outside")
    with pytest.raises(ValueError, match="Secret Resolver"):
        await environment.prepare(
            EnvironmentPlan(secret_bindings=(SecretBinding("token", "TOKEN"),))
        )
    await environment.dispose("failed")


@pytest.mark.asyncio
async def test_local_environment_rejects_symlink_mounts_and_times_out(
    tmp_path: Path,
) -> None:
    target = tmp_path / "target"
    target.write_text("secret", encoding="utf-8")
    link = tmp_path / "link"
    link.symlink_to(target)
    provider = LocalExecutionEnvironmentProvider(temporary_directory=tmp_path)
    environment = await provider.provision()
    with pytest.raises(ValueError, match="symbolic links"):
        await environment.prepare(
            EnvironmentPlan(mounts=(MountSpec({"uri": link.as_uri()}, "mounted", False),))
        )
    handle = await environment.spawn(
        ProcessSpec(sys.executable, ("-c", "import time; time.sleep(2)"), timeout_ms=20)
    )
    with pytest.raises(TimeoutError, match="20ms"):
        await handle.wait()
    await environment.dispose()


@pytest.mark.asyncio
async def test_local_environment_accepts_wire_shaped_harness_plans(tmp_path: Path) -> None:
    source = tmp_path / "source.txt"
    source.write_text("mounted", encoding="utf-8")
    environment = await LocalExecutionEnvironmentProvider(temporary_directory=tmp_path).provision()

    await environment.prepare(
        EnvironmentPlan(
            files=({"path": "input.txt", "content": "staged", "mode": 0o600},),
            mounts=(
                {
                    "source": {"uri": source.as_uri()},
                    "destination": "mounted.txt",
                    "readOnly": True,
                },
            ),
        )
    )

    assert await environment.read("input.txt") == "staged"
    assert await environment.read("mounted.txt") == "mounted"
    await environment.dispose()


@pytest.mark.asyncio
async def test_local_environment_inherits_only_plumbing_and_projected_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SUPERTAG_SENTINEL_SECRET", "host-secret-must-not-cross")
    provider = LocalExecutionEnvironmentProvider(
        temporary_directory=tmp_path,
        inherited_environment={"EXPLICIT_PROVIDER_VALUE": "provider-value"},
    )
    environment = await provider.provision()
    try:
        handle = await environment.spawn(
            ProcessSpec(
                sys.executable,
                (
                    "-c",
                    "import json, os; print(json.dumps({"
                    "'sentinel': os.environ.get('SUPERTAG_SENTINEL_SECRET'), "
                    "'provider': os.environ.get('EXPLICIT_PROVIDER_VALUE'), "
                    "'process': os.environ.get('EXPLICIT_PROCESS_VALUE'), "
                    "'path': bool(os.environ.get('PATH'))}))",
                ),
                environment={"EXPLICIT_PROCESS_VALUE": "process-value"},
            )
        )
        result = await handle.wait()
        assert result.exit_code == 0
        assert json.loads(result.stdout) == {
            "sentinel": None,
            "provider": "provider-value",
            "process": "process-value",
            "path": True,
        }
    finally:
        await environment.dispose()


@pytest.mark.asyncio
async def test_process_output_is_drained_before_wait_and_bounded(tmp_path: Path) -> None:
    import asyncio

    environment = await LocalExecutionEnvironmentProvider(
        temporary_directory=tmp_path, max_output_characters=80
    ).provision()
    try:
        handle = await environment.spawn(
            ProcessSpec(
                sys.executable,
                ("-c", "import sys;sys.stdout.write('x'*2000000+'END')"),
                timeout_ms=2000,
            )
        )
        await asyncio.sleep(0.05)
        result = await asyncio.wait_for(handle.wait(), 3)
        assert result.exit_code == 0
        assert len(result.stdout) == 80
        assert result.stdout.endswith("END")
    finally:
        await environment.dispose()


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process-group supervision")
async def test_timeout_escalates_ignored_term_and_dispose_kills_unawaited_children(
    tmp_path: Path,
) -> None:
    import asyncio
    import os
    import signal

    environment = await LocalExecutionEnvironmentProvider(temporary_directory=tmp_path).provision()
    handle = await environment.spawn(
        ProcessSpec(
            sys.executable,
            (
                "-c",
                "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)",
            ),
            timeout_ms=150,
        )
    )
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(handle.wait(), 3)
    with pytest.raises(ProcessLookupError):
        os.kill(handle.pid, 0)
    child = await environment.spawn(
        ProcessSpec(sys.executable, ("-c", "import time;time.sleep(60)"))
    )
    await asyncio.wait_for(environment.dispose(), 3)
    with pytest.raises(ProcessLookupError):
        os.kill(child.pid, signal.SIGCONT)
    assert not Path(environment.root_directory).exists()


@pytest.mark.asyncio
async def test_cancellation_stops_running_process_and_nested_mount_composes(tmp_path: Path) -> None:
    import asyncio

    from supertag.models import CancellationToken

    token = CancellationToken()
    source = tmp_path / "seed"
    source.mkdir()
    (source / "base.txt").write_text("original")
    environment = await LocalExecutionEnvironmentProvider(temporary_directory=tmp_path).provision(
        cancellation=token
    )
    await environment.prepare(
        EnvironmentPlan(
            files=(StagedFile("workspace/inputs/blob", b"\x00\xff"),),
            mounts=(MountSpec({"uri": source.as_uri()}, "workspace", False),),
        )
    )
    assert await environment.read_bytes("workspace/inputs/blob") == b"\x00\xff"
    with pytest.raises(FileExistsError):
        await environment.prepare(
            EnvironmentPlan(files=(StagedFile("workspace/base.txt", "replace"),))
        )
    handle = await environment.spawn(
        ProcessSpec(sys.executable, ("-c", "import time;time.sleep(60)"))
    )
    token.cancel("stop")
    result = await asyncio.wait_for(handle.wait(), 3)
    assert result.exit_code != 0
    await environment.dispose("cancelled")


@pytest.mark.asyncio
async def test_streaming_output_preserves_channels_and_utf8(tmp_path: Path) -> None:
    environment = await LocalExecutionEnvironmentProvider(temporary_directory=tmp_path).provision()
    try:
        handle = await environment.spawn(
            ProcessSpec(
                sys.executable,
                ("-c", "import sys;print('hello 🌍');print('problem',file=sys.stderr)"),
                stream_output=True,
            )
        )
        chunks = [chunk async for chunk in handle.output()]
        assert (
            "".join(chunk["text"] for chunk in chunks if chunk["stream"] == "stdout")
            == "hello 🌍\n"
        )
        assert (
            "".join(chunk["text"] for chunk in chunks if chunk["stream"] == "stderr") == "problem\n"
        )
        assert (await handle.wait()).exit_code == 0
    finally:
        await environment.dispose()


@pytest.mark.asyncio
async def test_slow_consumer_receives_all_output_through_backpressure(tmp_path: Path) -> None:
    import asyncio

    size = 12_000_000
    generate = (
        "def generate(tag, size):\n"
        "    parts, total, i = [], 0, 0\n"
        "    while total < size:\n"
        "        part = tag + format(i, '07x') + '\\n'\n"
        "        parts.append(part); total += len(part); i += 1\n"
        "    return ''.join(parts)[:size]\n"
    )
    namespace: dict[str, Any] = {}
    exec(generate, namespace)
    environment = await LocalExecutionEnvironmentProvider(temporary_directory=tmp_path).provision()
    try:
        handle = await environment.spawn(
            ProcessSpec(
                sys.executable,
                (
                    "-c",
                    generate
                    + f"import sys\nsys.stdout.write(generate('o', {size}))\n"
                    + f"sys.stderr.write(generate('e', {size}))\n",
                ),
                stream_output=True,
            )
        )
        received: dict[str, list[str]] = {"stdout": [], "stderr": []}
        since_delay = 0
        async for chunk in handle.output():
            received[chunk["stream"]].append(chunk["text"])
            since_delay += len(chunk["text"])
            if since_delay >= 512 * 1024:
                since_delay = 0
                await asyncio.sleep(0.01)
        result = await handle.wait()
        assert result.exit_code == 0
        assert "".join(received["stdout"]) == namespace["generate"]("o", size)
        assert "".join(received["stderr"]) == namespace["generate"]("e", size)
    finally:
        await environment.dispose()


@pytest.mark.asyncio
async def test_unconsumed_stream_blocks_its_producer_until_the_timeout_stops_it(
    tmp_path: Path,
) -> None:
    import asyncio

    environment = await LocalExecutionEnvironmentProvider(temporary_directory=tmp_path).provision()
    try:
        handle = await environment.spawn(
            ProcessSpec(
                sys.executable,
                ("-c", "import sys;sys.stdout.write('x'*20_000_000)"),
                stream_output=True,
                timeout_ms=1500,
            )
        )
        with pytest.raises(TimeoutError, match="execution limit"):
            await asyncio.wait_for(handle.wait(), 10)
    finally:
        await environment.dispose()
