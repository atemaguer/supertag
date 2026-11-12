mod guardian;
mod journal;
mod process;
mod root;

pub mod v2 {
    tonic::include_proto!("supertag.environment.v2");
}

use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Result, ensure};
use journal::{Access, Entry, Journal, now_ms};
use prost::Message;
use root::Root;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::{
    sync::{Mutex, mpsc},
    time::{self, Instant},
};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use tonic::{Request, Response, Status};
use uuid::Uuid;
use v2::{
    execute_request::Operation,
    operation_receipt::Result as Effect,
    shared_execution_server::{SharedExecution, SharedExecutionServer},
    *,
};

const GRANT_HEADER: &str = "x-supertag-grant-token";
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_OPERATIONS_PER_ACCESS: i64 = 2048;

pub struct Config {
    pub environment_id: String,
    pub root: PathBuf,
    pub state_directory: PathBuf,
    pub admin_token: String,
    pub process_identity: Option<(u32, u32)>,
}

#[derive(Clone)]
pub struct Provider(Arc<Inner>);

struct Inner {
    root: Root,
    journal: Journal,
    admin_token: String,
    admission: Mutex<()>,
    shutdown: CancellationToken,
    process_identity: Option<(u32, u32)>,
    processes: Mutex<BTreeMap<String, process::Runtime>>,
}

impl Provider {
    pub async fn open(config: Config) -> Result<Self> {
        ensure!(
            identifier(&config.environment_id) && credential(&config.admin_token, 16),
            "invalid shared execution environment identity or admin token"
        );
        if let Some((uid, gid)) = config.process_identity {
            // SAFETY: geteuid takes no parameters.
            ensure!(
                cfg!(target_os = "linux") && unsafe { libc::geteuid() } == 0 && uid > 0 && gid > 0,
                "process execution requires Linux with a separate non-root workload UID and GID"
            );
        }
        let root = Root::open(&config.root, config.process_identity)?;
        root.lock()?;
        let journal = Journal::open(&config.state_directory, config.environment_id, &root).await?;
        ensure!(
            journal
                .authenticate(Sha256::digest(config.admin_token.as_bytes()).as_slice())
                .await?
                .is_none(),
            "shared execution admin token is already assigned to an access"
        );
        Ok(Self(Arc::new(Inner {
            root,
            journal,
            admin_token: config.admin_token,
            admission: Mutex::default(),
            shutdown: CancellationToken::new(),
            process_identity: config.process_identity,
            processes: Mutex::default(),
        })))
    }

    pub fn service(&self) -> SharedExecutionServer<Self> {
        SharedExecutionServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub async fn shutdown(&self) {
        self.0.shutdown.cancel();
        let _ = time::timeout(process::CLEANUP_WAIT, async {
            while !self.0.processes.lock().await.is_empty() {
                time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await;
    }

    fn accepting(&self) -> Result<(), Status> {
        if self.0.shutdown.is_cancelled() {
            return Err(Status::unavailable("shared execution is stopping"));
        }
        Ok(())
    }

    fn require_admin<T>(&self, request: &Request<T>) -> Result<(), Status> {
        if !bearer(request)
            .is_ok_and(|token| bool::from(token.as_bytes().ct_eq(self.0.admin_token.as_bytes())))
        {
            return Err(Status::unauthenticated(
                "shared execution admin credential required",
            ));
        }
        Ok(())
    }

    async fn auth(&self, token_hash: &[u8], active: bool) -> Result<Access, Status> {
        let access = self
            .0
            .journal
            .authenticate(token_hash)
            .await
            .map_err(journal_error)?
            .ok_or_else(|| Status::unauthenticated("invalid execution access credential"))?;
        if active
            && (access.receipt.state() != AccessState::Active
                || access.receipt.expires_at_ms <= now_ms())
        {
            return Err(Status::unauthenticated(
                "execution access is no longer active",
            ));
        }
        Ok(access)
    }

    async fn issue_owned(
        &self,
        input: IssueAccessRequest,
        token_hash: Vec<u8>,
    ) -> Result<AccessReceipt, Status> {
        let _lock = self.0.admission.lock().await;
        self.accepting()?;
        let journal = &self.0.journal;
        if input.environment_id != journal.environment_id {
            return Err(Status::failed_precondition(
                "shared execution environment identity does not match",
            ));
        }
        if ![
            &input.access_id,
            &input.task_id,
            &input.attempt_id,
            &input.tag_id,
        ]
        .into_iter()
        .all(|id| identifier(id))
            || !(1_000..=86_400_000).contains(&input.ttl_ms)
        {
            return Err(Status::invalid_argument("invalid execution access request"));
        }
        let mut digest = Sha256::new();
        digest.update(&token_hash);
        digest.update(input.encode_to_vec());
        let fingerprint = digest.finalize();
        if let Some(existing) = journal
            .access(&input.access_id)
            .await
            .map_err(journal_error)?
        {
            if !bool::from(
                existing
                    .fingerprint
                    .as_slice()
                    .ct_eq(fingerprint.as_slice()),
            ) {
                return Err(Status::already_exists(
                    "execution access ID was used with different input",
                ));
            }
            return Ok(existing.receipt);
        }
        if journal
            .authenticate(&token_hash)
            .await
            .map_err(journal_error)?
            .is_some()
        {
            return Err(Status::already_exists(
                "execution access credential was already bound",
            ));
        }
        if journal
            .attempt_assigned(&input.attempt_id)
            .await
            .map_err(journal_error)?
        {
            return Err(Status::already_exists(
                "Task Attempt already owns an execution access",
            ));
        }
        let receipt = AccessReceipt {
            environment_id: journal.environment_id.clone(),
            incarnation_id: journal.incarnation_id.clone(),
            access_id: input.access_id,
            task_id: input.task_id,
            attempt_id: input.attempt_id,
            tag_id: input.tag_id,
            expires_at_ms: now_ms() + input.ttl_ms as i64,
            state: AccessState::Active as i32,
            cleanup_verified: false,
        };
        journal
            .insert_access(&receipt, &token_hash, fingerprint.as_slice())
            .await
            .map_err(journal_error)?;
        Ok(receipt)
    }

    async fn execute_owned(
        &self,
        input: ExecuteRequest,
        token_hash: Vec<u8>,
    ) -> Result<OperationReceipt, Status> {
        let _lock = self.0.admission.lock().await;
        self.accepting()?;
        let access = self.auth(&token_hash, true).await?.receipt;
        let journal = &self.0.journal;
        if !identifier(&input.operation_id) {
            return Err(Status::invalid_argument("invalid operation ID"));
        }
        let fingerprint = Sha256::digest(input.encode_to_vec());
        if let Some(previous) = journal
            .entry(&input.operation_id)
            .await
            .map_err(journal_error)?
        {
            if previous.access_id != access.access_id {
                return Err(Status::permission_denied(
                    "operation belongs to another access",
                ));
            }
            if !bool::from(
                previous
                    .fingerprint
                    .as_slice()
                    .ct_eq(fingerprint.as_slice()),
            ) {
                return Err(Status::already_exists(
                    "operation ID was used with different input",
                ));
            }
            return Ok(previous.receipt);
        }
        for entry in journal
            .unverified(&access.access_id)
            .await
            .map_err(journal_error)?
        {
            if entry.receipt.state() == OperationState::Uncertain
                && entry.receipt.process_id.is_some()
                && !self.reconcile_cleanup(entry).await.map_err(journal_error)?
            {
                return Err(Status::failed_precondition(
                    "an earlier process cleanup proof is pending",
                ));
            }
        }
        let operation = input
            .operation
            .ok_or_else(|| Status::invalid_argument("operation required"))?;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM operations WHERE access_id=?")
            .bind(&access.access_id)
            .fetch_one(&journal.pool)
            .await
            .map_err(|_| Status::internal("operation count unavailable"))?;
        if count >= MAX_OPERATIONS_PER_ACCESS {
            return Err(Status::resource_exhausted(
                "execution access operation limit reached",
            ));
        }
        let mut entry = Entry {
            access_id: access.access_id,
            fingerprint: fingerprint.to_vec(),
            proof_nonce: None,
            receipt: OperationReceipt {
                operation_id: input.operation_id,
                state: OperationState::Accepted as i32,
                ..Default::default()
            },
        };
        let operation = match operation {
            Operation::StartProcess(process) => {
                if !guardian::validate(&process) {
                    return Err(Status::invalid_argument(
                        "invalid bounded process specification",
                    ));
                }
                self.0.root.directory(&process.cwd).map_err(|_| {
                    Status::invalid_argument("process directory is outside the fixed root")
                })?;
                entry.proof_nonce = Some(Uuid::new_v4().to_string());
                entry.receipt.process_id = Some(Uuid::new_v4().to_string());
                entry.receipt.cleanup_verified = true;
                return self
                    .launch_process(entry, process, access.expires_at_ms)
                    .await;
            }
            Operation::StopProcess(stop) => {
                let target = journal
                    .process(&stop.process_id)
                    .await
                    .map_err(journal_error)?
                    .ok_or_else(|| Status::not_found("unknown process"))?;
                if target.access_id != entry.access_id {
                    return Err(Status::permission_denied(
                        "process belongs to another access",
                    ));
                }
                journal.insert_entry(&entry).await.map_err(journal_error)?;
                self.cancel_process(&stop.process_id).await;
                match self.await_process_cleanup(&stop.process_id).await {
                    Ok(()) => {
                        entry.receipt.cleanup_verified = true;
                        entry.receipt.state = OperationState::Completed as i32;
                        entry.receipt.result =
                            Some(Effect::ProcessStopped(ProcessStopped { stopped: true }));
                    }
                    Err(_) => {
                        entry.receipt.state = OperationState::Uncertain as i32;
                        entry.receipt.error = Some("Process stop proof is pending".into());
                    }
                }
                journal
                    .set_receipt(&entry.receipt)
                    .await
                    .map_err(journal_error)?;
                return Ok(entry.receipt);
            }
            operation => operation,
        };
        journal.insert_entry(&entry).await.map_err(journal_error)?;
        let root = &self.0.root;
        let result = match operation {
            Operation::ReadFile(request) => root.read(request).map(Effect::FileContent),
            Operation::WriteFile(request) => root.write(request, false).map(Effect::FileWritten),
            Operation::StageFile(request) => root.write(request, true).map(Effect::FileWritten),
            _ => unreachable!("process operations are checked above"),
        };
        entry.receipt.cleanup_verified = true;
        match result {
            Ok(result) => {
                entry.receipt.state = OperationState::Completed as i32;
                entry.receipt.result = Some(result);
            }
            Err(error) if error.is::<root::PublishedWithoutSync>() => {
                entry.receipt.state = OperationState::Uncertain as i32;
                entry.receipt.error = Some("Shared file publication could not be confirmed".into());
            }
            Err(_) => {
                entry.receipt.state = OperationState::Failed as i32;
                entry.receipt.error =
                    Some("File operation did not complete within the fixed root".into());
            }
        }
        journal
            .set_receipt(&entry.receipt)
            .await
            .map_err(journal_error)?;
        Ok(entry.receipt)
    }

    async fn end_owned(
        &self,
        id: String,
        token_hash: Option<Vec<u8>>,
    ) -> Result<AccessReceipt, Status> {
        let lock = self.0.admission.lock().await;
        let journal = &self.0.journal;
        let revoke = token_hash.is_none();
        let access = if let Some(token_hash) = token_hash {
            let access = self.auth(&token_hash, false).await?.receipt;
            if access.access_id != id {
                return Err(Status::permission_denied("access may only release itself"));
            }
            access
        } else {
            journal
                .access(&id)
                .await
                .map_err(journal_error)?
                .ok_or_else(|| Status::not_found("unknown access"))?
                .receipt
        };
        if access.cleanup_verified {
            return Ok(access);
        }
        let pending = if revoke || access.state() == AccessState::Revoking {
            AccessState::Revoking
        } else {
            AccessState::Releasing
        };
        journal
            .set_access(&id, pending)
            .await
            .map_err(journal_error)?;
        drop(lock);
        for runtime in self
            .0
            .processes
            .lock()
            .await
            .values()
            .filter(|runtime| runtime.access_id == id)
        {
            runtime.stop.cancel();
        }
        let deadline = Instant::now() + process::CLEANUP_WAIT;
        loop {
            let mut clean = true;
            for entry in journal.unverified(&id).await.map_err(journal_error)? {
                clean &= self.reconcile_cleanup(entry).await.map_err(journal_error)?;
            }
            if clean {
                break;
            }
            if Instant::now() >= deadline {
                return Err(Status::failed_precondition(
                    "execution access cleanup proof is pending",
                ));
            }
            time::sleep(Duration::from_millis(25)).await;
        }
        let _lock = self.0.admission.lock().await;
        let access = journal
            .access(&id)
            .await
            .map_err(journal_error)?
            .ok_or_else(|| Status::internal("execution access disappeared"))?
            .receipt;
        if access.cleanup_verified {
            return Ok(access);
        }
        let state = if access.state() == AccessState::Revoking {
            AccessState::Revoked
        } else {
            AccessState::Released
        };
        journal
            .set_access(&id, state)
            .await
            .map_err(journal_error)?;
        Ok(AccessReceipt {
            state: state as i32,
            cleanup_verified: true,
            ..access
        })
    }
}

#[tonic::async_trait]
impl SharedExecution for Provider {
    async fn issue_access(
        &self,
        request: Request<IssueAccessRequest>,
    ) -> Result<Response<AccessReceipt>, Status> {
        self.require_admin(&request)?;
        let mut values = request.metadata().get_all(GRANT_HEADER).iter();
        let token = values
            .next()
            .and_then(|value| value.to_str().ok())
            .filter(|token| credential(token, 32) && *token != self.0.admin_token)
            .filter(|_| values.next().is_none())
            .ok_or_else(|| {
                Status::invalid_argument("valid separate execution grant credential required")
            })?;
        let hash = Sha256::digest(token.as_bytes()).to_vec();
        let provider = self.clone();
        let input = request.into_inner();
        Ok(Response::new(
            tokio::spawn(async move { provider.issue_owned(input, hash).await })
                .await
                .map_err(|_| Status::internal("access issuance interrupted"))??,
        ))
    }
    async fn release_access(
        &self,
        request: Request<EndAccessRequest>,
    ) -> Result<Response<AccessReceipt>, Status> {
        let hash = bearer_hash(&request)?;
        let provider = self.clone();
        let id = request.into_inner().access_id;
        Ok(Response::new(
            tokio::spawn(async move { provider.end_owned(id, Some(hash)).await })
                .await
                .map_err(|_| Status::internal("access release interrupted"))??,
        ))
    }
    async fn revoke_access(
        &self,
        request: Request<EndAccessRequest>,
    ) -> Result<Response<AccessReceipt>, Status> {
        self.require_admin(&request)?;
        let provider = self.clone();
        let id = request.into_inner().access_id;
        Ok(Response::new(
            tokio::spawn(async move { provider.end_owned(id, None).await })
                .await
                .map_err(|_| Status::internal("access revocation interrupted"))??,
        ))
    }
    async fn execute(
        &self,
        request: Request<ExecuteRequest>,
    ) -> Result<Response<OperationReceipt>, Status> {
        let hash = bearer_hash(&request)?;
        let provider = self.clone();
        let input = request.into_inner();
        Ok(Response::new(
            tokio::spawn(async move { provider.execute_owned(input, hash).await })
                .await
                .map_err(|_| Status::internal("execution operation interrupted"))??,
        ))
    }
    async fn inspect_operation(
        &self,
        request: Request<InspectOperationRequest>,
    ) -> Result<Response<OperationReceipt>, Status> {
        let access = self.auth(&bearer_hash(&request)?, true).await?;
        let entry = self
            .0
            .journal
            .entry(&request.get_ref().operation_id)
            .await
            .map_err(journal_error)?
            .ok_or_else(|| Status::not_found("unknown operation"))?;
        if entry.access_id != access.receipt.access_id {
            return Err(Status::permission_denied(
                "operation belongs to another access",
            ));
        }
        Ok(Response::new(entry.receipt))
    }
    type WatchProcessStream = ReceiverStream<Result<ProcessSnapshot, Status>>;
    async fn watch_process(
        &self,
        request: Request<WatchProcessRequest>,
    ) -> Result<Response<Self::WatchProcessStream>, Status> {
        self.accepting()?;
        let hash = bearer_hash(&request)?;
        let input = request.into_inner();
        self.snapshot(&input.process_id, &hash, input.after_sequence)
            .await?;
        let (sender, receiver) = mpsc::channel(2);
        let provider = self.clone();
        tokio::spawn(async move {
            provider
                .stream_process(input.process_id, hash, input.after_sequence, sender)
                .await;
        });
        Ok(Response::new(ReceiverStream::new(receiver)))
    }
}

/// Entrypoint dispatch for the separately supervised, credential-free workload guardian.
pub fn run_guardian() -> Result<()> {
    guardian::run()
}

fn identifier(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}
fn credential(value: &str, minimum: usize) -> bool {
    (minimum..=512).contains(&value.len()) && value.bytes().all(|byte| (33..=126).contains(&byte))
}
fn bearer_hash<T>(request: &Request<T>) -> Result<Vec<u8>, Status> {
    Ok(Sha256::digest(bearer(request)?.as_bytes()).to_vec())
}
fn bearer<T>(request: &Request<T>) -> Result<&str, Status> {
    let mut values = request.metadata().get_all("authorization").iter();
    values
        .next()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| credential(token, 16))
        .filter(|_| values.next().is_none())
        .ok_or_else(|| Status::unauthenticated("execution access credential required"))
}
fn journal_error(_: anyhow::Error) -> Status {
    Status::internal("shared execution journal could not verify the operation")
}
