//! Prepared remote Workspace artifacts: a provider snapshot of a preparation sandbox that holds
//! only the trusted commit and its devcontainer setup, which later Task sandboxes start from.
//!
//! TypeScript parity: `PreparedWorkspaceCache` (`packages/runtime/sdk/src/workspace-environment.ts`)
//! and `SandboxWorkspaceEnvironment.prepare` (`sandbox-workspace-environment.ts`). One artifact
//! serves every Attempt whose prepared digest matches: the provider authority, the Workspace,
//! the devcontainer translation, and the trusted commit. On a miss, the newest artifact with the
//! same warm key (the digest without the trusted commit) whose trusted commit is an ancestor of
//! the new one starts a warm preparation, which runs `updateContentCommand` alone; a warm
//! preparation that fails is retried cold once. Records live in the host's state directory, and
//! each preparation evicts artifacts beyond three per Workspace or unused for seven days.
//!
//! Differences: the preparation sandbox's network is blocked, as every Rust remote Workspace
//! sandbox's is, and it is journaled under the Attempt, so a host restart stops it like the
//! Attempt's own sandbox. Only translations with a lifecycle command are prepared.
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use supertag_protocol::v2::{HostRecord, RemoteWorkspaceEnvironment};
use supertag_workspaces::{ExclusiveLock, devcontainer::RemoteDevcontainer};
use tokio_util::sync::CancellationToken;

use crate::{
    HostOptions,
    journal::{Attempt, Journal},
    remote_provider::{ProviderConfig, RemoteProvider, Start, validate_artifact},
    workspaces::{PreparedWorkspace, Workspaces},
};

/// TypeScript's `PREPARED_WORKSPACE_LIMITS`.
const PER_WORKSPACE: usize = 3;
const UNUSED_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// A preparation sandbox outlives its image build and setup, each bounded at 20 minutes.
const PREPARATION_LIFETIME: Duration = Duration::from_secs(45 * 60);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    digest: String,
    warm_key: String,
    workspace_id: String,
    provider_scope: String,
    artifact: String,
    trusted_commit: String,
    last_used_ms: u64,
}

/// The prepared digest and warm key of a Workspace's translation on this provider.
fn keys(
    provider_scope: &str,
    workspace_id: &str,
    environment: &RemoteDevcontainer,
    trusted_commit: &str,
) -> (String, String) {
    let key = |trusted: Option<&str>| {
        let canonical = serde_json::json!({
            "provider": provider_scope,
            "workspace": workspace_id,
            "image": environment.image,
            "dockerfile": environment.dockerfile_commands,
            "user": environment.user,
            "setup": environment.setup_commands,
            "trusted": trusted,
        });
        format!("{:x}", Sha256::digest(canonical.to_string()))
    };
    (key(Some(trusted_commit)), key(None))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// The host's private record directory.
fn directory(state: &Path) -> Result<PathBuf> {
    let directory = state.join("prepared-workspaces");
    match DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = directory.symlink_metadata()?;
    ensure!(
        metadata.is_dir()
            && metadata.mode() & 0o077 == 0
            && metadata.uid() == unsafe { libc::geteuid() },
        "prepared Workspace records must be private"
    );
    Ok(directory)
}

fn lock_file(directory: &Path, digest: &str) -> Result<File> {
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join(format!("{digest}.lock")))?)
}

/// Waits for this digest's lock: another lane of this host may be preparing it.
async fn lock(directory: &Path, digest: &str, cancel: &CancellationToken) -> Result<ExclusiveLock> {
    loop {
        match ExclusiveLock::try_acquire(lock_file(directory, digest)?) {
            Ok(lock) => return Ok(lock),
            Err(_) => {
                tokio::select! {
                    () = cancel.cancelled() => anyhow::bail!("Workspace preparation cancelled"),
                    () = tokio::time::sleep(Duration::from_millis(200)) => {}
                }
            }
        }
    }
}

fn read(path: &Path) -> Option<Record> {
    let bytes = fs::read(path).ok()?;
    let record: Record = serde_json::from_slice(&bytes).ok()?;
    let name = path.file_stem()?.to_str()?;
    (record.digest == name && validate_artifact(&record.artifact).is_ok()).then_some(record)
}

fn write(directory: &Path, record: &Record) -> Result<()> {
    let mut staged = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(staged.as_file_mut(), record)?;
    staged.as_file().sync_all()?;
    staged.persist(directory.join(format!("{}.json", record.digest)))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

/// This Workspace's records on this provider, most recently used first.
fn list(directory: &Path, workspace_id: &str, provider_scope: &str) -> Vec<Record> {
    let mut records: Vec<Record> = fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| read(&entry.path()))
        .filter(|record| {
            record.workspace_id == workspace_id && record.provider_scope == provider_scope
        })
        .collect();
    records.sort_by(|left, right| right.last_used_ms.cmp(&left.last_used_ms));
    records
}

/// The prepared artifact for this Attempt's Workspace: a recorded one for the same digest, or a
/// new one from a preparation sandbox, warm when an ancestor's artifact exists.
pub(crate) async fn artifact(
    options: &HostOptions,
    journal: &Journal,
    workspaces: &Workspaces,
    (attempt, workspace): (&Attempt, &PreparedWorkspace),
    environment: &RemoteDevcontainer,
    registration: &HostRecord,
    cancel: &CancellationToken,
) -> Result<String> {
    let config = options
        .remote_provider
        .as_ref()
        .context("remote Workspace provider is unavailable")?;
    let scope = config.authority_fingerprint();
    let trusted = &workspace.checkout.base_commit;
    let (digest, warm_key) = keys(&scope, &workspace.workspace_id, environment, trusted);
    let records = directory(&options.state_directory)?;
    let artifact = {
        let _lock = lock(&records, &digest, cancel).await?;
        let path = records.join(format!("{digest}.json"));
        if let Some(mut record) = read(&path) {
            record.last_used_ms = now_ms();
            write(&records, &record)?;
            record.artifact
        } else {
            let mut warm = None;
            for record in list(&records, &workspace.workspace_id, &scope) {
                if record.warm_key == warm_key
                    && record.trusted_commit != *trusted
                    && workspaces
                        .base_descends_from(workspace, &record.trusted_commit, cancel)
                        .await
                {
                    warm = Some(record.artifact);
                    break;
                }
            }
            let preparation = (journal, workspaces, registration, config);
            let built = match warm {
                Some(from) => match build(
                    preparation,
                    attempt,
                    workspace,
                    environment,
                    Some(from),
                    cancel,
                )
                .await
                {
                    Ok(artifact) => Ok(artifact),
                    Err(_) if !cancel.is_cancelled() => {
                        // As TypeScript retries a failed warm build cold once.
                        stop_preparation(options, journal, attempt, registration).await?;
                        build(preparation, attempt, workspace, environment, None, cancel).await
                    }
                    Err(error) => Err(error),
                },
                None => build(preparation, attempt, workspace, environment, None, cancel).await,
            }?;
            let now = now_ms();
            write(
                &records,
                &Record {
                    digest: digest.clone(),
                    warm_key,
                    workspace_id: workspace.workspace_id.clone(),
                    provider_scope: scope.clone(),
                    artifact: built.clone(),
                    trusted_commit: trusted.clone(),
                    last_used_ms: now,
                },
            )?;
            built
        }
    };
    // Outside the digest lock: eviction takes other digests' locks.
    evict(
        config,
        journal,
        &records,
        &workspace.workspace_id,
        &scope,
        &digest,
    )
    .await;
    Ok(artifact)
}

/// Stops a preparation sandbox journaled under the Attempt and forgets it.
async fn stop_preparation(
    options: &HostOptions,
    journal: &Journal,
    attempt: &Attempt,
    registration: &HostRecord,
) -> Result<()> {
    crate::remote::ensure_stopped(options, journal, attempt, registration).await?;
    if let Some(record) = journal.remote_sandbox()? {
        journal.retire_stopped_sandbox(&record)?;
    }
    Ok(())
}

/// One preparation sandbox: the trusted commit alone, its setup, then a snapshot.
async fn build(
    (journal, workspaces, registration, config): (
        &Journal,
        &Workspaces,
        &HostRecord,
        &ProviderConfig,
    ),
    attempt: &Attempt,
    workspace: &PreparedWorkspace,
    environment: &RemoteDevcontainer,
    from: Option<String>,
    cancel: &CancellationToken,
) -> Result<String> {
    let trusted = workspaces.export_trusted(workspace, cancel).await?;
    let mut provider = RemoteProvider::spawn(config, &journal.remote_scratch()?, cancel).await?;
    let record = journal.begin_remote_sandbox(
        attempt,
        &registration.host_id,
        registration.generation,
        config.authority_fingerprint(),
    )?;
    let warm = from.is_some();
    let request = RemoteWorkspaceEnvironment {
        image: environment.image.clone(),
        dockerfile_commands: environment.dockerfile_commands.clone(),
        user: environment.user.clone(),
        setup_commands: if warm {
            environment.warm_setup_commands.clone()
        } else {
            environment.setup_commands.clone()
        },
    };
    let prepared = async {
        let sandbox = provider
            .allocate(
                &record.owner(),
                PREPARATION_LIFETIME,
                &[],
                (Some(request), &Start::Prepare { from }),
                cancel,
            )
            .await?;
        let record = journal.record_sandbox_active(&record, sandbox.clone())?;
        provider
            .stage(
                &trusted,
                &workspace.checkout.base_commit,
                &[],
                None,
                true,
                cancel,
            )
            .await?;
        let artifact = provider.snapshot(cancel).await?;
        let stopped = provider
            .stop(&record.owner(), Some(&sandbox), &CancellationToken::new())
            .await?
            .context("preparation sandbox termination could not be confirmed")?;
        let record = journal.record_sandbox_stopped(&record, stopped)?;
        journal.retire_stopped_sandbox(&record)?;
        Ok::<_, anyhow::Error>(artifact)
    }
    .await;
    let _ = fs::remove_file(&trusted.path);
    let closed = provider.shutdown().await;
    let artifact = prepared?;
    closed?;
    Ok(artifact)
}

/// Best effort: deletes artifacts beyond the newest three of this Workspace, and any unused for
/// seven days, except the one just used and any another lane holds.
async fn evict(
    config: &ProviderConfig,
    journal: &Journal,
    records: &Path,
    workspace_id: &str,
    scope: &str,
    keep: &str,
) {
    let now = now_ms();
    let candidates: Vec<Record> = list(records, workspace_id, scope)
        .into_iter()
        .enumerate()
        .filter(|(index, record)| {
            record.digest != keep
                && (*index >= PER_WORKSPACE || now.saturating_sub(record.last_used_ms) > UNUSED_MS)
        })
        .map(|(_, record)| record)
        .collect();
    if candidates.is_empty() {
        return;
    }
    let cancel = CancellationToken::new();
    let Ok(scratch) = journal.remote_scratch() else {
        return;
    };
    let Ok(mut provider) = RemoteProvider::spawn(config, &scratch, &cancel).await else {
        return;
    };
    for record in candidates {
        let Ok(file) = lock_file(records, &record.digest) else {
            continue;
        };
        let Ok(_lock) = ExclusiveLock::try_acquire(file) else {
            continue;
        };
        if provider
            .remove_artifact(&record.artifact, &cancel)
            .await
            .is_ok()
        {
            let _ = fs::remove_file(records.join(format!("{}.json", record.digest)));
            let _ = fs::remove_file(records.join(format!("{}.lock", record.digest)));
        }
    }
    let _ = provider.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment(setup: &str) -> RemoteDevcontainer {
        RemoteDevcontainer {
            setup_commands: vec![setup.into()],
            warm_setup_commands: vec![],
            prepared: true,
            ..Default::default()
        }
    }

    #[test]
    fn the_digest_covers_the_trusted_commit_and_the_warm_key_does_not() {
        let base = keys("scope", "app", &environment("make"), "a");
        assert_eq!(base, keys("scope", "app", &environment("make"), "a"));
        let next = keys("scope", "app", &environment("make"), "b");
        assert_ne!(base.0, next.0);
        assert_eq!(base.1, next.1);
        for other in [
            keys("other-scope", "app", &environment("make"), "a"),
            keys("scope", "other-app", &environment("make"), "a"),
            keys("scope", "app", &environment("make test"), "a"),
        ] {
            assert_ne!(base.0, other.0);
            assert_ne!(base.1, other.1);
        }
    }

    #[test]
    fn records_are_private_and_listed_newest_first() {
        let state = tempfile::tempdir().unwrap();
        let records = directory(state.path()).unwrap();
        assert_eq!(fs::metadata(&records).unwrap().mode() & 0o777, 0o700);
        let record = |digest: &str, workspace: &str, used: u64| Record {
            digest: digest.into(),
            warm_key: "warm".into(),
            workspace_id: workspace.into(),
            provider_scope: "scope".into(),
            artifact: format!("im-{digest}"),
            trusted_commit: "a".into(),
            last_used_ms: used,
        };
        write(&records, &record("one", "app", 1)).unwrap();
        write(&records, &record("two", "app", 3)).unwrap();
        write(&records, &record("three", "other", 2)).unwrap();
        // A record under another name, or with an invalid artifact, is ignored.
        fs::write(
            records.join("forged.json"),
            serde_json::to_vec(&record("one", "app", 9)).unwrap(),
        )
        .unwrap();
        let mut invalid = record("four", "app", 9);
        invalid.artifact = "bad artifact".into();
        write(&records, &invalid).unwrap();
        let listed: Vec<String> = list(&records, "app", "scope")
            .into_iter()
            .map(|record| record.digest)
            .collect();
        assert_eq!(listed, ["two", "one"]);
        assert!(list(&records, "app", "other-scope").is_empty());
    }
}
