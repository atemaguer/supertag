use super::*;
use supertag_protocol::{
    artifacts::managed_output_directory,
    v2::{OutputGitMode, OutputPathPatterns, TaskOutputPolicy},
};

async fn submit(
    runtime: &mut Runtime<'_>,
    mode: &str,
    policy: Option<TaskOutputPolicy>,
) -> Result<Task> {
    Ok(runtime
        .operator
        .submit_task(runtime.credentials.request(SubmitTaskRequest {
            tag_id: TAG.into(),
            session_id: mode.into(),
            operation_id: format!("submit-{mode}"),
            prompt: format!("fixture:{mode}"),
            output_policy: policy,
            ..Default::default()
        })?)
        .await?
        .into_inner())
}

fn declared(required: &[&str], git: OutputGitMode, max_bytes: u64) -> TaskOutputPolicy {
    TaskOutputPolicy {
        directory: Some("deliverables".into()),
        required: required.iter().map(|path| (*path).into()).collect(),
        include: Some(OutputPathPatterns {
            patterns: vec!["deliverables/**".into(), "workspace.txt".into()],
        }),
        exclude: vec!["deliverables/private/**".into()],
        git: git as i32,
        max_bytes: Some(max_bytes),
        ..Default::default()
    }
}

async fn download(
    runtime: &Runtime<'_>,
    fixture: &Fixture,
    artifact: &str,
    path: &str,
) -> Result<Vec<u8>> {
    let destination = fixture.root.join(format!("artifact-{}", Uuid::new_v4()));
    let output = timeout(
        WAIT,
        runtime
            .credentials
            .command(&[
                "artifact",
                "--gateway",
                &runtime.endpoint,
                "download",
                artifact,
                "--path",
                path,
                "--output",
                destination.to_str().context("download destination")?,
            ])
            .output(),
    )
    .await??;
    ensure!(
        output.status.success(),
        "artifact download failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(std::fs::read(destination)?)
}

async fn worker_exit(worker: Child) -> Result<()> {
    let output = timeout(WAIT, worker.wait_with_output()).await??;
    ensure!(
        output.status.success(),
        "remote output Worker Host failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

async fn frozen_outputs_survive_worker_restart(
    runtime: &mut Runtime<'_>,
    fixture: &Fixture,
    provider: RemoteWorkspace,
) -> Result<()> {
    let mode = "remote-output-auto";
    let submitted = submit(runtime, mode, None).await?;
    let hold = fixture.root.join("hold-stop");
    std::fs::write(&hold, b"held")?;
    let mut worker = runtime.worker_with_remote(fixture, mode, false, Some(provider))?;
    let deadline = Instant::now() + WAIT;
    let (capture, stop) = loop {
        let trace = fixture.provider_trace()?;
        if let (Some(capture), Some(stop)) = (
            trace.iter().find(|entry| entry["type"] == "capture"),
            trace.iter().find(|entry| entry["type"] == "stop-wait"),
        ) {
            break (capture.clone(), stop.clone());
        }
        if let Ok(Some(status)) = worker.try_wait() {
            anyhow::bail!(
                "remote output Worker Host exited {status}: {:?}; {:?}",
                fixture.trace()?,
                trace
            );
        }
        ensure!(
            Instant::now() < deadline,
            "remote output cleanup was not reached: {:?}; {:?}",
            fixture.trace()?,
            trace
        );
        sleep(Duration::from_millis(20)).await;
    };
    let running = runtime.task(&submitted.task_id).await?;
    assert_eq!(running.state(), TaskState::Running);
    assert!(running.artifacts.is_empty());
    let attempt_id = running.attempt_id.as_deref().context("producing Attempt")?;
    let path = format!("{}/report.txt", managed_output_directory(attempt_id));
    assert!(
        capture["paths"]
            .as_array()
            .is_some_and(|files| files.contains(&json!(path)))
    );
    let allocation = stop["owner"]["allocationId"]
        .as_str()
        .context("provider allocation")?;
    let snapshot = fixture
        .root
        .join(format!("host-{mode}"))
        .join("artifact-snapshots");
    assert!(
        std::fs::read_dir(snapshot)?
            .filter_map(Result::ok)
            .any(|dir| {
                std::fs::read_dir(dir.path()).is_ok_and(|mut entries| {
                    entries.any(|file| {
                        file.is_ok_and(|file| {
                            file.path()
                                .extension()
                                .is_some_and(|extension| extension == "pending")
                        })
                    })
                })
            }),
        "output receipt was not frozen before provider stop"
    );
    std::fs::write(
        fixture
            .root
            .join("remote-allocations")
            .join(allocation)
            .join("checkout")
            .join(&path),
        b"changed after capture",
    )?;
    worker.kill().await?;
    std::fs::remove_file(&hold)?;
    worker_exit(runtime.worker_with_remote(fixture, mode, false, Some(provider))?).await?;
    let result = runtime.assert_success(&submitted.task_id, mode).await?;
    assert_eq!(result.artifacts.len(), 1);
    let artifact = &result.artifacts[0];
    assert_eq!(artifact.paths.as_slice(), std::slice::from_ref(&path));
    assert_eq!(
        download(runtime, fixture, &artifact.artifact_id, &path).await?,
        b"frozen remote output\n"
    );
    assert_eq!(
        result
            .workspace_delivery
            .context("verified Workspace delivery")?
            .changed_files,
        0
    );
    assert_eq!(
        fixture
            .trace()?
            .iter()
            .filter(|entry| entry["type"] == "started" && entry["mode"] == mode)
            .count(),
        1
    );
    Ok(())
}

async fn policies(
    runtime: &mut Runtime<'_>,
    fixture: &Fixture,
    provider: RemoteWorkspace,
) -> Result<()> {
    let mode = "remote-output-declared";
    let task = submit(
        runtime,
        mode,
        Some(declared(&["reports/report.txt"], OutputGitMode::Ignore, 64)),
    )
    .await?;
    worker_exit(runtime.worker_with_remote(fixture, "local-no-output-capability", false, None)?)
        .await?;
    assert_eq!(
        runtime.task(&task.task_id).await?.state(),
        TaskState::Queued
    );
    worker_exit(runtime.worker_with_remote(fixture, mode, false, Some(provider))?).await?;
    let result = runtime.assert_success(&task.task_id, mode).await?;
    assert_eq!(result.artifacts.len(), 1);
    let artifact = &result.artifacts[0];
    assert_eq!(
        artifact.paths,
        ["deliverables/included.txt", "reports/report.txt"]
    );
    assert_eq!(
        download(
            runtime,
            fixture,
            &artifact.artifact_id,
            "reports/report.txt"
        )
        .await?,
        b"declared outside the default directory\n"
    );

    for (mode, policy, expected) in [
        ("remote-output-empty", None, None),
        (
            "remote-output-missing",
            Some(declared(
                &["deliverables/missing.txt"],
                OutputGitMode::Capture,
                64,
            )),
            Some("Required Task output is missing"),
        ),
        (
            "remote-output-tracked",
            Some(declared(&["workspace.txt"], OutputGitMode::Ignore, 64)),
            Some("Required Task output is missing"),
        ),
        (
            "remote-output-cap",
            Some(declared(&[], OutputGitMode::Ignore, 8)),
            Some("Task output files could not be captured safely"),
        ),
    ] {
        let task = submit(runtime, mode, policy).await?;
        worker_exit(runtime.worker_with_remote(fixture, mode, false, Some(provider))?).await?;
        let result = runtime.task(&task.task_id).await?;
        if let Some(message) = expected {
            assert_eq!(result.state(), TaskState::Failed);
            assert_eq!(result.result.as_deref(), Some(message));
            assert!(result.workspace_delivery.is_none());
        } else {
            assert_eq!(result.state(), TaskState::Succeeded);
        }
        assert!(result.artifacts.is_empty());
    }
    runtime
        .tag(fixture, TAG, HarnessKind::Cursor, &["files:read"])
        .await?;
    let mode = "remote-output-readonly";
    let task = submit(
        runtime,
        mode,
        Some(declared(&["workspace.txt"], OutputGitMode::Capture, 64)),
    )
    .await?;
    worker_exit(runtime.worker_with_remote(fixture, mode, false, Some(provider))?).await?;
    let result = runtime.assert_success(&task.task_id, mode).await?;
    assert_eq!(result.artifacts.len(), 1);
    assert_eq!(result.artifacts[0].paths, ["workspace.txt"]);
    assert_eq!(
        download(
            runtime,
            fixture,
            &result.artifacts[0].artifact_id,
            "workspace.txt"
        )
        .await?,
        b"initial-content\n"
    );
    Ok(())
}

async fn contract(provider: RemoteWorkspace, name: &str) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let fixture = Fixture::prepare(directory.path()).await?;
    std::fs::write(fixture.root.join("provider-kind"), name)?;
    let credentials = Credentials::new();
    let mut runtime = Runtime::start(&fixture.root, &credentials).await?;
    runtime
        .tag(
            &fixture,
            TAG,
            HarnessKind::Cursor,
            &["files:read", "files:write"],
        )
        .await?;
    Box::pin(frozen_outputs_survive_worker_restart(
        &mut runtime,
        &fixture,
        provider,
    ))
    .await?;
    Box::pin(policies(&mut runtime, &fixture, provider)).await?;
    runtime.stop().await
}

#[tokio::test]
async fn cursor_freezes_e2b_outputs_before_provider_stop() -> Result<()> {
    Box::pin(contract(RemoteWorkspace::E2b, "e2b")).await
}

#[tokio::test]
async fn cursor_freezes_modal_outputs_before_provider_stop() -> Result<()> {
    Box::pin(contract(RemoteWorkspace::Modal, "modal")).await
}
