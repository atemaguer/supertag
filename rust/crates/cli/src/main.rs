mod harness;
mod local;
mod network;
mod objectives;

use std::{ffi::OsString, net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, Result, ensure};
use clap::{Args, Parser, Subcommand, ValueEnum};
use harness::{AdapterOptions, CodexAdapterArgs};
use serde_json::json;
use sha2::{Digest, Sha256};
use supertag_control_plane::ControlPlane;
use supertag_gateway::{
    Gateway,
    slack::{Slack, SlackConfig},
    transfers::CheckpointTransfers,
};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request,
    v2::{
        AttemptDecision, CancelTaskRequest, CreateAuthKeyRequest, GetTaskRequest,
        ListEventsRequest, ListNativeUsageRequest, PutTagRequest, ResolveAttemptRequest,
        RevokeHostRequest, SubmitTaskRequest, Task,
        checkpoint_directory_server::CheckpointDirectoryServer, connector_server::ConnectorServer,
        host_directory_server::HostDirectoryServer, host_enrollment_server::HostEnrollmentServer,
        objectives_server::ObjectivesServer, operator_client::OperatorClient,
        operator_server::OperatorServer, transfers_server::TransfersServer,
        worker_host_server::WorkerHostServer,
    },
};
use supertag_worker_host::HostOptions;
use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use tokio_util::sync::CancellationToken;
use tonic::{Request, transport::Channel};
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "supertag", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct Connection {
    #[arg(
        long,
        conflicts_with = "state_directory",
        required_unless_present = "state_directory"
    )]
    gateway: Option<String>,
    #[arg(long)]
    state_directory: Option<PathBuf>,
}

#[derive(Clone, Copy, ValueEnum)]
enum RecoveryDecision {
    Failed,
    Retry,
}

#[derive(Subcommand)]
enum Command {
    /// Start the local Control Plane, Gateway, and Worker Host.
    Up {
        #[arg(long)]
        state_directory: PathBuf,
        #[command(flatten)]
        adapter: AdapterOptions,
        #[arg(long, default_value = "127.0.0.1:0")]
        gateway_listen: SocketAddr,
    },
    /// Run the private service that stores work and schedules execution.
    ControlPlane {
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,
    },
    /// Run the public gRPC service for operators and Worker Hosts.
    Gateway {
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,
        #[arg(long)]
        control_plane: String,
        #[arg(long)]
        checkpoint_directory: Option<PathBuf>,
        #[arg(long, requires = "slack_state_directory")]
        slack_listen: Option<SocketAddr>,
        #[arg(long, requires = "slack_listen")]
        slack_state_directory: Option<PathBuf>,
    },
    /// Connect a Worker Host and run accepted Tasks through an adapter.
    WorkerHost {
        #[arg(long)]
        gateway: String,
        #[arg(long)]
        state_directory: PathBuf,
        #[command(flatten)]
        adapter: AdapterOptions,
        #[arg(long, default_value_t = 120)]
        attempt_timeout_seconds: u64,
        #[arg(long)]
        once: bool,
        #[arg(long)]
        wait_for_recovery: bool,
    },
    /// Create a one-time, scoped Auth Key for a Worker Host.
    CreateAuthKey {
        #[command(flatten)]
        connection: Connection,
        host_id: String,
        #[arg(long, default_value_t = 600)]
        expires_in_seconds: u64,
        #[arg(
            long,
            conflicts_with = "all_tags",
            required_unless_present = "all_tags"
        )]
        tag: Vec<String>,
        #[arg(long)]
        all_tags: bool,
    },
    /// Enroll this installation with a one-time Auth Key.
    EnrollHost {
        #[arg(long)]
        gateway: String,
        #[arg(long)]
        state_directory: PathBuf,
        host_id: String,
        /// Auth Key or file:PATH. Also reads SUPERTAG_AUTH_KEY.
        #[arg(long)]
        auth_key: Option<String>,
    },
    /// Revoke a Worker Host and its execution authority.
    RevokeHost {
        #[command(flatten)]
        connection: Connection,
        host_id: String,
    },
    #[command(name = "__codex-adapter", hide = true)]
    CodexAdapter(CodexAdapterArgs),
    #[command(name = "__adapter-guardian", hide = true)]
    AdapterGuardian {
        #[arg(long)]
        adapter: PathBuf,
        #[arg(last = true)]
        adapter_args: Vec<OsString>,
    },
    /// Set the instructions and allowed actions for a Tag.
    PutTag {
        #[command(flatten)]
        connection: Connection,
        tag_id: String,
        #[arg(long)]
        instructions: String,
        #[arg(long)]
        allow: Vec<String>,
    },
    /// Accept one turn of work in a Tag's Session.
    Submit {
        #[command(flatten)]
        connection: Connection,
        #[arg(long)]
        tag: String,
        #[arg(long)]
        session: String,
        #[arg(long)]
        operation_id: Option<String>,
        prompt: String,
    },
    /// Read a Task.
    GetTask {
        #[command(flatten)]
        connection: Connection,
        task_id: String,
    },
    /// Read a page of recorded Task events.
    TaskEvents {
        #[command(flatten)]
        connection: Connection,
        task_id: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
    },
    /// Read native token usage recorded for a Task Attempt.
    TaskUsage {
        #[command(flatten)]
        connection: Connection,
        task_id: String,
        attempt_id: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
    },
    /// Cancel a Task.
    Cancel {
        #[command(flatten)]
        connection: Connection,
        task_id: String,
    },
    /// Record an audited decision for a stopped, uncertain Task Attempt.
    ResolveAttempt {
        #[command(flatten)]
        connection: Connection,
        task_id: String,
        attempt_id: String,
        #[arg(long, value_enum)]
        decision: RecoveryDecision,
        #[arg(long)]
        evidence: String,
        #[arg(long)]
        confirmed_stopped: bool,
        #[arg(long)]
        operation_id: Option<String>,
    },
    /// Manage an Objective and inspect its owner's work.
    Objective {
        #[command(flatten)]
        connection: Connection,
        #[command(subcommand)]
        command: objectives::ObjectiveCommand,
    },
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::AdapterGuardian {
            adapter,
            adapter_args,
        } => supertag_worker_host::guard_adapter(&adapter, &adapter_args),
        Command::CodexAdapter(args) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(harness::run_codex(args)),
        command => tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?
            .block_on(run(command)),
    }
}

async fn run(command: Command) -> Result<()> {
    match command {
        Command::Up {
            state_directory,
            adapter,
            gateway_listen,
        } => {
            local::up(
                local::LocalOptions {
                    state_directory,
                    adapter,
                    gateway_listen,
                },
                termination_signal(),
            )
            .await?;
        }
        Command::ControlPlane { listen } => control_plane(listen).await?,
        Command::Gateway {
            listen,
            control_plane,
            checkpoint_directory,
            slack_listen,
            slack_state_directory,
        } => {
            gateway(
                listen,
                control_plane,
                checkpoint_directory,
                slack_listen.zip(slack_state_directory),
            )
            .await?
        }
        Command::WorkerHost {
            gateway,
            state_directory,
            adapter,
            attempt_timeout_seconds,
            once,
            wait_for_recovery,
        } => {
            let forward_codex_credentials = adapter.uses_codex();
            let (adapter, adapter_args) = adapter.launch(attempt_timeout_seconds)?;
            let options = HostOptions {
                gateway: network::endpoint(gateway, false).await?,
                token: std::env::var("SUPERTAG_HOST_TOKEN").ok(),
                state_directory,
                adapter_guardian: std::env::current_exe()?,
                adapter,
                adapter_args,
                forward_codex_credentials,
                attempt_timeout: Duration::from_secs(attempt_timeout_seconds),
                wait_for_recovery,
                once,
            };
            let token = CancellationToken::new();
            let shutdown = token.clone();
            let signal = tokio::spawn(async move {
                termination_signal().await;
                shutdown.cancel();
            });
            let result = supertag_worker_host::run(options, token, || println!("ready")).await;
            signal.abort();
            result?;
        }
        Command::CreateAuthKey {
            connection,
            host_id,
            expires_in_seconds,
            tag,
            all_tags,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            let key = operator
                .create_auth_key(request(
                    CreateAuthKeyRequest {
                        host_id,
                        operation_id: Uuid::new_v4().to_string(),
                        key_digest: Sha256::digest(secret.as_bytes()).to_vec(),
                        expires_in_ms: expires_in_seconds
                            .checked_mul(1000)
                            .context("invalid Auth Key lifetime")?,
                        allowed_tag_ids: tag,
                        all_tags,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            println!(
                "{}",
                json!({
                    "auth_key": secret,
                    "host_id": key.host_id,
                    "expires_at_ms": key.expires_at_ms,
                    "allowed_tag_ids": key.allowed_tag_ids,
                    "all_tags": key.all_tags,
                })
            );
        }
        Command::EnrollHost {
            gateway,
            state_directory,
            host_id,
            auth_key,
        } => {
            let gateway = network::endpoint(gateway, false).await?;
            let auth_key = auth_key.or_else(|| std::env::var("SUPERTAG_AUTH_KEY").ok());
            let auth_key = match auth_key {
                Some(key) if key.starts_with("file:") => {
                    let path = key.strip_prefix("file:").expect("checked prefix");
                    let contents = tokio::fs::read_to_string(path)
                        .await
                        .context("read Auth Key file")?;
                    Some(contents.trim().to_owned())
                }
                other => other,
            };
            let record = supertag_worker_host::enroll(
                gateway,
                &state_directory,
                host_id,
                auth_key.as_deref(),
            )
            .await?;
            println!(
                "{}",
                json!({ "host_id": record.host_id, "generation": record.generation })
            );
        }
        Command::RevokeHost {
            connection,
            host_id,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let record = operator
                .revoke_host(request(RevokeHostRequest { host_id }, &token)?)
                .await?
                .into_inner();
            println!(
                "{}",
                json!({ "host_id": record.host_id, "revoked": record.revoked })
            );
        }
        Command::AdapterGuardian { .. } => unreachable!("guardian runs outside Tokio"),
        Command::CodexAdapter(_) => unreachable!("Codex adapter uses a dedicated runtime"),
        Command::PutTag {
            connection,
            tag_id,
            instructions,
            allow,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let tag = operator
                .put_tag(request(
                    PutTagRequest {
                        tag_id,
                        instructions,
                        allowed_actions: allow,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            println!(
                "{}",
                json!({ "tag_id": tag.tag_id, "revision": tag.revision })
            );
        }
        Command::Submit {
            connection,
            tag,
            session,
            operation_id,
            prompt,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let task = operator
                .submit_task(request(
                    SubmitTaskRequest {
                        tag_id: tag,
                        session_id: session,
                        prompt,
                        operation_id: operation_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            print_task(&task);
        }
        Command::GetTask {
            connection,
            task_id,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let task = operator
                .get_task(request(GetTaskRequest { task_id }, &token)?)
                .await?
                .into_inner();
            print_task(&task);
        }
        Command::TaskEvents {
            connection,
            task_id,
            after,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let events = operator
                .list_events(request(
                    ListEventsRequest {
                        task_id,
                        after_sequence: after,
                        limit: 100,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            for event in events.events {
                println!(
                    "{}",
                    json!({ "sequence": event.sequence, "text": event.text })
                );
            }
        }
        Command::TaskUsage {
            connection,
            task_id,
            attempt_id,
            after,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let response = operator
                .list_native_usage(request(
                    ListNativeUsageRequest {
                        task_id,
                        attempt_id,
                        after_sequence: after,
                        limit: 100,
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            for report in response.reports {
                if let Some(usage) = report.native_usage {
                    println!(
                        "{}",
                        json!({
                            "sequence": report.sequence,
                            "input_tokens": usage.input_tokens,
                            "cached_input_tokens": usage.cached_input_tokens,
                            "output_tokens": usage.output_tokens,
                            "observed_model": usage.observed_model,
                        })
                    );
                }
            }
        }
        Command::Cancel {
            connection,
            task_id,
        } => {
            let (mut operator, token) = operator(connection).await?;
            let task = operator
                .cancel_task(request(CancelTaskRequest { task_id }, &token)?)
                .await?
                .into_inner();
            print_task(&task);
        }
        Command::ResolveAttempt {
            connection,
            task_id,
            attempt_id,
            decision,
            evidence,
            confirmed_stopped,
            operation_id,
        } => {
            let (mut client, token) = operator(connection).await?;
            let decision = match decision {
                RecoveryDecision::Failed => AttemptDecision::Failed,
                RecoveryDecision::Retry => AttemptDecision::Retry,
            };
            let resolution = client
                .resolve_attempt(request(
                    ResolveAttemptRequest {
                        task_id,
                        attempt_id,
                        decision: decision as i32,
                        evidence,
                        confirmed_stopped,
                        operation_id: operation_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    },
                    &token,
                )?)
                .await?
                .into_inner();
            println!(
                "{}",
                json!({
                    "task_id": resolution.task_id, "attempt_id": resolution.attempt_id,
                    "decision": resolution.decision().as_str_name(),
                    "operator_id": resolution.operator_id, "resolved_at_ms": resolution.resolved_at_ms,
                })
            );
        }
        Command::Objective {
            connection,
            command,
        } => objectives::run(connection, command).await?,
    }
    Ok(())
}

async fn control_plane(listen: SocketAddr) -> Result<()> {
    let mut builder = network::server(listen, true).await?;
    let plane = ControlPlane::open(
        &required_env("SUPERTAG_DATABASE_URL")?,
        required_env("SUPERTAG_GATEWAY_TOKEN")?,
    )
    .await?;
    if let Ok(token) = std::env::var("SUPERTAG_BOOTSTRAP_HOST_TOKEN") {
        ensure!(
            token.len() >= 32,
            "invalid bootstrap Worker Host credential"
        );
        plane
            .seed_host("local", &Sha256::digest(token.as_bytes()))
            .await?;
    }
    let (health, health_service) = tonic_health::server::health_reporter();
    health.set_serving::<OperatorServer<ControlPlane>>().await;
    health.set_serving::<WorkerHostServer<ControlPlane>>().await;
    health
        .set_serving::<HostDirectoryServer<ControlPlane>>()
        .await;
    health
        .set_serving::<CheckpointDirectoryServer<ControlPlane>>()
        .await;
    health.set_serving::<ConnectorServer<ControlPlane>>().await;
    health.set_serving::<ObjectivesServer<ControlPlane>>().await;
    let listener = TcpListener::bind(listen).await?;
    println!("{}", listener.local_addr()?);
    let maintenance = plane.clone();
    let sweep = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(error) = maintenance.sweep().await {
                eprintln!("Control Plane maintenance failed: {error}");
            }
        }
    });
    let served = builder
        .add_service(health_service)
        .add_service(
            OperatorServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(
            WorkerHostServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(
            HostDirectoryServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(
            CheckpointDirectoryServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(
            ConnectorServer::new(plane.clone())
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .add_service(
            ObjectivesServer::new(plane)
                .max_decoding_message_size(MAX_MESSAGE_BYTES)
                .max_encoding_message_size(MAX_MESSAGE_BYTES),
        )
        .serve_with_incoming_shutdown(TcpListenerStream::new(listener), termination_signal())
        .await;
    sweep.abort();
    let _ = sweep.await;
    served?;
    Ok(())
}

async fn gateway(
    listen: SocketAddr,
    control_plane: String,
    checkpoint_directory: Option<PathBuf>,
    slack_options: Option<(SocketAddr, PathBuf)>,
) -> Result<()> {
    let mut builder = network::server(listen, false).await?;
    let channel = network::endpoint(control_plane, true)
        .await?
        .connect()
        .await?;
    let gateway_token = required_env("SUPERTAG_GATEWAY_TOKEN")?;
    let slack = match slack_options {
        Some((address, state_directory)) => {
            ensure!(
                address.ip().is_loopback(),
                "Slack webhook listener must use loopback"
            );
            let connector =
                slack_connector(channel.clone(), gateway_token.clone(), state_directory)?;
            Some((connector, TcpListener::bind(address).await?))
        }
        None => None,
    };
    let gateway = Gateway::new(
        channel,
        gateway_token,
        required_env("SUPERTAG_OPERATOR_TOKEN")?,
        std::env::var("SUPERTAG_OPERATOR_PRINCIPAL").unwrap_or_else(|_| "operator:local".into()),
    )?;
    let (health, health_service) = tonic_health::server::health_reporter();
    health.set_serving::<OperatorServer<Gateway>>().await;
    health.set_serving::<WorkerHostServer<Gateway>>().await;
    health.set_serving::<HostEnrollmentServer<Gateway>>().await;
    health
        .set_serving::<TransfersServer<CheckpointTransfers>>()
        .await;
    let transfers = CheckpointTransfers::new(gateway.clone(), checkpoint_directory)?;
    health.set_serving::<ObjectivesServer<Gateway>>().await;
    let listener = TcpListener::bind(listen).await?;
    println!("{}", listener.local_addr()?);
    if let Some((_, listener)) = &slack {
        println!("{}", listener.local_addr()?);
    }
    let shutdown = CancellationToken::new();
    let router = builder
        .add_service(health_service)
        .add_service(gateway.operator_service())
        .add_service(gateway.worker_host_service())
        .add_service(gateway.host_enrollment_service())
        .add_service(transfers.service())
        .add_service(gateway.objectives_service());
    let grpc = async {
        let result = router
            .serve_with_incoming_shutdown(
                TcpListenerStream::new(listener),
                shutdown.clone().cancelled_owned(),
            )
            .await;
        shutdown.cancel();
        result
    };
    let webhook = async {
        if let Some((slack, listener)) = slack {
            let result = slack.serve(listener, shutdown.clone()).await;
            shutdown.cancel();
            result
        } else {
            shutdown.cancelled().await;
            Ok(())
        }
    };
    let services = async {
        let (grpc, webhook) = tokio::join!(grpc, webhook);
        grpc?;
        webhook
    };
    tokio::pin!(services);
    tokio::select! {
        result = &mut services => result,
        _ = termination_signal() => {
            shutdown.cancel();
            tokio::time::timeout(Duration::from_secs(15), services)
                .await.context("Gateway shutdown timed out")?
        }
    }
}

fn slack_connector(
    channel: Channel,
    gateway_token: String,
    state_directory: PathBuf,
) -> Result<Slack> {
    let connector = Slack::new(
        SlackConfig {
            account_id: required_env("SUPERTAG_SLACK_ACCOUNT_ID")?,
            team_id: required_env("SUPERTAG_SLACK_TEAM_ID")?,
            channel_id: required_env("SUPERTAG_SLACK_CHANNEL_ID")?,
            tag_id: required_env("SUPERTAG_SLACK_TAG_ID")?,
            allowed_users: required_env("SUPERTAG_SLACK_ALLOWED_USERS")?
                .split(',')
                .map(|user| user.trim().to_owned())
                .collect(),
            signing_secret: required_env("SUPERTAG_SLACK_SIGNING_SECRET")?,
            bot_token: required_env("SUPERTAG_SLACK_BOT_TOKEN")?,
            state_directory,
        },
        channel,
        gateway_token,
    )?;
    #[cfg(feature = "test-fixtures")]
    if let Ok(url) = std::env::var("SUPERTAG_TEST_SLACK_API_URL") {
        return connector.with_test_reply_url(&url);
    }
    Ok(connector)
}

async fn termination_signal() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    let lifeline = async {
        if std::env::var_os(local::LOCAL_SERVICE_LIFELINE).as_deref()
            != Some(std::ffi::OsStr::new("1"))
        {
            std::future::pending::<()>().await;
        }
        let (closed, wait) = tokio::sync::oneshot::channel();
        let watcher = std::thread::Builder::new()
            .name("local-supervisor-lifeline".into())
            .spawn(move || {
                use std::io::Read;
                // A managed service receives only EOF on this pipe when its
                // supervisor exits. Standalone services use signal handlers.
                let _ = std::io::stdin().lock().read_exact(&mut [0_u8; 1]);
                let _ = closed.send(());
            });
        if watcher.is_ok() {
            let _ = wait.await;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
        _ = lifeline => {}
    }
}

async fn operator(connection: Connection) -> Result<(OperatorClient<Channel>, String)> {
    let (channel, token) = connect_operator(connection).await?;
    Ok((
        OperatorClient::new(channel)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES),
        token,
    ))
}

async fn connect_operator(connection: Connection) -> Result<(Channel, String)> {
    let (uri, token) = if let Some(directory) = connection.state_directory {
        local::connection(&directory)?
    } else {
        (
            connection.gateway.context("Gateway address required")?,
            required_env("SUPERTAG_OPERATOR_TOKEN")?,
        )
    };
    let channel = network::endpoint(uri, false).await?.connect().await?;
    Ok((channel, token))
}

fn required_env(name: &str) -> Result<String> {
    let value = std::env::var(name).with_context(|| format!("set {name}"))?;
    ensure!(!value.trim().is_empty(), "{name} must be nonempty");
    Ok(value)
}

fn request<T>(message: T, token: &str) -> Result<Request<T>> {
    let mut request = authenticated_request(message, token, None)?;
    request.set_timeout(Duration::from_secs(10));
    Ok(request)
}

fn print_task(task: &Task) {
    println!(
        "{}",
        json!({
            "task_id": task.task_id, "tag_id": task.tag_id, "session_id": task.session_id,
            "state": task.state().as_str_name(), "result": task.result, "attempt_id": task.attempt_id,
        })
    );
}
