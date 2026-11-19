//! The local contract between a Worklet and each Worker it starts.
//!
//! Transport: one `AF_UNIX` stream socket pair per Worker, made by the Worklet before it starts
//! the Worker and inherited by the Worker as file descriptor 3. Nothing else can reach it: it has
//! no name in the filesystem or the network, so a peer on it is the Worker the Worklet started,
//! authenticated by inheritance. The Worklet closes every other descriptor a Worker would inherit,
//! such as a sibling's channel another thread just made, and the Worker marks descriptor 3
//! close-on-exec before it starts anything, so neither a sibling nor a harness holds it. It is
//! also the Worker's lifeline: the Worker exits the moment it reads end-of-file, which is what it
//! reads when its Worklet dies.
//!
//! Each message is a 4-byte big-endian length and a JSON document; protocol messages inside it
//! are their protobuf encoding in base64.
//!
//! - Worklet → Worker: `Assign` (once, first), `Cancel`, `Drain`, `Lease` changes, and the
//!   `Reply` to each of the Worker's requests.
//! - Worker → Worklet: `State` (starting, executing, finalizing), `Milestone`s the Worklet
//!   journals before it answers, the `Outcome` it finishes the Attempt with, and `Request`s for
//!   host-signed calls. The Worklet makes a host-signed call only for the requesting Worker's own
//!   Attempt.
//!
//! The Worker is never handed the host credential: not in its environment, its arguments, or any
//! message here. That is no boundary between processes of one OS user: the host's state directory
//! holds the credential in its enrollment, and on macOS `ps eww` shows the environment the
//! Worklet started with, so a harness command run outside its sandbox as that user can read it.
//! The harness's sandbox, or another OS user, keeps it out; the Worker redacts any value shaped
//! like an enrolled credential, in any of its encodings, from what the harness sends upstream.

use std::{
    collections::{BTreeMap, HashMap},
    marker::PhantomData,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use base64::Engine as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use supertag_protocol::v2::{
    AuthorizeArtifactTransferRequest, GetReviewArtifactRequest, HostRecord, InspectAttemptRequest,
    MintWorkspaceGitAccessRequest, ReportAppliedLimitsRequest, SessionCheckpoint, Task,
    VerifyWorkspaceOutputRemoteRequest, VolumeObjectGrantRequest,
};
use supertag_workspaces::TransferArtifact;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{
        UnixStream,
        unix::{OwnedReadHalf, OwnedWriteHalf},
    },
    sync::{mpsc, oneshot, watch},
};
use tokio_util::sync::CancellationToken;
use tonic::{Code, Status};

use crate::{
    worker::task_outputs::PendingOutputs,
    worklet::{
        journal::{Attempt, PendingCheckpoint},
        workspaces::PreparedWorkspace,
    },
};

/// The file descriptor a Worker inherits its end of the socket pair as.
pub(crate) const CHANNEL_FD: i32 = 3;
/// The largest message either side accepts: an `Assign` carries the Task and the Session
/// checkpoint the Attempt resumes from.
pub(crate) const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
/// How long a Worker waits for its Worklet to answer one request.
const REPLY_TIMEOUT: Duration = Duration::from_secs(120);

/// A protocol message carried as its protobuf encoding.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Proto<T>(pub(crate) T);

impl<T: prost::Message> Serialize for Proto<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(
            &base64::engine::general_purpose::STANDARD.encode(self.0.encode_to_vec()),
        )
    }
}

impl<'de, T: prost::Message + Default> Deserialize<'de> for Proto<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(serde::de::Error::custom)?;
        T::decode(bytes.as_slice())
            .map(Proto)
            .map_err(serde::de::Error::custom)
    }
}

/// A gRPC status as the contract carries it.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct WireStatus {
    code: i32,
    message: String,
}

impl From<&Status> for WireStatus {
    fn from(status: &Status) -> Self {
        Self {
            code: status.code() as i32,
            message: status.message().to_owned(),
        }
    }
}

impl From<WireStatus> for Status {
    fn from(status: WireStatus) -> Self {
        Status::new(Code::from_i32(status.code), status.message)
    }
}

/// What a Worker's Attempt may use of its host's secrets: its own harness's provider
/// credentials, and the network credentials its egress proxy may inject. Never the host
/// credential.
#[derive(Clone, Default, Deserialize, Serialize)]
pub(crate) struct AttemptSecrets {
    pub(crate) provider: BTreeMap<String, String>,
    pub(crate) network: Vec<NetworkCredential>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct NetworkCredential {
    pub(crate) name: String,
    pub(crate) variable: String,
    pub(crate) value: String,
}

/// The one Task Attempt a Worker runs: the claimed and started Task, its prepared checkout, its
/// Attempt credential (in `attempt`), where its data calls go, and the secrets it may use.
#[derive(Deserialize, Serialize)]
pub(crate) struct Assign {
    /// The Worklet pool slot that runs the Attempt, whose directory holds its records.
    pub(crate) slot: String,
    pub(crate) state_directory: PathBuf,
    pub(crate) attempt: Attempt,
    pub(crate) task: Proto<Task>,
    pub(crate) workspace: Option<PreparedWorkspace>,
    /// The Session checkpoint this host holds for the Attempt to resume from.
    pub(crate) checkpoint: Option<Proto<SessionCheckpoint>>,
    /// How long the lease the Worklet renewed last is still valid, in milliseconds.
    pub(crate) valid_for_ms: u64,
    pub(crate) registration: Proto<HostRecord>,
    /// The protocol version the Worklet negotiated with its Control Plane.
    pub(crate) protocol: u32,
    /// Where the Worker sends its Attempt's data calls.
    pub(crate) data_endpoint: String,
    pub(crate) secrets: AttemptSecrets,
    /// Set for a Worker that only resumes the captures of an Attempt already Finalizing.
    pub(crate) resume_captures: Option<ResumeCaptures>,
}

/// A change to the Attempt's lease the Worklet observed.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum LeaseChange {
    /// Renewed: valid for this many more milliseconds.
    Renewed { valid_for_ms: u64 },
    /// The Control Plane ended the lease.
    Lost { message: String },
}

#[derive(Deserialize, Serialize)]
pub(crate) enum ToWorker {
    Assign(Box<Assign>),
    /// Stop now: the Worker exits after a short grace, whatever its run still does. The Worklet
    /// sends it when a drained Worker did not stop, and kills it after another.
    Cancel,
    /// The Worklet is stopping: stop before launching the harness if it has not launched, else
    /// stop the harness, and exit. The journal resumes the Attempt.
    Drain,
    Lease(LeaseChange),
    Reply {
        id: u64,
        result: Result<Bytes, WireStatus>,
    },
}

/// What a Worker is doing, for its Worklet's presence and `supertag ps`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum WorkerState {
    Starting,
    Executing,
    Finalizing,
}

/// A stage of the journal entry the Worker reached. The Worklet makes it durable before it
/// answers; the Worker does not go on until it has. The checkout each names is the one the
/// Worklet assigned, and the delivery's path scope the Task's: the Worker names neither.
#[allow(clippy::large_enum_variant)]
#[derive(Deserialize, Serialize)]
pub(crate) enum Milestone {
    /// Staging the Task's artifact inputs or Workspace copies in the assigned checkout.
    PreparingInputs,
    /// Launching the harness.
    Executing,
    /// The turn ended in the assigned Workspace. Durable before the Worker freezes and publishes
    /// its Task outputs and writes its Volume copies back, so that a Worker stopped meanwhile
    /// leaves the captures for another to resume rather than an interrupted Attempt.
    Finalizing {
        completion: Completion,
        checkpoint: Option<PendingCheckpoint>,
        remote_tree: Option<TransferArtifact>,
        outputs: Option<Box<PendingOutputs>>,
        failure_detail: Vec<String>,
    },
}

/// What a Worker started to resume a Finalizing Attempt's captures needs: the Task outputs a
/// successful turn left, and whether a remote Workspace's capture froze them already.
#[derive(Deserialize, Serialize)]
pub(crate) struct ResumeCaptures {
    pub(crate) remote: bool,
    pub(crate) outputs: Option<Box<PendingOutputs>>,
}

/// How the harness turn, or the Worker's own verdict, ended.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct Completion {
    pub(crate) result: String,
    pub(crate) succeeded: bool,
    pub(crate) objective_signal: i32,
    pub(crate) waiting_approval_ids: Vec<String>,
    pub(crate) quiet: bool,
}

impl Completion {
    pub(crate) fn of(outcome: &supertag_protocol::v2::HarnessCompleteRequest) -> Self {
        Self {
            result: outcome.result.clone(),
            succeeded: outcome.succeeded,
            objective_signal: outcome.objective_signal,
            waiting_approval_ids: outcome.waiting_approval_ids.clone(),
            quiet: outcome.quiet,
        }
    }
}

/// The completion the Worklet finishes the Attempt with. The Worklet journals it, answers, and
/// acts on it only once the Worker has exited.
#[allow(clippy::large_enum_variant)]
#[derive(Deserialize, Serialize)]
pub(crate) enum Outcome {
    /// The Worker stopped before it launched anything; the Worklet resumes the entry later.
    Retry,
    /// Finish with this, as the Worker's own verdict (`explained: false`, which the Worklet logs)
    /// or the adapter's.
    Finish {
        completion: Completion,
        explained: bool,
        checkpoint: Option<PendingCheckpoint>,
        failure_detail: Vec<String>,
    },
    /// The captures of the Finalizing turn are kept: its Task outputs, now frozen and
    /// published, and its Volume copies, written back. The Worklet finalizes and lands the
    /// delivery, then finishes with it.
    Finalizing {
        outputs: Option<Box<PendingOutputs>>,
    },
}

/// A call only the host may sign, which the Worklet makes for the requesting Worker's own
/// Attempt.
#[derive(Deserialize, Serialize)]
pub(crate) enum HostCall {
    Renew(Proto<InspectAttemptRequest>),
    Inspect(Proto<InspectAttemptRequest>),
    ReportAppliedLimits(Proto<ReportAppliedLimitsRequest>),
    VolumeGrant(Proto<VolumeObjectGrantRequest>),
    AuthorizeArtifactTransfer(Proto<AuthorizeArtifactTransferRequest>),
    ReviewDelivery(Proto<GetReviewArtifactRequest>),
    MintGitAccess(Proto<MintWorkspaceGitAccessRequest>),
    VerifyOutputRemote(Proto<VerifyWorkspaceOutputRemoteRequest>),
}

impl HostCall {
    /// The Attempt the call names. An artifact transfer grant names none: its token binds it to
    /// the Attempt it was granted to.
    pub(crate) fn attempt(&self) -> Option<Option<&InspectAttemptRequest>> {
        Some(match self {
            Self::Renew(request) | Self::Inspect(request) => Some(&request.0),
            Self::ReportAppliedLimits(request) => request.0.attempt.as_ref(),
            Self::VolumeGrant(request) => request.0.attempt.as_ref(),
            Self::ReviewDelivery(request) => request.0.attempt.as_ref(),
            Self::MintGitAccess(request) => request.0.attempt.as_ref(),
            Self::VerifyOutputRemote(request) => request.0.attempt.as_ref(),
            Self::AuthorizeArtifactTransfer(_) => return None,
        })
    }

    /// Refuses a call that names another Attempt than `own`, or acts beyond an Attempt.
    pub(crate) fn check(&self, own: &InspectAttemptRequest) -> Result<(), Status> {
        let refused = || {
            Status::permission_denied(
                "the Worklet makes host calls only for the requesting Worker's own Attempt",
            )
        };
        if let Some(named) = self.attempt()
            && named != Some(own)
        {
            return Err(refused());
        }
        if let Self::MintGitAccess(request) = self
            && (!request.0.landing_id.is_empty() || !request.0.landing_lease_token.is_empty())
        {
            return Err(refused());
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
pub(crate) enum FromWorker {
    State(WorkerState),
    Milestone { id: u64, milestone: Milestone },
    Request { id: u64, call: HostCall },
    Outcome { id: u64, outcome: Box<Outcome> },
}

/// Raw bytes in base64.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Bytes(pub(crate) Vec<u8>);

impl Serialize for Bytes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&base64::engine::general_purpose::STANDARD.encode(&self.0))
    }
}

impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .map(Bytes)
            .map_err(serde::de::Error::custom)
    }
}

pub(crate) async fn write_frame<T: Serialize>(
    writer: &mut OwnedWriteHalf,
    message: &T,
) -> Result<()> {
    let body = serde_json::to_vec(message)?;
    ensure!(body.len() <= MAX_FRAME_BYTES, "local message is too large");
    writer.write_all(&(body.len() as u32).to_be_bytes()).await?;
    writer.write_all(&body).await?;
    writer.flush().await?;
    Ok(())
}

/// The next message, or `None` at end-of-file.
pub(crate) async fn read_frame<T: for<'de> Deserialize<'de>>(
    reader: &mut OwnedReadHalf,
) -> Result<Option<T>> {
    let mut size = [0; 4];
    match reader.read_exact(&mut size).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let size = u32::from_be_bytes(size) as usize;
    ensure!(size <= MAX_FRAME_BYTES, "local message is too large");
    let mut body = vec![0; size];
    reader
        .read_exact(&mut body)
        .await
        .context("read a local message")?;
    Ok(Some(
        serde_json::from_slice(&body).context("decode a local message")?,
    ))
}

/// The Worker's end of the contract: what it sends its Worklet, and the answers it waits for.
#[derive(Clone)]
pub(crate) struct WorkletLink {
    inner: Arc<LinkInner>,
}

struct LinkInner {
    outgoing: mpsc::UnboundedSender<FromWorker>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Bytes, WireStatus>>>>,
    next: AtomicU64,
    lease: watch::Receiver<Option<LeaseChange>>,
}

/// A typed answer to a host call.
pub(crate) struct Answer<R>(PhantomData<R>);

impl WorkletLink {
    /// Connects to the Worklet on `stream`, and waits for its `Assign`. `stop` is cancelled by
    /// `Cancel` or `Drain`; `lost` runs when the Worklet's end closes, which means it died.
    pub(crate) async fn connect(
        stream: UnixStream,
        stop: CancellationToken,
        lost: fn(),
    ) -> Result<(Self, Assign)> {
        let (mut reader, mut writer) = stream.into_split();
        let (outgoing, mut queue) = mpsc::unbounded_channel::<FromWorker>();
        let (lease_sender, lease) = watch::channel(None);
        let link = Self {
            inner: Arc::new(LinkInner {
                outgoing,
                pending: Mutex::default(),
                next: AtomicU64::new(1),
                lease,
            }),
        };
        tokio::spawn(async move {
            while let Some(message) = queue.recv().await {
                if write_frame(&mut writer, &message).await.is_err() {
                    break;
                }
            }
        });
        let assign = match read_frame::<ToWorker>(&mut reader).await? {
            Some(ToWorker::Assign(assign)) => *assign,
            Some(_) => bail!("the Worklet sent another message before Assign"),
            None => bail!("the Worklet closed the channel before Assign"),
        };
        let inner = link.inner.clone();
        tokio::spawn(async move {
            loop {
                match read_frame::<ToWorker>(&mut reader).await {
                    Ok(Some(ToWorker::Reply { id, result })) => {
                        let waiting = inner
                            .pending
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .remove(&id);
                        if let Some(waiting) = waiting {
                            let _ = waiting.send(result);
                        }
                    }
                    Ok(Some(ToWorker::Lease(change))) => {
                        lease_sender.send_replace(Some(change));
                    }
                    Ok(Some(ToWorker::Drain)) => stop.cancel(),
                    Ok(Some(ToWorker::Cancel)) => {
                        stop.cancel();
                        // Stop now: whatever the run still does after a short grace, the Worker
                        // exits, and its guardian reaps the harness.
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_secs(2)).await;
                            lost();
                        });
                    }
                    Ok(Some(ToWorker::Assign(_))) => {
                        // One Worker runs one Attempt.
                        stop.cancel();
                    }
                    Ok(None) | Err(_) => {
                        lost();
                        stop.cancel();
                        return;
                    }
                }
            }
        });
        Ok((link, assign))
    }

    fn send(&self, message: FromWorker) -> Result<(), Status> {
        self.inner
            .outgoing
            .send(message)
            .map_err(|_| Status::unavailable("the Worklet channel closed"))
    }

    async fn ask(&self, message: impl FnOnce(u64) -> FromWorker) -> Result<Bytes, Status> {
        let id = self.inner.next.fetch_add(1, Ordering::SeqCst);
        let (answer, answered) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id, answer);
        if let Err(error) = self.send(message(id)) {
            self.inner
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(REPLY_TIMEOUT, answered).await {
            Ok(Ok(result)) => result.map_err(Status::from),
            Ok(Err(_)) => Err(Status::unavailable("the Worklet channel closed")),
            Err(_) => {
                self.inner
                    .pending
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&id);
                Err(Status::deadline_exceeded("the Worklet did not answer"))
            }
        }
    }

    /// A host-signed call, which the Worklet makes for this Worker's Attempt.
    pub(crate) async fn host_call<R: prost::Message + Default>(
        &self,
        call: HostCall,
        _answer: Answer<R>,
    ) -> Result<R, Status> {
        let bytes = self.ask(|id| FromWorker::Request { id, call }).await?;
        R::decode(bytes.0.as_slice())
            .map_err(|_| Status::data_loss("the Worklet sent an invalid answer"))
    }

    /// Reports a stage, and waits until the Worklet journaled it.
    pub(crate) async fn milestone(&self, milestone: Milestone) -> Result<()> {
        self.ask(|id| FromWorker::Milestone { id, milestone })
            .await
            .map_err(|status| {
                anyhow::anyhow!(
                    "the Worklet did not journal the stage: {}",
                    status.message()
                )
            })?;
        Ok(())
    }

    /// Hands over the Attempt's outcome, and waits until the Worklet journaled it.
    pub(crate) async fn outcome(&self, outcome: Outcome) -> Result<()> {
        self.ask(|id| FromWorker::Outcome {
            id,
            outcome: Box::new(outcome),
        })
        .await
        .map_err(|status| {
            anyhow::anyhow!(
                "the Worklet did not journal the outcome: {}",
                status.message()
            )
        })?;
        Ok(())
    }

    pub(crate) fn state(&self, state: WorkerState) {
        let _ = self.send(FromWorker::State(state));
    }

    /// The last lease change the Worklet reported.
    pub(crate) fn lease(&self) -> Option<LeaseChange> {
        self.inner.lease.borrow().clone()
    }
}

impl<R> Answer<R> {
    pub(crate) fn of() -> Self {
        Self(PhantomData)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_call_names_only_the_workers_own_attempt() {
        let own = InspectAttemptRequest {
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            lease_token: "lease".into(),
        };
        let other = InspectAttemptRequest {
            attempt_id: "another".into(),
            ..own.clone()
        };
        assert!(HostCall::Renew(Proto(own.clone())).check(&own).is_ok());
        let refused = HostCall::Renew(Proto(other.clone()))
            .check(&own)
            .unwrap_err();
        assert_eq!(refused.code(), Code::PermissionDenied);
        let grant = |attempt| {
            HostCall::VolumeGrant(Proto(VolumeObjectGrantRequest {
                attempt,
                ..Default::default()
            }))
        };
        assert!(grant(Some(own.clone())).check(&own).is_ok());
        assert!(grant(Some(other)).check(&own).is_err());
        assert!(
            grant(None).check(&own).is_err(),
            "a call must name its Attempt"
        );
        let landing = HostCall::MintGitAccess(Proto(MintWorkspaceGitAccessRequest {
            attempt: Some(own.clone()),
            landing_id: "landing".into(),
            ..Default::default()
        }));
        assert!(
            landing.check(&own).is_err(),
            "a Worker cannot push a landing"
        );
    }

    #[test]
    fn protocol_messages_round_trip_as_base64() {
        let status = Status::permission_denied("no");
        let wire = WireStatus::from(&status);
        let back: Status =
            serde_json::from_str::<WireStatus>(&serde_json::to_string(&wire).unwrap())
                .unwrap()
                .into();
        assert_eq!(
            (back.code(), back.message()),
            (Code::PermissionDenied, "no")
        );
        let call = HostCall::Inspect(Proto(InspectAttemptRequest {
            task_id: "t".into(),
            ..Default::default()
        }));
        let text = serde_json::to_string(&call).unwrap();
        match serde_json::from_str::<HostCall>(&text).unwrap() {
            HostCall::Inspect(Proto(request)) => assert_eq!(request.task_id, "t"),
            _ => panic!("wrong call"),
        }
    }

    #[tokio::test]
    async fn frames_carry_messages_and_end_at_eof() {
        let (left, right) = UnixStream::pair().unwrap();
        let (_, mut writer) = left.into_split();
        let (mut reader, _keep) = right.into_split();
        write_frame(&mut writer, &FromWorker::State(WorkerState::Executing))
            .await
            .unwrap();
        drop(writer);
        match read_frame::<FromWorker>(&mut reader).await.unwrap() {
            Some(FromWorker::State(WorkerState::Executing)) => {}
            _ => panic!("wrong message"),
        }
        assert!(
            read_frame::<FromWorker>(&mut reader)
                .await
                .unwrap()
                .is_none()
        );
    }
}
