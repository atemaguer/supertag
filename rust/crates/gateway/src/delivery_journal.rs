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
use supertag_protocol::{
    authenticated_request,
    v2::{RenewReplyRequest, connector_client::ConnectorClient},
};
use tempfile::NamedTempFile;
use tokio::time;
use tonic::transport::Channel;
const REPLY_FILE: &str = "reply.json";
const OWNER_FILE: &str = "connector-owner";
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
    owner_id: String,
    _lock: File,
}

impl Journal {
    pub(crate) fn open(directory: &Path, account_id: &str, provider: &str) -> Result<Self> {
        ensure!(
            matches!(
                provider,
                "slack" | "github" | "linear" | "lark" | "microsoft-teams"
            ),
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
        let directory = directory.canonicalize()?;
        let owner_id = owner_id(&directory)?;
        let journal = Self {
            directory,
            account_id: account_id.into(),
            provider: provider.into(),
            owner_id,
            _lock: lock,
        };
        journal.load()?;
        Ok(journal)
    }

    /// Stable connector owner identity of this private state directory. A
    /// restarted Gateway with the same state reclaims its ownership at once.
    pub(crate) fn owner_id(&self) -> &str {
        &self.owner_id
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

fn owner_id(directory: &Path) -> Result<String> {
    let path = directory.join(OWNER_FILE);
    match open_private(&path, false) {
        Ok(file) => {
            let mut value = String::new();
            file.take(65).read_to_string(&mut value)?;
            let value = value.trim().to_owned();
            ensure!(
                uuid::Uuid::parse_str(&value).is_ok(),
                "invalid connector owner identity"
            );
            Ok(value)
        }
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|e| e.kind() == io::ErrorKind::NotFound) =>
        {
            let value = uuid::Uuid::new_v4().to_string();
            let mut staged = NamedTempFile::new_in(directory)?;
            staged.write_all(value.as_bytes())?;
            staged.as_file().sync_all()?;
            staged.persist(&path)?;
            File::open(directory)?.sync_all()?;
            Ok(value)
        }
        Err(error) => Err(error).context("open connector owner identity"),
    }
}

/// Claim a reply. A lost ownership lease is not an error: the driver reclaims or waits.
pub(crate) async fn claim_call<T>(
    call: impl Future<Output = Result<T, tonic::Status>>,
    operation: &str,
) -> Result<Option<T>> {
    match time::timeout(DELIVERY_TIMEOUT, call).await {
        Ok(Err(error)) if error.code() == tonic::Code::FailedPrecondition => Ok(None),
        Ok(result) => private_call(async { result }, operation).await,
        Err(_) => Ok(None),
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
            ) || supertag_protocol::interrupted_transport(&error) =>
        {
            Ok(None)
        }
        Ok(Err(error)) => anyhow::bail!("{operation} rejected by Control Plane ({})", error.code()),
        Err(_) => Ok(None),
    }
}

/// A conflicting settlement is durably audited by the Control Plane. Retire the
/// local receipt, retaining the authoritative outcome, so it cannot poison later replies.
pub(crate) async fn settle_call(
    call: impl Future<Output = Result<tonic::Response<supertag_protocol::v2::Reply>, tonic::Status>>,
    operation: &str,
) -> Result<bool> {
    match time::timeout(DELIVERY_TIMEOUT, call).await {
        Ok(Ok(_)) => Ok(true),
        Ok(Err(error)) if error.code() == tonic::Code::AlreadyExists => Ok(true),
        Ok(Err(error))
            if matches!(
                error.code(),
                tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled
            ) || supertag_protocol::interrupted_transport(&error) =>
        {
            Ok(false)
        }
        Err(_) => Ok(false),
        Ok(Err(error)) => anyhow::bail!("{operation} rejected by Control Plane ({})", error.code()),
    }
}

enum Renewal {
    Granted(time::Instant),
    Transient,
    Revoked,
}

async fn renew_claim(
    client: &mut ConnectorClient<Channel>,
    gateway_token: &str,
    principal: &str,
    target: &Claim,
) -> Result<Renewal> {
    let requested_at = time::Instant::now();
    let mut request = authenticated_request(
        RenewReplyRequest {
            reply_id: target.reply_id.clone(),
            lease_token: target.lease_token.clone(),
        },
        gateway_token,
        Some(principal),
    )?;
    request.set_timeout(DELIVERY_TIMEOUT);
    match time::timeout(DELIVERY_TIMEOUT, client.renew_reply(request)).await {
        Ok(Ok(response)) => {
            let duration = response.into_inner().valid_for_ms;
            Ok(if (10_000..=60_000).contains(&duration) {
                Renewal::Granted(requested_at + Duration::from_millis(duration))
            } else {
                Renewal::Revoked
            })
        }
        Ok(Err(error)) if error.code() == tonic::Code::FailedPrecondition => Ok(Renewal::Revoked),
        Ok(Err(error))
            if matches!(
                error.code(),
                tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled
            ) || supertag_protocol::interrupted_transport(&error) =>
        {
            Ok(Renewal::Transient)
        }
        Err(_) => Ok(Renewal::Transient),
        Ok(Err(error)) => {
            anyhow::bail!("renew reply rejected by Control Plane ({})", error.code())
        }
    }
}

/// This future stays pending while ownership is valid. Its deadline also bounds
/// an in-flight renewal, and only a successful renewal can extend that deadline.
async fn maintain_claim_lease(
    client: &mut ConnectorClient<Channel>,
    gateway_token: &str,
    principal: &str,
    target: &Claim,
    mut valid_until: time::Instant,
) -> Result<()> {
    loop {
        tokio::select! {
            biased;
            _ = time::sleep_until(valid_until) => return Ok(()),
            _ = time::sleep(Duration::from_secs(2)) => {},
        }
        let renewal = tokio::select! {
            biased;
            _ = time::sleep_until(valid_until) => return Ok(()),
            result = renew_claim(client, gateway_token, principal, target) => result?,
        };
        match renewal {
            Renewal::Granted(deadline) => valid_until = deadline,
            Renewal::Transient => {}
            Renewal::Revoked => return Ok(()),
        }
    }
}

/// Prove ownership before credential preparation or provider I/O, then poll lease
/// maintenance alongside that work. Transient renewal failures retain the last
/// proven deadline; expiry or explicit revocation drops the possibly sent request.
pub(crate) async fn with_claim_lease<T>(
    mut client: ConnectorClient<Channel>,
    gateway_token: &str,
    principal: &str,
    target: &Claim,
    work: impl Future<Output = Result<T>>,
) -> Result<Option<T>> {
    let Renewal::Granted(valid_until) =
        renew_claim(&mut client, gateway_token, principal, target).await?
    else {
        return Ok(None);
    };
    tokio::select! {
        biased;
        result = maintain_claim_lease(&mut client, gateway_token, principal, target, valid_until) => result.map(|()| None),
        result = work => result.map(Some),
    }
}

#[cfg(test)]
mod tests;
