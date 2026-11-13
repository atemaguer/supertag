//! Prerequisite gates shared by ignored fixture tests.
//!
//! Ignored tests need local fixtures such as an isolated PostgreSQL server, Node, the Python
//! agents runtime, the terminal UI, or an isolated Linux root. Without one, a test reports the
//! skip on stderr and passes, so `--include-ignored` stays usable on a partial workstation.
//! Required lanes set `SUPERTAG_RUST_TEST_REQUIRE` to a comma-separated list of prerequisite
//! names (or `all`); any listed prerequisite that is absent then fails the test.
#![allow(dead_code)]

use std::ffi::OsString;

use anyhow::{Result, bail};

pub const REQUIRE: &str = "SUPERTAG_RUST_TEST_REQUIRE";

/// Every prerequisite a lane may require. `all` names all of them.
pub const KNOWN: &[&str] = &["postgres", "node", "agents-python", "tui", "linux-root"];

/// Whether the running lane requires `name`. Unknown names in the require list fail so a typo
/// cannot silently weaken a required lane.
pub fn required(name: &str) -> Result<bool> {
    debug_assert!(KNOWN.contains(&name), "unknown test prerequisite {name}");
    let Some(list) = std::env::var_os(REQUIRE) else {
        return Ok(false);
    };
    let Some(list) = list.to_str() else {
        bail!("{REQUIRE} must be UTF-8");
    };
    let mut found = false;
    for entry in list
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if entry != "all" && !KNOWN.contains(&entry) {
            bail!("{REQUIRE} names unknown prerequisite `{entry}`; known: all, {KNOWN:?}");
        }
        found |= entry == "all" || entry == name;
    }
    Ok(found)
}

/// Reports a missing prerequisite: an error when the lane requires it, otherwise a visible skip.
pub fn missing<T>(name: &str, detail: &str) -> Result<Option<T>> {
    if required(name)? {
        bail!("required test prerequisite `{name}` is missing: {detail}");
    }
    eprintln!(
        "SKIPPED: test prerequisite `{name}` is missing ({detail}); {REQUIRE}={name} requires it"
    );
    Ok(None)
}

/// Returns a non-empty environment variable that carries the prerequisite `name`.
pub fn env(name: &str, variable: &str) -> Result<Option<OsString>> {
    match std::env::var_os(variable).filter(|value| !value.is_empty()) {
        Some(value) => Ok(Some(value)),
        None => missing(name, &format!("set {variable}")),
    }
}

/// Returns `Some(())` when the test runs as root on Linux, the isolated environment the shared
/// execution workload cases need to switch to a distinct workload UID.
pub fn linux_root() -> Result<Option<()>> {
    // SAFETY: geteuid has no preconditions and cannot fail.
    if cfg!(target_os = "linux") && unsafe { libc::geteuid() } == 0 {
        return Ok(Some(()));
    }
    missing("linux-root", "run as root in an isolated Linux environment")
}
