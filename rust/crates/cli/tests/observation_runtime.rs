//! Operator observation through real services: saved Gateway profiles,
//! `watch` across a Gateway restart, `describe`, and `spend`.
use std::{
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sqlx::{Connection, Executor};
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

    async fn restart_gateway(&mut self) -> Result<()> {
        self.gateway.kill().await?;
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
            "put-tag",
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
        vec!["--gateway", "local", "get-tag", "builder"],
        vec!["get-tag", "--gateway", "local", "builder"],
        vec!["--gateway", "desk", "get-tag", "builder"],
    ] {
        let tag = json_of(&home, &args, None).await?;
        assert_eq!(tag["tag_id"], "builder", "{args:?}");
    }
    let (success, _, stderr) =
        run(&home, &["--gateway", "missing", "get-tag", "builder"], None).await?;
    ensure!(
        !success && stderr.contains("no saved Gateway is named"),
        "{stderr}"
    );
    let (success, _, stderr) = run(
        &home,
        &[
            "--gateway",
            "local",
            "get-tag",
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
    let (success, _, stderr) =
        run(&home, &["--gateway", "local", "get-tag", "builder"], None).await?;
    ensure!(
        !success && stderr.contains("different connections"),
        "{stderr}"
    );
    write_private(&desktop_store, &desktop)?;
    // A store other users can read is refused.
    std::fs::set_permissions(&tui_store, std::fs::Permissions::from_mode(0o644))?;
    let (success, _, stderr) =
        run(&home, &["--gateway", "local", "get-tag", "builder"], None).await?;
    ensure!(
        !success && stderr.contains("private regular file"),
        "{stderr}"
    );
    std::fs::set_permissions(&tui_store, std::fs::Permissions::from_mode(0o600))?;

    // Watch continues across a Gateway restart from its last resume token.
    let mut watcher = command(
        &home,
        &[
            "--gateway",
            "local",
            "watch",
            "--kind",
            "tag",
            "--output",
            "json",
            "--limit",
            "2",
        ],
    )
    .stdout(Stdio::piped())
    .spawn()?;
    let mut lines = BufReader::new(watcher.stdout.take().context("watch stdout")?).lines();
    let opened = next_json(&mut lines).await?;
    assert_eq!(opened["type"], "heartbeat");
    let put = |id: &'static str| {
        let home = home.clone();
        let public = public.clone();
        let operator = operator.clone();
        async move {
            ok(
                &home,
                &[
                    "put-tag",
                    "--gateway",
                    &public,
                    id,
                    "--instructions",
                    "Watch me",
                ],
                Some(&operator),
            )
            .await
        }
    };
    put("first").await?;
    let first = loop {
        let event = next_json(&mut lines).await?;
        if event["type"] == "change" {
            break event;
        }
    };
    assert_eq!(first["kind"], "tag");
    assert_eq!(first["id"], "first");
    assert_eq!(first["reason"], "created");
    services.restart_gateway().await?;
    put("second").await?;
    let second = loop {
        let event = next_json(&mut lines).await?;
        if event["type"] == "change" {
            break event;
        }
    };
    assert_eq!(second["id"], "second");
    let status = timeout(WAIT, watcher.wait()).await??;
    ensure!(status.success(), "watch exited with {status}");
    // Resuming from the first notice yields the second and nothing earlier.
    let resumed = ok(
        &home,
        &[
            "--gateway",
            "local",
            "watch",
            "--kind",
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
    assert_eq!(changes[0]["id"], "second");
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
            "--kind",
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
        text.starts_with("created tag second (resume token v1."),
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
    let channel = Channel::from_shared(public.clone())?
        .timeout(WAIT)
        .connect()
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
    for operation in ["claim-objective", "claim-unassigned"] {
        if operation == "claim-unassigned" {
            ok(
                &home,
                &[
                    "--gateway",
                    "local",
                    "submit",
                    "--tag",
                    "builder",
                    "--session",
                    "side",
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
                "key": "unassigned", "name": null, "attempts": 1,
                "reported_cost_by_currency": null,
                "unknown_cost_attempts": 1, "estimated_cost_attempts": 0,
                "unpriced_models": {"mystery-model": 1}, "unpriced_tokens": 120,
                "reported_tokens": 120, "unknown_token_attempts": 0,
                "budget": null,
            },
        ])
    );
    let text = ok(&home, &["--gateway", "local", "spend"], None).await?;
    assert_eq!(
        text,
        "launch | 1 Attempt(s) | cost $0.42; 1 estimated-cost Attempt(s) | tokens 120 | budget $5.00\n\
         unassigned | 1 Attempt(s) | cost unpriced; 1 unknown-cost Attempt(s): unpriced: no reported or estimated cost for mystery-model in 1; tokens recorded | tokens 120 | budget none\n"
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
    assert_eq!(by_tag["groups"][0]["attempts"], 2);
    assert_eq!(by_tag["groups"][0]["reported_tokens"], 240);
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
    assert_eq!(by_day["groups"][0]["attempts"], 2);
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
        json_of(&home, &["--gateway", "local", "get-tag", "builder"], None).await?
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
    ensure!(described.starts_with("Objective\n"), "{described}");
    ensure!(
        described.contains("\nBudget currency: USD\n"),
        "{described}"
    );
    ensure!(
        described.contains("\nOutcome: Launch the release\n"),
        "{described}"
    );
    let worker_host = ok(
        &home,
        &[
            "--gateway",
            "local",
            "describe",
            "worker-host",
            &host.host_id,
        ],
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

    services.stop().await
}

#[tokio::test]
async fn observes_through_saved_gateways_on_sqlite() -> Result<()> {
    let directory = tempfile::tempdir()?;
    exercise(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("observe.db").display()
    ))
    .await
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL server via SUPERTAG_RUST_TEST_POSTGRES_URL_FILE"]
async fn observes_through_saved_gateways_on_postgres() -> Result<()> {
    let url_file = std::env::var_os("SUPERTAG_RUST_TEST_POSTGRES_URL_FILE")
        .context("disposable PostgreSQL URL file required")?;
    let admin_url = std::fs::read_to_string(url_file)?;
    let mut admin = sqlx::PgConnection::connect(admin_url.trim()).await?;
    let database = format!("supertag_observe_{}", Uuid::new_v4().simple());
    let mut url = url::Url::parse(admin_url.trim())?;
    url.set_path(&database);
    admin
        .execute(format!("CREATE DATABASE {database}").as_str())
        .await?;
    let result = tokio::spawn(async move { exercise(url.as_str()).await }).await;
    admin
        .execute(format!("DROP DATABASE {database} WITH (FORCE)").as_str())
        .await?;
    result?
}
