//! Independent CLI processes exercise repository routing, delivery, and continuation.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;

#[path = "support/direct_artifact_runtime.rs"]
mod direct_artifact_runtime;
use std::{net::SocketAddr, path::Path, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};

use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{Instant, sleep, timeout},
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const WAIT: Duration = Duration::from_secs(30);

struct Credentials {
    gateway: String,
    operator: String,
    host: String,
}
impl Credentials {
    fn new() -> Self {
        Self {
            gateway: Uuid::new_v4().to_string(),
            operator: Uuid::new_v4().to_string(),
            host: Uuid::new_v4().to_string(),
        }
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(BINARY);
        command
            .args(args)
            .env_clear()
            .env("SUPERTAG_GATEWAY_TOKEN", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        command
    }
    fn operator(&self, args: &[&str], public: &str) -> Command {
        let mut command = self.command(args);
        command.args(["--gateway", public]);
        command
    }
    fn worker(&self, public: &str, state: &Path, source: Option<&Path>) -> Command {
        self.worker_with_mode(public, state, source, "--workspace-fixture")
    }
    fn worker_with_mode(
        &self,
        public: &str,
        state: &Path,
        source: Option<&Path>,
        mode: &str,
    ) -> Command {
        let mut command = self.command(&[
            "worker-host",
            "--gateway",
            public,
            "--adapter",
            ADAPTER,
            "--once",
        ]);
        command
            .arg(format!("--adapter-arg={mode}"))
            .arg("--state-directory")
            .arg(state);
        if let Some(source) = source {
            command
                .args(["--workspace-id", "project", "--workspace-source"])
                .arg(source);
        }
        command
    }
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    delivered_commit_review_survives_restart_and_notifies_owner_once;
    #[tokio::test]
    artifact_inputs_survive_gateway_restart_and_do_not_enter_workspace_delivery;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    workspace_delivery_and_cross_host_continuation_survive_gateway_restart;
}

async fn delivered_commit_review_survives_restart_and_notifies_owner_once(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    let source = root.join("source");
    std::fs::create_dir(&source)?;
    git(&source, &["init", "--quiet"]).await?;
    std::fs::write(source.join("workspace.txt"), "base\n")?;
    git(&source, &["add", "workspace.txt"]).await?;
    git(&source, &["commit", "--quiet", "-m", "Initial source"]).await?;
    let base = git(&source, &["rev-parse", "HEAD"]).await?;
    let credentials = Credentials::new();
    let plane_command = |listen: &str| {
        let mut plane = credentials.command(&["control-plane", "--listen", listen]);
        plane.env("SUPERTAG_DATABASE_URL", &database);
        plane
    };
    let (mut plane, private) = service(plane_command("127.0.0.1:0")).await?;
    let gateway_command = |listen: &str| {
        let mut gateway =
            credentials.command(&["gateway", "--control-plane", &private, "--listen", listen]);
        gateway
            .arg("--checkpoint-directory")
            .arg(root.join("gateway-artifacts"));
        gateway
    };
    let (mut gateway, public) = service(gateway_command("127.0.0.1:0")).await?;
    let cli = |args: &[&str]| {
        let mut command = credentials.command(&[args[0], "--gateway", &public]);
        command.args(&args[1..]);
        command
    };
    json(cli(&[
        "put-tag",
        "owner",
        "--instructions",
        "Review the delivery",
        "--allow",
        "files:read",
        "--allow",
        "files:write",
        "--workspace-id",
        "project",
        "--workspace-base",
        &base,
    ]))
    .await?;
    json(cli(&[
        "put-tag",
        "reviewer",
        "--instructions",
        "Inspect the exact patch",
        "--allow",
        "files:read",
    ]))
    .await?;
    json(cli(&[
        "team", "create", "release", "--name", "Release", "--member", "owner", "--member",
        "reviewer",
    ]))
    .await?;
    let objective = json(cli(&[
        "objective",
        "create",
        "release",
        "--owner",
        "owner",
        "--team",
        "release",
        "--ongoing",
        "Review the work",
    ]))
    .await?;
    let session = field(&objective, "session_id")?;
    success(credentials.worker_with_mode(
        &public,
        &root.join("owner-start"),
        Some(&source),
        "--start-work-session",
    ))
    .await?;
    let work = json(cli(&[
        "work-sessions",
        "list",
        "--parent-tag",
        "owner",
        "--parent-session",
        session,
    ]))
    .await?;
    let child_id = field(&work["work_sessions"][0], "latest_task_id")?;
    success(credentials.worker(&public, &root.join("child"), Some(&source))).await?;
    let child = json(cli(&["get-task", child_id])).await?;
    assert_eq!(child["state"], "TASK_STATE_SUCCEEDED");
    let commit = field(&child["workspace_delivery"], "head_commit")?;
    assert_ne!(commit, base);

    let list = || cli(&["objective", "list-commit-reviews", "release"]);
    success(credentials.worker_with_mode(
        &public,
        &root.join("owner-report"),
        Some(&source),
        &format!("--request-commit-review={commit}"),
    ))
    .await?;
    let pending = json(list()).await?;
    let pending = pending["reviews"]
        .as_array()
        .context("pending review list")?;
    assert_eq!(pending.len(), 1);
    let request_id = field(&pending[0], "request_id")?;
    assert_eq!(pending[0]["source_task_id"], child_id);
    assert_eq!(pending[0]["commit"], commit);
    assert_eq!(pending[0]["reviewer_tag_id"], "reviewer");
    assert!(pending[0]["verdict"].is_null());

    gateway.kill().await?;
    plane.kill().await?;
    (plane, _) = service(plane_command(private.trim_start_matches("http://"))).await?;
    (gateway, _) = service(gateway_command(public.trim_start_matches("http://"))).await?;
    assert_eq!(json(list()).await?["reviews"][0], pending[0]);
    success(credentials.worker_with_mode(
        &public,
        &root.join("reviewer"),
        None,
        &format!("--record-commit-review={request_id}"),
    ))
    .await?;
    let recorded = json(list()).await?;
    assert_eq!(
        recorded["reviews"]
            .as_array()
            .context("recorded review list")?
            .len(),
        1
    );
    assert_eq!(recorded["reviews"][0]["request_id"], request_id);
    assert_eq!(recorded["reviews"][0]["verdict"]["decision"], "approved");

    // Observe the durable internal notice without treating Objective Sessions as
    // direct operator conversations. Execute it on the owner through the Host.
    let mut db = database::connect(&database).await?;
    let notices: Vec<String> = timeout(WAIT, async {
        loop {
            let ids: Vec<String> = sqlx::query_scalar(
                "SELECT task_id FROM supertag_v2_objective_notices WHERE objective_id='release' AND notice_key LIKE 'review:%'",
            )
            .fetch_all(&mut db)
            .await?;
            if !ids.is_empty() {
                return Ok::<_, anyhow::Error>(ids);
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .context("owner did not receive its review notice")??;
    assert_eq!(notices.len(), 1);
    success(credentials.worker_with_mode(
        &public,
        &root.join("owner-notice"),
        Some(&source),
        &format!("--observe-commit-review={request_id}"),
    ))
    .await?;
    let notice = json(cli(&["get-task", &notices[0]])).await?;
    assert_eq!(notice["state"], "TASK_STATE_SUCCEEDED");
    assert_eq!(notice["tag_id"], "owner");
    assert_eq!(notice["session_id"], session);
    let objective = json(cli(&["objective", "get", "release"])).await?;
    assert_eq!(objective["status"], "OBJECTIVE_STATUS_WORKING");
    gateway.kill().await?;
    plane.kill().await?;
    Ok(())
}

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    timeout(WAIT, stdout.read_line(&mut line))
        .await
        .context("service startup timed out")??;
    let address: SocketAddr = line.trim().parse().context("service endpoint missing")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

async fn output(mut command: Command) -> Result<std::process::Output> {
    Ok(timeout(WAIT, command.output())
        .await
        .context("CLI command timed out")??)
}
async fn success(command: Command) -> Result<std::process::Output> {
    let output = output(command).await?;
    ensure!(
        output.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(output)
}
async fn json(command: Command) -> Result<Value> {
    Ok(serde_json::from_slice(&success(command).await?.stdout)?)
}
fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .with_context(|| format!("missing {name}: {value}"))
}
async fn git(source: &Path, arguments: &[&str]) -> Result<String> {
    let mut command = Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(source)
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid");
    Ok(String::from_utf8(success(command).await?.stdout)?
        .trim()
        .into())
}

async fn exercise(database: &str, directory: &Path) -> Result<()> {
    let source = directory.join("source");
    std::fs::create_dir(&source)?;
    git(&source, &["init", "--quiet"]).await?;
    std::fs::write(source.join("workspace.txt"), "base\n")?;
    git(&source, &["add", "workspace.txt"]).await?;
    git(&source, &["commit", "--quiet", "-m", "Initial source"]).await?;
    let base = git(&source, &["rev-parse", "HEAD"]).await?;
    let config = std::fs::read(source.join(".git/config"))?;
    std::fs::write(source.join("workspace.txt"), "operator dirty work\n")?;
    std::fs::write(
        source.join("operator-only.txt"),
        "uncommitted private note\n",
    )?;

    let credentials = Credentials::new();
    let mut plane = credentials.command(&["control-plane"]);
    plane.env("SUPERTAG_DATABASE_URL", database);
    let (mut plane, private) = service(plane).await?;
    let artifact_store = directory.join("gateway-artifacts");
    let gateway_command = |listen: Option<&str>| {
        let mut command = credentials.command(&["gateway", "--control-plane", &private]);
        command.arg("--checkpoint-directory").arg(&artifact_store);
        if let Some(listen) = listen {
            command.args(["--listen", listen]);
        }
        command
    };
    let (mut gateway, public) = service(gateway_command(None)).await?;
    let tag = json(credentials.operator(
        &[
            "put-tag",
            "builder",
            "--instructions",
            "Improve the repository",
            "--allow",
            "file:write",
            "--workspace-id",
            "project",
            "--workspace-base",
            &base,
        ],
        &public,
    ))
    .await?;
    assert_eq!(tag["tag_id"], "builder");
    let submit = |prompt| {
        credentials.operator(
            &["submit", "--tag", "builder", "--session", "feature", prompt],
            &public,
        )
    };
    let get = |task| credentials.operator(&["get-task", task], &public);
    let first = json(submit("first")).await?;
    assert_eq!(first["workspace"]["base_commit"], base);
    let first_id = field(&first, "task_id")?;

    // A valid host credential alone does not make a machine eligible for this repository.
    success(credentials.worker(&public, &directory.join("unmapped-host"), None)).await?;
    let queued = json(get(first_id)).await?;
    assert_eq!(queued["state"], "TASK_STATE_QUEUED");
    assert!(queued["attempt_id"].is_null());

    success(credentials.worker(&public, &directory.join("first-host"), Some(&source))).await?;
    let first = json(get(first_id)).await?;
    assert_eq!(first["state"], "TASK_STATE_SUCCEEDED", "{first}");
    assert_eq!(first["result"], "Change: first\nWorkspace before:\nbase\n");
    let delivery = &first["workspace_delivery"];
    assert_eq!(delivery["workspace_id"], "project");
    assert_eq!(delivery["base_commit"], base);
    assert_eq!(delivery["start_commit"], base);
    assert_eq!(delivery["changed_files"], 2);
    let first_head = field(delivery, "head_commit")?.to_owned();
    assert_ne!(first_head, base);

    // Restart the public artifact service before downloading or continuing.
    gateway.kill().await?;
    gateway.wait().await?;
    let listen = public
        .strip_prefix("http://")
        .context("invalid public URL")?;
    let (restarted, restored_public) = service(gateway_command(Some(listen))).await?;
    gateway = restarted;
    assert_eq!(restored_public, public);
    let patch = directory.join("review.patch");
    let bundle = directory.join("review.bundle");
    for (kind, path) in [("patch", &patch), ("bundle", &bundle)] {
        let mut download =
            credentials.operator(&["workspace-artifact", first_id, "--kind", kind], &public);
        download.arg("--output").arg(path);
        let receipt = json(download).await?;
        let bytes = std::fs::read(path)?;
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            delivery[kind]["sha256"]
        );
        assert_eq!(
            bytes.len() as u64,
            delivery[kind]["byte_length"]
                .as_u64()
                .context("missing byte length")?
        );
        assert_eq!(receipt["sha256"], delivery[kind]["sha256"]);
    }
    let patch_bytes = std::fs::read(&patch)?;
    assert!(String::from_utf8_lossy(&patch_bytes).contains("GIT binary patch"));
    let mut overwrite = credentials.operator(
        &["workspace-artifact", first_id, "--kind", "patch"],
        &public,
    );
    overwrite.arg("--output").arg(&patch);
    assert!(!output(overwrite).await?.status.success());
    assert_eq!(std::fs::read(&patch)?, patch_bytes);

    // Verify the exported commit independently in an empty repository.
    let review = directory.join("review");
    std::fs::create_dir(&review)?;
    git(&review, &["init", "--quiet"]).await?;
    git(
        &review,
        &[
            "fetch",
            "--quiet",
            bundle.to_str().context("bundle path")?,
            &format!(
                "refs/heads/supertag-deliveries/{}",
                field(delivery, "delivery_id")?
            ),
        ],
    )
    .await?;
    assert_eq!(
        git(&review, &["rev-parse", "FETCH_HEAD"]).await?,
        first_head
    );
    assert_eq!(
        git(&review, &["show", &format!("{first_head}:workspace.txt")]).await?,
        "base\nfirst"
    );
    assert_eq!(
        git(&review, &["show", "-s", "--format=%s", &first_head]).await?,
        "first"
    );
    // The source object store has never received the generated commit.
    let mut absent = Command::new("/usr/bin/git");
    absent
        .arg("-C")
        .arg(&source)
        .args(["cat-file", "-e", &first_head]);
    assert!(!output(absent).await?.status.success());

    let second = json(submit("second")).await?;
    let second_id = field(&second, "task_id")?;
    success(credentials.worker(&public, &directory.join("fresh-second-host"), Some(&source)))
        .await?;
    let second = json(get(second_id)).await?;
    assert_eq!(second["state"], "TASK_STATE_SUCCEEDED", "{second}");
    assert_eq!(second["workspace_delivery"]["start_commit"], first_head);
    assert_eq!(
        second["result"],
        "Change: second\nWorkspace before:\nbase\nfirst\n"
    );
    let second_head = field(&second["workspace_delivery"], "head_commit")?.to_owned();

    let cancelled = json(submit("cancelled-edit")).await?;
    let cancelled_id = field(&cancelled, "task_id")?;
    let mut worker = credentials.worker(&public, &directory.join("cancelled-host"), Some(&source));
    worker
        .arg("--adapter-arg=--wait-for-cancel")
        .stdout(Stdio::null());
    let mut worker = worker.spawn()?;
    let deadline = Instant::now() + WAIT;
    loop {
        let events = success(credentials.operator(&["task-events", cancelled_id], &public)).await?;
        if String::from_utf8_lossy(&events.stdout).contains("workspace edited") {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "workspace fixture never recorded its cancelled edits"
        );
        sleep(Duration::from_millis(20)).await;
    }
    let cancelled_journal = directory.join("cancelled-host/attempt.json");
    let executing: Value = serde_json::from_slice(&std::fs::read(&cancelled_journal)?)?;
    assert_eq!(executing["stage"], "executing");
    let cancelled_checkout =
        std::path::PathBuf::from(field(&executing["prepared"]["checkout"], "path")?);
    assert!(
        std::fs::read_to_string(cancelled_checkout.join("workspace.txt"))?
            .contains("cancelled-edit")
    );
    let cancelled = json(credentials.operator(&["cancel", cancelled_id], &public)).await?;
    assert_eq!(cancelled["state"], "TASK_STATE_CANCELLED");
    ensure!(
        timeout(WAIT, worker.wait()).await??.success(),
        "cancelled host did not settle cleanup"
    );
    let cancelled = json(get(cancelled_id)).await?;
    assert!(cancelled["workspace_delivery"].is_null());
    assert!(
        !cancelled_checkout.exists(),
        "settled cancellation left its checkout behind"
    );
    assert!(
        !cancelled_journal.exists(),
        "terminal cleanup journal was not cleared"
    );
    let third = json(submit("third")).await?;
    let third_id = field(&third, "task_id")?;
    success(credentials.worker(&public, &directory.join("fresh-third-host"), Some(&source)))
        .await?;
    let third = json(get(third_id)).await?;
    assert_eq!(third["state"], "TASK_STATE_SUCCEEDED", "{third}");
    assert_eq!(third["workspace_delivery"]["start_commit"], second_head);
    assert_eq!(
        third["result"],
        "Change: third\nWorkspace before:\nbase\nfirst\nsecond\n"
    );

    assert_eq!(git(&source, &["rev-parse", "HEAD"]).await?, base);
    assert_eq!(std::fs::read(source.join(".git/config"))?, config);
    assert_eq!(
        std::fs::read_to_string(source.join("workspace.txt"))?,
        "operator dirty work\n"
    );
    assert_eq!(
        std::fs::read_to_string(source.join("operator-only.txt"))?,
        "uncommitted private note\n"
    );
    assert!(!source.join("artifact.bin").exists());
    gateway.kill().await?;
    gateway.wait().await?;
    plane.kill().await?;
    plane.wait().await?;
    Ok(())
}

async fn workspace_delivery_and_cross_host_continuation_survive_gateway_restart(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    exercise(&database, directory.path()).await
}

async fn artifact_inputs_survive_gateway_restart_and_do_not_enter_workspace_delivery(
    database: String,
) -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let root = temporary.path();
    let source = root.join("source");
    std::fs::create_dir(&source)?;
    git(&source, &["init", "--quiet"]).await?;
    std::fs::write(source.join("workspace.txt"), "base\n")?;
    git(&source, &["add", "workspace.txt"]).await?;
    git(&source, &["commit", "--quiet", "-m", "base"]).await?;
    let base = git(&source, &["rev-parse", "HEAD"]).await?;
    let credentials = Credentials::new();
    let mut command = credentials.command(&["control-plane"]);
    command.env("SUPERTAG_DATABASE_URL", &database);
    let (mut plane, private) = service(command).await?;
    let gateway_command = |listen: Option<&str>| {
        let mut command = credentials.command(&["gateway", "--control-plane", &private]);
        command
            .arg("--checkpoint-directory")
            .arg(root.join("artifacts"));
        if let Some(listen) = listen {
            command.args(["--listen", listen]);
        }
        command
    };
    let (mut gateway, public) = service(gateway_command(None)).await?;
    json(credentials.operator(
        &[
            "put-tag",
            "builder",
            "--instructions",
            "Use bounded evidence",
            "--allow",
            "files:read",
            "--allow",
            "files:write",
            "--workspace-id",
            "project",
            "--workspace-base",
            &base,
        ],
        &public,
    ))
    .await?;
    for prompt in ["produce", "consume"] {
        let task = json(credentials.operator(
            &[
                "submit",
                "--tag",
                "builder",
                "--session",
                "evidence",
                prompt,
            ],
            &public,
        ))
        .await?;
        success(credentials.worker_with_mode(
            &public,
            &root.join(format!("host-{prompt}")),
            Some(&source),
            "--artifact-acquisition-fixture",
        ))
        .await?;
        let result =
            json(credentials.operator(&["get-task", field(&task, "task_id")?], &public)).await?;
        assert_eq!(result["state"], "TASK_STATE_SUCCEEDED", "{result}");
        if prompt == "produce" {
            assert!(field(&result, "result")?.starts_with("artifact:"));
            gateway.kill().await?;
            gateway.wait().await?;
            gateway = service(gateway_command(Some(
                public.strip_prefix("http://").unwrap(),
            )))
            .await?
            .0;
        } else {
            let derived = field(&result, "result")?
                .strip_prefix("derived:")
                .context("missing derived artifact")?;
            let metadata =
                json(credentials.command(&["artifact", "--gateway", &public, "get", derived]))
                    .await?;
            assert_eq!(metadata["inputs"].as_array().unwrap().len(), 1);
            assert_eq!(
                metadata["inputs"][0]["paths"],
                serde_json::json!(["evidence.txt"])
            );
            let mut command = credentials.operator(
                &[
                    "workspace-artifact",
                    field(&task, "task_id")?,
                    "--kind",
                    "patch",
                ],
                &public,
            );
            let patch = root.join("patch.diff");
            command.arg("--output").arg(&patch);
            success(command).await?;
            let patch = std::fs::read_to_string(patch)?;
            assert!(patch.contains("derived.txt"));
            assert!(!patch.contains("inputs/") && !patch.contains("artifact-"));
        }
    }
    assert_eq!(
        std::fs::read_to_string(source.join("workspace.txt"))?,
        "base\n"
    );
    let cancelled = json(credentials.operator(
        &[
            "submit",
            "--tag",
            "builder",
            "--session",
            "evidence",
            "cancel",
        ],
        &public,
    ))
    .await?;
    let cancelled_id = field(&cancelled, "task_id")?;
    let cancel_state = root.join("host-cancel");
    let mut worker = credentials.worker_with_mode(
        &public,
        &cancel_state,
        Some(&source),
        "--artifact-acquisition-fixture",
    );
    worker
        .arg("--adapter-arg=--wait-for-cancel")
        .stdout(Stdio::null());
    let mut worker = worker.spawn()?;
    let deadline = Instant::now() + WAIT;
    loop {
        let events = success(credentials.operator(&["task-events", cancelled_id], &public)).await?;
        if String::from_utf8_lossy(&events.stdout).contains("artifact attached") {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "artifact attachment never completed"
        );
        sleep(Duration::from_millis(20)).await;
    }
    let executing: Value =
        serde_json::from_slice(&std::fs::read(cancel_state.join("attempt.json"))?)?;
    let checkout = std::path::PathBuf::from(field(&executing["prepared"]["checkout"], "path")?);
    assert!(checkout.join("inputs").exists());
    json(credentials.operator(&["cancel", cancelled_id], &public)).await?;
    ensure!(
        timeout(WAIT, worker.wait()).await??.success(),
        "cancelled artifact consumer did not settle"
    );
    assert!(!checkout.exists() && !cancel_state.join("artifact-inputs").exists());
    let cancelled = json(credentials.operator(&["get-task", cancelled_id], &public)).await?;
    assert_eq!(cancelled["state"], "TASK_STATE_CANCELLED");
    assert!(cancelled["workspace_delivery"].is_null());
    assert!(!source.join("evidence.txt").exists() && !source.join("inputs").exists());
    gateway.kill().await?;
    plane.kill().await?;
    Ok(())
}
