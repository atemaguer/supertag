from __future__ import annotations

import pytest

from supertag.models import (
    EnvironmentLifetime,
    ExecutionConfiguration,
    ProviderConfiguration,
    ResourceRef,
    TaskAttemptSpec,
    WorkerProfile,
    WorkerProfileRef,
    wire,
)

from .helpers import task_attempt


def test_task_attempt_has_explicit_round_trip_wire_boundary() -> None:
    raw = task_attempt()
    raw["futureOptionalField"] = {"value": True}
    spec = TaskAttemptSpec.from_wire(raw)

    assert spec.task_id == "task-1"
    assert spec.worker_profile == WorkerProfileRef("codex", "1")
    assert spec.to_wire() == raw


def test_nested_sdk_values_encode_camel_case_without_leaking_python_names() -> None:
    profile = WorkerProfile(
        ref=WorkerProfileRef("custom", "1"),
        worker_type="runtime",
        harness=ProviderConfiguration("custom"),
        execution=ExecutionConfiguration(
            "local",
            EnvironmentLifetime("session", idle_timeout_seconds=60),
            {"source": ResourceRef("file:///workspace", media_type="text/plain")},
        ),
    )

    encoded = wire(profile)

    assert encoded["workerType"] == "runtime"
    assert encoded["execution"]["lifetime"] == {
        "scope": "session",
        "idleTimeoutSeconds": 60,
    }
    assert encoded["execution"]["configuration"]["source"]["mediaType"] == "text/plain"
    assert "worker_type" not in encoded


def test_task_execution_requirements_validate_and_round_trip() -> None:
    import pytest

    raw = task_attempt()
    raw["execution"] = {
        "requires": [{"id": "supertag.process-output-streaming", "version": 1}],
        "prefers": [],
        "harness": "codex",
        "profile": {"id": "codex", "revision": "1"},
    }
    assert TaskAttemptSpec.from_wire(raw).to_wire()["execution"] == raw["execution"]
    for invalid in (
        {"requires": [{"id": "x", "version": "1"}]},
        {"unknown": True},
        {"harness": ""},
    ):
        raw["execution"] = invalid
        with pytest.raises(ValueError):
            TaskAttemptSpec.from_wire(raw)
    raw.pop("execution")
    with pytest.raises(ValueError):
        TaskAttemptSpec.from_wire(raw)


def test_authorization_tag_cannot_bind_a_worker_profile() -> None:
    import pytest

    raw = task_attempt()
    raw["authorization"]["tag"]["workerProfile"] = raw["workerProfile"]
    with pytest.raises(ValueError, match="belongs to the Attempt"):
        TaskAttemptSpec.from_wire(raw)


def test_profile_capability_wire_and_requirement_isolation() -> None:
    from supertag import Capability, WorkerDescriptor, WorkerProfileCapabilities
    from supertag.models import _supports_required_context

    profile = WorkerProfileRef("codex", "1")
    descriptor = WorkerDescriptor(
        id="mixed",
        type="custom",
        profiles=(profile,),
        capabilities=(Capability("broad-only", 1),),
        context_types=(),
        profile_capabilities=(
            WorkerProfileCapabilities(
                profile=profile,
                capabilities=(Capability("narrow", 1),),
                context_types=(),
                harness="codex",
            ),
        ),
    )
    assert wire(descriptor)["profileCapabilities"] == [
        {
            "profile": {"id": "codex", "revision": "1"},
            "capabilities": [{"id": "narrow", "version": 1}],
            "contextTypes": [],
            "harness": "codex",
        }
    ]
    spec = task_attempt()
    spec["execution"] = {"harness": "codex", "requires": [{"id": "narrow", "version": 1}]}
    assert _supports_required_context(descriptor, spec)
    for requirements in (
        {"harness": "other"},
        {"requires": [{"id": "broad-only", "version": 1}]},
        {"profile": {"id": "other", "revision": "1"}},
    ):
        spec["execution"] = requirements
        assert not _supports_required_context(descriptor, spec)


def test_artifact_selection_preserves_exact_catalog_entries() -> None:
    from supertag import ArtifactSelection, ResourceRef

    selection = ArtifactSelection.from_wire(
        {"artifactId": "research-1", "paths": ["report/findings.md", "data/answers.csv"]}
    )
    assert selection.to_wire() == {
        "artifactId": "research-1",
        "paths": ["report/findings.md", "data/answers.csv"],
    }
    resource = ResourceRef.from_wire(
        {
            "uri": "supertag-artifact:sha256:abc",
            "artifactId": "research-1",
            "path": "report/findings.md",
            "provenance": {"taskId": "producer", "attemptId": "producer-attempt"},
        }
    )
    assert resource.to_wire()["artifactId"] == selection.artifact_id
    assert resource.to_wire()["path"] == "report/findings.md"


@pytest.mark.parametrize("paths", [[], ["../secret"], ["/root/file"], ["a//b"], ["same", "same"]])
def test_artifact_selection_rejects_ambiguous_paths(paths: list[str]) -> None:
    from supertag import ArtifactSelection

    with pytest.raises(ValueError):
        ArtifactSelection.from_wire({"artifactId": "research-1", "paths": paths})


def test_output_policy_round_trip_and_validation() -> None:
    raw = task_attempt()
    raw["execution"] = {"outputs": {"required": ["outputs/report.md"], "git": "capture"}}
    assert TaskAttemptSpec.from_wire(raw).to_wire()["execution"] == raw["execution"]
    for policy in (
        {"directory": "../secret"},
        {"maxFiles": 101},
        {"git": "push"},
        {"include": ["a/../b"]},
        {"directory": "a\\b"},
        {"required": "report"},
    ):
        raw["execution"] = {"outputs": policy}
        with pytest.raises(ValueError):
            TaskAttemptSpec.from_wire(raw)


def test_output_policy_requires_worker_capability() -> None:
    from dataclasses import replace

    from supertag.models import (
        Capability,
        WorkerDescriptor,
        WorkerProfileCapabilities,
        _supports_required_context,
    )

    raw = task_attempt()
    raw["execution"] = {"outputs": {}}
    descriptor = WorkerDescriptor(
        id="custom",
        type="custom",
        capabilities=(),
        profiles=(WorkerProfileRef("codex", "1"),),
        context_types=(),
        profile_capabilities=(WorkerProfileCapabilities(WorkerProfileRef("codex", "1"), (), ()),),
    )
    assert not _supports_required_context(descriptor, raw)
    capable = replace(
        descriptor,
        profile_capabilities=(
            replace(
                descriptor.profile_capabilities[0],
                capabilities=(Capability("supertag.artifacts.output-policy", 1),),
            ),
        ),
    )
    assert _supports_required_context(capable, raw)


def test_worker_descriptor_requires_profile_capabilities() -> None:
    from supertag import WorkerDescriptor

    with pytest.raises(TypeError, match="profile_capabilities"):
        WorkerDescriptor(
            id="custom",
            type="custom",
            profiles=(WorkerProfileRef("custom", "1"),),
            capabilities=(),
            context_types=(),
        )


def test_worker_descriptor_rejects_null_profile_capabilities() -> None:
    from supertag import WorkerDescriptor

    with pytest.raises(ValueError, match="profile_capabilities"):
        WorkerDescriptor(
            id="custom",
            type="custom",
            profiles=(WorkerProfileRef("custom", "1"),),
            capabilities=(),
            context_types=(),
            profile_capabilities=None,
        )
