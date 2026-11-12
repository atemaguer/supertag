use super::*;

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_NODE and built Claude adapter"]
async fn accepted_inputs_reach_an_exclusive_workspace_before_native_launch() -> Result<()> {
    let node = std::env::var_os("SUPERTAG_RUST_TEST_NODE").context("Node test executable")?;
    let root = tempfile::tempdir()?;
    let source = root.path().join("source");
    let base = super::python_artifacts_runtime::checkout(&source).await?;
    let policy = root.path().join("output-policy.json");
    std::fs::write(
        &policy,
        r#"{"directory":"outputs","include":["evidence.txt"],"required":["evidence.txt"],"git":"capture"}"#,
    )?;
    let native = claude_fixture(root.path())?;
    let claude = repo_path("packages/runtime/harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let services = LanguageServices::start(root.path()).await?;
    let worker = |state: &str, harness: &str, runtime: &Path, entry: &Path| {
        let mut host = services.worker(harness, &root.path().join(state), runtime, entry);
        host.arg("--workspace-id")
            .arg("evidence")
            .arg("--workspace-source")
            .arg(&source);
        host
    };

    // A fixture Task creates and submits a file through the real declared-output lifecycle.
    services
        .operator(&[
            "put-tag",
            "input-owner",
            "--instructions",
            "Read the admitted input files.",
            "--harness",
            "claude-code",
            "--allow",
            "files:read",
            "--workspace-id",
            "evidence",
            "--workspace-base",
            &base,
        ])
        .await?;
    let objective = services
        .operator(&[
            "objective",
            "create",
            "input-objective",
            "--owner",
            "input-owner",
            "--ongoing",
            "Share exact findings from the current Objective.",
        ])
        .await?;
    let session = objective["session_id"]
        .as_str()
        .context("Objective Session")?;
    let producer = || {
        let mut host = worker("claude-producer", "claude-code", Path::new(&node), &claude);
        host.arg("--claude-path")
            .arg(&native)
            .env("ANTHROPIC_API_KEY", "fixture-provider-key");
        host
    };
    success(producer()).await?;
    let accepted = services
        .operator(&[
            "submit",
            "--tag",
            "input-owner",
            "--session",
            session,
            "--outputs",
            policy.to_str().context("policy path")?,
            "Submit evidence for a subsequent Task.",
        ])
        .await?;
    success(producer()).await?;
    let produced = services
        .operator(&["get-task", accepted["task_id"].as_str().unwrap()])
        .await?;
    assert_eq!(produced["state"], "TASK_STATE_SUCCEEDED", "{produced}");
    let artifact_id = produced["artifacts"][0]["artifact_id"]
        .as_str()
        .context("submitted artifact")?;
    let input = format!("{artifact_id}:evidence.txt");
    let args = [
        "submit",
        "--tag",
        "input-owner",
        "--session",
        session,
        "--artifact-input",
        &input,
        "--operation-id",
        "exact-input",
        "task-artifact-consumer",
    ];
    let queued = services.operator(&args).await?;
    assert_eq!(queued["input_artifacts"][0]["artifact_id"], artifact_id);
    assert_eq!(
        queued["input_artifacts"][0]["source_attempt_id"],
        produced["attempt_id"]
    );
    assert_eq!(
        queued["input_artifacts"][0]["files"][0]["path"],
        "evidence.txt"
    );
    assert_eq!(services.operator(&args).await?, queued);

    // The accepted Objective Session's harness remains pinned. Verify delivery from
    // Claude's actual manager with the input path supplied before native launch.
    success(producer()).await?;
    let result = services
        .operator(&["get-task", queued["task_id"].as_str().unwrap()])
        .await?;
    assert_eq!(result["state"], "TASK_STATE_SUCCEEDED", "{result}");
    assert_eq!(result["result"], "verified supplied Task artifact input");
    assert_eq!(result["workspace_delivery"]["changed_files"], 0);
    assert!(!source.join("inputs").exists());
    services.stop().await
}
