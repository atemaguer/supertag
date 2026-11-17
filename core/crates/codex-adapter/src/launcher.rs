//! The Codex binary SuperTag runs: the native executable behind the npm launcher.
//!
//! `npm install -g @openai/codex` puts `bin/codex.js` on PATH, a Node script that finds the
//! native binary in the platform package and runs it. Run through the launcher, every Codex
//! process also starts Node, which needs `node` on the clean PATH a Worker Host passes and adds
//! seconds to a cold start; the version probe timed out that way. SuperTag runs the native binary
//! the launcher would have chosen, and says which one it uses.
use std::{
    ffi::OsStr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

/// The Codex executable SuperTag runs, and the npm launcher it was found behind, if any.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Executable {
    pub path: PathBuf,
    pub launcher: Option<PathBuf>,
}

impl Executable {
    /// Which binary is used, for `supertag sign-in codex` and `supertag init`.
    pub fn describe(&self) -> String {
        match &self.launcher {
            Some(launcher) => format!(
                "Using Codex at {} (the native binary behind the npm launcher {})",
                self.path.display(),
                launcher.display()
            ),
            None => format!("Using Codex at {}", self.path.display()),
        }
    }
}

/// Finds `command` (an absolute path, or a name searched on `path`), then the native binary
/// behind it when it is the npm launcher. None when no executable file is found.
pub fn resolve(command: &Path, path: Option<&OsStr>) -> Option<Executable> {
    let found = if command.is_absolute() {
        executable(command).then(|| command.to_owned())?
    } else if command.components().count() > 1 {
        let absolute = std::path::absolute(command).ok()?;
        executable(&absolute).then_some(absolute)?
    } else {
        std::env::split_paths(path?)
            .filter(|directory| !directory.as_os_str().is_empty())
            .map(|directory| directory.join(command))
            .find(|candidate| executable(candidate))?
    };
    Some(match native(&found) {
        Some(native) => Executable {
            path: native,
            launcher: Some(found),
        },
        None => Executable {
            path: found,
            launcher: None,
        },
    })
}

/// The native binary the npm launcher at `launcher` would run, or None when `launcher` is not
/// that launcher or its platform package is missing.
pub fn native(launcher: &Path) -> Option<PathBuf> {
    let script = launcher.canonicalize().ok()?;
    if script.file_name()? != "codex.js" || script.parent()?.file_name()? != "bin" {
        return None;
    }
    let root = script.parent()?.parent()?;
    let manifest = std::fs::read_to_string(root.join("package.json")).ok()?;
    let name = serde_json::from_str::<serde_json::Value>(&manifest).ok()?["name"].clone();
    if name != "@openai/codex" {
        return None;
    }
    let (package, triple) = platform()?;
    let binary = Path::new("vendor").join(triple).join("bin").join("codex");
    // Nested under the launcher's package, hoisted beside it, or vendored in it (older releases).
    [
        root.join("node_modules")
            .join("@openai")
            .join(package)
            .join(&binary),
        root.parent()?.join(package).join(&binary),
        root.join(&binary),
    ]
    .into_iter()
    .find(|candidate| executable(candidate))
}

/// The launcher's platform package and Rust target for this machine.
fn platform() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some(("codex-darwin-arm64", "aarch64-apple-darwin")),
        ("macos", "x86_64") => Some(("codex-darwin-x64", "x86_64-apple-darwin")),
        ("linux", "aarch64") => Some(("codex-linux-arm64", "aarch64-unknown-linux-musl")),
        ("linux", "x86_64") => Some(("codex-linux-x64", "x86_64-unknown-linux-musl")),
        _ => None,
    }
}

fn executable(candidate: &Path) -> bool {
    std::fs::metadata(candidate)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn write_executable(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// An npm global install: `bin/codex` links to the package's `bin/codex.js`.
    fn install(root: &Path, layout: &str) -> (PathBuf, PathBuf) {
        let package = root.join("lib/node_modules/@openai/codex");
        fs::create_dir_all(package.join("bin")).unwrap();
        fs::write(package.join("package.json"), r#"{"name":"@openai/codex"}"#).unwrap();
        write_executable(&package.join("bin/codex.js"), "#!/usr/bin/env node\n");
        let (name, triple) = platform().unwrap();
        let binary = Path::new("vendor").join(triple).join("bin/codex");
        let native = match layout {
            "nested" => package.join("node_modules/@openai").join(name).join(binary),
            "hoisted" => package.parent().unwrap().join(name).join(binary),
            _ => package.join(binary),
        };
        write_executable(&native, "#!/bin/sh\necho codex-cli 0.163.0\n");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        std::os::unix::fs::symlink(package.join("bin/codex.js"), bin.join("codex")).unwrap();
        (bin, native.canonicalize().unwrap())
    }

    #[test]
    fn the_npm_launcher_resolves_to_its_native_binary_in_every_layout() {
        for layout in ["nested", "hoisted", "vendored"] {
            let root = tempfile::tempdir().unwrap();
            let (bin, native) = install(root.path(), layout);
            let found = resolve(Path::new("codex"), Some(bin.as_os_str())).unwrap();
            assert_eq!(found.path.canonicalize().unwrap(), native, "{layout}");
            assert_eq!(found.launcher, Some(bin.join("codex")), "{layout}");
            assert!(found.describe().contains("behind the npm launcher"));
        }
    }

    #[test]
    fn a_native_binary_or_another_script_is_used_as_found() {
        let root = tempfile::tempdir().unwrap();
        write_executable(
            &root.path().join("codex"),
            "#!/bin/sh\necho codex-cli 0.163.0\n",
        );
        let found = resolve(Path::new("codex"), Some(root.path().as_os_str())).unwrap();
        assert_eq!(found.path, root.path().join("codex"));
        assert_eq!(found.launcher, None);
        // A codex.js outside the @openai/codex package is not the launcher.
        let other = root.path().join("other/bin/codex.js");
        write_executable(&other, "#!/usr/bin/env node\n");
        fs::write(
            root.path().join("other/package.json"),
            r#"{"name":"lookalike"}"#,
        )
        .unwrap();
        assert_eq!(native(&other), None);
    }

    #[test]
    fn a_launcher_without_its_platform_package_stays_the_launcher() {
        let root = tempfile::tempdir().unwrap();
        let (bin, native_binary) = install(root.path(), "nested");
        fs::remove_file(&native_binary).unwrap();
        let found = resolve(Path::new("codex"), Some(bin.as_os_str())).unwrap();
        assert_eq!(found.path, bin.join("codex"));
        assert_eq!(found.launcher, None);
    }
}
