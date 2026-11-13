//! Operator Tokens and the audit log through separate Control Plane and Gateway processes.
//!
//! The admin operator token issues, rotates, and revokes an Operator Token with the CLI. A running
//! Gateway refuses the revoked token on new calls and ends a Watch stream and an artifact download
//! it already opened. The audit log names every resource a call changed.
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
use sha2::{Digest, Sha256};
use sqlx::{Connection, Executor};
use supertag_protocol::{
    CHECKPOINT_CHUNK_BYTES, HOST_GENERATION_HEADER, MAX_MESSAGE_BYTES, authenticated_request, v2::*,
};
use tokio::time::sleep;
use tonic::{Code, Request, transport::Endpoint};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(15);

struct Credentials {
    gateway: String,
    admin: String,
    host: String,
}

impl Credentials {
    fn new() -> Self {
        Self {
            gateway: Uuid::new_v4().to_string(),
            admin: Uuid::new_v4().to_string(),
            host: Uuid::new_v4().to_string(),
        }
    }

    /// A Worker Host call for `generation`.
    fn host<T>(&self, value: T, generation: u64) -> Result<Request<T>> {
        let mut request = request(value, &self.host)?;
        request
            .metadata_mut()
            .insert(HOST_GENERATION_HEADER, generation.to_string().parse()?);
        Ok(request)
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(BINARY);
        command
            .args(args)
            .env_clear()
            .stdin(Stdio::null())
            .env("SUPERTAG_GATEWAY_TOKEN", &self.gateway)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.admin)
            .env("SUPERTAG_HOST_TOKEN", &self.host)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &self.host);
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

/// A Control Plane and a Gateway with a blob directory, as separate processes.
struct Services {
    _directory: tempfile::TempDir,
    _control: Process,
    _gateway: Process,
    private: String,
    public: String,
}

async fn services(credentials: &Credentials, database: &str) -> Result<Services> {
    let directory = tempfile::tempdir()?;
    let mut command = credentials.command(&["control-plane"]);
    command.env("SUPERTAG_DATABASE_URL", database);
    let mut control = Process::spawn(command, directory.path())?;
    let private = control.address().await?;
    let mut command = credentials.command(&["gateway", "--control-plane", &private]);
    command
        .arg("--checkpoint-directory")
        .arg(directory.path().join("cas"));
    let mut gateway = Process::spawn(command, directory.path())?;
    let public = gateway.address().await?;
    Ok(Services {
        _directory: directory,
        _control: control,
        _gateway: gateway,
        private,
        public,
    })
}

fn create_token(credentials: &Credentials, public: &str, name: &str) -> Result<String> {
    let created = json(&cli(
        credentials,
        &credentials.admin,
        public,
        &["operator-token", "create", name],
    )?)?;
    Ok(created["secret"].as_str().context("secret")?.to_owned())
}

/// `(actor, action, target, outcome, code)` of every entry, oldest first.
fn audit_entries(credentials: &Credentials, public: &str) -> Result<Vec<[String; 5]>> {
    let audit = json(&cli(
        credentials,
        &credentials.admin,
        public,
        &["audit", "--output", "json", "--limit", "500"],
    )?)?;
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

fn entry(actor: &str, action: &str, target: &str, outcome: &str, code: &str) -> [String; 5] {
    [actor, action, target, outcome, code].map(str::to_owned)
}

async fn audit_names_every_changed_resource(database: &str) -> Result<()> {
    let credentials = Credentials::new();
    let services = services(&credentials, database).await?;
    let channel = Endpoint::from_shared(services.public.clone())?.connect_lazy();
    let mut operator = operator_client::OperatorClient::new(channel.clone());
    let mut mailbox = mailbox_client::MailboxClient::new(channel.clone());
    let mut manifests =
        manifest_relationships_client::ManifestRelationshipsClient::new(channel.clone());
    let mut teams = teams_client::TeamsClient::new(channel.clone());
    let secret = create_token(&credentials, &services.public, "auditor")?;
    let actor = "token:auditor";

    // IDs at the 256-byte limit still name their resource: the target is longer than any one ID.
    let long_tag = "t".repeat(253);
    let sender = "s".repeat(128);
    let recipient = "r".repeat(128);
    for tag in [&long_tag, &sender, &recipient] {
        operator.put_tag(request(put_tag(tag), &secret)?).await?;
    }
    let grant = format!("MailboxGrant/{sender}->{recipient}");
    assert!(grant.len() > 256);
    mailbox
        .change_grant(request(
            ChangeMailboxGrantRequest {
                operation_id: "grant".into(),
                sender_tag_id: sender.clone(),
                recipient_tag_id: recipient.clone(),
                granted: true,
            },
            &secret,
        )?)
        .await?;
    teams
        .create_team(request(
            CreateTeamRequest {
                operation_id: "team".into(),
                team_id: "core".into(),
                name: "Core".into(),
                member_tag_ids: vec![sender.clone()],
                max_concurrency: Some(1),
            },
            &secret,
        )?)
        .await?;

    // A call that provisions several Tags names each of them.
    let provision = |tag: &str| ProvisionTag {
        tag: Some(put_tag(tag)),
        ..Default::default()
    };
    manifests
        .provision_tags(request(
            ProvisionTagsRequest {
                tags: vec![provision("planner"), provision("builder")],
            },
            &secret,
        )?)
        .await?;

    // Pruning an apply set records each member it removed, not only the set. As `supertag apply`
    // does, the set first claims the Tags it is about to create.
    let claims = ["prune-kept", "prune-removed"].map(|tag| ApplySetDeclaration {
        kind: "Tag".into(),
        name: tag.into(),
        revision: 0,
        created: true,
    });
    manifests
        .reconcile_apply_set(request(
            ReconcileApplySetRequest {
                apply_set: "web".into(),
                declared: claims.to_vec(),
                prune: false,
                preview: false,
            },
            &secret,
        )?)
        .await?;
    let mut declared = Vec::new();
    for tag in ["prune-kept", "prune-removed"] {
        let put = operator
            .put_tag(request(put_tag(tag), &secret)?)
            .await?
            .into_inner();
        declared.push(ApplySetDeclaration {
            kind: "Tag".into(),
            name: tag.into(),
            revision: put.revision,
            created: true,
        });
    }
    manifests
        .reconcile_apply_set(request(
            ReconcileApplySetRequest {
                apply_set: "web".into(),
                declared: declared.clone(),
                prune: false,
                preview: false,
            },
            &secret,
        )?)
        .await?;
    let pruned = manifests
        .reconcile_apply_set(request(
            ReconcileApplySetRequest {
                apply_set: "web".into(),
                declared: declared[..1].to_vec(),
                prune: true,
                preview: false,
            },
            &secret,
        )?)
        .await?
        .into_inner();
    assert_eq!(pruned.pruned.len(), 1);
    assert_eq!(pruned.pruned[0].action(), ApplySetPruneAction::Delete);

    // A message larger than the Control Plane accepts is refused by tonic itself, and recorded with
    // that refusal rather than as an empty request.
    let private = Endpoint::from_shared(services.private.clone())?.connect_lazy();
    let mut oversized = request(
        PutTagRequest {
            instructions: "x".repeat(MAX_MESSAGE_BYTES + 1024),
            ..put_tag("oversized")
        },
        &credentials.gateway,
    )?;
    oversized
        .metadata_mut()
        .insert("x-supertag-principal", "operator:local".parse()?);
    let refused = operator_client::OperatorClient::new(private)
        .put_tag(oversized)
        .await
        .unwrap_err();
    assert_ne!(refused.code(), Code::InvalidArgument, "{refused:?}");
    let refused_code = format!("{:?}", refused.code());

    let entries = audit_entries(&credentials, &services.public)?;
    let mut expected = vec![entry(
        "local",
        "operator-token.create",
        "OperatorToken/auditor",
        "succeeded",
        "OK",
    )];
    for tag in [&long_tag, &sender, &recipient] {
        expected.push(entry(
            actor,
            "tag.put",
            &format!("Tag/{tag}"),
            "succeeded",
            "OK",
        ));
    }
    expected.extend([
        entry(actor, "mailbox-grant.change", &grant, "succeeded", "OK"),
        entry(actor, "team.create", "Team/core", "succeeded", "OK"),
        entry(actor, "tag.provision", "Tag/planner", "succeeded", "OK"),
        entry(actor, "tag.provision", "Tag/builder", "succeeded", "OK"),
        entry(
            actor,
            "apply-set.reconcile",
            "ApplySet/web",
            "succeeded",
            "OK",
        ),
        entry(actor, "tag.put", "Tag/prune-kept", "succeeded", "OK"),
        entry(actor, "tag.put", "Tag/prune-removed", "succeeded", "OK"),
        entry(
            actor,
            "apply-set.reconcile",
            "ApplySet/web",
            "succeeded",
            "OK",
        ),
        entry(
            actor,
            "resource.prune",
            "Tag/prune-removed",
            "succeeded",
            "OK",
        ),
    ]);
    assert_eq!(entries[..expected.len()], expected[..]);
    let last = entries.last().context("oversized entry")?;
    assert_eq!(
        last[..4],
        entry("local", "tag.put", "Tag", "failed", "")[..4]
    );
    assert_eq!(
        last[4].replace('_', "").to_lowercase(),
        refused_code.to_lowercase(),
        "{last:?}"
    );
    assert_eq!(entries.len(), expected.len() + 1);
    Ok(())
}

/// Captures one artifact file of `bytes` from a Task the Operator Token submitted.
async fn capture_artifact(
    credentials: &Credentials,
    channel: tonic::transport::Channel,
    secret: &str,
    bytes: &[u8],
) -> Result<String> {
    let mut operator = operator_client::OperatorClient::new(channel.clone());
    let mut host = worker_host_client::WorkerHostClient::new(channel.clone());
    operator
        .put_tag(request(
            PutTagRequest {
                allowed_actions: vec!["files:read".into()],
                ..put_tag("writer")
            },
            secret,
        )?)
        .await?;
    let task = operator
        .submit_task(request(
            SubmitTaskRequest {
                tag_id: "writer".into(),
                session_id: "source".into(),
                operation_id: "submit".into(),
                prompt: "Evidence".into(),
                ..Default::default()
            },
            secret,
        )?)
        .await?
        .into_inner();
    let registered = host
        .register_host(request(
            RegisterHostRequest {
                incarnation_id: "download-fixture".into(),
            },
            &credentials.host,
        )?)
        .await?
        .into_inner();
    let generation = registered.generation;
    let assignment = host
        .claim_task(credentials.host(
            ClaimTaskRequest {
                operation_id: "claim".into(),
                ..Default::default()
            },
            generation,
        )?)
        .await?
        .into_inner()
        .assignment
        .context("no assignment")?;
    ensure!(assignment.task.as_ref().context("task")?.task_id == task.task_id);
    let attempt = InspectAttemptRequest {
        task_id: task.task_id.clone(),
        attempt_id: assignment.attempt_id,
        lease_token: assignment.lease_token,
    };
    host.start_task(credentials.host(
        StartTaskRequest {
            task_id: attempt.task_id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            lease_token: attempt.lease_token.clone(),
        },
        generation,
    )?)
    .await?;
    let blob = BlobReference {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        byte_length: bytes.len() as u64,
    };
    let mut parts = vec![ArtifactUpload {
        part: Some(artifact_upload::Part::Begin(CommitArtifactCaptureRequest {
            attempt: Some(attempt.clone()),
            operation_id: "capture".into(),
            description: Some(ArtifactDescription {
                title: "Evidence".into(),
                kind: "report".into(),
                summary: None,
            }),
            files: vec![ArtifactFile {
                path: "report.bin".into(),
                blob: Some(blob),
                ..Default::default()
            }],
            ..Default::default()
        })),
    }];
    for chunk in bytes.chunks(CHECKPOINT_CHUNK_BYTES) {
        parts.push(ArtifactUpload {
            part: Some(artifact_upload::Part::Chunk(ArtifactChunk {
                file_index: 0,
                data: chunk.to_vec(),
            })),
        });
    }
    let mut upload = credentials.host(tokio_stream::iter(parts), generation)?;
    upload.set_timeout(Duration::from_secs(30));
    let artifact = artifact_transfers_client::ArtifactTransfersClient::new(channel)
        .upload_capture(upload)
        .await?
        .into_inner();
    host.finish_task(credentials.host(
        FinishTaskRequest {
            task_id: attempt.task_id,
            attempt_id: attempt.attempt_id,
            lease_token: attempt.lease_token,
            succeeded: true,
            result: "Captured".into(),
            ..Default::default()
        },
        generation,
    )?)
    .await?;
    Ok(artifact.summary.context("summary")?.artifact_id)
}

async fn revoked_token_ends_an_in_flight_download(database: &str) -> Result<()> {
    let credentials = Credentials::new();
    let services = services(&credentials, database).await?;
    let channel = Endpoint::from_shared(services.public.clone())?.connect_lazy();
    let secret = create_token(&credentials, &services.public, "reader")?;
    // Far more than the HTTP/2 windows and stream buffers hold, so the download is still in
    // flight when the token is revoked.
    let bytes: Vec<u8> = (0..24 * 1024 * 1024)
        .map(|index| (index % 251) as u8)
        .collect();
    let artifact_id = capture_artifact(&credentials, channel.clone(), &secret, &bytes).await?;
    let mut transfers = artifact_transfers_client::ArtifactTransfersClient::new(channel);
    let download = |token: &str| {
        let mut download = authenticated_request(
            DownloadArtifactFileRequest {
                artifact_id: artifact_id.clone(),
                path: "report.bin".into(),
            },
            token,
            None,
        )?;
        download.set_timeout(Duration::from_secs(60));
        anyhow::Ok(download)
    };
    // The token reads the whole file while it is valid.
    let mut whole = transfers
        .download_file(download(&secret)?)
        .await?
        .into_inner();
    let mut length = 0;
    while let Some(message) = whole.message().await? {
        if let Some(artifact_download::Part::Chunk(chunk)) = message.part {
            length += chunk.len();
        }
    }
    assert_eq!(length, bytes.len());

    let mut stream = transfers
        .download_file(download(&secret)?)
        .await?
        .into_inner();
    let header = stream.message().await?.context("download header")?;
    assert!(matches!(
        header.part,
        Some(artifact_download::Part::File(_))
    ));
    cli(
        &credentials,
        &credentials.admin,
        &services.public,
        &["operator-token", "revoke", "reader"],
    )?;
    let revoked_at = Instant::now();
    // The download is blocked on this reader. Its next periodic recheck, once it resumes, is the
    // first since the revocation, so it ends before the remaining bytes are sent.
    sleep(Duration::from_millis(1500)).await;
    let mut received = 0;
    let ended = loop {
        match tokio::time::timeout(Duration::from_secs(10), stream.message())
            .await
            .context("revoked download stayed open")?
        {
            Ok(Some(message)) => {
                if let Some(artifact_download::Part::Chunk(chunk)) = message.part {
                    received += chunk.len();
                }
            }
            Ok(None) => anyhow::bail!("revoked download finished after {received} bytes"),
            Err(error) => break error,
        }
    };
    assert_eq!(ended.code(), Code::Unauthenticated, "{ended:?}");
    assert!(ended.message().contains("revoked"), "{ended:?}");
    assert!(received < bytes.len());
    assert!(revoked_at.elapsed() < Duration::from_secs(5));
    Ok(())
}

async fn postgres_database<F, Fut>(run: F) -> Result<()>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
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
    let outcome = run(url.to_string()).await;
    admin
        .execute(format!("DROP DATABASE {name} WITH (FORCE)").as_str())
        .await?;
    admin.close().await?;
    outcome
}

fn sqlite_database(directory: &tempfile::TempDir) -> String {
    format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("control.db").display()
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_audit_names_every_changed_resource() -> Result<()> {
    let directory = tempfile::tempdir()?;
    audit_names_every_changed_resource(&sqlite_database(&directory)).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_audit_names_every_changed_resource() -> Result<()> {
    postgres_database(|url| async move { audit_names_every_changed_resource(&url).await }).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_revoked_token_ends_an_in_flight_download() -> Result<()> {
    let directory = tempfile::tempdir()?;
    revoked_token_ends_an_in_flight_download(&sqlite_database(&directory)).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_revoked_token_ends_an_in_flight_download() -> Result<()> {
    postgres_database(|url| async move { revoked_token_ends_an_in_flight_download(&url).await })
        .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_revoked_operator_token_is_refused_by_a_running_gateway() -> Result<()> {
    let directory = tempfile::tempdir()?;
    revoked_token_is_refused_by_a_running_gateway(&sqlite_database(&directory)).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires SUPERTAG_RUST_TEST_POSTGRES_URL_FILE for a dedicated PostgreSQL test server"]
async fn postgres_revoked_operator_token_is_refused_by_a_running_gateway() -> Result<()> {
    postgres_database(
        |url| async move { revoked_token_is_refused_by_a_running_gateway(&url).await },
    )
    .await
}
