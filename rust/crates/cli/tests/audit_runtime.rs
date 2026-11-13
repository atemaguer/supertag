//! Operator access through a Control Plane process: an audit entry commits
//! with the change it records, Worker Hosts joining with an Auth Key are recorded under that key,
//! and `supertag connect` saves a proven operator token for `--control-plane NAME`.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[macro_use]
#[path = "support/database.rs"]
mod database;
#[path = "support/protocol.rs"]
mod protocol;

use std::{net::SocketAddr, path::Path, process::Stdio, time::Duration};

use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use supertag_protocol::{
    authenticated_request,
    v2::{EnrollRequest, PrincipalRole, enrollments_client::EnrollmentsClient},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};
use tonic::Code;
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(15);

fn binary(args: &[&str]) -> Command {
    let mut command = Command::new(BINARY);
    command
        .args(args)
        .env_clear()
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().context("service stdout missing")?);
    let mut line = String::new();
    timeout(WAIT, stdout.read_line(&mut line))
        .await
        .context("service did not start")??;
    let address: SocketAddr = line.trim().parse().context("missing service address")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

/// A Control Plane process and the credentials it shares across restarts.
struct Services {
    gateway_token: String,
    operator_token: String,
    control: Child,
    public: String,
}

impl Services {
    async fn start(database: &str, crash: Option<(&str, &Path)>) -> Result<Self> {
        Self::start_with(
            database,
            supertag_protocol::new_secret(supertag_protocol::CREDENTIAL_SECRET_PREFIX),
            Uuid::new_v4().to_string(),
            crash,
        )
        .await
    }

    async fn start_with(
        database: &str,
        gateway_token: String,
        operator_token: String,
        crash: Option<(&str, &Path)>,
    ) -> Result<Self> {
        let mut control = binary(&["control-plane", "--listen", "127.0.0.1:0"]);
        control
            .env("SUPERTAG_BOOTSTRAP_GATEWAY_CREDENTIAL", &gateway_token)
            .env("SUPERTAG_GATEWAY_CREDENTIAL", &gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &operator_token)
            .env("SUPERTAG_DATABASE_URL", database);
        if let Some((point, marker)) = crash {
            control
                .env("SUPERTAG_TEST_CRASH_POINT", point)
                .env("SUPERTAG_TEST_CRASH_MARKER", marker);
        }
        let (control, public) = service(control).await?;
        Ok(Self {
            gateway_token,
            operator_token,
            control,
            public,
        })
    }

    fn operator(&self, args: &[&str]) -> Command {
        let mut command = binary(args);
        command
            .args(["--control-plane", &self.public])
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator_token);
        command
    }

    async fn json(&self, args: &[&str]) -> Result<Value> {
        let output = timeout(WAIT, self.operator(args).output())
            .await
            .context("SuperTag command did not exit")??;
        ensure!(
            output.status.success(),
            "supertag {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(serde_json::from_slice(&output.stdout)?)
    }

    /// `(actor, action, target, outcome, code)` of every entry, oldest first.
    async fn audit(&self) -> Result<Vec<[String; 5]>> {
        let audit = self
            .json(&["audit", "--output", "json", "--limit", "500"])
            .await?;
        let mut entries: Vec<[String; 5]> = audit["entries"]
            .as_array()
            .context("entries")?
            .iter()
            .map(|entry| {
                ["actor", "action", "target", "outcome", "code"]
                    .map(|field| entry[field].as_str().unwrap_or_default().to_owned())
            })
            .collect();
        entries.reverse();
        Ok(entries)
    }

    async fn stop(mut self) -> Result<(String, String)> {
        self.control.kill().await?;
        Ok((self.gateway_token, self.operator_token))
    }
}

fn entry(actor: &str, action: &str, target: &str, outcome: &str, code: &str) -> [String; 5] {
    [actor, action, target, outcome, code].map(str::to_owned)
}

database_tests! {
    #[tokio::test]
    audit_entry_commits_with_the_change_it_records;
    #[tokio::test]
    worker_host_joins_are_recorded_under_their_auth_key;
    #[tokio::test]
    connect_saves_a_proven_token_for_later_commands;
}

/// The Control Plane dies after committing an audited change and before answering. The change
/// and its entry survive together, so the restarted Control Plane lists the entry.
async fn audit_entry_commits_with_the_change_it_records(database: String) -> Result<()> {
    let directory = tempfile::tempdir()?;
    let marker = directory.path().join("crashed");
    let services = Services::start(
        &database,
        Some(("control-plane.submit.after-commit", &marker)),
    )
    .await?;
    services
        .json(&[
            "tag",
            "put",
            "reviewer",
            "--instructions",
            "Review the change",
        ])
        .await?;
    let submitted = timeout(
        WAIT,
        services
            .operator(&[
                "task",
                "submit",
                "--tag",
                "reviewer",
                "--session",
                "review",
                "Check the diff",
            ])
            .output(),
    )
    .await??;
    ensure!(!submitted.status.success(), "the submit was answered");
    ensure!(
        std::fs::read_to_string(&marker)? == "control-plane.submit.after-commit",
        "the Control Plane did not stop at the commit"
    );
    let (gateway_token, operator_token) = services.stop().await?;

    let services = Services::start_with(&database, gateway_token, operator_token, None).await?;
    let mut connection = database::connect(&database).await?;
    let accepted: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM supertag_v2_tasks WHERE tag_id='reviewer'")
            .fetch_one(&mut connection)
            .await?;
    assert_eq!(accepted, 1, "the change committed");
    assert_eq!(
        services.audit().await?,
        [
            entry(
                "operator:local",
                "tag.put",
                "Tag/reviewer",
                "succeeded",
                "OK"
            ),
            entry(
                "operator:local",
                "tag.message",
                "Tag/reviewer",
                "succeeded",
                "OK"
            ),
        ]
    );
    services.stop().await?;
    Ok(())
}

/// A join with a key the Control Plane does not know is not recorded, nor is a join refused before
/// its key is looked up; a join with a known key is recorded under `auth-key:NAME`, whether it
/// succeeds or is refused.
async fn worker_host_joins_are_recorded_under_their_auth_key(database: String) -> Result<()> {
    let services = Services::start(&database, None).await?;
    services
        .json(&[
            "tag",
            "put",
            "reviewer",
            "--instructions",
            "Review the change",
        ])
        .await?;
    let issued = services
        .json(&[
            "auth-key",
            "create",
            "review-key",
            "--role",
            "host",
            "--tag",
            "reviewer",
        ])
        .await?;
    let auth_key = issued["auth_key"].as_str().context("auth_key")?;
    let key_name = issued["name"].as_str().context("name")?;
    let mut enrollment = EnrollmentsClient::new(protocol::dial(services.public.clone()).await?);
    let mut join = async |key: &str, host: &str, operation: &str| {
        let mut request = authenticated_request(
            EnrollRequest {
                role: PrincipalRole::Host.into(),
                name: host.into(),
                operation_id: operation.into(),
                token_digest: Sha256::digest(format!("credential for {host}")).to_vec(),
            },
            key,
            None,
        )?;
        request.set_timeout(WAIT);
        anyhow::Ok(enrollment.enroll(request).await)
    };
    // Only an Auth Key enrolls; any other bearer is refused before anything is looked up.
    let unknown = join("unissued-test-key", "review-host", "unknown")
        .await?
        .unwrap_err();
    assert_eq!(unknown.code(), Code::Unauthenticated, "{unknown:?}");
    // The key is looked up before the request is checked, so an unknown caller cannot write
    // entries by sending invalid joins.
    let unissued = format!("stak_{}", "0".repeat(64));
    for _ in 0..3 {
        let invalid = join(&unissued, "", "invalid").await?.unwrap_err();
        assert_eq!(invalid.code(), Code::PermissionDenied, "{invalid:?}");
    }
    // A known key's invalid join is recorded under the key.
    let invalid = join(auth_key, "", "invalid").await?.unwrap_err();
    assert_eq!(invalid.code(), Code::InvalidArgument, "{invalid:?}");
    join(auth_key, "review-host", "join").await??;
    // A one-time key admits one enrollee; another may not use it.
    let refused = join(auth_key, "other-host", "other").await?.unwrap_err();
    assert_eq!(refused.code(), Code::PermissionDenied);

    let actor = format!("auth-key:{key_name}");
    let joins = services
        .audit()
        .await?
        .into_iter()
        .filter(|entry| entry[1] == "enrollment.join")
        .collect::<Vec<_>>();
    assert_eq!(joins.len(), 3, "{joins:?}");
    assert_eq!(
        joins[0],
        entry(
            &actor,
            "enrollment.join",
            "Enrollment",
            "failed",
            "INVALID_ARGUMENT"
        )
    );
    assert_eq!(
        joins[1],
        entry(
            &actor,
            "enrollment.join",
            "WorkerHost/review-host",
            "succeeded",
            "OK"
        )
    );
    assert_eq!(
        joins[2],
        entry(
            &actor,
            "enrollment.join",
            "Enrollment",
            "failed",
            "PERMISSION_DENIED"
        )
    );
    services.stop().await?;
    Ok(())
}

/// `supertag connect` checks the token first, saves the Control Plane owner-only in the
/// terminal UI's store as the active one, and later commands use it by name.
async fn connect_saves_a_proven_token_for_later_commands(database: String) -> Result<()> {
    let services = Services::start(&database, None).await?;
    let home = tempfile::tempdir()?;
    let connect = |token: &str, name: &str, url: &str, replace: bool| {
        let mut command = binary(&["connect", url, "--name", name]);
        if replace {
            command.arg("--replace");
        }
        command
            .env("HOME", home.path())
            .env("SUPERTAG_OPERATOR_TOKEN", token);
        async move {
            let output = timeout(WAIT, command.output()).await??;
            anyhow::Ok((
                output.status.success(),
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ))
        }
    };
    let store = if cfg!(target_os = "macos") {
        home.path()
            .join("Library/Application Support/supertag/tui-control-planes.json")
    } else {
        home.path().join(".config/supertag/tui-control-planes.json")
    };

    let (saved, stderr) = connect("not-the-token", "prod", &services.public, false).await?;
    ensure!(!saved, "a refused token was saved");
    ensure!(stderr.contains("refused the credential"), "{stderr}");
    ensure!(!store.exists(), "nothing is saved for a refused token");

    let token = services.operator_token.clone();
    let (saved, stderr) = connect(&token, "prod", &services.public, false).await?;
    ensure!(saved, "{stderr}");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&store)?.permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(store.parent().context("store directory")?)?
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let profiles: Value = serde_json::from_slice(&std::fs::read(&store)?)?;
    assert_eq!(profiles["version"], 1);
    assert_eq!(profiles["active"], "prod");
    assert_eq!(profiles["control_planes"][0]["name"], "prod");
    assert_eq!(
        profiles["control_planes"][0]["url"],
        services.public.as_str()
    );
    assert_eq!(profiles["control_planes"][0]["token"], token.as_str());

    // A later command names the saved Control Plane and needs no token in its environment.
    let mut listed = binary(&["get", "tags", "--control-plane", "prod"]);
    listed.env("HOME", home.path());
    let output = timeout(WAIT, listed.output()).await??;
    ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let (saved, stderr) = connect(&token, "prod", &services.public, false).await?;
    ensure!(!saved && stderr.contains("--replace"), "{stderr}");
    // Replacing a connection keeps the Workspace the terminal UI chose for it.
    let mut profiles: Value = serde_json::from_slice(&std::fs::read(&store)?)?;
    profiles["control_planes"][0]["workspace"] = "project".into();
    std::fs::write(&store, serde_json::to_vec(&profiles)?)?;
    let (saved, stderr) = connect(&token, "prod", &services.public, true).await?;
    ensure!(saved, "{stderr}");
    let profiles: Value = serde_json::from_slice(&std::fs::read(&store)?)?;
    assert_eq!(profiles["control_planes"][0]["workspace"], "project");
    // A URL that cannot be saved is refused before the token is sent anywhere.
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    for url in [
        format!("http://user:secret@127.0.0.1:{port}"),
        format!("http://127.0.0.1:{port}/path"),
        format!("http://127.0.0.1:{port}/?query=1"),
    ] {
        let (saved, stderr) = connect(&token, "other", &url, false).await?;
        ensure!(
            !saved && stderr.contains("without credentials, path, query or fragment"),
            "{stderr}"
        );
    }
    let refused = listener.accept().map(|_| ()).unwrap_err();
    assert_eq!(
        refused.kind(),
        std::io::ErrorKind::WouldBlock,
        "the token was sent"
    );
    let (saved, stderr) = connect(&token, "prod", "http://127.0.0.2:1", true).await?;
    ensure!(!saved && stderr.contains("could not reach"), "{stderr}");
    let profiles: Value = serde_json::from_slice(&std::fs::read(&store)?)?;
    assert_eq!(profiles["control_planes"].as_array().map(Vec::len), Some(1));

    // A client Auth Key joins this device as client:NAME; only the enrolled credential is saved,
    // and the device reaches only the Tags its key allows.
    for tag in ["allowed", "hidden"] {
        services
            .json(&["tag", "put", tag, "--instructions", "Help"])
            .await?;
    }
    let issued = services
        .json(&[
            "auth-key", "create", "laptops", "--role", "client", "--tag", "allowed",
        ])
        .await?;
    assert_eq!(issued["role"], "client");
    let key = issued["auth_key"].as_str().context("auth_key")?.to_owned();
    let mut join = binary(&[
        "connect",
        &services.public,
        "--name",
        "work",
        "--client-name",
        "alice-laptop",
    ]);
    join.env("HOME", home.path())
        .env("SUPERTAG_OPERATOR_TOKEN", &key);
    let joined = timeout(WAIT, join.output()).await??;
    ensure!(
        joined.status.success(),
        "{}",
        String::from_utf8_lossy(&joined.stderr)
    );
    let joined: Value = serde_json::from_slice(&joined.stdout)?;
    assert_eq!(joined["connected_as"], "client:alice-laptop");
    let profiles: Value = serde_json::from_slice(&std::fs::read(&store)?)?;
    let saved = profiles["control_planes"]
        .as_array()
        .context("control_planes")?
        .iter()
        .find(|entry| entry["name"] == "work")
        .context("work")?["token"]
        .as_str()
        .context("token")?
        .to_owned();
    ensure!(
        saved != key && saved.starts_with("stcr_"),
        "the Auth Key was saved"
    );
    let as_client = |args: &[&str]| {
        let mut command = binary(args);
        command
            .args(["--control-plane", "work"])
            .env("HOME", home.path());
        command
    };
    let tags = timeout(WAIT, as_client(&["get", "tags"]).output()).await??;
    ensure!(
        tags.status.success(),
        "{}",
        String::from_utf8_lossy(&tags.stderr)
    );
    let tags: Value = serde_json::from_slice(&tags.stdout)?;
    let names: Vec<&str> = tags["tags"]
        .as_array()
        .context("tags")?
        .iter()
        .filter_map(|tag| tag["tag_id"].as_str())
        .collect();
    assert_eq!(names, ["allowed"]);
    for args in [
        &["tag", "put", "allowed", "--instructions", "Mine now"][..],
        &["get", "hosts"][..],
        &["get", "tag", "hidden"][..],
    ] {
        let refused = timeout(WAIT, as_client(args).output()).await??;
        ensure!(!refused.status.success(), "a client ran {args:?}");
    }
    // The one-time key admits no second device.
    let mut again = binary(&["connect", &services.public, "--name", "again"]);
    again
        .env("HOME", home.path())
        .env("SUPERTAG_OPERATOR_TOKEN", &key);
    let again = timeout(WAIT, again.output()).await??;
    ensure!(
        !again.status.success()
            && String::from_utf8_lossy(&again.stderr).contains("refused the Auth Key"),
        "{}",
        String::from_utf8_lossy(&again.stderr)
    );
    // Enrollment and the client's own calls are recorded under their full principals.
    let audit = services.audit().await?;
    assert!(
        audit.contains(&entry(
            "auth-key:laptops",
            "enrollment.join",
            "Client/alice-laptop",
            "succeeded",
            "OK"
        )),
        "{audit:?}"
    );
    services.stop().await?;
    Ok(())
}
