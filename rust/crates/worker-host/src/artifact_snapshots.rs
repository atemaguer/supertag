use std::{
    collections::BTreeMap,
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use prost::Message;
use sha2::{Digest, Sha256};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    artifacts::{MAX_ARTIFACT_BYTES, MAX_ARTIFACT_FILE_BYTES, validate_capture_manifest},
    v2::{
        ArtifactDescription, ArtifactFile, BlobReference, CapturedArtifact,
        CommitArtifactCaptureRequest, GitOutputSnapshot, HarnessCaptureArtifactRequest,
        InspectAttemptRequest,
    },
};
use tempfile::NamedTempFile;
use tonic::Status;

const MAX_PENDING_BYTES: u64 = 2 * (MAX_ARTIFACT_BYTES + MAX_MESSAGE_BYTES as u64);
const SNAPSHOTS: &str = "artifact-snapshots";

#[derive(Clone)]
pub(crate) struct Snapshots {
    directory: PathBuf,
}

pub(crate) enum Capture {
    Pending(CommitArtifactCaptureRequest, Vec<Vec<u8>>),
    Committed(CapturedArtifact),
}

pub(crate) struct CollectedOutput {
    pub(crate) bytes: Vec<u8>,
    pub(crate) git_output: Option<GitOutputSnapshot>,
}

enum SnapshotSource<'a> {
    Checkout(&'a Path),
    Collected(BTreeMap<String, CollectedOutput>),
    Replay,
}

enum SnapshotMode {
    Explicit,
    Output { declared: bool, max_bytes: u64 },
}

impl Snapshots {
    pub(crate) fn open(state: &Path, attempt_id: &str) -> Result<Self> {
        let root = state.join(SNAPSHOTS);
        let directory = root.join(digest(attempt_id.as_bytes()));
        create_private_directory(&root)?;
        create_private_directory(&directory)?;
        File::open(state)?.sync_all()?;
        File::open(root)?.sync_all()?;
        Ok(Self { directory })
    }

    pub(crate) fn clear(state: &Path) -> Result<()> {
        match fs::remove_dir_all(state.join(SNAPSHOTS)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn freeze(
        &self,
        checkout: &Path,
        attempt: InspectAttemptRequest,
        request: HarnessCaptureArtifactRequest,
    ) -> Result<Capture, Status> {
        self.freeze_with_purpose(
            SnapshotSource::Checkout(checkout),
            attempt,
            request,
            SnapshotMode::Explicit,
        )
    }

    pub(crate) fn freeze_outputs(
        &self,
        checkout: &Path,
        attempt: InspectAttemptRequest,
        request: HarnessCaptureArtifactRequest,
        declared: bool,
        max_bytes: u64,
    ) -> Result<Capture, Status> {
        self.freeze_with_purpose(
            SnapshotSource::Checkout(checkout),
            attempt,
            request,
            SnapshotMode::Output {
                declared,
                max_bytes,
            },
        )
    }

    pub(crate) fn freeze_collected_outputs(
        &self,
        files: BTreeMap<String, CollectedOutput>,
        attempt: InspectAttemptRequest,
        request: HarnessCaptureArtifactRequest,
        max_bytes: u64,
    ) -> Result<Capture, Status> {
        self.freeze_with_purpose(
            SnapshotSource::Collected(files),
            attempt,
            request,
            SnapshotMode::Output {
                declared: true,
                max_bytes,
            },
        )
    }

    pub(crate) fn staged_output_paths(
        &self,
        operation: &str,
        attempt: InspectAttemptRequest,
        declared: bool,
        max_bytes: u64,
    ) -> Result<Option<Vec<String>>, Status> {
        let Some(mut file) =
            open_private(&self.path(operation, "pending")).map_err(journal_error)?
        else {
            return Ok(None);
        };
        let mut manifest: CommitArtifactCaptureRequest =
            read_record(&mut file).map_err(journal_error)?;
        if manifest.operation_id != operation
            || manifest.attempt.is_some()
            || manifest.declared_task_output != declared
            || manifest.managed_task_output == declared
        {
            return Err(Status::data_loss(
                "stored Task output has invalid authority",
            ));
        }
        manifest.attempt = Some(attempt);
        if validate_capture_manifest(&manifest)? > max_bytes {
            return Err(Status::data_loss(
                "stored artifact exceeds its accepted byte limit",
            ));
        }
        Ok(Some(
            manifest.files.into_iter().map(|file| file.path).collect(),
        ))
    }

    pub(crate) fn replay_outputs(
        &self,
        attempt: InspectAttemptRequest,
        request: HarnessCaptureArtifactRequest,
        declared: bool,
        max_bytes: u64,
    ) -> Result<Capture, Status> {
        self.freeze_with_purpose(
            SnapshotSource::Replay,
            attempt,
            request,
            SnapshotMode::Output {
                declared,
                max_bytes,
            },
        )
    }

    fn freeze_with_purpose(
        &self,
        mut source: SnapshotSource<'_>,
        attempt: InspectAttemptRequest,
        mut request: HarnessCaptureArtifactRequest,
        mode: SnapshotMode,
    ) -> Result<Capture, Status> {
        let (managed_task_output, declared_task_output, max_bytes) = match mode {
            SnapshotMode::Explicit => (false, false, MAX_ARTIFACT_BYTES),
            SnapshotMode::Output {
                declared,
                max_bytes,
            } => (!declared, declared, max_bytes),
        };
        request.paths.sort_unstable();
        let receipt = self.path(&request.operation_id, "receipt");
        if let Some(mut file) = open_private(&receipt).map_err(journal_error)? {
            let capture: CapturedArtifact = read_record(&mut file).map_err(journal_error)?;
            ensure_eof(&mut file).map_err(journal_error)?;
            let summary = capture
                .summary
                .as_ref()
                .ok_or_else(|| Status::data_loss("stored artifact summary is missing"))?;
            if summary.declared_task_output != declared_task_output
                || summary.byte_length > max_bytes
            {
                return Err(Status::data_loss(
                    "stored artifact differs from its accepted output policy",
                ));
            }
            let producer = summary
                .producer
                .as_ref()
                .ok_or_else(|| Status::data_loss("stored artifact producer is missing"))?;
            if producer.task_id != attempt.task_id || producer.attempt_id != attempt.attempt_id {
                return Err(Status::data_loss(
                    "stored artifact belongs to another Attempt",
                ));
            }
            check_selection(
                &request,
                &summary.description,
                &producer.native_session_id,
                &capture.files,
            )?;
            self.remove_pending(&request.operation_id)
                .map_err(journal_error)?;
            return Ok(Capture::Committed(capture));
        }

        let path = self.path(&request.operation_id, "pending");
        if let Some(mut file) = open_private(&path).map_err(journal_error)? {
            let mut manifest: CommitArtifactCaptureRequest =
                read_record(&mut file).map_err(journal_error)?;
            if manifest.operation_id != request.operation_id
                || manifest.attempt.is_some()
                || manifest.managed_task_output != managed_task_output
                || manifest.declared_task_output != declared_task_output
            {
                return Err(Status::data_loss(
                    "stored artifact request has invalid authority",
                ));
            }
            check_selection(
                &request,
                &manifest.description,
                &manifest.native_session_id,
                &manifest.files,
            )?;
            manifest.attempt = Some(attempt);
            if validate_capture_manifest(&manifest)? > max_bytes {
                return Err(Status::data_loss(
                    "stored artifact exceeds its accepted byte limit",
                ));
            }
            let bytes = manifest
                .files
                .iter()
                .map(|entry| {
                    let blob = entry.blob.as_ref().expect("validated artifact manifest");
                    let mut content = vec![0; blob.byte_length as usize];
                    file.read_exact(&mut content).map_err(journal_error)?;
                    if digest(&content) != blob.sha256 {
                        return Err(Status::data_loss(
                            "frozen artifact bytes failed verification",
                        ));
                    }
                    Ok(content)
                })
                .collect::<Result<Vec<_>, _>>()?;
            ensure_eof(&mut file).map_err(journal_error)?;
            return Ok(Capture::Pending(manifest, bytes));
        }

        if matches!(&source, SnapshotSource::Replay) {
            return Err(Status::data_loss("frozen Task output snapshot is missing"));
        }
        let mut manifest = CommitArtifactCaptureRequest {
            attempt: Some(attempt),
            operation_id: request.operation_id,
            description: request.description,
            files: Vec::with_capacity(request.paths.len()),
            native_session_id: request.native_session_id,
            managed_task_output,
            declared_task_output,
        };
        let pending = self.pending_bytes().map_err(journal_error)?;
        let mut remaining = (MAX_PENDING_BYTES.saturating_sub(pending))
            .saturating_sub(MAX_MESSAGE_BYTES as u64 + 4)
            .min(max_bytes);
        if remaining == 0 {
            return Err(Status::resource_exhausted(
                "retry a pending artifact capture before staging more bytes",
            ));
        }
        let mut bytes = Vec::with_capacity(request.paths.len());
        for path in request.paths {
            let limit = remaining.min(MAX_ARTIFACT_FILE_BYTES) as usize;
            let CollectedOutput {
                bytes: content,
                git_output,
            } = match &mut source {
                SnapshotSource::Checkout(checkout) => CollectedOutput {
                    bytes: supertag_workspaces::capture_artifact_file(checkout, &path, limit)
                        .map_err(|_| {
                            Status::failed_precondition(
                                "cannot capture the selected workspace file",
                            )
                        })?,
                    git_output: None,
                },
                SnapshotSource::Collected(files) => files
                    .remove(&path)
                    .ok_or_else(|| Status::internal("selected output file was not collected"))?,
                SnapshotSource::Replay => unreachable!("replay has no new output files"),
            };
            if content.len() > limit {
                return Err(Status::resource_exhausted(
                    "Task output exceeds its byte limit",
                ));
            }
            let byte_length = content.len() as u64;
            remaining -= byte_length;
            manifest.files.push(ArtifactFile {
                path,
                blob: Some(BlobReference {
                    sha256: digest(&content),
                    byte_length,
                }),
                git_output,
            });
            bytes.push(content);
        }
        validate_capture_manifest(&manifest)?;
        let authority = manifest.attempt.take();
        self.persist(&path, &manifest, &bytes)
            .map_err(journal_error)?;
        manifest.attempt = authority;
        Ok(Capture::Pending(manifest, bytes))
    }

    pub(crate) fn commit(&self, operation: &str, receipt: &CapturedArtifact) -> Result<()> {
        self.persist(&self.path(operation, "receipt"), receipt, &[])?;
        self.remove_pending(operation)
    }

    fn persist(&self, path: &Path, record: &impl Message, bytes: &[Vec<u8>]) -> Result<()> {
        let mut staging = NamedTempFile::new_in(&self.directory)?;
        let encoded = record.encode_to_vec();
        ensure!(
            encoded.len() <= MAX_MESSAGE_BYTES,
            "artifact journal record is oversized"
        );
        staging.write_all(&(encoded.len() as u32).to_be_bytes())?;
        staging.write_all(&encoded)?;
        for content in bytes {
            staging.write_all(content)?;
        }
        staging.as_file().sync_all()?;
        staging.persist(path)?;
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }

    fn remove_pending(&self, operation: &str) -> Result<()> {
        match fs::remove_file(self.path(operation, "pending")) {
            Ok(()) => Ok(File::open(&self.directory)?.sync_all()?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn pending_bytes(&self) -> Result<u64> {
        let mut total = 0_u64;
        for entry in fs::read_dir(&self.directory)? {
            let path = entry?.path();
            if path
                .extension()
                .is_some_and(|extension| extension == "pending")
            {
                total = total.saturating_add(path.symlink_metadata()?.len());
            }
        }
        Ok(total)
    }

    fn path(&self, operation: &str, extension: &str) -> PathBuf {
        self.directory
            .join(digest(operation.as_bytes()))
            .with_extension(extension)
    }
}

fn digest(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn create_private_directory(path: &Path) -> Result<()> {
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = path.symlink_metadata()?;
    ensure!(
        metadata.is_dir()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0,
        "artifact snapshot directory is not private"
    );
    Ok(())
}

fn open_private(path: &Path) -> Result<Option<File>> {
    match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => {
            let metadata = file.metadata()?;
            ensure!(
                metadata.is_file()
                    && metadata.uid() == unsafe { libc::geteuid() }
                    && metadata.mode() & 0o077 == 0
                    && metadata.nlink() == 1,
                "artifact snapshot is not a private regular file"
            );
            Ok(Some(file))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn read_record<T: Default + Message>(file: &mut File) -> Result<T> {
    let mut size = [0; 4];
    file.read_exact(&mut size)?;
    let size = u32::from_be_bytes(size) as usize;
    ensure!(
        size <= MAX_MESSAGE_BYTES,
        "artifact journal record is oversized"
    );
    let mut bytes = vec![0; size];
    file.read_exact(&mut bytes)?;
    T::decode(bytes.as_slice()).context("invalid artifact journal record")
}

fn ensure_eof(file: &mut File) -> Result<()> {
    ensure!(
        file.read(&mut [0])? == 0,
        "artifact journal has trailing bytes"
    );
    Ok(())
}

fn check_selection(
    request: &HarnessCaptureArtifactRequest,
    description: &Option<ArtifactDescription>,
    native_session_id: &Option<String>,
    files: &[ArtifactFile],
) -> Result<(), Status> {
    if &request.description != description
        || &request.native_session_id != native_session_id
        || !request
            .paths
            .iter()
            .map(String::as_str)
            .eq(files.iter().map(|file| file.path.as_str()))
    {
        return Err(Status::already_exists(
            "artifact operation was used with a different selection",
        ));
    }
    Ok(())
}

fn journal_error<E>(_: E) -> Status {
    Status::data_loss("artifact snapshot could not be read or saved safely")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{Attempt, Entry, Journal};
    use supertag_protocol::v2::{ArtifactProducer, ArtifactSummary};
    use tonic::Code;

    fn attempt() -> InspectAttemptRequest {
        InspectAttemptRequest {
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            lease_token: "private-lease-token".into(),
        }
    }

    fn selection() -> HarnessCaptureArtifactRequest {
        HarnessCaptureArtifactRequest {
            operation_id: "report".into(),
            description: Some(ArtifactDescription {
                title: "Evidence".into(),
                kind: "report".into(),
                summary: None,
            }),
            paths: vec!["report.txt".into(), "empty.txt".into()],
            native_session_id: Some("native-session".into()),
        }
    }

    #[test]
    fn frozen_operation_replays_after_lost_upload_reply_and_source_removal() -> Result<()> {
        let state = tempfile::tempdir()?;
        let checkout = tempfile::tempdir()?;
        fs::write(checkout.path().join("report.txt"), b"original bytes")?;
        fs::write(checkout.path().join("empty.txt"), [])?;
        let snapshots = Snapshots::open(state.path(), "attempt")?;
        let Capture::Pending(first, bytes) =
            snapshots.freeze(&checkout.path().canonicalize()?, attempt(), selection())?
        else {
            anyhow::bail!("expected a new pending capture");
        };
        assert_eq!(bytes, [Vec::new(), b"original bytes".to_vec()]);
        let stored = fs::read(snapshots.path("report", "pending"))?;
        assert!(
            !stored
                .windows(b"private-lease-token".len())
                .any(|part| part == b"private-lease-token")
        );
        drop(snapshots);
        checkout.close()?;

        let snapshots = Snapshots::open(state.path(), "attempt")?;
        let missing = state.path().join("removed-checkout");
        let mut exact_retry = selection();
        exact_retry.paths.reverse();
        let Capture::Pending(replay, replayed_bytes) =
            snapshots.freeze(&missing, attempt(), exact_retry.clone())?
        else {
            anyhow::bail!("expected a pending capture replay");
        };
        assert_eq!(replay, first);
        assert_eq!(replayed_bytes, bytes);
        let mut conflicting = selection();
        conflicting.paths.pop();
        let error = snapshots
            .freeze(&missing, attempt(), conflicting)
            .err()
            .unwrap();
        assert_eq!(error.code(), Code::AlreadyExists);

        let receipt = CapturedArtifact {
            inputs: vec![],
            files: replay.files,
            summary: Some(ArtifactSummary {
                artifact_id: "immutable-artifact".into(),
                description: replay.description,
                producer: Some(ArtifactProducer {
                    task_id: "task".into(),
                    attempt_id: "attempt".into(),
                    native_session_id: replay.native_session_id,
                    ..Default::default()
                }),
                ..Default::default()
            }),
        };
        snapshots.commit("report", &receipt)?;
        assert!(!snapshots.path("report", "pending").exists());
        let Capture::Committed(prior) = snapshots.freeze(&missing, attempt(), exact_retry)? else {
            anyhow::bail!("expected the exact committed receipt");
        };
        assert_eq!(prior, receipt);
        let journal = Journal::open(state.path())?;
        journal.save(&Entry::Terminal {
            attempt: Attempt {
                task_id: "task".into(),
                attempt_id: "attempt".into(),
                lease_token: "private-lease-token".into(),
                execution_selection: None,
                requires_unsandboxed_commands: false,
            },
            prepared: None,
        })?;
        journal.clear()?;
        assert!(!state.path().join(SNAPSHOTS).exists());
        Ok(())
    }

    #[test]
    fn corrupted_pending_bytes_fail_closed_instead_of_resnapshotting() -> Result<()> {
        let state = tempfile::tempdir()?;
        let checkout = tempfile::tempdir()?;
        fs::write(checkout.path().join("report.txt"), b"original")?;
        fs::write(checkout.path().join("empty.txt"), [])?;
        let snapshots = Snapshots::open(state.path(), "attempt")?;
        let checkout = checkout.path().canonicalize()?;
        snapshots.freeze(&checkout, attempt(), selection())?;
        let pending = snapshots.path("report", "pending");
        let mut corrupt = fs::read(&pending)?;
        *corrupt.last_mut().context("missing frozen bytes")? = b'!';
        fs::write(pending, corrupt)?;
        let error = snapshots
            .freeze(&checkout, attempt(), selection())
            .err()
            .unwrap();
        assert_eq!(error.code(), Code::DataLoss);
        Ok(())
    }
}
