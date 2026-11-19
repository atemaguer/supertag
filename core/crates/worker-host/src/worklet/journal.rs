use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use crate::worklet::workspaces::{PendingWorkspace, PreparedWorkspace};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use supertag_protocol::{
    MAX_CHECKPOINT_BYTES,
    v2::{RemoteWorkspaceOwner, SessionCheckpoint},
    valid_sha256,
};
use supertag_workspaces::{ExclusiveLock, TransferArtifact};
use tempfile::NamedTempFile;

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Attempt {
    pub task_id: String,
    pub attempt_id: String,
    pub lease_token: String,
    /// The Attempt credential StartTask returned, which the Attempt's data calls carry: the
    /// Worker's, and the Worklet's own finalization records. Empty until the Attempt started; a
    /// replayed start replaces it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub attempt_credential: String,
    #[serde(default)]
    pub execution_selection: Option<Vec<u8>>,
    #[serde(default)]
    pub requires_unsandboxed_commands: bool,
    /// The later messages the Control Plane joined into this Attempt when it was claimed.
    #[serde(default)]
    pub joined: Vec<JoinedMessage>,
    /// The Tag's native memory store the Control Plane granted this Attempt, if any.
    #[serde(default)]
    pub native_memory: Option<NativeMemoryGrant>,
    /// The Tag's Volume as the claim assigned it.
    #[serde(default)]
    pub volume: Option<AssignedVolume>,
}

/// One Attempt is the same Attempt whichever credential its latest start returned: a replayed
/// start replaces the credential, never the Attempt.
impl PartialEq for Attempt {
    fn eq(&self, other: &Self) -> bool {
        let Self {
            task_id,
            attempt_id,
            lease_token,
            attempt_credential: _,
            execution_selection,
            requires_unsandboxed_commands,
            joined,
            native_memory,
            volume,
        } = self;
        *task_id == other.task_id
            && *attempt_id == other.attempt_id
            && *lease_token == other.lease_token
            && *execution_selection == other.execution_selection
            && *requires_unsandboxed_commands == other.requires_unsandboxed_commands
            && *joined == other.joined
            && *native_memory == other.native_memory
            && *volume == other.volume
    }
}

impl Eq for Attempt {}

/// `supertag_protocol::v2::NativeMemoryGrant`, as the journal keeps it.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct NativeMemoryGrant {
    pub scope: String,
    pub reset_generation: u64,
    /// The store's head on the Tag's Volume: revision, manifest SHA-256, and manifest length.
    #[serde(default)]
    pub volume_head: Option<(u64, String, u64)>,
}

/// The Tag's Volume as an Attempt's assignment carries it.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct AssignedVolume {
    pub volume_id: String,
    pub source: String,
    pub revision: u64,
}

/// A person's message this Attempt answers together with its Task's own prompt.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct JoinedMessage {
    pub task_id: String,
    pub text: String,
    pub sent_at_ms: i64,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct PendingCheckpoint {
    pub harness: String,
    pub format: String,
    pub sha256: String,
    pub uploaded: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum RemoteSandboxState {
    Allocating,
    Active { sandbox_id: String },
    Stopped { sandbox_id: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct RemoteSandbox {
    host_id: String,
    host_generation: u64,
    task_id: String,
    attempt_id: String,
    allocation_id: String,
    pub(crate) provider_scope: String,
    pub(crate) state: RemoteSandboxState,
}

impl RemoteSandbox {
    pub(crate) fn owner(&self) -> RemoteWorkspaceOwner {
        RemoteWorkspaceOwner {
            host_id: self.host_id.clone(),
            host_generation: self.host_generation,
            task_id: self.task_id.clone(),
            attempt_id: self.attempt_id.clone(),
            allocation_id: self.allocation_id.clone(),
        }
    }

    pub(crate) fn sandbox_id(&self) -> Option<&str> {
        match &self.state {
            RemoteSandboxState::Allocating => None,
            RemoteSandboxState::Active { sandbox_id }
            | RemoteSandboxState::Stopped { sandbox_id } => Some(sandbox_id),
        }
    }
}

pub(crate) fn valid_sandbox_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub(crate) enum Entry {
    Claim {
        operation_id: String,
        #[serde(default)]
        request: Vec<u8>,
    },
    Starting {
        #[serde(flatten)]
        attempt: Attempt,
    },
    PreparingInputs {
        #[serde(flatten)]
        attempt: Attempt,
        prepared: Box<PreparedWorkspace>,
    },
    Executing {
        #[serde(flatten)]
        attempt: Attempt,
        #[serde(default)]
        prepared: Option<Box<PreparedWorkspace>>,
    },
    Finalizing {
        #[serde(flatten)]
        attempt: Attempt,
        result: String,
        succeeded: bool,
        objective_signal: i32,
        #[serde(default)]
        waiting_approval_ids: Vec<String>,
        /// The turn asked to finish quietly (`stay_quiet`).
        #[serde(default)]
        quiet: bool,
        checkpoint: Option<PendingCheckpoint>,
        workspace: Box<PreparedWorkspace>,
        #[serde(default)]
        remote_tree: Option<TransferArtifact>,
        #[serde(default)]
        outputs: Option<Box<crate::worker::task_outputs::PendingOutputs>>,
        /// The Task's path scope, which the delivery check applies after a restart too.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_scope: Option<supertag_protocol::file_scope::Rules>,
        /// Why the Worker failed the turn, for operators: see `failures::take_detail`.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        failure_detail: Vec<String>,
        /// Whether a Worker froze and published a successful turn's Task outputs and wrote its
        /// Volume copies back. Until then a Worker of the Attempt does that before the Worklet
        /// finalizes the delivery: the Worker that ran the turn, or one started to resume it.
        #[serde(default)]
        captured: bool,
    },
    Finish {
        #[serde(flatten)]
        attempt: Attempt,
        result: String,
        succeeded: bool,
        #[serde(default)]
        objective_signal: i32,
        #[serde(default)]
        waiting_approval_ids: Vec<String>,
        #[serde(default)]
        quiet: bool,
        #[serde(default)]
        checkpoint: Option<PendingCheckpoint>,
        #[serde(default)]
        workspace: Option<Box<PendingWorkspace>>,
        #[serde(default)]
        prepared: Option<Box<PreparedWorkspace>>,
        #[serde(default)]
        outputs: Option<Box<crate::worker::task_outputs::PendingOutputs>>,
        /// Why the host failed the Attempt, for operators: see `failures::take_detail`.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        failure_detail: Vec<String>,
    },
    Terminal {
        #[serde(flatten)]
        attempt: Attempt,
        prepared: Option<Box<PreparedWorkspace>>,
    },
}

impl Entry {
    /// The Attempt whose execution started and was not yet confirmed stopped.
    pub(crate) fn unsettled_attempt(&self) -> Option<&Attempt> {
        match self {
            Self::Executing { attempt, .. }
            | Self::Finalizing { attempt, .. }
            | Self::Finish { attempt, .. } => Some(attempt),
            _ => None,
        }
    }

    /// Keep checkout ownership when an outcome is downgraded after local cleanup.
    pub(crate) fn prepared(&self, expected: &Attempt) -> Result<Option<Box<PreparedWorkspace>>> {
        let (attempt, prepared) = match self {
            Self::Starting { attempt } => (attempt, None),
            Self::PreparingInputs { attempt, prepared } => (attempt, Some(prepared.clone())),
            Self::Executing { attempt, prepared } | Self::Terminal { attempt, prepared } => {
                (attempt, prepared.clone())
            }
            Self::Finalizing {
                attempt, workspace, ..
            } => (attempt, Some(workspace.clone())),
            Self::Finish {
                attempt,
                prepared,
                workspace,
                ..
            } => (
                attempt,
                prepared.clone().or_else(|| {
                    workspace.as_ref().map(|pending| {
                        Box::new(PreparedWorkspace {
                            workspace_id: pending.workspace_id.clone(),
                            checkout: pending.checkout.clone(),
                        })
                    })
                }),
            ),
            Self::Claim { .. } => anyhow::bail!("claim journal has no prepared Attempt"),
        };
        ensure!(
            attempt == expected,
            "workspace journal belongs to another Attempt"
        );
        Ok(prepared)
    }
}

/// The Worklet's journal. The host journal (`open`) holds the Worklet's lock, its incarnation,
/// and its presence sequence; each slot of its Worker pool keeps one entry (`slot`): the stage of
/// the one Attempt that slot holds, in `slots/NAME/` beside that Attempt's checkpoint, sandbox,
/// shared-access, and process records. A Worker reads and writes its own Attempt's records
/// through a `view` of its slot; only the Worklet writes the entry.
pub(crate) struct Journal {
    directory: PathBuf,
    _lock: Option<ExclusiveLock>,
}

/// The directory under the Worklet's state directory that holds one entry per slot.
pub(crate) const SLOTS: &str = "slots";

impl Journal {
    pub(crate) fn open(directory: &Path) -> Result<Self> {
        private_state_directory(directory)?;
        let owner = unsafe { libc::geteuid() };
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(directory.join("host.lock"))?;
        let metadata = lock.metadata()?;
        ensure!(
            metadata.is_file() && metadata.uid() == owner && metadata.mode() & 0o077 == 0,
            "Worker Host state lock must be private"
        );
        let lock = ExclusiveLock::try_acquire(lock)
            .context("another Worker Host owns this state directory")?;
        Ok(Self {
            directory: directory.to_owned(),
            _lock: Some(lock),
        })
    }

    /// The entry of the pool slot `name`, under this host journal's lock.
    pub(crate) fn slot(&self, name: &str) -> Result<Self> {
        ensure!(
            self._lock.is_some(),
            "only the Worklet's own journal has slots"
        );
        ensure!(
            !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
            "invalid Worker pool slot name"
        );
        let directory = self.directory.join(SLOTS).join(name);
        private_state_directory(&self.directory.join(SLOTS))?;
        private_state_directory(&directory)?;
        Ok(Self {
            directory,
            _lock: None,
        })
    }

    /// The names of the slots that hold an Attempt or a claim.
    pub(crate) fn occupied_slots(&self) -> Result<Vec<String>> {
        let mut names = Vec::new();
        match fs::read_dir(self.directory.join(SLOTS)) {
            Ok(entries) => {
                for entry in entries {
                    let entry = entry?;
                    let path = entry.path();
                    if (path.join("attempt.json").exists() || path.join("claim.json").exists())
                        && let Some(name) = entry.file_name().to_str()
                    {
                        names.push(name.to_owned());
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        names.sort();
        Ok(names)
    }

    /// A Worker's view of its slot `directory`, which its Worklet created: it records the
    /// Attempt's processes, sandbox, shared access, and staged checkpoint there, and reads the
    /// entry its Worklet wrote.
    pub(crate) fn view(directory: &Path) -> Result<Self> {
        let metadata = directory.symlink_metadata()?;
        ensure!(
            metadata.is_dir()
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.mode() & 0o077 == 0,
            "Worker slot directory must be private"
        );
        Ok(Self {
            directory: directory.to_owned(),
            _lock: None,
        })
    }

    pub(crate) fn incarnation(&self) -> Result<String> {
        let path = self.directory.join("incarnation");
        match fs::read_to_string(&path) {
            Ok(value) => {
                uuid::Uuid::parse_str(&value).context("read Worker Host incarnation")?;
                Ok(value)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let value = uuid::Uuid::new_v4().to_string();
                self.write(&path, |file| Ok(file.write_all(value.as_bytes())?))?;
                Ok(value)
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Start a new incarnation. Registering it replaces the Host's generation, which fences
    /// every Attempt the previous incarnation held.
    pub(crate) fn replace_incarnation(&self) -> Result<String> {
        let value = uuid::Uuid::new_v4().to_string();
        self.write(&self.directory.join("incarnation"), |file| {
            Ok(file.write_all(value.as_bytes())?)
        })?;
        Ok(value)
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    /// Persist before transmission so a restarted incarnation never reuses a
    /// sequence for different observations, even after an unacknowledged report.
    pub(crate) fn next_report_sequence(&self) -> Result<u64> {
        let path = self.directory.join("presence-sequence");
        let prior = match fs::read_to_string(&path) {
            Ok(value) => value.parse::<u64>().context("read host report sequence")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error.into()),
        };
        let next = prior
            .checked_add(1)
            .filter(|value| *value <= i64::MAX as u64)
            .context("host report sequence exhausted")?;
        self.write(&path, |file| Ok(write!(file, "{next}")?))?;
        Ok(next)
    }

    fn entry_path(&self) -> PathBuf {
        self.directory.join("attempt.json")
    }

    /// A claim sent and not yet answered is kept apart from the Attempt record: a slot waiting
    /// for work holds one, and it names no Attempt, whose reservation would expire on its lease.
    fn claim_path(&self) -> PathBuf {
        self.directory.join("claim.json")
    }

    pub(crate) fn load(&self) -> Result<Option<Entry>> {
        for path in [self.entry_path(), self.claim_path()] {
            match fs::read(path) {
                Ok(bytes) => {
                    return Ok(Some(
                        serde_json::from_slice(&bytes).context("read host journal")?,
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(None)
    }

    pub(crate) fn save(&self, entry: &Entry) -> Result<()> {
        if matches!(entry, Entry::Claim { .. }) {
            return self.write(&self.claim_path(), |file| {
                Ok(serde_json::to_writer(file, entry)?)
            });
        }
        self.write(&self.entry_path(), |file| {
            Ok(serde_json::to_writer(file, entry)?)
        })?;
        // The Attempt record now holds what the claim led to.
        self.remove_claim()
    }

    fn remove_claim(&self) -> Result<()> {
        match fs::remove_file(self.claim_path()) {
            Ok(()) => self.sync_directory(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn remote_sandbox_path(&self) -> PathBuf {
        self.directory.join("remote-sandbox.json")
    }

    fn shared_access_path(&self) -> PathBuf {
        self.directory.join("shared-execution-access.json")
    }

    pub(crate) fn shared_access(
        &self,
    ) -> Result<Option<crate::worker::shared_execution::AccessRecord>> {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(self.shared_access_path())
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file()
                && metadata.nlink() == 1
                && metadata.mode() & 0o077 == 0
                && metadata.uid() == unsafe { libc::geteuid() },
            "shared execution access journal must be private"
        );
        let mut bytes = Vec::new();
        file.take(4097).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 4096,
            "shared execution access journal exceeds its limit"
        );
        let record: crate::worker::shared_execution::AccessRecord =
            serde_json::from_slice(&bytes).context("read shared execution access journal")?;
        ensure!(
            valid_sha256(&record.scope)
                && record.host_generation > 0
                && !record.host_id.is_empty()
                && !record.task_id.is_empty()
                && !record.attempt_id.is_empty()
                && !record.tag_id.is_empty()
                && supertag_protocol::shared_execution::valid_environment_id(
                    &record.environment_id
                )
                && uuid::Uuid::parse_str(&record.incarnation_id).is_ok()
                && uuid::Uuid::parse_str(&record.access_id).is_ok()
                && (0..=2).contains(&record.command_mode)
                && (1_000..=86_400_000).contains(&record.ttl_ms),
            "invalid shared execution access journal"
        );
        Ok(Some(record))
    }

    pub(crate) fn save_shared_access(
        &self,
        record: &crate::worker::shared_execution::AccessRecord,
    ) -> Result<()> {
        self.write(&self.shared_access_path(), |file| {
            Ok(serde_json::to_writer(file, record)?)
        })
    }

    pub(crate) fn remote_scratch(&self) -> Result<PathBuf> {
        let directory = self.directory.join("remote-workspace");
        match DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => self.sync_directory()?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let metadata = directory.symlink_metadata()?;
        ensure!(
            metadata.is_dir()
                && metadata.mode() & 0o077 == 0
                && metadata.uid() == unsafe { libc::geteuid() },
            "sandbox scratch directory must be private"
        );
        Ok(directory.canonicalize()?)
    }

    pub(crate) fn remote_sandbox(&self) -> Result<Option<RemoteSandbox>> {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(self.remote_sandbox_path())
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file()
                && metadata.mode() & 0o077 == 0
                && metadata.uid() == unsafe { libc::geteuid() },
            "sandbox allocation journal must be private"
        );
        let mut bytes = Vec::new();
        file.take(4097).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 4096,
            "sandbox allocation journal exceeds its limit"
        );
        let record: RemoteSandbox =
            serde_json::from_slice(&bytes).context("read sandbox allocation journal")?;
        ensure!(
            record.host_generation > 0
                && !record.host_id.is_empty()
                && !record.task_id.is_empty()
                && !record.attempt_id.is_empty()
                && uuid::Uuid::parse_str(&record.allocation_id).is_ok()
                && valid_sha256(&record.provider_scope)
                && record.sandbox_id().is_none_or(valid_sandbox_id),
            "invalid sandbox allocation journal"
        );
        Ok(Some(record))
    }

    fn save_remote_sandbox(&self, record: &RemoteSandbox) -> Result<()> {
        self.write(&self.remote_sandbox_path(), |file| {
            Ok(serde_json::to_writer(file, record)?)
        })
    }

    /// Only a newly persisted intent authorizes allocation. A prior intent may
    /// have reached the provider even when the host has no sandbox ID yet.
    pub(crate) fn begin_remote_sandbox(
        &self,
        attempt: &Attempt,
        host_id: &str,
        host_generation: u64,
        provider_scope: String,
    ) -> Result<RemoteSandbox> {
        ensure!(
            host_generation > 0 && !host_id.is_empty() && valid_sha256(&provider_scope),
            "invalid sandbox host identity"
        );
        ensure!(
            matches!(self.load()?, Some(Entry::Executing { attempt: active, .. }) if &active == attempt),
            "sandbox allocation requires a durable executing Attempt"
        );
        ensure!(
            self.remote_sandbox()?.is_none(),
            "sandbox allocation already requires recovery"
        );
        let record = RemoteSandbox {
            host_id: host_id.to_owned(),
            host_generation,
            task_id: attempt.task_id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            allocation_id: uuid::Uuid::new_v4().to_string(),
            provider_scope,
            state: RemoteSandboxState::Allocating,
        };
        self.save_remote_sandbox(&record)?;
        Ok(record)
    }

    pub(crate) fn record_sandbox_active(
        &self,
        record: &RemoteSandbox,
        sandbox_id: String,
    ) -> Result<RemoteSandbox> {
        ensure!(
            record.state == RemoteSandboxState::Allocating
                && self.remote_sandbox()?.as_ref() == Some(record),
            "sandbox allocation receipt does not match the journal"
        );
        ensure!(valid_sandbox_id(&sandbox_id), "invalid sandbox identity");
        let record = RemoteSandbox {
            state: RemoteSandboxState::Active { sandbox_id },
            ..record.clone()
        };
        self.save_remote_sandbox(&record)?;
        Ok(record)
    }

    pub(crate) fn record_sandbox_stopped(
        &self,
        record: &RemoteSandbox,
        sandbox_id: String,
    ) -> Result<RemoteSandbox> {
        ensure!(
            self.remote_sandbox()?.as_ref() == Some(record),
            "sandbox stop receipt does not match the journal"
        );
        ensure!(
            valid_sandbox_id(&sandbox_id)
                && record.sandbox_id().is_none_or(|prior| prior == sandbox_id),
            "sandbox stop receipt belongs to another sandbox"
        );
        let record = RemoteSandbox {
            state: RemoteSandboxState::Stopped { sandbox_id },
            ..record.clone()
        };
        self.save_remote_sandbox(&record)?;
        Ok(record)
    }

    /// Forgets a preparation sandbox whose stop was confirmed, so the Attempt's own sandbox can
    /// be journaled next.
    pub(crate) fn retire_stopped_sandbox(&self, record: &RemoteSandbox) -> Result<()> {
        ensure!(
            matches!(record.state, RemoteSandboxState::Stopped { .. })
                && self.remote_sandbox()?.as_ref() == Some(record),
            "only a confirmed sandbox stop can be retired"
        );
        fs::remove_file(self.remote_sandbox_path())?;
        self.sync_directory()
    }

    pub(crate) fn write(
        &self,
        path: &Path,
        write: impl FnOnce(&mut File) -> Result<()>,
    ) -> Result<()> {
        let mut staged = NamedTempFile::new_in(&self.directory)?;
        write(staged.as_file_mut())?;
        staged.flush()?;
        staged.as_file().sync_all()?;
        staged.persist(path)?;
        self.sync_directory()
    }

    pub(crate) fn stage_checkpoint(
        &self,
        checkpoint: SessionCheckpoint,
    ) -> Result<PendingCheckpoint> {
        self.write(&self.directory.join("checkpoint.bin"), |file| {
            Ok(file.write_all(&checkpoint.payload)?)
        })?;
        Ok(PendingCheckpoint {
            harness: checkpoint.harness,
            format: checkpoint.format,
            sha256: checkpoint.sha256,
            uploaded: false,
        })
    }

    pub(crate) fn read_checkpoint(
        &self,
        checkpoint: &PendingCheckpoint,
    ) -> Result<SessionCheckpoint> {
        let path = self.directory.join("checkpoint.bin");
        anyhow::ensure!(
            fs::metadata(&path)?.len() <= MAX_CHECKPOINT_BYTES as u64,
            "staged checkpoint is oversized"
        );
        Ok(SessionCheckpoint {
            harness: checkpoint.harness.clone(),
            format: checkpoint.format.clone(),
            sha256: checkpoint.sha256.clone(),
            payload: fs::read(path)?,
        })
    }

    pub(crate) fn clear(&self) -> Result<()> {
        let remote = self.remote_sandbox()?;
        let shared = self.shared_access()?;
        ensure!(
            shared.as_ref().is_none_or(|access| access.ended),
            "shared execution cleanup must be confirmed before clearing the Attempt"
        );
        ensure!(
            remote
                .as_ref()
                .is_none_or(|record| matches!(record.state, RemoteSandboxState::Stopped { .. })),
            "sandbox cleanup must be confirmed before clearing the Attempt"
        );
        crate::artifact_snapshots::Snapshots::clear(&self.directory)?;
        crate::artifact_inputs::Inputs::clear(&self.directory)?;
        match fs::remove_dir_all(self.directory.join("remote-workspace")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        if remote.is_some() {
            fs::remove_file(self.remote_sandbox_path())?;
            self.sync_directory()?;
        }
        if shared.is_some() {
            fs::remove_file(self.shared_access_path())?;
            self.sync_directory()?;
        }
        match fs::remove_dir_all(self.directory.join(PROCESSES)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        match fs::remove_file(self.entry_path()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        self.remove_claim()?;
        match fs::remove_file(self.directory.join("checkpoint.bin")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        self.sync_directory()
    }

    fn sync_directory(&self) -> Result<()> {
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }

    /// The record of the processes this host starts for `attempt` while it executes.
    pub(crate) fn processes(&self, attempt: &Attempt) -> Processes {
        Processes {
            directory: self.directory.join(PROCESSES),
            attempt_id: attempt.attempt_id.clone(),
        }
    }
}

/// The Worker's view of its slot's journal for its one Attempt. It records the Attempt's
/// harness processes, its sandbox and shared-access records, and its staged checkpoint, which the
/// Worklet reads to recover them. The entry's stages are the Worklet's: the Worker reports the
/// ones it reaches as milestones over the local contract, and the Worklet journals them.
#[derive(Clone, Copy)]
pub(crate) struct AttemptJournal<'a>(&'a Journal);

impl Journal {
    /// The view of this slot a Worker writes through, also used by the Worklet's own recovery of
    /// a Worker's sandbox and shared access.
    pub(crate) fn for_attempt(&self) -> AttemptJournal<'_> {
        AttemptJournal(self)
    }
}

impl AttemptJournal<'_> {
    /// Stages the turn's checkpoint beside the entry, for the Worklet to record and upload.
    pub(crate) fn stage_checkpoint(
        &self,
        checkpoint: SessionCheckpoint,
    ) -> Result<PendingCheckpoint> {
        self.0.stage_checkpoint(checkpoint)
    }

    pub(crate) fn processes(&self, attempt: &Attempt) -> Processes {
        self.0.processes(attempt)
    }

    pub(crate) fn shared_access(
        &self,
    ) -> Result<Option<crate::worker::shared_execution::AccessRecord>> {
        self.0.shared_access()
    }

    pub(crate) fn save_shared_access(
        &self,
        record: &crate::worker::shared_execution::AccessRecord,
    ) -> Result<()> {
        self.0.save_shared_access(record)
    }

    pub(crate) fn remote_scratch(&self) -> Result<PathBuf> {
        self.0.remote_scratch()
    }

    pub(crate) fn remote_sandbox(&self) -> Result<Option<RemoteSandbox>> {
        self.0.remote_sandbox()
    }

    pub(crate) fn begin_remote_sandbox(
        &self,
        attempt: &Attempt,
        host_id: &str,
        host_generation: u64,
        provider_scope: String,
    ) -> Result<RemoteSandbox> {
        self.0
            .begin_remote_sandbox(attempt, host_id, host_generation, provider_scope)
    }

    pub(crate) fn record_sandbox_active(
        &self,
        record: &RemoteSandbox,
        sandbox_id: String,
    ) -> Result<RemoteSandbox> {
        self.0.record_sandbox_active(record, sandbox_id)
    }

    pub(crate) fn record_sandbox_stopped(
        &self,
        record: &RemoteSandbox,
        sandbox_id: String,
    ) -> Result<RemoteSandbox> {
        self.0.record_sandbox_stopped(record, sandbox_id)
    }

    pub(crate) fn retire_stopped_sandbox(&self, record: &RemoteSandbox) -> Result<()> {
        self.0.retire_stopped_sandbox(record)
    }
}

/// Creates `directory` owner-only, or checks that it is.
fn private_state_directory(directory: &Path) -> Result<()> {
    DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(directory)
        .context("create Worker Host state directory")?;
    let metadata = directory.symlink_metadata()?;
    let owner = unsafe { libc::geteuid() };
    ensure!(
        metadata.is_dir() && metadata.uid() == owner && metadata.mode() & 0o022 == 0,
        "Worker Host state directory must be writable only by its owner"
    );
    Ok(())
}

/// Where the host records each process group it starts while an Attempt executes.
const PROCESSES: &str = "attempt-processes";
const MAX_PROCESS_RECORDS: usize = 256;

#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum ProcessRecord {
    /// A spawn may have happened, but its process group is unknown.
    Pending,
    /// The spawn failed, so nothing ran.
    None,
    Recorded {
        group: i32,
    },
}

/// Who wrote a process record, as TypeScript's ownership manifest names it. Process group IDs
/// prove nothing on another machine, for another user, or in another PID namespace.
#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
struct ProcessOwner {
    attempt_id: String,
    hostname: String,
    uid: u32,
    platform: String,
    /// The PID namespace on Linux.
    pid_namespace: Option<String>,
    /// Whether every process ran on this host. A remote sandbox or shared execution environment
    /// runs commands this record cannot see, so its Attempt is never reclaimed automatically.
    colocated: bool,
}

impl ProcessOwner {
    fn current(attempt_id: &str, colocated: bool) -> Result<Self> {
        let mut name = [0_u8; 256];
        // SAFETY: the buffer is writable for its length.
        ensure!(
            unsafe { libc::gethostname(name.as_mut_ptr().cast(), name.len()) } == 0,
            "read the host name"
        );
        let end = name
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(name.len());
        Ok(Self {
            attempt_id: attempt_id.to_owned(),
            hostname: String::from_utf8_lossy(&name[..end]).into_owned(),
            // SAFETY: geteuid has no preconditions.
            uid: unsafe { libc::geteuid() },
            platform: std::env::consts::OS.to_owned(),
            pid_namespace: fs::read_link("/proc/self/ns/pid")
                .ok()
                .map(|link| link.to_string_lossy().into_owned()),
            colocated,
        })
    }
}

/// The process groups an executing Attempt started, recorded before each spawn as TypeScript's
/// `LocalAttemptOwnership` does. A host restarted after it was killed may reclaim the Attempt
/// only when every record names a process group that is gone. A pending, unreadable, or live
/// record, or a missing directory, never counts as stopped.
#[derive(Clone, Debug)]
pub(crate) struct Processes {
    directory: PathBuf,
    attempt_id: String,
}

pub(crate) struct PendingProcess {
    path: PathBuf,
    directory: PathBuf,
}

impl Processes {
    /// Start an empty record before the Attempt can start any process. `colocated` is false
    /// when the Attempt also runs commands off this host.
    pub(crate) fn begin(&self, colocated: bool) -> Result<()> {
        match fs::remove_dir_all(&self.directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        DirBuilder::new().mode(0o700).create(&self.directory)?;
        write_private(
            &self.directory.join("attempt"),
            &serde_json::to_vec(&ProcessOwner::current(&self.attempt_id, colocated)?)?,
        )?;
        sync(&self.directory)?;
        sync(self.directory.parent().context("process record parent")?)
    }

    /// Forget the record, so a restart cannot reclaim the Attempt on its own. Used once the
    /// host holds an outcome that only the operator may now decide.
    pub(crate) fn discard(&self) -> Result<()> {
        match fs::remove_dir_all(&self.directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        sync(self.directory.parent().context("process record parent")?)
    }

    /// Persist uncertainty before a spawn; a crash before `record` keeps it.
    pub(crate) fn prepare(&self) -> Result<PendingProcess> {
        let entries = fs::read_dir(&self.directory)
            .context("read the Attempt's process record")?
            .count();
        ensure!(
            entries <= MAX_PROCESS_RECORDS,
            "an Attempt records at most {MAX_PROCESS_RECORDS} processes"
        );
        let pending = PendingProcess {
            path: self
                .directory
                .join(format!("process-{}.json", uuid::Uuid::new_v4().simple())),
            directory: self.directory.clone(),
        };
        pending.write(&ProcessRecord::Pending)?;
        Ok(pending)
    }

    /// Whether a record of this Attempt's processes exists.
    pub(crate) fn recorded(&self) -> bool {
        self.directory.join("attempt").exists()
    }

    /// Whether every process this Attempt recorded is proven gone.
    pub(crate) fn stopped(&self) -> Result<Option<String>> {
        let owner = match read_private(&self.directory.join("attempt")) {
            Ok(owner) => owner,
            Err(_) => return Ok(None),
        };
        let current = ProcessOwner::current(&self.attempt_id, true)?;
        if serde_json::from_slice::<ProcessOwner>(&owner).ok() != Some(current) {
            return Ok(None);
        }
        let mut groups = Vec::new();
        for entry in fs::read_dir(&self.directory)? {
            let name = entry?.file_name();
            let Some(name) = name.to_str() else {
                return Ok(None);
            };
            if name == "attempt" {
                continue;
            }
            if !name.starts_with("process-") || !name.ends_with(".json") {
                return Ok(None);
            }
            let Ok(bytes) = read_private(&self.directory.join(name)) else {
                return Ok(None);
            };
            match serde_json::from_slice::<ProcessRecord>(&bytes) {
                Ok(ProcessRecord::None) => {}
                Ok(ProcessRecord::Recorded { group }) if group > 1 && group_gone(group) => {
                    groups.push(group);
                }
                _ => return Ok(None),
            }
        }
        groups.sort_unstable();
        Ok(Some(if groups.is_empty() {
            "The Worker Host restarted and found that this Attempt started no processes.".into()
        } else {
            format!(
                "The Worker Host restarted and found every process group it recorded for this Attempt gone: {}.",
                groups
                    .iter()
                    .map(i32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }))
    }
}

impl PendingProcess {
    /// Record the started process group, or that the spawn failed (`None`).
    pub(crate) fn record(self, group: Option<u32>) -> Result<()> {
        let record = match group.map(i32::try_from) {
            Some(Ok(group)) => ProcessRecord::Recorded { group },
            Some(Err(_)) => anyhow::bail!("process group out of range"),
            None => ProcessRecord::None,
        };
        self.write(&record)
    }

    fn write(&self, record: &ProcessRecord) -> Result<()> {
        let mut staged = NamedTempFile::new_in(&self.directory)?;
        serde_json::to_writer(staged.as_file_mut(), record)?;
        staged.as_file().sync_all()?;
        staged.persist(&self.path)?;
        sync(&self.directory)
    }
}

/// Only `ESRCH` proves a group gone; a reused or inaccessible group counts as running.
fn group_gone(group: i32) -> bool {
    // SAFETY: signal 0 only checks whether the process group exists.
    let result = unsafe { libc::kill(-group, 0) };
    result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let directory = path.parent().context("private file parent")?;
    let mut staged = NamedTempFile::new_in(directory)?;
    staged.write_all(bytes)?;
    staged.as_file().sync_all()?;
    staged.persist(path)?;
    Ok(())
}

fn read_private(path: &Path) -> Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.nlink() == 1
            && metadata.mode() & 0o077 == 0
            && metadata.uid() == unsafe { libc::geteuid() },
        "process record must be private"
    );
    let mut bytes = Vec::new();
    file.take(1025).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 1024, "process record exceeds its limit");
    Ok(bytes)
}

fn sync(directory: &Path) -> Result<()> {
    File::open(directory)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_recorded_gone_process_groups_prove_an_attempt_stopped() -> Result<()> {
        use std::os::unix::process::CommandExt;
        let state = tempfile::tempdir()?;
        let journal = Journal::open(state.path())?;
        let attempt = |id: &str| Attempt {
            attempt_credential: String::new(),
            native_memory: None,
            task_id: "task".into(),
            attempt_id: id.into(),
            lease_token: "lease".into(),
            execution_selection: None,
            requires_unsandboxed_commands: false,
            joined: vec![],
            volume: None,
        };
        let processes = journal.processes(&attempt("attempt"));
        // No record at all is no evidence.
        assert!(processes.stopped()?.is_none());
        processes.begin(true)?;
        assert!(
            processes
                .stopped()?
                .unwrap()
                .contains("started no processes")
        );
        // A spawn whose group was never recorded stays uncertain.
        let pending = processes.prepare()?;
        assert!(processes.stopped()?.is_none());
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()?;
        pending.record(Some(child.id()))?;
        assert!(processes.stopped()?.is_none(), "a live group is running");
        child.kill()?;
        child.wait()?;
        let gone = processes.stopped()?.expect("a reaped group is gone");
        assert!(gone.contains(&child.id().to_string()));
        processes.prepare()?.record(None)?;
        assert!(processes.stopped()?.is_some());
        // Another Attempt's record and an unknown file are no evidence.
        assert!(journal.processes(&attempt("other")).stopped()?.is_none());
        fs::write(state.path().join(PROCESSES).join("stray"), b"")?;
        assert!(processes.stopped()?.is_none());
        processes.discard()?;
        assert!(processes.stopped()?.is_none());
        // Commands off this host are never proven stopped, nor is another owner's record.
        processes.begin(false)?;
        assert!(processes.stopped()?.is_none());
        processes.begin(true)?;
        let owner = state.path().join(PROCESSES).join("attempt");
        let mut forged: ProcessOwner = serde_json::from_slice(&read_private(&owner)?)?;
        forged.hostname.push_str("-elsewhere");
        write_private(&owner, &serde_json::to_vec(&forged)?)?;
        assert!(processes.stopped()?.is_none());
        Ok(())
    }

    #[test]
    fn lost_allocation_acknowledgement_requires_recovery_before_reuse() -> Result<()> {
        let state = tempfile::tempdir()?;
        let attempt = Attempt {
            attempt_credential: String::new(),
            native_memory: None,
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            lease_token: "lease-secret".into(),
            execution_selection: None,
            requires_unsandboxed_commands: false,
            joined: vec![],
            volume: None,
        };
        let journal = Journal::open(state.path())?;
        let provider_scope = "a".repeat(64);
        assert!(
            journal
                .begin_remote_sandbox(&attempt, "host", 1, provider_scope.clone())
                .is_err()
        );
        journal.save(&Entry::Executing {
            attempt: attempt.clone(),
            prepared: None,
        })?;
        let intent = journal.begin_remote_sandbox(&attempt, "host", 7, provider_scope.clone())?;
        assert!(intent.sandbox_id().is_none());
        assert!(!fs::read_to_string(journal.remote_sandbox_path())?.contains(&attempt.lease_token));
        drop(journal);

        let journal = Journal::open(state.path())?;
        let loaded = journal.remote_sandbox()?.unwrap();
        assert_eq!(loaded.owner(), intent.owner());
        assert_eq!(loaded.owner().host_generation, 7);
        assert_eq!(loaded.provider_scope, provider_scope);
        assert!(
            journal
                .begin_remote_sandbox(&attempt, "host", 7, provider_scope)
                .is_err()
        );
        assert!(journal.clear().is_err());
        let active = journal.record_sandbox_active(&loaded, "owned-sandbox".into())?;
        assert!(
            journal
                .record_sandbox_active(&loaded, "second-sandbox".into())
                .is_err()
        );
        assert!(
            journal
                .record_sandbox_stopped(&active, "other-sandbox".into())
                .is_err()
        );
        assert!(journal.clear().is_err());
        let stopped = journal.record_sandbox_stopped(&active, "owned-sandbox".into())?;
        assert_eq!(journal.remote_sandbox()?, Some(stopped));
        journal.clear()?;
        assert!(journal.load()?.is_none());
        assert!(journal.remote_sandbox()?.is_none());
        Ok(())
    }

    #[test]
    fn released_ownership_is_immediately_reacquirable_while_children_spawn() -> Result<()> {
        use std::sync::atomic::{AtomicBool, Ordering};

        // Children spawned on other threads briefly share the lock's open file description
        // until exec closes it. Dropping a Journal must still release ownership at once.
        let state = tempfile::tempdir()?;
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let spawners = (0..4)
            .map(|_| {
                let stop = stop.clone();
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        let _ = std::process::Command::new("/usr/bin/true")
                            .stdin(std::process::Stdio::null())
                            .status();
                    }
                })
            })
            .collect::<Vec<_>>();
        let reopened = (0..2_000).try_for_each(|_| Journal::open(state.path()).map(drop));
        stop.store(true, Ordering::Relaxed);
        for spawner in spawners {
            spawner.join().expect("spawner thread panicked");
        }
        reopened
    }

    #[test]
    fn presence_sequence_survives_restart_and_rejects_corruption() -> Result<()> {
        let state = tempfile::tempdir()?;
        let journal = Journal::open(state.path())?;
        assert_eq!(journal.next_report_sequence()?, 1);
        assert_eq!(journal.next_report_sequence()?, 2);
        drop(journal);
        let journal = Journal::open(state.path())?;
        assert_eq!(journal.next_report_sequence()?, 3);
        fs::write(state.path().join("presence-sequence"), "bad counter")?;
        assert!(journal.next_report_sequence().is_err());
        Ok(())
    }

    #[test]
    fn journal_is_exclusive_and_persists_execution_intent() -> Result<()> {
        use prost::Message;
        use supertag_protocol::v2::{
            AttemptExecutionSelection, ClaimTaskRequest, ExecutionSelection,
            HarnessExecutionProfile, HarnessKind, ModelSource,
        };

        let state = tempfile::tempdir()?;
        let journal = Journal::open(state.path())?;
        assert!(Journal::open(state.path()).is_err());
        let prior: Entry = serde_json::from_str(r#"{"stage":"claim","operation_id":"old"}"#)?;
        assert!(matches!(prior, Entry::Claim { request, .. } if request.is_empty()));
        let claim = ClaimTaskRequest {
            operation_id: "claim".into(),
            harness_kind: HarnessKind::Codex as i32,
            workspace_ids: vec!["repository".into()],
            execution_profile: Some(HarnessExecutionProfile {
                declared_task_outputs: false,
                volumes: vec![],
                model_ids: vec!["primary".into(), "secondary".into()],
                default_model: Some("primary".into()),
                allow_unsandboxed_commands: false,
                remote_file_workspace: false,
                mcp_servers: vec![],
                shared_execution: None,
                task_artifact_inputs: false,
                workspace_mounts: vec![],
                mcp_login_servers: vec![],
                network_credentials: vec![],
                network_sandbox: false,
                unverified_workspace_provider: false,
                remote_egress_relay: false,
            }),
            ..Default::default()
        };
        journal.save(&Entry::Claim {
            operation_id: claim.operation_id.clone(),
            request: claim.encode_to_vec(),
        })?;
        let Some(Entry::Claim {
            operation_id,
            request,
        }) = journal.load()?
        else {
            anyhow::bail!("Claim intent was not restored");
        };
        assert_eq!(operation_id, claim.operation_id);
        assert_eq!(ClaimTaskRequest::decode(request.as_slice())?, claim);
        let execution_selection = Some(
            AttemptExecutionSelection {
                selection: Some(ExecutionSelection {
                    model: Some("secondary".into()),
                    effort: Some("high".into()),
                }),
                model_source: ModelSource::Task as i32,
                harness_kind: HarnessKind::Codex as i32,
                effort_applied: Some(true),
                remote_file_workspace: false,
                shared_execution: None,
                mcp_servers: vec![],
                task_artifact_inputs: false,
            }
            .encode_to_vec(),
        );
        journal.save(&Entry::Executing {
            attempt: Attempt {
                attempt_credential: String::new(),
                native_memory: None,
                task_id: "task".into(),
                attempt_id: "attempt".into(),
                lease_token: "lease".into(),
                execution_selection: execution_selection.clone(),
                requires_unsandboxed_commands: false,
                joined: vec![],
                volume: None,
            },
            prepared: None,
        })?;
        drop(journal);
        let reopened = Journal::open(state.path())?;
        assert!(matches!(
            reopened.load()?,
            Some(Entry::Executing { attempt, .. })
                if attempt.task_id == "task" && attempt.attempt_id == "attempt"
                    && attempt.execution_selection == execution_selection
        ));
        reopened.clear()?;
        assert!(reopened.load()?.is_none());
        Ok(())
    }
}
