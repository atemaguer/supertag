//! A Tag's harness-native memory on its Volume.
//!
//! When the Tag names a Volume, its store lives there instead of on this host, so any host that
//! reaches the Volume uses it. Every object is immutable and named by its SHA-256: each memory
//! file, and a manifest that maps the store's paths to them. The Control Plane holds only the
//! store's head, the current manifest, which it hands out with the turn's grant. After the turn
//! the host merges the Attempt's copy onto the head file by file (as `native_memory::merge`
//! does on a host), writes the new objects, and moves the head by compare-and-set. If another
//! turn moved it first, the host merges onto that head and tries again, so no turn's memories are
//! lost and no reader sees a half-written store.
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use supertag_protocol::{
    authenticated_request,
    v2::{
        AdvanceNativeMemoryRequest, AssignedVolume, BlobReference, InspectAttemptRequest,
        NativeMemoryGrant, NativeMemoryVolumeHead, VolumeAccess, VolumeObjectGrantRequest,
        VolumeObjectPurpose, attempt_memory_client::AttemptMemoryClient,
        volume_objects_client::VolumeObjectsClient,
    },
};
use tonic::{service::interceptor::InterceptedService, transport::Channel};

use crate::{
    HostHeaders,
    worker::native_memory::{
        Files, check_caps, component, merge, private_directory, remove, snapshot, write_tree,
    },
};

/// How many times a turn merges onto a head another turn moved before giving up.
const ATTEMPTS: usize = 5;

type Objects = VolumeObjectsClient<InterceptedService<Channel, HostHeaders>>;
type Memory = AttemptMemoryClient<InterceptedService<Channel, HostHeaders>>;

/// What the host needs to reach the Tag's Volume for one Attempt.
#[derive(Clone)]
pub(crate) struct Access {
    pub objects: Objects,
    pub memory: Memory,
    pub token: String,
    pub attempt: InspectAttemptRequest,
    pub volume: AssignedVolume,
    pub volumes: crate::worklet::volume_objects::HostVolumes,
}

/// The manifest object: each path of the store and the object holding its bytes.
#[derive(Default, Serialize, Deserialize)]
struct Manifest {
    files: BTreeMap<String, Entry>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Entry {
    sha256: String,
    bytes: u64,
}

fn blob(bytes: &[u8]) -> BlobReference {
    BlobReference {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        byte_length: bytes.len() as u64,
    }
}

/// A store path is relative, `/`-separated, and stays inside the store.
fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && !part.contains('\0'))
}

impl Access {
    async fn grant(
        &self,
        blob: &BlobReference,
        access: VolumeAccess,
    ) -> Result<supertag_protocol::v2::VolumeObjectGrant> {
        let request = VolumeObjectGrantRequest {
            attempt: Some(self.attempt.clone()),
            purpose: VolumeObjectPurpose::NativeMemoryBlob.into(),
            access: access.into(),
            native_memory_blob: Some(blob.clone()),
            ..Default::default()
        };
        Ok(self
            .objects
            .clone()
            .grant(authenticated_request(request, &self.token, None)?)
            .await
            .map_err(|status| anyhow!("native memory Volume grant: {}", status.message()))?
            .into_inner())
    }

    fn object<'a>(
        &'a self,
        grant: &'a supertag_protocol::v2::VolumeObjectGrant,
        blob: &'a BlobReference,
    ) -> crate::worklet::volume_objects::ObjectGrant<'a> {
        crate::worklet::volume_objects::ObjectGrant {
            volume_id: &self.volume.volume_id,
            source: &self.volume.source,
            key: &grant.key,
            blob,
            presigned: grant.presigned.as_ref(),
        }
    }

    /// The object's verified bytes.
    async fn fetch(&self, blob: &BlobReference) -> Result<Vec<u8>> {
        let grant = self.grant(blob, VolumeAccess::Read).await?;
        crate::worklet::volume_objects::get(&self.object(&grant, blob), &self.volumes)
            .await
            .map_err(|status| anyhow!("{}", status.message()))?
            .ok_or_else(|| anyhow!("native memory object {} is missing or changed", blob.sha256))
    }

    /// Writes `bytes` as an object, unless it is already there.
    async fn store(&self, bytes: &[u8]) -> Result<BlobReference> {
        let reference = blob(bytes);
        let grant = self.grant(&reference, VolumeAccess::Write).await?;
        crate::worklet::volume_objects::put(&self.object(&grant, &reference), bytes, &self.volumes)
            .await
            .map_err(|status| anyhow!("{}", status.message()))?;
        Ok(reference)
    }

    /// The store's files at `head`; empty when it has none.
    async fn load(&self, head: Option<&NativeMemoryVolumeHead>) -> Result<(Files, Manifest)> {
        let Some(manifest) = head.and_then(|head| head.manifest.as_ref()) else {
            return Ok((Files::new(), Manifest::default()));
        };
        let manifest: Manifest = serde_json::from_slice(&self.fetch(manifest).await?)
            .context("native memory manifest is not valid")?;
        let mut files = Files::new();
        for (path, entry) in &manifest.files {
            ensure!(
                valid_path(path),
                "native memory manifest names an unsafe path"
            );
            let bytes = self
                .fetch(&BlobReference {
                    sha256: entry.sha256.clone(),
                    byte_length: entry.bytes,
                })
                .await?;
            files.insert(path.clone(), bytes);
        }
        check_caps(&files)?;
        Ok((files, manifest))
    }
}

/// An Attempt's copy of its store on the Tag's Volume.
pub(crate) struct Prepared {
    attempt: PathBuf,
    label: String,
    generation: u64,
    head: Option<NativeMemoryVolumeHead>,
    base: Files,
    manifest: Manifest,
}

impl Prepared {
    /// Reads the store at the grant's head into a fresh working copy in the lane's state.
    pub(crate) async fn prepare(
        access: &Access,
        state: &Path,
        attempt: &str,
        grant: &NativeMemoryGrant,
    ) -> Result<Self> {
        component("Attempt ID", attempt)?;
        let head = grant.volume_head.clone();
        let (base, manifest) = access.load(head.as_ref()).await?;
        let root = state.join("native-memory-attempts").join(attempt);
        let files = base.clone();
        let directory = root.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            remove(&directory)?;
            private_directory(&directory)?;
            write_tree(&directory.join("work"), &files)
        })
        .await??;
        Ok(Self {
            attempt: root,
            label: attempt.chars().take(8).collect(),
            generation: grant.reset_generation,
            head,
            base,
            manifest,
        })
    }

    /// The directory the harness reads and writes as its memory.
    pub(crate) fn working_directory(&self) -> PathBuf {
        self.attempt.join("work")
    }

    /// Merges the working copy onto the store's head, moves the head, and removes the copy. On an
    /// error the store keeps its head.
    pub(crate) async fn finish(self, access: &Access) -> Result<Option<NativeMemoryVolumeHead>> {
        let work = self.working_directory();
        let ours = tokio::task::spawn_blocking(move || snapshot(&work)).await?;
        let result = match ours {
            Ok(ours) => self.merge_back(access, ours).await,
            Err(error) => Err(error),
        };
        let attempt = self.attempt.clone();
        let removed = tokio::task::spawn_blocking(move || remove(&attempt)).await?;
        let summary = result?;
        removed?;
        Ok(summary)
    }

    async fn merge_back(
        &self,
        access: &Access,
        ours: Files,
    ) -> Result<Option<NativeMemoryVolumeHead>> {
        let mut head = self.head.clone();
        let mut theirs = self.base.clone();
        let mut known: BTreeMap<String, Entry> = self.manifest.files.clone();
        for _ in 0..ATTEMPTS {
            let merged = merge(&self.base, &ours, &theirs, &self.label);
            if merged == theirs {
                return Ok(head);
            }
            check_caps(&merged)?;
            let mut manifest = Manifest::default();
            for (path, bytes) in &merged {
                let reference = blob(bytes);
                let entry = Entry {
                    sha256: reference.sha256.clone(),
                    bytes: reference.byte_length,
                };
                // An object the store already names is on the Volume; write only the new ones.
                if !known.values().any(|known| known == &entry) {
                    access.store(bytes).await?;
                }
                manifest.files.insert(path.clone(), entry);
            }
            let manifest_bytes = serde_json::to_vec(&manifest)?;
            let manifest_blob = access.store(&manifest_bytes).await?;
            let request = AdvanceNativeMemoryRequest {
                attempt: Some(access.attempt.clone()),
                expected_revision: head.as_ref().map_or(0, |head| head.revision),
                manifest: Some(manifest_blob),
                files: merged.len() as u32,
                bytes: merged.values().map(|bytes| bytes.len() as u64).sum(),
                reset_generation: self.generation,
                // Each object once: the Control Plane deletes what the store no longer names.
                objects: manifest
                    .files
                    .values()
                    .map(|entry| (entry.sha256.clone(), entry.bytes))
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .map(|(sha256, byte_length)| BlobReference {
                        sha256,
                        byte_length,
                    })
                    .collect(),
            };
            let response = access
                .memory
                .clone()
                .advance_native(authenticated_request(request, &access.token, None)?)
                .await
                .map_err(|status| anyhow!("native memory head: {}", status.message()))?
                .into_inner();
            if response.advanced {
                return Ok(response.head);
            }
            // Another turn moved the head: merge onto what it holds now.
            head = response.head;
            let (files, current) = access.load(head.as_ref()).await?;
            theirs = files;
            known = current.files;
        }
        bail!("native memory head kept moving; this turn's changes were not kept")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_paths_stay_inside_the_store() {
        for good in ["MEMORY.md", "extensions/ad_hoc/notes/a.md"] {
            assert!(valid_path(good), "{good}");
        }
        for bad in ["", "/etc/passwd", "a//b", "../x", "a/./b", "a/../b", "a\0b"] {
            assert!(!valid_path(bad), "{bad:?}");
        }
    }

    #[test]
    fn manifests_are_stable_for_the_same_store() {
        let mut first = Manifest::default();
        let mut second = Manifest::default();
        for (path, sha) in [("b.md", "2"), ("a.md", "1")] {
            first.files.insert(
                path.into(),
                Entry {
                    sha256: sha.into(),
                    bytes: 1,
                },
            );
        }
        for (path, sha) in [("a.md", "1"), ("b.md", "2")] {
            second.files.insert(
                path.into(),
                Entry {
                    sha256: sha.into(),
                    bytes: 1,
                },
            );
        }
        assert_eq!(
            serde_json::to_vec(&first).unwrap(),
            serde_json::to_vec(&second).unwrap()
        );
    }
}
