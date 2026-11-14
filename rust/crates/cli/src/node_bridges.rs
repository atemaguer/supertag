use std::{
    fs::{self, OpenOptions},
    io::{self, Read},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{ChildStdout, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;

const FORMAT: &str = "supertag-node-bridges-v1";
const PROTOCOL: &str = "supertag.runtime.v2";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const NODE_MAJOR: u32 = 22;
const NODE_MINIMUM_MINOR: u32 = 13;
const MAX_MANIFEST_BYTES: usize = 4096;
const MAX_PROBE_BYTES: usize = 64;
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "kebab-case")]
pub enum NodeBridge {
    ClaudeCode,
    Cursor,
    Opencode,
}

impl NodeBridge {
    fn entry(self) -> &'static str {
        match self {
            Self::ClaudeCode => {
                "node_modules/@supertag/worker-claude-code/dist/rust-adapter/entry.js"
            }
            Self::Cursor => "node_modules/@supertag/worker-cursor/dist/rust-adapter/entry.js",
            Self::Opencode => "node_modules/@supertag/worker-opencode/dist/rust-adapter/entry.js",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: String,
    version: String,
    protocol: String,
    platform: String,
    node_major: u32,
    bridges: Vec<NodeBridge>,
}

fn platform() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("darwin-arm64"),
        ("macos", "x86_64") => Ok("darwin-amd64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        ("linux", "x86_64") => Ok("linux-amd64"),
        _ => bail!("this platform has no packaged Node bridges"),
    }
}

fn trusted(metadata: &fs::Metadata) -> bool {
    // SAFETY: geteuid returns the effective user of this process.
    let user = unsafe { libc::geteuid() };
    (metadata.uid() == user || metadata.uid() == 0)
        && (metadata.is_symlink() || metadata.mode() & 0o022 == 0)
}

fn trusted_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).context("packaged Node bridges are unavailable")?;
    ensure!(
        metadata.is_dir() && trusted(&metadata),
        "packaged Node bridge directory is unsafe"
    );
    Ok(())
}

fn read_manifest(root: &Path) -> Result<Manifest> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(root.join("manifest.json"))
        .context("open packaged Node bridge manifest")?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && trusted(&metadata) && metadata.len() <= MAX_MANIFEST_BYTES as u64,
        "packaged Node bridge manifest is unsafe or oversized"
    );
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_MANIFEST_BYTES,
        "packaged Node bridge manifest is oversized"
    );
    serde_json::from_slice(&bytes).context("invalid packaged Node bridge manifest")
}

fn installed_entry(executable: &Path, bridge: NodeBridge) -> Result<PathBuf> {
    let executable = executable
        .canonicalize()
        .context("resolve installed SuperTag executable")?;
    let directory = executable
        .parent()
        .context("installed SuperTag directory is unavailable")?;
    trusted_directory(directory)?;
    let root = directory.join("node-bridges");
    trusted_directory(&root)?;
    let mut manifest = read_manifest(&root)?;
    ensure!(
        manifest.format == FORMAT
            && manifest.version == VERSION
            && manifest.protocol == PROTOCOL
            && manifest.platform == platform()?
            && manifest.node_major == NODE_MAJOR,
        "packaged Node bridges do not match this SuperTag release"
    );
    manifest.bridges.sort_unstable();
    ensure!(
        manifest.bridges.windows(2).all(|pair| pair[0] != pair[1]),
        "packaged Node bridge manifest lists a bridge twice"
    );
    ensure!(
        manifest.bridges.contains(&bridge),
        "the selected Node bridge is not installed"
    );
    let mut path = root.clone();
    let components = Path::new(bridge.entry()).components();
    for component in components {
        path.push(component);
        let metadata =
            fs::symlink_metadata(&path).context("packaged Node bridge entry is unavailable")?;
        ensure!(trusted(&metadata), "packaged Node bridge path is unsafe");
        if metadata.is_symlink() {
            ensure!(
                fs::read_link(&path)?.is_relative() && path.canonicalize()?.starts_with(&root),
                "packaged Node bridge link leaves the installation"
            );
        }
    }
    ensure!(
        fs::symlink_metadata(&path)?.is_file(),
        "packaged Node bridge entry must be a regular file"
    );
    let entry = path.canonicalize()?;
    ensure!(
        entry.starts_with(&root),
        "packaged Node bridge entry leaves the installation"
    );
    for directory in entry.ancestors().skip(1).take_while(|path| *path != root) {
        trusted_directory(directory)?;
    }
    Ok(entry)
}

fn executable(path: &Path) -> bool {
    fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

fn resolve_node(runtime: PathBuf) -> Result<PathBuf> {
    if runtime.is_absolute() {
        ensure!(
            executable(&runtime),
            "packaged Node bridge interpreter is unavailable"
        );
        return Ok(runtime);
    }
    ensure!(
        runtime.components().count() == 1,
        "Node interpreter path must be absolute"
    );
    let path = std::env::var_os("PATH").context("packaged Node bridges require Node on PATH")?;
    std::env::split_paths(&path)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(&runtime))
        .find(|path| executable(path))
        .context("packaged Node bridge interpreter is unavailable on PATH")
}

pub fn launch(
    executable: &Path,
    bridge: NodeBridge,
    runtime: PathBuf,
) -> Result<(PathBuf, PathBuf)> {
    let entry = installed_entry(executable, bridge)
        .context("install the matching Node bridges or supply an explicit harness entrypoint")?;
    let runtime = resolve_node(runtime)?;
    check_node_version(&runtime, PROBE_TIMEOUT)?;
    Ok((runtime, entry))
}

fn collect_output(stdout: &mut ChildStdout, bytes: &mut Vec<u8>) -> Result<()> {
    let remaining = MAX_PROBE_BYTES + 1 - bytes.len();
    if let Err(error) = stdout.take(remaining as u64).read_to_end(bytes)
        && error.kind() != io::ErrorKind::WouldBlock
    {
        return Err(error.into());
    }
    ensure!(
        bytes.len() <= MAX_PROBE_BYTES,
        "Node version output is oversized"
    );
    Ok(())
}

fn check_node_version(runtime: &Path, timeout: Duration) -> Result<()> {
    let mut child = Command::new(runtime)
        .arg("--version")
        .env_clear()
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .context("start packaged Node bridge version check")?;
    let checked = (|| -> Result<()> {
        let mut stdout = child
            .stdout
            .take()
            .context("Node version output is unavailable")?;
        // SAFETY: stdout owns a valid pipe descriptor. Only this reader is made nonblocking.
        let nonblocking =
            unsafe { libc::fcntl(stdout.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) };
        ensure!(nonblocking != -1, "could not bound the Node version output");
        let deadline = Instant::now() + timeout;
        let mut bytes = Vec::new();
        loop {
            collect_output(&mut stdout, &mut bytes)?;
            if let Some(status) = child.try_wait()? {
                ensure!(status.success(), "Node version check failed");
                collect_output(&mut stdout, &mut bytes)?;
                break;
            }
            ensure!(Instant::now() < deadline, "Node version check timed out");
            thread::sleep(Duration::from_millis(10));
        }
        let version = std::str::from_utf8(&bytes)?.trim_end_matches(['\r', '\n']);
        let version = version.strip_prefix('v').context("invalid Node version")?;
        let components = version.split('.').collect::<Vec<_>>();
        let [major, minor, patch] = components.as_slice() else {
            bail!("invalid Node version");
        };
        ensure!(
            [major, minor, patch]
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())),
            "invalid Node version"
        );
        ensure!(
            major.parse::<u32>()? == NODE_MAJOR && minor.parse::<u32>()? >= NODE_MINIMUM_MINOR,
            "packaged Node bridges require Node 22.13 or a later Node 22 version"
        );
        Ok(())
    })();
    if checked.is_err() && child.try_wait().ok().flatten().is_none() {
        // SAFETY: this child created its own process group, and has not been reaped.
        unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
        let _ = child.wait();
    }
    checked
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::AdapterOptions;
    use clap::Parser;
    use serde_json::{Value, json};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use tempfile::TempDir;

    struct Installation {
        temporary: TempDir,
        executable: PathBuf,
        root: PathBuf,
    }

    #[derive(Parser)]
    struct TestCommand {
        #[command(flatten)]
        adapter: AdapterOptions,
    }

    impl Installation {
        fn new() -> Self {
            let temporary = tempfile::tempdir().unwrap();
            let install = temporary.path().join("release");
            let root = install.join("node-bridges");
            fs::create_dir_all(&root).unwrap();
            let executable = install.join("supertag");
            fs::write(&executable, b"test executable").unwrap();
            let result = Self {
                temporary,
                executable,
                root,
            };
            result.manifest(&json!({
                "format": FORMAT,
                "version": VERSION,
                "protocol": PROTOCOL,
                "platform": platform().unwrap(),
                "node_major": NODE_MAJOR,
                "bridges": ["claude-code", "cursor", "opencode"]
            }));
            result
        }

        fn manifest(&self, value: &Value) {
            fs::write(
                self.root.join("manifest.json"),
                serde_json::to_vec(value).unwrap(),
            )
            .unwrap();
        }

        fn entry(&self, bridge: NodeBridge) -> PathBuf {
            let entry = self.root.join(bridge.entry());
            fs::create_dir_all(entry.parent().unwrap()).unwrap();
            fs::write(&entry, b"// fixture entry").unwrap();
            entry.canonicalize().unwrap()
        }

        fn node(&self, script: &str) -> PathBuf {
            let path = self.temporary.path().join("node");
            fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        }
    }

    #[test]
    fn resolves_the_installed_sibling_for_all_harnesses_and_pins_the_runtime() {
        let install = Installation::new();
        let launcher = install.temporary.path().join("bin-supertag");
        symlink(&install.executable, &launcher).unwrap();
        let node = install.node("printf 'v22.22.3\\n'");
        for bridge in [
            NodeBridge::ClaudeCode,
            NodeBridge::Cursor,
            NodeBridge::Opencode,
        ] {
            let entry = install.entry(bridge);
            let (actual_node, actual_entry) = launch(&launcher, bridge, node.clone()).unwrap();
            assert_eq!(actual_node, node);
            assert_eq!(actual_entry, entry);
        }
    }

    #[test]
    fn built_in_launch_uses_packaged_entries_and_explicit_entry_wins_without_probe() {
        let install = Installation::new();
        let node = install.node("printf 'v22.22.3\n'");
        for (name, bridge) in [
            ("claude-code", NodeBridge::ClaudeCode),
            ("cursor", NodeBridge::Cursor),
            ("opencode", NodeBridge::Opencode),
        ] {
            let entry = install.entry(bridge);
            let mut args = vec![
                "test".into(),
                "--harness".into(),
                name.into(),
                "--harness-runtime".into(),
                node.as_os_str().to_owned(),
            ];
            if bridge == NodeBridge::Opencode {
                args.extend([
                    "--harness-model".into(),
                    "openai/test-model".into(),
                    "--opencode-path".into(),
                    node.as_os_str().to_owned(),
                ]);
            }
            let (runtime, arguments) = TestCommand::try_parse_from(args)
                .unwrap()
                .adapter
                .launch_from(1, || Ok(install.executable.clone()))
                .unwrap();
            assert_eq!(runtime, node);
            assert_eq!(arguments[0], entry.as_os_str());
        }
        let old_node = install.node("printf 'v20.19.0\n'");
        let custom = install.temporary.path().join("custom.js");
        fs::write(&custom, b"// explicit test adapter").unwrap();
        let (runtime, arguments) = TestCommand::try_parse_from([
            std::ffi::OsStr::new("test"),
            std::ffi::OsStr::new("--harness"),
            std::ffi::OsStr::new("claude-code"),
            std::ffi::OsStr::new("--harness-runtime"),
            old_node.as_os_str(),
            std::ffi::OsStr::new("--harness-entrypoint"),
            custom.as_os_str(),
        ])
        .unwrap()
        .adapter
        .launch_from(1, || panic!("explicit entry should skip package discovery"))
        .unwrap();
        assert_eq!(runtime, old_node);
        assert_eq!(arguments[0], custom.canonicalize().unwrap().as_os_str());
    }

    #[test]
    fn rejects_incompatible_manifest_and_a_bridge_not_listed() {
        let install = Installation::new();
        install.entry(NodeBridge::Cursor);
        let manifest = install.root.join("manifest.json");
        let original: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        for (key, replacement) in [
            ("format", json!("other")),
            ("version", json!("9.9.9")),
            ("protocol", json!("supertag.runtime.v1")),
            ("platform", json!("unsupported")),
            ("node_major", json!(23)),
            ("bridges", json!(["opencode"])),
            ("bridges", json!(["cursor", "cursor"])),
        ] {
            let mut edited = original.clone();
            edited[key] = replacement;
            install.manifest(&edited);
            assert!(
                installed_entry(&install.executable, NodeBridge::Cursor).is_err(),
                "{key}"
            );
        }
        install.manifest(&original);
        assert!(installed_entry(&install.executable, NodeBridge::ClaudeCode).is_err());
    }

    #[test]
    fn permits_contained_package_links_and_rejects_external_and_mutable_paths() {
        let install = Installation::new();
        let entry = install.entry(NodeBridge::Cursor);
        let package = entry.parent().unwrap().parent().unwrap().parent().unwrap();
        let store = install.root.join("node_modules/.pnpm");
        fs::create_dir(&store).unwrap();
        let contained = store.join("cursor");
        fs::rename(package, &contained).unwrap();
        symlink("../.pnpm/cursor", package).unwrap();
        assert_eq!(
            installed_entry(&install.executable, NodeBridge::Cursor).unwrap(),
            contained
                .join("dist/rust-adapter/entry.js")
                .canonicalize()
                .unwrap()
        );
        fs::set_permissions(&contained, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(installed_entry(&install.executable, NodeBridge::Cursor).is_err());
        fs::set_permissions(&contained, fs::Permissions::from_mode(0o755)).unwrap();
        let outside = install.temporary.path().join("outside");
        fs::rename(&contained, &outside).unwrap();
        fs::remove_file(package).unwrap();
        symlink("../../../../outside", package).unwrap();
        assert!(installed_entry(&install.executable, NodeBridge::Cursor).is_err());
    }

    #[test]
    fn refuses_linked_or_oversized_manifests() {
        let install = Installation::new();
        install.entry(NodeBridge::Cursor);
        let manifest = install.root.join("manifest.json");
        let outside = install.temporary.path().join("manifest.json");
        fs::rename(&manifest, &outside).unwrap();
        symlink(&outside, &manifest).unwrap();
        assert!(installed_entry(&install.executable, NodeBridge::Cursor).is_err());
        fs::remove_file(&manifest).unwrap();
        fs::write(&manifest, vec![b' '; MAX_MANIFEST_BYTES + 1]).unwrap();
        assert!(installed_entry(&install.executable, NodeBridge::Cursor).is_err());
    }

    #[test]
    fn packaged_node_requires_the_supported_major_and_minimum_and_bounds_the_probe() {
        let install = Installation::new();
        for script in [
            "printf 'v20.19.0\\n'",
            "printf 'v22.12.0\\n'",
            "printf 'v23.1.0\\n'",
            "printf 'v22.bad.0\\n'",
            "printf 'v22.22.3\\n'; exit 1",
            "printf '%0100d' 0",
            "exec /bin/sleep 3",
        ] {
            assert!(
                check_node_version(&install.node(script), Duration::from_millis(100)).is_err(),
                "{script}"
            );
        }
        let node = install.node(
            "test \"$#\" = 1 && test \"$1\" = --version && test -z \"$NODE_OPTIONS\" && printf 'v22.13.0\\n'",
        );
        // Generous: a parallel test run can delay the fake shell well past a second.
        check_node_version(&node, Duration::from_secs(10)).unwrap();
    }
}
