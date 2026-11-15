use std::{future::Future, sync::atomic::Ordering, time::Duration};

use supertag_protocol::{
    MAX_WORKSPACE_TOOL_OUTPUT_BYTES,
    v2::{HarnessWorkspaceResult, SharedExecutionTool, WorkspaceCommand},
};
use supertag_shared_execution::v2::{
    ExecuteRequest, InspectOperationRequest, OperationReceipt, OperationState, OutputStream,
    PrepareCommandLeaseRequest, RenewCommandLeaseRequest, StartProcess, StopProcess,
    WatchProcessRequest, execute_request::Operation, operation_receipt::Result as Effect,
};
use tokio::time::{self, Instant};
use tonic::{Code, Status};
use uuid::Uuid;

use super::{Access, request};

const LEASE_MAX_MS: u64 = 5_000;
const RENEW_EVERY: Duration = Duration::from_secs(1);
const DEFAULT_COMMAND_TIMEOUT_MS: u32 = 120_000;

impl Access {
    pub(crate) async fn command<F>(
        &self,
        command: WorkspaceCommand,
        tool_deadline: Instant,
        mut current_authority: impl FnMut() -> F,
    ) -> Result<HarnessWorkspaceResult, Status>
    where
        F: Future<Output = Result<u64, Status>>,
    {
        self.require_no_pending_command()?;
        if !self.allows(SharedExecutionTool::Command) {
            return Err(Status::permission_denied(
                "shared execution has no command authority",
            ));
        }
        self.renew_command_lease(&mut current_authority).await?;
        self.commands_blocked.store(true, Ordering::Release);
        let operation_id = Uuid::new_v4().to_string();
        let started = self.start_command(&operation_id, command).await?;
        let process_id = started
            .process_id
            .as_deref()
            .filter(|id| Uuid::parse_str(id).is_ok())
            .ok_or_else(|| Status::data_loss("shared command receipt lacks a process identity"))?;
        if started.operation_id != operation_id {
            return Err(Status::data_loss(
                "shared command receipt has a different identity",
            ));
        }
        // An Accepted launch reservation may become Running after a lost start response.
        // Require a terminal, verified receipt even if the reservation was not armed when read.
        let result = self
            .watch_command(
                process_id,
                &operation_id,
                tool_deadline,
                &mut current_authority,
            )
            .await;
        let (receipt, output) = match result {
            Ok(result) => result,
            Err(error) => {
                // Stop is an owned, fenced effect. On transport loss the provider guardian
                // independently expires, and Task settlement still requires a verified revoke.
                if self.stop_command(process_id).await.is_ok() {
                    self.commands_blocked.store(false, Ordering::Release);
                }
                return Err(error);
            }
        };
        if !receipt.cleanup_verified {
            return Err(Status::failed_precondition(
                "shared command cleanup is unverified",
            ));
        }
        self.commands_blocked.store(false, Ordering::Release);
        let exit = match receipt.result {
            Some(Effect::ProcessResult(result))
                if receipt.state == OperationState::Completed as i32 =>
            {
                result.exit_code
            }
            _ => None,
        };
        let description = exit.map_or_else(
            || "Shared command stopped or failed".to_string(),
            |code| format!("Shared command exited with status {code}"),
        );
        let text = format!("{description}\n{}", String::from_utf8_lossy(&output));
        if text.len() > MAX_WORKSPACE_TOOL_OUTPUT_BYTES {
            return Err(Status::resource_exhausted(
                "shared command output exceeds its bound",
            ));
        }
        if text.contains(&self.token) {
            return Err(Status::data_loss(
                "shared command output contains private access material",
            ));
        }
        Ok(HarnessWorkspaceResult {
            text,
            is_error: exit != Some(0),
        })
    }

    async fn renew_command_lease<F>(
        &self,
        current_authority: &mut impl FnMut() -> F,
    ) -> Result<(), Status>
    where
        F: Future<Output = Result<u64, Status>>,
    {
        let mut client = self.client.clone();
        let challenge = client
            .prepare_command_lease(request(
                PrepareCommandLeaseRequest {
                    access_id: self.access_id.clone(),
                },
                &self.token,
            )?)
            .await
            .map_err(|_| Status::failed_precondition("shared command challenge is unavailable"))?
            .into_inner();
        if challenge.access_id != self.access_id
            || Uuid::parse_str(&challenge.challenge_id).is_err()
        {
            return Err(Status::data_loss(
                "shared command challenge has a different identity",
            ));
        }
        // Read authority only after the provider has started the challenge clock.
        let valid_for_ms = current_authority().await?.min(LEASE_MAX_MS);
        let receipt = client
            .renew_command_lease(request(
                RenewCommandLeaseRequest {
                    access_id: self.access_id.clone(),
                    challenge_id: challenge.challenge_id,
                    valid_for_ms,
                },
                &self.token,
            )?)
            .await
            .map_err(|_| {
                Status::failed_precondition("shared command authority could not be renewed")
            })?
            .into_inner();
        if receipt.access_id != self.access_id
            || !(1..=valid_for_ms).contains(&receipt.valid_for_ms)
        {
            return Err(Status::data_loss(
                "shared command authority receipt is invalid",
            ));
        }
        Ok(())
    }

    async fn start_command(
        &self,
        operation_id: &str,
        command: WorkspaceCommand,
    ) -> Result<OperationReceipt, Status> {
        let mut client = self.client.clone();
        let response = client
            .execute(request(
                ExecuteRequest {
                    operation_id: operation_id.into(),
                    operation: Some(Operation::StartProcess(StartProcess {
                        command: "/bin/sh".into(),
                        args: vec!["-c".into(), command.command],
                        cwd: ".".into(),
                        stdin: vec![],
                        timeout_ms: u64::from(
                            command.timeout_ms.unwrap_or(DEFAULT_COMMAND_TIMEOUT_MS),
                        ),
                    })),
                },
                &self.token,
            )?)
            .await;
        let result = match response {
            Err(error)
                if matches!(
                    error.code(),
                    Code::Unavailable | Code::DeadlineExceeded | Code::Cancelled
                ) =>
            {
                client
                    .inspect_operation(request(
                        InspectOperationRequest {
                            operation_id: operation_id.into(),
                        },
                        &self.token,
                    )?)
                    .await
            }
            response => response,
        };
        result
            .map(tonic::Response::into_inner)
            .map_err(|_| Status::unavailable("shared command launch could not be confirmed"))
    }

    async fn stop_command(&self, process_id: &str) -> Result<(), Status> {
        let operation_id = Uuid::new_v4().to_string();
        let receipt = self
            .client
            .clone()
            .execute(request(
                ExecuteRequest {
                    operation_id: operation_id.clone(),
                    operation: Some(Operation::StopProcess(StopProcess {
                        process_id: process_id.into(),
                    })),
                },
                &self.token,
            )?)
            .await?
            .into_inner();
        if receipt.operation_id != operation_id
            || receipt.state() != OperationState::Completed
            || !receipt.cleanup_verified
            || !matches!(receipt.result, Some(Effect::ProcessStopped(stopped)) if stopped.stopped)
        {
            return Err(Status::failed_precondition(
                "shared command stop receipt is invalid",
            ));
        }
        Ok(())
    }

    async fn watch_command<F>(
        &self,
        process_id: &str,
        operation_id: &str,
        deadline: Instant,
        current_authority: &mut impl FnMut() -> F,
    ) -> Result<(OperationReceipt, Vec<u8>), Status>
    where
        F: Future<Output = Result<u64, Status>>,
    {
        let mut watch = request(
            WatchProcessRequest {
                process_id: process_id.into(),
                after_sequence: 0,
            },
            &self.token,
        )?;
        watch.set_timeout(deadline.saturating_duration_since(Instant::now()));
        let mut stream = self
            .client
            .clone()
            .watch_process(watch)
            .await
            .map_err(|_| Status::unavailable("shared command output is unavailable"))?
            .into_inner();
        let mut renewal = time::interval_at(Instant::now() + RENEW_EVERY, RENEW_EVERY);
        renewal.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
        let mut cursor = 0;
        let mut output = Vec::new();
        loop {
            let page = tokio::select! {
                _ = renewal.tick() => {
                    self.renew_command_lease(current_authority).await?;
                    continue;
                }
                page = stream.message() => page
                    .map_err(|_| Status::unavailable("shared command output was interrupted"))?
                    .ok_or_else(|| Status::unavailable("shared command ended before cleanup proof"))?,
            };
            if page.process_id != process_id {
                return Err(Status::data_loss(
                    "shared command output has a different identity",
                ));
            }
            for chunk in page.chunks {
                cursor += 1;
                if chunk.sequence != cursor
                    || !matches!(chunk.stream(), OutputStream::Stdout | OutputStream::Stderr)
                {
                    return Err(Status::data_loss(
                        "shared command output sequence is invalid",
                    ));
                }
                if output.len().saturating_add(chunk.data.len()) > MAX_WORKSPACE_TOOL_OUTPUT_BYTES {
                    return Err(Status::resource_exhausted(
                        "shared command output exceeds its bound",
                    ));
                }
                output.extend(chunk.data);
            }
            if page.next_cursor != cursor {
                return Err(Status::data_loss("shared command output cursor is invalid"));
            }
            if let Some(receipt) = page.terminal {
                if receipt.operation_id != operation_id
                    || receipt.process_id.as_deref() != Some(process_id)
                {
                    return Err(Status::data_loss(
                        "shared command terminal receipt has a different identity",
                    ));
                }
                return Ok((receipt, output));
            }
        }
    }
}
