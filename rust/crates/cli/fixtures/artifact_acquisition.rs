use anyhow::{Context, Result, ensure};
use supertag_protocol::{
    authenticated_request,
    v2::{harness_artifacts_client::HarnessArtifactsClient, *},
};
pub async fn exercise(bootstrap: &AdapterBootstrap, run: &HarnessRun) -> Result<String> {
    let task = run.task.as_ref().context("missing Task")?;
    let checkout = std::path::PathBuf::from(
        std::env::var_os(supertag_worker_host::WORKSPACE_DIRECTORY).context("missing checkout")?,
    );
    ensure!(run.may_acquire_artifacts && run.may_materialize_artifacts);
    let mut artifacts = HarnessArtifactsClient::connect(bootstrap.endpoint.clone()).await?;
    if task.prompt == "produce" {
        std::fs::write(checkout.join("evidence.txt"), "immutable evidence\n")?;
        std::fs::write(checkout.join("not-selected.txt"), "separate private file\n")?;
        let receipt = artifacts
            .capture(authenticated_request(
                HarnessCaptureArtifactRequest {
                    operation_id: "source-capture".into(),
                    description: Some(ArtifactDescription {
                        // Credentials in the description are redacted before it leaves the
                        // Worker Host.
                        title: "Reusable evidence from https://bot:url-password-77@git.example/repo.git".into(),
                        kind: "report".into(),
                        summary: Some("auth Basic dXNlcjpwYXNzd29yZA==".into()),
                    }),
                    paths: vec!["evidence.txt".into(), "not-selected.txt".into()],
                    native_session_id: None,
                },
                &bootstrap.token,
                None,
            )?)
            .await?
            .into_inner();
        ensure!(receipt.inputs.is_empty());
        return Ok(format!(
            "artifact:{}",
            receipt.summary.context("missing summary")?.artifact_id
        ));
    }
    let found = artifacts
        .find(authenticated_request(
            HarnessFindArtifactsRequest {
                query: "Reusable".into(),
                ..Default::default()
            },
            &bootstrap.token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(found.artifacts.len() == 1, "expected one prior artifact");
    let id = &found.artifacts[0].artifact_id;
    let inspected = artifacts
        .inspect(authenticated_request(
            GetCapturedArtifactRequest {
                artifact_id: id.clone(),
            },
            &bootstrap.token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(inspected.files.len() == 2);
    let page = artifacts
        .read(authenticated_request(
            HarnessReadArtifactRequest {
                artifact_id: id.clone(),
                operation_id: "read-one".into(),
                path: "evidence.txt".into(),
                offset: 0,
                limit: 1024,
            },
            &bootstrap.token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(page.text == "immutable evidence\n" && !page.truncated);
    let request = HarnessAttachArtifactRequest {
        artifact_id: id.clone(),
        operation_id: "attach-one".into(),
        paths: vec!["evidence.txt".into()],
    };
    let attached = artifacts
        .attach(authenticated_request(
            request.clone(),
            &bootstrap.token,
            None,
        )?)
        .await?
        .into_inner();
    let replay = artifacts
        .attach(authenticated_request(request, &bootstrap.token, None)?)
        .await?
        .into_inner();
    ensure!(attached == replay, "attachment replay changed");
    let directory = checkout.join(&attached.local_path);
    ensure!(std::fs::read_to_string(directory.join("evidence.txt"))? == "immutable evidence\n");
    ensure!(!directory.join("not-selected.txt").exists());
    std::fs::write(
        checkout.join("derived.txt"),
        "derived from selected evidence\n",
    )?;
    let captured = artifacts
        .capture(authenticated_request(
            HarnessCaptureArtifactRequest {
                operation_id: "derived-capture".into(),
                description: Some(ArtifactDescription {
                    title: "Derived result".into(),
                    kind: "report".into(),
                    summary: None,
                }),
                paths: vec!["derived.txt".into()],
                native_session_id: None,
            },
            &bootstrap.token,
            None,
        )?)
        .await?
        .into_inner();
    ensure!(
        captured.inputs
            == vec![ArtifactSelection {
                artifact_id: id.clone(),
                paths: vec!["evidence.txt".into()]
            }],
        "capture lost confirmed input provenance"
    );
    Ok(format!(
        "derived:{}",
        captured
            .summary
            .context("missing derived summary")?
            .artifact_id
    ))
}
