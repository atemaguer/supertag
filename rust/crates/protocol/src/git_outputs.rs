use serde::Serialize;
use sha2::{Digest, Sha256};
use tonic::Status;

use crate::{
    artifacts::{MAX_ARTIFACT_FILES, validate_artifact_path},
    v2::{ArtifactFile, GitOutputSnapshot},
};

pub const MANIFEST_PATH: &str = "supertag-git-output.json";

pub fn remote_url(value: &str) -> Option<url::Url> {
    if value.len() > 1024 || value.chars().any(char::is_control) {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() == "/"
    {
        return None;
    }
    match url.scheme() {
        "https" if url.host_str().is_some() => Some(url),
        "file" if url.host_str().is_none() && url.to_file_path().is_ok() => Some(url),
        _ => None,
    }
}

fn valid_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate(snapshot: &GitOutputSnapshot) -> Result<(), Status> {
    if !valid_commit(&snapshot.start_commit)
        || !valid_commit(&snapshot.head_commit)
        || snapshot.start_commit.len() != snapshot.head_commit.len()
        || snapshot.tracked_paths.is_empty() && snapshot.deleted_paths.is_empty()
        || snapshot
            .remote
            .as_deref()
            .is_some_and(|value| remote_url(value).is_none_or(|url| url.as_str() != value))
        || snapshot.remote.is_none() && !snapshot.referenced_paths.is_empty()
    {
        return Err(Status::invalid_argument("invalid Git output snapshot"));
    }
    for paths in [
        &snapshot.tracked_paths,
        &snapshot.deleted_paths,
        &snapshot.referenced_paths,
    ] {
        if paths.len() > MAX_ARTIFACT_FILES || paths.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(Status::invalid_argument(
                "Git output snapshot paths must be sorted, unique, and bounded",
            ));
        }
        for path in paths {
            validate_artifact_path(path)?;
            if path == MANIFEST_PATH {
                return Err(Status::invalid_argument(
                    "Git output manifest path is reserved",
                ));
            }
        }
    }
    if snapshot
        .referenced_paths
        .iter()
        .any(|path| snapshot.tracked_paths.binary_search(path).is_err())
        || snapshot
            .deleted_paths
            .iter()
            .any(|path| snapshot.tracked_paths.binary_search(path).is_ok())
    {
        return Err(Status::invalid_argument(
            "Git output snapshot paths disagree",
        ));
    }
    Ok(())
}

pub fn render(snapshot: &GitOutputSnapshot) -> Result<Vec<u8>, Status> {
    validate(snapshot)?;
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Document<'a> {
        kind: &'static str,
        head: &'a str,
        base_commit: &'a str,
        repository_root: &'static str,
        paths: &'a [String],
        remote: Option<&'a str>,
        remote_durable: bool,
        referenced_paths: &'a [String],
        deleted: &'a [String],
        partial: bool,
    }
    serde_json::to_vec_pretty(&Document {
        kind: "selected-git-snapshot",
        head: &snapshot.head_commit,
        base_commit: &snapshot.start_commit,
        repository_root: "",
        paths: &snapshot.tracked_paths,
        remote: snapshot.remote.as_deref(),
        remote_durable: snapshot.remote.is_some(),
        referenced_paths: &snapshot.referenced_paths,
        deleted: &snapshot.deleted_paths,
        partial: true,
    })
    .map_err(|_| Status::internal("could not encode Git output snapshot"))
}

pub(crate) fn validate_file(
    file: &ArtifactFile,
    files: &[ArtifactFile],
    declared: bool,
) -> Result<(), Status> {
    let Some(snapshot) = &file.git_output else {
        return Ok(());
    };
    let bytes = render(snapshot)?;
    if !declared
        || file.path != MANIFEST_PATH
        || file.blob.as_ref().is_none_or(|blob| {
            blob.byte_length != bytes.len() as u64
                || blob.sha256 != format!("{:x}", Sha256::digest(&bytes))
        })
        || snapshot.tracked_paths.iter().any(|path| {
            let referenced = snapshot.referenced_paths.binary_search(path).is_ok();
            referenced == files.iter().any(|file| file.path == *path)
        })
        || snapshot
            .deleted_paths
            .iter()
            .any(|path| files.iter().any(|file| file.path == *path))
    {
        return Err(Status::invalid_argument(
            "Git output manifest differs from its file receipt",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v2::BlobReference;

    #[test]
    fn canonical_snapshot_cannot_claim_extra_paths_or_different_bytes() {
        let snapshot = GitOutputSnapshot {
            start_commit: "a".repeat(40),
            head_commit: "b".repeat(40),
            remote: Some("https://example.test/team/repo.git".into()),
            tracked_paths: vec!["clean".into(), "dirty".into()],
            deleted_paths: vec!["removed".into()],
            referenced_paths: vec!["clean".into()],
        };
        let bytes = render(&snapshot).unwrap();
        let mut file = ArtifactFile {
            path: MANIFEST_PATH.into(),
            blob: Some(BlobReference {
                byte_length: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)),
            }),
            git_output: Some(snapshot.clone()),
        };
        let dirty = ArtifactFile {
            path: "dirty".into(),
            ..Default::default()
        };
        assert!(validate_file(&file, std::slice::from_ref(&dirty), true).is_ok());
        assert!(validate_file(&file, &[], true).is_err());
        assert!(validate_file(&file, std::slice::from_ref(&dirty), false).is_err());
        file.blob.as_mut().unwrap().sha256 = "0".repeat(64);
        assert!(validate_file(&file, &[dirty], true).is_err());
        let mut forged = snapshot;
        forged.referenced_paths.push("not-selected".into());
        assert!(render(&forged).is_err());
        for unsafe_url in [
            "https://user:secret@example.test/team/repo.git",
            "https://example.test/team/repo.git?token=secret",
            "ext::anything",
            "file://different-host/path",
        ] {
            assert!(remote_url(unsafe_url).is_none());
        }
    }
}
