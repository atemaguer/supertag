mod command;

use std::{
    net::IpAddr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, MAX_WORKSPACE_TOOL_OUTPUT_BYTES, authenticated_request,
    v2::{
        HarnessWorkspaceRequest, HarnessWorkspaceResult, HostRecord, SharedExecutionAccessSummary,
        SharedExecutionCapability, SharedExecutionTool, Task,
        harness_workspace_request::Operation as Tool,
    },
};
use supertag_shared_execution::v2::{
    AccessCommandMode, AccessReceipt, AccessState, DescribeEnvironmentRequest, EndAccessRequest,
    ExecuteRequest, InspectOperationRequest, IssueAccessRequest, OperationReceipt, OperationState,
    ReadFile, WriteFile, execute_request::Operation, operation_receipt::Result as Effect,
    shared_execution_client::SharedExecutionClient,
};
use tonic::{
    Code, Request, Status,
    transport::{Certificate, Channel, ClientTlsConfig, Endpoint},
};
use uuid::Uuid;

use crate::{
    HostOptions,
    journal::{Attempt, Journal},
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_FILE_BYTES: usize = 256 * 1024;

#[derive(Clone)]
pub struct SharedExecutionConfig {
    client: SharedExecutionClient<Channel>,
    admin_token: String,
    scope: String,
    incarnation_id: String,
    capability: SharedExecutionCapability,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AccessRecord {
    pub(crate) scope: String,
    pub(crate) host_id: String,
    pub(crate) host_generation: u64,
    pub(crate) task_id: String,
    pub(crate) attempt_id: String,
    pub(crate) tag_id: String,
    pub(crate) environment_id: String,
    pub(crate) incarnation_id: String,
    pub(crate) access_id: String,
    pub(crate) ttl_ms: u64,
    pub(crate) ended: bool,
    #[serde(default)]
    pub(crate) command_mode: i32,
}

#[derive(Clone)]
pub(crate) struct Access {
    client: SharedExecutionClient<Channel>,
    token: String,
    access_id: String,
    commands_blocked: Arc<AtomicBool>,
    capability: SharedExecutionCapability,
    pub(crate) summary: SharedExecutionAccessSummary,
}

impl SharedExecutionConfig {
    pub async fn connect(
        uri: String,
        environment_id: String,
        admin_token: String,
        ca: Option<Vec<u8>>,
        allow_commands: bool,
    ) -> Result<Self> {
        ensure!(
            supertag_protocol::shared_execution::valid_environment_id(&environment_id)
                && (16..=512).contains(&admin_token.len())
                && admin_token.bytes().all(|byte| (33..=126).contains(&byte)),
            "invalid shared execution identity or admin credential"
        );
        let mut endpoint = Endpoint::from_shared(uri)
            .map_err(|_| anyhow::anyhow!("invalid shared execution endpoint"))?
            .connect_timeout(REQUEST_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .http2_keep_alive_interval(supertag_transport::KEEPALIVE_INTERVAL)
            .keep_alive_timeout(supertag_transport::KEEPALIVE_TIMEOUT)
            .keep_alive_while_idle(true);
        let target = endpoint.uri();
        ensure!(
            target.path() == "/"
                && target.query().is_none()
                && target
                    .authority()
                    .is_some_and(|value| !value.as_str().contains('@')),
            "shared execution endpoint must be a credential-free origin"
        );
        let origin = target.to_string();
        match target.scheme_str() {
            Some("https") => {
                let tls = match &ca {
                    Some(ca) => {
                        ClientTlsConfig::new().ca_certificate(Certificate::from_pem(ca.clone()))
                    }
                    None => ClientTlsConfig::new().with_native_roots(),
                };
                endpoint = endpoint.tls_config(tls)?;
            }
            Some("http") => {
                ensure!(
                    ca.is_none()
                        && target.host().is_some_and(|host| host
                            .trim_matches(['[', ']'])
                            .parse::<IpAddr>()
                            .is_ok_and(|ip| ip.is_loopback())),
                    "cleartext shared execution requires a loopback IP address"
                );
            }
            _ => anyhow::bail!("shared execution endpoint must use HTTP or HTTPS"),
        }
        let mut client = SharedExecutionClient::new(endpoint.connect().await?)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES);
        let info = client
            .describe(request(DescribeEnvironmentRequest {}, &admin_token)?)
            .await
            .map_err(|_| anyhow::anyhow!("shared execution service could not verify its identity"))?
            .into_inner();
        ensure!(
            info.environment_id == environment_id && Uuid::parse_str(&info.incarnation_id).is_ok(),
            "shared execution service identity did not match"
        );
        let mut tools = vec![];
        if info.file_read {
            tools.push(SharedExecutionTool::Read as i32);
        }
        if info.file_write {
            tools.push(SharedExecutionTool::Write as i32);
        }
        if allow_commands {
            ensure!(
                info.lease_bound_commands,
                "shared execution provider does not support lease-bound commands"
            );
            tools.push(SharedExecutionTool::Command as i32);
        }
        let mut capability = SharedExecutionCapability {
            environment_id,
            tools,
            incarnation_id: info.incarnation_id.clone(),
        };
        ensure!(
            supertag_protocol::shared_execution::normalize(&mut capability),
            "shared execution service has no supported file tools"
        );
        let scope = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &origin,
                &capability.environment_id,
                &info.incarnation_id,
                format!("{:x}", Sha256::digest(admin_token.as_bytes())),
                ca.as_deref()
                    .map(|bytes| format!("{:x}", Sha256::digest(bytes))),
            ))?)
        );
        Ok(Self {
            client,
            admin_token,
            scope,
            incarnation_id: info.incarnation_id,
            capability,
        })
    }

    pub fn capability(&self) -> &SharedExecutionCapability {
        &self.capability
    }

    fn token(&self, record: &AccessRecord) -> Result<String> {
        let mut signer = Hmac::<Sha256>::new_from_slice(self.admin_token.as_bytes())?;
        signer.update(b"supertag/shared-execution/access/v1\0");
        signer.update(&serde_json::to_vec(&(
            &record.access_id,
            &record.host_id,
            record.host_generation,
            &record.task_id,
            &record.attempt_id,
            &record.tag_id,
            &record.environment_id,
            &record.incarnation_id,
            record.ttl_ms,
        ))?);
        if record.command_mode != 0 {
            signer.update(&record.command_mode.to_le_bytes());
        }
        Ok(format!("{:x}", signer.finalize().into_bytes()))
    }

    async fn issue(&self, record: &AccessRecord) -> Result<(AccessReceipt, String)> {
        let access_token = self.token(record)?;
        let mut request = request(
            IssueAccessRequest {
                environment_id: record.environment_id.clone(),
                access_id: record.access_id.clone(),
                task_id: record.task_id.clone(),
                attempt_id: record.attempt_id.clone(),
                tag_id: record.tag_id.clone(),
                ttl_ms: record.ttl_ms,
                expected_incarnation_id: Some(record.incarnation_id.clone()),
                command_mode: record.command_mode,
            },
            &self.admin_token,
        )?;
        let mut grant: tonic::metadata::MetadataValue<_> = access_token.parse()?;
        grant.set_sensitive(true);
        request
            .metadata_mut()
            .insert("x-supertag-grant-token", grant);
        let receipt = self
            .client
            .clone()
            .issue_access(request)
            .await
            .map_err(|_| anyhow::anyhow!("shared execution access receipt is unavailable"))?
            .into_inner();
        record.verify(&receipt)?;
        Ok((receipt, access_token))
    }
}

impl AccessRecord {
    fn verify(&self, receipt: &AccessReceipt) -> Result<()> {
        ensure!(
            receipt.access_id == self.access_id
                && receipt.environment_id == self.environment_id
                && receipt.incarnation_id == self.incarnation_id
                && receipt.task_id == self.task_id
                && receipt.attempt_id == self.attempt_id
                && receipt.tag_id == self.tag_id
                && receipt.expires_at_ms > 0,
            "shared execution receipt does not match the authorized Attempt"
        );
        Ok(())
    }
}

pub(crate) async fn prepare(
    config: &SharedExecutionConfig,
    journal: &Journal,
    attempt: &Attempt,
    task: &Task,
    registration: &HostRecord,
    timeout: Duration,
) -> Result<Access> {
    ensure!(
        journal.shared_access()?.is_none(),
        "shared execution access requires recovery before launch"
    );
    ensure!(
        task.task_id == attempt.task_id && task.attempt_id.as_deref() == Some(&attempt.attempt_id),
        "shared execution requires the exact authorized Attempt"
    );
    let record = AccessRecord {
        scope: config.scope.clone(),
        host_id: registration.host_id.clone(),
        host_generation: registration.generation,
        task_id: task.task_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        tag_id: task.tag_id.clone(),
        environment_id: config.capability.environment_id.clone(),
        incarnation_id: config.incarnation_id.clone(),
        access_id: Uuid::new_v4().to_string(),
        ttl_ms: timeout
            .saturating_add(Duration::from_secs(30))
            .clamp(Duration::from_secs(1), Duration::from_secs(86_400))
            .as_millis() as u64,
        ended: false,
        command_mode: if task
            .allowed_actions
            .iter()
            .any(|action| action == "commands:execute")
        {
            AccessCommandMode::LeaseBound as i32
        } else {
            AccessCommandMode::Disabled as i32
        },
    };
    journal.save_shared_access(&record)?;
    let (receipt, token) = config.issue(&record).await?;
    ensure!(
        receipt.state() == AccessState::Active && !receipt.cleanup_verified,
        "shared execution access is no longer active"
    );
    Ok(Access {
        client: config.client.clone(),
        token,
        access_id: record.access_id,
        commands_blocked: Arc::default(),
        capability: config.capability.clone(),
        summary: SharedExecutionAccessSummary {
            environment_id: record.environment_id,
            incarnation_id: record.incarnation_id,
        },
    })
}

pub(crate) async fn ensure_released(
    options: &HostOptions,
    journal: &Journal,
    attempt: &Attempt,
    registration: &HostRecord,
) -> Result<()> {
    let Some(mut record) = journal.shared_access()? else {
        return Ok(());
    };
    ensure!(
        record.task_id == attempt.task_id && record.attempt_id == attempt.attempt_id,
        "shared execution cleanup belongs to another Attempt"
    );
    if record.ended {
        return Ok(());
    }
    ensure!(
        record.host_id == registration.host_id && record.host_generation == registration.generation,
        "shared execution cleanup requires the original Worker Host generation"
    );
    let config = options
        .shared_execution
        .as_ref()
        .context("shared execution cleanup requires its provider")?;
    ensure!(
        record.scope == config.scope && record.incarnation_id == config.incarnation_id,
        "shared execution cleanup requires the original provider authority"
    );
    // The initial Issue RPC may have committed after its response was lost. Replaying exactly
    // converges on one access identity, even when the original request never reached the service.
    config.issue(&record).await?;
    let receipt = config
        .client
        .clone()
        .revoke_access(request(
            EndAccessRequest {
                access_id: record.access_id.clone(),
            },
            &config.admin_token,
        )?)
        .await
        .map_err(|_| anyhow::anyhow!("shared execution cleanup receipt is unavailable"))?
        .into_inner();
    record.verify(&receipt)?;
    ensure!(
        receipt.cleanup_verified
            && matches!(
                receipt.state(),
                AccessState::Released | AccessState::Revoked
            ),
        "shared execution cleanup has no verified provider receipt"
    );
    record.ended = true;
    journal.save_shared_access(&record)
}

fn request<T>(body: T, token: &str) -> Result<Request<T>, Status> {
    let mut request = authenticated_request(body, token, None)?;
    request.set_timeout(REQUEST_TIMEOUT);
    Ok(request)
}

impl Access {
    fn allows(&self, tool: SharedExecutionTool) -> bool {
        self.capability.tools.contains(&(tool as i32))
    }

    fn require_no_pending_command(&self) -> Result<(), Status> {
        if self.commands_blocked.load(Ordering::Acquire) {
            return Err(Status::failed_precondition(
                "shared command cleanup has not been verified",
            ));
        }
        Ok(())
    }

    pub(crate) async fn execute(
        &self,
        input: HarnessWorkspaceRequest,
    ) -> Result<HarnessWorkspaceResult, Status> {
        self.require_no_pending_command()?;
        let operation_id = Uuid::new_v4().to_string();
        let (operation, read, bytes) = match input.operation {
            Some(Tool::Read(read)) if self.allows(SharedExecutionTool::Read) => {
                let file = ReadFile {
                    path: read.path.clone(),
                    maximum_bytes: MAX_FILE_BYTES as u32,
                };
                (Operation::ReadFile(file), Some(read), None)
            }
            Some(Tool::Write(write)) if self.allows(SharedExecutionTool::Write) => {
                if write.content.len() > MAX_FILE_BYTES {
                    return Err(Status::resource_exhausted(
                        "shared file write exceeds its bound",
                    ));
                }
                let bytes = write.content.len() as u32;
                (
                    Operation::WriteFile(WriteFile {
                        path: write.path,
                        content: write.content.into_bytes(),
                        overwrite: true,
                    }),
                    None,
                    Some(bytes),
                )
            }
            _ => {
                return Err(Status::permission_denied(
                    "shared execution has no authority for this tool",
                ));
            }
        };
        let mut client = self.client.clone();
        let input = ExecuteRequest {
            operation_id: operation_id.clone(),
            operation: Some(operation),
        };
        let receipt = match client.execute(request(input, &self.token)?).await {
            Ok(receipt) => receipt.into_inner(),
            Err(error)
                if matches!(
                    error.code(),
                    Code::Unavailable | Code::DeadlineExceeded | Code::Cancelled
                ) =>
            {
                client
                    .inspect_operation(request(
                        InspectOperationRequest {
                            operation_id: operation_id.clone(),
                        },
                        &self.token,
                    )?)
                    .await
                    .map_err(|_| Status::unavailable("shared file effect could not be confirmed"))?
                    .into_inner()
            }
            Err(error) => {
                return Err(Status::new(
                    error.code(),
                    "shared file operation was refused",
                ));
            }
        };
        let output = convert_receipt(receipt, &operation_id, read, bytes)?;
        if output.text.contains(&self.token) {
            return Err(Status::data_loss(
                "shared file contains private access material",
            ));
        }
        Ok(output)
    }
}

fn convert_receipt(
    receipt: OperationReceipt,
    id: &str,
    read: Option<supertag_protocol::v2::WorkspaceRead>,
    bytes: Option<u32>,
) -> Result<HarnessWorkspaceResult, Status> {
    if receipt.operation_id != id || receipt.process_id.is_some() {
        return Err(Status::data_loss(
            "shared file receipt has a different identity",
        ));
    }
    let status = receipt.state();
    if status != OperationState::Completed {
        return Ok(HarnessWorkspaceResult {
            is_error: true,
            text: if status == OperationState::Failed {
                "Shared file operation failed within the fixed root".into()
            } else {
                "Shared file effect could not be confirmed".into()
            },
        });
    }
    if !receipt.cleanup_verified {
        return Err(Status::data_loss("shared file receipt is unsettled"));
    }
    let text = match (receipt.result, read, bytes) {
        (Some(Effect::FileContent(file)), Some(read), None)
            if file.content.len() <= MAX_FILE_BYTES =>
        {
            let text = String::from_utf8(file.content)
                .map_err(|_| Status::invalid_argument("shared file is not UTF-8"))?;
            let offset = read.offset.unwrap_or(1).saturating_sub(1) as usize;
            let text = text
                .lines()
                .skip(offset)
                .take(read.limit.unwrap_or(u32::MAX) as usize)
                .collect::<Vec<_>>()
                .join("\n");
            if text.len() > MAX_WORKSPACE_TOOL_OUTPUT_BYTES {
                return Err(Status::resource_exhausted(
                    "shared file output exceeds its bound; use a smaller line range",
                ));
            }
            text
        }
        (Some(Effect::FileWritten(written)), None, Some(bytes)) if written.bytes == bytes => {
            format!("Wrote {bytes} bytes to the shared file.")
        }
        _ => {
            return Err(Status::data_loss(
                "shared file receipt has a different result",
            ));
        }
    };
    Ok(HarnessWorkspaceResult {
        is_error: false,
        text,
    })
}
