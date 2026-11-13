//! Separate Control Plane and Worker Host processes stage a read-only
//! Workspace Volume copy for a real Codex Task, then remove it at cleanup, and
//! write a read-write copy's changes back to its Volume.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    net::SocketAddr, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{Instant, sleep, timeout},
};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(60);

struct Credentials {
    gateway: String,
    operator: String,
    host: String,
}

impl Credentials {
    fn new() -> Self {
        Self {
            gateway: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
            operator: Uuid::new_v4().to_string(),
            host: supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
        }
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(BINARY);
        command
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        command
    }
    fn operator(&self, args: &[&str], public: &str) -> Command {
        let mut command = self.command(args);
        command.args(["--control-plane", public]);
        command
    }
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

async fn json_output(command: Command) -> Result<Value> {
    Ok(serde_json::from_slice(&success(command).await?.stdout)?)
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

fn private(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn file_url(path: &Path) -> Result<String> {
    Ok(format!(
        "file://{}",
        path.to_str().context("fixture path is not UTF-8")?
    ))
}

async fn exercise(database: &str, directory: &Path) -> Result<()> {
    let directory = directory.canonicalize()?;
    let repository = directory.join("repository");
    std::fs::create_dir(&repository)?;
    git(&repository, &["init", "--quiet"]).await?;
    std::fs::write(repository.join("README.md"), "repository\n")?;
    git(&repository, &["add", "README.md"]).await?;
    git(&repository, &["commit", "--quiet", "-m", "Initial"]).await?;
    let base = git(&repository, &["rev-parse", "HEAD"]).await?;

    let source = directory.join("data");
    std::fs::create_dir_all(source.join("nested"))?;
    std::fs::write(source.join("rows.csv"), "id,value\n1,42\n")?;
    std::fs::write(source.join("nested/notes.txt"), "fixture notes")?;
    let root = directory.join("mounts");
    private(&root)?;
    let state = directory.join("host-state");
    private(&state)?;
    let home = directory.join("home");
    private(&home.join(".codex"))?;
    let auth = home.join(".codex/auth.json");
    std::fs::write(
        &auth,
        r#"{"tokens":{"access_token":"fixture-mount","refresh_token":"fixture-mount"}}"#,
    )?;
    std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o600))?;
    let fake = directory.join("codex-fixture");
    std::fs::write(
        &fake,
        include_str!("fixtures/workspace_mount_app_server.py"),
    )?;
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700))?;
    let source_url = file_url(&source)?;
    let mappings = directory.join("mappings.json");
    std::fs::write(
        &mappings,
        serde_json::to_vec(&json!([{
            "volumeId": "data",
            "source": source_url,
            "destinationRoot": root,
        }]))?,
    )?;
    let declarations = directory.join("mounts.json");
    let destination = root.join("data");
    let editable = directory.join("editable.json");
    std::fs::write(
        &editable,
        serde_json::to_vec(&json!([{
            "volumeId": "data",
            "destination": destination,
            "maxBytes": 1_048_576,
            "access": "read-write",
        }]))?,
    )?;
    std::fs::write(
        &declarations,
        serde_json::to_vec(&json!([{
            "volumeId": "data",
            "destination": destination,
            "maxBytes": 1_048_576,
        }]))?,
    )?;

    let credentials = Credentials::new();
    let mut plane = credentials.command(&["control-plane"]);
    plane.env("SUPERTAG_DATABASE_URL", database);
    plane
        .arg("--transfer-directory")
        .arg(directory.join("transfers"));
    let (mut plane, public) = service(plane).await?;

    let volume = json_output(credentials.command(&[
        "workspace-volume",
        "--control-plane",
        &public,
        "put",
        "data",
        "--source",
        &source_url,
    ]))
    .await?;
    assert_eq!(volume["revision"], 1);
    let declarations = declarations.to_str().context("path is not UTF-8")?;
    let editable = editable.to_str().context("path is not UTF-8")?;
    let put_tag_with = |id: &str, allow: &[&str], declarations: &str| {
        let mut args = vec![
            "tag",
            "put",
            id,
            "--instructions",
            "Read the mounted data.",
            "--harness",
            "codex",
            "--workspace-id",
            "project",
            "--workspace-base",
            &base,
            "--workspace-mounts",
            declarations,
        ];
        for action in allow {
            args.extend(["--allow", action]);
        }
        credentials.operator(&args, &public)
    };
    let put_tag = |id: &str, allow: &[&str]| put_tag_with(id, allow, declarations);
    json_output(put_tag("reader", &["files:read"])).await?;
    let tag = json_output(credentials.operator(&["get", "tag", "reader"], &public)).await?;
    assert_eq!(
        tag["workspace_mounts"][0]["destination"],
        json!(destination),
        "{tag}"
    );
    assert!(tag["workspace_mounts"][0]["volume"].is_null(), "{tag}");
    // Tags that could run commands, or write a read-write copy without
    // files:write, are refused at admission.
    json_output(put_tag("runner", &["files:read", "commands:execute"])).await?;
    json_output(put_tag_with("unwritable", &["files:read"], editable)).await?;
    for tag in ["runner", "unwritable"] {
        let refused = output(credentials.operator(
            &["task", "submit", "--tag", tag, "--session", "w", "Write"],
            &public,
        ))
        .await?;
        ensure!(!refused.status.success(), "{tag} admitted mounts");
    }

    let task = json_output(credentials.operator(
        &[
            "task",
            "submit",
            "--tag",
            "reader",
            "--session",
            "s",
            "Summarize",
        ],
        &public,
    ))
    .await?;
    let task_id = task["task_id"].as_str().context("missing Task ID")?;
    assert_eq!(task["workspace"]["mounts"][0]["volume"]["revision"], 1);

    let worker = || {
        let mut command = credentials.command(&[
            "worker-host",
            "--control-plane",
            &public,
            "--harness",
            "codex",
            "--codex-model",
            "fixture-model",
            "--once",
        ]);
        command
            .arg("--codex-path")
            .arg(&fake)
            .arg("--state-directory")
            .arg(&state)
            .args(["--workspace-id", "project", "--workspace-source"])
            .arg(&repository)
            .arg("--workspace-mount-mappings")
            .arg(&mappings)
            .env("HOME", &home);
        command
    };
    let ran = output(worker()).await?;
    let stderr = String::from_utf8_lossy(&ran.stderr);
    ensure!(ran.status.success(), "Worker Host failed: {stderr}");
    let settled = json_output(credentials.operator(&["get", "task", task_id], &public)).await?;
    assert_eq!(
        settled["state"], "TASK_STATE_SUCCEEDED",
        "{settled} {stderr}"
    );
    assert_eq!(
        settled["result"],
        "data: id,value\n1,42 | fixture notes | writable=[]"
    );
    // Cleanup removed the copy and its receipts; the source is unchanged.
    assert_eq!(std::fs::read_dir(&root)?.count(), 0);
    assert!(
        !state.join("workspace-mounts").exists()
            || std::fs::read_dir(state.join("workspace-mounts"))?.count() == 0
    );
    assert_eq!(
        std::fs::read_to_string(source.join("rows.csv"))?,
        "id,value\n1,42\n"
    );
    assert!(!source.join("new.txt").exists());

    // A read-write copy's changes are written back to the Volume directly,
    // and the Task records only the summary.
    json_output(put_tag_with(
        "editor",
        &["files:read", "files:write"],
        editable,
    ))
    .await?;
    let edit = json_output(credentials.operator(
        &[
            "task",
            "submit",
            "--tag",
            "editor",
            "--session",
            "edit",
            "Edit the data",
        ],
        &public,
    ))
    .await?;
    let edit_id = edit["task_id"].as_str().context("missing Task ID")?;
    assert_eq!(edit["workspace"]["mounts"][0]["access"], "read-write");
    let ran = output(worker()).await?;
    let stderr = String::from_utf8_lossy(&ran.stderr);
    ensure!(ran.status.success(), "Worker Host failed: {stderr}");
    let edited = json_output(credentials.operator(&["get", "task", edit_id], &public)).await?;
    assert_eq!(edited["state"], "TASK_STATE_SUCCEEDED", "{edited} {stderr}");
    assert_eq!(edited["result"], "edited data");
    assert_eq!(
        std::fs::read_to_string(source.join("rows.csv"))?,
        "id,value\n1,43\n"
    );
    assert_eq!(
        std::fs::read_to_string(source.join("reports/new.txt"))?,
        "created"
    );
    // Deletions are not written back.
    assert!(source.join("nested/notes.txt").exists());
    let writes = &edited["workspace_mount_writes"];
    assert_eq!(writes.as_array().map(Vec::len), Some(1), "{edited}");
    assert_eq!(writes[0]["attempt_id"], edited["attempt_id"]);
    let write = &writes[0]["writes"][0];
    assert_eq!(write["status"], "complete", "{write}");
    assert_eq!(write["volume_id"], "data");
    assert_eq!(write["skipped"], 0);
    let mut keys: Vec<_> = write["files"]
        .as_array()
        .context("missing files")?
        .iter()
        .map(|file| file["key"].as_str().unwrap_or_default().to_owned())
        .collect();
    keys.sort();
    assert_eq!(keys, ["reports/new.txt", "rows.csv"]);
    let described = json_output(
        credentials.operator(&["describe", "task", edit_id, "--output", "json"], &public),
    )
    .await?;
    assert_eq!(described["workspace_mount_writes"], *writes);
    assert_eq!(std::fs::read_dir(&root)?.count(), 0);
    // Restore the source for the cases below.
    std::fs::write(source.join("rows.csv"), "id,value\n1,42\n")?;
    std::fs::remove_dir_all(source.join("reports"))?;

    // A refused write-back writes nothing and fails the Task, which still
    // records the summary.
    let refused = json_output(credentials.operator(
        &[
            "task",
            "submit",
            "--tag",
            "editor",
            "--session",
            "refused",
            "Edit the data with a hard link",
        ],
        &public,
    ))
    .await?;
    let refused_id = refused["task_id"].as_str().context("missing Task ID")?;
    let ran = output(worker()).await?;
    let stderr = String::from_utf8_lossy(&ran.stderr);
    ensure!(ran.status.success(), "Worker Host failed: {stderr}");
    let refused = json_output(credentials.operator(&["get", "task", refused_id], &public)).await?;
    assert_eq!(refused["state"], "TASK_STATE_FAILED", "{refused} {stderr}");
    assert_eq!(
        refused["result"],
        "Workspace Volume write-back was partial or refused"
    );
    let write = &refused["workspace_mount_writes"][0]["writes"][0];
    assert_eq!(write["status"], "refused", "{refused}");
    assert_eq!(write["error"]["key"], "alias.csv", "{write}");
    assert_eq!(
        std::fs::read_to_string(source.join("rows.csv"))?,
        "id,value\n1,42\n"
    );
    assert!(!source.join("reports").exists() && !source.join("alias.csv").exists());
    assert_eq!(std::fs::read_dir(&root)?.count(), 0);

    // Cancellation and a Host crash during execution both end with the copy removed.
    for case in ["cancel", "crash"] {
        let held = json_output(credentials.operator(
            &[
                "task",
                "submit",
                "--tag",
                "reader",
                "--session",
                case,
                "Hold the mount",
            ],
            &public,
        ))
        .await?;
        let held_id = held["task_id"].as_str().context("missing Task ID")?;
        let mut running = worker();
        running.stdout(Stdio::null()).stderr(Stdio::null());
        let mut running = running.spawn()?;
        let deadline = Instant::now() + WAIT;
        while !destination.join("rows.csv").exists() {
            ensure!(Instant::now() < deadline, "{case}: mount was never staged");
            sleep(Duration::from_millis(20)).await;
        }
        let mode = std::fs::metadata(&destination)?.permissions().mode() & 0o777;
        assert_eq!(mode, 0o500, "{case}");
        if case == "cancel" {
            let cancelled =
                json_output(credentials.operator(&["task", "cancel", held_id], &public)).await?;
            assert_eq!(cancelled["state"], "TASK_STATE_CANCELLED");
            ensure!(
                timeout(WAIT, running.wait()).await??.success(),
                "cancelled Host did not settle cleanup"
            );
        } else {
            // Kill the Host while the harness reads the mount.
            let journal = state.join("attempt.json");
            while serde_json::from_slice::<Value>(&std::fs::read(&journal)?)?["stage"]
                != "executing"
            {
                ensure!(Instant::now() < deadline, "Attempt never started executing");
                sleep(Duration::from_millis(20)).await;
            }
            running.kill().await?;
            running.wait().await?;
            assert!(destination.exists(), "the crashed Host already cleaned up");
            let attempt = json_output(credentials.operator(&["get", "task", held_id], &public))
                .await?["attempt_id"]
                .as_str()
                .context("missing Attempt")?
                .to_owned();
            // The operator records the stopped Attempt once its lease lapses.
            let deadline = Instant::now() + Duration::from_secs(90);
            loop {
                let resolved = output(credentials.operator(
                    &[
                        "task",
                        "resolve-attempt",
                        held_id,
                        &attempt,
                        "--decision",
                        "failed",
                        "--evidence",
                        "Worker Host process was killed by the test",
                        "--confirmed-stopped",
                        "--operation-id",
                        "crash-recovery",
                    ],
                    &public,
                ))
                .await?;
                if resolved.status.success() {
                    break;
                }
                ensure!(
                    Instant::now() < deadline,
                    "recovery was never accepted: {}",
                    String::from_utf8_lossy(&resolved.stderr)
                );
                sleep(Duration::from_secs(1)).await;
            }
            // The restarted Host settles the journaled Attempt and cleans up.
            success(worker()).await?;
            let failed =
                json_output(credentials.operator(&["get", "task", held_id], &public)).await?;
            assert_eq!(failed["state"], "TASK_STATE_FAILED");
        }
        assert_eq!(std::fs::read_dir(&root)?.count(), 0, "{case}");
        assert!(
            std::fs::read_dir(state.join("workspace-mounts"))?
                .next()
                .is_none(),
            "{case}"
        );
    }

    // Retargeting the Volume leaves a queued Task unplaceable on this Host.
    let queued = json_output(credentials.operator(
        &[
            "task",
            "submit",
            "--tag",
            "reader",
            "--session",
            "next",
            "Summarize again",
        ],
        &public,
    ))
    .await?;
    let queued_id = queued["task_id"].as_str().context("missing Task ID")?;
    let other = directory.join("other-data");
    std::fs::create_dir(&other)?;
    json_output(credentials.command(&[
        "workspace-volume",
        "--control-plane",
        &public,
        "put",
        "data",
        "--source",
        &file_url(&other)?,
        "--expected-revision",
        "1",
    ]))
    .await?;
    success(worker()).await?;
    let still = json_output(credentials.operator(&["get", "task", queued_id], &public)).await?;
    assert_eq!(still["state"], "TASK_STATE_QUEUED", "{still}");
    assert_eq!(std::fs::read_dir(&root)?.count(), 0);

    plane.kill().await?;
    plane.wait().await?;
    Ok(())
}

database_tests! {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    stages_workspace_copies_and_writes_read_write_changes_back;
}

async fn stages_workspace_copies_and_writes_read_write_changes_back(
    database: String,
) -> Result<()> {
    let directory = tempfile::tempdir()?;
    exercise(&database, directory.path()).await
}
