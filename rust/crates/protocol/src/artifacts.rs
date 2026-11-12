use std::collections::BTreeSet;

use sha2::{Digest, Sha256};
use tonic::Status;

use crate::{
    v2::{ArtifactDescription, CommitArtifactCaptureRequest, HarnessCaptureArtifactRequest},
    valid_sha256,
};

pub const MAX_ARTIFACT_FILES: usize = 100;
pub const MAX_ARTIFACT_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;

pub fn managed_output_directory(attempt_id: &str) -> String {
    format!("outputs/{:x}", Sha256::digest(attempt_id.as_bytes()))
}

pub fn validate_capture_request(input: &HarnessCaptureArtifactRequest) -> Result<(), Status> {
    validate_metadata(
        &input.operation_id,
        input.description.as_ref(),
        input.native_session_id.as_deref(),
    )?;
    validate_paths(input.paths.iter().map(String::as_str))
}

pub fn validate_capture_manifest(input: &CommitArtifactCaptureRequest) -> Result<u64, Status> {
    validate_metadata(
        &input.operation_id,
        input.description.as_ref(),
        input.native_session_id.as_deref(),
    )?;
    let attempt = input
        .attempt
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("Attempt authority is required"))?;
    validate_paths(input.files.iter().map(|file| file.path.as_str()))?;
    if input.managed_task_output && input.declared_task_output {
        return Err(Status::invalid_argument(
            "artifact output modes are mutually exclusive",
        ));
    }
    if input.managed_task_output {
        let prefix = format!("{}/", managed_output_directory(&attempt.attempt_id));
        if input
            .files
            .iter()
            .any(|file| !file.path.starts_with(&prefix))
        {
            return Err(Status::invalid_argument(
                "managed output file is outside its Attempt directory",
            ));
        }
    }
    let mut total = 0;
    for file in &input.files {
        let blob = file
            .blob
            .as_ref()
            .filter(|blob| valid_sha256(&blob.sha256))
            .ok_or_else(|| {
                Status::invalid_argument("each artifact file requires a SHA-256 digest")
            })?;
        if blob.byte_length > MAX_ARTIFACT_FILE_BYTES {
            return Err(Status::resource_exhausted(
                "artifact file exceeds its size limit",
            ));
        }
        total += blob.byte_length;
        if total > MAX_ARTIFACT_BYTES {
            return Err(Status::resource_exhausted(
                "artifact exceeds its total size limit",
            ));
        }
    }
    Ok(total)
}

pub fn validate_artifact_path(path: &str) -> Result<(), Status> {
    if path.len() > 1024
        || path.contains(['\\', ':'])
        || path.chars().any(char::is_control)
        || path.split('/').any(|part| {
            matches!(part, "" | "." | "..")
                || part.eq_ignore_ascii_case(".git")
                || part.eq_ignore_ascii_case(".supertag")
        })
    {
        return Err(Status::invalid_argument(
            "artifact file path must be relative and canonical",
        ));
    }
    Ok(())
}

fn validate_paths<'a>(paths: impl ExactSizeIterator<Item = &'a str>) -> Result<(), Status> {
    if !(1..=MAX_ARTIFACT_FILES).contains(&paths.len()) {
        return Err(Status::invalid_argument(
            "artifact must select between 1 and 100 files",
        ));
    }
    let mut selected = BTreeSet::new();
    for path in paths {
        validate_artifact_path(path)?;
        if !selected.insert(path) {
            return Err(Status::invalid_argument("artifact paths must be unique"));
        }
    }
    for path in &selected {
        if path
            .match_indices('/')
            .any(|(separator, _)| selected.contains(&path[..separator]))
        {
            return Err(Status::invalid_argument("artifact paths must not overlap"));
        }
    }
    Ok(())
}

fn validate_metadata(
    operation_id: &str,
    description: Option<&ArtifactDescription>,
    native_session_id: Option<&str>,
) -> Result<(), Status> {
    let valid = |value: &str, limit| {
        !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
    };
    if !valid(operation_id, 256) {
        return Err(Status::invalid_argument(
            "artifact capture operation ID is required",
        ));
    }
    let description =
        description.ok_or_else(|| Status::invalid_argument("artifact description is required"))?;
    if !valid(&description.title, 200)
        || !valid(&description.kind, 64)
        || description
            .summary
            .as_ref()
            .is_some_and(|summary| summary.len() > 4096 || summary.contains('\0'))
        || native_session_id.is_some_and(|value| !valid(value, 256))
    {
        return Err(Status::invalid_argument(
            "artifact capture metadata is invalid",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v2::{ArtifactFile, BlobReference, InspectAttemptRequest};
    use tonic::Code;

    fn manifest(paths: &[&str], bytes: u64) -> CommitArtifactCaptureRequest {
        CommitArtifactCaptureRequest {
            operation_id: "capture-report".into(),
            attempt: Some(InspectAttemptRequest::default()),
            description: Some(ArtifactDescription {
                title: "Release report".into(),
                kind: "report".into(),
                summary: Some("Summary\nEvidence".into()),
            }),
            files: paths
                .iter()
                .map(|path| ArtifactFile {
                    path: (*path).into(),
                    blob: Some(BlobReference {
                        sha256: "a".repeat(64),
                        byte_length: bytes,
                    }),
                })
                .collect(),
            native_session_id: Some("native-session".into()),
            managed_task_output: false,
            declared_task_output: false,
        }
    }

    #[test]
    fn rejects_unsafe_duplicate_and_overlapping_paths_before_staging() {
        for paths in [
            vec![],
            vec!["/absolute"],
            vec!["../escape"],
            vec!["dir/../escape"],
            vec!["dir//file"],
            vec!["dir\\file"],
            vec!["dir/."],
            vec!["dir/"],
            vec!["C:file"],
            vec!["file\0name"],
            vec![".Git/config"],
            vec![".supertag/state"],
            vec!["dir/file", "dir/file"],
            vec!["dir", "dir-other/file", "dir/file"],
        ] {
            assert_eq!(
                validate_capture_manifest(&manifest(&paths, 1))
                    .unwrap_err()
                    .code(),
                Code::InvalidArgument,
                "{paths:?}"
            );
        }
    }

    #[test]
    fn checks_digest_and_size_limits_for_each_file_and_the_total() {
        let mut input = manifest(&["a", "b"], MAX_ARTIFACT_FILE_BYTES);
        assert_eq!(
            validate_capture_manifest(&input).unwrap(),
            MAX_ARTIFACT_BYTES
        );
        input.files[0].blob.as_mut().unwrap().sha256 = "bad-digest".into();
        assert_eq!(
            validate_capture_manifest(&input).unwrap_err().code(),
            Code::InvalidArgument
        );
        for input in [
            manifest(&["a"], MAX_ARTIFACT_FILE_BYTES + 1),
            manifest(&["a", "b", "c"], MAX_ARTIFACT_FILE_BYTES),
        ] {
            assert_eq!(
                validate_capture_manifest(&input).unwrap_err().code(),
                Code::ResourceExhausted
            );
        }
        assert_eq!(
            validate_capture_manifest(&manifest(&["empty.txt"], 0)).unwrap(),
            0
        );
    }
}
