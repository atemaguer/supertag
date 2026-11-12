use super::*;

const EVIDENCE: &str = "évidence from Python\n";

async fn checkout(root: &Path) -> Result<String> {
    std::fs::create_dir(root)?;
    let git = |args: &[&str]| {
        let mut command = Command::new("/usr/bin/git");
        command
            .current_dir(root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args([
                "-c",
                "user.name=SuperTag Fixture",
                "-c",
                "user.email=fixture@example.invalid",
            ])
            .args(args);
        command
    };
    success(git(&["init", "--quiet"])).await?;
    std::fs::write(root.join("evidence.txt"), EVIDENCE)?;
    std::fs::write(root.join("derived.txt"), "derived evidence\n")?;
    success(git(&["add", "evidence.txt", "derived.txt"])).await?;
    success(git(&["commit", "--quiet", "-m", "Fixture evidence"])).await?;
    Ok(
        String::from_utf8(success(git(&["rev-parse", "HEAD"])).await?)?
            .trim()
            .to_owned(),
    )
}

async fn run(
    services: &LanguageServices,
    mut worker: Command,
    tag: &str,
    session: &str,
    prompt: &str,
) -> Result<Value> {
    let accepted = services
        .operator(&["submit", "--tag", tag, "--session", session, prompt])
        .await?;
    let task_id = accepted["task_id"].as_str().context("accepted Task ID")?;
    worker.env("OPENAI_API_KEY", "python-artifact-fixture-key");
    success(worker).await?;
    let task = services.operator(&["get-task", task_id]).await?;
    assert_eq!(task["state"], "TASK_STATE_SUCCEEDED", "{task}");
    Ok(task)
}

async fn captured(services: &LanguageServices, task: &Value) -> Result<Value> {
    let task_id = task["task_id"].as_str().context("producing Task ID")?;
    let page = services
        .operator(&["artifact", "list", "--task", task_id])
        .await?;
    let captures = page["artifacts"].as_array().context("captured artifacts")?;
    assert_eq!(captures.len(), 1);
    assert_eq!(
        captures[0]["producer"]["harness"],
        "HARNESS_KIND_OPENAI_AGENTS"
    );
    assert_eq!(captures[0]["producer"]["task_id"], task_id);
    let id = captures[0]["artifact_id"].as_str().context("artifact ID")?;
    services.operator(&["artifact", "get", id]).await
}

#[tokio::test]
#[ignore = "requires SUPERTAG_RUST_TEST_AGENTS_PYTHON with the Python SDK runtime and agents extras installed"]
async fn python_agents_sdk_uses_attempt_scoped_artifact_tools() -> Result<()> {
    let interpreter = std::env::var_os("SUPERTAG_RUST_TEST_AGENTS_PYTHON")
        .context("installed Python Agents test interpreter required")?;
    let fixture = repo_path("sdks/python/tests/fixtures/openai_agents_runtime.py")?;
    let directory = tempfile::tempdir()?;
    let source = directory.path().join("source");
    let base = checkout(&source).await?;
    let services = LanguageServices::start(directory.path()).await?;
    let worker = |phase: &str, workspace: bool| {
        let mut command = services.worker(
            "openai-agents",
            &directory.path().join(phase),
            Path::new(&interpreter),
            &fixture,
        );
        if workspace {
            command
                .arg("--workspace-id")
                .arg("evidence")
                .arg("--workspace-source")
                .arg(&source);
        }
        command
    };

    services
        .operator(&[
            "put-tag",
            "python-artifacts",
            "--instructions",
            "Use the admitted artifact tools.",
            "--harness",
            "openai-agents",
            "--allow",
            "files:read",
            "--workspace-id",
            "evidence",
            "--workspace-base",
            &base,
        ])
        .await?;
    let producer = run(
        &services,
        worker("producer", true),
        "python-artifacts",
        "artifact-session",
        "artifact-producer",
    )
    .await?;
    let first = captured(&services, &producer).await?;
    let id = first["summary"]["artifact_id"]
        .as_str()
        .context("producer artifact ID")?;
    assert_eq!(first["files"][0]["path"], "evidence.txt");
    assert_eq!(first["inputs"], serde_json::json!([]));

    let consumer = run(
        &services,
        worker("consumer", true),
        "python-artifacts",
        "artifact-session",
        "artifact-consumer",
    )
    .await?;
    let derived = captured(&services, &consumer).await?;
    assert_eq!(derived["files"][0]["path"], "derived.txt");
    assert_eq!(
        derived["inputs"],
        serde_json::json!([{"artifact_id": id, "paths": ["evidence.txt"]}])
    );
    assert_eq!(consumer["workspace_delivery"]["changed_files"], 0);
    assert!(!source.join("inputs").exists());

    services
        .operator(&[
            "put-tag",
            "python-outsider",
            "--instructions",
            "Attempt to read foreign artifact metadata.",
            "--harness",
            "openai-agents",
        ])
        .await?;
    run(
        &services,
        worker("outsider", false),
        "python-outsider",
        "other-session",
        &format!("artifact-foreign {id}"),
    )
    .await?;
    services.stop().await
}
