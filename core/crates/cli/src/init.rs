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
const ROLE: &str = "Lead";
/// Task Attempts the local Worker Host runs at once per harness, so one stuck Task does not hold
/// every Tag on that harness.
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
    /// Check this machine and folder without changing anything: whether the folder is a git
    /// repository, which harnesses are installed and signed in, and whether SuperTag is set up.
    #[arg(long, requires = "json", conflicts_with = "yes")]
    check: bool,
    /// Print the result as one JSON object, and progress on standard error. Needs --check or
    /// --yes.
    #[arg(long)]
    json: bool,
}

/// A harness `--harness` may choose.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum InitHarness {
    Codex,
    ClaudeCode,
}

impl InitHarness {
    fn found(self) -> Found {
        match self {
            Self::Codex => Found::Codex,
            Self::ClaudeCode => Found::ClaudeCode,
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
    /// In a container on this machine's Docker (`environment: local-vm`).
    LocalVm,
    /// On this machine, as the operator (`allow-unsandboxed-commands`).
    Unsandboxed,
    /// Neither: Codex sandboxes its own, and another harness's lead gets no commands:execute.
    Unset,
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
    async fn check(&mut self, harness: Found, model: Option<&str>) -> Result<bool> {
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
        let result = harness_checks::probe_sign_in(harness.check(), model, &variables).await;
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

struct Repository {
    root: PathBuf,
    name: String,
    /// Where the lead Tag's Sessions start.
    start: Start,
}

/// Where the lead Tag's Sessions start: the current branch, followed as it moves, or, when HEAD is
/// detached, the checked-out commit.
#[derive(Debug, PartialEq, Eq)]
enum Start {
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
struct Fixable {
    error: String,
    fix: String,
    command: Option<&'static str>,
}

impl std::fmt::Display for Fixable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.error, self.fix)
    }
}

impl std::error::Error for Fixable {}

/// The `--json` object for an init that failed.
fn failure(error: &anyhow::Error) -> Value {
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
enum RepositoryProblem {
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
fn repository(directory: Option<&Path>) -> Result<Repository> {
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
fn sanitize(value: &str) -> Option<String> {
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
    model: Option<String>,
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
        outln!("{}", serde_json::to_string_pretty(&report)?);
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
    if let Some(harness) = named
        && !installed.contains(&harness)
    {
        bail!(Fixable {
            error: format!("{} is not installed on this machine.", harness.harness()),
            fix: install_line(harness).into(),
            command: install_command(harness),
        });
    }
    ensure!(
        !installed.is_empty(),
        "SuperTag runs Tasks with an installed coding agent, and none was found. Install Claude Code or Codex:
  Claude Code: curl -fsSL https://claude.ai/install.sh | bash
  Codex: npm install -g @openai/codex
Sign in to it, then run supertag init again. (OpenCode, with opencode on PATH, and Cursor, with CURSOR_API_KEY set, also work.)"
    );
    if args.yes && installed == [Found::Opencode] {
        bail!(
            "OpenCode is the only harness on this machine, and it needs a model. Run supertag init in a terminal, without --yes, to enter one as provider/model, or install Claude Code or Codex."
        );
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
                let signed_in = sign_ins.check(found, model.as_deref()).await?;
                report(found, signed_in);
                runnable |= signed_in;
                checked.push(found);
            }
        }
        if !checked.is_empty() && !runnable {
            return Err(no_sign_in(&checked));
        }
        up(&state, config).await?;
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
    let mut without_node = false;
    // A named harness is the only one checked.
    for harness in installed
        .iter()
        .filter(|harness| named.is_none_or(|named| named == **harness))
    {
        if *harness == Found::Opencode {
            // `--yes` never selects OpenCode, which needs a model answer first.
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
            without_node = true;
            if named.is_some() {
                bail!(Fixable {
                    error: format!("Claude Code can't run: {problem}."),
                    fix: "Install Node.js 22.13 or later from https://nodejs.org/en/download, then run supertag init again.".into(),
                    command: None,
                });
            }
            continue;
        }
        let result = sign_ins.check(*harness, None).await?;
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
        .filter(|harness| !(without_node && *harness == Found::ClaudeCode))
        .collect();
    ensure!(
        !installed.is_empty(),
        "Claude Code is the only harness on this machine, and it needs Node.js 22.13 or later on PATH. Install that, or install Codex (npm install -g @openai/codex), then run supertag init again."
    );
    if let Some(harness) = named
        && !signed_in.contains(&harness)
    {
        bail!(sign_in_problem(
            harness,
            sign_ins.timed_out.contains(&harness)
        ));
    }
    if prompter.is_none() && signed_in.is_empty() {
        return Err(no_sign_in(&installed));
    }
    if prompter.is_some() {
        outln!("Press Enter to accept the default in [brackets].");
    }
    let answers = answers(
        prompter.as_mut(),
        &installed,
        &signed_in,
        &repository,
        named,
    )?;
    // A harness checked above already said whether it is signed in.
    let checked = sign_ins
        .results
        .iter()
        .any(|(harness, model, _)| *harness == answers.harness && *model == answers.model);
    let result = sign_ins
        .check(answers.harness, answers.model.as_deref())
        .await?;
    if !checked {
        report(answers.harness, result);
    }
    if !result {
        return Err(no_sign_in(&[answers.harness]));
    }
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
        answers.harness.harness(),
        answers.workspace,
        repository.root.display(),
        repository.start.describe()
    );
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
    if text.lines().any(|line| line.trim_start().starts_with('#')) || text.contains("${") {
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
        file.write_all(local_config::to_yaml(&document).as_bytes())?;
        file.sync_all()?;
    }
    let state = path.parent().context("supertag.yaml has no directory")?;
    if let Err(error) = local_config::load(Some(temporary.clone()), state) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.context("adding this repository would make supertag.yaml invalid"));
    }
    std::fs::rename(&temporary, path)?;
    outln!(
        "Added Workspace {name} ({}) to host {host}, and Tag {name}, which works in it on the lead's harness, {}.",
        root.display(),
        repository.start.describe()
    );
    Ok(())
}

/// supertag.yaml as written, without resolving variables.
fn yaml_document(text: &str) -> Result<Value> {
    let options = serde_saphyr::options! {budget:serde_saphyr::budget!{max_documents:1,max_depth:24,max_nodes:10000}};
    serde_saphyr::from_str_with_options(text, options).context("supertag.yaml is not valid YAML")
}

/// The host services of this machine's own Control Plane.
fn local_hosts(document: &Value) -> Vec<String> {
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
fn mapped_workspace(document: &Value, hosts: &[String], root: &Path) -> Option<String> {
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

/// The command that installs a harness, or what to set for Cursor.
fn install_line(harness: Found) -> &'static str {
    match harness {
        Found::Codex => "Install Codex: npm install -g @openai/codex",
        Found::ClaudeCode => "Install Claude Code: npm install -g @anthropic-ai/claude-code",
        Found::Opencode => "Install OpenCode: npm install -g opencode-ai",
        Found::Cursor => {
            "Cursor: generate an API key at https://cursor.com/dashboard/api and set CURSOR_API_KEY in ~/.supertag/.env."
        }
    }
}

/// The command in `install_line`, if it has one.
fn install_command(harness: Found) -> Option<&'static str> {
    match harness {
        Found::Codex => Some("npm install -g @openai/codex"),
        Found::ClaudeCode => Some("npm install -g @anthropic-ai/claude-code"),
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

/// What `--check` found about one harness.
struct HarnessFact {
    harness: Found,
    installed: bool,
    /// `None` when it was not checked: not installed, or OpenCode, whose check needs a model;
    /// or when the check ran out of time.
    signed_in: Option<bool>,
    timed_out: bool,
    /// `None` for a harness without a Node bridge; otherwise why its Node can't run, if it can't.
    node: Option<Option<String>>,
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
            Some(sign_ins.check(harness, None).await?)
        } else {
            None
        };
        let timed_out = sign_ins.timed_out.contains(&harness);
        facts.push(HarnessFact {
            harness,
            installed: is_installed,
            signed_in: signed_in.filter(|_| !timed_out),
            timed_out,
            node: bridge(harness).map(crate::node_bridges::node_problem),
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
                    Some(install_line(fact.harness).to_owned()),
                    install_command(fact.harness),
                )
            } else if fact.timed_out || fact.signed_in == Some(false) {
                let problem = sign_in_problem(fact.harness, fact.timed_out);
                (Some(problem.fix), problem.command)
            } else {
                (
                    node_problem
                        .as_ref()
                        .map(|problem| format!("Node.js: {problem}")),
                    None,
                )
            };
            ready_harness |= fact.signed_in == Some(true) && node_problem.is_none();
            json!({
                "harness": fact.harness.harness(),
                "installed": fact.installed,
                "signed_in": fact.signed_in,
                "node": fact.node.as_ref().map(|problem| json!({
                    "ok": problem.is_none(),
                    "fix": problem.as_ref().map(|problem| format!("Node.js: {problem}")),
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

async fn up(state: &Path, config: local_config::Config) -> Result<()> {
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
    let model = match (harness, ask.as_deref_mut()) {
        (Found::Opencode, Some(prompter)) => Some(loop {
            let answer = prompter.ask("OpenCode model, as provider/model", "")?;
            if answer
                .split_once('/')
                .is_some_and(|(provider, model)| !provider.is_empty() && !model.is_empty())
            {
                break answer;
            }
            outln!("Enter the model as provider/model.");
        }),
        (Found::Opencode, None) => unreachable!("--yes never selects OpenCode"),
        _ => None,
    };
    let runtime = matches!(harness, Found::ClaudeCode | Found::Cursor | Found::Opencode)
        .then(container_runtime)
        .flatten();
    let commands = match (runtime, ask.as_deref_mut()) {
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
                unsandboxed(harness, Some(prompter))?
            }
        }
        (_, prompter) => unsandboxed(harness, prompter)?,
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
    Ok(Answers {
        port,
        harness,
        model,
        commands,
        workspace,
        tag,
    })
}

/// Whether a harness without a container runs commands on this machine, unsandboxed. Codex
/// sandboxes its own. The suggestion is local-vm containers; running commands without a sandbox
/// takes an explicit yes, which `--yes` never gives.
/// How to let a harness without a sandbox run commands after setup.
const ENABLE_COMMANDS: &str = "To let it run commands later, see https://github.com/atemaguer/supertag/blob/main/docs/operations/cli.md#let-the-lead-run-commands";

fn unsandboxed(harness: Found, ask: Option<&mut Prompter>) -> Result<Commands> {
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
                        "  Those commands can read a Claude Code sign-in made with /login. With ANTHROPIC_API_KEY in ~/.supertag/.env instead, the key stays in the Worker Host and Claude Code gets a stand-in."
                    );
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
        (Found::Codex, _) => {
            outln!(
                "  Gave the Codex lead web:fetch, which current Codex models need to run commands, so its commands can reach the network. To keep them offline, remove web:fetch from supertag.yaml and select a Codex model that isn't code-mode-only."
            );
            Commands::Unset
        }
    })
}

fn document(answers: &Answers, repository: &Repository) -> Value {
    let harness = answers.harness.harness();
    let mut execution = json!({ "harness": harness });
    if let Some(model) = &answers.model {
        execution["models"] = json!([model]);
    }
    let mut host = json!({
        "type": "host",
        "harnesses": [harness],
        "concurrency": CONCURRENCY,
        "workspaces": { answers.workspace.clone(): repository.root },
    });
    if let Some(model) = &answers.model {
        host["models"] = json!({ harness: model });
    }
    match answers.commands {
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
    // Current Codex models run commands only in code mode, which SuperTag starts only for a Task
    // that may also fetch from the web: without it the lead could not run commands at all.
    if answers.harness == Found::Codex {
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
                    {
                        "apiVersion": "supertag/v1",
                        "kind": "Role",
                        "metadata": { "name": ROLE },
                        "spec": {
                            "purpose": "Own Objectives for this repository: plan the work, make and verify changes, and report what changed.",
                            "permissionSets": [PERMISSION_SET],
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
            },
            HarnessFact {
                harness: Found::ClaudeCode,
                installed: true,
                signed_in: Some(true),
                timed_out: false,
                node: Some(None),
            },
            HarnessFact {
                harness: Found::Cursor,
                installed: false,
                signed_in: None,
                timed_out: false,
                node: Some(Some("Node.js is not on PATH".into())),
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

        // A signed-in harness whose Node can't run is not ready, and says so.
        let facts = [HarnessFact {
            harness: Found::ClaudeCode,
            installed: true,
            signed_in: Some(true),
            timed_out: false,
            node: Some(Some("Node.js is not on PATH".into())),
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
            model: None,
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
            assert_eq!(provision[2]["spec"]["workspace"], binding);
            // The Tag init creates is the Control Plane's lead Tag.
            assert_eq!(provision[2]["spec"]["lead"], true);
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
            // The local host runs three Task Attempts per harness at once.
            assert_eq!(document["services"][machine_name()]["concurrency"], 3);
            let sources = provision
                .into_iter()
                .map(crate::manifests::ProvisionSource::Inline)
                .collect();
            assert_eq!(crate::manifests::validate_provision(sources).unwrap(), 3);
        }
    }

    #[test]
    fn grants_web_fetch_only_to_a_codex_lead() {
        let repository = Repository {
            root: PathBuf::from("/work/app"),
            name: "app".into(),
            start: Start::Branch("main".into()),
        };
        let answers = Answers {
            port: DEFAULT_PORT,
            harness: Found::ClaudeCode,
            model: None,
            commands: Commands::Unsandboxed,
            workspace: "app".into(),
            tag: "lead".into(),
        };
        let document = document(&answers, &repository);
        let permissions =
            &document["services"]["control-plane"]["provision"][0]["spec"]["permissions"];
        assert_eq!(permissions.as_array().unwrap().len(), 4, "{permissions}");
        assert!(
            !permissions.to_string().contains("web:fetch"),
            "{permissions}"
        );
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
                model: None,
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
            model: None,
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
}
