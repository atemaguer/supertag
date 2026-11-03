from __future__ import annotations

from importlib.util import find_spec

import supertag
from supertag import (
    CodexHarness,
    CodexWorker,
    OpenAIAgentsHarness,
    OpenAIAgentsWorker,
    Worker,
    WorkerHostDescriptor,
    WorkerOptions,
    Worklet,
    WorkletConnection,
    create_worker,
)


def test_public_execution_layers_separate_worklets_from_worker_hosts() -> None:
    assert CodexHarness is not None
    assert CodexWorker is not None
    assert OpenAIAgentsHarness is not None
    assert OpenAIAgentsWorker is not None
    assert Worker is not None
    assert WorkerOptions is not None
    assert WorkerHostDescriptor is not None
    assert Worklet is not None
    assert WorkletConnection is not None
    assert callable(create_worker)

    removed_names = {
        "LocalWorkerHost",
        "RemoteWorkerHost",
        "WorkerHost",
        "WorkerRuntime",
        "WorkerRuntimeOptions",
        "PROTOCOL_VERSION",
        "RuntimeInputPipeline",
    }
    assert removed_names.isdisjoint(supertag.__all__)
    assert all(not hasattr(supertag, name) for name in removed_names)
    assert find_spec("supertag.codex_worklet") is None
    assert supertag.WORKLET_PROTOCOL_VERSION == 18
