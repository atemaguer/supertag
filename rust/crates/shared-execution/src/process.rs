use std::{process::Stdio, time::Duration};

use anyhow::{Context, Result};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, watch},
    time::{self, Instant},
};
use tokio_util::sync::CancellationToken;
use tonic::Status;

use crate::{
    Provider,
    guardian::{self, Launch, Outcome, Owner},
    journal::{Entry, now_ms},
    journal_error,
    v2::{
        OperationReceipt, OperationState, OutputStream, ProcessChunk, ProcessResult,
        ProcessSnapshot, StartProcess, operation_receipt::Result as Effect,
    },
};

const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_PROCESSES: usize = 8;
const CHUNK_BYTES: usize = 8 * 1024;
const POLL: Duration = Duration::from_millis(25);
pub(crate) const CLEANUP_WAIT: Duration = Duration::from_secs(8);

pub(crate) struct Runtime {
    pub(crate) access_id: String,
    pub(crate) stop: CancellationToken,
    pub(crate) lease: Option<watch::Sender<u64>>,
}

impl Provider {
    pub(crate) async fn launch_process(
        &self,
        mut entry: Entry,
        process: StartProcess,
        expires_at: i64,
        lease_deadline_ns: Option<u64>,
    ) -> Result<OperationReceipt, Status> {
        let (uid, gid) = self.0.process_identity.ok_or_else(|| {
            Status::failed_precondition("shared execution process lane is disabled")
        })?;
        let journal = &self.0.journal;
        // Recover durable cleanup proofs for pre-restart processes before checking admission.
        let unsettled = journal.unsettled_processes().await.map_err(journal_error)?;
        let mut pending = 0;
        for operation in unsettled {
            if !self
                .reconcile_cleanup(operation)
                .await
                .map_err(journal_error)?
            {
                pending += 1;
            }
        }
        if pending >= MAX_PROCESSES {
            return Err(Status::resource_exhausted(
                "shared execution process capacity reached",
            ));
        }
        let process_id = entry
            .receipt
            .process_id
            .clone()
            .expect("reserved process identity");
        let owner = Owner {
            proofs: journal.proofs.clone(),
            process_id: process_id.clone(),
            nonce: entry.proof_nonce.clone().expect("reserved proof nonce"),
        };
        let now = guardian::monotonic_now_ns()
            .map_err(|_| Status::internal("process authority clock unavailable"))?;
        let remaining = u64::try_from(expires_at.saturating_sub(now_ms()))
            .unwrap_or_default()
            .min(process.timeout_ms);
        if remaining == 0 {
            return Err(Status::failed_precondition(
                "execution access expired before launch",
            ));
        }
        let launch = Launch {
            root: self.0.root.path.clone(),
            root_identity: self.0.root.identity,
            uid,
            gid,
            deadline_ns: now
                .checked_add(remaining * 1_000_000)
                .ok_or_else(|| Status::internal("process deadline overflow"))?,
            lease_deadline_ns,
            command: process.command,
            args: process.args,
            cwd: process.cwd,
            stdin: process.stdin,
        };
        let owner_frame = guardian::encode_frame(&owner)
            .map_err(|_| Status::internal("process owner frame unavailable"))?;
        let launch_frame = guardian::encode_frame(&launch)
            .map_err(|_| Status::invalid_argument("process launch frame exceeds limit"))?;
        let guardian =
            std::env::current_exe().map_err(|_| Status::internal("resolve process guardian"))?;
        journal.insert_entry(&entry).await.map_err(journal_error)?;
        let mut child = match Command::new(guardian)
            .arg(guardian::GUARDIAN_ARGUMENT)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => return self.fail_unarmed(entry).await,
        };
        let mut lifeline = child.stdin.take().expect("piped guardian lifeline");
        if !matches!(
            time::timeout(Duration::from_secs(2), lifeline.write_all(&owner_frame)).await,
            Ok(Ok(()))
        ) {
            drop(lifeline);
            let _ = child.wait().await;
            return self.fail_unarmed(entry).await;
        }
        // The guardian has its proof identity but cannot spawn any workload until it receives
        // the second frame. Persist that cleanup proof is now required before sending that frame.
        entry.receipt.state = OperationState::Running as i32;
        entry.receipt.cleanup_verified = false;
        if let Err(error) = journal.set_receipt(&entry.receipt).await {
            drop(lifeline);
            let _ = child.wait().await;
            return Err(journal_error(error));
        }
        let stop = self.0.shutdown.child_token();
        let (lease, updates) = match lease_deadline_ns {
            Some(deadline) => {
                let (lease, updates) = watch::channel(deadline);
                (Some(lease), Some(updates))
            }
            None => (None, None),
        };
        self.0.processes.lock().await.insert(
            process_id,
            Runtime {
                access_id: entry.access_id.clone(),
                stop: stop.clone(),
                lease,
            },
        );
        let receipt = entry.receipt.clone();
        let provider = self.clone();
        tokio::spawn(async move {
            provider
                .supervise_guardian(child, lifeline, launch_frame, entry, stop, updates)
                .await;
        });
        Ok(receipt)
    }

    async fn fail_unarmed(&self, mut entry: Entry) -> Result<OperationReceipt, Status> {
        entry.receipt.state = OperationState::Failed as i32;
        entry.receipt.error = Some("Shared execution guardian could not start".into());
        self.0
            .journal
            .set_receipt(&entry.receipt)
            .await
            .map_err(journal_error)?;
        Ok(entry.receipt)
    }

    async fn supervise_guardian(
        &self,
        mut child: Child,
        mut writer: ChildStdin,
        frame: Vec<u8>,
        mut entry: Entry,
        stop: CancellationToken,
        mut lease: Option<watch::Receiver<u64>>,
    ) {
        let journal = &self.0.journal;
        let id = entry
            .receipt
            .process_id
            .clone()
            .expect("launched process identity");
        let launched = tokio::select! {
            biased;
            _ = stop.cancelled() => false,
            result = time::timeout(Duration::from_secs(2), writer.write_all(&frame)) => matches!(result, Ok(Ok(()))),
        };
        let mut lifeline = launched.then_some(writer);
        let mut stdout = child.stdout.take().expect("piped guardian stdout");
        let mut stderr = child.stderr.take().expect("piped guardian stderr");
        let (mut stdout_open, mut stderr_open, mut exited) = (true, true, false);
        let (mut out, mut err) = ([0u8; CHUNK_BYTES], [0u8; CHUNK_BYTES]);
        let mut sequence = 0u64;
        let mut saved = 0usize;
        let mut capture_error = None;
        while stdout_open || stderr_open || !exited {
            let (lane, read, bytes) = tokio::select! {
                _ = stop.cancelled(), if lifeline.is_some() => { lifeline.take(); continue; }
                deadline = next_lease(&mut lease), if lease.is_some() && lifeline.is_some() => {
                    if let (Some(deadline), Some(writer)) = (deadline, lifeline.as_mut()) {
                        if matches!(time::timeout(Duration::from_millis(300), writer.write_all(&deadline.to_le_bytes())).await, Ok(Ok(()))) {
                            continue;
                        }
                    }
                    lifeline.take();
                    continue;
                }
                read = stdout.read(&mut out), if stdout_open => (OutputStream::Stdout,read,&out),
                read = stderr.read(&mut err), if stderr_open => (OutputStream::Stderr,read,&err),
                result = child.wait(), if !exited => {
                    exited=true;
                    lifeline.take();
                    if result.is_err() { capture_error=Some("Process guardian exit was not observed"); }
                    continue;
                }
            };
            let read = match read {
                Ok(read) => read,
                Err(_) => {
                    capture_error = Some("Process output could not be captured");
                    lifeline.take();
                    0
                }
            };
            if read == 0 {
                if lane == OutputStream::Stdout {
                    stdout_open = false;
                } else {
                    stderr_open = false;
                }
                continue;
            }
            if capture_error.is_some() {
                continue;
            }
            let length = read.min(MAX_OUTPUT_BYTES.saturating_sub(saved));
            if length > 0 {
                let chunk = ProcessChunk {
                    sequence: sequence + 1,
                    stream: lane as i32,
                    data: bytes[..length].to_vec(),
                };
                if journal.append(&id, &chunk).await.is_err() {
                    capture_error = Some("Process output could not be stored");
                    lifeline.take();
                    continue;
                }
                saved += length;
                sequence += 1;
            }
            if length < read {
                capture_error = Some("Process output exceeded its bound");
                lifeline.take();
            }
        }
        let proof = guardian::read_proof(
            &journal.proofs,
            &id,
            entry.proof_nonce.as_deref().expect("launched proof nonce"),
        );
        entry.receipt.cleanup_verified = matches!(proof, Ok(Some(_)));
        entry.receipt.state = OperationState::Failed as i32;
        match (proof, capture_error) {
            (Ok(Some(proof)), None) => match proof.outcome {
                Outcome::Exited { code, signal } => {
                    entry.receipt.state = OperationState::Completed as i32;
                    entry.receipt.result = Some(Effect::ProcessResult(ProcessResult {
                        exit_code: code,
                        signal,
                    }));
                }
                Outcome::Cancelled => entry.receipt.error = Some("Process was stopped".into()),
                Outcome::TimedOut => {
                    entry.receipt.error = Some("Process execution deadline elapsed".into())
                }
                Outcome::LaunchFailed => {
                    entry.receipt.error = Some("Process could not start under its authority".into())
                }
                Outcome::Unobserved => {
                    entry.receipt.state = OperationState::Uncertain as i32;
                    entry.receipt.error = Some("Process exit could not be observed".into());
                }
            },
            (Ok(Some(_)), Some(error)) => entry.receipt.error = Some(error.into()),
            _ => {
                entry.receipt.state = OperationState::Uncertain as i32;
                entry.receipt.error = Some("Process cleanup could not be verified".into());
            }
        }
        let _ = journal.set_receipt(&entry.receipt).await;
        self.0.processes.lock().await.remove(&id);
    }

    pub(crate) async fn reconcile_cleanup(&self, entry: Entry) -> Result<bool> {
        let journal = &self.0.journal;
        let processes = self.0.processes.lock().await;
        if entry
            .receipt
            .process_id
            .as_ref()
            .is_some_and(|id| processes.contains_key(id))
        {
            return Ok(false);
        }
        // The supervisor may have settled a receipt before dropping its live runtime entry.
        let mut current = journal
            .entry(&entry.receipt.operation_id)
            .await?
            .context("cleanup receipt disappeared")?;
        let pending = matches!(
            current.receipt.state(),
            OperationState::Accepted | OperationState::Running
        );
        if current.receipt.cleanup_verified && !pending {
            return Ok(true);
        }
        let clean = match (
            current.receipt.process_id.as_deref(),
            current.proof_nonce.as_deref(),
        ) {
            (Some(id), Some(nonce)) if !current.receipt.cleanup_verified => {
                guardian::read_proof(&journal.proofs, id, nonce)?.is_some()
            }
            (Some(_), None) => false,
            _ => true,
        };
        if !clean {
            return Ok(false);
        }
        current.receipt.cleanup_verified = true;
        if pending {
            current.receipt.state = OperationState::Uncertain as i32;
            current.receipt.error =
                Some("Shared execution lost the operation completion receipt".into());
        }
        journal.set_receipt(&current.receipt).await?;
        Ok(true)
    }

    pub(crate) async fn cancel_process(&self, id: &str) {
        if let Some(runtime) = self.0.processes.lock().await.get(id) {
            runtime.stop.cancel();
        }
    }

    pub(crate) async fn await_process_cleanup(&self, id: &str) -> Result<(), Status> {
        let deadline = Instant::now() + CLEANUP_WAIT;
        loop {
            let entry = self
                .0
                .journal
                .process(id)
                .await
                .map_err(journal_error)?
                .ok_or_else(|| Status::not_found("unknown process"))?;
            if self.reconcile_cleanup(entry).await.map_err(journal_error)? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(Status::failed_precondition(
                    "process cleanup proof is pending",
                ));
            }
            time::sleep(POLL).await;
        }
    }

    pub(crate) async fn stream_process(
        &self,
        id: String,
        token_hash: Vec<u8>,
        mut after: u64,
        sender: mpsc::Sender<Result<ProcessSnapshot, Status>>,
    ) {
        loop {
            let message = self.snapshot(&id, &token_hash, after).await;
            let (snapshot, terminal) = match message {
                Ok(Some(snapshot)) => {
                    after = snapshot.next_cursor;
                    let terminal = snapshot.terminal.is_some();
                    (Some(Ok(snapshot)), terminal)
                }
                Ok(None) => (None, false),
                Err(error) => (Some(Err(error)), true),
            };
            if let Some(snapshot) = snapshot {
                let sent = tokio::select! {
                    _ = self.0.shutdown.cancelled() => return,
                    sent = sender.send(snapshot) => sent,
                };
                if sent.is_err() {
                    return;
                }
            }
            if terminal {
                return;
            }
            tokio::select! {
                _ = sender.closed() => return,
                _ = self.0.shutdown.cancelled() => return,
                _ = time::sleep(POLL) => {},
            }
        }
    }

    pub(crate) async fn snapshot(
        &self,
        id: &str,
        token_hash: &[u8],
        after: u64,
    ) -> Result<Option<ProcessSnapshot>, Status> {
        let access = self.auth(token_hash, true).await?.receipt;
        let journal = &self.0.journal;
        let entry = journal
            .process(id)
            .await
            .map_err(journal_error)?
            .ok_or_else(|| Status::not_found("unknown process"))?;
        if entry.access_id != access.access_id {
            return Err(Status::permission_denied(
                "process belongs to another access",
            ));
        }
        let latest = journal.latest(id).await.map_err(journal_error)?;
        if after > latest {
            return Err(Status::failed_precondition(
                "process cursor is ahead of the journal",
            ));
        }
        let chunks = journal
            .page(id, after, latest)
            .await
            .map_err(journal_error)?;
        let next_cursor = chunks.last().map_or(after, |chunk| chunk.sequence);
        if chunks
            .iter()
            .enumerate()
            .any(|(index, chunk)| chunk.sequence != after + index as u64 + 1)
            || next_cursor == after && after < latest
        {
            return Err(Status::data_loss(
                "process output journal has a sequence gap",
            ));
        }
        let terminal = (next_cursor == latest
            && !matches!(
                entry.receipt.state(),
                OperationState::Accepted | OperationState::Running
            ))
        .then_some(entry.receipt);
        if chunks.is_empty() && terminal.is_none() {
            return Ok(None);
        }
        Ok(Some(ProcessSnapshot {
            process_id: id.into(),
            chunks,
            next_cursor,
            terminal,
        }))
    }
}

async fn next_lease(lease: &mut Option<watch::Receiver<u64>>) -> Option<u64> {
    let lease = lease.as_mut()?;
    lease.changed().await.ok()?;
    let deadline = *lease.borrow_and_update();
    Some(deadline)
}
