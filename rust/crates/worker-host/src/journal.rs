use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Attempt {
    pub task_id: String,
    pub attempt_id: String,
    pub lease_token: String,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub(crate) enum Entry {
    Claim {
        operation_id: String,
    },
    Starting {
        #[serde(flatten)]
        attempt: Attempt,
    },
    Executing {
        #[serde(flatten)]
        attempt: Attempt,
    },
    Finish {
        #[serde(flatten)]
        attempt: Attempt,
        result: String,
        succeeded: bool,
        #[serde(default)]
        objective_signal: i32,
    },
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
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(directory.join("host.lock"))?;
        lock.try_lock()
            .context("another Worker Host owns this state directory")?;
        Ok(Self {
            directory: directory.to_owned(),
            _lock: lock,
        })
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
        let mut staged = NamedTempFile::new_in(&self.directory)?;
        serde_json::to_writer(staged.as_file_mut(), entry)?;
        staged.flush()?;
        staged.as_file().sync_all()?;
        staged.persist(self.entry_path())?;
        self.sync_directory()
    }

    pub(crate) fn clear(&self) -> Result<()> {
        fs::remove_file(self.entry_path())?;
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
    fn journal_is_exclusive_and_persists_execution_intent() -> Result<()> {
        let state = tempfile::tempdir()?;
        let journal = Journal::open(state.path())?;
        assert!(Journal::open(state.path()).is_err());
        journal.save(&Entry::Claim {
            operation_id: "claim".into(),
        })?;
        journal.save(&Entry::Executing {
            attempt: Attempt {
                task_id: "task".into(),
                attempt_id: "attempt".into(),
                lease_token: "lease".into(),
            },
        })?;
        drop(journal);
        let reopened = Journal::open(state.path())?;
        assert!(matches!(
            reopened.load()?,
            Some(Entry::Executing { attempt })
                if attempt.task_id == "task" && attempt.attempt_id == "attempt"
        ));
        reopened.clear()?;
        assert!(reopened.load()?.is_none());
        Ok(())
    }
}
