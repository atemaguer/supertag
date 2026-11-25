//! `supertag init`: the local setup wizard. It checks for a harness before asking or changing
//! anything, checks harness sign-in with the credentials the host will have, asks a few
//! questions (or takes the defaults with `--yes`), writes supertag.yaml
//! with a control-plane service that provisions the lead Tag and a host service named after
//! this machine, and brings them up in the background.
use std::{
    io::{self, BufRead as _, IsTerminal as _, Write as _},
    os::unix::fs::{DirBuilderExt as _, PermissionsExt as _},
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result, bail, ensure};
use clap::Args;
use serde_json::{Value, json};
use supertag_protocol::v2::HarnessKind;

use crate::{harness_checks, lifecycle, local_config};

const DEFAULT_PORT: u16 = 3434;
const PERMISSION_SET: &str = "local-tools";
const ROLE: &str = "lead";
/// The Context Set init gives the lead's Role: every Skill the Worker Host has.
const CONTEXT_SET: &str = "skills";
/// Task Attempts the local Worker Host runs at once across its harnesses, so one stuck Task does
/// not hold every Tag.
const CONCURRENCY: u32 = 3;

#[derive(Args)]
pub struct InitArgs {
    /// Accept every default without asking.
    #[arg(long, short = 'y')]
    yes: bool,
    /// Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR).
    #[arg(long)]
    state_directory: Option<PathBuf>,
    /// The git repository to set up, instead of the current directory.
    #[arg(long, value_name = "PATH")]
    directory: Option<PathBuf>,
    /// The harness the lead Tag runs on, instead of the first signed-in one. Applies to a new
    /// setup only: another repository's Tag uses the lead's harness. With --check, check only
    /// this harness.
    #[arg(long, value_enum)]
    harness: Option<InitHarness>,
    /// The lead's model with --harness opencode, as OpenCode writes it: provider/model, such as
    /// opencode-go/glm-5.3. Without it, init offers the models opencode models lists.
    #[arg(
        long,
        value_name = "PROVIDER/MODEL",
        requires = "harness",
        conflicts_with = "check"
    )]
    model: Option<String>,
    /// Check this machine and folder without changing anything: whether the folder is a git
    /// repository, which harnesses are installed and signed in, and whether SuperTag is set up.
    /// Prints a readable report, or one JSON object with --json.
    #[arg(long, conflicts_with = "yes")]
    check: bool,
    /// Print the result as one JSON object, and progress on standard error. Use it with --check
    /// or --yes.
    #[arg(long)]
    json: bool,
}

/// A harness `--harness` may choose.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum InitHarness {
    Codex,
    ClaudeCode,
    Opencode,
}

impl InitHarness {
    fn found(self) -> Found {
        match self {
            Self::Codex => Found::Codex,
            Self::ClaudeCode => Found::ClaudeCode,
            Self::Opencode => Found::Opencode,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Found {
    ClaudeCode,
    Codex,
    Opencode,
    Cursor,
}

impl Found {
    fn check(self) -> harness_checks::Harness {
        match self {
            Self::ClaudeCode => harness_checks::Harness::ClaudeCode,
            Self::Codex => harness_checks::Harness::Codex,
            Self::Opencode => harness_checks::Harness::Opencode,
            Self::Cursor => harness_checks::Harness::Cursor,
        }
    }

    fn harness(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Cursor => "cursor",
        }
    }
}

/// Where a harness without its own sandbox runs commands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Commands {
    /// In Claude Code's own sandbox on this machine (`sandbox-commands`).
    Sandboxed,
    /// In a container on this machine's Docker (`environment: local-vm`).
    LocalVm,
    /// On this machine, as the operator (`allow-unsandboxed-commands`).
    Unsandboxed,
    /// Neither: Codex sandboxes its own, and another harness's lead gets no commands:execute.
    Unset,
}

/// Why Claude Code's own sandbox can't run the lead's commands on this machine, or `None` when it
/// can: it must start here, and the `claude` on PATH must be recent enough for `sandbox-commands`.
fn claude_sandbox_problem() -> Option<String> {
    #[cfg(feature = "test-fixtures")]
    if let Ok(state) = std::env::var("SUPERTAG_TEST_INIT_CLAUDE_SANDBOX") {
        return (state != "ready").then_some(state);
    }
    if !supertag_worker_host::egress::claude_sandbox_available() {
        return Some(if cfg!(target_os = "linux") {
            "it needs bubblewrap (bwrap), socat, and unprivileged user namespaces, and this machine is missing one".to_owned()
        } else {
            "it does not run on this operating system".to_owned()
        });
    }
    let output = Command::new("claude")
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok();
    crate::harness::sandbox_version_problem(
        output.and_then(|output| claude_version(&String::from_utf8_lossy(&output.stdout))),
    )
}

/// The container runtime local-vm would use, when one answers and the local-vm provider is
/// installed beside this CLI.
fn container_runtime() -> Option<&'static str> {
    #[cfg(feature = "test-fixtures")]
    if let Ok(runtime) = std::env::var("SUPERTAG_TEST_INIT_CONTAINER_RUNTIME") {
        return (runtime == "docker").then_some("docker");
    }
    crate::harness::local_vm_bridge().ok()?;
    // local-vm refuses Podman until it gives a Task the same isolation as Docker.
    ["docker"].into_iter().find(|runtime| {
        Command::new(runtime)
            .arg("info")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}

/// Harnesses this machine can run: claude, codex or opencode on PATH; Cursor through
/// CURSOR_API_KEY.
fn installed_harnesses() -> Vec<Found> {
    let mut found = Vec::new();
    for (program, harness) in [
        ("claude", Found::ClaudeCode),
        ("codex", Found::Codex),
        ("opencode", Found::Opencode),
    ] {
        if on_path(program) {
            found.push(harness);
        }
    }
    if std::env::var("CURSOR_API_KEY").is_ok_and(|key| !key.trim().is_empty()) {
        found.push(Found::Cursor);
    }
    found
}

/// The oldest Claude Code the Claude Code bridge's Agent SDK runs: the version it was built against.
/// SuperTag runs the `claude` on PATH, so an older one is refused before anything is written.
pub(crate) const CLAUDE_CODE_MINIMUM: (u64, u64, u64) = (2, 1, 280);

/// Why the `claude` on PATH is too old to run, read from `claude --version`, if it is.
fn claude_version_problem() -> Option<String> {
    let output = Command::new("claude")
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let found = claude_version(&String::from_utf8_lossy(&output.stdout))?;
    let (major, minor, patch) = CLAUDE_CODE_MINIMUM;
    (found < CLAUDE_CODE_MINIMUM).then(|| {
        format!(
            "Claude Code {}.{}.{} is older than {major}.{minor}.{patch}, the oldest SuperTag runs",
            found.0, found.1, found.2
        )
    })
}

/// The version in `claude --version`'s output, such as "2.1.323 (Claude Code)".
pub(crate) fn claude_version(output: &str) -> Option<(u64, u64, u64)> {
    let word = output.split_whitespace().next()?;
    let mut parts = word.split('.').map(|part| part.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

fn on_path(program: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|directory| {
            std::fs::metadata(directory.join(program)).is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
    })
}

/// Sign-in probes run with the credentials the host will have, each harness and model once.
struct SignIns {
    environment: local_config::Environment,
    supervisor: harness_checks::Supervisor,
    /// `--check --json` prints only its JSON.
    quiet: bool,
    results: Vec<(Found, Option<String>, bool)>,
    /// Harnesses whose check ran out of time.
    timed_out: Vec<Found>,
}

impl SignIns {
    async fn check(
        &mut self,
        harness: Found,
        model: Option<&str>,
        opencode_auth_file: Option<&Path>,
    ) -> Result<bool> {
        if let Some((_, _, signed_in)) = self
            .results
            .iter()
            .find(|(known, known_model, _)| *known == harness && known_model.as_deref() == model)
        {
            return Ok(*signed_in);
        }
        if !self.quiet {
            outln!(
                "Checking {} sign-in with the Worker Host credentials...",
                harness.harness()
            );
        }
        let variables = harness_checks::worker_variables(
            harness.check(),
            model,
            &self.environment,
            self.supervisor,
        )?;
        let result =
            harness_checks::probe_sign_in(harness.check(), model, opencode_auth_file, &variables)
                .await;
        if let Some(detail) = result.detail.as_ref().filter(|_| !self.quiet) {
            outln!("  {detail}");
        }
        let signed_in = result.signed_in;
        if result.timed_out {
            self.timed_out.push(harness);
        }
        self.results
            .push((harness, model.map(str::to_owned), signed_in));
        Ok(signed_in)
    }

    /// The key variable for an OpenCode model's provider that the Worker Host would pass, when
    /// it is set: in the environment or the env_file.
    fn opencode_key_variable(&self, model: &str) -> Option<&'static str> {
        let names =
            supertag_worker_host::provider_environment_for(HarnessKind::Opencode, Some(model))
                .ok()?;
        let variables = harness_checks::worker_variables(
            harness_checks::Harness::Opencode,
            Some(model),
            &self.environment,
            self.supervisor,
        )
        .ok()?;
        names.iter().copied().find(|name| {
            variables
                .get(std::ffi::OsStr::new(name))
                .and_then(|value| value.to_str())
                .is_some_and(|value| !value.trim().is_empty())
        })
    }
}

fn no_sign_in(harnesses: &[Found]) -> anyhow::Error {
    let mut message =
        "No harness on this machine is signed in. Sign in to one, then run supertag init again:"
            .to_owned();
    for harness in harnesses {
        message.push('\n');
        message.push_str(harness_checks::instructions(harness.check()));
    }
    anyhow::anyhow!(message)
}

pub(crate) struct Repository {
    pub(crate) root: PathBuf,
    pub(crate) name: String,
    /// Where the lead Tag's Sessions start.
    pub(crate) start: Start,
}

/// Where the lead Tag's Sessions start: the current branch, followed as it moves, or, when HEAD is
/// detached, the checked-out commit.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Start {
    Branch(String),
    Commit(String),
}

impl Start {
    /// The Tag manifest's `workspace` binding.
    fn binding(&self, workspace: &str) -> serde_json::Value {
        match self {
            Start::Branch(branch) => json!({ "id": workspace, "ref": branch }),
            Start::Commit(commit) => json!({ "id": workspace, "baseCommit": commit }),
        }
    }

    /// How init's closing summary describes it.
    fn describe(&self) -> String {
        match self {
            Start::Branch(branch) => format!("following branch {branch}"),
            Start::Commit(commit) => format!(
                "starting from commit {commit}. HEAD is detached, so the Tag is pinned to that commit; check out a branch and run supertag init again to follow it instead"
            ),
        }
    }
}

/// The current branch when it can be followed, otherwise the checked-out commit.
fn start(branch: Option<&str>, head: &str) -> Start {
    match branch {
        Some(branch) if supertag_protocol::valid_git_branch(branch) => {
            Start::Branch(branch.to_owned())
        }
        _ => Start::Commit(head.to_owned()),
    }
}

/// An error with one line that says what to do, for `--json`.
#[derive(Debug)]
pub(crate) struct Fixable {
    pub(crate) error: String,
    pub(crate) fix: String,
    pub(crate) command: Option<&'static str>,
}

impl std::fmt::Display for Fixable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.error, self.fix)
    }
}

impl std::error::Error for Fixable {}

/// The `--json` object for an init that failed.
pub(crate) fn failure(error: &anyhow::Error) -> Value {
    let (fix, command) = if let Some(fixable) = error.downcast_ref::<Fixable>() {
        (Some(fixable.fix.clone()), fixable.command)
    } else if let Some(problem) = error.downcast_ref::<RepositoryProblem>() {
        (Some(problem.to_string()), problem.command())
    } else {
        (None, None)
    };
    json!({
        "version": 1,
        "error": match error.downcast_ref::<Fixable>() {
            Some(fixable) => fixable.error.clone(),
            None => format!("{error:#}"),
        },
        "fix": fix,
        "fix_command": command,
    })
}

/// Why a folder can't be set up, in words a person can act on.
#[derive(Debug)]
pub(crate) enum RepositoryProblem {
    NoGit,
    NotRepository,
    NoCommits(PathBuf),
}

impl std::fmt::Display for RepositoryProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoGit => write!(
                f,
                "supertag init needs git on PATH; install it and run supertag init again"
            ),
            Self::NotRepository => write!(
                f,
                "supertag init sets up SuperTag for a git repository; run it inside one, or run git init and make a first commit"
            ),
            Self::NoCommits(root) => write!(
                f,
                "{} has no commits yet; Tasks start from a commit, so make one and run supertag init again",
                root.display()
            ),
        }
    }
}

impl std::error::Error for RepositoryProblem {}

impl RepositoryProblem {
    /// A command that fixes it, as the fix line words it.
    fn command(&self) -> Option<&'static str> {
        match self {
            Self::NotRepository => Some("git init"),
            Self::NoGit | Self::NoCommits(_) => None,
        }
    }
}

/// The git repository at `directory`, or the current directory.
pub(crate) fn repository(directory: Option<&Path>) -> Result<Repository> {
    let mut command = Command::new("git");
    if let Some(directory) = directory {
        command.arg("-C").arg(directory);
    }
    let output = command
        .args(["rev-parse", "--show-toplevel"])
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|_| RepositoryProblem::NoGit)?;
    if !output.status.success() {
        return Err(RepositoryProblem::NotRepository.into());
    }
    let root = PathBuf::from(String::from_utf8(output.stdout)?.trim()).canonicalize()?;
    let commits = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["rev-parse", "--verify", "--quiet", "HEAD"])
        .output()?;
    if !commits.status.success() {
        return Err(RepositoryProblem::NoCommits(root).into());
    }
    let head = String::from_utf8(commits.stdout)?.trim().to_owned();
    // Fails with a detached HEAD.
    let branch = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()?;
    let branch = if branch.status.success() {
        Some(String::from_utf8(branch.stdout)?.trim().to_owned())
    } else {
        None
    };
    let base = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workspace");
    Ok(Repository {
        name: sanitize(base).unwrap_or_else(|| "workspace".into()),
        root,
        start: start(branch.as_deref(), &head),
    })
}

/// A lowercase identifier of letters, digits and hyphens, at most 63 characters.
pub(crate) fn sanitize(value: &str) -> Option<String> {
    let mut name = String::new();
    for c in value.to_ascii_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            name.push(c);
        } else if !name.is_empty() && !name.ends_with('-') {
            name.push('-');
        }
    }
    let name = name.trim_end_matches('-');
    let name: String = name.chars().take(63).collect();
    let name = name.trim_end_matches('-').to_owned();
    (!name.is_empty()).then_some(name)
}

/// The name this machine goes by, for naming its host service. On macOS `hostname` can be a
/// network-assigned name such as `Mac.attlocal.net`, so the user-set LocalHostName
/// (`Dana-MacBook-Pro`) comes first there.
fn machine_name() -> String {
    let local_host_name = if cfg!(target_os = "macos") {
        mac_local_host_name()
    } else {
        None
    };
    name_for_machine(local_host_name, &hostname())
}

fn mac_local_host_name() -> Option<String> {
    let mut child = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "LocalHostName"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if child.try_wait().ok()?.is_some() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let output = child.wait_with_output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
}

fn hostname() -> String {
    let mut buffer = [0_u8; 256];
    // SAFETY: the buffer is writable for its full length, and gethostname NUL-terminates
    // within it on success.
    if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0 {
        let end = buffer
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(buffer.len());
        String::from_utf8_lossy(&buffer[..end]).into_owned()
    } else {
        String::new()
    }
}

/// The LocalHostName when there is one, otherwise the hostname's first label, as an identifier
/// that does not collide with a built-in service.
fn name_for_machine(local_host_name: Option<String>, hostname: &str) -> String {
    let name = local_host_name
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| hostname.split('.').next().unwrap_or_default().to_owned());
    sanitize(&name)
        .filter(|name| {
            ![
                lifecycle::CONTROL_PLANE,
                lifecycle::GATEWAY,
                lifecycle::SUPERVISOR,
            ]
            .contains(&name.as_str())
        })
        .unwrap_or_else(|| "this-machine".into())
}

fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

struct Prompter {
    input: io::StdinLock<'static>,
}

impl Prompter {
    fn ask(&mut self, question: &str, default: &str) -> Result<String> {
        if default.is_empty() {
            out!("{question}: ");
        } else {
            out!("{question} [{default}]: ");
        }
        let mut line = String::new();
        ensure!(
            self.input.read_line(&mut line)? > 0,
            "supertag init stopped: no answer was given"
        );
        let answer = line.trim();
        Ok(if answer.is_empty() { default } else { answer }.to_owned())
    }

    fn confirm(&mut self, question: &str, default: bool) -> Result<bool> {
        let hint = if default { "Y/n" } else { "y/N" };
        loop {
            let answer = self.ask(question, hint)?;
            if answer == hint {
                return Ok(default);
            }
            match answer.to_ascii_lowercase().as_str() {
                "y" | "yes" => return Ok(true),
                "n" | "no" => return Ok(false),
                _ => outln!("Answer yes or no."),
            }
        }
    }
}

fn interactive() -> bool {
    #[cfg(feature = "test-fixtures")]
    if std::env::var_os("SUPERTAG_TEST_INIT_INTERACTIVE").is_some() {
        return true;
    }
    io::stdin().is_terminal()
}

struct Answers {
    port: u16,
    harness: Found,
    /// The other signed-in harnesses the host also runs, for Tags created later.
    also: Vec<Found>,
    model: Option<String>,
    /// The host's `opencode-auth-file`, for an OpenCode lead whose provider's key is in it.
    opencode_auth_file: Option<PathBuf>,
    commands: Commands,
    workspace: String,
    tag: String,
}

pub async fn init(args: InitArgs) -> Result<()> {
    if args.check {
        let report = check(
            args.directory.as_deref(),
            args.state_directory,
            args.harness.map(InitHarness::found),
        )
        .await?;
        if args.json {
            outln!("{}", serde_json::to_string_pretty(&report)?);
        } else {
            out!("{}", check_text(&report));
        }
        return Ok(());
    }
    if !args.json {
        return apply(args).await.map(drop);
    }
    // The app reading standard output gets one JSON object; progress goes to standard error.
    crate::terminal::progress_to_stderr();
    let result = if args.yes {
        match apply(args).await {
            Ok((path, root)) => applied(&path, &root),
            Err(error) => Err(error),
        }
    } else {
        Err(Fixable {
            error: "supertag init --json does not ask questions.".into(),
            fix: "Add --yes, or use --check.".into(),
            command: None,
        }
        .into())
    };
    let value = match &result {
        Ok(value) => value.clone(),
        Err(error) => failure(error),
    };
    crate::terminal::write_result(&format!("{}\n", serde_json::to_string(&value)?));
    result.map(drop)
}

/// Sets up SuperTag, or adds the repository to the setup, and starts it. Returns supertag.yaml's
/// path and the repository's root.
async fn apply(args: InitArgs) -> Result<(PathBuf, PathBuf)> {
    // First, before any question or side effect: a harness must be installed.
    let installed = installed_harnesses();
    let named = args.harness.map(InitHarness::found);
    if let Some(model) = &args.model {
        ensure!(
            named == Some(Found::Opencode),
            Fixable {
                error: "--model chooses an OpenCode lead's model.".into(),
                fix: "Add --harness opencode, or leave --model out.".into(),
                command: None,
            }
        );
        if supertag_worker_host::validate_opencode_model(model).is_err() {
            bail!(Fixable {
                error: format!("{model} is not an OpenCode model."),
                fix: "Give it as OpenCode writes it, provider/model, such as opencode-go/glm-5.3; opencode models lists them.".into(),
                command: Some("opencode models"),
            });
        }
    }
    if let Some(harness) = named
        && !installed.contains(&harness)
    {
        bail!(Fixable {
            error: format!("{} is not installed on this machine.", harness.harness()),
            fix: install_line(
                harness,
                &local_config::state_directory(args.state_directory.clone())?,
            ),
            command: install_command(harness),
        });
    }
    ensure!(
        !installed.is_empty(),
        "SuperTag runs Tasks with an installed coding agent, and none was found. Install Claude Code or Codex:
  Claude Code: {}
  Codex: npm install -g @openai/codex
Sign in to it, then run supertag init again. (OpenCode, with opencode on PATH, and Cursor, with CURSOR_API_KEY set, also work.)",
        harness_checks::CLAUDE_CODE_INSTALL
    );
    if args.yes && named.is_none() && installed == [Found::Opencode] {
        bail!(Fixable {
            error: "OpenCode is the only harness on this machine, and --yes chooses OpenCode only when it is named.".into(),
            fix: "Run supertag init --yes --harness opencode, and add --model provider/model to choose its model.".into(),
            command: Some("supertag init --yes --harness opencode"),
        });
    }
    let ask = !args.yes;
    if ask && !interactive() {
        bail!(
            "supertag init asks a few questions, so it needs a terminal. Run it in one, or pass --yes to accept the defaults."
        );
    }
    let repository = repository(args.directory.as_deref())?;
    let state = local_config::state_directory(args.state_directory)?;
    let path = state.join("supertag.yaml");
    let mut prompter = ask.then(|| Prompter {
        input: io::stdin().lock(),
    });
    outln!("SuperTag setup for {}", repository.root.display());

    if path.exists() {
        // Refuse a file that does not load before changing anything.
        local_config::load(Some(path.clone()), &state)?.context("supertag.yaml disappeared")?;
        outln!(
            "\nSuperTag is already set up on this machine: {}",
            path.display()
        );
        let keep = match &mut prompter {
            Some(prompter) => {
                prompter.confirm("Keep it, and make sure everything is running?", true)?
            }
            None => true,
        };
        if keep {
            add_repository(&path, &repository, prompter.as_mut())?;
            // Before add_skills, which finds the Role by its current name.
            rename_role(&path)?;
            add_skills(&path)?;
        }
        if !keep {
            outln!(
                "Nothing was changed. To try another harness, see https://github.com/atemaguer/supertag/blob/main/docs/operations/cli.md#try-another-harness; to start over, run supertag down and move {} aside, which leaves your Tags and conversations behind.",
                state.display()
            );
            return Ok((path, repository.root));
        }
        // Adding this repository may have changed the file.
        let config =
            local_config::load(Some(path.clone()), &state)?.context("supertag.yaml disappeared")?;
        let mut sign_ins = SignIns {
            environment: config.environment.clone(),
            // A service unit carries no credential from this shell, so neither does the check.
            supervisor: harness_checks::Supervisor::of(&config),
            quiet: false,
            results: Vec::new(),
            timed_out: Vec::new(),
        };
        add_harnesses(&path, &installed, &mut sign_ins, prompter.as_mut()).await?;
        // Adding harnesses may have changed the file too.
        let config =
            local_config::load(Some(path.clone()), &state)?.context("supertag.yaml disappeared")?;
        let mut checked = Vec::new();
        let mut runnable = false;
        for host in config
            .hosts
            .iter()
            .filter(|host| host.control_plane.is_none())
        {
            for adapter in &host.harnesses {
                let found = match adapter.harness_kind() {
                    HarnessKind::ClaudeCode => Found::ClaudeCode,
                    HarnessKind::Codex => Found::Codex,
                    HarnessKind::Cursor => Found::Cursor,
                    HarnessKind::Opencode => Found::Opencode,
                    _ => continue,
                };
                let model = adapter.execution_profile()?.default_model;
                let signed_in = sign_ins
                    .check(found, model.as_deref(), adapter.opencode_auth_file())
                    .await?;
                report(found, signed_in);
                runnable |= signed_in;
                checked.push(found);
            }
        }
        if !checked.is_empty() && !runnable {
            return Err(no_sign_in(&checked));
        }
        up(&state, config).await?;
        // As a first init ends: which Tag works here, and how to talk to it.
        match applied(&path, &repository.root)
            .ok()
            .and_then(|value| value["tag"].as_str().map(str::to_owned))
        {
            Some(tag) => outln!(
                "\nTag {tag} works in {}. Run supertag in your terminal to talk to it.",
                repository.root.display()
            ),
            None => outln!("\nRun supertag in your terminal to talk to your Tags."),
        }
        return Ok((path, repository.root));
    }

    let mut sign_ins = SignIns {
        environment: local_config::default_environment(&state)?,
        // The supertag.yaml init writes runs a background supervisor, which inherits this shell.
        supervisor: harness_checks::Supervisor::ThisProcess,
        quiet: false,
        results: Vec::new(),
        timed_out: Vec::new(),
    };
    let mut signed_in = Vec::new();
    // Why Claude Code can't run here, as the fix to name if it is the only harness.
    let mut claude_cannot_run: Option<&str> = None;
    // Why OpenCode can't run here, when it can't.
    let mut opencode_cannot_run: Option<String> = None;
    // Every installed harness is checked, a named one too: the host runs each signed-in one, so
    // Tags created later may use any of them. Only the lead's harness must be signed in.
    for harness in &installed {
        if *harness == Found::Opencode {
            // SuperTag runs OpenCode through its Node bridge too.
            if let Some((cause, fix)) = opencode_problem() {
                outln!("  opencode: can't run: {cause}. {fix}");
                if named == Some(Found::Opencode) {
                    bail!(Fixable {
                        error: format!("OpenCode can't run: {cause}."),
                        fix,
                        command: None,
                    });
                }
                opencode_cannot_run = Some(format!(
                    "OpenCode is the only harness on this machine, and it can't run: {cause}. {fix}"
                ));
                continue;
            }
            // Its sign-in check needs a model, chosen below.
            if prompter.is_some() {
                outln!("  opencode: sign-in not checked (choose a model)");
            }
            continue;
        }
        // SuperTag runs Claude Code through its Node bridge: without a Node it can use, the
        // Worker Host could not start, so say so now rather than after writing supertag.yaml.
        if *harness == Found::ClaudeCode
            && let Some(problem) =
                crate::node_bridges::node_problem(crate::node_bridges::NodeBridge::ClaudeCode)
        {
            outln!(
                "  claude-code: can't run: {problem}. SuperTag runs Claude Code through Node.js 22.13 or later. Install it from https://nodejs.org/en/download (or brew install node), then run supertag init again."
            );
            claude_cannot_run = Some(
                "Claude Code is the only harness on this machine, and it needs Node.js 22.13 or later on PATH. Install that, or install Codex (npm install -g @openai/codex), then run supertag init again.",
            );
            if named == Some(*harness) {
                bail!(Fixable {
                    error: format!("Claude Code can't run: {problem}."),
                    fix: "Install Node.js 22.13 or later from https://nodejs.org/en/download, then run supertag init again.".into(),
                    command: None,
                });
            }
            continue;
        }
        if *harness == Found::ClaudeCode
            && let Some(problem) = claude_version_problem()
        {
            outln!(
                "  claude-code: can't run: {problem}. Update it with claude update, then run supertag init again."
            );
            claude_cannot_run = Some(
                "Claude Code is the only harness on this machine, and it is too old for SuperTag. Update it with claude update, or install Codex (npm install -g @openai/codex), then run supertag init again.",
            );
            if named == Some(*harness) {
                bail!(Fixable {
                    error: format!("{problem}."),
                    fix: "Update Claude Code with claude update, then run supertag init again."
                        .into(),
                    command: Some("claude update"),
                });
            }
            continue;
        }
        // A supertag without its Node bridges, such as one built from a checkout, could not
        // start Claude Code's Worker either.
        if *harness == Found::ClaudeCode
            && let Some(problem) =
                crate::node_bridges::bridge_problem(crate::node_bridges::NodeBridge::ClaudeCode)
        {
            outln!(
                "  claude-code: can't run: {}. {}, then run supertag init again.",
                problem.cause,
                problem.fix
            );
            claude_cannot_run = Some(
                "Claude Code is the only harness on this machine, and this supertag has no Node bridge to run it. Install the bridges as shown above, or install Codex (npm install -g @openai/codex), then run supertag init again.",
            );
            if named == Some(*harness) {
                bail!(Fixable {
                    error: format!("Claude Code can't run: {}.", problem.cause),
                    fix: format!("{}, then run supertag init again.", problem.fix),
                    command: None,
                });
            }
            continue;
        }
        let result = sign_ins.check(*harness, None, None).await?;
        report(*harness, result);
        if result {
            signed_in.push(*harness);
        } else if prompter.is_some() {
            outln!("{}", harness_checks::instructions(harness.check()));
        }
    }
    // A harness that can't run is not offered.
    let installed: Vec<Found> = installed
        .into_iter()
        .filter(|harness| !(claude_cannot_run.is_some() && *harness == Found::ClaudeCode))
        .filter(|harness| !(opencode_cannot_run.is_some() && *harness == Found::Opencode))
        .collect();
    if installed.is_empty()
        && let Some(problem) = claude_cannot_run.map(str::to_owned).or(opencode_cannot_run)
    {
        bail!(problem);
    }
    // OpenCode's sign-in is checked once its model is chosen.
    if let Some(harness) = named
        && harness != Found::Opencode
        && !signed_in.contains(&harness)
    {
        bail!(sign_in_problem(
            harness,
            sign_ins.timed_out.contains(&harness)
        ));
    }
    if prompter.is_none() && signed_in.is_empty() && named != Some(Found::Opencode) {
        return Err(no_sign_in(&installed));
    }
    if prompter.is_some() {
        outln!("Press Enter to accept the default in [brackets].");
    }
    // OpenCode's own sign-in file, read only for which providers it holds.
    let opencode_auth = installed
        .contains(&Found::Opencode)
        .then(OpencodeAuth::at_usual_path)
        .flatten();
    // OpenCode Zen's models without a key are only its free ones.
    let usable = |model: &str| match opencode_key(
        model,
        opencode_auth.as_ref(),
        sign_ins.opencode_key_variable(model),
        &state,
    ) {
        Ok(OpencodeKey::None) => model.ends_with("-free"),
        Ok(_) => true,
        Err(_) => false,
    };
    let mut answers = answers(
        prompter.as_mut(),
        &installed,
        &signed_in,
        &repository,
        named,
        Opencode {
            model: args.model.as_deref(),
            usable: &usable,
        },
        &state,
    )?;
    if let (Found::Opencode, Some(model)) = (answers.harness, answers.model.as_deref()) {
        let key = opencode_key(
            model,
            opencode_auth.as_ref(),
            sign_ins.opencode_key_variable(model),
            &state,
        )?;
        outln!("  {}", key.describe(model));
        if let OpencodeKey::File(path) = key {
            answers.opencode_auth_file = Some(path);
        }
    }
    // A harness checked above already said whether it is signed in.
    let checked = sign_ins
        .results
        .iter()
        .any(|(harness, model, _)| *harness == answers.harness && *model == answers.model);
    let result = sign_ins
        .check(
            answers.harness,
            answers.model.as_deref(),
            answers.opencode_auth_file.as_deref(),
        )
        .await?;
    if !checked {
        report(answers.harness, result);
    }
    if !result {
        if let (Found::Opencode, Some(model)) = (answers.harness, answers.model.as_deref()) {
            bail!(opencode_turn_failed(
                model,
                sign_ins.timed_out.contains(&Found::Opencode)
            ));
        }
        return Err(no_sign_in(&[answers.harness]));
    }
    answers.also = signed_in
        .iter()
        .copied()
        .filter(|harness| *harness != answers.harness)
        .collect();
    let document = document(&answers, &repository);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&state)?;
    let text = local_config::to_yaml(&document);
    let temporary = state.join(format!(
        ".supertag.yaml.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
    }
    let config = match local_config::load(Some(temporary.clone()), &state) {
        Ok(Some(config)) => config,
        Ok(None) => unreachable!("an explicit file is always read"),
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.context("supertag init wrote an invalid supertag.yaml"));
        }
    };
    drop(config);
    std::fs::rename(&temporary, &path)?;
    outln!("\nWrote {}.", path.display());
    let config =
        local_config::load(Some(path.clone()), &state)?.context("supertag.yaml missing")?;
    up(&state, config).await?;
    outln!(
        "\nTag {} runs {} on this machine, in Workspace {} ({}), {}.",
        answers.tag,
        match &answers.model {
            Some(model) => format!("{} with {model}", answers.harness.harness()),
            None => answers.harness.harness().to_owned(),
        },
        answers.workspace,
        repository.root.display(),
        repository.start.describe()
    );
    if !answers.also.is_empty() {
        let names: Vec<&str> = answers.also.iter().map(|found| found.harness()).collect();
        outln!(
            "This machine also runs {} for Tags you create later.",
            names.join(" and ")
        );
    }
    outln!(
        "Run supertag in your terminal to talk to it. To keep SuperTag running after restarts, add restart: unless-stopped to both services in {} and run supertag up.",
        path.display()
    );
    Ok((path, repository.root))
}

/// On an existing setup, run in a repository no local host maps yet: offers (default yes) to add
/// it as a Workspace of the local host, with a Tag of its own that works in it on the lead's
/// harness and Roles. `supertag up` then creates the Tag. A file with comments or more than one
/// local host is left alone, with the steps to do it by hand.
fn add_repository(
    path: &Path,
    repository: &Repository,
    prompter: Option<&mut Prompter>,
) -> Result<()> {
    let text = std::fs::read_to_string(path)?;
    let mut document = yaml_document(&text)?;
    let hosts = local_hosts(&document);
    let root = repository.root.canonicalize()?;
    if maps(&document, &hosts, &root) || hosts.is_empty() {
        return Ok(());
    }
    let name = repository.name.clone();
    let lead = document["services"]["control-plane"]["provision"]
        .as_array()
        .and_then(|manifests| {
            manifests
                .iter()
                .find(|manifest| manifest["kind"] == "Tag" && manifest["spec"]["lead"] == true)
        })
        .cloned();
    let taken = |name: &str| {
        hosts
            .iter()
            .any(|host| !document["services"][host]["workspaces"][name].is_null())
            || document["services"]["control-plane"]["provision"]
                .as_array()
                .is_some_and(|manifests| {
                    manifests
                        .iter()
                        .any(|manifest| manifest["metadata"]["name"] == name)
                })
    };
    let by_hand = |reason: &str| {
        outln!(
            "\nThis repository is not a Workspace of this machine yet, and {reason}, so supertag init leaves supertag.yaml alone. Add {name}: {} under a host's workspaces in {}, run supertag up, then create a Tag for it with supertag tag put {name} --workspace-id {name}.",
            root.display(),
            path.display()
        );
    };
    let (Some(lead), [host]) = (lead, hosts.as_slice()) else {
        by_hand("the file has no single local host and lead Tag that init set up");
        return Ok(());
    };
    if !rewritable(&text) {
        by_hand("the file has comments or variables that rewriting it would lose");
        return Ok(());
    }
    if taken(&name) {
        by_hand(&format!("the name {name} is already used"));
        return Ok(());
    }
    outln!(
        "\n{} is not a Workspace of this machine yet.",
        root.display()
    );
    let add = match prompter {
        Some(prompter) => prompter.confirm(
            &format!("Add it as Workspace {name}, with a Tag {name} that works in it?"),
            true,
        )?,
        None => true,
    };
    if !add {
        return Ok(());
    }
    document["services"][host]["workspaces"][&name] = json!(root);
    let mut spec = json!({
        "roles": lead["spec"]["roles"].clone(),
        "workspace": repository.start.binding(&name),
    });
    if !lead["spec"]["execution"].is_null() {
        spec["execution"] = lead["spec"]["execution"].clone();
    }
    document["services"]["control-plane"]["provision"]
        .as_array_mut()
        .context("supertag.yaml has no provision list")?
        .push(json!({
            "apiVersion": "supertag/v1",
            "kind": "Tag",
            "metadata": { "name": name },
            "spec": spec,
        }));
    rewrite(path, &document).context("adding this repository would make supertag.yaml invalid")?;
    outln!(
        "Added Workspace {name} ({}) to host {host}, and Tag {name}, which works in it on the lead's harness, {}.",
        root.display(),
        repository.start.describe()
    );
    Ok(())
}

/// On an existing setup: offers (default yes) to let the one local host also run the installed,
/// signed-in harnesses it does not run yet, such as Codex beside a Claude Code lead, so Tags
/// created later can use them. A host with an adapter, more than one local host, or a file with
/// comments is left alone, with the step to do it by hand.
async fn add_harnesses(
    path: &Path,
    installed: &[Found],
    sign_ins: &mut SignIns,
    prompter: Option<&mut Prompter>,
) -> Result<()> {
    let text = std::fs::read_to_string(path)?;
    let mut document = yaml_document(&text)?;
    let hosts = local_hosts(&document);
    let [host] = hosts.as_slice() else {
        return Ok(());
    };
    let service = &document["services"][host];
    let Some(listed) = service["harnesses"].as_array() else {
        return Ok(());
    };
    if !service["adapter"].is_null() || listed.is_empty() {
        return Ok(());
    }
    let mut missing = Vec::new();
    for harness in installed {
        // OpenCode needs a model answer first.
        if *harness == Found::Opencode
            || listed
                .iter()
                .any(|listed| listed.as_str() == Some(harness.harness()))
            || (*harness == Found::ClaudeCode && claude_code_cannot_run())
        {
            continue;
        }
        if sign_ins.check(*harness, None, None).await? {
            missing.push(*harness);
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    let names: Vec<&str> = missing.iter().map(|found| found.harness()).collect();
    let names = names.join(" and ");
    if !rewritable(&text) {
        outln!(
            "\n{names} is signed in but host {host} does not run it. To create Tags on it, add it to the host's harnesses in {}, then run supertag up.",
            path.display()
        );
        return Ok(());
    }
    let add = match prompter {
        Some(prompter) => prompter.confirm(
            &format!("Also run {names} on this machine, so new Tags can use it?"),
            true,
        )?,
        None => true,
    };
    if !add {
        return Ok(());
    }
    let harnesses = document["services"][host]["harnesses"]
        .as_array_mut()
        .context("the host's harnesses is not a list")?;
    harnesses.extend(missing.iter().map(|found| json!(found.harness())));
    rewrite(path, &document).context("adding harnesses would make supertag.yaml invalid")?;
    outln!("Host {host} also runs {names} now, for Tags you create later.");
    Ok(())
}

/// Whether SuperTag could not run the Claude Code on PATH: no Node.js it can use, a Claude Code
/// too old, or no Node bridge beside this supertag.
fn claude_code_cannot_run() -> bool {
    use crate::node_bridges::{NodeBridge, bridge_problem, node_problem};
    node_problem(NodeBridge::ClaudeCode).is_some()
        || claude_version_problem().is_some()
        || bridge_problem(NodeBridge::ClaudeCode).is_some()
}

/// Whether supertag.yaml's text can be rewritten without losing anything: it has no comments
/// and no `${...}` variables.
pub(crate) fn rewritable(text: &str) -> bool {
    !(text.lines().any(|line| line.trim_start().starts_with('#')) || text.contains("${"))
}

/// Replaces supertag.yaml at `path` with `document`, refusing one that would not load: the new
/// file is written beside it, read as `supertag up` reads it, then renamed over it.
pub(crate) fn rewrite(path: &Path, document: &Value) -> Result<()> {
    let temporary = path.with_file_name(format!(
        ".supertag.yaml.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(local_config::to_yaml(document).as_bytes())?;
        file.sync_all()?;
    }
    let state = path.parent().context("supertag.yaml has no directory")?;
    if let Err(error) = local_config::load(Some(temporary.clone()), state) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    std::fs::rename(&temporary, path)?;
    Ok(())
}

/// supertag.yaml as written, without resolving variables.
pub(crate) fn yaml_document(text: &str) -> Result<Value> {
    let options = serde_saphyr::options! {budget:serde_saphyr::budget!{max_documents:1,max_depth:24,max_nodes:10000}};
    serde_saphyr::from_str_with_options(text, options).context("supertag.yaml is not valid YAML")
}

/// The host services of this machine's own Control Plane.
pub(crate) fn local_hosts(document: &Value) -> Vec<String> {
    document["services"]
        .as_object()
        .map(|services| {
            services
                .iter()
                .filter(|(_, service)| {
                    service["type"] == "host" && service.get("control-plane").is_none()
                })
                .map(|(name, _)| name.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether one of `hosts` maps the repository at `root` as a Workspace.
fn maps(document: &Value, hosts: &[String], root: &Path) -> bool {
    mapped_workspace(document, hosts, root).is_some()
}

/// The name of the Workspace a local host maps to `root`, if any.
pub(crate) fn mapped_workspace(document: &Value, hosts: &[String], root: &Path) -> Option<String> {
    hosts.iter().find_map(|host| {
        document["services"][host]["workspaces"]
            .as_object()?
            .iter()
            .find(|(_, mapping)| {
                let source = mapping.as_str().or_else(|| mapping["path"].as_str());
                source.is_some_and(|source| {
                    expand_home(source).canonicalize().ok().as_deref() == Some(root)
                })
            })
            .map(|(name, _)| name.clone())
    })
}

/// The `--json` object for an init that finished: the Tag that works in `root`, and where the
/// Control Plane listens.
fn applied(path: &Path, root: &Path) -> Result<Value> {
    let document = yaml_document(&std::fs::read_to_string(path)?)?;
    let root = root.canonicalize()?;
    let not_set_up = || Fixable {
        error: format!(
            "{} is not a Workspace of this machine's SuperTag.",
            root.display()
        ),
        fix: format!(
            "Add it under a host's workspaces in {}, add a Tag for it, and run supertag up.",
            path.display()
        ),
        command: None,
    };
    let workspace =
        mapped_workspace(&document, &local_hosts(&document), &root).ok_or_else(not_set_up)?;
    let tags: Vec<&Value> = document["services"]["control-plane"]["provision"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|manifest| manifest["kind"] == "Tag")
        .collect();
    let lead = tags.iter().find(|tag| tag["spec"]["lead"] == true);
    // The lead first, when it works in this Workspace.
    let tag = lead
        .into_iter()
        .chain(tags.iter())
        .find(|tag| tag["spec"]["workspace"]["id"] == workspace.as_str())
        .ok_or_else(not_set_up)?;
    let harness = [Some(tag), lead]
        .into_iter()
        .flatten()
        .find_map(|tag| tag["spec"]["execution"]["harness"].as_str());
    let state = path.parent().context("supertag.yaml has no directory")?;
    let config =
        local_config::load(Some(path.to_owned()), state)?.context("supertag.yaml missing")?;
    Ok(json!({
        "version": 1,
        "tag": tag["metadata"]["name"],
        "workspace": workspace,
        "harness": harness,
        "control_plane": config.plane.map(|plane| format!("http://{}", plane.listen)),
    }))
}

fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(rest))
            .unwrap_or_else(|| PathBuf::from(path)),
        None => PathBuf::from(path),
    }
}

/// The command that installs a harness, or what to set for Cursor in `state`'s .env.
fn install_line(harness: Found, state: &Path) -> String {
    match harness {
        Found::Codex => "Install Codex: npm install -g @openai/codex".into(),
        Found::ClaudeCode => format!(
            "Install Claude Code: {}",
            harness_checks::CLAUDE_CODE_INSTALL
        ),
        Found::Opencode => "Install OpenCode: npm install -g opencode-ai".into(),
        Found::Cursor => format!(
            "Cursor: generate an API key at https://cursor.com/dashboard/api and set CURSOR_API_KEY in {}.",
            state.join(".env").display()
        ),
    }
}

/// The command in `install_line`, if it has one.
fn install_command(harness: Found) -> Option<&'static str> {
    match harness {
        Found::Codex => Some("npm install -g @openai/codex"),
        Found::ClaudeCode => Some(harness_checks::CLAUDE_CODE_INSTALL),
        Found::Opencode => Some("npm install -g opencode-ai"),
        Found::Cursor => None,
    }
}

/// Where to read how to install a harness, or, for Cursor, get its API key.
fn install_url(harness: Found) -> &'static str {
    match harness {
        Found::Codex => "https://developers.openai.com/codex/cli",
        Found::ClaudeCode => "https://docs.claude.com/en/docs/claude-code/setup",
        Found::Opencode => "https://opencode.ai/docs/",
        Found::Cursor => "https://cursor.com/dashboard/api",
    }
}

/// The command in the first line of `harness_checks::instructions`, if it has one.
fn sign_in_command(harness: Found) -> Option<&'static str> {
    match harness {
        Found::Codex => Some("codex -c 'cli_auth_credentials_store=\"file\"' login"),
        Found::ClaudeCode => Some("claude"),
        Found::Cursor | Found::Opencode => None,
    }
}

/// Why a harness's sign-in check failed, with one line that says what to do.
fn sign_in_problem(harness: Found, timed_out: bool) -> Fixable {
    if timed_out {
        return Fixable {
            error: format!("Couldn't check the {} sign-in.", harness.harness()),
            fix: timed_out_line(),
            command: None,
        };
    }
    Fixable {
        error: format!("{} is not signed in.", harness.harness()),
        fix: first_line(harness_checks::instructions(harness.check())).into(),
        command: sign_in_command(harness),
    }
}

fn timed_out_line() -> String {
    format!(
        "Couldn't check the sign-in: it did not finish within {} seconds. Check your network connection, then check again.",
        harness_checks::SIGN_IN_TIMEOUT.as_secs()
    )
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or(text)
}

/// The Node bridge a harness runs through, if any.
fn bridge(harness: Found) -> Option<crate::node_bridges::NodeBridge> {
    use crate::node_bridges::NodeBridge;
    match harness {
        Found::Codex => None,
        Found::ClaudeCode => Some(NodeBridge::ClaudeCode),
        Found::Cursor => Some(NodeBridge::Cursor),
        Found::Opencode => Some(NodeBridge::Opencode),
    }
}

/// What to fix before `bridge` can run, as `--check` reports it, or `None` when it can.
fn bridge_fix(bridge: crate::node_bridges::NodeBridge) -> Option<String> {
    crate::node_bridges::node_problem(bridge)
        .map(|problem| format!("Node.js: {problem}"))
        .or_else(|| {
            crate::node_bridges::bridge_problem(bridge)
                .map(|problem| format!("Node bridge: {}. {}.", problem.cause, problem.fix))
        })
}

/// What `--check` found about one harness.
struct HarnessFact {
    harness: Found,
    installed: bool,
    /// `None` when it was not checked: not installed, or OpenCode, whose check needs a model;
    /// or when the check ran out of time.
    signed_in: Option<bool>,
    timed_out: bool,
    /// `None` for a harness without a Node bridge; otherwise what to fix when its bridge can't
    /// run: the Node on PATH, or the bridge itself missing beside this supertag.
    node: Option<Option<String>>,
    /// Why the installed harness is too old to run, for Claude Code.
    version: Option<String>,
}

/// `supertag init --check --json`: what `init` would find, without changing anything. The same
/// probes `init` runs: the repository, installed harnesses and their sign-in with the Worker
/// Host's credentials, the Node a bridge needs, and the local setup.
async fn check(
    directory: Option<&Path>,
    state_directory: Option<PathBuf>,
    only: Option<Found>,
) -> Result<Value> {
    let state = local_config::state_directory(state_directory)?;
    let path = state.join("supertag.yaml");
    let configured = path.exists();
    let shown = directory
        .map(Path::to_path_buf)
        .map_or_else(std::env::current_dir, Ok)?;
    let found = repository(directory);
    let environment = match configured
        .then(|| local_config::load(Some(path.clone()), &state))
        .transpose()?
        .flatten()
    {
        Some(config) => config.environment,
        None => local_config::default_environment(&state)?,
    };
    let mut sign_ins = SignIns {
        environment,
        supervisor: harness_checks::Supervisor::ThisProcess,
        quiet: true,
        results: Vec::new(),
        timed_out: Vec::new(),
    };
    let installed = installed_harnesses();
    let mut facts = Vec::new();
    for harness in [
        Found::Codex,
        Found::ClaudeCode,
        Found::Cursor,
        Found::Opencode,
    ]
    .into_iter()
    .filter(|harness| only.is_none_or(|only| only == *harness))
    {
        let is_installed = installed.contains(&harness);
        // OpenCode's check needs a model, which only an interactive init asks for.
        let signed_in = if is_installed && harness != Found::Opencode {
            Some(sign_ins.check(harness, None, None).await?)
        } else {
            None
        };
        let timed_out = sign_ins.timed_out.contains(&harness);
        facts.push(HarnessFact {
            harness,
            installed: is_installed,
            signed_in: signed_in.filter(|_| !timed_out),
            timed_out,
            node: bridge(harness).map(bridge_fix),
            version: (is_installed && harness == Found::ClaudeCode)
                .then(claude_version_problem)
                .flatten(),
        });
    }
    let repository_mapped = match (&found, configured) {
        (Ok(repository), true) => {
            let document = yaml_document(&std::fs::read_to_string(&path)?)?;
            maps(&document, &local_hosts(&document), &repository.root)
        }
        _ => false,
    };
    Ok(check_report(
        &shown,
        &found,
        &facts,
        (&state, configured, repository_mapped),
    ))
}

/// The `--check --json` object.
fn check_report(
    shown: &Path,
    found: &Result<Repository>,
    facts: &[HarnessFact],
    (state, configured, repository_mapped): (&Path, bool, bool),
) -> Value {
    let repository = match found {
        Ok(repository) => {
            let (branch, detached) = match &repository.start {
                Start::Branch(branch) => (Some(branch.clone()), None),
                Start::Commit(commit) => (None, Some(commit.clone())),
            };
            json!({
                "directory": shown,
                "git": true,
                "root": repository.root,
                "name": repository.name,
                "has_commits": true,
                "branch": branch,
                "detached_commit": detached,
                "fix": null,
                "fix_command": null,
            })
        }
        Err(error) => {
            let problem = error.downcast_ref::<RepositoryProblem>();
            let no_commits = match problem {
                Some(RepositoryProblem::NoCommits(root)) => Some(root.clone()),
                _ => None,
            };
            json!({
                "directory": shown,
                "git": no_commits.is_some(),
                "root": no_commits,
                "name": null,
                "has_commits": false,
                "branch": null,
                "detached_commit": null,
                "fix": format!("{error:#}"),
                "fix_command": problem.and_then(RepositoryProblem::command),
            })
        }
    };
    let mut ready_harness = false;
    let harnesses: Vec<Value> = facts
        .iter()
        .map(|fact| {
            let node_problem = fact.node.clone().flatten();
            let (fix, fix_command) = if !fact.installed {
                (
                    Some(install_line(fact.harness, state)),
                    install_command(fact.harness),
                )
            } else if let Some(problem) = &fact.version {
                (
                    Some(format!(
                        "{problem}: update it with claude update, then check again."
                    )),
                    Some("claude update"),
                )
            } else if fact.timed_out || fact.signed_in == Some(false) {
                let problem = sign_in_problem(fact.harness, fact.timed_out);
                (Some(problem.fix), problem.command)
            } else {
                (node_problem.clone(), None)
            };
            ready_harness |=
                fact.signed_in == Some(true) && node_problem.is_none() && fact.version.is_none();
            json!({
                "harness": fact.harness.harness(),
                "installed": fact.installed,
                "signed_in": fact.signed_in,
                "node": fact.node.as_ref().map(|problem| json!({
                    "ok": problem.is_none(),
                    "fix": problem,
                })),
                "install_url": install_url(fact.harness),
                "fix": fix,
                "fix_command": fix_command,
            })
        })
        .collect();
    json!({
        "version": 1,
        "ready": found.is_ok() && ready_harness,
        "repository": repository,
        "harnesses": harnesses,
        "state": {
            "directory": state,
            "configured": configured,
            "repository_mapped": repository_mapped,
        },
    })
}

/// The `--check` report as people read it, from its JSON object.
fn check_text(report: &Value) -> String {
    let text = |value: &Value| crate::terminal::text(value.as_str().unwrap_or_default());
    let mut out = String::new();
    let repository = &report["repository"];
    if repository["fix"].is_null() {
        let at = match repository["branch"].as_str() {
            Some(_) => format!("branch {}", text(&repository["branch"])),
            None => format!("commit {}", text(&repository["detached_commit"])),
        };
        out.push_str(&format!(
            "Repository: {} ({at})\n",
            text(&repository["root"])
        ));
    } else {
        out.push_str(&format!("Repository: {}\n", text(&repository["fix"])));
    }
    out.push_str("Harnesses:\n");
    for harness in report["harnesses"].as_array().into_iter().flatten() {
        let status = match (&harness["fix"], harness["installed"].as_bool()) {
            (Value::Null, Some(true)) if harness["signed_in"] == true => "ready".to_owned(),
            (Value::Null, Some(true)) => "installed; sign-in not checked".to_owned(),
            (fix, _) => text(fix),
        };
        out.push_str(&format!("  {}: {status}\n", text(&harness["harness"])));
    }
    let state = &report["state"];
    out.push_str(&match (
        state["configured"].as_bool(),
        state["repository_mapped"].as_bool(),
    ) {
        (Some(true), Some(true)) => format!(
            "SuperTag: set up in {}, with this repository.\n",
            text(&state["directory"])
        ),
        (Some(true), _) => format!(
            "SuperTag: set up in {}; supertag init adds this repository.\n",
            text(&state["directory"])
        ),
        _ => format!(
            "SuperTag: not set up yet in {}.\n",
            text(&state["directory"])
        ),
    });
    out.push_str(if report["ready"] == true {
        "Ready: run supertag init here to set up and start SuperTag.\n"
    } else {
        "Not ready: fix what is named above, then check again.\n"
    });
    out
}

pub(crate) async fn up(state: &Path, config: local_config::Config) -> Result<()> {
    lifecycle::up(lifecycle::Background {
        state: state.to_owned(),
        args: vec![
            "up".into(),
            "--state-directory".into(),
            state.as_os_str().to_owned(),
            "--file".into(),
            config.path.clone().into_os_string(),
        ],
        config: Some(config),
        force: false,
    })
    .await
}

fn report(harness: Found, signed_in: bool) {
    outln!(
        "  {}: {}",
        harness.harness(),
        if signed_in {
            "signed in"
        } else {
            "not signed in"
        }
    );
}

fn answers(
    mut ask: Option<&mut Prompter>,
    installed: &[Found],
    signed_in: &[Found],
    repository: &Repository,
    chosen: Option<Found>,
    opencode: Opencode<'_>,
    state: &Path,
) -> Result<Answers> {
    let free = (DEFAULT_PORT..=u16::MAX)
        .find(|port| port_free(*port))
        .context("no free local port for the Control Plane")?;
    let port = match ask.as_deref_mut() {
        None => free,
        Some(prompter) => loop {
            let answer = prompter.ask("Control Plane port", &free.to_string())?;
            match answer.parse::<u16>() {
                Ok(port) if port > 0 && port_free(port) => break port,
                Ok(port) if port > 0 => outln!("Port {port} is in use; choose another."),
                _ => outln!("Enter a port number from 1 to 65535."),
            }
        },
    };
    // Prefer a signed-in harness; with --yes, only a signed-in one that needs no model answer.
    let default = chosen
        .as_ref()
        .or(signed_in.first())
        .or_else(|| {
            installed
                .iter()
                .find(|harness| **harness != Found::Opencode)
        })
        .copied()
        .unwrap_or(installed[0]);
    let harness = match ask.as_deref_mut() {
        Some(prompter) if installed.len() > 1 && chosen.is_none() => {
            let names: Vec<_> = installed.iter().map(|harness| harness.harness()).collect();
            outln!("Harnesses on this machine: {}", names.join(", "));
            loop {
                let answer = prompter.ask("Harness for this machine", default.harness())?;
                if let Some(found) = installed.iter().find(|harness| harness.harness() == answer) {
                    break *found;
                }
                outln!("Choose one of: {}", names.join(", "));
            }
        }
        _ => default,
    };
    let model = match (harness, opencode.model) {
        (Found::Opencode, Some(model)) => Some(model.to_owned()),
        (Found::Opencode, None) => Some(opencode_model(ask.as_deref_mut(), opencode.usable)?),
        _ => None,
    };
    // Claude Code's own sandbox, where it can start, runs the lead's commands without asking.
    let sandbox = match harness {
        Found::ClaudeCode => Some(claude_sandbox_problem()),
        _ => None,
    };
    if let Some(Some(problem)) = &sandbox {
        outln!("  Claude Code's sandbox can't run the lead's commands on this machine: {problem}.");
    }
    let runtime = matches!(harness, Found::ClaudeCode | Found::Cursor | Found::Opencode)
        .then(container_runtime)
        .flatten();
    let commands = match (runtime, ask.as_deref_mut()) {
        _ if sandbox == Some(None) => {
            outln!(
                "  claude-code runs the lead's commands in its own sandbox (sandbox-commands): they write only the Workspace, can't read hidden paths or your credential folders such as ~/.ssh, and reach the network only through the lead's web:fetch."
            );
            Commands::Sandboxed
        }
        (Some(runtime), Some(prompter)) => {
            let name = harness.harness();
            outln!(
                "{name} has no sandbox of its own. SuperTag can run its commands and file tools in a container on {runtime} (local-vm), with no network and none of your files but the Workspace. The first Task builds the container image, which takes a few minutes."
            );
            if prompter.confirm(
                &format!("Run {name}'s Tasks in local-vm containers?"),
                false,
            )? {
                Commands::LocalVm
            } else {
                unsandboxed(harness, model.as_deref(), Some(prompter), state)?
            }
        }
        (_, prompter) => unsandboxed(harness, model.as_deref(), prompter, state)?,
    };
    let workspace = match ask.as_deref_mut() {
        None => repository.name.clone(),
        Some(prompter) => loop {
            let answer = prompter.ask("Workspace name", &repository.name)?;
            match sanitize(&answer).filter(|name| *name == answer) {
                Some(name) => break name,
                None => outln!("Use lowercase letters, digits and hyphens."),
            }
        },
    };
    let tag = match ask {
        None => "lead".to_owned(),
        Some(prompter) => loop {
            let answer = prompter.ask("Lead Tag name", "lead")?;
            match sanitize(&answer).filter(|name| *name == answer) {
                Some(name) => break name,
                None => outln!("Use lowercase letters, digits and hyphens."),
            }
        },
    };
    outln!("  {}", web_access_line(harness, commands));
    Ok(Answers {
        port,
        harness,
        // Set once the lead's harness is known to be signed in.
        also: Vec::new(),
        model,
        // Set once the model's sign-in is found.
        opencode_auth_file: None,
        commands,
        workspace,
        tag,
    })
}

/// Why OpenCode can't run on this machine, and what to do, or `None` when it can: SuperTag runs it
/// through Node.js and the OpenCode Node bridge installed beside this supertag.
fn opencode_problem() -> Option<(String, String)> {
    use crate::node_bridges::{NodeBridge, bridge_problem, node_problem};
    #[cfg(feature = "test-fixtures")]
    if std::env::var_os("SUPERTAG_TEST_INIT_OPENCODE_RUNS").is_some() {
        return None;
    }
    if let Some(problem) = node_problem(NodeBridge::Opencode) {
        return Some((
            format!("{problem}; SuperTag runs OpenCode through Node.js 22.13 or later"),
            "Install it from https://nodejs.org/en/download, then run supertag init again.".into(),
        ));
    }
    bridge_problem(NodeBridge::Opencode).map(|problem| {
        (
            problem.cause,
            format!("{}, then run supertag init again.", problem.fix),
        )
    })
}

/// What `answers` needs to choose an OpenCode lead's model.
struct Opencode<'a> {
    /// `--model`.
    model: Option<&'a str>,
    /// Whether the Worker Host would have a sign-in for a model, or it is a free one.
    usable: &'a dyn Fn(&str) -> bool,
}

/// OpenCode models SuperTag has run real work on, in the order init prefers them as the default.
const OPENCODE_MODELS: [&str; 3] = [
    "opencode-go/kimi-k3",
    "opencode-go/glm-5.3",
    "opencode/deepseek-v4.1-flash-free",
];

/// How long `opencode models` may take.
const OPENCODE_MODELS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The models `opencode models` lists, one `provider/model` a line, or `None` when it fails.
/// It runs outside the repository, so no project configuration of OpenCode's loads.
fn opencode_models() -> Option<Vec<String>> {
    let mut child = Command::new("opencode")
        .arg("models")
        .current_dir(std::env::temp_dir())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        io::Read::read_to_string(&mut stdout, &mut text).map(|_| text)
    });
    let deadline = std::time::Instant::now() + OPENCODE_MODELS_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let text = reader.join().ok()?.ok()?;
    status.success().then(|| opencode_model_lines(&text))
}

/// The `provider/model` lines of `opencode models`' output.
fn opencode_model_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| supertag_worker_host::validate_opencode_model(line).is_ok())
        .map(str::to_owned)
        .collect()
}

/// The default OpenCode model among those listed: a tested one the host has a sign-in for, then
/// any model of a signed-in provider, then any of OpenCode Zen's free models.
fn default_opencode_model(listed: &[String], usable: &dyn Fn(&str) -> bool) -> Option<String> {
    let listed_and_usable =
        |model: &str| listed.iter().any(|known| known == model) && usable(model);
    OPENCODE_MODELS
        .iter()
        .find(|model| listed_and_usable(model))
        .map(|model| (*model).to_owned())
        .or_else(|| {
            listed
                .iter()
                .find(|model| !model.starts_with("opencode/") && usable(model))
                .cloned()
        })
        .or_else(|| {
            listed
                .iter()
                .find(|model| model.starts_with("opencode/") && model.ends_with("-free"))
                .cloned()
        })
}

/// The OpenCode lead's model: asked, offering the signed-in models `opencode models` lists, or
/// with `--yes` the default.
fn opencode_model(ask: Option<&mut Prompter>, usable: &dyn Fn(&str) -> bool) -> Result<String> {
    outln!("Listing OpenCode's models (opencode models)...");
    let listed = opencode_models().unwrap_or_default();
    let default = default_opencode_model(&listed, usable);
    let Some(prompter) = ask else {
        return default.ok_or_else(|| {
            Fixable {
                error: "supertag init found no OpenCode model to choose.".into(),
                fix: "Add --model provider/model, such as opencode-go/glm-5.3; opencode models lists them.".into(),
                command: Some("opencode models"),
            }
            .into()
        });
    };
    let ready: Vec<&str> = listed
        .iter()
        .map(String::as_str)
        .filter(|model| usable(model))
        .collect();
    if !ready.is_empty() {
        const SHOWN: usize = 8;
        let more = match ready.len().saturating_sub(SHOWN) {
            0 => String::new(),
            more => format!(", and {more} more"),
        };
        outln!(
            "OpenCode models you can use now: {}{more}. opencode models lists every model.",
            ready[..ready.len().min(SHOWN)].join(", ")
        );
    }
    loop {
        let answer = prompter.ask(
            "OpenCode model, as provider/model",
            default.as_deref().unwrap_or_default(),
        )?;
        if supertag_worker_host::validate_opencode_model(&answer).is_ok() {
            return Ok(answer);
        }
        outln!("Enter the model as provider/model, such as opencode-go/glm-5.3.");
    }
}

/// OpenCode's sign-in file at its usual path, and which providers it holds, when it exists.
struct OpencodeAuth {
    path: PathBuf,
    /// Why it can't be read, in words, when it can't.
    providers: std::result::Result<
        std::collections::BTreeMap<String, harness_checks::opencode_auth::Entry>,
        String,
    >,
}

impl OpencodeAuth {
    fn at_usual_path() -> Option<Self> {
        let path = harness_checks::opencode_auth::usual_path()?;
        std::fs::symlink_metadata(&path).ok()?;
        let providers =
            harness_checks::opencode_auth::providers(&path).map_err(|error| error.to_string());
        Some(Self { path, providers })
    }
}

/// Where an OpenCode lead's Worker Host gets the provider's key.
#[derive(Debug, PartialEq, Eq)]
enum OpencodeKey {
    /// The provider's API key in OpenCode's sign-in file, which the host names.
    File(PathBuf),
    /// The provider's key variable, in the environment or the env_file.
    Variable(&'static str),
    /// No key: OpenCode Zen's free models.
    None,
}

impl OpencodeKey {
    fn describe(&self, model: &str) -> String {
        let provider = model
            .split_once('/')
            .map_or(model, |(provider, _)| provider);
        match self {
            Self::File(path) => format!(
                "opencode: {provider}'s API key comes from OpenCode's sign-in file, {}, as opencode-auth-file.",
                path.display()
            ),
            Self::Variable(variable) => {
                format!("opencode: {provider}'s API key comes from {variable}.")
            }
            Self::None => format!("opencode: {model} needs no sign-in."),
        }
    }
}

/// Where the Worker Host gets the key for an OpenCode `model`: the provider's API-key entry in
/// OpenCode's sign-in file `auth`, then its key `variable` when set, then none for OpenCode Zen.
/// Otherwise, how to sign in. Reads only which providers the file holds, never a key.
fn opencode_key(
    model: &str,
    auth: Option<&OpencodeAuth>,
    variable: Option<&'static str>,
    state: &Path,
) -> std::result::Result<OpencodeKey, Fixable> {
    use harness_checks::opencode_auth::{Entry, private_problem};
    let provider = model
        .split_once('/')
        .map_or(model, |(provider, _)| provider);
    let entry = auth.and_then(|auth| auth.providers.as_ref().ok()?.get(provider).copied());
    if let (Some(Entry::ApiKey), Some(auth)) = (entry, auth) {
        if let Some(problem) = private_problem(&auth.path) {
            return Err(Fixable {
                error: format!("OpenCode's sign-in file can't be used: {problem}."),
                fix: format!(
                    "Run chmod 600 {}, then run supertag init again.",
                    auth.path.display()
                ),
                command: None,
            });
        }
        return Ok(OpencodeKey::File(auth.path.clone()));
    }
    if let Some(variable) = variable {
        return Ok(OpencodeKey::Variable(variable));
    }
    if provider == "opencode" {
        return Ok(OpencodeKey::None);
    }
    let why = match (auth, entry) {
        (
            Some(OpencodeAuth {
                path,
                providers: Err(problem),
            }),
            _,
        ) => format!(
            "OpenCode's sign-in file {} can't be read: {problem}",
            path.display()
        ),
        (_, Some(_)) => format!(
            "OpenCode's {provider} sign-in is not an API key, and SuperTag uses only API keys, not OAuth"
        ),
        _ => format!("OpenCode has no {provider} sign-in"),
    };
    let variable =
        supertag_worker_host::provider_environment_for(HarnessKind::Opencode, Some(model))
            .ok()
            .and_then(|names| names.first().copied());
    let or_variable = variable
        .map(|variable| format!(", or set {variable} in {}", state.join(".env").display()))
        .unwrap_or_default();
    Err(Fixable {
        error: format!("{why}."),
        fix: format!(
            "Sign in with opencode auth login, choosing {provider} and an API key{or_variable}, then run supertag init again."
        ),
        command: Some("opencode auth login"),
    })
}

/// Why init stops when OpenCode's check turn with `model` fails.
fn opencode_turn_failed(model: &str, timed_out: bool) -> Fixable {
    if timed_out {
        return Fixable {
            error: "Couldn't check the opencode sign-in.".into(),
            fix: timed_out_line(),
            command: None,
        };
    }
    Fixable {
        error: format!("OpenCode's check turn with {model} didn't succeed."),
        fix: format!(
            "Check the model and its sign-in outside SuperTag with opencode run -m {model} \"Reply with OK only.\", then run supertag init again."
        ),
        command: None,
    }
}

/// What an unsandboxed OpenCode lead's commands can read: the provider proxy keeps only an
/// anthropic or openai key in the Worker.
fn opencode_key_caveat(model: &str) -> Option<String> {
    let provider = model.split_once('/')?.0;
    (!matches!(provider, "anthropic" | "openai")).then(|| {
        format!(
            "Those commands can read {provider}'s key: SuperTag keeps only an anthropic or openai key in the Worker. With environment: local-vm, the key stays out of their reach."
        )
    })
}

/// Whether a harness without a container runs commands on this machine, unsandboxed. Codex
/// sandboxes its own. The suggestion is local-vm containers; running commands without a sandbox
/// takes an explicit yes, which `--yes` never gives.
/// How to let a harness without a sandbox run commands after setup.
const ENABLE_COMMANDS: &str = "To let it run commands later, see https://github.com/atemaguer/supertag/blob/main/docs/operations/cli.md#let-the-lead-run-commands";

fn unsandboxed(
    harness: Found,
    model: Option<&str>,
    ask: Option<&mut Prompter>,
    state: &Path,
) -> Result<Commands> {
    Ok(match (harness, ask) {
        (Found::ClaudeCode | Found::Opencode | Found::Cursor, Some(prompter)) => {
            let name = harness.harness();
            outln!(
                "{name} has no sandbox of its own, so by default the lead Tag reads and edits files in your repository's checkout but runs no commands. Codex sandboxes its commands."
            );
            if prompter.confirm(
                &format!("Allow {name} to run commands without a sandbox?"),
                false,
            )? {
                outln!("  {}", supertag_worker_host::unsandboxed_caveat(name));
                if matches!(harness, Found::ClaudeCode) {
                    outln!(
                        "  Those commands can read a Claude Code sign-in made with /login. With ANTHROPIC_API_KEY in {} instead, the key stays in the Worker and Claude Code gets a stand-in.",
                        state.join(".env").display()
                    );
                }
                if let Some(line) = model.and_then(opencode_key_caveat) {
                    outln!("  {line}");
                }
                Commands::Unsandboxed
            } else {
                outln!("  {ENABLE_COMMANDS}");
                Commands::Unset
            }
        }
        (Found::ClaudeCode | Found::Opencode | Found::Cursor, None) => {
            outln!(
                "  {} has no sandbox of its own, so the lead Tag reads and edits files but runs no commands. {ENABLE_COMMANDS}",
                harness.harness()
            );
            Commands::Unset
        }
        (Found::Codex, _) => Commands::Unset,
    })
}

/// Whether init gives the lead `web:fetch`: every lead but a Cursor one, which has no web fetch
/// tool and runs no Task that may use one, and one in local-vm containers, which have no network
/// and run no Task that may fetch from the web without a network scope.
fn web_access(harness: Found, commands: Commands) -> bool {
    harness != Found::Cursor && commands != Commands::LocalVm
}

/// What init says about the lead's web access.
fn web_access_line(harness: Found, commands: Commands) -> String {
    if harness == Found::Cursor {
        return "The lead has no web:fetch: Cursor has no tool for reading web pages.".to_owned();
    }
    if !web_access(harness, commands) {
        return "The lead has no web:fetch: local-vm containers have no network, and run no Task that may fetch from any site. To let its commands reach named sites, grant web:fetch with a network scope: https://github.com/atemaguer/supertag/blob/main/docs/reference/iam.md#network-scopes".to_owned();
    }
    let codex = if harness == Found::Codex {
        " Current Codex models need it to run commands; without it, select a Codex model that isn't code-mode-only."
    } else {
        ""
    };
    format!(
        "Gave the lead web:fetch: it can read web pages, and its commands can reach the network. Web pages can carry instructions, so for a Tag that handles secrets, remove web:fetch from supertag.yaml.{codex}"
    )
}

/// A Context Set that loads every Skill the Task's Worker Host has: the user's, the
/// repository's, and any catalog the host names.
fn skills_context_set() -> Value {
    json!({
        "apiVersion": "supertag/v1",
        "kind": "ContextSet",
        "metadata": { "name": CONTEXT_SET },
        "spec": {
            "items": [{
                "itemKey": "skill:all",
                "type": "supertag/skill",
                "version": 1,
                "required": false,
                "config": { "reference": "*" },
            }],
        },
    })
}

/// On an existing setup from before resource IDs were DNS labels: renames the Role init created,
/// `Lead`, to `lead` in its manifest and in every Tag's `roles`, since `supertag up` refuses the
/// old name. A setup without that Role, or that already declares a Role `lead`, is left alone.
fn rename_role(path: &Path) -> Result<()> {
    use crate::manifests::INIT_ROLE_BEFORE_IDS as OLD;
    let text = std::fs::read_to_string(path)?;
    let mut document = yaml_document(&text)?;
    let Some(manifests) = document["services"]["control-plane"]["provision"].as_array_mut() else {
        return Ok(());
    };
    let named = |manifest: &Value, name: &str| {
        manifest["kind"] == "Role" && manifest["metadata"]["name"] == name
    };
    let Some(role) = manifests.iter().position(|manifest| named(manifest, OLD)) else {
        return Ok(());
    };
    if manifests.iter().any(|manifest| named(manifest, ROLE)) {
        return Ok(());
    }
    if !rewritable(&text) {
        outln!(
            "\nsupertag up refuses the Role name {OLD}: IDs are now lowercase. In {}, set that Role's metadata.name to {ROLE}, write {ROLE} for {OLD} in each Tag's roles, and run supertag up.",
            path.display()
        );
        return Ok(());
    }
    manifests[role]["metadata"]["name"] = json!(ROLE);
    for manifest in manifests.iter_mut() {
        if manifest["kind"] != "Tag" {
            continue;
        }
        for reference in manifest["spec"]["roles"]
            .as_array_mut()
            .into_iter()
            .flatten()
        {
            if *reference == OLD {
                *reference = json!(ROLE);
            }
        }
    }
    rewrite(path, &document).context("renaming Role Lead would make supertag.yaml invalid")?;
    outln!(
        "Renamed Role {OLD} to {ROLE}, since IDs are now lowercase. supertag up gives your Tags Role {ROLE}, and they keep the old Role {OLD} until you deactivate it: see supertag get role-assignment --role {OLD}."
    );
    Ok(())
}

/// On an existing setup from before init gave the lead's Role every Skill: adds the `skills`
/// Context Set to the Role, so the Tags with it load the user's and the repository's Skills. A
/// setup that already has it, has no such Role, or names something else `skills` is left alone.
fn add_skills(path: &Path) -> Result<()> {
    let text = std::fs::read_to_string(path)?;
    let mut document = yaml_document(&text)?;
    let Some(manifests) = document["services"]["control-plane"]["provision"].as_array_mut() else {
        return Ok(());
    };
    if manifests
        .iter()
        .any(|manifest| manifest["metadata"]["name"] == CONTEXT_SET)
    {
        return Ok(());
    }
    let Some(role) = manifests
        .iter()
        .position(|manifest| manifest["kind"] == "Role" && manifest["metadata"]["name"] == ROLE)
    else {
        return Ok(());
    };
    if !rewritable(&text) {
        outln!(
            "\nTo let your Tags load your Skills, add a ContextSet {CONTEXT_SET} with one supertag/skill item whose reference is \"*\" to {}, list it in Role {ROLE}'s contextSets, and run supertag up.",
            path.display()
        );
        return Ok(());
    }
    let spec = &mut manifests[role]["spec"];
    match spec["contextSets"].as_array_mut() {
        Some(sets) => sets.push(json!(CONTEXT_SET)),
        None => spec["contextSets"] = json!([CONTEXT_SET]),
    }
    manifests.insert(role, skills_context_set());
    rewrite(path, &document)
        .context("adding the skills Context Set would make supertag.yaml invalid")?;
    outln!(
        "Gave Role {ROLE} the Context Set {CONTEXT_SET}, so its Tags load your Skills and the repository's."
    );
    Ok(())
}

fn document(answers: &Answers, repository: &Repository) -> Value {
    let harness = answers.harness.harness();
    let mut execution = json!({ "harness": harness });
    if let Some(model) = &answers.model {
        execution["models"] = json!([model]);
    }
    // The lead's harness first, then the others signed in, so a Tag created later, in the
    // desktop app or with supertag tag put, may run on any of them.
    let harnesses: Vec<&str> = [answers.harness]
        .iter()
        .chain(&answers.also)
        .map(|found| found.harness())
        .collect();
    let mut host = json!({
        "type": "host",
        "harnesses": harnesses,
        "concurrency": CONCURRENCY,
        "workspaces": { answers.workspace.clone(): repository.root },
    });
    if let Some(model) = &answers.model {
        host["models"] = json!({ harness: model });
    }
    if let Some(path) = &answers.opencode_auth_file {
        host["opencode-auth-file"] = json!(path);
    }
    match answers.commands {
        Commands::Sandboxed => host["sandbox-commands"] = json!([harness]),
        Commands::LocalVm => host["environment"] = json!("local-vm"),
        Commands::Unsandboxed => host["allow-unsandboxed-commands"] = json!([harness]),
        Commands::Unset => {}
    }
    // A harness without a sandbox, on a host that may not run its commands, gets no
    // commands:execute: every Task with it would wait for a host that can run commands.
    let commands = answers.harness == Found::Codex || answers.commands != Commands::Unset;
    // files:write does not imply files:read: Claude Code's Read, Glob and Grep need it.
    let mut permissions = vec![
        json!({ "target": "runtime", "action": "files:read" }),
        json!({ "target": "runtime", "action": "files:write" }),
        json!({ "target": "runtime", "action": "schedule:create" }),
    ];
    if commands {
        permissions.insert(
            0,
            json!({ "target": "runtime", "action": "commands:execute" }),
        );
    }
    // Every lead may read web pages, and its commands reach the network. Current Codex models
    // also need it: they run commands only in code mode, which SuperTag starts only for a Task
    // that may fetch from the web.
    if web_access(answers.harness, answers.commands) {
        permissions.push(json!({ "target": "runtime", "action": "web:fetch" }));
    }
    let mut document = json!({
        "version": 1,
        "name": lifecycle::DEFAULT_INSTANCE,
        "services": {
            "control-plane": {
                "type": "control-plane",
                "ports": [format!("127.0.0.1:{}", answers.port)],
                "provision": [
                    {
                        "apiVersion": "supertag/v1",
                        "kind": "PermissionSet",
                        "metadata": { "name": PERMISSION_SET },
                        "spec": { "permissions": permissions },
                    },
                    skills_context_set(),
                    {
                        "apiVersion": "supertag/v1",
                        "kind": "Role",
                        "metadata": { "name": ROLE },
                        "spec": {
                            "purpose": "Own Objectives for this repository: plan the work, make and verify changes, and report what changed.",
                            "permissionSets": [PERMISSION_SET],
                            "contextSets": [CONTEXT_SET],
                        },
                    },
                    {
                        "apiVersion": "supertag/v1",
                        "kind": "Tag",
                        "metadata": { "name": answers.tag },
                        "spec": {
                            "lead": true,
                            "roles": [ROLE],
                            "execution": execution,
                            "workspace": repository.start.binding(&answers.workspace),
                        },
                    },
                ],
            },
            machine_name(): host,
        },
    });
    // Schedules read times in the machine's zone, which the Control Plane may not see as a service.
    if let Ok(zone) = iana_time_zone::get_timezone() {
        document["services"]["control-plane"]["time-zone"] = json!(zone);
    }
    document
}

#[cfg(test)]
mod tests {
    #[test]
    fn claude_code_versions_are_read_and_compared_with_the_minimum() {
        assert_eq!(
            super::claude_version("2.1.323 (Claude Code)\n"),
            Some((2, 1, 323))
        );
        assert_eq!(super::claude_version("2.1.280"), Some((2, 1, 280)));
        assert_eq!(super::claude_version("Claude Code"), None);
        assert_eq!(super::claude_version(""), None);
        assert!((2, 1, 279) < super::CLAUDE_CODE_MINIMUM);
        assert!((2, 1, 280) >= super::CLAUDE_CODE_MINIMUM);
        assert!((2, 2, 0) > super::CLAUDE_CODE_MINIMUM);
    }

    use super::*;

    #[test]
    fn check_reports_the_folder_harnesses_and_setup_with_one_fix_line_each() {
        let repository = Ok(Repository {
            root: PathBuf::from("/work/app"),
            name: "app".into(),
            start: Start::Branch("main".into()),
        });
        let facts = [
            HarnessFact {
                harness: Found::Codex,
                installed: true,
                signed_in: Some(false),
                timed_out: false,
                node: None,
                version: None,
            },
            HarnessFact {
                harness: Found::ClaudeCode,
                installed: true,
                signed_in: Some(true),
                timed_out: false,
                node: Some(None),
                version: None,
            },
            HarnessFact {
                harness: Found::Cursor,
                installed: false,
                signed_in: None,
                timed_out: false,
                node: Some(Some("Node.js: Node.js is not on PATH".into())),
                version: None,
            },
        ];
        let state = Path::new("/home/me/.supertag");
        let value = check_report(
            Path::new("/work/app"),
            &repository,
            &facts,
            (state, false, false),
        );
        assert_eq!(value["version"], 1);
        assert_eq!(value["ready"], true, "{value}");
        assert_eq!(value["repository"]["branch"], "main");
        assert!(value["repository"]["detached_commit"].is_null());
        assert!(value["repository"]["fix"].is_null());
        let harnesses = value["harnesses"].as_array().unwrap();
        assert_eq!(harnesses[0]["harness"], "codex");
        assert!(harnesses[0]["node"].is_null(), "Codex needs no Node");
        let codex_fix = harnesses[0]["fix"].as_str().unwrap();
        assert!(codex_fix.starts_with("Codex: run codex"), "{codex_fix}");
        assert!(!codex_fix.contains('\n'), "one line: {codex_fix}");
        let command = harnesses[0]["fix_command"].as_str().unwrap();
        assert!(codex_fix.contains(command), "{codex_fix} copies {command}");
        assert_eq!(
            harnesses[0]["install_url"],
            "https://developers.openai.com/codex/cli"
        );
        assert_eq!(harnesses[1]["signed_in"], true);
        assert_eq!(harnesses[1]["node"]["ok"], true);
        assert!(harnesses[1]["fix"].is_null());
        assert_eq!(harnesses[2]["installed"], false);
        assert!(harnesses[2]["signed_in"].is_null());
        assert_eq!(harnesses[2]["node"]["ok"], false);
        assert!(harnesses[2]["fix_command"].is_null(), "Cursor needs a key");
        assert_eq!(value["state"]["configured"], false);
        // `--check` without --json reads the same report as text.
        let text = check_text(&value);
        assert!(
            text.starts_with("Repository: /work/app (branch main)\n"),
            "{text}"
        );
        assert!(text.contains("\n  codex: Codex: run codex"), "{text}");
        assert!(text.contains("\n  claude-code: ready\n"), "{text}");
        assert!(
            text.contains("SuperTag: not set up yet in /home/me/.supertag.\n")
                && text.ends_with("Ready: run supertag init here to set up and start SuperTag.\n"),
            "{text}"
        );

        // A signed-in harness whose Node can't run is not ready, and says so.
        let facts = [HarnessFact {
            harness: Found::ClaudeCode,
            installed: true,
            signed_in: Some(true),
            timed_out: false,
            node: Some(Some("Node.js: Node.js is not on PATH".into())),
            version: None,
        }];
        let value = check_report(
            Path::new("/work/app"),
            &repository,
            &facts,
            (state, true, true),
        );
        assert_eq!(value["ready"], false, "{value}");
        assert_eq!(
            value["harnesses"][0]["fix"],
            "Node.js: Node.js is not on PATH"
        );
        assert_eq!(value["state"]["repository_mapped"], true);

        // A check that ran out of time says nothing about the sign-in.
        let facts = [HarnessFact {
            harness: Found::ClaudeCode,
            installed: true,
            signed_in: None,
            timed_out: true,
            node: Some(None),
            version: None,
        }];
        let value = check_report(
            Path::new("/work/app"),
            &repository,
            &facts,
            (state, true, true),
        );
        assert_eq!(value["ready"], false, "{value}");
        assert!(value["harnesses"][0]["signed_in"].is_null());
        assert!(
            value["harnesses"][0]["fix"]
                .as_str()
                .unwrap()
                .starts_with("Couldn't check the sign-in:"),
            "{value}"
        );
        assert!(value["harnesses"][0]["fix_command"].is_null());

        // A folder that is no repository says what to do, and nothing is ready.
        let missing: Result<Repository> = Err(RepositoryProblem::NotRepository.into());
        let value = check_report(
            Path::new("/tmp/notes"),
            &missing,
            &facts,
            (state, false, false),
        );
        assert_eq!(value["ready"], false);
        assert_eq!(value["repository"]["git"], false);
        assert_eq!(value["repository"]["fix_command"], "git init");
        assert!(
            value["repository"]["fix"]
                .as_str()
                .unwrap()
                .contains("git init"),
            "{value}"
        );
        let empty: Result<Repository> =
            Err(RepositoryProblem::NoCommits(PathBuf::from("/work/new")).into());
        let value = check_report(
            Path::new("/work/new"),
            &empty,
            &facts,
            (state, false, false),
        );
        assert_eq!(value["repository"]["git"], true);
        assert_eq!(value["repository"]["has_commits"], false);
        assert_eq!(value["repository"]["root"], "/work/new");
    }

    #[test]
    fn a_failed_json_init_carries_its_fix_line_and_command() {
        let error: anyhow::Error = sign_in_problem(Found::Codex, false).into();
        let value = failure(&error);
        assert_eq!(value["version"], 1);
        assert_eq!(value["error"], "codex is not signed in.");
        assert!(
            value["fix"]
                .as_str()
                .unwrap()
                .starts_with("Codex: run codex"),
            "{value}"
        );
        assert_eq!(
            value["fix_command"],
            "codex -c 'cli_auth_credentials_store=\"file\"' login"
        );
        let other = failure(&anyhow::anyhow!("disk full"));
        assert_eq!(other["error"], "disk full");
        assert!(other["fix"].is_null() && other["fix_command"].is_null());
    }

    #[test]
    fn names_are_sanitized_to_identifiers() {
        assert_eq!(sanitize("My Repo.git").as_deref(), Some("my-repo-git"));
        assert_eq!(sanitize("--x--").as_deref(), Some("x"));
        assert_eq!(sanitize("..."), None);
        assert_eq!(sanitize(&"a".repeat(80)).map(|name| name.len()), Some(63));
    }

    #[test]
    fn follows_the_current_branch_and_pins_a_detached_head() {
        let head = "4f2c0d1e9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d";
        assert_eq!(
            start(Some("feature/login"), head),
            Start::Branch("feature/login".into())
        );
        assert_eq!(start(None, head), Start::Commit(head.into()));
        // A branch the Tag ref cannot name is pinned like a detached HEAD.
        assert_eq!(start(Some("-odd"), head), Start::Commit(head.into()));
        assert!(start(None, head).describe().contains("HEAD is detached"));
        assert_eq!(
            start(Some("main"), head).describe(),
            "following branch main"
        );
    }

    #[test]
    fn binds_the_lead_tag_to_the_repository_on_its_current_branch() {
        let answers = Answers {
            port: DEFAULT_PORT,
            harness: Found::Codex,
            also: vec![Found::ClaudeCode],
            model: None,
            opencode_auth_file: None,
            commands: Commands::Unset,
            workspace: "app".into(),
            tag: "lead".into(),
        };
        let head = "4f2c0d1e9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d";
        for (start, binding) in [
            (
                Start::Branch("main".into()),
                json!({ "id": "app", "ref": "main" }),
            ),
            (
                Start::Commit(head.into()),
                json!({ "id": "app", "baseCommit": head }),
            ),
        ] {
            let repository = Repository {
                root: PathBuf::from("/work/app"),
                name: "app".into(),
                start,
            };
            let document = document(&answers, &repository);
            let provision = document["services"]["control-plane"]["provision"]
                .as_array()
                .unwrap()
                .clone();
            assert_eq!(provision[3]["spec"]["workspace"], binding);
            // The Tag init creates is the Control Plane's lead Tag.
            assert_eq!(provision[3]["spec"]["lead"], true);
            // Its Role loads every Skill the Worker Host has.
            assert_eq!(provision[1]["kind"], "ContextSet");
            assert_eq!(provision[1]["spec"]["items"][0]["config"]["reference"], "*");
            assert_eq!(provision[1]["spec"]["items"][0]["required"], false);
            assert_eq!(provision[2]["spec"]["contextSets"], json!(["skills"]));
            // A Codex lead may fetch from the web, so it can run commands in Codex code mode.
            let actions: Vec<&str> = provision[0]["spec"]["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|permission| permission["action"].as_str().unwrap())
                .collect();
            assert_eq!(
                actions,
                [
                    "commands:execute",
                    "files:read",
                    "files:write",
                    "schedule:create",
                    "web:fetch"
                ]
            );
            // The host also runs the other signed-in harness, the lead's first.
            assert_eq!(
                document["services"][machine_name()]["harnesses"],
                json!(["codex", "claude-code"])
            );
            // The local host runs three Task Attempts at once across its harnesses.
            assert_eq!(document["services"][machine_name()]["concurrency"], 3);
            let sources = provision
                .into_iter()
                .map(crate::manifests::ProvisionSource::Inline)
                .collect();
            assert_eq!(crate::manifests::validate_provision(sources).unwrap(), 4);
        }
    }

    #[test]
    fn running_init_again_renames_the_role_init_named_lead_before_ids_were_lowercase() {
        use std::os::unix::fs::PermissionsExt as _;
        let temp = tempfile::tempdir().unwrap();
        let repository = Repository {
            root: temp.path().to_path_buf(),
            name: "app".into(),
            start: Start::Branch("main".into()),
        };
        let answers = Answers {
            port: DEFAULT_PORT,
            harness: Found::Codex,
            also: Vec::new(),
            model: None,
            opencode_auth_file: None,
            commands: Commands::Unset,
            workspace: "app".into(),
            tag: "lead".into(),
        };
        // What init wrote before IDs were lowercase and before the skills Context Set.
        let mut old = document(&answers, &repository);
        let provision = old["services"]["control-plane"]["provision"]
            .as_array_mut()
            .unwrap();
        provision.remove(1);
        provision[1]["metadata"]["name"] = json!("Lead");
        provision[1]["spec"]
            .as_object_mut()
            .unwrap()
            .remove("contextSets");
        provision[2]["spec"]["roles"] = json!(["Lead"]);
        let state = temp.path().join("state");
        std::fs::create_dir(&state).unwrap();
        let path = state.join("supertag.yaml");
        std::fs::write(&path, local_config::to_yaml(&old)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        rename_role(&path).unwrap();
        add_skills(&path).unwrap();
        let upgraded = yaml_document(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let provision = upgraded["services"]["control-plane"]["provision"]
            .as_array()
            .unwrap();
        let role = provision
            .iter()
            .find(|manifest| manifest["kind"] == "Role")
            .unwrap();
        assert_eq!(role["metadata"]["name"], ROLE);
        assert_eq!(role["spec"]["contextSets"], json!([CONTEXT_SET]));
        let tag = provision
            .iter()
            .find(|manifest| manifest["kind"] == "Tag")
            .unwrap();
        assert_eq!(tag["spec"]["roles"], json!([ROLE]));
        let sources = provision
            .iter()
            .cloned()
            .map(crate::manifests::ProvisionSource::Inline)
            .collect();
        assert_eq!(crate::manifests::validate_provision(sources).unwrap(), 4);
        // Running init yet again changes nothing.
        let text = std::fs::read_to_string(&path).unwrap();
        rename_role(&path).unwrap();
        add_skills(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn grants_web_fetch_to_every_lead_that_can_use_it() {
        let repository = Repository {
            root: PathBuf::from("/work/app"),
            name: "app".into(),
            start: Start::Branch("main".into()),
        };
        let answers = Answers {
            port: DEFAULT_PORT,
            harness: Found::ClaudeCode,
            also: Vec::new(),
            model: None,
            opencode_auth_file: None,
            commands: Commands::Unsandboxed,
            workspace: "app".into(),
            tag: "lead".into(),
        };
        let document = document(&answers, &repository);
        let permissions =
            &document["services"]["control-plane"]["provision"][0]["spec"]["permissions"];
        assert_eq!(permissions.as_array().unwrap().len(), 5, "{permissions}");
        assert!(
            permissions.to_string().contains("web:fetch"),
            "{permissions}"
        );
        // Init says how to take it away, and why Codex needs it.
        let line = web_access_line(Found::ClaudeCode, Commands::Sandboxed);
        assert!(
            line.contains("remove web:fetch from supertag.yaml"),
            "{line}"
        );
        assert!(!line.contains("Codex"), "{line}");
        assert!(web_access_line(Found::Codex, Commands::Unset).contains("need it to run commands"));
        // A local-vm container has no network, and runs no Task with an unscoped web:fetch.
        let answers = Answers {
            commands: Commands::LocalVm,
            ..answers
        };
        let permissions = super::document(&answers, &repository)["services"]["control-plane"]
            ["provision"][0]["spec"]["permissions"]
            .to_string();
        assert!(!permissions.contains("web:fetch"), "{permissions}");
        assert!(web_access_line(Found::ClaudeCode, Commands::LocalVm).contains("no web:fetch"));
        // Cursor has no web fetch tool, and runs no Task that may use one.
        let answers = Answers {
            harness: Found::Cursor,
            commands: Commands::Unsandboxed,
            ..answers
        };
        let permissions = super::document(&answers, &repository)["services"]["control-plane"]
            ["provision"][0]["spec"]["permissions"]
            .to_string();
        assert!(!permissions.contains("web:fetch"), "{permissions}");
    }

    #[test]
    fn a_lead_whose_host_cannot_run_its_commands_gets_no_commands_execute() {
        let repository = Repository {
            root: PathBuf::from("/work/app"),
            name: "app".into(),
            start: Start::Branch("main".into()),
        };
        let permissions = |harness, commands| {
            let answers = Answers {
                port: DEFAULT_PORT,
                harness,
                also: Vec::new(),
                model: None,
                opencode_auth_file: None,
                commands,
                workspace: "app".into(),
                tag: "lead".into(),
            };
            document(&answers, &repository)["services"]["control-plane"]["provision"][0]["spec"]
                ["permissions"]
                .to_string()
        };
        // Its Tasks would otherwise wait for a host that may run commands, the first reply too.
        assert!(!permissions(Found::ClaudeCode, Commands::Unset).contains("commands:execute"));
        // Without commands, Claude Code reads the repository only with files:read.
        assert!(permissions(Found::ClaudeCode, Commands::Unset).contains("files:read"));
        for (harness, commands) in [
            (Found::ClaudeCode, Commands::Sandboxed),
            (Found::ClaudeCode, Commands::LocalVm),
            (Found::ClaudeCode, Commands::Unsandboxed),
            (Found::Codex, Commands::Unset),
        ] {
            assert!(
                permissions(harness, commands).contains("commands:execute"),
                "{harness:?} {commands:?}"
            );
        }
    }

    #[test]
    fn a_local_vm_host_runs_commands_in_containers_without_the_unsandboxed_opt_in() {
        let repository = Repository {
            root: PathBuf::from("/work/app"),
            name: "app".into(),
            start: Start::Branch("main".into()),
        };
        let answers = Answers {
            port: DEFAULT_PORT,
            harness: Found::ClaudeCode,
            also: Vec::new(),
            model: None,
            opencode_auth_file: None,
            commands: Commands::LocalVm,
            workspace: "app".into(),
            tag: "lead".into(),
        };
        let document = document(&answers, &repository);
        let host = &document["services"][machine_name()];
        assert_eq!(host["environment"], "local-vm");
        assert!(host.get("allow-unsandboxed-commands").is_none(), "{host}");
        let config = local_config::parse(
            local_config::to_yaml(&document).as_bytes(),
            Path::new("/work"),
            |_| None,
        )
        .unwrap();
        assert!(config.hosts[0].local_vm);
    }

    #[test]
    fn a_sandboxed_claude_code_lead_runs_commands_in_claude_codes_sandbox() {
        let repository = Repository {
            root: PathBuf::from("/work/app"),
            name: "app".into(),
            start: Start::Branch("main".into()),
        };
        let answers = Answers {
            port: DEFAULT_PORT,
            harness: Found::ClaudeCode,
            also: Vec::new(),
            model: None,
            opencode_auth_file: None,
            commands: Commands::Sandboxed,
            workspace: "app".into(),
            tag: "lead".into(),
        };
        let document = document(&answers, &repository);
        let host = &document["services"][machine_name()];
        assert_eq!(host["sandbox-commands"], json!(["claude-code"]));
        assert!(host.get("allow-unsandboxed-commands").is_none(), "{host}");
        assert!(host.get("environment").is_none(), "{host}");
        assert!(
            document["services"]["control-plane"]["provision"][0]["spec"]["permissions"]
                .to_string()
                .contains("commands:execute")
        );
        let config = local_config::parse(
            local_config::to_yaml(&document).as_bytes(),
            Path::new("/work"),
            |_| None,
        )
        .unwrap();
        let profile = config.hosts[0].harnesses[0].execution_profile().unwrap();
        assert!(profile.command_sandbox && !profile.allow_unsandboxed_commands);
    }

    #[test]
    fn sandbox_commands_refuses_a_claude_code_older_than_its_sandbox_fixes() {
        use crate::harness::{CLAUDE_SANDBOX_MINIMUM, sandbox_version_problem};
        assert!(sandbox_version_problem(Some(CLAUDE_SANDBOX_MINIMUM)).is_none());
        assert!(sandbox_version_problem(Some((2, 2, 0))).is_none());
        let old = sandbox_version_problem(Some((2, 1, 322))).unwrap();
        assert!(
            old.contains("2.1.323") && old.contains("2.1.322") && old.contains("claude update"),
            "{old}"
        );
        assert!(
            sandbox_version_problem(None)
                .unwrap()
                .contains("claude update")
        );
        assert!(CLAUDE_SANDBOX_MINIMUM >= CLAUDE_CODE_MINIMUM);
    }

    #[test]
    fn prefers_the_macos_local_host_name_over_a_network_assigned_hostname() {
        assert_eq!(
            name_for_machine(Some("Dana-MacBook-Pro\n".into()), "Mac.attlocal.net"),
            "dana-macbook-pro"
        );
        assert_eq!(name_for_machine(None, "Mac.attlocal.net"), "mac");
        assert_eq!(
            name_for_machine(Some(" \n".into()), "build-01.lan"),
            "build-01"
        );
        assert_eq!(name_for_machine(None, "gateway.local"), "this-machine");
        assert_eq!(name_for_machine(None, ""), "this-machine");
    }

    #[derive(clap::Parser)]
    struct Init {
        #[command(flatten)]
        args: InitArgs,
    }

    fn parse(args: &[&str]) -> Result<InitArgs, clap::Error> {
        use clap::Parser as _;
        Init::try_parse_from([&["init"][..], args].concat()).map(|init| init.args)
    }

    #[test]
    fn harness_opencode_takes_a_model_and_model_needs_a_harness() {
        let args = parse(&[
            "--yes",
            "--harness",
            "opencode",
            "--model",
            "opencode-go/glm-5.3",
        ])
        .unwrap();
        assert_eq!(args.harness, Some(InitHarness::Opencode));
        assert_eq!(args.harness.map(InitHarness::found), Some(Found::Opencode));
        assert_eq!(args.model.as_deref(), Some("opencode-go/glm-5.3"));
        assert_eq!(parse(&["--harness", "opencode"]).unwrap().model, None);
        assert!(parse(&["--model", "opencode-go/glm-5.3"]).is_err());
        assert!(
            parse(&[
                "--check",
                "--harness",
                "opencode",
                "--model",
                "opencode-go/glm-5.3"
            ])
            .is_err()
        );
        assert!(parse(&["--harness", "cursor"]).is_err());
    }

    #[test]
    fn reads_the_models_opencode_lists() {
        assert_eq!(
            opencode_model_lines(
                "opencode/big-pickle\nopencode-go/glm-5.3\n\nnot a model\n  openai/gpt-5 \n"
            ),
            ["opencode/big-pickle", "opencode-go/glm-5.3", "openai/gpt-5"]
        );
    }

    #[test]
    fn the_default_opencode_model_is_a_tested_signed_in_one_then_a_signed_in_then_a_free_one() {
        let listed: Vec<String> = [
            "amazon-bedrock/some-model",
            "opencode/big-pickle",
            "opencode/deepseek-v4.1-flash-free",
            "opencode-go/glm-5.3",
            "opencode-go/kimi-k3",
            "openai/gpt-5",
        ]
        .map(str::to_owned)
        .to_vec();
        let signed_in = |providers: &'static [&'static str]| {
            move |model: &str| {
                let provider = model.split_once('/').unwrap().0;
                providers.contains(&provider)
                    || (provider == "opencode" && model.ends_with("-free"))
            }
        };
        assert_eq!(
            default_opencode_model(&listed, &signed_in(&["opencode-go"])).as_deref(),
            Some("opencode-go/kimi-k3")
        );
        assert_eq!(
            default_opencode_model(&listed, &signed_in(&["openai"])).as_deref(),
            Some("opencode/deepseek-v4.1-flash-free"),
            "a tested free model before an untested signed-in one"
        );
        let untested: Vec<String> = ["opencode/beam-free", "openai/gpt-5"]
            .map(str::to_owned)
            .to_vec();
        assert_eq!(
            default_opencode_model(&untested, &signed_in(&["openai"])).as_deref(),
            Some("openai/gpt-5")
        );
        assert_eq!(
            default_opencode_model(&untested, &signed_in(&[])).as_deref(),
            Some("opencode/beam-free")
        );
        assert_eq!(default_opencode_model(&[], &signed_in(&["openai"])), None);
    }

    fn auth_file(directory: &Path, text: &str, mode: u32) -> OpencodeAuth {
        use std::os::unix::fs::PermissionsExt as _;
        let path = directory.join("auth.json");
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        OpencodeAuth {
            providers: harness_checks::opencode_auth::providers(&path)
                .map_err(|error| error.to_string()),
            path,
        }
    }

    #[test]
    fn an_opencode_lead_takes_its_key_from_the_sign_in_file_then_a_variable_then_none() {
        let temporary = tempfile::tempdir().unwrap();
        let state = Path::new("/home/me/.supertag");
        let auth = auth_file(
            temporary.path(),
            r#"{"opencode-go":{"type":"api","key":"fake-go-key"},"anthropic":{"type":"oauth","refresh":"fake-refresh"}}"#,
            0o600,
        );
        // The provider's API key in the file: the host names the file.
        assert_eq!(
            opencode_key("opencode-go/glm-5.3", Some(&auth), None, state).unwrap(),
            OpencodeKey::File(auth.path.clone())
        );
        assert_eq!(
            opencode_key(
                "opencode-go/glm-5.3",
                Some(&auth),
                Some("OPENAI_API_KEY"),
                state
            )
            .unwrap(),
            OpencodeKey::File(auth.path.clone()),
            "the file's entry comes first, as a Task Attempt reads it"
        );
        // A key variable, with no API key in the file: no file.
        assert_eq!(
            opencode_key(
                "anthropic/claude-sonnet-5",
                Some(&auth),
                Some("ANTHROPIC_API_KEY"),
                state
            )
            .unwrap(),
            OpencodeKey::Variable("ANTHROPIC_API_KEY")
        );
        // OpenCode Zen's free models need no key, and no file.
        assert_eq!(
            opencode_key(
                "opencode/deepseek-v4.1-flash-free",
                Some(&auth),
                None,
                state
            )
            .unwrap(),
            OpencodeKey::None
        );
        assert_eq!(
            opencode_key("opencode/deepseek-v4.1-flash-free", None, None, state).unwrap(),
            OpencodeKey::None
        );
        // An OAuth sign-in is refused, with how to sign in, and never the file's contents.
        let refused =
            opencode_key("anthropic/claude-sonnet-5", Some(&auth), None, state).unwrap_err();
        assert!(refused.error.contains("not an API key"), "{refused}");
        assert!(refused.fix.contains("opencode auth login"), "{refused}");
        assert!(
            refused
                .fix
                .contains("ANTHROPIC_API_KEY in /home/me/.supertag/.env"),
            "{refused}"
        );
        assert!(!refused.to_string().contains("fake"), "{refused}");
        // No sign-in at all: stop, saying how to sign in.
        let refused = opencode_key("moonshot/kimi-k3", Some(&auth), None, state).unwrap_err();
        assert_eq!(refused.error, "OpenCode has no moonshot sign-in.");
        assert_eq!(refused.command, Some("opencode auth login"));
        assert!(!refused.fix.contains(".env"), "no variable for {refused}");
        let refused = opencode_key("opencode-go/glm-5.3", None, None, state).unwrap_err();
        assert_eq!(refused.error, "OpenCode has no opencode-go sign-in.");
        // A file the host would refuse: shared with others.
        let shared = auth_file(
            temporary.path(),
            r#"{"opencode-go":{"type":"api","key":"fake-go-key"}}"#,
            0o644,
        );
        let refused = opencode_key("opencode-go/glm-5.3", Some(&shared), None, state).unwrap_err();
        assert!(refused.fix.starts_with("Run chmod 600 "), "{refused}");
        // One it can't read says why, without its contents.
        let broken = auth_file(temporary.path(), "not json fake-go-key", 0o600);
        let refused = opencode_key("opencode-go/glm-5.3", Some(&broken), None, state).unwrap_err();
        assert!(refused.error.contains("is not valid JSON"), "{refused}");
        assert!(!refused.to_string().contains("fake-go-key"), "{refused}");
    }

    #[test]
    fn an_opencode_lead_names_its_model_and_sign_in_file_in_supertag_yaml() {
        let repository = Repository {
            root: PathBuf::from("/work/app"),
            name: "app".into(),
            start: Start::Branch("main".into()),
        };
        let auth = PathBuf::from("/home/me/.local/share/opencode/auth.json");
        let answers = Answers {
            port: DEFAULT_PORT,
            harness: Found::Opencode,
            also: vec![Found::Codex],
            model: Some("opencode-go/glm-5.3".into()),
            opencode_auth_file: Some(auth.clone()),
            commands: Commands::LocalVm,
            workspace: "app".into(),
            tag: "lead".into(),
        };
        let document = document(&answers, &repository);
        let host = &document["services"][machine_name()];
        assert_eq!(host["harnesses"], json!(["opencode", "codex"]));
        assert_eq!(host["models"], json!({ "opencode": "opencode-go/glm-5.3" }));
        assert_eq!(host["opencode-auth-file"], json!(auth));
        assert_eq!(host["environment"], "local-vm");
        let tag = &document["services"]["control-plane"]["provision"][3];
        assert_eq!(
            tag["spec"]["execution"],
            json!({ "harness": "opencode", "models": ["opencode-go/glm-5.3"] })
        );
        let config = local_config::parse(
            local_config::to_yaml(&document).as_bytes(),
            Path::new("/work"),
            |_| None,
        )
        .unwrap();
        let lanes = &config.hosts[0].harnesses;
        assert_eq!(lanes[0].harness_kind(), HarnessKind::Opencode);
        assert_eq!(lanes[0].opencode_auth_file(), Some(auth.as_path()));
        assert_eq!(
            lanes[0].provider_model().as_deref(),
            Some("opencode-go/glm-5.3")
        );
        assert_eq!(
            lanes[1].opencode_auth_file(),
            None,
            "only the OpenCode lane"
        );
        // A free model, or a key from a variable, names no file.
        let answers = Answers {
            model: Some("opencode/deepseek-v4.1-flash-free".into()),
            opencode_auth_file: None,
            commands: Commands::Unset,
            ..answers
        };
        let document = super::document(&answers, &repository);
        let host = &document["services"][machine_name()];
        assert!(host.get("opencode-auth-file").is_none(), "{host}");
        // An OpenCode lead without a sandbox runs no commands.
        let permissions =
            document["services"]["control-plane"]["provision"][0]["spec"]["permissions"]
                .to_string();
        assert!(!permissions.contains("commands:execute"), "{permissions}");
    }

    #[test]
    fn an_unsandboxed_opencode_lead_is_told_which_keys_its_commands_can_read() {
        let line = opencode_key_caveat("opencode-go/glm-5.3").unwrap();
        assert!(
            line.contains("opencode-go's key") && line.contains("local-vm"),
            "{line}"
        );
        assert_eq!(opencode_key_caveat("anthropic/claude-sonnet-5"), None);
        assert_eq!(opencode_key_caveat("openai/gpt-5"), None);
    }
}
