//! The CLI's help, its reference page, and its usage errors, through the real binary.
//!
//! `rust/docs/cli-reference.md` records the help of every visible command. A change to a command,
//! flag, or description must update that page in the same change: rerun with
//! `SUPERTAG_UPDATE_CLI_REFERENCE=1` and review the diff.

use std::{path::PathBuf, process::Command};

use anyhow::{Context, Result, ensure};

const BINARY: &str = env!("CARGO_BIN_EXE_supertag");
const UPDATE: &str = "SUPERTAG_UPDATE_CLI_REFERENCE";

fn reference_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/cli-reference.md")
}

fn supertag(args: &[&str]) -> Result<std::process::Output> {
    Ok(Command::new(BINARY)
        .args(args)
        .env_clear()
        .env("HOME", std::env::temp_dir())
        .output()?)
}

fn help(path: &[String]) -> Result<String> {
    let mut args: Vec<&str> = path.iter().map(String::as_str).collect();
    args.push("--help");
    let output = supertag(&args)?;
    ensure!(
        output.status.success(),
        "supertag {} --help failed: {}",
        path.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?)
}

/// `(name, description)` for each subcommand listed under `Commands:`, without `help`.
fn subcommands(help: &str) -> Vec<(String, String)> {
    help.lines()
        .skip_while(|line| *line != "Commands:")
        .skip(1)
        .take_while(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let line = line.trim_start();
            let (name, description) = line.split_once(' ').unwrap_or((line, ""));
            (name != "help").then(|| (name.to_owned(), description.trim().to_owned()))
        })
        .collect()
}

struct Entry {
    path: Vec<String>,
    description: String,
    help: String,
}

/// Every visible command, depth first in the order the CLI lists them.
fn commands() -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    let mut pending = vec![(Vec::new(), String::new())];
    while let Some((path, description)) = pending.pop() {
        let text = help(&path)?;
        for (name, description) in subcommands(&text).into_iter().rev() {
            let mut child = path.clone();
            child.push(name);
            pending.push((child, description));
        }
        entries.push(Entry {
            path,
            description,
            help: text,
        });
    }
    Ok(entries)
}

fn render(entries: &[Entry]) -> String {
    let mut page = String::from(
        "# Rust CLI reference\n\n\
         Generated from `supertag --help` and the help of every visible command, and checked by\n\
         `rust/crates/cli/tests/cli_help.rs`. Do not edit by hand: change the command's help, then\n\
         rerun that test with `SUPERTAG_UPDATE_CLI_REFERENCE=1`.\n\n\
         This page describes the Rust CLI. The pages under `docs/` still describe the TypeScript CLI\n\
         until the docs switch.\n",
    );
    for entry in entries {
        let name = if entry.path.is_empty() {
            "supertag".to_owned()
        } else {
            format!("supertag {}", entry.path.join(" "))
        };
        page.push_str(&format!(
            "\n## `{name}`\n\n```text\n{}\n```\n",
            entry.help.trim_end()
        ));
    }
    page
}

#[test]
fn every_command_help_matches_the_reference() -> Result<()> {
    let entries = commands()?;
    ensure!(entries.len() > 50, "found only {} commands", entries.len());
    let rendered = render(&entries);
    let path = reference_path();
    if std::env::var_os(UPDATE).is_some() {
        std::fs::write(&path, &rendered)?;
        return Ok(());
    }
    let recorded = std::fs::read_to_string(&path).context("read rust/docs/cli-reference.md")?;
    if recorded == rendered {
        return Ok(());
    }
    // Name the first section that differs, so the failure points at the command that drifted.
    let sections = |page: &str| -> Vec<String> {
        page.split("\n## ")
            .map(|section| section.to_owned())
            .collect()
    };
    let (recorded, rendered) = (sections(&recorded), sections(&rendered));
    let drift = rendered
        .iter()
        .zip(&recorded)
        .find(|(now, before)| now != before)
        .map(|(now, before)| format!("reference:\n{before}\n\nhelp now:\n{now}"))
        .unwrap_or_else(|| "a command was added or removed".into());
    anyhow::bail!(
        "the CLI help no longer matches rust/docs/cli-reference.md; rerun with {UPDATE}=1 and \
         review the diff.\n{drift}"
    )
}

/// Each visible command says in a sentence what it is for.
#[test]
fn every_command_has_a_plain_description() -> Result<()> {
    let missing: Vec<String> = commands()?
        .into_iter()
        .filter(|entry| !entry.path.is_empty() && entry.description.is_empty())
        .map(|entry| entry.path.join(" "))
        .collect();
    ensure!(
        missing.is_empty(),
        "commands without a description: {missing:?}"
    );
    Ok(())
}

/// Flags without a sentence of help, as `supertag PATH --flag`. Clap prints a flag's help on the
/// same line, or on the next line indented further when any flag of the command has long help.
fn undocumented_flags(entry: &Entry) -> Vec<String> {
    let lines: Vec<&str> = entry
        .help
        .lines()
        .skip_while(|line| *line != "Options:")
        .skip(1)
        .take_while(|line| !line.is_empty())
        .collect();
    let mut missing = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('-') || line.len() - trimmed.len() > 6 {
            continue;
        }
        let name = trimmed
            .split([' ', ','])
            .find(|part| part.starts_with("--"))
            .unwrap_or(trimmed);
        // Drop the flag names and the value placeholder; whatever remains is help text.
        let after = trimmed
            .split_once(name)
            .map_or("", |(_, rest)| rest)
            .trim_start();
        let after = match after.strip_prefix('<') {
            Some(rest) => rest.split_once('>').map_or("", |(_, rest)| rest),
            None => after,
        };
        let next = lines.get(index + 1).copied().unwrap_or("");
        let described_below = next.starts_with("          ")
            && !next.trim().is_empty()
            && !next.trim().starts_with('-');
        if after.trim().is_empty() && !described_below {
            missing.push(format!("supertag {} {name}", entry.path.join(" ")));
        }
    }
    missing
}

/// Each flag says in a sentence what it does.
#[test]
fn every_flag_has_a_plain_description() -> Result<()> {
    let missing: Vec<String> = commands()?.iter().flat_map(undocumented_flags).collect();
    ensure!(
        missing.is_empty(),
        "flags without a description: {missing:#?}"
    );
    Ok(())
}

#[test]
fn an_unknown_command_is_short_and_points_at_help() -> Result<()> {
    for command in ["not-a-command", "helpp"] {
        let output = supertag(&[command])?;
        assert_eq!(output.status.code(), Some(2));
        let stderr = String::from_utf8(output.stderr)?;
        assert!(
            stderr.starts_with(&format!("error: unrecognized subcommand '{command}'")),
            "{stderr}"
        );
        assert!(
            stderr.contains("For more information, try '--help'."),
            "{stderr}"
        );
        assert!(stderr.lines().count() <= 7, "{stderr}");
        assert!(output.stdout.is_empty());
    }
    Ok(())
}

#[test]
fn a_missing_flag_names_the_flag_and_one_usage_line() -> Result<()> {
    let output = supertag(&["objective", "create", "ship", "Ship it"])?;
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8(output.stderr)?;
    assert!(
        stderr.starts_with(
            "error: the following required arguments were not provided:\n  --owner <OWNER>\n"
        ),
        "{stderr}"
    );
    let usage: Vec<&str> = stderr
        .lines()
        .filter(|line| line.starts_with("Usage: "))
        .collect();
    assert_eq!(
        usage,
        ["Usage: supertag objective create --owner <OWNER> <OBJECTIVE_ID> <OUTCOME>"]
    );
    Ok(())
}

/// A usage error repeats what was typed; it must not carry terminal controls with it.
#[test]
fn usage_errors_filter_what_was_typed() -> Result<()> {
    let hostile = "visible\x1b[2J\x1b]0;hidden-title\x07\r\n\t\u{9b}\u{202e}end";
    for args in [
        vec![hostile],
        vec!["objective", "list", "--limit", hostile],
        vec!["--gateway", hostile, "health"],
    ] {
        let output = supertag(&args)?;
        assert!(!output.status.success());
        for stream in [&output.stdout, &output.stderr] {
            let text = String::from_utf8(stream.clone())?;
            assert!(
                !text.chars().any(|c| c != '\n'
                    && (c.is_control() || matches!(c, '\u{202e}' | '\u{2028}' | '\u{2029}'))),
                "{args:?}: {text:?}"
            );
        }
        let stderr = String::from_utf8(output.stderr)?;
        assert!(
            stderr.contains("hidden-title") || args[0] == "--gateway",
            "{stderr:?}"
        );
    }
    Ok(())
}
