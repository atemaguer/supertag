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

/// Removes clap's bracketed annotations, such as `[default: 100]` or `[possible values: a, b]`.
/// They describe a value, not what the flag is for, so they never count as help.
fn without_annotations(text: &str) -> String {
    const ANNOTATIONS: [&str; 5] = [
        "default:",
        "possible values:",
        "aliases:",
        "short aliases:",
        "env:",
    ];
    let mut rest = text;
    let mut kept = String::new();
    while let Some(open) = rest.find('[') {
        let (before, from) = rest.split_at(open);
        kept.push_str(before);
        let inner = &from[1..];
        match inner.find(']') {
            Some(close)
                if ANNOTATIONS
                    .iter()
                    .any(|prefix| inner[..close].trim_start().starts_with(prefix)) =>
            {
                rest = &inner[close + 1..];
            }
            _ => {
                kept.push('[');
                rest = inner;
            }
        }
    }
    kept.push_str(rest);
    kept
}

/// Entries of one help section, such as `Options:`, as `(name, help)`. Clap prints an entry's help
/// on the same line, or on the following lines indented further with a blank line between
/// entries when any entry of the command has long help. The help keeps no names, placeholders or
/// clap annotations, so it is empty when the entry says nothing about itself.
fn section_entries(help: &str, section: &str) -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut lines = help.lines().skip_while(|line| *line != section).skip(1);
    for line in lines.by_ref() {
        // A line that is not indented starts the next section.
        if !line.is_empty() && !line.starts_with(' ') {
            break;
        }
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        if trimmed.is_empty() {
            continue;
        }
        if indent <= 6 {
            // `-s, --long <VALUE>  help`, `--long [<VALUE>]  help`, or `<NAME>  help`.
            let (head, rest) = match trimmed.find("  ") {
                Some(gap) => trimmed.split_at(gap),
                None => (trimmed, ""),
            };
            let name = head
                .split([' ', ','])
                .find(|part| part.starts_with("--"))
                .unwrap_or(head)
                .to_owned();
            entries.push((name, rest.to_owned()));
        } else if let Some((_, text)) = entries.last_mut() {
            text.push(' ');
            text.push_str(trimmed);
        }
    }
    entries
        .into_iter()
        .map(|(name, text)| (name, without_annotations(&text).trim().to_owned()))
        .collect()
}

/// Flags without a sentence of help, as `supertag PATH --flag`.
fn undocumented(entry: &Entry) -> Vec<String> {
    section_entries(&entry.help, "Options:")
        .into_iter()
        .filter(|(_, text)| text.is_empty())
        .map(|(name, _)| format!("supertag {} {name}", entry.path.join(" ")))
        .collect()
}

#[test]
fn the_flag_check_reads_both_help_layouts_and_ignores_annotations() {
    let entry = |help: &str| Entry {
        path: vec!["demo".into()],
        description: String::new(),
        help: help.into(),
    };
    let short = "Demo\n\nUsage: supertag demo [OPTIONS] <ID>\n\nArguments:\n  <ID>  \n\n\
                 Options:\n      --limit <LIMIT>      [default: 100]\n      \
                 --cursor <CURSOR>    Page to continue from [default: \"\"]\n      \
                 --state <STATE>      [possible values: a, b]\n  -h, --help           Print help\n";
    assert_eq!(
        undocumented(&entry(short)),
        ["supertag demo --limit", "supertag demo --state"]
    );
    let long = "Demo\n\nUsage: supertag demo [OPTIONS]\n\nOptions:\n      --gateway <GATEWAY>\n          \
                Gateway URL\n\n      --limit <LIMIT>\n          [default: 100]\n\n      \
                --harness <HARNESS>\n          Built-in harness\n          \n          \
                [possible values: codex]\n\n      --quiet\n\n  -h, --help\n          Print help\n";
    assert_eq!(
        undocumented(&entry(long)),
        ["supertag demo --limit", "supertag demo --quiet"]
    );
}

/// Each flag says in a sentence what it does.
#[test]
fn every_flag_has_a_plain_description() -> Result<()> {
    let missing: Vec<String> = commands()?.iter().flat_map(undocumented).collect();
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
        vec!["get", "objectives", "--limit", hostile],
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
