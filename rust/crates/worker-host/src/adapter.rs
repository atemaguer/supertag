use std::{
    ffi::OsStr,
    io,
    process::{ExitStatus, Stdio},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, anyhow, ensure};
use prost::Message;
use supertag_protocol::{
    MAX_MESSAGE_BYTES, authenticated_request, matches_bearer,
    v2::{
        AdapterBootstrap, AppendEventRequest, Assignment, HarnessAttachRequest,
        HarnessCompleteRequest, HarnessCompleteResponse, HarnessPublishRequest, HarnessRun,
        InspectAttemptRequest, TaskEvent, TaskState,
        harness_server::{Harness, HarnessServer},
        worker_host_client::WorkerHostClient,
    },
};
use tokio::{
    io::AsyncWriteExt,
    net::TcpListener,
    process::{Child, Command},
    sync::Mutex,
    time,
};
use tokio_stream::wrappers::TcpListenerStream;
use tokio_util::sync::CancellationToken;
use tonic::{
    Request, Response, Status,
    transport::{Channel, Server},
};
use uuid::Uuid;

use crate::{HostOptions, guardian::MAX_BOOTSTRAP_BYTES};

#[derive(Clone)]
struct Bridge {
    token: String,
    assignment: Assignment,
    host_token: String,
    host: WorkerHostClient<Channel>,
    state: Arc<Mutex<RunState>>,
}

#[derive(Default)]
struct RunState {
    attached: bool,
    outcome: Option<HarnessCompleteRequest>,
}

impl Bridge {
    fn authenticate<T>(&self, request: &Request<T>) -> Result<(), Status> {
        if !matches_bearer(request, &self.token) {
            return Err(Status::unauthenticated("execution credential required"));
        }
        Ok(())
    }

    fn task_id(&self) -> &str {
        &self
            .assignment
            .task
            .as_ref()
            .expect("validated assignment")
            .task_id
    }
}

#[tonic::async_trait]
impl Harness for Bridge {
    async fn attach(
        &self,
        request: Request<HarnessAttachRequest>,
    ) -> Result<Response<HarnessRun>, Status> {
        self.authenticate(&request)?;
        self.state.lock().await.attached = true;
        Ok(Response::new(HarnessRun {
            task: self.assignment.task.clone(),
            attempt_id: self.assignment.attempt_id.clone(),
        }))
    }

    async fn publish(
        &self,
        request: Request<HarnessPublishRequest>,
    ) -> Result<Response<TaskEvent>, Status> {
        self.authenticate(&request)?;
        let state = self.state.lock().await;
        if !state.attached || state.outcome.is_some() {
            return Err(Status::failed_precondition(
                "execution is not accepting events",
            ));
        }
        let event = request.into_inner();
        let mut upstream = authenticated_request(
            AppendEventRequest {
                task_id: self.task_id().into(),
                attempt_id: self.assignment.attempt_id.clone(),
                lease_token: self.assignment.lease_token.clone(),
                sequence: event.sequence,
                text: event.text,
            },
            &self.host_token,
            None,
        )?;
        upstream.set_timeout(Duration::from_secs(5));
        let event = self.host.clone().append_event(upstream).await?;
        drop(state);
        Ok(event)
    }

    async fn complete(
        &self,
        request: Request<HarnessCompleteRequest>,
    ) -> Result<Response<HarnessCompleteResponse>, Status> {
        self.authenticate(&request)?;
        let mut state = self.state.lock().await;
        if !state.attached {
            return Err(Status::failed_precondition(
                "adapter must attach before proposing a result",
            ));
        }
        let outcome = request.into_inner();
        if let Some(previous) = &state.outcome {
            if previous != &outcome {
                return Err(Status::already_exists(
                    "adapter already proposed a different result",
                ));
            }
        } else {
            state.outcome = Some(outcome);
        }
        Ok(Response::new(HarnessCompleteResponse {}))
    }
}

pub(crate) async fn execute(
    options: &HostOptions,
    assignment: Assignment,
    host: WorkerHostClient<Channel>,
    shutdown: &CancellationToken,
) -> Result<HarnessCompleteRequest> {
    ensure!(assignment.task.is_some(), "assignment is missing its Task");
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let bootstrap = AdapterBootstrap {
        endpoint: format!("http://{}", listener.local_addr()?),
        token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
    };
    let bridge = Bridge {
        token: bootstrap.token.clone(),
        assignment,
        host_token: options.token.clone(),
        host,
        state: Arc::default(),
    };
    let stop_server = CancellationToken::new();
    let mut server = tokio::spawn(
        Server::builder()
            .add_service(
                HarnessServer::new(bridge.clone())
                    .max_decoding_message_size(MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES),
            )
            .serve_with_incoming_shutdown(
                TcpListenerStream::new(listener),
                stop_server.clone().cancelled_owned(),
            ),
    );
    let result = supervise(options, &bridge, bootstrap, shutdown).await;
    stop_server.cancel();
    if time::timeout(Duration::from_secs(2), &mut server)
        .await
        .is_err()
    {
        server.abort();
        let _ = server.await;
    }
    result
}

async fn supervise(
    options: &HostOptions,
    bridge: &Bridge,
    bootstrap: AdapterBootstrap,
    shutdown: &CancellationToken,
) -> Result<HarnessCompleteRequest> {
    if shutdown.is_cancelled() {
        return Ok(failed("Worker Host is shutting down"));
    }
    let mut command = Command::new(&options.adapter_guardian);
    command
        .args(["__adapter-guardian", "--adapter"])
        .arg(&options.adapter)
        .arg("--")
        .args(&options.adapter_args)
        .env_clear()
        .envs(
            ["PATH", "TMPDIR", "LANG"]
                .into_iter()
                .filter_map(|name| std::env::var_os(name).map(|value| (OsStr::new(name), value))),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return Ok(failed("Harness adapter could not start")),
    };
    let group = child.id().context("adapter process has no PID")?;
    let outcome = time::timeout(options.attempt_timeout, async {
        let mut input = child
            .stdin
            .take()
            .context("adapter bootstrap pipe is missing")?;
        let payload = bootstrap.encode_to_vec();
        ensure!(
            payload.len() <= MAX_BOOTSTRAP_BYTES,
            "adapter bootstrap exceeds size limit"
        );
        input
            .write_all(&(payload.len() as u32).to_le_bytes())
            .await?;
        input.write_all(&payload).await?;
        // Keep the pipe open while monitoring. It closes on cancellation,
        // deadline, or Worker Host death and wakes the guardian.
        let outcome = monitor(&mut child, bridge, shutdown).await;
        drop(input);
        outcome
    })
    .await;
    if child.try_wait()?.is_none() {
        // Give the guardian time to reap the adapter before forcing down the group.
        let _ = time::timeout(Duration::from_millis(500), child.wait()).await;
    }
    let survivors = signal_group(group, libc::SIGKILL)?;
    time::timeout(Duration::from_secs(2), async {
        if child.try_wait()?.is_none() {
            child.kill().await?;
        }
        child.wait().await?;
        while signal_group(group, 0)? {
            time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("adapter process group did not stop")??;
    let status = match outcome {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => return Ok(failed("Harness execution was interrupted")),
        Err(_) => return Ok(failed("Harness execution timed out")),
    };
    if survivors || !status.success() {
        return Ok(failed(
            "Harness adapter exited unsuccessfully or left running descendants",
        ));
    }
    Ok(bridge
        .state
        .lock()
        .await
        .outcome
        .clone()
        .unwrap_or_else(|| failed("Harness adapter exited without an outcome")))
}

fn failed(message: &str) -> HarnessCompleteRequest {
    HarnessCompleteRequest {
        result: message.into(),
        succeeded: false,
    }
}

async fn monitor(
    child: &mut Child,
    bridge: &Bridge,
    shutdown: &CancellationToken,
) -> Result<ExitStatus> {
    let mut interval = time::interval(Duration::from_millis(250));
    interval.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
    let check_cancellation = async {
        let mut host = bridge.host.clone();
        loop {
            interval.tick().await;
            let mut request = authenticated_request(
                InspectAttemptRequest {
                    task_id: bridge.task_id().into(),
                    attempt_id: bridge.assignment.attempt_id.clone(),
                    lease_token: bridge.assignment.lease_token.clone(),
                },
                &bridge.host_token,
                None,
            )?;
            request.set_timeout(Duration::from_secs(2));
            match host.inspect_attempt(request).await {
                Ok(response) if response.get_ref().state() == TaskState::Running => {}
                Ok(_) => return Err(anyhow!("Control Plane ended the Task Attempt")),
                Err(error)
                    if matches!(
                        error.code(),
                        tonic::Code::Unavailable
                            | tonic::Code::DeadlineExceeded
                            | tonic::Code::Cancelled
                    ) => {}
                Err(error) => return Err(error.into()),
            }
        }
    };
    tokio::select! {
        status = child.wait() => Ok(status?),
        result = check_cancellation => result,
        _ = shutdown.cancelled() => Err(anyhow!("Worker Host is shutting down")),
    }
}

fn signal_group(group: u32, signal: i32) -> Result<bool> {
    let group = i32::try_from(group).context("adapter process group is out of range")?;
    ensure!(group > 0, "invalid adapter process group");
    // The child was launched as leader of a dedicated Unix process group.
    let result = unsafe { libc::kill(-group, signal) };
    if result == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(false);
    }
    Err(error.into())
}
