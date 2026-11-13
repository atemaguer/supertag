//! Host services with state on this machine that supertag.yaml no longer names
//! (`tests/removed-host.test.ts`). `supertag up` removes such a host's state once its Worker Host
//! can no longer run work: it never enrolled, or it is revoked or gone. Until then the state,
//! including its credential, is kept and `up` names the command that retires it. Revoking stays
//! an explicit operator step because a revoked Worker Host ID is never enrolled again.
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::Deserialize;

/// What the Control Plane says of a removed host's Worker Host.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Registration {
    /// It may still run work.
    Active,
    /// Revoked, removed, or never registered: nothing can run as it.
    Retired,
}

#[derive(Deserialize)]
struct Enrollment {
    gateway: String,
    host_id: String,
}

/// The Gateway and Worker Host ID a host's state directory enrolled with, if it did.
fn enrollment(directory: &Path) -> Result<Option<Enrollment>> {
    let path = directory.join("enrollment.json");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("inspect its enrollment"),
        Ok(metadata) if !metadata.is_file() => anyhow::bail!("its enrollment is not a file"),
        Ok(_) => {}
    }
    let bytes = crate::local::read_private(&path).context("read its enrollment")?;
    Ok(Some(
        serde_json::from_str(&bytes).context("its enrollment is not valid")?,
    ))
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

/// Removes the state of every host service the file no longer names whose Worker Host cannot
/// run work, and returns a line for each removed or kept one. `local` is the local Gateway this
/// state directory's supervisor runs; `check` asks its Control Plane about a Worker Host.
pub(crate) async fn retire(
    state: &Path,
    configured: &BTreeSet<String>,
    local: Option<&str>,
    check: impl AsyncFn(&str) -> Result<Registration>,
) -> Result<Vec<String>> {
    let mut lines = Vec::new();
    for (name, directory) in removed(state, configured)? {
        let shown = directory.display();
        let gone = |reason: &str| {
            format!(
                "Removed host service {name}'s state ({shown}), since supertag.yaml no longer names it{reason}."
            )
        };
        let line = match enrollment(&directory) {
            Err(error) => format!(
                "Could not read host service {name}'s Worker Host enrollment ({error:#}), so its state ({shown}) was kept. Fix or remove that directory."
            ),
            Ok(None) => {
                fs::remove_dir_all(&directory)?;
                gone(" and it never enrolled")
            }
            Ok(Some(enrolled))
                if local.is_some_and(|local| same_origin(local, &enrolled.gateway)) =>
            {
                match check(&enrolled.host_id).await {
                    Ok(Registration::Retired) => {
                        fs::remove_dir_all(&directory)?;
                        gone(&format!(" and Worker Host {} is revoked", enrolled.host_id))
                    }
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
                enrolled.gateway.trim_end_matches('/'),
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

    fn enrolled(gateway: &str) -> String {
        format!(
            r#"{{"gateway":"{gateway}/","host_id":"old","operation_id":"o","token":"secret","receipt":{{"generation":1}}}}"#
        )
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
            Some((&enrolled("https://gateway.example"), 0o600)),
        );
        let configured = BTreeSet::new();
        let lines = retire(state.path(), &configured, Some(LOCAL), async |_: &str| {
            panic!("another Control Plane is never asked")
        })
        .await
        .unwrap();
        assert!(old.exists());
        assert!(
            lines[0].contains("enrolled with https://gateway.example: revoke it there"),
            "{lines:?}"
        );
    }

    #[tokio::test]
    async fn keeps_its_state_when_its_enrollment_cannot_be_read() {
        for (text, mode) in [("not json", 0o600), (enrolled(LOCAL).as_str(), 0o644)] {
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
