//! The local read-only file copy placement contract.
use std::path::{Component, Path};
use tonic::Status;

use crate::{v2::*, volumes::file_volume_path};

pub const MAX_WORKSPACE_MOUNTS: usize = 8;
pub const MAX_WORKSPACE_MOUNT_BYTES: u64 = 256 * 1024 * 1024;

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
        file_volume_path(&item.source)?;
        if !volume_id(&item.volume_id) {
            return Err(Status::invalid_argument("invalid Workspace Volume ID"));
        }
    }
    Ok(())
}

pub fn supports(task: &Task, harness: HarnessKind, profile: &HarnessExecutionProfile) -> bool {
    let Some(spec) = task
        .workspace
        .as_ref()
        .filter(|spec| !spec.mounts.is_empty())
    else {
        return true;
    };
    matches!(harness, HarnessKind::Codex)
        && !profile.remote_file_workspace
        && profile.shared_execution.is_none()
        && spec.github_source.is_none()
        && task
            .allowed_actions
            .iter()
            .any(|action| action == "files:read")
        && !task.allowed_actions.iter().any(|action| {
            matches!(
                action.as_str(),
                "commands:execute" | "files:write" | "web:fetch"
            )
        })
        && spec.mounts.iter().all(|mount| {
            let Some(volume) = &mount.volume else {
                return false;
            };
            profile.workspace_mounts.iter().any(|item| {
                item.volume_id == mount.volume_id
                    && item.source == volume.source
                    && Path::new(&mount.destination).parent()
                        == Some(Path::new(&item.destination_root))
            })
        })
}
