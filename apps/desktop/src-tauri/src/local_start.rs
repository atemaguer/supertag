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
/// How long `supertag down` may take: it waits up to five minutes for running Task Attempts.
const DOWN_LIMIT: Duration = Duration::from_secs(360);

/// The command that installs or updates the `supertag` CLI.
pub const INSTALL_COMMAND: &str =
    "curl -fsSL https://github.com/atemaguer/supertag/releases/latest/download/install.sh | sh";

/// The version of SuperTag this app belongs to; the CLI it runs must match it.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The version `cli --version` reports (`supertag X`), or `None` when it says nothing usable in
/// a few seconds.
pub async fn cli_version(cli: &Path) -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new(cli)
            .arg("--version")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_version(&String::from_utf8_lossy(&output.stdout))
}

fn parse_version(printed: &str) -> Option<String> {
    let version = printed.trim().strip_prefix("supertag ")?.trim();
    (!version.is_empty() && !version.contains(char::is_whitespace)).then(|| version.to_owned())
}

/// What to tell the person when the CLI is another version than the app's, else `None`. A CLI
/// whose version can't be read counts as another version.
pub fn version_mismatch(cli_version: Option<&str>, app_version: &str) -> Option<String> {
    if cli_version == Some(app_version) {
        return None;
    }
    let cli_version = cli_version.unwrap_or("an unknown version");
    Some(format!(
        "This SuperTag CLI is {cli_version}, the app expects {app_version}. Update with: {INSTALL_COMMAND}"
    ))
}

/// The `supertag` the app runs: the copy bundled beside the app's executable, else the first on
/// `path`, else where the installer links it (`installed`). An app opened from Finder gets only
/// the system PATH, which never holds the installer's `~/.local/bin`. Only an executable regular
/// file counts.
pub fn cli(bundled: Option<&Path>, path: Option<&OsStr>, installed: &[PathBuf]) -> Option<PathBuf> {
    // The app itself never counts, whatever its name: running it as the CLI would start the app.
    let usable = |candidate: &Path| executable(candidate) && !is_this_app(candidate);
    if let Some(bundled) = bundled.filter(|candidate| usable(candidate)) {
        return Some(bundled.to_owned());
    }
    path.into_iter()
        .flat_map(std::env::split_paths)
        .chain(installed.iter().cloned())
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join("supertag"))
        .find(|candidate| usable(candidate))
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

/// The copy of `supertag` bundled in this app's resources (`Contents/Resources/supertag/` on
/// macOS), in the release archive's layout. Never beside the app's own executable: macOS file
/// systems ignore case, so `Contents/MacOS/supertag` is the app itself, `SuperTag`, and running
/// it as the CLI started the app again, which ran itself again.
fn bundled() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(
        exe.parent()?
            .parent()?
            .join("Resources")
            .join("supertag")
            .join("supertag"),
    )
}

/// Whether `candidate` is the running app's own executable, by file identity, whatever its name.
#[cfg(unix)]
fn is_this_app(candidate: &Path) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    let (Ok(exe), Ok(candidate)) = (
        std::env::current_exe().and_then(std::fs::metadata),
        std::fs::metadata(candidate),
    ) else {
        return false;
    };
    exe.dev() == candidate.dev() && exe.ino() == candidate.ino()
}

#[cfg(not(unix))]
fn is_this_app(_: &Path) -> bool {
    false
}

/// Starts the local services from `state` with `supertag up`. On failure, says what `up` printed
/// and where the logs are.
pub async fn start(state: &Path) -> Result<(), String> {
    let (cli, path) = usable_cli().await?;
    up(&cli, state, path.as_deref()).await
}

/// The `supertag` the app would run and the PATH it runs with, or what is wrong with it: none is
/// installed, or it is another version than the app's. Onboarding asks this before it sets
/// SuperTag up, and `start` before `up`.
pub async fn usable_cli() -> Result<(PathBuf, Option<String>), String> {
    let (cli, path) = environment().await;
    let cli = cli.ok_or(format!(
        "Could not find the supertag command. Install it with: {INSTALL_COMMAND}"
    ))?;
    // A CLI of another version may not read this state, or may migrate it under the app.
    if let Some(mismatch) = version_mismatch(cli_version(&cli).await.as_deref(), APP_VERSION) {
        return Err(format!("{mismatch}\n(It is {}.)", cli.display()));
    }
    Ok((cli, path))
}

/// The `supertag` the app runs, if any, and the PATH to run it and anything it starts with: the
/// user's login shell's, else the app's own. The services find the coding agents (claude, codex,
/// node) on that PATH, which an app opened from Finder lacks.
pub async fn environment() -> (Option<PathBuf>, Option<String>) {
    let path = login_path()
        .await
        .or_else(|| std::env::var_os("PATH").map(|path| path.to_string_lossy().into_owned()));
    let cli = cli(
        bundled().as_deref(),
        path.as_deref().map(OsStr::new),
        &installer_directories(),
    );
    (cli, path)
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

/// What the app reports while it restarts the local services with its own CLI.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RestartStep {
    /// `supertag down` is stopping the services that run now.
    Stopping,
    /// `supertag up` is starting them again with this app's CLI, migrating the database.
    Starting,
}

/// Restarts the local services from `state` with the app's own CLI: `supertag down`, then
/// `supertag up`, which migrates the database. `step` hears each step as it begins. On failure,
/// says what the CLI printed and where the logs are.
pub async fn restart(state: &Path, step: impl Fn(RestartStep)) -> Result<(), String> {
    let (cli, path) = usable_cli().await?;
    restart_with(&cli, state, path.as_deref(), step).await
}

async fn restart_with(
    cli: &Path,
    state: &Path,
    path: Option<&str>,
    step: impl Fn(RestartStep),
) -> Result<(), String> {
    step(RestartStep::Stopping);
    run(cli, Verb::Down, state, path).await?;
    step(RestartStep::Starting);
    up(cli, state, path).await
}

#[derive(Clone, Copy)]
enum Verb {
    Up,
    Down,
}

impl Verb {
    fn name(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
        }
    }

    fn failure(self) -> &'static str {
        match self {
            Self::Up => "Could not start SuperTag",
            Self::Down => "Could not stop SuperTag",
        }
    }

    /// What it says when it outlasts its limit.
    fn timed_out(self) -> &'static str {
        match self {
            Self::Up => "supertag up did not report its services ready in 3 minutes.",
            Self::Down => "supertag down did not stop the services in 6 minutes.",
        }
    }

    fn limit(self) -> Duration {
        match self {
            Self::Up => UP_LIMIT,
            Self::Down => DOWN_LIMIT,
        }
    }
}

async fn up(cli: &Path, state: &Path, path: Option<&str>) -> Result<(), String> {
    run(cli, Verb::Up, state, path).await
}

/// Runs `supertag VERB --state-directory STATE`.
async fn run(cli: &Path, verb: Verb, state: &Path, path: Option<&str>) -> Result<(), String> {
    let logs = state.join("logs");
    let failed = |detail: &str| {
        let detail = detail.trim();
        let detail = if detail.is_empty() {
            format!("supertag {} stopped without saying why.", verb.name())
        } else {
            // Its last lines say why; earlier ones are progress.
            let lines: Vec<&str> = detail.lines().collect();
            lines[lines.len().saturating_sub(12)..].join("\n")
        };
        format!("{}:\n{detail}\nLogs: {}", verb.failure(), logs.display())
    };
    let mut command = tokio::process::Command::new(cli);
    command
        .arg(verb.name())
        .arg("--state-directory")
        .arg(state)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = path {
        command.env("PATH", path);
    }
    let output = tokio::time::timeout(verb.limit(), command.output())
        .await
        .map_err(|_| failed(verb.timed_out()))?
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
    fn another_cli_version_is_named_with_the_update_command() {
        assert_eq!(parse_version("supertag 0.3.0\n").as_deref(), Some("0.3.0"));
        assert_eq!(parse_version("something else"), None);
        assert_eq!(version_mismatch(Some("0.3.0"), "0.3.0"), None);
        let older = version_mismatch(Some("0.2.0"), "0.3.0").unwrap();
        assert_eq!(
            older,
            format!(
                "This SuperTag CLI is 0.2.0, the app expects 0.3.0. Update with: {INSTALL_COMMAND}"
            )
        );
        assert!(
            version_mismatch(None, "0.3.0")
                .unwrap()
                .contains("an unknown version")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reads_the_version_the_cli_reports() {
        let root = tempfile::tempdir().unwrap();
        let cli = tool(root.path(), "supertag", 0o755);
        std::fs::write(
            &cli,
            "#!/bin/sh\ntest \"$1\" = --version && echo 'supertag 0.2.9'\n",
        )
        .unwrap();
        assert_eq!(cli_version(&cli).await.as_deref(), Some("0.2.9"));
        std::fs::write(&cli, "#!/bin/sh\nexit 1\n").unwrap();
        assert_eq!(cli_version(&cli).await, None);
    }

    #[test]
    fn never_runs_the_app_itself_as_the_cli() {
        // The test binary stands in for the app: a link to it named supertag is refused.
        let directory = tempfile::tempdir().unwrap();
        let exe = std::env::current_exe().unwrap();
        let link = directory.path().join("supertag");
        std::os::unix::fs::symlink(&exe, &link).unwrap();
        assert_eq!(cli(Some(&link), None, &[]), None);
        assert_eq!(cli(None, Some(directory.path().as_os_str()), &[]), None);
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

    /// A restart runs `down`, then `up`, both against the same state directory, and reports each
    /// step as it begins; a failed `down` never starts `up` and says what `down` printed.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_restart_stops_then_starts_the_same_state_directory() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("state");
        let calls = root.path().join("calls");
        let cli = tool(root.path(), "supertag", 0o755);
        std::fs::write(
            &cli,
            format!("#!/bin/sh\necho \"$*\" >> '{}'\n", calls.display()),
        )
        .unwrap();
        let steps = std::sync::Mutex::new(Vec::new());
        restart_with(&cli, &state, None, |step| steps.lock().unwrap().push(step))
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&calls).unwrap(),
            format!(
                "down --state-directory {0}\nup --state-directory {0}\n",
                state.display()
            )
        );
        assert_eq!(
            *steps.lock().unwrap(),
            [RestartStep::Stopping, RestartStep::Starting]
        );

        std::fs::remove_file(&calls).unwrap();
        std::fs::write(
            &cli,
            format!(
                "#!/bin/sh\necho \"$*\" >> '{}'\ntest \"$1\" = down && echo 'Error: drain Worker Host laptop: timed out' >&2 && exit 1\nexit 0\n",
                calls.display()
            ),
        )
        .unwrap();
        let steps = std::sync::Mutex::new(Vec::new());
        let error = restart_with(&cli, &state, None, |step| steps.lock().unwrap().push(step))
            .await
            .unwrap_err();
        assert!(error.starts_with("Could not stop SuperTag:\n"), "{error}");
        assert!(
            error.contains("drain Worker Host laptop: timed out"),
            "{error}"
        );
        assert!(
            std::fs::read_to_string(&calls)
                .unwrap()
                .starts_with("down "),
        );
        assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 1);
        assert_eq!(*steps.lock().unwrap(), [RestartStep::Stopping]);
    }
}
