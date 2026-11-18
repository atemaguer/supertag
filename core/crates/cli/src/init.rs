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
    results: Vec<(Found, Option<String>, bool)>,
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
        outln!(
            "Checking {} sign-in with the Worker Host credentials...",
            harness.harness()
        );
        let variables = harness_checks::worker_variables(
            harness.check(),
            model,
            &self.environment,
            self.supervisor,
        )?;
        let result = harness_checks::probe_sign_in(harness.check(), model, &variables).await;
        if let Some(detail) = &result.detail {
            outln!("  {detail}");
        }
        let signed_in = result.signed_in;
        self.results
            .push((harness, model.map(str::to_owned), signed_in));
        Ok(signed_in)
    }
}

fn no_sign_in(harnesses: &[Found]) -> anyhow::Error {
    let mut message = "No selected harness could complete the sign-in check. Check your sign-in, model access, and network connection, then run supertag init again.".to_owned();
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

fn repository() -> Result<Repository> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .context("supertag init needs git on PATH; install it and run supertag init again")?;
    ensure!(
        output.status.success(),
        "supertag init sets up SuperTag for a git repository; run it inside one"
    );
    let root = PathBuf::from(String::from_utf8(output.stdout)?.trim()).canonicalize()?;
    let commits = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["rev-parse", "--verify", "--quiet", "HEAD"])
        .output()?;
    ensure!(
        commits.status.success(),
        "{} has no commits yet; Tasks start from a commit, so make one and run supertag init again",
        root.display()
    );
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
    // First, before any question or side effect: a harness must be installed.
    let installed = installed_harnesses();
    ensure!(
        !installed.is_empty(),
        "SuperTag runs Tasks with an installed coding agent, and none was found. Install Claude Code or Codex:\n  Claude Code: npm install -g @anthropic-ai/claude-code\n  Codex: npm install -g @openai/codex\nSign in to it, then run supertag init again. (OpenCode, with opencode on PATH, and Cursor, with CURSOR_API_KEY set, also work.)"
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
    let repository = repository()?;
    let state = local_config::state_directory(args.state_directory)?;
    let path = state.join("supertag.yaml");
    let mut prompter = ask.then(|| Prompter {
        input: io::stdin().lock(),
    });
    outln!("SuperTag setup for {}", repository.root.display());

    if path.exists() {
        let config =
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
        if !keep {
            outln!(
                "Nothing was changed. Edit {} or move it aside to start over.",
                path.display()
            );
            return Ok(());
        }
        let mut sign_ins = SignIns {
            environment: config.environment.clone(),
            // A service unit carries no credential from this shell, so neither does the check.
            supervisor: harness_checks::Supervisor::of(&config),
            results: Vec::new(),
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
        return up(&state, config).await;
    }

    let mut sign_ins = SignIns {
        environment: local_config::default_environment(&state)?,
        // The supertag.yaml init writes runs a background supervisor, which inherits this shell.
        supervisor: harness_checks::Supervisor::ThisProcess,
        results: Vec::new(),
    };
    let mut signed_in = Vec::new();
    let mut without_node = false;
    for harness in &installed {
        if *harness == Found::Opencode {
            outln!("  opencode: sign-in not checked (choose a model)");
            continue;
        }
        // SuperTag runs Claude Code through its Node bridge: without a Node it can use, the
        // Worker Host could not start, so say so now rather than after writing supertag.yaml.
        if *harness == Found::ClaudeCode
            && let Some(problem) = crate::node_bridges::node_problem()
        {
            outln!(
                "  claude-code: can't run: {problem}. SuperTag runs Claude Code through Node.js 22.13 or a later 22.x release. Install it from https://nodejs.org/en/download (or brew install node@22 and put it on PATH), then run supertag init again."
            );
            without_node = true;
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
        "Claude Code is the only harness on this machine, and it needs Node.js 22.13 or a later 22.x release on PATH. Install that, or install Codex (npm install -g @openai/codex), then run supertag init again."
    );
    if prompter.is_none() && signed_in.is_empty() {
        return Err(no_sign_in(&installed));
    }
    if prompter.is_some() {
        outln!("Press Enter to accept the default in [brackets].");
    }
    let answers = answers(prompter.as_mut(), &installed, &signed_in, &repository)?;
    let result = sign_ins
        .check(answers.harness, answers.model.as_deref())
        .await?;
    report(answers.harness, result);
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
    Ok(())
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
            "not signed in (the credential check did not succeed)"
        }
    );
}

fn answers(
    mut ask: Option<&mut Prompter>,
    installed: &[Found],
    signed_in: &[Found],
    repository: &Repository,
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
    let default = signed_in
        .first()
        .or_else(|| {
            installed
                .iter()
                .find(|harness| **harness != Found::Opencode)
        })
        .copied()
        .unwrap_or(installed[0]);
    let harness = match ask.as_deref_mut() {
        Some(prompter) if installed.len() > 1 => {
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
                "  Gave the Codex lead web:fetch in the local-tools Permission Set: current Codex models run commands only in Codex code mode, which SuperTag starts only for Tasks that may also fetch from the web, so its commands can reach the network. To keep them offline, remove web:fetch from supertag.yaml, select a Codex model that is not code-mode-only, and run supertag up."
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
    let mut permissions = vec![
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
        assert_eq!(permissions.as_array().unwrap().len(), 3, "{permissions}");
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
