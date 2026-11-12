//! Crash-safe provider delivery intent and receipt storage shared by connectors.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    future::Future,
    io::{self, Read as _, Write as _},
    os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _},
    path::{Path, PathBuf},
    time::Duration,
};
use tempfile::NamedTempFile;
use tokio::time;
const REPLY_FILE: &str = "reply.json";
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);
#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Claim {
    pub(crate) reply_id: String,
    pub(crate) lease_token: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum Outcome {
    Delivered { provider_receipt: String },
    Failed,
    Uncertain,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub(crate) enum Entry {
    Claim { operation_id: String },
    Sending { target: Claim },
    Settle { target: Claim, outcome: Outcome },
}

#[derive(Deserialize, Serialize)]
struct Record {
    account_id: String,
    provider: String,
    entry: Entry,
}

pub(crate) struct Journal {
    directory: PathBuf,
    account_id: String,
    provider: String,
    _lock: File,
}

impl Journal {
    pub(crate) fn open(directory: &Path, account_id: &str, provider: &str) -> Result<Self> {
        ensure!(
            matches!(provider, "slack" | "github"),
            "unknown delivery provider"
        );
        DirBuilder::new()
            .mode(0o700)
            .recursive(true)
            .create(directory)?;
        let metadata = fs::symlink_metadata(directory)?;
        ensure!(
            metadata.is_dir() && private(&metadata),
            "Surface state must be an owner-only directory"
        );
        let lock = open_private(&directory.join("delivery.lock"), true)?;
        lock.try_lock()
            .context("Surface delivery state is already in use")?;
        let journal = Self {
            directory: directory.canonicalize()?,
            account_id: account_id.into(),
            provider: provider.into(),
            _lock: lock,
        };
        journal.load()?;
        Ok(journal)
    }

    pub(crate) fn load(&self) -> Result<Option<Entry>> {
        let file = match open_private(&self.directory.join(REPLY_FILE), false) {
            Ok(file) => file,
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|e| e.kind() == io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error).context("open Surface delivery journal"),
        };
        let mut bytes = Vec::new();
        file.take(8193).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 8192, "Surface delivery journal is too large");
        let record: Record = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid Surface delivery journal"))?;
        ensure!(
            record.account_id == self.account_id && record.provider == self.provider,
            "Surface delivery journal belongs to another provider or account"
        );
        Ok(Some(record.entry))
    }

    pub(crate) fn save(&self, entry: &Entry) -> Result<()> {
        let mut staged = NamedTempFile::new_in(&self.directory)?;
        serde_json::to_writer(
            staged.as_file_mut(),
            &Record {
                account_id: self.account_id.clone(),
                provider: self.provider.clone(),
                entry: entry.clone(),
            },
        )?;
        staged.flush()?;
        staged.as_file().sync_all()?;
        staged.persist(self.directory.join(REPLY_FILE))?;
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }

    pub(crate) fn clear(&self) -> Result<()> {
        fs::remove_file(self.directory.join(REPLY_FILE))?;
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }
}

fn open_private(path: &Path, create: bool) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(create)
        .create(create)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.nlink() == 1 && private(&metadata),
        "Surface state file must be private"
    );
    Ok(file)
}

fn private(metadata: &fs::Metadata) -> bool {
    // SAFETY: geteuid reads the current process's effective user ID.
    metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0
}

pub(crate) async fn private_call<T>(
    call: impl Future<Output = Result<T, tonic::Status>>,
    operation: &str,
) -> Result<Option<T>> {
    match time::timeout(DELIVERY_TIMEOUT, call).await {
        Ok(Ok(value)) => Ok(Some(value)),
        Ok(Err(error))
            if matches!(
                error.code(),
                tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled
            ) =>
        {
            Ok(None)
        }
        Ok(Err(error)) => anyhow::bail!("{operation} rejected by Control Plane ({})", error.code()),
        Err(_) => Ok(None),
    }
}
