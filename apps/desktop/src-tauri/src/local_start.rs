//! Later launches: when this user's local SuperTag is set up (`supertag.yaml` in the state
//! directory) but its services are stopped, the app starts them with `supertag up` itself, then
//! connects. First-launch setup stays with the onboarding screens.
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

/// How long `supertag up` may take to report its services ready.
const UP_LIMIT: Duration = Duration::from_secs(180);

/// The `supertag` the app runs: the copy bundled beside the app's executable, else the first on
/// `path`, else where the installer links it (`installed`). An app opened from Finder gets only
/// the system PATH, which never holds the installer's `~/.local/bin`. Only an executable regular
/// file counts.
pub fn cli(bundled: Option<&Path>, path: Option<&OsStr>, installed: &[PathBuf]) -> Option<PathBuf> {
    if let Some(bundled) = bundled.filter(|candidate| executable(candidate)) {
        return Some(bundled.to_owned());
    }
    path.into_iter()
        .flat_map(std::env::split_paths)
        .chain(installed.iter().cloned())
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join("supertag"))
        .find(|candidate| executable(candidate))
}

/// Where the installer links `supertag`: `$XDG_BIN_HOME`, else `~/.local/bin`.
fn installer_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(bin) = std::env::var_os("XDG_BIN_HOME").filter(|bin| !bin.is_empty()) {
        directories.push(PathBuf::from(bin));
    }
    if let Some(home) = std::env::var_os("HOME").filter(|home| !home.is_empty()) {
        directories.push(PathBuf::from(home).join(".local/bin"));
    }
    directories
}

#[cfg(unix)]
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable(path: &Path) -> bool {
    path.is_file()
}

/// Whether the app should start the local services: SuperTag was set up in `state` (its
/// `supertag.yaml` exists) and no local Gateway runs from it.
pub fn should_start(state: Option<&Path>, running: bool) -> bool {
    !running && state.is_some_and(|state| state.join("supertag.yaml").is_file())
}

/// The copy of `supertag` bundled beside this app's executable, where Tauri puts its sidecars.
fn bundled() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.join("supertag"))
}

/// Starts the local services from `state` with `supertag up`. On failure, says what `up` printed
/// and where the logs are.
pub async fn start(state: &Path) -> Result<(), String> {
    // The services find the coding agents (claude, codex, node) on the PATH they start with, so
    // they need the user's shell PATH, not the bare one an app opened from Finder gets.
    let path = login_path()
        .await
        .or_else(|| std::env::var_os("PATH").map(|path| path.to_string_lossy().into_owned()));
    let cli = cli(
        bundled().as_deref(),
        path.as_deref().map(OsStr::new),
        &installer_directories(),
    )
    .ok_or(
        "Could not find the supertag command. Install it with the install script, then reopen the app.",
    )?;
    up(&cli, state, path.as_deref()).await
}

/// Marks the PATH a login shell prints, so what its startup files print around it is ignored.
const PATH_MARK: &str = "__SUPERTAG_PATH__";

/// The PATH the user's login shell sets up, or `None` when it can't be read in a few seconds.
async fn login_path() -> Option<String> {
    let shell = std::env::var_os("SHELL").filter(|shell| !shell.is_empty())?;
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(shell)
            .args([
                "-ilc",
                &format!("printf '{PATH_MARK}%s{PATH_MARK}' \"$PATH\""),
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    marked_path(&String::from_utf8_lossy(&output.stdout))
}

/// The PATH between the marks in a login shell's output.
fn marked_path(output: &str) -> Option<String> {
    let (_, rest) = output.split_once(PATH_MARK)?;
    let (path, _) = rest.split_once(PATH_MARK)?;
    (!path.trim().is_empty()).then(|| path.to_owned())
}

async fn up(cli: &Path, state: &Path, path: Option<&str>) -> Result<(), String> {
    let logs = state.join("logs");
    let failed = |detail: &str| {
        let detail = detail.trim();
        let detail = if detail.is_empty() {
            "supertag up stopped without saying why.".to_owned()
        } else {
            // Its last lines say why; earlier ones are progress.
            let lines: Vec<&str> = detail.lines().collect();
            lines[lines.len().saturating_sub(12)..].join("\n")
        };
        format!(
            "Could not start SuperTag:\n{detail}\nLogs: {}",
            logs.display()
        )
    };
    let mut command = tokio::process::Command::new(cli);
    command
        .arg("up")
        .arg("--state-directory")
        .arg(state)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = path {
        command.env("PATH", path);
    }
    let output = tokio::time::timeout(UP_LIMIT, command.output())
        .await
        .map_err(|_| failed("supertag up did not report its services ready in 3 minutes."))?
        .map_err(|error| failed(&format!("could not run {}: {error}", cli.display())))?;
    if output.status.success() {
        return Ok(());
    }
    Err(failed(&format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn tool(directory: &Path, name: &str, mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt as _;
        let path = directory.join(name);
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn the_bundled_cli_wins_and_path_is_the_fallback() {
        let root = tempfile::tempdir().unwrap();
        let (app, first, second) = (
            root.path().join("app"),
            root.path().join("first"),
            root.path().join("second"),
        );
        for directory in [&app, &first, &second] {
            std::fs::create_dir(directory).unwrap();
        }
        let bundled = tool(&app, "supertag", 0o755);
        tool(&first, "supertag", 0o644); // not executable
        let on_path = tool(&second, "supertag", 0o755);
        let path = std::env::join_paths([PathBuf::from("relative"), first.clone(), second.clone()])
            .unwrap();
        assert_eq!(cli(Some(&bundled), Some(&path), &[]), Some(bundled.clone()));
        assert_eq!(
            cli(Some(&app.join("missing")), Some(&path), &[]),
            Some(on_path.clone())
        );
        assert_eq!(cli(None, Some(&path), &[]), Some(on_path));
        assert_eq!(cli(None, Some(first.as_os_str()), &[]), None);
        assert_eq!(cli(None, None, &[]), None);
        // Opened from Finder, PATH lacks the installer's directory: it is looked in last.
        let installed = root.path().join("local-bin");
        std::fs::create_dir(&installed).unwrap();
        let linked = tool(&installed, "supertag", 0o755);
        assert_eq!(
            cli(
                None,
                Some(OsStr::new("/usr/bin:/bin")),
                std::slice::from_ref(&installed)
            ),
            Some(linked)
        );
        assert_eq!(
            cli(None, Some(&path), std::slice::from_ref(&installed)),
            Some(second.join("supertag"))
        );
    }

    #[test]
    fn the_login_shell_path_is_read_between_its_marks() {
        let printed =
            format!("motd line\n{PATH_MARK}/opt/homebrew/bin:/usr/bin{PATH_MARK}trailing");
        assert_eq!(
            marked_path(&printed).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(marked_path("no marks"), None);
        assert_eq!(marked_path(&format!("{PATH_MARK}{PATH_MARK}")), None);
    }

    #[test]
    fn starts_only_a_set_up_machine_whose_services_are_stopped() {
        let state = tempfile::tempdir().unwrap();
        // Nothing set up yet: first launch belongs to onboarding.
        assert!(!should_start(Some(state.path()), false));
        assert!(!should_start(None, false));
        std::fs::write(state.path().join("supertag.yaml"), "version: 1\n").unwrap();
        assert!(should_start(Some(state.path()), false));
        // Already running: just connect.
        assert!(!should_start(Some(state.path()), true));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_up_says_what_it_printed_and_where_the_logs_are() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("state");
        let failing = tool(root.path(), "failing", 0o755);
        std::fs::write(
            &failing,
            "#!/bin/sh\ntest \"$1 $2\" = 'up --state-directory' || exit 9\necho 'Starting SuperTag'\necho 'Error: Worker Host laptop lane 0 did not report readiness: no Node' >&2\nexit 1\n",
        )
        .unwrap();
        let error = up(&failing, &state, None).await.unwrap_err();
        assert!(
            error.contains("did not report readiness: no Node"),
            "{error}"
        );
        assert!(
            error.contains(&format!("Logs: {}", state.join("logs").display())),
            "{error}"
        );
        let working = tool(root.path(), "working", 0o755);
        std::fs::write(&working, "#!/bin/sh\ntest \"$1\" = up && echo ready\n").unwrap();
        assert_eq!(up(&working, &state, None).await, Ok(()));
    }
}
