use super::*;
use sha2::Digest;
use std::sync::Arc;

async fn interrupt_input_receipt(
    services: &LanguageServices,
    root: &Path,
    worker: impl Fn(&str) -> Command,
) -> Result<String> {
    use axum::middleware::{Next, from_fn};
    use supertag_gateway::{Gateway, transfers::GatewayTransfers};
    use tonic::{
        service::Routes,
        transport::{Endpoint, Server},
    };

    let channel = Endpoint::from_shared(services.private.clone())?
        .connect()
        .await?;
    let gateway = Gateway::new(
        channel,
        services.gateway_token.clone(),
        services.operator_token.clone(),
        "operator:local".into(),
    )?;
    let transfers = GatewayTransfers::new(gateway.clone(), Some(root.join("blobs")))?
        .with_artifact_volumes(
            supertag_gateway::transfers::volumes::ArtifactVolumeMappings::new(vec![(
                "inputs".into(),
                root.join("volume"),
            )])?,
        )?;
    let response = Arc::new(tokio::sync::Notify::new());
    let gate = {
        let response = response.clone();
        from_fn(move |request: axum::extract::Request, next: Next| {
            let response = response.clone();
            async move {
                let settlement =
                    request.uri().path() == "/supertag.runtime.v2.AttemptArtifacts/Settle";
                let result = next.run(request).await;
                if settlement {
                    response.notify_one();
                    std::future::pending::<()>().await;
                }
                result
            }
        })
    };
    let routes: Routes = Routes::new(gateway.worker_host_service())
        .add_service(gateway.host_enrollment_service())
        .add_service(transfers.attempt_artifacts_service())
        .add_service(transfers.artifact_transfer_service())
        .add_service(transfers.service())
        .into_axum_router()
        .layer(gate)
        .into();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}", listener.local_addr()?);
    let runner = tokio::spawn(
        Server::builder()
            .add_routes(routes)
            .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener)),
    );
    let result = async {
        let mut running = worker(&endpoint)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        timeout(WAIT, response.notified()).await?;
        let journal: Value =
            serde_json::from_slice(&std::fs::read(root.join("claude-producer/attempt.json"))?)?;
        assert_eq!(journal["stage"], "preparing_inputs");
        let checkout = journal["prepared"]["checkout"]["path"]
            .as_str()
            .context("prepared checkout")?;
        let attempt = journal["attempt_id"]
            .as_str()
            .context("Attempt ID")?
            .to_owned();
        let input_root = Path::new(checkout).join(format!(
            "inputs/{:x}",
            sha2::Sha256::digest(attempt.as_bytes())
        ));
        let destination = std::fs::read_dir(input_root)?
            .next()
            .context("materialized input root")??
            .path();
        assert_eq!(
            std::fs::read_to_string(destination.join("evidence.txt"))?,
            "évidence from Python\n"
        );
        running.kill().await?;
        success(worker(&services.public)).await?;
        assert!(!Path::new(checkout).exists());
        Ok(attempt)
    }
    .await;
    runner.abort();
    result
}

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
    let volume = root.path().canonicalize()?.join("volume");
    std::fs::create_dir(&volume)?;
    std::fs::set_permissions(&volume, std::fs::Permissions::from_mode(0o700))?;
    let services = LanguageServices::start_with_volume(root.path(), Some(&volume)).await?;
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
    let worker = |endpoint: &str| {
        let mut host = command(&[
            "worker-host",
            "--gateway",
            endpoint,
            "--once",
            "--harness",
            "claude-code",
        ]);
        host.arg("--workspace-id")
            .arg("evidence")
            .arg("--workspace-source")
            .arg(&source)
            .arg("--state-directory")
            .arg(root.path().join("claude-producer"))
            .arg("--harness-runtime")
            .arg(&node)
            .arg("--harness-entrypoint")
            .arg(&claude)
            .arg("--claude-path")
            .arg(&native)
            .env("SUPERTAG_HOST_TOKEN", &services.host_token)
            .env("ANTHROPIC_API_KEY", "fixture-provider-key");
        host
    };
    success(worker(&services.public)).await?;
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
    success(worker(&services.public)).await?;
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

    services
        .operator(&[
            "volume",
            "put",
            "inputs",
            "--source",
            &format!("file://{}", volume.display()),
            "--operation-id",
            "register-inputs-volume",
        ])
        .await?;
    let copy = services
        .operator(&[
            "volume",
            "copy",
            "inputs",
            artifact_id,
            "--path",
            "evidence.txt",
            "--expected-revision",
            "1",
            "--operation-id",
            "copy-input-evidence",
        ])
        .await?;
    let digest = copy["file"]["blob"]["sha256"]
        .as_str()
        .context("verified Volume copy digest")?;
    std::fs::remove_file(root.path().join("blobs").join(digest))?;
    // The accepted Objective Session's harness remains pinned. Verify delivery from
    // Claude's actual manager with the input path supplied before native launch.
    let attempt = interrupt_input_receipt(&services, root.path(), worker).await?;
    let result = services
        .operator(&["get-task", queued["task_id"].as_str().unwrap()])
        .await?;
    assert_eq!(result["state"], "TASK_STATE_SUCCEEDED", "{result}");
    assert_eq!(result["attempt_id"], attempt);
    assert_eq!(result["result"], "verified supplied Task artifact input");
    assert_eq!(result["workspace_delivery"]["changed_files"], 0);
    assert!(!source.join("inputs").exists());
    assert!(!root.path().join("blobs").join(digest).exists());
    services.stop().await
}
