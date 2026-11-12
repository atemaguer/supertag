//! Independent CLI processes exercise repository routing, delivery, and continuation.
use std::{net::SocketAddr, path::Path, process::Stdio, str::FromStr, time::Duration};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{ConnectOptions, Connection, Executor, PgConnection, postgres::PgConnectOptions};
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
        let mut command = self.command(&[
            "worker-host",
            "--gateway",
            public,
            "--adapter",
            ADAPTER,
            "--adapter-arg=--workspace-fixture",
            "--once",
        ]);
        command.arg("--state-directory").arg(state);
        if let Some(source) = source {
            command
                .args(["--workspace-id", "project", "--workspace-source"])
                .arg(source);
        }
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_workspace_delivery_and_cross_host_continuation_survive_gateway_restart()
-> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("runtime.sqlite3").display()
    );
    exercise(&database, directory.path()).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn postgres_workspace_delivery_and_cross_host_continuation_survive_gateway_restart()
-> Result<()> {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .context("PostgreSQL URL file required")?;
    let options = PgConnectOptions::from_str(std::fs::read_to_string(path)?.trim())?;
    let mut admin = PgConnection::connect_with(&options).await?;
    let name = format!("supertag_workspace_process_{}", Uuid::new_v4().simple());
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await?;
    let database = options.database(&name).to_url_lossy().to_string();
    let directory = tempfile::tempdir()?;
    let path = directory.path().to_owned();
    let result = tokio::spawn(async move { exercise(&database, &path).await }).await;
    let cleanup = admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await;
    admin.close().await?;
    cleanup?;
    result.context("workspace process test panicked")?
}
