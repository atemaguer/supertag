//! Operator Tokens and the audit log through separate Control Plane and Gateway processes.
//!
//! The admin operator token issues, rotates, and revokes an Operator Token with the CLI. A running
//! Gateway refuses the revoked token on new calls and ends a Watch stream it already opened.
use std::{
    fs::File,
    io::{BufRead, BufReader},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sqlx::{Connection, Executor};
use supertag_protocol::{authenticated_request, v2::*};
use tokio::time::sleep;
use tonic::{Code, Request, transport::Endpoint};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(15);

struct Credentials {
    gateway: String,
    admin: String,
}

impl Credentials {
    fn new() -> Self {
        Self {
            gateway: Uuid::new_v4().to_string(),
            admin: Uuid::new_v4().to_string(),
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(BINARY);
        command
            .args(args)
            .env_clear()
            .stdin(Stdio::null())
            .env("SUPERTAG_GATEWAY_TOKEN", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.admin);
        command
    }
}

fn request<T>(value: T, token: &str) -> Result<Request<T>> {
    let mut request = authenticated_request(value, token, None)?;
    request.set_timeout(Duration::from_secs(5));
    Ok(request)
}

struct Process {
    child: Child,
    log: PathBuf,
}

impl Process {
    fn spawn(mut command: Command, directory: &Path) -> Result<Self> {
        let log = directory.join(format!("{}.log", Uuid::new_v4()));
        let child = command
            .stdout(Stdio::piped())
            .stderr(File::create(&log)?)
            .spawn()?;
        Ok(Self { child, log })
    }

    async fn address(&mut self) -> Result<String> {
        let stdout = self.child.stdout.take().context("missing stdout")?;
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
            let _ = tx.send(result);
        });
        let end = Instant::now() + WAIT;
        let line = loop {
            match rx.try_recv() {
                Ok(line) => break line?,
                Err(mpsc::TryRecvError::Empty) => {}
                Err(error) => return Err(error.into()),
            }
            ensure!(
                self.child.try_wait()?.is_none(),
                "service exited: {}",
                std::fs::read_to_string(&self.log)?
            );
            ensure!(Instant::now() < end, "service readiness timed out");
            sleep(Duration::from_millis(20)).await;
        };
        let address: SocketAddr = line
            .trim()
            .parse()
            .with_context(|| std::fs::read_to_string(&self.log).unwrap_or_default())?;
        ensure!(address.ip().is_loopback() && address.port() > 0);
        Ok(format!("http://{address}"))
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Runs the CLI with `token` as the operator credential and returns its standard output.
fn cli(credentials: &Credentials, token: &str, gateway: &str, args: &[&str]) -> Result<String> {
    let mut command = command(credentials, gateway, args);
    let output = command
        .env("SUPERTAG_OPERATOR_TOKEN", token)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()?;
    ensure!(
        output.status.success(),
        "supertag {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?)
}

/// `supertag COMMAND --gateway URL ARGS...`: the connection belongs to the top-level command.
fn command(credentials: &Credentials, gateway: &str, args: &[&str]) -> Command {
    let mut command = credentials.command(&args[..1]);
    command.args(["--gateway", gateway]).args(&args[1..]);
    command
}

fn cli_failure(
    credentials: &Credentials,
    token: &str,
    gateway: &str,
    args: &[&str],
) -> Result<String> {
    let mut command = command(credentials, gateway, args);
    let output = command.env("SUPERTAG_OPERATOR_TOKEN", token).output()?;
    ensure!(
        !output.status.success(),
        "supertag {} succeeded",
        args.join(" ")
    );
    Ok(String::from_utf8(output.stderr)?)
}

fn json(text: &str) -> Result<Value> {
    Ok(serde_json::from_str(text.trim())?)
}

fn put_tag(tag_id: &str) -> PutTagRequest {
    PutTagRequest {
        tag_id: tag_id.into(),
        instructions: "Review changes".into(),
        ..Default::default()
    }
}

async fn revoked_token_is_refused_by_a_running_gateway(database: &str) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let credentials = Credentials::new();
    let mut command = credentials.command(&["control-plane"]);
    command.env("SUPERTAG_DATABASE_URL", database);
    let mut control = Process::spawn(command, directory.path())?;
    let private = control.address().await?;
    let mut gateway = Process::spawn(
        credentials.command(&["gateway", "--control-plane", &private]),
        directory.path(),
    )?;
    let public = gateway.address().await?;
    let channel = Endpoint::from_shared(public.clone())?.connect_lazy();
    let mut operator = operator_client::OperatorClient::new(channel.clone());
    let mut access = operator_access_client::OperatorAccessClient::new(channel.clone());
    let admin = credentials.admin.clone();

    // The admin token issues a token; its secret is printed once and only its digest is stored.
    let created = json(&cli(
        &credentials,
        &admin,
        &public,
        &["operator-token", "create", "laptop-2"],
    )?)?;
    let secret = created["secret"].as_str().context("secret")?.to_owned();
    assert!(
        secret.starts_with("stop_") && secret.len() == 69,
        "{secret}"
    );
    assert_eq!(created["operator_id"], "token:laptop-2");
    assert_eq!(created["phase"], "active");
    assert_eq!(created["created_by"], "local");
    let listed = cli(&credentials, &admin, &public, &["operator-token", "list"])?;
    assert!(!listed.contains(&secret));
    assert_eq!(json(&listed)?["operator_tokens"][0]["name"], "laptop-2");

    // The token works for ordinary operator calls and acts as token:laptop-2.
    operator
        .put_tag(request(put_tag("reviewer"), &secret)?)
        .await?;
    let listed = json(&cli(
        &credentials,
        &admin,
        &public,
        &["operator-token", "get", "laptop-2"],
    )?)?;
    assert!(listed["last_used_at_ms"].as_i64().is_some());
    // It may not manage Operator Tokens, and a forged or malformed secret is refused.
    let denied = access
        .list_operator_tokens(request(ListOperatorTokensRequest::default(), &secret)?)
        .await
        .unwrap_err();
    assert_eq!(denied.code(), Code::PermissionDenied);
    assert!(
        cli_failure(
            &credentials,
            &secret,
            &public,
            &["operator-token", "create", "other"]
        )?
        .contains("Only the admin operator token manages Operator Tokens")
    );
    for forged in [
        format!("stop_{}", "0".repeat(64)),
        "stop_short".into(),
        credentials.gateway.clone(),
    ] {
        let status = operator
            .list_tags(request(ListTagsRequest::default(), &forged)?)
            .await
            .unwrap_err();
        assert_eq!(status.code(), Code::Unauthenticated, "{forged}");
    }

    // A Watch opened with the token is ended by revocation while it is open.
    let mut events = operator_events_client::OperatorEventsClient::new(channel.clone());
    let mut watch = authenticated_request(WatchRequest::default(), &secret, None)?;
    watch.metadata_mut().remove("grpc-timeout");
    let mut stream = events.watch(watch).await?.into_inner();
    let watching = tokio::spawn(async move {
        loop {
            match stream.message().await {
                Ok(Some(_)) => {}
                Ok(None) => return None,
                Err(error) => return Some(error),
            }
        }
    });
    sleep(Duration::from_millis(1500)).await;
    assert!(!watching.is_finished(), "Watch ended before revocation");
    let revoked = json(&cli(
        &credentials,
        &admin,
        &public,
        &["operator-token", "revoke", "laptop-2"],
    )?)?;
    assert_eq!(revoked["phase"], "revoked");
    let revoked_at = Instant::now();
    let ended = tokio::time::timeout(Duration::from_secs(5), watching)
        .await
        .context("revoked Watch stayed open")??
        .context("revoked Watch ended without an error")?;
    assert_eq!(ended.code(), Code::Unauthenticated, "{ended:?}");
    assert!(ended.message().contains("revoked"), "{ended:?}");
    assert!(revoked_at.elapsed() < Duration::from_secs(3));
    let refused = operator
        .list_tags(request(ListTagsRequest::default(), &secret)?)
        .await
        .unwrap_err();
    assert_eq!(refused.code(), Code::Unauthenticated);
    assert!(refused.message().contains("was revoked"), "{refused:?}");
    // Revoked names stay taken, and revoking again keeps the first revocation.
    assert_eq!(
        json(&cli(
            &credentials,
            &admin,
            &public,
            &["operator-token", "revoke", "laptop-2"]
        )?)?["revoked_at_ms"],
        revoked["revoked_at_ms"]
    );
    assert!(
        cli_failure(
            &credentials,
            &admin,
            &public,
            &["operator-token", "create", "laptop-2"]
        )?
        .contains("never reused")
    );

    // Rotation refuses the previous secret at once and accepts the new one.
    let ci = json(&cli(
        &credentials,
        &admin,
        &public,
        &["operator-token", "create", "ci"],
    )?)?;
    let old = ci["secret"].as_str().context("secret")?.to_owned();
    operator
        .list_tags(request(ListTagsRequest::default(), &old)?)
        .await?;
    let rotated = json(&cli(
        &credentials,
        &admin,
        &public,
        &["operator-token", "rotate", "ci"],
    )?)?;
    let new = rotated["secret"].as_str().context("secret")?.to_owned();
    assert_eq!(rotated["secret_revision"], 2);
    assert_ne!(old, new);
    assert_eq!(
        operator
            .list_tags(request(ListTagsRequest::default(), &old)?)
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    operator.put_tag(request(put_tag("builder"), &new)?).await?;
    // A failed change is recorded by kind only.
    let failed = operator
        .retire_tag(request(
            RetireTagRequest {
                tag_id: "missing".into(),
                dry_run: false,
            },
            &new,
        )?)
        .await
        .unwrap_err();
    assert_eq!(failed.code(), Code::NotFound);
    // Previews are not recorded.
    operator
        .retire_tag(request(
            RetireTagRequest {
                tag_id: "builder".into(),
                dry_run: true,
            },
            &new,
        )?)
        .await?;

    // `supertag audit` lists who did what, on which resource, and the outcome, newest first.
    let audit = json(&cli(
        &credentials,
        &new,
        &public,
        &["audit", "--output", "json", "--limit", "100"],
    )?)?;
    let entries = audit["entries"].as_array().context("entries")?;
    let summary: Vec<(String, String, String, String)> = entries
        .iter()
        .map(|entry| {
            (
                entry["actor"].as_str().unwrap_or_default().to_owned(),
                entry["action"].as_str().unwrap_or_default().to_owned(),
                entry["target"].as_str().unwrap_or_default().to_owned(),
                entry["outcome"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    let expected = [
        ("token:ci", "tag.retire", "Tag", "failed"),
        ("token:ci", "tag.put", "Tag/builder", "succeeded"),
        (
            "local",
            "operator-token.rotate",
            "OperatorToken/ci",
            "succeeded",
        ),
        (
            "local",
            "operator-token.create",
            "OperatorToken/ci",
            "succeeded",
        ),
        ("local", "operator-token.create", "OperatorToken", "failed"),
        (
            "local",
            "operator-token.revoke",
            "OperatorToken/laptop-2",
            "succeeded",
        ),
        (
            "local",
            "operator-token.revoke",
            "OperatorToken/laptop-2",
            "succeeded",
        ),
        (
            "token:laptop-2",
            "operator-token.create",
            "OperatorToken",
            "failed",
        ),
        ("token:laptop-2", "tag.put", "Tag/reviewer", "succeeded"),
        (
            "local",
            "operator-token.create",
            "OperatorToken/laptop-2",
            "succeeded",
        ),
    ]
    .map(|(a, b, c, d)| (a.to_owned(), b.to_owned(), c.to_owned(), d.to_owned()));
    assert_eq!(summary, expected);
    assert_eq!(entries[0]["code"], "NOT_FOUND");
    assert_eq!(entries[1]["method"], "/supertag.runtime.v2.Operator/PutTag");
    let text = cli(
        &credentials,
        &admin,
        &public,
        &["audit", "--actor", "token:ci", "--since", "2020-01-01"],
    )?;
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 3, "{text}");
    assert!(lines[0].starts_with("TIME"));
    assert!(
        lines[1].contains("token:ci") && lines[1].ends_with("failed (NOT_FOUND)"),
        "{text}"
    );
    assert!(
        lines[2].contains("Tag/builder") && lines[2].ends_with("succeeded"),
        "{text}"
    );
    for value in [&secret, &old, &new, &admin, &credentials.gateway] {
        assert!(!audit.to_string().contains(value.as_str()) && !text.contains(value.as_str()));
    }
    assert!(
        cli(
            &credentials,
            &admin,
            &public,
            &["audit", "--actor", "nobody"]
        )?
        .contains("No audit entries match.")
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_revoked_operator_token_is_refused_by_a_running_gateway() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("control.db").display()
    );
    revoked_token_is_refused_by_a_running_gateway(&database).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_revoked_operator_token_is_refused_by_a_running_gateway() -> Result<()> {
    let path = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .context("PostgreSQL test URL file required")?;
    let admin_url = std::fs::read_to_string(path)?;
    let name = format!("supertag_rust_access_runtime_{}", Uuid::new_v4().simple());
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await?;
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await?;
    let mut url = url::Url::parse(admin_url.trim())?;
    url.set_path(&name);
    let outcome = revoked_token_is_refused_by_a_running_gateway(url.as_str()).await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await?;
    admin.close().await?;
    outcome
}
