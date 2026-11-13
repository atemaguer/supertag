//! The local Workspace copy placement contract.
use std::path::{Component, Path};
use tonic::Status;

use crate::{
    v2::*,
    volumes::{file_volume_path, s3_volume_source},
};

pub const MAX_WORKSPACE_MOUNTS: usize = 8;
pub const MAX_WORKSPACE_MOUNT_BYTES: u64 = 256 * 1024 * 1024;
/// Most files one copy may write back in one Attempt, as in TypeScript.
pub const MAX_WRITE_FILES: usize = 1_000;
/// Most bytes, as protobuf, one Attempt's write summaries may take.
pub const MAX_WRITES_BYTES: usize = 512 * 1024;
/// Longest Volume-relative key a copy may hold or write.
pub const MAX_KEY_BYTES: usize = 1024;

/// Credential names are labels Worker Hosts map to their own secrets.
pub fn credential_name(name: &str) -> bool {
    (1..=63).contains(&name.len())
        && name.as_bytes()[0].is_ascii_lowercase()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_".contains(&b))
}

/// A Workspace Volume source is a canonical file URL, or an S3 bucket and
/// prefix whose credential name each serving Worker Host maps.
pub fn validate_volume(source: &str, credential: &str) -> Result<(), Status> {
    if source.starts_with("s3://") {
        s3_volume_source(source)?;
        if !credential_name(credential) {
            return Err(Status::invalid_argument(
                "an s3:// Workspace Volume requires a credential name of 1-63 lowercase letters, digits, hyphens, or underscores",
            ));
        }
    } else {
        file_volume_path(source)?;
        if !credential.is_empty() {
            return Err(Status::invalid_argument(
                "a file:// Workspace Volume takes no credential; its Worker Host mapping is the consent",
            ));
        }
    }
    Ok(())
}

/// A Volume-relative key: `/`-separated normal names, no dot names that
/// SuperTag or Git reserve, no control characters.
pub fn volume_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_BYTES
        && !key.chars().any(char::is_control)
        && !key.contains('\\')
        && key.split('/').all(|part| {
            !matches!(part, "" | "." | "..") && part != ".git" && !part.starts_with(".supertag-")
        })
}

pub fn volume_id(id: &str) -> bool {
    (1..=63).contains(&id.len())
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_".contains(&b))
}

pub fn absolute_path(value: &str) -> Result<&Path, Status> {
    let invalid =
        || Status::invalid_argument("Workspace mount requires a normalized absolute path");
    if value.len() > 1024 || value.chars().any(char::is_control) || value.contains('\\') {
        return Err(invalid());
    }
    let path = Path::new(value);
    if !path.is_absolute()
        || path.components().count() < 2
        || !path
            .components()
            .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
        || path
            .components()
            .collect::<std::path::PathBuf>()
            .as_os_str()
            != path.as_os_str()
    {
        return Err(invalid());
    }
    for reserved in [
        "/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/dev",
        "/proc",
        "/sys",
        "/run",
        "/root",
        "/System",
        "/Library",
        "/private/etc",
        "/private/var/db",
        "/private/var/run",
        "/var/db",
        "/var/run",
        "/var/lib",
        "/var/log",
    ] {
        if overlaps(path, Path::new(reserved)) {
            return Err(Status::invalid_argument(
                "Workspace mount overlaps a protected system path",
            ));
        }
    }
    Ok(path)
}

pub fn overlaps(a: &Path, b: &Path) -> bool {
    if cfg!(target_os = "macos") {
        // Compare component boundaries and Unicode aliases on the usual macOS filesystem.
        use unicode_normalization::UnicodeNormalization;
        let fold = |path: &Path| {
            path.to_string_lossy()
                .to_lowercase()
                .nfc()
                .collect::<String>()
        };
        let a = fold(a);
        let b = fold(b);
        Path::new(&a).starts_with(&b) || Path::new(&b).starts_with(&a)
    } else {
        a.starts_with(b) || b.starts_with(a)
    }
}

pub fn normalize_mounts(mounts: &mut [WorkspaceCopyMount]) -> Result<(), Status> {
    if mounts.len() > MAX_WORKSPACE_MOUNTS {
        return Err(Status::invalid_argument("too many Workspace mounts"));
    }
    mounts.sort_unstable_by(|a, b| a.destination.cmp(&b.destination));
    let mut paths = Vec::new();
    let mut total = 0u64;
    for mount in mounts {
        let path = absolute_path(&mount.destination)?;
        // Dot names are configuration for tools that read the parent directory.
        if path
            .file_name()
            .is_none_or(|name| name.as_encoded_bytes().starts_with(b"."))
        {
            return Err(Status::invalid_argument(
                "Workspace mount destination cannot be a dot name",
            ));
        }
        total = total.saturating_add(mount.max_bytes);
        if !volume_id(&mount.volume_id)
            || !(1..=MAX_WORKSPACE_MOUNT_BYTES).contains(&mount.max_bytes)
            || total > MAX_WORKSPACE_MOUNT_BYTES
            || paths.iter().any(|&prior| overlaps(prior, path))
        {
            return Err(Status::invalid_argument(
                "invalid or overlapping Workspace mounts",
            ));
        }
        paths.push(path);
    }
    Ok(())
}

pub fn normalize_capabilities(items: &mut [WorkspaceMountCapability]) -> Result<(), Status> {
    if items.len() > 32 {
        return Err(Status::invalid_argument(
            "too many Workspace mount mappings",
        ));
    }
    items.sort_unstable_by(|a, b| a.volume_id.cmp(&b.volume_id));
    if items
        .windows(2)
        .any(|pair| pair[0].volume_id == pair[1].volume_id)
    {
        return Err(Status::invalid_argument(
            "duplicate Workspace mount mapping",
        ));
    }
    for item in items {
        absolute_path(&item.destination_root)?;
        validate_volume(&item.source, &item.credential)?;
        if !volume_id(&item.volume_id) {
            return Err(Status::invalid_argument("invalid Workspace Volume ID"));
        }
    }
    Ok(())
}

/// Harnesses whose local tools Worker Hosts confine to granted roots, so a
/// copy is readable and, when read-write, writable without other access.
pub fn mount_harness(harness: HarnessKind) -> bool {
    matches!(harness, HarnessKind::Codex | HarnessKind::ClaudeCode)
}

/// Copies need file reads, and every read-write copy needs file writes.
/// Commands and web access could reach data outside the granted roots.
pub fn mount_actions(mounts: &[WorkspaceCopyMount], allowed: &[String]) -> bool {
    let allows = |name: &str| allowed.iter().any(|action| action == name);
    allows("files:read")
        && !allows("commands:execute")
        && !allows("web:fetch")
        && mounts
            .iter()
            .all(|mount| !mount.read_write || allows("files:write"))
}

pub fn supports(task: &Task, harness: HarnessKind, profile: &HarnessExecutionProfile) -> bool {
    let Some(spec) = task
        .workspace
        .as_ref()
        .filter(|spec| !spec.mounts.is_empty())
    else {
        return true;
    };
    mount_harness(harness)
        && !profile.remote_file_workspace
        && profile.shared_execution.is_none()
        && spec.github_source.is_none()
        && mount_actions(&spec.mounts, &task.allowed_actions)
        && spec.mounts.iter().all(|mount| {
            let Some(volume) = &mount.volume else {
                return false;
            };
            profile.workspace_mounts.iter().any(|item| {
                item.volume_id == mount.volume_id
                    && item.source == volume.source
                    && item.credential == volume.credential
                    && Path::new(&mount.destination).parent()
                        == Some(Path::new(&item.destination_root))
            })
        })
}

/// Check a Worker Host's write summaries against the Attempt's read-write pins.
pub fn validate_writes(
    writes: &[WorkspaceMountWrite],
    mounts: &[WorkspaceCopyMount],
) -> Result<(), Status> {
    let invalid = |message: &str| Err(Status::invalid_argument(message.to_owned()));
    if prost::Message::encoded_len(&AttemptWorkspaceMountWrites {
        attempt_id: String::new(),
        writes: writes.to_vec(),
    }) > MAX_WRITES_BYTES
    {
        return invalid("Workspace mount writes exceed their size limit");
    }
    let mut seen = std::collections::BTreeSet::new();
    for write in writes {
        let Some(mount) = mounts
            .iter()
            .find(|mount| mount.read_write && mount.destination == write.destination)
        else {
            return invalid("Workspace mount write does not match a read-write copy");
        };
        if mount.volume_id != write.volume_id || !seen.insert(&write.destination) {
            return invalid("Workspace mount write does not match a read-write copy");
        }
        let status = WorkspaceMountWriteStatus::try_from(write.status)
            .unwrap_or(WorkspaceMountWriteStatus::Unspecified);
        let complete = status == WorkspaceMountWriteStatus::Complete;
        let reason_ok =
            write.error_reason.len() <= 256 && !write.error_reason.chars().any(char::is_control);
        let keys_ok = write
            .files
            .iter()
            .map(|file| file.key.as_str())
            .chain(write.not_attempted.iter().map(String::as_str))
            .all(volume_key)
            && write.files.iter().all(|file| {
                file.sha256.len() == 64
                    && file
                        .sha256
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            });
        if status == WorkspaceMountWriteStatus::Unspecified
            || write.files.len() > MAX_WRITE_FILES
            || write.not_attempted.len() > MAX_WRITE_FILES + 1
            || !keys_ok
            || !reason_ok
            || (complete
                && (!write.error_key.is_empty()
                    || !write.error_reason.is_empty()
                    || !write.not_attempted.is_empty()))
            || (!complete
                && (write.error_reason.is_empty()
                    || (status == WorkspaceMountWriteStatus::Partial
                        || !write.error_key.is_empty())
                        && !write.not_attempted.contains(&write.error_key)))
            || (status == WorkspaceMountWriteStatus::Refused && !write.files.is_empty())
        {
            return invalid("invalid Workspace mount write summary");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mount(read_write: bool) -> WorkspaceCopyMount {
        WorkspaceCopyMount {
            volume_id: "data".into(),
            destination: "/mnt/data".into(),
            max_bytes: 10,
            volume: None,
            read_write,
        }
    }

    fn write(status: WorkspaceMountWriteStatus) -> WorkspaceMountWrite {
        WorkspaceMountWrite {
            volume_id: "data".into(),
            destination: "/mnt/data".into(),
            status: status as i32,
            files: vec![WorkspaceMountWrittenFile {
                key: "a/b.txt".into(),
                size: 3,
                sha256: "a".repeat(64),
            }],
            ..Default::default()
        }
    }

    #[test]
    fn volumes_need_a_credential_name_exactly_for_object_stores() {
        assert!(validate_volume("s3://bucket-a/data", "team-data").is_ok());
        assert!(validate_volume("s3://bucket-a/data", "").is_err());
        assert!(validate_volume("s3://bucket-a/data", "Team").is_err());
        assert!(validate_volume("s3://bucket-a/data?region=x", "team").is_err());
        assert!(validate_volume("file:///srv/data", "").is_ok());
        assert!(validate_volume("file:///srv/data", "team").is_err());
        assert!(validate_volume("gs://bucket-a/data", "team").is_err());
    }

    #[test]
    fn actions_and_harnesses_bound_copies() {
        let read = |actions: &[&str]| actions.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert!(mount_actions(&[mount(false)], &read(&["files:read"])));
        assert!(mount_actions(
            &[mount(false)],
            &read(&["files:read", "files:write"])
        ));
        assert!(!mount_actions(&[mount(true)], &read(&["files:read"])));
        assert!(mount_actions(
            &[mount(true)],
            &read(&["files:read", "files:write"])
        ));
        assert!(!mount_actions(
            &[mount(true)],
            &read(&["files:read", "files:write", "commands:execute"])
        ));
        assert!(!mount_actions(
            &[mount(false)],
            &read(&["files:read", "web:fetch"])
        ));
        assert!(mount_harness(HarnessKind::Codex) && mount_harness(HarnessKind::ClaudeCode));
        assert!(!mount_harness(HarnessKind::Opencode) && !mount_harness(HarnessKind::Cursor));
    }

    #[test]
    fn write_summaries_match_read_write_pins_and_are_consistent() {
        let pins = [mount(true)];
        assert!(validate_writes(&[write(WorkspaceMountWriteStatus::Complete)], &pins).is_ok());
        assert!(
            validate_writes(
                &[write(WorkspaceMountWriteStatus::Complete)],
                &[mount(false)]
            )
            .is_err()
        );
        let mut twice = vec![write(WorkspaceMountWriteStatus::Complete)];
        twice.push(twice[0].clone());
        assert!(validate_writes(&twice, &pins).is_err());
        let mut partial = write(WorkspaceMountWriteStatus::Partial);
        assert!(validate_writes(std::slice::from_ref(&partial), &pins).is_err());
        partial.error_key = "c.txt".into();
        partial.error_reason = "write failed".into();
        partial.not_attempted = vec!["c.txt".into()];
        assert!(validate_writes(std::slice::from_ref(&partial), &pins).is_ok());
        let mut refused = partial.clone();
        refused.status = WorkspaceMountWriteStatus::Refused as i32;
        assert!(validate_writes(std::slice::from_ref(&refused), &pins).is_err());
        refused.files.clear();
        assert!(validate_writes(std::slice::from_ref(&refused), &pins).is_ok());
        // A refusal at the copy root names no key; a failed write always does.
        refused.error_key.clear();
        assert!(validate_writes(std::slice::from_ref(&refused), &pins).is_ok());
        let mut unnamed = refused.clone();
        unnamed.status = WorkspaceMountWriteStatus::Partial as i32;
        assert!(validate_writes(&[unnamed], &pins).is_err());
        for key in [
            "",
            "../x",
            "a//b",
            ".git/config",
            "a/.supertag-x",
            "a\nb",
            "/abs",
        ] {
            let mut bad = write(WorkspaceMountWriteStatus::Complete);
            bad.files[0].key = key.into();
            assert!(validate_writes(&[bad], &pins).is_err(), "{key:?}");
        }
        let mut bad = write(WorkspaceMountWriteStatus::Complete);
        bad.files[0].sha256 = "A".repeat(64);
        assert!(validate_writes(&[bad], &pins).is_err());
    }
}
