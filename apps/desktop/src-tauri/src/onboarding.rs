//! First launch: setting SuperTag up from the app, with no terminal. The app checks a project
//! folder and the harnesses with `supertag init --check --json`, then runs `supertag init --yes`.
//! The CLI does all the work, so the app never repeats init's logic. It runs the CLI that
//! `local_start` finds, with the same PATH, as later launches do for `supertag up`.
use std::{path::Path, process::Stdio, time::Duration};

use serde_json::Value;
use tokio::process::Command;

use crate::local_start::INSTALL_COMMAND;

/// How long the checks may take: a harness sign-in check runs one short turn.
const CHECK_TIMEOUT: Duration = Duration::from_secs(120);
/// How long init may take: it writes the configuration and starts the services.
const SETUP_TIMEOUT: Duration = Duration::from_secs(600);
/// The most of a failed command's output the app shows.
const MAX_REASON_CHARS: usize = 600;

/// What a finished CLI run printed.
pub(crate) struct Ran {
    pub(crate) success: bool,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

pub(crate) async fn run(
    cli: &Path,
    path: Option<&str>,
    args: &[&str],
    directory: Option<&str>,
    timeout: Duration,
) -> Result<Ran, String> {
    let mut command = Command::new(cli);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = path {
        command.env("PATH", path);
    }
    if let Some(directory) = directory {
        command.current_dir(directory);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("Could not run {}: {error}", cli.display()))?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| {
            format!(
                "supertag {} did not finish in time.",
                args.first().unwrap_or(&"")
            )
        })?
        .map_err(|error| format!("Could not run {}: {error}", cli.display()))?;
    Ok(Ran {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// The last lines of a failed command's output, as one bounded reason.
pub(crate) fn reason(ran: &Ran) -> String {
    let text = if ran.stderr.trim().is_empty() {
        &ran.stdout
    } else {
        &ran.stderr
    };
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let tail = lines[lines.len().saturating_sub(4)..].join(" ");
    let tail: String = tail.chars().filter(|c| !c.is_control()).collect();
    if tail.chars().count() > MAX_REASON_CHARS {
        let skip = tail.chars().count() - MAX_REASON_CHARS;
        format!("…{}", tail.chars().skip(skip).collect::<String>())
    } else if tail.is_empty() {
        "The command failed without saying why.".into()
    } else {
        tail
    }
}

/// The one JSON object a `--json` run prints on its last non-empty line.
pub(crate) fn json_of(stdout: &str) -> Option<Value> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with('{'))
        .and_then(|line| serde_json::from_str(line).ok())
        .or_else(|| serde_json::from_str(stdout.trim()).ok())
}

/// Whether SuperTag can be set up, as `supertag init --check --json` says, for `directory` and,
/// when given, only `harness`. With no CLI, says how to install it.
pub async fn check(directory: Option<String>, harness: Option<String>) -> Result<Value, String> {
    // No CLI, or one of another version than the app: say what to do instead of running it.
    let (cli, path) = match crate::local_start::usable_cli().await {
        Ok(found) => found,
        Err(problem) => {
            return Ok(serde_json::json!({
                "cli": null,
                "problem": problem,
                "install": INSTALL_COMMAND,
            }));
        }
    };
    check_with(&cli, path.as_deref(), directory, harness).await
}

/// `check` with the CLI and PATH already found.
async fn check_with(
    cli: &Path,
    path: Option<&str>,
    directory: Option<String>,
    harness: Option<String>,
) -> Result<Value, String> {
    let mut args = vec!["init", "--check", "--json"];
    if let Some(directory) = directory.as_deref() {
        args.extend(["--directory", directory]);
    }
    if let Some(harness) = harness.as_deref() {
        args.extend(["--harness", harness]);
    }
    let ran = run(cli, path, &args, None, CHECK_TIMEOUT).await?;
    // A CLI older than the app has no check: say to update it, as for one that is missing.
    if !ran.success && ran.stderr.contains("unexpected argument") {
        return Ok(serde_json::json!({
            "cli": null,
            "outdated": cli.display().to_string(),
            "install": INSTALL_COMMAND,
        }));
    }
    let mut value = json_of(&ran.stdout).ok_or_else(|| {
        if ran.success {
            "This version of the supertag CLI can't check a setup for the app. Update it, then try again.".to_owned()
        } else {
            reason(&ran)
        }
    })?;
    if let Some(object) = value.as_object_mut() {
        object.insert("cli".into(), Value::String(cli.display().to_string()));
    }
    Ok(value)
}

/// Sets SuperTag up for the project in `directory` with `harness`, and starts it.
pub async fn set_up(directory: String, harness: String) -> Result<Value, String> {
    let (cli, path) = crate::local_start::usable_cli().await?;
    let args = [
        "init",
        "--yes",
        "--json",
        "--harness",
        harness.as_str(),
        "--directory",
        directory.as_str(),
    ];
    let ran = run(
        &cli,
        path.as_deref(),
        &args,
        Some(&directory),
        SETUP_TIMEOUT,
    )
    .await?;
    result(&ran)
}

/// What a `--json` run printed: its object, or its error and fix in one line.
pub(crate) fn result(ran: &Ran) -> Result<Value, String> {
    let value = json_of(&ran.stdout);
    if ran.success {
        return Ok(value.unwrap_or(Value::Null));
    }
    let error = value
        .as_ref()
        .and_then(|value| {
            let error = value["error"].as_str()?;
            Some(match value["fix"].as_str() {
                Some(fix) if !fix.is_empty() => format!("{error} {fix}"),
                _ => error.to_owned(),
            })
        })
        .unwrap_or_else(|| reason(ran));
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_json_line_after_any_progress() {
        assert_eq!(
            json_of("Starting SuperTag…\n{\"version\":1,\"tag\":\"lead\"}\n").unwrap()["tag"],
            "lead"
        );
        assert_eq!(json_of("{\n  \"ready\": true\n}").unwrap()["ready"], true);
        assert!(json_of("no json here").is_none());
    }

    /// One check runs the CLI exactly once, with the check's arguments, and nothing more: the
    /// stand-in CLI records every run, and the test waits after the answer so a late extra run
    /// would still show in the record.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_check_runs_the_cli_once() {
        use std::os::unix::fs::PermissionsExt as _;
        let directory = tempfile::tempdir().unwrap();
        let runs = directory.path().join("runs");
        let cli = directory.path().join("supertag");
        std::fs::write(
            &cli,
            format!(
                "#!/bin/sh\necho \"$*\" >> '{}'\necho '{{\"version\":1,\"ready\":false}}'\n",
                runs.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let value = check_with(
            &cli,
            None,
            Some("/tmp/My Project".into()),
            Some("codex".into()),
        )
        .await
        .unwrap();
        assert_eq!(value["ready"], false);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(
            std::fs::read_to_string(&runs).unwrap(),
            "init --check --json --directory /tmp/My Project --harness codex\n"
        );
    }

    #[test]
    fn a_failure_reason_is_its_last_lines_bounded() {
        let ran = Ran {
            success: false,
            stdout: String::new(),
            stderr: "one\ntwo\n\nthree\nfour\nfive\n".into(),
        };
        assert_eq!(reason(&ran), "two three four five");
        let long = Ran {
            success: false,
            stdout: "x".repeat(2000),
            stderr: String::new(),
        };
        assert_eq!(reason(&long).chars().count(), MAX_REASON_CHARS + 1);
    }
}
