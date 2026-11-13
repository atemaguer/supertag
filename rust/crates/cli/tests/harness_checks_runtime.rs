//! Harness sign-in checks and host startup checks through the shipped binary, with fake harness
//! CLIs on PATH: `supertag sign-in`, and a configured host service that `supertag up` refuses to
//! start when its Codex CLI or configured models cannot run Tasks.
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_supertag");

/// A private machine: its own HOME, PATH of fake harness CLIs, and state directory.
struct Machine {
    _temp: TempDir,
    home: PathBuf,
    state: PathBuf,
    bin: PathBuf,
}

impl Machine {
    fn new() -> Result<Self> {
        let temp = TempDir::new()?;
        let home = temp.path().join("home");
        let bin = temp.path().join("bin");
        fs::create_dir_all(&home)?;
        fs::create_dir_all(&bin)?;
        Ok(Self {
            state: home.join(".supertag"),
            home,
            bin,
            _temp: temp,
        })
    }

    fn fake(&self, name: &str, body: &str) -> Result<()> {
        let path = self.bin.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n"))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
        Ok(())
    }

    fn run(&self, args: &[&str], env: &[(&str, &str)]) -> Result<Output> {
        let mut child = Command::new(BIN)
            .args(args)
            .env_clear()
            .env("HOME", &self.home)
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", self.bin.display()),
            )
            .env("TMPDIR", std::env::temp_dir())
            .envs(env.iter().copied())
            .current_dir(&self.home)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let deadline = Instant::now() + Duration::from_secs(150);
        while child.try_wait()?.is_none() {
            if Instant::now() > deadline {
                let _ = child.kill();
                anyhow::bail!("supertag {} timed out", args.join(" "));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(child.wait_with_output()?)
    }

    fn text(output: &Output) -> String {
        format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    }

    fn ok(&self, args: &[&str], env: &[(&str, &str)]) -> Result<String> {
        let output = self.run(args, env)?;
        ensure!(
            output.status.success(),
            "supertag {} failed: {}\nsupervisor log:\n{}",
            args.join(" "),
            Self::text(&output),
            fs::read_to_string(self.state.join("logs/supervisor.log")).unwrap_or_default()
        );
        Ok(Self::text(&output))
    }

    fn fails(&self, args: &[&str], env: &[(&str, &str)]) -> Result<String> {
        let output = self.run(args, env)?;
        ensure!(
            !output.status.success(),
            "supertag {} unexpectedly succeeded: {}",
            args.join(" "),
            Self::text(&output)
        );
        Ok(Self::text(&output))
    }

    fn private_file(&self, path: &Path, text: &str) -> Result<()> {
        fs::create_dir_all(path.parent().context("parent")?)?;
        fs::set_permissions(&self.state, fs::Permissions::from_mode(0o700)).ok();
        fs::write(path, text)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(())
    }
}

impl Drop for Machine {
    fn drop(&mut self) {
        // Never leak a background supervisor from a failed assertion.
        if let Ok(text) = fs::read_to_string(self.state.join("supervisor.json"))
            && let Ok(status) = serde_json::from_str::<Value>(&text)
            && let Some(pid) = status["pid"].as_i64()
        {
            // SAFETY: signals only the supervisor this test started.
            unsafe { libc::kill(pid as i32, libc::SIGTERM) };
            let deadline = Instant::now() + Duration::from_secs(30);
            // SAFETY: signal 0 only checks that the process exists.
            while unsafe { libc::kill(pid as i32, 0) } == 0 && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

/// A fake `codex exec` that answers only for the expected API key and records what it saw.
fn codex_exec(machine: &Machine, key: &str) -> String {
    format!(
        r#"if [ "$1" = --version ]; then echo codex-cli 0.163.0; exit 0; fi
test "$1" = exec || exit 9
/usr/bin/env > '{log}'
test "$CODEX_API_KEY" = '{key}' || {{ echo '{{"type":"turn.failed","error":{{"message":"401 Unauthorized"}}}}'; exit 1; }}
echo '{{"type":"item.completed","item":{{"type":"agent_message","text":"OK"}}}}'
echo '{{"type":"turn.completed"}}'"#,
        log = machine.home.join("codex.env").display()
    )
}

#[test]
fn sign_in_checks_each_harness_with_the_worker_host_credentials() -> Result<()> {
    let machine = Machine::new()?;
    // No credential: Codex is not signed in, and the steps name every credential location.
    machine.fake("codex", &codex_exec(&machine, "env-file-key"))?;
    let failed = machine.fails(&["sign-in", "codex"], &[])?;
    assert!(failed.contains("codex: not signed in"), "{failed}");
    for location in [
        "codex -c 'cli_auth_credentials_store=\"file\"' login",
        "$CODEX_HOME/auth.json",
        "~/.codex/auth.json",
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
    ] {
        assert!(failed.contains(location), "{location}: {failed}");
    }
    assert!(
        !machine.home.join("codex.env").exists(),
        "no key, so no turn"
    );

    // A key from the default env_file reaches the turn; nothing unrelated does.
    machine.private_file(
        &machine.state.join(".env"),
        "CODEX_API_KEY=env-file-key\nUNRELATED_SECRET=never-pass\n",
    )?;
    let signed_in = machine.ok(&["sign-in", "codex"], &[("OTHER_SECRET", "never-pass")])?;
    assert!(signed_in.contains("codex: signed in"), "{signed_in}");
    let environment = fs::read_to_string(machine.home.join("codex.env"))?;
    assert!(environment.contains("CODEX_API_KEY=env-file-key"));
    assert!(!environment.contains("never-pass"), "{environment}");
    // The shell's value wins over env_file, as it does for a Worker Host.
    let shell = machine.fails(&["sign-in", "codex"], &[("CODEX_API_KEY", "wrong")])?;
    assert!(shell.contains("codex: not signed in"), "{shell}");

    // A file-backed login is accepted from its structure alone, without a turn.
    fs::remove_file(machine.state.join(".env"))?;
    fs::remove_file(machine.home.join("codex.env"))?;
    machine.private_file(
        &machine.home.join(".codex/auth.json"),
        r#"{"tokens":{"refresh_token":"refresh"}}"#,
    )?;
    assert!(
        machine
            .ok(&["sign-in", "codex"], &[])?
            .contains("codex: signed in")
    );
    assert!(!machine.home.join("codex.env").exists());

    // Claude Code runs one turn; a refused turn names /login and the credential stores.
    machine.fake(
        "claude",
        r#"while IFS= read -r line; do
  case "$line" in
    *'"type":"user"'*)
      if [ "$ANTHROPIC_API_KEY" = good ]; then echo '{"type":"result","subtype":"success","is_error":false}';
      else echo '{"type":"result","subtype":"error_during_execution","is_error":true}'; fi;;
  esac
done"#,
    )?;
    let claude = machine.fails(&["sign-in", "claude-code"], &[])?;
    assert!(claude.contains("run claude and use /login"), "{claude}");
    assert!(
        claude.contains("CLAUDE_SECURESTORAGE_CONFIG_DIR"),
        "{claude}"
    );
    assert!(
        machine
            .ok(
                &["sign-in", "claude-code"],
                &[("ANTHROPIC_API_KEY", "good")]
            )?
            .contains("claude-code: signed in")
    );

    // A signed-in Cursor CLI is advice only: the Cursor runner needs CURSOR_API_KEY.
    machine.fake(
        "cursor-agent",
        r#"case "$*" in
  --version) echo cursor-agent 1.0;;
  'status --format json') echo '{"isAuthenticated":true}';;
  *) exit 1;;
esac"#,
    )?;
    // The first launch of a new executable can wait on macOS policy checks. Take that once
    // here, outside the probe's five-second bound.
    Command::new(machine.bin.join("cursor-agent"))
        .arg("--version")
        .output()?;
    let cursor = machine.fails(&["sign-in", "cursor"], &[])?;
    assert!(
        cursor.contains("Cursor CLI is signed in, but the Cursor SDK runner needs CURSOR_API_KEY"),
        "{cursor}"
    );
    assert!(
        cursor.contains("https://cursor.com/dashboard/api"),
        "{cursor}"
    );

    // OpenCode needs its model, and uses only that provider's key.
    assert!(
        machine
            .fails(&["sign-in", "opencode"], &[])?
            .contains("needs a model")
    );
    machine.fake(
        "opencode",
        r#"test "$OPENAI_API_KEY" = good && test -z "$ANTHROPIC_API_KEY" || exit 1
echo '{"type":"text","part":{"text":"OK"}}'
echo '{"type":"step_finish","part":{"reason":"stop"}}'"#,
    )?;
    let opencode = machine.ok(
        &["sign-in", "opencode", "--model", "openai/fixture"],
        &[("OPENAI_API_KEY", "good"), ("ANTHROPIC_API_KEY", "other")],
    )?;
    assert!(opencode.contains("opencode: signed in"), "{opencode}");
    Ok(())
}

/// A fake Codex: `--version` reports `version`, and its app server lists `models` or refuses.
fn codex_server(version: &str, models: Option<&[&str]>) -> String {
    let answer = match models {
        Some(models) => json!({"id": 2, "result": {"data": models
            .iter()
            .map(|id| json!({"id": id}))
            .collect::<Vec<_>>()}})
        .to_string(),
        None => r#"{"id":2,"error":{"message":"not logged in"}}"#.into(),
    };
    format!(
        r#"if [ "$1" = --version ]; then echo codex-cli {version}; exit 0; fi
test "$*" = "app-server --listen stdio://" || exit 9
test -z "$CODEX_API_KEY$OPENAI_API_KEY" || exit 8
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) echo '{{"id":1,"result":{{}}}}';;
    *'"method":"model/list"'*) echo '{answer}';;
  esac
done"#
    )
}

#[test]
fn configured_hosts_check_the_codex_cli_and_models_before_they_start() -> Result<()> {
    let machine = Machine::new()?;
    fs::create_dir_all(&machine.state)?;
    fs::set_permissions(&machine.state, fs::Permissions::from_mode(0o700))?;
    let file = machine.state.join("supertag.yaml");
    let write = |models: &[&str]| -> Result<()> {
        let config = json!({
            "name": "checks",
            "services": {
                "control-plane": {"type": "control-plane", "ports": ["127.0.0.1:0"]},
                "builder": {"type": "host", "harnesses": ["codex"], "models": {"codex": models}},
            },
        });
        fs::write(&file, serde_json::to_string(&config)?)?;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600))?;
        Ok(())
    };
    // An API key in the shell never reaches the listing, so it cannot spend.
    let env = [("CODEX_API_KEY", "never-used-for-listing")];

    write(&["gpt-6.1-sol"])?;
    machine.fake("codex", &codex_server("0.1.0", Some(&["gpt-6-sol"])))?;
    let old = machine.fails(&["up"], &env)?;
    assert!(
        old.contains(
            "Host service builder can't run its harnesses:\n  Codex 0.1.0 is older than 0.163.0"
        ),
        "{old}"
    );
    assert!(old.contains("npm install -g @openai/codex"), "{old}");

    machine.fake(
        "codex",
        &codex_server("0.163.0", Some(&["gpt-6-sol", "gpt-6-max"])),
    )?;
    let missing = machine.fails(&["up"], &env)?;
    assert!(
        missing.contains("Host service models are not available: Codex does not offer gpt-6.1-sol for this account. Available models: gpt-6-sol, gpt-6-max. Change models in supertag.yaml and run supertag up again."),
        "{missing}"
    );
    assert!(!machine.state.join("hosts/builder").exists(), "{missing}");

    // A listing that cannot run is noted in the host's log, and the host starts.
    machine.fake("codex", &codex_server("0.163.0", None))?;
    machine.ok(&["up"], &env)?;
    let logs = machine.ok(&["logs", "builder"], &[])?;
    assert!(
        logs.contains("Could not list Codex models (Codex app-server did not list models); skipping the model check."),
        "{logs}"
    );
    let ps: Value = serde_json::from_str(&machine.ok(&["ps", "--output", "json"], &[])?)?;
    let builder = ps["services"]
        .as_array()
        .context("services")?
        .iter()
        .find(|service| service["service"] == "builder")
        .context("builder")?;
    assert_eq!(builder["state"], "running", "{ps}");
    machine.ok(&["down", "--force"], &[])?;

    // A listed model starts the host with nothing to note.
    write(&["gpt-6-sol"])?;
    machine.fake("codex", &codex_server("0.163.0", Some(&["gpt-6-sol"])))?;
    fs::remove_file(machine.state.join("logs/hosts/builder.log"))?;
    machine.ok(&["up"], &env)?;
    let logs = machine.ok(&["logs", "builder"], &[])?;
    assert!(!logs.contains("model check"), "{logs}");
    machine.ok(&["down", "--force"], &[])?;
    Ok(())
}

#[test]
fn ctrl_c_during_a_sign_in_probe_kills_it_and_removes_its_home() -> Result<()> {
    let machine = Machine::new()?;
    let started = machine.home.join("started");
    machine.fake(
        "codex",
        &format!(
            "echo \"$CODEX_HOME\" > '{0}.home'\necho $$ > '{0}.tmp'\nmv '{0}.tmp' '{0}'\nexec sleep 1000",
            started.display()
        ),
    )?;
    let mut child = Command::new(BIN)
        .args(["sign-in", "codex"])
        .env_clear()
        .env("HOME", &machine.home)
        .env("PATH", format!("{}:/usr/bin:/bin", machine.bin.display()))
        .env("TMPDIR", std::env::temp_dir())
        .env("CODEX_API_KEY", "test-secret")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    // The barrier is the probe recording its process ID, not a wall-clock budget.
    let deadline = Instant::now() + Duration::from_secs(120);
    while !started.exists() {
        ensure!(Instant::now() < deadline, "the probe never started");
        std::thread::sleep(Duration::from_millis(10));
    }
    // SAFETY: signals only the command this test started.
    unsafe { libc::kill(child.id() as i32, libc::SIGINT) };
    let status = child.wait()?;
    assert_eq!(status.code(), Some(130), "{status:?}");
    let pid: i32 = fs::read_to_string(&started)?.trim().parse()?;
    // The probe was the command's child; once it is killed, init reaps the orphaned zombie.
    let deadline = Instant::now() + Duration::from_secs(30);
    // SAFETY: signal 0 only checks that the process exists.
    while unsafe { libc::kill(pid, 0) } == 0 {
        ensure!(Instant::now() < deadline, "the probe outlived Ctrl-C");
        std::thread::sleep(Duration::from_millis(10));
    }
    let home = fs::read_to_string(started.with_extension("home"))?;
    assert!(
        !Path::new(home.trim()).exists(),
        "the probe home was left behind"
    );
    Ok(())
}
