//! Host services with state on this machine that supertag.yaml no longer names
//! (`tests/removed-host.test.ts`). `supertag up` removes such a host's state once its Worker Host
//! can no longer run work: it never enrolled, or it is revoked or gone. Until then the state,
//! including its credential, is kept and `up` names the command that retires it. Revoking stays
//! an explicit operator step because a revoked Worker Host ID is never enrolled again.
//!
//! A host's `artifacts` directory is never removed while it holds bytes: it is the only copy of
//! the artifacts and Workspace deliveries the host produced, which the Control Plane does not
//! store. `up` keeps it, says so each time, and leaves deleting it to the operator.
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};

/// What the Control Plane says of a removed host's Worker Host.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Registration {
    /// It may still run work.
    Active,
    /// Revoked, removed, or never registered: nothing can run as it.
    Retired,
}

/// The Control Plane and Worker Host ID a host's state directory enrolled with, read from the
/// enrollment the Worker Host itself writes.
struct Enrollment {
    control_plane: String,
    host_id: String,
}

/// The enrollment a host's state directory holds, if it enrolled.
fn enrollment(directory: &Path) -> Result<Option<Enrollment>> {
    let path = directory.join("enrollment.json");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("inspect its enrollment"),
        Ok(metadata) if !metadata.is_file() => anyhow::bail!("its enrollment is not a file"),
        Ok(_) => {}
    }
    let (control_plane, host_id) = supertag_worker_host::enrolled_host(directory)
        .context("its enrollment is not valid")?
        .context("its enrollment disappeared")?;
    Ok(Some(Enrollment {
        control_plane,
        host_id,
    }))
}

fn same_origin(left: &str, right: &str) -> bool {
    left.trim_end_matches('/') == right.trim_end_matches('/')
}

/// Host state directories under `state/hosts` that no configured host names.
fn removed(state: &Path, configured: &BTreeSet<String>) -> Result<Vec<(String, PathBuf)>> {
    let mut removed = Vec::new();
    match fs::read_dir(state.join("hosts")) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type()?.is_dir() && !configured.contains(&name) {
                    removed.push((name, entry.path()));
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    removed.sort();
    Ok(removed)
}

/// Whether a host's artifact storage holds any Task Attempt's bytes.
fn holds_bytes(artifacts: &Path) -> Result<bool> {
    let entries = match fs::read_dir(artifacts) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => return Ok(false),
        entries => entries?,
    };
    for entry in entries {
        if entry?.file_name().to_string_lossy().starts_with("attempt-") {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Removes a retired host's state except an artifact storage that holds bytes, and returns that
/// kept storage.
fn remove_state(directory: &Path) -> Result<Option<PathBuf>> {
    let artifacts = directory.join("artifacts");
    if !holds_bytes(&artifacts)? {
        fs::remove_dir_all(directory)?;
        return Ok(None);
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_name() == "artifacts" {
            continue;
        }
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(Some(artifacts))
}

/// The line for a retired host's removed state.
fn removed_line(name: &str, directory: &Path, reason: &str, kept: Option<PathBuf>) -> String {
    let shown = directory.display();
    match kept {
        None => format!(
            "Removed host service {name}'s state ({shown}), since supertag.yaml no longer names it{reason}."
        ),
        Some(artifacts) => format!(
            "Removed host service {name}'s state ({shown}), since supertag.yaml no longer names it{reason}, but kept its artifact storage ({}). It holds the only copy of the artifacts and Workspace deliveries that host produced, which no Worker Host can serve any more; delete that directory once nothing needs them.",
            artifacts.display()
        ),
    }
}

/// Removes the state of every host service the file no longer names whose Worker Host cannot
/// run work, and returns a line for each removed or kept one. `local` is the local Control Plane
/// this state directory's supervisor runs; `check` asks it about a Worker Host.
pub(crate) async fn retire(
    state: &Path,
    configured: &BTreeSet<String>,
    local: Option<&str>,
    check: impl AsyncFn(&str) -> Result<Registration>,
) -> Result<Vec<String>> {
    let mut lines = Vec::new();
    for (name, directory) in removed(state, configured)? {
        let shown = directory.display();
        let artifacts = directory.join("artifacts");
        if fs::read_dir(&directory)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<std::io::Result<Vec<_>>>()?
            == ["artifacts"]
            && holds_bytes(&artifacts)?
        {
            // An earlier `up` removed the rest of this retired host's state.
            lines.push(crate::terminal::text(&format!(
                "Kept removed host service {name}'s artifact storage ({}). It holds the only copy of the artifacts and Workspace deliveries that host produced; delete that directory once nothing needs them.",
                artifacts.display()
            )));
            continue;
        }
        let line = match enrollment(&directory) {
            Err(error) => format!(
                "Could not read host service {name}'s Worker Host enrollment ({error:#}), so its state ({shown}) was kept. Fix or remove that directory."
            ),
            Ok(None) => removed_line(
                &name,
                &directory,
                " and it never enrolled",
                remove_state(&directory)?,
            ),
            Ok(Some(enrolled))
                if local.is_some_and(|local| same_origin(local, &enrolled.control_plane)) =>
            {
                match check(&enrolled.host_id).await {
                    Ok(Registration::Retired) => removed_line(
                        &name,
                        &directory,
                        &format!(" and Worker Host {} is revoked", enrolled.host_id),
                        remove_state(&directory)?,
                    ),
                    Ok(Registration::Active) => format!(
                        "Host service {name} is no longer in supertag.yaml, but Worker Host {} is still enrolled. Retire it with supertag host revoke {} --state-directory {}; the next supertag up then removes its state ({shown}).",
                        enrolled.host_id,
                        enrolled.host_id,
                        state.display()
                    ),
                    Err(error) => format!(
                        "Could not check Worker Host {} of removed host service {name} ({error:#}), so its state ({shown}) was kept. Run supertag up again once its Control Plane runs.",
                        enrolled.host_id
                    ),
                }
            }
            Ok(Some(enrolled)) => format!(
                "Host service {name} is no longer in supertag.yaml. Its Worker Host {} is enrolled with {}: revoke it there with supertag host revoke {}, then remove its state ({shown}).",
                enrolled.host_id,
                enrolled.control_plane.trim_end_matches('/'),
                enrolled.host_id
            ),
        };
        lines.push(crate::terminal::text(&line));
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    const LOCAL: &str = "http://127.0.0.1:3434";

    fn host(state: &Path, name: &str, enrollment: Option<(&str, u32)>) -> PathBuf {
        let directory = state.join("hosts").join(name);
        fs::create_dir_all(directory.join("lanes")).unwrap();
        if let Some((text, mode)) = enrollment {
            let path = directory.join("enrollment.json");
            fs::write(&path, text).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        }
        directory
    }

    /// The enrollment a Worker Host writes once `old` enrolled with `control_plane`, under
    /// `enrolled_name` when a reusable Auth Key suffixed it.
    fn enrolled_as(control_plane: &str, enrolled_name: Option<&str>) -> String {
        let mut state = serde_json::json!({
            "control_plane": format!("{control_plane}/"),
            "role": "host",
            "name": "old",
            "operation_id": "o",
            "token": "secret",
            "revision": 1,
        });
        if let Some(name) = enrolled_name {
            state["enrolled_name"] = name.into();
        }
        state.to_string()
    }

    fn enrolled(control_plane: &str) -> String {
        enrolled_as(control_plane, None)
    }

    async fn run(state: &Path, registration: Result<Registration>) -> Vec<String> {
        let configured = BTreeSet::from(["laptop".to_owned()]);
        let answer = std::sync::Mutex::new(Some(registration));
        retire(state, &configured, Some(LOCAL), async |id: &str| {
            assert_eq!(id, "old");
            answer.lock().unwrap().take().expect("asked once")
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn removes_state_without_a_credential_and_keeps_configured_hosts() {
        let state = tempfile::tempdir().unwrap();
        let kept = host(state.path(), "laptop", None);
        let old = host(state.path(), "old", None);
        let lines = run(state.path(), Ok(Registration::Active)).await;
        assert!(!old.exists());
        assert!(kept.exists());
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].contains("Removed host service old's state"),
            "{lines:?}"
        );
    }

    #[tokio::test]
    async fn keeps_an_enrolled_host_until_it_is_revoked() {
        let state = tempfile::tempdir().unwrap();
        let old = host(state.path(), "old", Some((&enrolled(LOCAL), 0o600)));
        let lines = run(state.path(), Ok(Registration::Active)).await;
        assert!(old.join("enrollment.json").exists());
        assert!(
            lines[0].contains(&format!(
                "Retire it with supertag host revoke old --state-directory {}",
                state.path().display()
            )),
            "{lines:?}"
        );
        let lines = run(state.path(), Ok(Registration::Retired)).await;
        assert!(!old.exists());
        assert!(lines[0].contains("Worker Host old is revoked"), "{lines:?}");
    }

    #[tokio::test]
    async fn keeps_the_artifact_storage_of_a_retired_host() {
        let state = tempfile::tempdir().unwrap();
        let old = host(state.path(), "old", Some((&enrolled(LOCAL), 0o600)));
        let held = old.join("artifacts").join("attempt-1");
        fs::create_dir_all(&held).unwrap();
        fs::write(held.join("0".repeat(64)), b"the only copy").unwrap();
        let lines = run(state.path(), Ok(Registration::Retired)).await;
        assert!(held.join("0".repeat(64)).exists());
        assert!(!old.join("enrollment.json").exists() && !old.join("lanes").exists());
        assert!(
            lines[0].contains("Worker Host old is revoked")
                && lines[0].contains("kept its artifact storage")
                && lines[0].contains("only copy of the artifacts and Workspace deliveries"),
            "{lines:?}"
        );
        // Later runs keep saying so, and never remove it.
        let configured = BTreeSet::new();
        let lines = retire(state.path(), &configured, Some(LOCAL), async |_: &str| {
            panic!("a host with only artifact storage left is never checked")
        })
        .await
        .unwrap();
        assert!(held.join("0".repeat(64)).exists());
        assert!(
            lines[0].contains("Kept removed host service old's artifact storage"),
            "{lines:?}"
        );
        // Storage that holds no bytes is removed with the rest.
        let empty = host(state.path(), "empty", None);
        fs::create_dir_all(empty.join("artifacts")).unwrap();
        fs::write(empty.join("artifacts").join("storage-id"), b"id").unwrap();
        retire(state.path(), &configured, Some(LOCAL), async |_: &str| {
            panic!("never enrolled")
        })
        .await
        .unwrap();
        assert!(!empty.exists());
    }

    #[tokio::test]
    async fn checks_the_worker_host_id_a_reusable_key_enrolled() {
        let state = tempfile::tempdir().unwrap();
        let old = host(
            state.path(),
            "old",
            Some((&enrolled_as(LOCAL, Some("old-2")), 0o600)),
        );
        let configured = BTreeSet::new();
        let lines = retire(state.path(), &configured, Some(LOCAL), async |id: &str| {
            assert_eq!(id, "old-2");
            Ok(Registration::Active)
        })
        .await
        .unwrap();
        assert!(old.join("enrollment.json").exists());
        assert!(
            lines[0].contains("Worker Host old-2 is still enrolled"),
            "{lines:?}"
        );
    }

    #[tokio::test]
    async fn keeps_its_state_when_its_control_plane_cannot_answer() {
        let state = tempfile::tempdir().unwrap();
        let old = host(state.path(), "old", Some((&enrolled(LOCAL), 0o600)));
        let lines = run(state.path(), Err(anyhow::anyhow!("connection refused"))).await;
        assert!(old.join("enrollment.json").exists());
        assert!(
            lines[0].contains("Could not check Worker Host old"),
            "{lines:?}"
        );
        assert!(lines[0].contains("connection refused"), "{lines:?}");
    }

    #[tokio::test]
    async fn keeps_a_host_enrolled_with_another_control_plane() {
        let state = tempfile::tempdir().unwrap();
        let old = host(
            state.path(),
            "old",
            Some((&enrolled("https://control-plane.example"), 0o600)),
        );
        let configured = BTreeSet::new();
        let lines = retire(state.path(), &configured, Some(LOCAL), async |_: &str| {
            panic!("another Control Plane is never asked")
        })
        .await
        .unwrap();
        assert!(old.exists());
        assert!(
            lines[0].contains("enrolled with https://control-plane.example: revoke it there"),
            "{lines:?}"
        );
    }

    #[tokio::test]
    async fn keeps_its_state_when_its_enrollment_cannot_be_read() {
        let gateway = enrolled(LOCAL).replace(r#""role":"host""#, r#""role":"gateway""#);
        for (text, mode) in [
            ("not json", 0o600),
            (enrolled(LOCAL).as_str(), 0o644),
            (gateway.as_str(), 0o600),
        ] {
            let state = tempfile::tempdir().unwrap();
            let old = host(state.path(), "old", Some((text, mode)));
            let configured = BTreeSet::new();
            let lines = retire(state.path(), &configured, Some(LOCAL), async |_: &str| {
                panic!("an unreadable enrollment is never checked")
            })
            .await
            .unwrap();
            assert!(old.join("enrollment.json").exists());
            assert!(
                lines[0].contains("Could not read host service old's Worker Host enrollment"),
                "{lines:?}"
            );
        }
    }
}
