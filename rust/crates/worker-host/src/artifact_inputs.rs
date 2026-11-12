//! Local writes are journaled outside the native writable checkout. An uncertain
//! write is never repeated or redirected to a caller-selected destination.
use anyhow::{Context, Result, ensure};
use prost::Message;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    artifacts::{MAX_ARTIFACT_FILE_BYTES, materialized_artifact_directory},
    v2::*,
};
use tempfile::NamedTempFile;
use tonic::Status;

#[derive(Clone)]
pub(crate) struct Inputs {
    directory: PathBuf,
    root: Root,
}
#[derive(Clone, Serialize, Deserialize)]
struct Root {
    checkout: PathBuf,
    attempt: String,
    path: String,
    device: u64,
    inode: u64,
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn read(path: &Path) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file() && meta.nlink() == 1 && meta.len() <= MAX_MESSAGE_BYTES as u64,
        "invalid artifact input journal"
    );
    file.take(MAX_MESSAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_MESSAGE_BYTES,
        "input journal is too large"
    );
    Ok(bytes)
}
fn persist(directory: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let mut file = NamedTempFile::new_in(directory)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(directory.join(name))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}
impl Inputs {
    pub(crate) fn prepare_optional(
        state: &Path,
        attempt: &str,
        checkout: &Path,
    ) -> Result<Option<Self>> {
        match fs::symlink_metadata(checkout.join("inputs")) {
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Ok(None);
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Self::prepare(state, attempt, checkout).map(Some)
    }

    pub(crate) fn clear(state: &Path) -> Result<()> {
        match fs::remove_dir_all(state.join("artifact-inputs")) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn prepare(state: &Path, attempt: &str, checkout: &Path) -> Result<Self> {
        let directory = state.join("artifact-inputs").join(hash(attempt));
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)?;
        let root_path = directory.join("root.json");
        if root_path.try_exists()? {
            let root: Root = serde_json::from_slice(&read(&root_path)?)?;
            ensure!(
                root.attempt == attempt && root.checkout == checkout,
                "artifact input journal belongs to another checkout"
            );
            let result = Self { directory, root };
            result.verify_root()?;
            return Ok(result);
        }
        let path = format!("inputs/{}", hash(attempt));
        supertag_workspaces::create_output_directory(checkout, &path)?;
        let metadata = fs::symlink_metadata(checkout.join(&path))?;
        let root = Root {
            checkout: checkout.to_owned(),
            attempt: attempt.to_owned(),
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        persist(&directory, "root.json", &serde_json::to_vec(&root)?)?;
        Ok(Self { directory, root })
    }
    fn verify_root(&self) -> Result<()> {
        let parent = self.root.checkout.join("inputs");
        let parent = fs::symlink_metadata(parent)?;
        ensure!(
            parent.is_dir() && !parent.file_type().is_symlink(),
            "artifact input parent changed"
        );
        let meta = fs::symlink_metadata(self.root.checkout.join(&self.root.path))?;
        ensure!(
            meta.is_dir()
                && !meta.file_type().is_symlink()
                && meta.dev() == self.root.device
                && meta.ino() == self.root.inode,
            "artifact input directory changed"
        );
        Ok(())
    }
    fn selected<'a>(&self, receipt: &'a ArtifactAcquisition) -> Result<&'a str> {
        ensure!(
            receipt.attempt_id == self.root.attempt,
            "artifact Attempt mismatch"
        );
        let destination = receipt
            .destination
            .as_deref()
            .context("missing artifact input destination")?;
        ensure!(
            destination
                == materialized_artifact_directory(&self.root.attempt, &receipt.operation_id),
            "artifact destination mismatch"
        );
        Ok(destination)
    }
    pub(crate) fn replay(&self, receipt: &ArtifactAcquisition) -> Result<bool, Status> {
        self.replay_inner(receipt).map_err(|_| {
            Status::failed_precondition("artifact attachment has uncertain or changed local files")
        })
    }
    fn replay_inner(&self, receipt: &ArtifactAcquisition) -> Result<bool> {
        self.verify_root()?;
        let destination = self.selected(receipt)?;
        let key = hash(&receipt.operation_id);
        let done = self.directory.join(format!("{key}.done"));
        if done.try_exists()? {
            let prior = ArtifactAcquisition::decode(read(&done)?.as_slice())?;
            ensure!(
                prior.acquisition_id == receipt.acquisition_id && prior.files == receipt.files,
                "artifact attachment receipt differs"
            );
            for file in &receipt.files {
                let blob = file.blob.as_ref().context("missing blob")?;
                let bytes = supertag_workspaces::capture_artifact_file(
                    &self.root.checkout,
                    &format!("{destination}/{}", file.path),
                    MAX_ARTIFACT_FILE_BYTES as usize,
                )?;
                ensure!(
                    bytes.len() as u64 == blob.byte_length
                        && format!("{:x}", Sha256::digest(bytes)) == blob.sha256,
                    "artifact attachment changed"
                );
            }
            return Ok(true);
        }
        ensure!(
            !self.directory.join(format!("{key}.writing")).try_exists()?,
            "artifact write outcome is uncertain"
        );
        ensure!(
            !matches!(
                receipt.state(),
                ArtifactAcquisitionState::Delivered | ArtifactAcquisitionState::Uncertain
            ),
            "artifact local receipt is missing"
        );
        Ok(false)
    }
    pub(crate) fn materialize(
        &self,
        receipt: &ArtifactAcquisition,
        files: &[(String, Vec<u8>)],
    ) -> Result<(), Status> {
        self.materialize_inner(receipt, files).map_err(|_| {
            Status::failed_precondition("artifact attachment could not be written safely")
        })
    }
    fn materialize_inner(
        &self,
        receipt: &ArtifactAcquisition,
        files: &[(String, Vec<u8>)],
    ) -> Result<()> {
        ensure!(
            !self.replay_inner(receipt)?,
            "artifact attachment was already written"
        );
        let destination = self.selected(receipt)?;
        ensure!(
            files.len() == receipt.files.len(),
            "artifact file selection mismatch"
        );
        for ((path, bytes), file) in files.iter().zip(&receipt.files) {
            let blob = file.blob.as_ref().context("missing blob")?;
            ensure!(
                path == &file.path
                    && bytes.len() as u64 == blob.byte_length
                    && format!("{:x}", Sha256::digest(bytes)) == blob.sha256,
                "artifact file differs from receipt"
            );
        }
        let key = hash(&receipt.operation_id);
        persist(
            &self.directory,
            &format!("{key}.writing"),
            &receipt.encode_to_vec(),
        )?;
        supertag_workspaces::write_acquired_files(&self.root.checkout, destination, files)?;
        persist(
            &self.directory,
            &format!("{key}.done"),
            &receipt.encode_to_vec(),
        )?;
        Ok(())
    }
    pub(crate) fn cleanup(state: &Path, attempt: &str, checkout: &Path) -> Result<()> {
        let directory = state.join("artifact-inputs").join(hash(attempt));
        let root_path = directory.join("root.json");
        if !root_path.try_exists()? {
            return Ok(());
        }
        let root: Root = serde_json::from_slice(&read(&root_path)?)?;
        ensure!(
            root.attempt == attempt && root.checkout == checkout,
            "artifact input cleanup scope mismatch"
        );
        let inputs = Self { directory, root };
        if fs::symlink_metadata(checkout.join(&inputs.root.path))
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(());
        }
        inputs.verify_root()?;
        supertag_workspaces::remove_output_directory(checkout, &inputs.root.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Inputs, ArtifactAcquisition) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let state = root.join("state");
        let checkout = root.join("checkout");
        fs::create_dir(&state).unwrap();
        fs::create_dir(&checkout).unwrap();
        let inputs = Inputs::prepare(&state, "attempt", &checkout).unwrap();
        let receipt = ArtifactAcquisition {
            acquisition_id: "acquired".into(),
            attempt_id: "attempt".into(),
            operation_id: "op".into(),
            destination: Some(materialized_artifact_directory("attempt", "op")),
            files: vec![ArtifactFile {
                path: "nested/read.txt".into(),
                blob: Some(BlobReference {
                    sha256: format!("{:x}", Sha256::digest(b"hello")),
                    byte_length: 5,
                }),
            }],
            state: ArtifactAcquisitionState::Authorized as i32,
            ..Default::default()
        };
        (temp, inputs, receipt)
    }
    #[test]
    fn repository_input_file_disables_optional_attachment_without_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let checkout = root.join("checkout");
        let state = root.join("state");
        fs::create_dir(&checkout).unwrap();
        fs::create_dir(&state).unwrap();
        fs::write(checkout.join("inputs"), "repository content").unwrap();
        assert!(
            Inputs::prepare_optional(&state, "attempt", &checkout)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            fs::read_to_string(checkout.join("inputs")).unwrap(),
            "repository content"
        );
    }
    #[test]
    fn selected_files_replay_without_overwrite_and_cleanup() {
        let (_temp, inputs, receipt) = fixture();
        assert!(!inputs.replay(&receipt).unwrap());
        inputs
            .materialize(&receipt, &[("nested/read.txt".into(), b"hello".to_vec())])
            .unwrap();
        assert!(inputs.replay(&receipt).unwrap());
        assert!(
            inputs
                .materialize(&receipt, &[("nested/read.txt".into(), b"hello".to_vec())])
                .is_err()
        );
        Inputs::cleanup(
            inputs.directory.parent().unwrap().parent().unwrap(),
            "attempt",
            &inputs.root.checkout,
        )
        .unwrap();
        Inputs::cleanup(
            inputs.directory.parent().unwrap().parent().unwrap(),
            "attempt",
            &inputs.root.checkout,
        )
        .unwrap();
        assert!(!inputs.root.checkout.join(&inputs.root.path).exists());
    }
    #[test]
    fn uncertain_write_and_symlink_never_replayed() {
        let (_temp, inputs, receipt) = fixture();
        persist(
            &inputs.directory,
            &format!("{}.writing", hash("op")),
            &receipt.encode_to_vec(),
        )
        .unwrap();
        assert!(inputs.replay(&receipt).is_err());
        let outside = inputs.directory.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::remove_dir(inputs.root.checkout.join(&inputs.root.path)).unwrap();
        std::os::unix::fs::symlink(&outside, inputs.root.checkout.join(&inputs.root.path)).unwrap();
        assert!(inputs.materialize(&receipt, &[]).is_err());
        assert!(
            Inputs::cleanup(
                inputs.directory.parent().unwrap().parent().unwrap(),
                "attempt",
                &inputs.root.checkout
            )
            .is_err()
        );
        assert!(outside.exists());
    }
}
