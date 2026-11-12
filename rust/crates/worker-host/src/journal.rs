use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use crate::workspaces::{PendingWorkspace, PreparedWorkspace};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use supertag_protocol::{MAX_CHECKPOINT_BYTES, v2::SessionCheckpoint};
use tempfile::NamedTempFile;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Attempt {
    pub task_id: String,
    pub attempt_id: String,
    pub lease_token: String,
    #[serde(default)]
    pub execution_selection: Option<Vec<u8>>,
    #[serde(default)]
    pub requires_unsandboxed_commands: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct PendingCheckpoint {
    pub harness: String,
    pub format: String,
    pub sha256: String,
    pub uploaded: bool,
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
        checkpoint: Option<PendingCheckpoint>,
        workspace: Box<PreparedWorkspace>,
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
        checkpoint: Option<PendingCheckpoint>,
        #[serde(default)]
        workspace: Option<Box<PendingWorkspace>>,
        #[serde(default)]
        prepared: Option<Box<PreparedWorkspace>>,
    },
    Terminal {
        #[serde(flatten)]
        attempt: Attempt,
        prepared: Option<Box<PreparedWorkspace>>,
    },
}

impl Entry {
    /// Keep checkout ownership when an outcome is downgraded after local cleanup.
    pub(crate) fn prepared(&self, expected: &Attempt) -> Result<Option<Box<PreparedWorkspace>>> {
        let (attempt, prepared) = match self {
            Self::Starting { attempt } => (attempt, None),
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

pub(crate) struct Journal {
    directory: PathBuf,
    _lock: File,
}

impl Journal {
    pub(crate) fn open(directory: &Path) -> Result<Self> {
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
        lock.try_lock()
            .context("another Worker Host owns this state directory")?;
        Ok(Self {
            directory: directory.to_owned(),
            _lock: lock,
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

    pub(crate) fn load(&self) -> Result<Option<Entry>> {
        match fs::read(self.entry_path()) {
            Ok(bytes) => Ok(Some(
                serde_json::from_slice(&bytes).context("read host journal")?,
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn save(&self, entry: &Entry) -> Result<()> {
        self.write(&self.entry_path(), |file| {
            Ok(serde_json::to_writer(file, entry)?)
        })
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
        fs::remove_file(self.entry_path())?;
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
                model_ids: vec!["primary".into(), "secondary".into()],
                default_model: Some("primary".into()),
                allow_unsandboxed_commands: false,
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
            }
            .encode_to_vec(),
        );
        journal.save(&Entry::Executing {
            attempt: Attempt {
                task_id: "task".into(),
                attempt_id: "attempt".into(),
                lease_token: "lease".into(),
                execution_selection: execution_selection.clone(),
                requires_unsandboxed_commands: false,
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
