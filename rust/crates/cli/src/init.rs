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

#[derive(Args)]
pub struct InitArgs {
    /// Accept every default without asking.
    #[arg(long, short = 'y')]
    yes: bool,
    /// Local state directory (default: ~/.supertag or SUPERTAG_STATE_DIR).
    #[arg(long)]
    state_directory: Option<PathBuf>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
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
        let signed_in = harness_checks::probe_sign_in(harness.check(), model, &variables)
            .await
            .signed_in;
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
}

fn repository() -> Result<Repository> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .context("run git")?;
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
    let base = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workspace");
    Ok(Repository {
        name: sanitize(base).unwrap_or_else(|| "workspace".into()),
        root,
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

fn machine_name() -> String {
    let mut buffer = [0_u8; 256];
    // SAFETY: the buffer is writable for its full length, and gethostname NUL-terminates
    // within it on success.
    let name = if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0 {
        let end = buffer
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(buffer.len());
        String::from_utf8_lossy(&buffer[..end]).into_owned()
    } else {
        String::new()
    };
    let short = name.split('.').next().unwrap_or_default();
    sanitize(short)
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
    unsandboxed: bool,
    workspace: String,
    tag: String,
}

pub async fn init(args: InitArgs) -> Result<()> {
    // First, before any question or side effect: a harness must be installed.
    let installed = installed_harnesses();
    ensure!(
        !installed.is_empty(),
        "SuperTag runs Tasks with an installed harness, and none was found. Install one of:\n  Claude Code: npm install -g @anthropic-ai/claude-code\n  Codex: npm install -g @openai/codex\n  OpenCode: npm install -g opencode-ai\n  Cursor: set CURSOR_API_KEY\nThen run supertag init again."
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
    for harness in &installed {
        if *harness == Found::Opencode {
            outln!("  opencode: sign-in not checked (choose a model)");
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
        "\nTag {} runs {} on this machine, in Workspace {} ({}).",
        answers.tag,
        answers.harness.harness(),
        answers.workspace,
        repository.root.display()
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
    let unsandboxed = match (harness, ask.as_deref_mut()) {
        (Found::Opencode | Found::Cursor, Some(prompter)) => {
            let name = harness.harness();
            outln!(
                "{name} runs commands as you, without a sandbox, so give its Tags only trusted work. Codex sandboxes its commands."
            );
            let allowed = prompter.confirm(
                &format!("Allow {name} to run commands without a sandbox?"),
                true,
            )?;
            if !allowed {
                outln!(
                    "  Tasks that run commands will not run on {name}. To allow it later, add allow-unsandboxed-commands to its host in supertag.yaml."
                );
            }
            allowed
        }
        (Found::Opencode | Found::Cursor, None) => {
            outln!(
                "  Allowed {} to run commands without a sandbox (allow-unsandboxed-commands in supertag.yaml); remove it there and run supertag up to undo.",
                harness.harness()
            );
            true
        }
        _ => false,
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
        unsandboxed,
        workspace,
        tag,
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
        "workspaces": { answers.workspace.clone(): repository.root },
    });
    if let Some(model) = &answers.model {
        host["models"] = json!({ harness: model });
    }
    if answers.unsandboxed {
        host["allow-unsandboxed-commands"] = json!([harness]);
    }
    json!({
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
                        "spec": { "permissions": [
                            { "target": "runtime", "action": "commands:execute" },
                            { "target": "runtime", "action": "files:write" },
                        ] },
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
                        "spec": { "roles": [ROLE], "execution": execution },
                    },
                ],
            },
            machine_name(): host,
        },
    })
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
}
