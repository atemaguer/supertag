use super::*;
use supertag_protocol::v2::{
    CreateObjectiveRequest, TaskArtifactInputSelection, objectives_client::ObjectivesClient,
};

async fn finish_worker(worker: Child) -> Result<()> {
    let output = timeout(WAIT, worker.wait_with_output()).await??;
    ensure!(
        output.status.success(),
        "Worker Host failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

async fn submit(
    runtime: &mut Runtime<'_>,
    session: &str,
    mode: &str,
    inputs: Vec<TaskArtifactInputSelection>,
) -> Result<Task> {
    Ok(runtime
        .operator
        .submit_task(runtime.credentials.request(SubmitTaskRequest {
            tag_id: TAG.into(),
            session_id: session.into(),
            operation_id: Uuid::new_v4().to_string(),
            prompt: format!("fixture:{mode}"),
            input_artifacts: inputs,
            ..Default::default()
        })?)
        .await?
        .into_inner())
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
    let mut objectives = ObjectivesClient::connect(runtime.endpoint.clone()).await?;
    let objective = objectives
        .create_objective(credentials.request(CreateObjectiveRequest {
            operation_id: "artifact-objective".into(),
            objective_id: "artifact-objective".into(),
            owner_tag_id: TAG.into(),
            outcome: "fixture:remote-input-producer".into(),
            ongoing: true,
            ..Default::default()
        })?)
        .await?
        .into_inner();
    let worker = |runtime: &Runtime<'_>, label| {
        runtime.worker_with_remote(&fixture, label, false, Some(provider))
    };
    finish_worker(worker(&runtime, "input-producer")?).await?;
    let produced = runtime
        .assert_success(&objective.starting_task_id, "remote-input-producer")
        .await
        .with_context(|| {
            format!(
                "producer trace: {:?}; provider {:?}",
                fixture.trace(),
                fixture.provider_trace()
            )
        })?;
    let artifact = produced.artifacts.first().context("submitted artifact")?;
    let selection = vec![TaskArtifactInputSelection {
        artifact_id: artifact.artifact_id.clone(),
        paths: artifact.paths.clone(),
        require_accepted: false,
        ..Default::default()
    }];
    let task = submit(
        &mut runtime,
        &objective.session_id,
        "remote-input-consumer",
        selection.clone(),
    )
    .await?;
    let pin = task
        .input_artifacts
        .first()
        .context("admitted source pin")?;
    assert_eq!(pin.source_attempt_id, produced.attempt_id.unwrap());
    assert_eq!(pin.files[0].path, artifact.paths[0]);
    finish_worker(worker(&runtime, "input-consumer")?).await?;
    let consumed = runtime
        .assert_success(&task.task_id, "remote-input-consumer")
        .await
        .with_context(|| {
            format!(
                "consumer trace: {:?}; provider {:?}",
                fixture.trace(),
                fixture.provider_trace()
            )
        })?;
    assert!(consumed.artifacts.is_empty());
    assert_eq!(consumed.workspace_delivery.unwrap().changed_files, 0);
    let trace = fixture.provider_trace()?;
    let stage = trace
        .iter()
        .rev()
        .find(|entry| entry["type"] == "stage")
        .context("input Stage")?;
    let paths = stage["inputPaths"]
        .as_array()
        .context("provider input paths")?;
    assert_eq!(paths.len(), 1);
    let capture = trace
        .iter()
        .rev()
        .find(|entry| entry["type"] == "capture")
        .context("input Capture")?;
    assert!(!capture["paths"].as_array().unwrap().contains(&paths[0]));

    // A provider that violates exclusion cannot turn mounted inputs into a delivery.
    std::fs::write(fixture.root.join("return-private-input"), b"fixture")?;
    let leak = submit(
        &mut runtime,
        &objective.session_id,
        "remote-input-consumer",
        selection.clone(),
    )
    .await?;
    finish_worker(worker(&runtime, "unsafe-input-return")?).await?;
    let result = runtime.task(&leak.task_id).await?;
    assert_eq!(result.state(), TaskState::Failed);
    assert!(result.workspace_delivery.is_none());
    assert!(result.artifacts.is_empty());
    std::fs::remove_file(fixture.root.join("return-private-input"))?;

    let interruption = submit(
        &mut runtime,
        &objective.session_id,
        "remote-input-consumer",
        selection,
    )
    .await?;
    let hold = fixture.root.join("hold-input-stage");
    std::fs::write(&hold, b"fixture")?;
    let mut interrupted = worker(&runtime, "interrupted-input")?;
    let deadline = Instant::now() + WAIT;
    let allocation = loop {
        if let Some(stage) = fixture
            .provider_trace()?
            .into_iter()
            .find(|entry| entry["type"] == "input-stage-wait")
        {
            break stage["owner"].clone();
        }
        ensure!(
            interrupted.try_wait()?.is_none(),
            "Host exited before staging; provider: {:?}",
            fixture.provider_trace()?
        );
        ensure!(Instant::now() < deadline, "remote Stage was not reached");
        sleep(Duration::from_millis(20)).await;
    };
    interrupted.kill().await?;
    std::fs::remove_file(hold)?;
    let recovery = timeout(
        WAIT,
        worker(&runtime, "interrupted-input")?.wait_with_output(),
    )
    .await??;
    ensure!(
        !recovery.status.success(),
        "interrupted remote Attempt unexpectedly reexecuted"
    );
    let trace = fixture.provider_trace()?;
    assert_eq!(
        trace
            .iter()
            .filter(|entry| entry["type"] == "stop" && entry["owner"] == allocation)
            .count(),
        1
    );
    assert_eq!(
        fixture
            .trace()?
            .iter()
            .filter(|entry| entry["type"] == "started" && entry["mode"] == "remote-input-consumer")
            .count(),
        2
    );
    assert!(matches!(
        runtime.task(&interruption.task_id).await?.state(),
        TaskState::Running | TaskState::Uncertain
    ));
    runtime.stop().await
}

#[tokio::test]
async fn cursor_stages_exact_e2b_task_artifact_inputs() -> Result<()> {
    Box::pin(contract(RemoteWorkspace::E2b, "e2b")).await
}

#[tokio::test]
async fn cursor_stages_exact_modal_task_artifact_inputs() -> Result<()> {
    Box::pin(contract(RemoteWorkspace::Modal, "modal")).await
}
