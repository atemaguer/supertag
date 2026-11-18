use std::{
    collections::HashSet,
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use sha2::{Digest, Sha256};
use supertag_protocol::{
    MAX_MESSAGE_BYTES, MAX_RESUMED_CHECKPOINT_BYTES,
    v2::{volume_objects_client::VolumeObjectsClient, worker_host_client::WorkerHostClient, *},
    validate_checkpoint_reference,
};
use tonic::{Status, transport::Channel};

use crate::{HostHeaders, request, worklet::journal::Attempt};

/// Whether this host's harness resumes the checkpoint. One it cannot (one too big to grow, or
/// another harness's, which only a Tag that names no harness can leave, since any lane claims its
/// Tasks) is left out, and the adapter starts fresh from the Session's recap. A custom adapter's
/// host names no harness, so only its adapter can tell.
pub(crate) fn resumable(harness: HarnessKind, checkpoint: &SessionCheckpoint) -> bool {
    supertag_protocol::checkpoint_harness(harness).is_none_or(|name| name == checkpoint.harness)
        && checkpoint.payload.len() <= MAX_RESUMED_CHECKPOINT_BYTES
}

/// The checkpoint a finished turn keeps. One too big to grow would be dropped before the next
/// turn resumed it, so it is never kept: the turn still succeeds, and the next one starts from
/// the recap.
pub(crate) fn kept(checkpoint: Option<SessionCheckpoint>) -> Option<SessionCheckpoint> {
    checkpoint.filter(|checkpoint| checkpoint.payload.len() <= MAX_RESUMED_CHECKPOINT_BYTES)
}

/// How long a held checkpoint file lives without being written again: the Control Plane drops a
/// Session's checkpoint after the same idle time.
const FILE_IDLE: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// A file younger than this is never swept: its turn may not have recorded it yet.
const FRESH: Duration = Duration::from_secs(60 * 60);

/// The Session checkpoints this host holds, in its artifact storage, which every lane of the host
/// shares: `tags/<sha256(tag)>/sessions/<sha256(session)>/checkpoint/<sha256>.bin`. The Control
/// Plane keeps only which host holds each one, so only this host can resume it. A Tag's other
/// per-host state, such as its harness's native memory, goes beside `sessions/` under the same
/// `tags/<sha256(tag)>/`.
#[derive(Clone)]
pub(crate) struct Held {
    root: PathBuf,
    host_id: String,
}

fn hashed(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

/// A Tag's directory in this host's artifact storage, which every lane of the host shares:
/// `tags/<sha256(tag)>`. Its Session checkpoints and its harness's native memory live in it.
pub(crate) fn tag_directory(storage: &Path, tag: &str) -> PathBuf {
    storage.join("tags").join(hashed(tag))
}

fn private_directory(path: &Path) -> std::io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.mode() & 0o077 != 0 {
        return Err(std::io::Error::other(
            "checkpoint directory must be a private directory",
        ));
    }
    Ok(())
}

impl Held {
    pub(crate) fn new(storage: &Path, host_id: &str) -> Self {
        Self {
            root: storage.to_owned(),
            host_id: host_id.to_owned(),
        }
    }

    fn directory(&self, tag: &str, session: &str) -> PathBuf {
        tag_directory(&self.root, tag)
            .join("sessions")
            .join(hashed(session))
            .join("checkpoint")
    }

    /// Writes the checkpoint beside the Session's other checkpoint files, owner-only.
    pub(crate) fn save(
        &self,
        tag: &str,
        session: &str,
        checkpoint: &SessionCheckpoint,
    ) -> std::io::Result<()> {
        let directory = self.directory(tag, session);
        private_directory(&directory)?;
        let mut staged = tempfile::NamedTempFile::new_in(&directory)?;
        staged
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
        staged.write_all(&checkpoint.payload)?;
        staged.as_file().sync_all()?;
        staged.persist(directory.join(format!("{}.bin", checkpoint.sha256)))?;
        fs::File::open(&directory)?.sync_all()
    }

    /// The held checkpoint `reference` names, when its file is here and its bytes match.
    pub(crate) fn load(
        &self,
        tag: &str,
        session: &str,
        reference: &CheckpointReference,
    ) -> Option<SessionCheckpoint> {
        let path = self
            .directory(tag, session)
            .join(format!("{}.bin", reference.sha256));
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() || metadata.len() != reference.byte_length {
            return None;
        }
        let mut payload = Vec::with_capacity(reference.byte_length as usize);
        std::io::Read::read_to_end(
            &mut std::io::Read::take(&file, reference.byte_length + 1),
            &mut payload,
        )
        .ok()?;
        (payload.len() as u64 == reference.byte_length
            && format!("{:x}", Sha256::digest(&payload)) == reference.sha256)
            .then(|| SessionCheckpoint {
                harness: reference.harness.clone(),
                format: reference.format.clone(),
                sha256: reference.sha256.clone(),
                payload,
            })
    }

    /// Deletes the Session's other checkpoint files once `kept` is recorded.
    pub(crate) fn supersede(&self, tag: &str, session: &str, kept: &str) {
        let Ok(entries) = fs::read_dir(self.directory(tag, session)) else {
            return;
        };
        let kept = format!("{kept}.bin");
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name != kept && name.ends_with(".bin"))
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    /// Deletes every held checkpoint file `live` does not name, or not written for 14 days, unless
    /// it is younger than an hour. Returns how many it deleted.
    pub(crate) fn sweep(&self, live: &HashSet<String>, now: SystemTime) -> usize {
        let mut deleted = 0;
        let Ok(tags) = fs::read_dir(self.root.join("tags")) else {
            return 0;
        };
        for tag in tags.flatten() {
            let Ok(sessions) = fs::read_dir(tag.path().join("sessions")) else {
                continue;
            };
            for session in sessions.flatten() {
                let directory = session.path().join("checkpoint");
                let Ok(files) = fs::read_dir(&directory) else {
                    continue;
                };
                for file in files.flatten() {
                    let name = file.file_name();
                    let Some(digest) = name.to_str().and_then(|name| name.strip_suffix(".bin"))
                    else {
                        continue;
                    };
                    let age = file
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .ok()
                        .and_then(|modified| now.duration_since(modified).ok())
                        .unwrap_or_default();
                    if age >= FRESH
                        && (age >= FILE_IDLE || !live.contains(digest))
                        && fs::remove_file(file.path()).is_ok()
                    {
                        deleted += 1;
                    }
                }
                // An emptied Session directory goes too; a non-empty one stays.
                let _ = fs::remove_dir(&directory);
                let _ = fs::remove_dir(session.path());
            }
        }
        deleted
    }
}

fn authorized<T>(message: T, token: &str) -> Result<tonic::Request<T>, Status> {
    request(message, token).map_err(|error| {
        crate::failures::noted(
            Status::internal("cannot authenticate checkpoint call"),
            &error,
        )
    })
}

#[derive(Clone)]
pub(crate) struct Transfers {
    pub(crate) channel: Channel,
    pub(crate) headers: HostHeaders,
    /// Where this host keeps the Workspace deliveries it produces.
    pub(crate) storage: Option<crate::worklet::artifact_direct::SourceStorage>,
    /// The Session checkpoints this host holds.
    pub(crate) held: Option<Held>,
    /// The file Volumes this host maps, for checkpoints of Tags that name a Volume.
    pub(crate) volumes: crate::worklet::volume_objects::HostVolumes,
}

impl Transfers {
    pub fn new(channel: Channel, headers: HostHeaders) -> Self {
        Self {
            channel,
            headers,
            storage: None,
            held: None,
            volumes: Default::default(),
        }
    }

    pub(crate) fn with_volumes(
        mut self,
        volumes: crate::worklet::volume_objects::HostVolumes,
    ) -> Self {
        self.volumes = volumes;
        self
    }

    pub(crate) fn volume_objects(
        &self,
    ) -> VolumeObjectsClient<tonic::service::interceptor::InterceptedService<Channel, HostHeaders>>
    {
        VolumeObjectsClient::with_interceptor(self.channel.clone(), self.headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    /// The Control Plane's grant to write this Attempt's reserved Session checkpoint to its Tag's
    /// Volume, or to read the Session's current one. It names the bytes from its own records.
    async fn volume_grant(
        &self,
        attempt: &Attempt,
        token: &str,
        access: VolumeAccess,
    ) -> Result<VolumeObjectGrant, Status> {
        let request = VolumeObjectGrantRequest {
            attempt: Some(attempt.inspect()),
            access: access.into(),
            purpose: VolumeObjectPurpose::SessionCheckpoint.into(),
            ..Default::default()
        };
        Ok(self
            .volume_objects()
            .grant(authorized(request, token)?)
            .await?
            .into_inner())
    }

    pub(crate) fn with_storage(
        mut self,
        storage: crate::worklet::artifact_direct::SourceStorage,
    ) -> Self {
        self.storage = Some(storage);
        self
    }

    pub(crate) fn with_checkpoints(mut self, held: Held) -> Self {
        self.held = Some(held);
        self
    }

    fn host(
        &self,
    ) -> WorkerHostClient<tonic::service::interceptor::InterceptedService<Channel, HostHeaders>>
    {
        WorkerHostClient::with_interceptor(self.channel.clone(), self.headers.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    fn held(&self) -> Result<&Held, Status> {
        self.held
            .as_ref()
            .ok_or_else(|| Status::failed_precondition("this Worker Host keeps no checkpoints"))
    }

    /// Keeps the turn's checkpoint on this host, then records this host as its holder. The
    /// Control Plane never receives its bytes.
    pub async fn upload(
        &self,
        attempt: &Attempt,
        token: &str,
        checkpoint: SessionCheckpoint,
    ) -> Result<CheckpointReference, Status> {
        let held = self.held()?;
        let reference = checkpoint.reference();
        validate_checkpoint_reference(&reference)?;
        // A Tag that names a Volume keeps its checkpoints there, so any host that reaches the
        // Volume resumes them; otherwise this host keeps it.
        let on_volume = attempt.volume.is_some();
        let task = self
            .host()
            .inspect_attempt(authorized(attempt.inspect(), token)?)
            .await?
            .into_inner();
        if !on_volume {
            held.save(&task.tag_id, &task.session_id, &checkpoint)
                .map_err(|error| {
                    crate::failures::noted(
                        Status::internal("checkpoint could not be kept on this host"),
                        &error,
                    )
                })?;
        }
        let record = CommitCheckpointRequest {
            attempt: Some(attempt.inspect()),
            reference: Some(reference.clone()),
        };
        let reserved = self
            .host()
            .reserve_checkpoint(authorized(record.clone(), token)?)
            .await?
            .into_inner();
        // The reservation comes first: the Volume grant names the reserved checkpoint.
        if on_volume {
            let grant = self
                .volume_grant(attempt, token, VolumeAccess::Write)
                .await?;
            let volume = grant
                .volume
                .as_ref()
                .ok_or_else(|| Status::data_loss("Volume grant has no Volume"))?;
            let blob = grant
                .blob
                .as_ref()
                .ok_or_else(|| Status::data_loss("Volume grant has no object"))?;
            crate::worklet::volume_objects::put(
                &crate::worklet::volume_objects::ObjectGrant {
                    volume_id: &volume.volume_id,
                    source: &volume.source,
                    key: &grant.key,
                    blob,
                    presigned: grant.presigned.as_ref(),
                },
                &checkpoint.payload,
                &self.volumes,
            )
            .await?;
        }
        let committed = self
            .host()
            .commit_checkpoint(authorized(record, token)?)
            .await?
            .into_inner();
        if reserved != reference || committed != reference {
            return Err(Status::data_loss(
                "Control Plane returned a different checkpoint receipt",
            ));
        }
        if !on_volume {
            held.supersede(&task.tag_id, &task.session_id, &reference.sha256);
        }
        Ok(committed)
    }

    /// The Session's checkpoint, when this host holds it and its bytes match. A checkpoint
    /// another host holds, or a missing or changed file, starts the turn fresh from the recap.
    pub async fn download(
        &self,
        attempt: &Attempt,
        token: &str,
        (tag, session): (&str, &str),
    ) -> Result<Option<SessionCheckpoint>, Status> {
        let held = self.held()?;
        let mut upstream = authorized(attempt.inspect(), token)?;
        upstream.set_timeout(Duration::from_secs(20));
        let response = self.host().get_checkpoint(upstream).await?.into_inner();
        let Some(reference) = response.reference else {
            return Ok(None);
        };
        validate_checkpoint_reference(&reference)?;
        if !response.volume_id.is_empty() {
            return self.read_volume(attempt, token, reference).await;
        }
        if response.holder_host_id != held.host_id {
            supertag_protocol::terminal_text::warn(&format!(
                "Task {}: Worker Host {} holds the Session checkpoint, so this turn starts from the recap",
                attempt.task_id, response.holder_host_id
            ));
            return Ok(None);
        }
        let loaded = held.load(tag, session, &reference);
        if loaded.is_none() {
            supertag_protocol::terminal_text::warn(&format!(
                "Task {}: the Session checkpoint this host holds is missing or changed, so this turn starts from the recap",
                attempt.task_id
            ));
        }
        Ok(loaded)
    }

    /// The Session's checkpoint from its Tag's Volume. A checkpoint this host cannot reach, or
    /// whose bytes do not match, starts the turn fresh from the recap.
    async fn read_volume(
        &self,
        attempt: &Attempt,
        token: &str,
        reference: CheckpointReference,
    ) -> Result<Option<SessionCheckpoint>, Status> {
        let fresh = |why: &str| {
            supertag_protocol::terminal_text::warn(&format!(
                "Task {}: the Session checkpoint on its Volume {why}, so this turn starts from the recap",
                attempt.task_id
            ));
            Ok(None)
        };
        let grant = match self.volume_grant(attempt, token, VolumeAccess::Read).await {
            Ok(grant) => grant,
            Err(error)
                if matches!(
                    error.code(),
                    tonic::Code::NotFound | tonic::Code::FailedPrecondition
                ) =>
            {
                return fresh("is no longer current");
            }
            Err(error) => return Err(error),
        };
        let (Some(volume), Some(blob)) = (grant.volume.as_ref(), grant.blob.as_ref()) else {
            return Err(Status::data_loss("Volume grant is incomplete"));
        };
        let object = crate::worklet::volume_objects::ObjectGrant {
            volume_id: &volume.volume_id,
            source: &volume.source,
            key: &grant.key,
            blob,
            presigned: grant.presigned.as_ref(),
        };
        match crate::worklet::volume_objects::get(&object, &self.volumes).await {
            Ok(Some(payload)) => Ok(Some(SessionCheckpoint {
                harness: reference.harness,
                format: reference.format,
                sha256: reference.sha256,
                payload,
            })),
            Ok(None) => fresh("is missing or changed"),
            Err(error) if error.code() == tonic::Code::FailedPrecondition => {
                fresh("is out of this host's reach")
            }
            Err(error) => Err(error),
        }
    }

    /// Deletes the checkpoint files this host holds that no Session will resume.
    pub async fn reconcile(&self, token: &str) -> Result<usize, Status> {
        let held = self.held()?;
        let mut live = HashSet::new();
        let mut after = String::new();
        loop {
            let page = self
                .host()
                .list_held_checkpoints(authorized(
                    ListHeldCheckpointsRequest {
                        after_sha256: after.clone(),
                        limit: 0,
                    },
                    token,
                )?)
                .await?
                .into_inner();
            live.extend(page.sha256);
            match page.next_after_sha256 {
                Some(next) if next > after => after = next,
                _ => break,
            }
        }
        let held = held.clone();
        tokio::task::spawn_blocking(move || held.sweep(&live, SystemTime::now()))
            .await
            .map_err(|_| Status::internal("checkpoint sweep stopped"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkpoint(harness: &str, bytes: usize) -> SessionCheckpoint {
        SessionCheckpoint {
            harness: harness.into(),
            format: "fixture-v1".into(),
            sha256: "0".repeat(64),
            payload: vec![b' '; bytes],
        }
    }

    #[test]
    fn a_host_resumes_only_its_own_harness_checkpoints_that_can_still_grow() {
        let limit = MAX_RESUMED_CHECKPOINT_BYTES;
        assert!(resumable(HarnessKind::Codex, &checkpoint("codex", limit)));
        assert!(!resumable(
            HarnessKind::Codex,
            &checkpoint("codex", limit + 1)
        ));
        assert!(!resumable(
            HarnessKind::ClaudeCode,
            &checkpoint("codex", 10)
        ));
        assert!(resumable(
            HarnessKind::ClaudeCode,
            &checkpoint("claude-code", 10)
        ));
        // A custom adapter's host names no harness; its adapter decides.
        assert!(resumable(
            HarnessKind::Unspecified,
            &checkpoint("fixture", 10)
        ));
    }

    fn real(harness: &str, payload: &[u8]) -> SessionCheckpoint {
        SessionCheckpoint {
            harness: harness.into(),
            format: "fixture-v1".into(),
            sha256: format!("{:x}", Sha256::digest(payload)),
            payload: payload.to_vec(),
        }
    }

    #[test]
    fn a_host_keeps_each_sessions_checkpoint_privately_and_resumes_only_matching_bytes() {
        let state = tempfile::tempdir().unwrap();
        let held = Held::new(state.path(), "laptop");
        let first = real("codex", b"first transcript");
        held.save("tag", "session", &first).unwrap();
        // Hashed names: no Tag or Session ID appears in the path, and only the owner can read.
        let directory = held.directory("tag", "session");
        assert!(!directory.to_string_lossy().contains("session/"));
        assert!(directory.starts_with(tag_directory(state.path(), "tag")));
        let file = directory.join(format!("{}.bin", first.sha256));
        assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(&directory).unwrap().mode() & 0o777, 0o700);
        assert_eq!(
            held.load("tag", "session", &first.reference()),
            Some(first.clone())
        );
        // Another Session, or changed bytes, never resume.
        assert_eq!(held.load("tag", "other", &first.reference()), None);
        fs::write(&file, b"tampered transcript").unwrap();
        assert_eq!(held.load("tag", "session", &first.reference()), None);
        // A newer checkpoint supersedes the Session's older file.
        let second = real("codex", b"second transcript");
        held.save("tag", "session", &first).unwrap();
        held.save("tag", "session", &second).unwrap();
        held.supersede("tag", "session", &second.sha256);
        assert!(!file.exists());
        assert_eq!(
            held.load("tag", "session", &second.reference()),
            Some(second.clone())
        );
    }

    #[test]
    fn a_host_sweeps_files_no_session_resumes_or_too_old_but_never_a_fresh_one() {
        let state = tempfile::tempdir().unwrap();
        let held = Held::new(state.path(), "laptop");
        let live = real("codex", b"live transcript");
        let dropped = real("codex", b"dropped transcript");
        held.save("tag", "live", &live).unwrap();
        held.save("tag", "dropped", &dropped).unwrap();
        let listed = HashSet::from([live.sha256.clone()]);
        // Just written: nothing goes, whatever the listing says.
        assert_eq!(held.sweep(&listed, SystemTime::now()), 0);
        // Two hours on, the file no Session names goes; the live one stays.
        let later = SystemTime::now() + Duration::from_secs(2 * 60 * 60);
        assert_eq!(held.sweep(&listed, later), 1);
        assert!(held.load("tag", "live", &live.reference()).is_some());
        assert!(!held.directory("tag", "dropped").exists());
        // Fifteen days on, even a listed file goes: its Session went idle.
        let idle = SystemTime::now() + Duration::from_secs(15 * 24 * 60 * 60);
        assert_eq!(held.sweep(&listed, idle), 1);
        assert!(held.load("tag", "live", &live.reference()).is_none());
    }

    #[test]
    fn a_turn_keeps_no_checkpoint_too_big_to_resume() {
        let limit = MAX_RESUMED_CHECKPOINT_BYTES;
        assert!(kept(Some(checkpoint("codex", limit))).is_some());
        assert!(kept(Some(checkpoint("codex", limit + 1))).is_none());
        assert!(kept(None).is_none());
    }
}
