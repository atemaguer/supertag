//! `supertag tui` and plain `supertag` start the terminal UI installed beside the CLI: through
//! an installed command link, with the release's version, passing only `--gateway` and
//! `--state-directory` and the CLI's own path, never a credential.
#[path = "../../../test-support/executables.rs"]
mod executables;
#[path = "../../../test-support/prerequisites.rs"]
mod prerequisites;

use std::{
    fs,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use anyhow::{Result, ensure};

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A stand-in terminal UI that reports this release's version (or `version`) and prints its
/// name, arguments, and the variables the launcher sets or passes through.
fn fixture(path: &Path, name: &str, version: &str) -> Result<()> {
    executables::write_executable(
        path,
        format!(
            "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '%s\\n' '{version}'; exit 0; fi\n\
             printf 'name=%s\\n' '{name}'\nprintf 'arg=%s\\n' \"$@\"\n\
             printf 'cli=%s\\n' \"$SUPERTAG_CLI\"\nprintf 'notify=%s\\n' \"$SUPERTAG_TUI_NOTIFY\"\n\
             exit 7\n"
        ),
        0o755,
    )?;
    Ok(())
}

struct Install {
    _root: tempfile::TempDir,
    home: PathBuf,
    release: PathBuf,
    command: PathBuf,
}

/// A release directory with a copy of the CLI and, in another directory, the command link an
/// installer creates. There is deliberately no supertag-tui beside the link.
fn install() -> Result<Install> {
    let root = tempfile::tempdir()?;
    let release = root.path().join("versions/native-fixture");
    let bin = root.path().join("bin");
    let home = root.path().join("home");
    fs::create_dir_all(&release)?;
    fs::create_dir(&bin)?;
    fs::create_dir(&home)?;
    executables::copy_executable(
        Path::new(env!("CARGO_BIN_EXE_supertag")),
        &release.join("supertag"),
        0o755,
    )?;
    let command = bin.join("supertag");
    symlink(release.join("supertag"), &command)?;
    Ok(Install {
        home,
        release: release.canonicalize()?,
        command,
        _root: root,
    })
}

fn run(install: &Install, args: &[&str], environment: &[(&str, &Path)]) -> Result<Output> {
    let mut command = Command::new(&install.command);
    command
        .args(args)
        .current_dir(&install.home)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &install.home)
        .env("SUPERTAG_TUI_NOTIFY", "questions")
        .stdin(Stdio::null());
    for (name, value) in environment {
        command.env(name, value);
    }
    Ok(command.output()?)
}

fn lines(output: &Output) -> Vec<String> {
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_owned)
        .collect()
}

#[test]
fn the_installed_command_starts_its_sibling_with_only_the_selected_connection() -> Result<()> {
    let install = install()?;
    fixture(
        &install.release.join("supertag-tui"),
        "release-sibling",
        VERSION,
    )?;
    let output = run(
        &install,
        &["tui", "--gateway", "https://gateway.example"],
        &[],
    )?;
    // The CLI replaced itself with the terminal UI, so its exit status is the UI's.
    assert_eq!(output.status.code(), Some(7), "{output:?}");
    let cli = install.release.join("supertag");
    assert_eq!(
        lines(&output),
        [
            "name=release-sibling".to_owned(),
            "arg=--gateway".to_owned(),
            "arg=https://gateway.example".to_owned(),
            format!("cli={}", cli.display()),
            "notify=questions".to_owned(),
        ]
    );

    // A Gateway before no command opens the terminal UI on it, even outside a terminal.
    let output = run(&install, &["--gateway", "work"], &[])?;
    assert_eq!(lines(&output)[1..3], ["arg=--gateway", "arg=work"]);

    // A relative state directory reaches the terminal UI as an absolute path.
    let output = run(&install, &["tui", "--state-directory", "state"], &[])?;
    assert_eq!(
        lines(&output)[1..3],
        [
            "arg=--state-directory".to_owned(),
            format!(
                "arg={}",
                install.home.canonicalize()?.join("state").display()
            ),
        ]
    );
    Ok(())
}

#[test]
fn an_explicit_binary_wins_over_the_environment_and_the_sibling() -> Result<()> {
    let install = install()?;
    fixture(&install.release.join("supertag-tui"), "sibling", VERSION)?;
    let from_environment = install.home.join("environment-tui");
    let from_flag = install.home.join("flag-tui");
    fixture(&from_environment, "environment-override", VERSION)?;
    fixture(&from_flag, "flag-override", VERSION)?;
    let output = run(
        &install,
        &["tui"],
        &[("SUPERTAG_TUI_BINARY", &from_environment)],
    )?;
    assert_eq!(lines(&output)[0], "name=environment-override");
    let output = run(
        &install,
        &["tui", "--binary", from_flag.to_str().unwrap()],
        &[("SUPERTAG_TUI_BINARY", &from_environment)],
    )?;
    assert_eq!(lines(&output)[0], "name=flag-override");
    Ok(())
}

#[test]
fn a_terminal_ui_from_another_release_is_refused() -> Result<()> {
    let install = install()?;
    fixture(&install.release.join("supertag-tui"), "old", "0.0.1")?;
    let output = run(&install, &["tui"], &[])?;
    ensure!(!output.status.success(), "{output:?}");
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains(&format!("must be the terminal UI from SuperTag {VERSION}")),
        "{error}"
    );
    assert!(lines(&output).is_empty(), "the old terminal UI never ran");
    Ok(())
}

#[test]
fn plain_supertag_prints_help_and_says_when_the_terminal_ui_is_missing() -> Result<()> {
    let install = install()?;
    let output = run(&install, &[], &[])?;
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    let stdout = String::from_utf8(output.stdout)?;
    assert!(stdout.contains("Usage: supertag"), "{stdout}");
    let missing = install.release.join("supertag-tui");
    assert!(
        stdout.trim_end().ends_with(&format!(
            "The terminal UI isn't installed ({} is missing); reinstall SuperTag to get it.",
            missing.display()
        )),
        "{stdout}"
    );

    let output = run(&install, &["tui"], &[])?;
    ensure!(!output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("the terminal UI is not installed"));

    // Installed but not in a terminal: plain supertag is still the help, without the note.
    fixture(&install.release.join("supertag-tui"), "sibling", VERSION)?;
    let output = run(&install, &[], &[])?;
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    let stdout = String::from_utf8(output.stdout)?;
    assert!(stdout.contains("Usage: supertag") && !stdout.contains("isn't installed"));
    Ok(())
}

/// The release's real terminal UI (SUPERTAG_RUST_TEST_TUI), started through the installed command
/// outside a terminal: the launcher accepts its version, and it refuses to draw without one.
#[test]
#[ignore = "needs the compiled terminal UI in SUPERTAG_RUST_TEST_TUI"]
fn the_real_terminal_ui_starts_through_the_installed_command() -> Result<()> {
    let Some(binary) = prerequisites::env("tui", "SUPERTAG_RUST_TEST_TUI")? else {
        return Ok(());
    };
    let install = install()?;
    executables::copy_executable(
        Path::new(&binary),
        &install.release.join("supertag-tui"),
        0o755,
    )?;
    let output = run(&install, &["tui"], &[])?;
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        !output.stderr.is_empty(),
        "the terminal UI says why it did not start"
    );
    let check = Command::new(install.release.join("supertag-tui"))
        .arg("--headless-check")
        .output()?;
    assert_eq!(String::from_utf8_lossy(&check.stdout).trim(), "ok");
    Ok(())
}
