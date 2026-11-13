//! Operator observation through real services: saved Gateway profiles,
//! `watch` across a Gateway restart, `describe`, and `spend`.
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;
#[path = "support/protocol.rs"]
mod protocol;
#[macro_use]
#[path = "support/database.rs"]
mod database;

use std::{
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use supertag_protocol::{HOST_GENERATION_HEADER, authenticated_request, v2::*};
use tokio::{
    io::{AsyncBufReadExt, BufReader, Lines},
    process::{Child, ChildStdout, Command},
    time::timeout,
};
use tonic::{Request, transport::Channel};
use uuid::Uuid;

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const WAIT: Duration = Duration::from_secs(20);

fn command(home: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(BINARY);
    command
        .args(args)
        .env_clear()
        .env("HOME", home)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn service(mut command: Command) -> Result<(Child, String)> {
    let mut child = command.stdout(Stdio::piped()).spawn()?;
    let mut output = BufReader::new(child.stdout.take().context("missing service stdout")?);
    let mut ready = String::new();
    timeout(WAIT, output.read_line(&mut ready)).await??;
    let address: SocketAddr = ready
        .trim()
        .parse()
        .context("service did not report its bind address")?;
    ensure!(address.ip().is_loopback() && address.port() != 0);
    Ok((child, format!("http://{address}")))
}

/// Runs a command and returns (success, stdout, stderr).
async fn run(home: &Path, args: &[&str], token: Option<&str>) -> Result<(bool, String, String)> {
    let mut command = command(home, args);
    if let Some(token) = token {
        command.env("SUPERTAG_OPERATOR_TOKEN", token);
    }
    let output = timeout(WAIT, command.output()).await??;
    Ok((
        output.status.success(),
        String::from_utf8(output.stdout)?,
        String::from_utf8(output.stderr)?,
    ))
}

async fn ok(home: &Path, args: &[&str], token: Option<&str>) -> Result<String> {
    let (success, stdout, stderr) = run(home, args, token).await?;
    ensure!(success, "command {args:?} failed: {stderr}");
    Ok(stdout)
}

async fn json_of(home: &Path, args: &[&str], token: Option<&str>) -> Result<Value> {
    Ok(serde_json::from_str(&ok(home, args, token).await?)?)
}

fn config_directory(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else {
        home.join(".config")
    }
}

fn write_private(path: &Path, value: &Value) -> Result<()> {
    let parent = path.parent().context("store directory")?;
    std::fs::create_dir_all(parent)?;
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    std::fs::write(path, serde_json::to_vec(value)?)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

fn host_request<T>(input: T, token: &str, generation: u64) -> Result<Request<T>> {
    let mut request = authenticated_request(input, token, None)?;
    request
        .metadata_mut()
        .insert(HOST_GENERATION_HEADER, generation.into());
    Ok(request)
}

async fn next_json(lines: &mut Lines<BufReader<ChildStdout>>) -> Result<Value> {
    let line = timeout(WAIT, lines.next_line())
        .await??
        .context("watch ended early")?;
    Ok(serde_json::from_str(&line)?)
}

/// The next change notice, skipping heartbeats, within one overall wait.
async fn next_change(lines: &mut Lines<BufReader<ChildStdout>>) -> Result<Value> {
    timeout(WAIT, async {
        loop {
            let event = next_json(lines).await?;
            if event["type"] == "change" {
                return Ok(event);
            }
        }
    })
    .await
    .context("no change notice arrived")?
}

struct Services {
    home: PathBuf,
    gateway_token: String,
    operator_token: String,
    host_token: String,
    plane: Child,
    gateway: Child,
    private: String,
    public: String,
}

async fn launch_gateway(
    home: &Path,
    private: &str,
    gateway_token: &str,
    operator_token: &str,
    listen: &str,
) -> Result<(Child, String)> {
    let mut gateway = command(
        home,
        &["gateway", "--control-plane", private, "--listen", listen],
    );
    gateway
        .env("SUPERTAG_GATEWAY_TOKEN", gateway_token)
        .env("SUPERTAG_OPERATOR_TOKEN", operator_token);
    service(gateway).await
}

impl Services {
    async fn start(home: &Path, database_url: &str) -> Result<Self> {
        let gateway_token = Uuid::new_v4().to_string();
        let operator_token = Uuid::new_v4().to_string();
        let host_token = Uuid::new_v4().to_string();
        let mut plane = command(home, &["control-plane"]);
        plane
            .env("SUPERTAG_GATEWAY_TOKEN", &gateway_token)
            .env("SUPERTAG_BOOTSTRAP_HOST_TOKEN", &host_token)
            .env("SUPERTAG_DATABASE_URL", database_url);
        let (plane, private) = service(plane).await?;
        let (gateway, public) = launch_gateway(
            home,
            &private,
            &gateway_token,
            &operator_token,
            "127.0.0.1:0",
        )
        .await?;
        Ok(Self {
            home: home.to_owned(),
            gateway_token,
            operator_token,
            host_token,
            plane,
            gateway,
            private,
            public,
        })
    }

    /// A second Gateway on another port, sharing the Control Plane.
    async fn extra_gateway(&self, extra: &[(&str, &Path)]) -> Result<(Child, String)> {
        let mut gateway = command(
            &self.home,
            &[
                "gateway",
                "--control-plane",
                &self.private,
                "--listen",
                "127.0.0.1:0",
            ],
        );
        gateway
            .env("SUPERTAG_GATEWAY_TOKEN", &self.gateway_token)
            .env("SUPERTAG_OPERATOR_TOKEN", &self.operator_token);
        for (name, value) in extra {
            gateway.env(name, value);
        }
        service(gateway).await
    }

    async fn stop_gateway(&mut self) -> Result<()> {
        self.gateway.kill().await?;
        self.gateway.wait().await?;
        Ok(())
    }

    async fn start_gateway(&mut self) -> Result<()> {
        let listen = self.public.trim_start_matches("http://").to_owned();
        let (gateway, public) = launch_gateway(
            &self.home,
            &self.private,
            &self.gateway_token,
            &self.operator_token,
            &listen,
        )
        .await?;
        ensure!(public == self.public, "Gateway moved to {public}");
        self.gateway = gateway;
        Ok(())
    }

    async fn stop(mut self) -> Result<()> {
        self.gateway.kill().await?;
        self.plane.kill().await?;
        Ok(())
    }
}

/// A throwaway CA with a 127.0.0.1 server certificate and a client
/// certificate, made with the openssl command.
struct Certificates {
    ca: PathBuf,
    server_cert: PathBuf,
    server_key: PathBuf,
    client_cert: PathBuf,
    client_key: PathBuf,
}

impl Certificates {
    fn create(directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(directory)?;
        let openssl = |args: &[&str]| -> Result<()> {
            let output = std::process::Command::new("openssl")
                .args(args)
                .current_dir(directory)
                .stdin(Stdio::null())
                .output()
                .context("run openssl")?;
            ensure!(
                output.status.success(),
                "openssl {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            Ok(())
        };
        let key = [
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:P-256",
            "-nodes",
        ];
        openssl(
            &[
                &["req", "-x509"][..],
                &key,
                &[
                    "-keyout",
                    "ca.key",
                    "-out",
                    "ca.pem",
                    "-days",
                    "1",
                    "-subj",
                    "/CN=observe-test-ca",
                    "-addext",
                    "basicConstraints=critical,CA:TRUE",
                    "-addext",
                    "keyUsage=critical,keyCertSign",
                ],
            ]
            .concat(),
        )?;
        for (name, extensions) in [
            (
                "server",
                "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
            ),
            ("client", "extendedKeyUsage=clientAuth\n"),
        ] {
            std::fs::write(directory.join(format!("{name}.ext")), extensions)?;
            openssl(
                &[
                    &["req"][..],
                    &key,
                    &[
                        "-keyout",
                        &format!("{name}.key"),
                        "-out",
                        &format!("{name}.csr"),
                        "-subj",
                        &format!("/CN={name}"),
                    ],
                ]
                .concat(),
            )?;
            openssl(&[
                "x509",
                "-req",
                "-in",
                &format!("{name}.csr"),
                "-CA",
                "ca.pem",
                "-CAkey",
                "ca.key",
                "-CAcreateserial",
                "-days",
                "1",
                "-out",
                &format!("{name}.pem"),
                "-extfile",
                &format!("{name}.ext"),
            ])?;
        }
        Ok(Self {
            ca: directory.join("ca.pem"),
            server_cert: directory.join("server.pem"),
            server_key: directory.join("server.key"),
            client_cert: directory.join("client.pem"),
            client_key: directory.join("client.key"),
        })
    }
}

async fn exercise(database_url: &str) -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let home = temporary.path().join("home");
    std::fs::create_dir(&home)?;
    let mut services = Services::start(&home, database_url).await?;
    let public = services.public.clone();
    let operator = services.operator_token.clone();
    let token = Some(operator.as_str());
    ok(
        &home,
        &[
            "tag",
            "put",
            "--gateway",
            &public,
            "builder",
            "--name",
            "Builder",
            "--instructions",
            "Build carefully",
        ],
        token,
    )
    .await?;

    // Saved Gateways: the terminal UI and desktop stores are read by name,
    // before or after the command, with no operator token in the environment.
    let tui_store = config_directory(&home).join("supertag/tui-gateways.json");
    let desktop_store = config_directory(&home).join("ai.supertag.desktop/gateways.json");
    write_private(
        &tui_store,
        &json!({"version":1,"active":"local","gateways":[{"url":public,"token":operator,"name":"local"}]}),
    )?;
    let desktop = json!({"active":public,"gateways":[{"profile":{"name":"desk","origin":public},"token":operator}]});
    write_private(&desktop_store, &desktop)?;
    for args in [
        vec!["--gateway", "local", "get", "tag", "builder"],
        vec!["get", "tag", "--gateway", "local", "builder"],
        vec!["--gateway", "desk", "get", "tag", "builder"],
    ] {
        let tag = json_of(&home, &args, None).await?;
        assert_eq!(tag["tag_id"], "builder", "{args:?}");
    }
    let (success, _, stderr) = run(
        &home,
        &["--gateway", "missing", "get", "tag", "builder"],
        None,
    )
    .await?;
    ensure!(
        !success && stderr.contains("no saved Gateway is named"),
        "{stderr}"
    );
    let (success, _, stderr) = run(
        &home,
        &[
            "--gateway",
            "local",
            "get",
            "tag",
            "--gateway",
            "local",
            "builder",
        ],
        None,
    )
    .await?;
    ensure!(
        !success && stderr.contains("pass --gateway once"),
        "{stderr}"
    );
    // The same name for two different connections is refused, not guessed.
    write_private(
        &desktop_store,
        &json!({"gateways":[{"profile":{"name":"local","origin":public},"token":"other-token"}]}),
    )?;
    let (success, _, stderr) = run(
        &home,
        &["--gateway", "local", "get", "tag", "builder"],
        None,
    )
    .await?;
    ensure!(
        !success && stderr.contains("different connections"),
        "{stderr}"
    );
    write_private(&desktop_store, &desktop)?;
    // A store other users can read is refused.
    std::fs::set_permissions(&tui_store, std::fs::Permissions::from_mode(0o644))?;
    let (success, _, stderr) = run(
        &home,
        &["--gateway", "local", "get", "tag", "builder"],
        None,
    )
    .await?;
    ensure!(
        !success && stderr.contains("private regular file"),
        "{stderr}"
    );
    std::fs::set_permissions(&tui_store, std::fs::Permissions::from_mode(0o600))?;

    // Watch continues across a Gateway restart from its last resume token:
    // a Tag created while the watcher is disconnected arrives exactly once
    // after it reconnects. A watcher that reconnected without its token would
    // start at the feed head and never see it.
    let mut watcher = command(
        &home,
        &[
            "--gateway",
            "local",
            "watch",
            "tag",
            "--output",
            "json",
            "--limit",
            "3",
        ],
    )
    .stdout(Stdio::piped())
    .spawn()?;
    let mut lines = BufReader::new(watcher.stdout.take().context("watch stdout")?).lines();
    let opened = next_json(&mut lines).await?;
    assert_eq!(opened["type"], "heartbeat");
    let put = |gateway: String, id: &'static str| {
        let home = home.clone();
        let operator = operator.clone();
        async move {
            ok(
                &home,
                &[
                    "tag",
                    "put",
                    "--gateway",
                    &gateway,
                    id,
                    "--instructions",
                    "Watch me",
                ],
                Some(&operator),
            )
            .await
        }
    };
    let mut changes = Vec::new();
    put(public.clone(), "first").await?;
    let first = next_change(&mut lines).await?;
    assert_eq!(first["kind"], "tag");
    assert_eq!(first["id"], "first");
    assert_eq!(first["reason"], "created");
    changes.push(first.clone());
    services.stop_gateway().await?;
    {
        let (mut other, other_url) = services.extra_gateway(&[]).await?;
        put(other_url, "missed").await?;
        other.kill().await?;
    }
    services.start_gateway().await?;
    put(public.clone(), "second").await?;
    changes.push(next_change(&mut lines).await?);
    changes.push(next_change(&mut lines).await?);
    assert_eq!(
        changes
            .iter()
            .map(|event| event["id"].clone())
            .collect::<Vec<_>>(),
        vec![json!("first"), json!("missed"), json!("second")]
    );
    let status = timeout(WAIT, watcher.wait()).await??;
    ensure!(status.success(), "watch exited with {status}");
    // Resuming from the first notice yields the next one and nothing earlier.
    let resumed = ok(
        &home,
        &[
            "--gateway",
            "local",
            "watch",
            "tag",
            "--output",
            "json",
            "--limit",
            "1",
            "--resume-token",
            first["resume_token"].as_str().context("resume token")?,
        ],
        None,
    )
    .await?;
    let changes = resumed
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|event| event["type"] == "change")
        .collect::<Vec<_>>();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0]["id"], "missed");
    let (success, _, stderr) = run(
        &home,
        &[
            "--gateway",
            "local",
            "watch",
            "--resume-token",
            "not-a-token",
        ],
        None,
    )
    .await?;
    ensure!(
        !success && stderr.contains("invalid Watch resume token"),
        "{stderr}"
    );
    let text = ok(
        &home,
        &[
            "--gateway",
            "local",
            "watch",
            "tag",
            "--limit",
            "1",
            "--resume-token",
            first["resume_token"].as_str().context("resume token")?,
        ],
        None,
    )
    .await?;
    ensure!(
        text.starts_with("created tag missed (resume token v1."),
        "{text}"
    );

    // Spend: one budgeted Objective Attempt with estimated cost and one
    // unassigned Attempt with tokens for a model that reported no cost.
    let empty = ok(&home, &["--gateway", "local", "spend"], None).await?;
    assert_eq!(empty, "No Task Attempts.\n");
    let objective = json_of(
        &home,
        &[
            "--gateway",
            "local",
            "objective",
            "create",
            "launch",
            "--owner",
            "builder",
            "--budget-minor",
            "500",
            "--currency",
            "USD",
            "Launch the release",
        ],
        None,
    )
    .await?;
    let objective_task = objective["starting_task_id"]
        .as_str()
        .context("starting Task")?
        .to_owned();
    let channel = protocol::negotiated(
        Channel::from_shared(public.clone())?
            .timeout(WAIT)
            .connect()
            .await?,
    )
    .await?;
    let mut worker = worker_host_client::WorkerHostClient::new(channel);
    let host_token = services.host_token.clone();
    let host = worker
        .register_host(authenticated_request(
            RegisterHostRequest {
                incarnation_id: "observation-host".into(),
            },
            &host_token,
            None,
        )?)
        .await?
        .into_inner();
    let mut attempts = Vec::new();
    // The objective Attempt and a plain Attempt run on an unspecified
    // harness; the Codex Attempt runs on a harness that prices its usage.
    for (operation, session, harness) in [
        ("claim-objective", None, HarnessKind::Unspecified),
        ("claim-codex", Some("side"), HarnessKind::Codex),
        ("claim-plain", Some("plain"), HarnessKind::Unspecified),
    ] {
        if let Some(session) = session {
            ok(
                &home,
                &[
                    "--gateway",
                    "local",
                    "task",
                    "submit",
                    "--tag",
                    "builder",
                    "--session",
                    session,
                    "Tidy the docs",
                ],
                None,
            )
            .await?;
        }
        let assignment = worker
            .claim_task(host_request(
                ClaimTaskRequest {
                    operation_id: operation.into(),
                    harness_kind: harness as i32,
                    ..Default::default()
                },
                &host_token,
                host.generation,
            )?)
            .await?
            .into_inner()
            .assignment
            .context("expected a Task")?;
        let attempt = InspectAttemptRequest {
            task_id: assignment.task.context("claimed Task")?.task_id,
            attempt_id: assignment.attempt_id,
            lease_token: assignment.lease_token,
        };
        worker
            .start_task(host_request(
                StartTaskRequest {
                    task_id: attempt.task_id.clone(),
                    attempt_id: attempt.attempt_id.clone(),
                    lease_token: attempt.lease_token.clone(),
                },
                &host_token,
                host.generation,
            )?)
            .await?;
        attempts.push(attempt);
    }
    assert_eq!(attempts[0].task_id, objective_task);
    let usage = |attempt: &InspectAttemptRequest, model: &str, cost: Option<u64>| {
        ReportAttemptUsageRequest {
            attempt: Some(attempt.clone()),
            sequence: 1,
            native_usage: Some(NativeTokenUsage {
                input_tokens: 100,
                cached_input_tokens: 10,
                output_tokens: 20,
                total_tokens: Some(120),
                observed_model: Some(model.into()),
            }),
            amount_minor: cost,
            currency: cost.map(|_| "USD".into()),
            estimated: cost.is_some(),
        }
    };
    worker
        .report_attempt_usage(host_request(
            usage(&attempts[0], "priced-model", Some(42)),
            &host_token,
            host.generation,
        )?)
        .await?;
    worker
        .report_attempt_usage(host_request(
            usage(&attempts[1], "mystery-model", None),
            &host_token,
            host.generation,
        )?)
        .await?;
    worker
        .report_attempt_usage(host_request(
            usage(&attempts[2], "plain-model", None),
            &host_token,
            host.generation,
        )?)
        .await?;

    let by_objective = json_of(
        &home,
        &["--gateway", "local", "spend", "--output", "json"],
        None,
    )
    .await?;
    assert_eq!(by_objective["by"], "objective");
    assert_eq!(
        by_objective["groups"],
        json!([
            {
                "key": "launch", "name": null, "attempts": 1,
                "reported_cost_by_currency": {"USD": 42},
                "unknown_cost_attempts": 0, "estimated_cost_attempts": 1,
                "unpriced_models": {}, "unpriced_tokens": 0,
                "reported_tokens": 120, "unknown_token_attempts": 0,
                "budget": {"limit_minor": 500, "currency": "USD"},
            },
            {
                "key": "unassigned", "name": null, "attempts": 2,
                "reported_cost_by_currency": null,
                "unknown_cost_attempts": 2, "estimated_cost_attempts": 0,
                "unpriced_models": {"mystery-model": 1}, "unpriced_tokens": 120,
                "reported_tokens": 240, "unknown_token_attempts": 0,
                "budget": null,
            },
        ])
    );
    let text = ok(&home, &["--gateway", "local", "spend"], None).await?;
    assert_eq!(
        text,
        "launch | 1 Attempt(s) | cost $0.42; 1 estimated-cost Attempt(s) | tokens 120 | budget $5.00\n\
         unassigned | 2 Attempt(s) | cost unpriced; 2 unknown-cost Attempt(s): unpriced: no reported or estimated cost for mystery-model in 1; tokens recorded; no cost reported in 1 | tokens 240 | budget none\n"
    );
    let by_tag = json_of(
        &home,
        &[
            "--gateway",
            "local",
            "spend",
            "--by",
            "tag",
            "--output",
            "json",
        ],
        None,
    )
    .await?;
    assert_eq!(by_tag["groups"].as_array().map(Vec::len), Some(1));
    assert_eq!(by_tag["groups"][0]["key"], "builder");
    assert_eq!(by_tag["groups"][0]["name"], "Builder");
    assert_eq!(by_tag["groups"][0]["attempts"], 3);
    assert_eq!(by_tag["groups"][0]["reported_tokens"], 360);
    let by_day = json_of(
        &home,
        &[
            "--gateway",
            "local",
            "spend",
            "--by",
            "day",
            "--output",
            "json",
        ],
        None,
    )
    .await?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?;
    let today = chrono::DateTime::from_timestamp(now.as_secs() as i64, 0)
        .context("current time")?
        .format("%Y-%m-%d")
        .to_string();
    assert_eq!(by_day["groups"][0]["key"], today);
    assert_eq!(by_day["groups"][0]["attempts"], 3);
    let future = json_of(
        &home,
        &[
            "--gateway",
            "local",
            "spend",
            "--since",
            "2999-01-01T00:00:00Z",
            "--output",
            "json",
        ],
        None,
    )
    .await?;
    assert_eq!(future["groups"], json!([]));
    assert_eq!(future["since"], "2999-01-01T00:00:00.000Z");
    let (success, _, stderr) = run(
        &home,
        &["--gateway", "local", "spend", "--since", "yesterday"],
        None,
    )
    .await?;
    ensure!(!success && stderr.contains("RFC 3339"), "{stderr}");

    // Describe: readable text by default and the get JSON on request.
    let tag = ok(
        &home,
        &["--gateway", "local", "describe", "tag", "builder"],
        None,
    )
    .await?;
    ensure!(tag.starts_with("Tag\n"), "{tag}");
    ensure!(tag.contains("\nInstructions: Build carefully\n"), "{tag}");
    ensure!(tag.contains("\nName: Builder\n"), "{tag}");
    let tag_json = json_of(
        &home,
        &[
            "--gateway",
            "local",
            "describe",
            "tag",
            "builder",
            "--output",
            "json",
        ],
        None,
    )
    .await?;
    assert_eq!(
        tag_json,
        json_of(
            &home,
            &["--gateway", "local", "get", "tag", "builder"],
            None
        )
        .await?
    );
    let task = ok(
        &home,
        &["--gateway", "local", "describe", "task", &objective_task],
        None,
    )
    .await?;
    ensure!(task.contains("\nState: TASK_STATE_RUNNING\n"), "{task}");
    ensure!(
        task.contains(&format!("\nTask ID: {objective_task}\n")),
        "{task}"
    );
    let described = ok(
        &home,
        &["--gateway", "local", "describe", "objective", "launch"],
        None,
    )
    .await?;
    // The Objective overview: status, outcome, owner, budget pool, and its work.
    ensure!(
        described.starts_with(
            "Objective launch: working\nOutcome: Launch the release\nOwner: builder\nBudget: "
        ),
        "{described}"
    );
    ensure!(described.contains(" of $5.00 spent"), "{described}");
    ensure!(described.contains("\nWork: 1 Session\n"), "{described}");
    ensure!(
        described.contains("Full record: supertag describe objective launch --output json"),
        "{described}"
    );
    let overview = json_of(
        &home,
        &[
            "--gateway",
            "local",
            "describe",
            "objective",
            "launch",
            "--output",
            "json",
        ],
        None,
    )
    .await?;
    assert_eq!(overview["objective"]["outcome"], "Launch the release");
    assert_eq!(overview["pool"]["limit_minor"], 500);
    assert_eq!(overview["pool"]["currency"], "USD");
    assert_eq!(overview["sessions"][0]["owner"], true);
    assert_eq!(
        overview["sessions"][0]["status"],
        "OBJECTIVE_SESSION_STATUS_RUNNING"
    );
    assert_eq!(overview["tasks"][0]["task_id"], objective_task.as_str());
    assert_eq!(overview["tasks"][0]["kind"], "start");
    let worker_host = ok(
        &home,
        &["--gateway", "local", "describe", "host", &host.host_id],
        None,
    )
    .await?;
    ensure!(worker_host.starts_with("Worker Host\n"), "{worker_host}");
    ensure!(
        worker_host.contains(&format!("Host ID: {}", host.host_id)),
        "{worker_host}"
    );
    let (success, _, stderr) = run(
        &home,
        &["--gateway", "local", "describe", "tag", "nobody"],
        None,
    )
    .await?;
    ensure!(
        !success && stderr.contains("Tag nobody was not found"),
        "{stderr}"
    );

    // Every other kind: readable text under its title, and JSON that is the
    // same record the kind's own get command prints.
    let files = temporary.path().join("specs");
    std::fs::create_dir(&files)?;
    let spec = |name: &str, value: Value| -> Result<String> {
        let path = files.join(name);
        std::fs::write(&path, serde_json::to_vec(&value)?)?;
        Ok(path.to_str().context("spec path")?.to_owned())
    };
    let permission = spec(
        "permission.json",
        json!({"set_id":"edit","name":"edit","permissions":[{"target":"runtime","action":"files:write"}]}),
    )?;
    let context = spec(
        "context.json",
        json!({"set_id":"notes","name":"notes","items":[{"item_key":"policy","type":"example/notes","version":1,"config":{"text":"Review the diff"}}]}),
    )?;
    let role = spec(
        "role.json",
        json!({"role_id":"review","name":"review","purpose":"Review changes","permission_set_ids":["edit"],"context_set_ids":["notes"]}),
    )?;
    for (kind, file) in [
        ("permission-set", &permission),
        ("context-set", &context),
        ("role", &role),
    ] {
        ok(&home, &["--gateway", "local", kind, "put", file], None).await?;
    }
    ok(
        &home,
        &[
            "--gateway",
            "local",
            "team",
            "create",
            "crew",
            "--name",
            "Crew",
            "--member",
            "builder",
        ],
        None,
    )
    .await?;
    ok(
        &home,
        &[
            "--gateway",
            "local",
            "volume",
            "put",
            "shared",
            "--source",
            "s3://fixture-bucket/release",
            "--operation-id",
            "shared-volume",
        ],
        None,
    )
    .await?;
    let data = temporary.path().join("data");
    std::fs::create_dir(&data)?;
    let data_url = format!(
        "file://{}",
        data.canonicalize()?.to_str().context("data path")?
    );
    ok(
        &home,
        &[
            "--gateway",
            "local",
            "workspace-volume",
            "put",
            "data",
            "--source",
            &data_url,
        ],
        None,
    )
    .await?;
    let account = spec(
        "account.json",
        json!({"account_id":"github-source","identity":{"provider":"github","external_account_id":"installation:42"},"enabled":true}),
    )?;
    ok(
        &home,
        &["--gateway", "local", "surface-account", "put", &account],
        None,
    )
    .await?;
    ok(
        &home,
        &[
            "--gateway",
            "local",
            "workspace",
            "put",
            "project",
            "--account",
            "github-source",
            "--repository-id",
            "123",
            "--repository",
            "acme/project",
            "--commit",
            &"a".repeat(40),
            "--operation-id",
            "project-source",
        ],
        None,
    )
    .await?;
    let session = attempt_work_sessions_client::AttemptWorkSessionsClient::new(
        protocol::negotiated(
            Channel::from_shared(public.clone())?
                .timeout(WAIT)
                .connect()
                .await?,
        )
        .await?,
    )
    .start(host_request(
        StartWorkSessionRequest {
            attempt: Some(attempts[0].clone()),
            operation_id: "describe-session".into(),
            title: "Check the docs".into(),
            instruction: "Read the docs and report.".into(),
            workspace_id: None,
            target_tag_id: None,
        },
        &host_token,
        host.generation,
    )?)
    .await?
    .into_inner();
    for (kind, id, title, get) in [
        ("team", "crew", "Team", vec!["get", "team", "crew"]),
        (
            "session",
            session.work_session_id.as_str(),
            "Work Session",
            vec!["get", "session", session.work_session_id.as_str()],
        ),
        ("role", "review", "Role", vec!["get", "role", "review"]),
        (
            "permission-set",
            "edit",
            "Permission Set",
            vec!["get", "permission-set", "edit"],
        ),
        (
            "context-set",
            "notes",
            "Context Set",
            vec!["get", "context-set", "notes"],
        ),
        (
            "volume",
            "shared",
            "Volume",
            vec!["get", "volume", "shared"],
        ),
        (
            "workspace-volume",
            "data",
            "Workspace Volume",
            vec!["get", "workspace-volume", "data"],
        ),
        (
            "workspace",
            "project",
            "Workspace",
            vec!["get", "workspace", "project"],
        ),
    ] {
        let text = ok(&home, &["--gateway", "local", "describe", kind, id], None).await?;
        ensure!(text.starts_with(&format!("{title}\n")), "{kind}: {text}");
        ensure!(text.contains(id), "{kind}: {text}");
        let described = json_of(
            &home,
            &[
                "--gateway",
                "local",
                "describe",
                kind,
                id,
                "--output",
                "json",
            ],
            None,
        )
        .await?;
        let mut args = vec!["--gateway", "local"];
        args.extend(get);
        assert_eq!(described, json_of(&home, &args, None).await?, "{kind}");
    }

    // An operator completes the Objective with an assessment from a file.
    let summary = temporary.path().join("summary.md");
    let summary_path = summary.to_str().context("summary path")?;
    std::fs::write(&summary, "  \n")?;
    for file in [summary_path, "-"] {
        let (success, _, stderr) = run(
            &home,
            &[
                "--gateway",
                "local",
                "objective",
                "complete",
                "launch",
                "--summary-file",
                file,
            ],
            None,
        )
        .await?;
        ensure!(
            !success && stderr.contains("summary file is empty"),
            "{stderr}"
        );
    }
    std::fs::write(
        &summary,
        "Launched to all regions.\nChecks: smoke tests passed.\n",
    )?;
    let complete = [
        "--gateway",
        "local",
        "objective",
        "complete",
        "launch",
        "--summary-file",
        summary_path,
    ];
    let completed = json_of(&home, &complete, None).await?;
    assert_eq!(completed["status"], "OBJECTIVE_STATUS_COMPLETED");
    assert_eq!(
        completed["completion_summary"],
        "Launched to all regions.\nChecks: smoke tests passed."
    );
    let described = ok(
        &home,
        &["--gateway", "local", "describe", "objective", "launch"],
        None,
    )
    .await?;
    ensure!(
        described.starts_with(
            "Objective launch: completed\nOutcome: Launch the release\nResult: Launched to all regions.\n  Checks: smoke tests passed.\n"
        ),
        "{described}"
    );
    ensure!(
        described.contains("\nDelivered:\n  Launched to all regions.\n"),
        "{described}"
    );
    ensure!(!described.contains("Follow it"), "{described}");
    let (success, _, stderr) = run(&home, &complete, None).await?;
    ensure!(!success && stderr.contains("already completed"), "{stderr}");

    // The per-Objective timeline: a closed Objective is replayed and the watch returns; its
    // owner's turn still runs, so a zero settle time ends the wait for its delivery.
    let timeline = ok(
        &home,
        &[
            "--gateway",
            "local",
            "watch",
            "objective",
            "launch",
            "--output",
            "json",
            "--settle-seconds",
            "0",
        ],
        None,
    )
    .await?;
    let events: Vec<Value> = timeline
        .lines()
        .map(serde_json::from_str)
        .collect::<std::result::Result<_, _>>()?;
    let first = events.first().context("no events")?;
    let last = events.last().context("no events")?;
    assert_eq!(first["kind"], "objective.created", "{timeline}");
    assert_eq!(first["actor"], "operator");
    assert_eq!(first["objective_id"], "launch");
    assert_eq!(last["kind"], "objective.closed", "{timeline}");
    assert_eq!(last["status"], "completed");
    ensure!(
        events
            .iter()
            .any(|event| event["kind"] == "task.status"
                && event["task_id"] == objective_task.as_str()),
        "{timeline}"
    );
    let timeline = ok(
        &home,
        &[
            "--gateway",
            "local",
            "watch",
            "objective",
            "launch",
            "--settle-seconds",
            "0",
        ],
        None,
    )
    .await?;
    ensure!(
        timeline.contains("operator      Objective launch created for builder: Launch the release"),
        "{timeline}"
    );
    ensure!(
        timeline.contains("Objective launch is completed.\nResult: Launched to all regions."),
        "{timeline}"
    );
    let (success, _, stderr) = run(
        &home,
        &["--gateway", "local", "watch", "objective", "nobody"],
        None,
    )
    .await?;
    ensure!(!success && stderr.contains("not found"), "{stderr}");
    let (success, _, stderr) = run(&home, &["--gateway", "local", "watch", "launch"], None).await?;
    ensure!(
        !success && stderr.contains("unknown kind launch"),
        "{stderr}"
    );

    // Each client's store directory rule applies: the terminal UI's must be
    // private, the desktop app's only owner-writable.
    let tui_directory = tui_store.parent().context("store directory")?;
    std::fs::set_permissions(tui_directory, std::fs::Permissions::from_mode(0o750))?;
    let (success, _, stderr) = run(
        &home,
        &["--gateway", "local", "get", "tag", "builder"],
        None,
    )
    .await?;
    ensure!(
        !success && stderr.contains("saved Gateway directory"),
        "{stderr}"
    );
    std::fs::set_permissions(tui_directory, std::fs::Permissions::from_mode(0o700))?;
    let desktop_directory = desktop_store.parent().context("store directory")?;
    std::fs::set_permissions(desktop_directory, std::fs::Permissions::from_mode(0o755))?;
    json_of(&home, &["--gateway", "desk", "get", "tag", "builder"], None).await?;
    std::fs::set_permissions(desktop_directory, std::fs::Permissions::from_mode(0o775))?;
    let (success, _, stderr) =
        run(&home, &["--gateway", "desk", "get", "tag", "builder"], None).await?;
    ensure!(
        !success && stderr.contains("saved Gateway directory"),
        "{stderr}"
    );
    std::fs::set_permissions(desktop_directory, std::fs::Permissions::from_mode(0o700))?;

    // A saved profile's TLS files reach both operator commands and the
    // terminal UI handover, with no TLS environment variables set.
    let tls = Certificates::create(&temporary.path().join("tls"))?;
    let (mut secure, secure_url) = services
        .extra_gateway(&[
            ("SUPERTAG_TLS_CERT_FILE", &tls.server_cert),
            ("SUPERTAG_TLS_KEY_FILE", &tls.server_key),
            ("SUPERTAG_TLS_CLIENT_CA_FILE", &tls.ca),
        ])
        .await?;
    let secure_url = secure_url.replacen("http://", "https://", 1);
    let path = |path: &Path| path.to_str().map(str::to_owned).context("TLS path");
    write_private(
        &tui_store,
        &json!({"version":1,"active":"local","gateways":[
            {"url":public,"token":operator,"name":"local"},
            {"url":secure_url,"token":operator,"name":"secure",
             "server_ca_file":path(&tls.ca)?,"client_cert_file":path(&tls.client_cert)?,
             "client_key_file":path(&tls.client_key)?},
            {"url":secure_url,"token":operator,"name":"no-client",
             "server_ca_file":path(&tls.ca)?},
            {"url":secure_url,"token":operator,"name":"no-trust"},
        ]}),
    )?;
    let tag = json_of(
        &home,
        &["--gateway", "secure", "get", "tag", "builder"],
        None,
    )
    .await?;
    assert_eq!(tag["tag_id"], "builder");
    for name in ["no-client", "no-trust"] {
        let (success, _, stderr) =
            run(&home, &["--gateway", name, "get", "tag", "builder"], None).await?;
        ensure!(!success, "{name} connected without its TLS files: {stderr}");
    }
    let fixture = temporary.path().join("tui-fixture");
    std::fs::write(
        &fixture,
        format!(
            "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '%s\\n' '{}'; exit 0; fi\nexec cat <&3\n",
            env!("CARGO_PKG_VERSION")
        ),
    )?;
    std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o755))?;
    let handover = json_of(
        &home,
        &[
            "tui",
            "--gateway",
            "secure",
            "--binary",
            path(&fixture)?.as_str(),
        ],
        None,
    )
    .await?;
    let context = &handover["contexts"][0];
    assert_eq!(context["url"], secure_url);
    assert_eq!(context["token"], operator);
    assert_eq!(context["server_ca_file"], path(&tls.ca.canonicalize()?)?);
    assert_eq!(
        context["client_cert_file"],
        path(&tls.client_cert.canonicalize()?)?
    );
    assert_eq!(
        context["client_key_file"],
        path(&tls.client_key.canonicalize()?)?
    );
    secure.kill().await?;

    services.stop().await
}

database_tests! {
    #[tokio::test]
    observes_through_saved_gateways;
}

async fn observes_through_saved_gateways(database: String) -> Result<()> {
    exercise(&database).await
}
