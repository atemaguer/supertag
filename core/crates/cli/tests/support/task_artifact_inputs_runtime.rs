use super::*;
use sha2::Digest;
use std::sync::Arc;

async fn interrupt_input_receipt(
    services: &LanguageServices,
    root: &Path,
    worker: impl Fn(&str) -> Command,
) -> Result<String> {
    use axum::middleware::{Next, from_fn};
    use tonic::codegen::Service as _;
    use tonic::transport::{Endpoint, Server};

    // A relay in front of the Control Plane that never answers the artifact settlement, so the
    // host stays at the input-preparation boundary.
    let upstream = Endpoint::from_shared(services.public.clone())?
        .connect()
        .await?;
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
    let relay = axum::Router::new()
        .fallback(move |request: axum::extract::Request| {
            let mut upstream = upstream.clone();
            async move {
                let (parts, body) = request.into_parts();
                let request = axum::http::Request::from_parts(parts, tonic::body::Body::new(body));
                let answered = async {
                    std::future::poll_fn(|context| upstream.poll_ready(context)).await?;
                    upstream.call(request).await
                };
                match answered.await {
                    Ok(response) => response.map(axum::body::Body::new),
                    Err(_) => axum::http::Response::builder()
                        .status(502)
                        .body(axum::body::Body::empty())
                        .expect("static response"),
                }
            }
        })
        .layer(gate);
    let routes = tonic::service::Routes::from(relay);
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
        let journal: Value = serde_json::from_slice(&std::fs::read(
            root.join("claude-producer/slots/claude-code-0/attempt.json"),
        )?)?;
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
        // The Worker dies at this stage: its Worklet stays, keeps the entry, and starts another
        // Worker for the same Attempt, which reaches the same boundary.
        let worklet = running.id().context("Worklet PID")?;
        let workers = || -> Result<Vec<i32>> {
            let listed = std::process::Command::new("ps")
                .args(["-axo", "pid=,ppid=,command="])
                .output()?;
            Ok(String::from_utf8(listed.stdout)?
                .lines()
                .filter_map(|line| {
                    let mut parts = line.split_whitespace();
                    let pid = parts.next()?.parse().ok()?;
                    let parent = parts.next()?.parse::<u32>().ok()?;
                    (parent == worklet && line.contains(" __worker ")).then_some(pid)
                })
                .collect())
        };
        let first = workers()?;
        ensure!(first.len() == 1, "one Worker runs the Attempt: {first:?}");
        // SAFETY: the PID is the running Worklet's child.
        unsafe { libc::kill(first[0], libc::SIGKILL) };
        timeout(WAIT, response.notified()).await?;
        ensure!(
            running.try_wait()?.is_none(),
            "the Worklet survives its Worker"
        );
        let again: Value = serde_json::from_slice(&std::fs::read(
            root.join("claude-producer/slots/claude-code-0/attempt.json"),
        )?)?;
        assert_eq!(again["stage"], "preparing_inputs");
        assert_eq!(again["attempt_id"].as_str(), Some(attempt.as_str()));
        ensure!(workers()? != first, "the Worklet started another Worker");
        // The Worklet dies at this stage, and its Worker with it; the next one settles the Attempt.
        running.kill().await?;
        success(worker(&services.public)).await?;
        assert!(!Path::new(checkout).exists());
        Ok(attempt)
    }
    .await;
    runner.abort();
    result
}

database_tests! {
    #[tokio::test]
    #[ignore = "requires SUPERTAG_RUST_TEST_NODE and built Claude adapter"]
    accepted_inputs_reach_an_exclusive_workspace_before_native_launch;
}

async fn accepted_inputs_reach_an_exclusive_workspace_before_native_launch(
    database: String,
) -> Result<()> {
    let Some(node) = crate::prerequisites::env("node", "SUPERTAG_RUST_TEST_NODE")? else {
        return Ok(());
    };
    let root = tempfile::tempdir()?;
    let source = root.path().join("source");
    let base = super::python_artifacts_runtime::checkout(&source).await?;
    let policy = root.path().join("output-policy.json");
    std::fs::write(
        &policy,
        r#"{"directory":"outputs","include":["evidence.txt"],"required":["evidence.txt"],"git":"capture"}"#,
    )?;
    let native = claude_fixture(root.path())?;
    let claude = repo_path("harnesses/claude-code/dist/rust-adapter/entry.js")?;
    let services = LanguageServices::start(root.path(), &database).await?;
    // A fixture Task creates and submits a file through the real declared-output lifecycle.
    services
        .operator(&[
            "tag",
            "put",
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
    let artifacts = crate::holding_host::artifact_directory(root.path());
    let host = |endpoint: &str, state: &str| {
        let mut host = command(&[
            "worker-host",
            "--control-plane",
            endpoint,
            "--harness",
            "claude-code",
        ]);
        host.arg("--state-directory")
            .arg(root.path().join(state))
            .arg("--artifact-directory")
            .arg(&artifacts)
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
    // A host's state directory carries its incarnation, which the holder below replaces, so the
    // producing runs and the consuming run use separate ones.
    let mapped = |endpoint: &str, state: &str| {
        let mut worker = host(endpoint, state);
        worker
            .arg("--once")
            .arg("--workspace-id")
            .arg("evidence")
            .arg("--workspace-source")
            .arg(&source);
        worker
    };
    let producer = |endpoint: &str| mapped(endpoint, "claude-first");
    let worker = |endpoint: &str| mapped(endpoint, "claude-producer");
    success(producer(&services.public)).await?;
    let accepted = services
        .operator(&[
            "task",
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
    success(producer(&services.public)).await?;
    let produced = services
        .operator(&["get", "task", accepted["task_id"].as_str().unwrap()])
        .await?;
    assert_eq!(produced["state"], "TASK_STATE_SUCCEEDED", "{produced}");
    let artifact_id = produced["artifacts"][0]["artifact_id"]
        .as_str()
        .context("submitted artifact")?;
    let input = format!("{artifact_id}:evidence.txt");
    let args = [
        "task",
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

    // The consuming host shares the producer's artifact storage, so it reads the input there; the
    // Control Plane passes no artifact bytes.
    // The accepted Objective Session's harness remains pinned. Verify delivery from
    // Claude's actual manager with the input path supplied before native launch.
    let attempt = interrupt_input_receipt(&services, root.path(), worker).await?;
    let result = services
        .operator(&["get", "task", queued["task_id"].as_str().unwrap()])
        .await?;
    assert_eq!(result["state"], "TASK_STATE_SUCCEEDED", "{result}");
    assert_eq!(result["attempt_id"], attempt);
    assert_eq!(result["result"], "verified supplied Task artifact input");
    assert_eq!(result["workspace_delivery"]["changed_files"], 0);
    assert!(!source.join("inputs").exists());
    services.stop().await
}
