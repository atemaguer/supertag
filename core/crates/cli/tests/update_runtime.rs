//! `supertag update` through the shipped binary, against a local server laid out like GitHub
//! Releases: it installs a release beside the running one as `install.sh` does, refuses what it
//! cannot replace, and restarts the local services only when no Task Attempt is running.
#[path = "support/children.rs"]
mod children;
use children::reaped;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use axum::{Router, extract, http::StatusCode, response::IntoResponse, routing::get};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_supertag");
const ADAPTER: &str = env!("CARGO_BIN_EXE_supertag-fixture-adapter");
const CURRENT: &str = env!("CARGO_PKG_VERSION");
const NEXT: &str = "9.9.9";
const PLATFORMS: [&str; 4] = ["darwin-arm64", "darwin-amd64", "linux-arm64", "linux-amd64"];
const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const WAIT: Duration = Duration::from_secs(30);

/// The release's `supertag`: reports its version, and records any other command it is given.
const FAKE_CLI: &str = r#"#!/bin/sh
if [ "$1" = --version ]; then echo "supertag 9.9.9"; exit 0; fi
echo "$*" >> "$UPDATE_TEST_LOG"
"#;
const FAKE_TUI: &str = "#!/bin/sh\necho 9.9.9\n";

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn write_executable(path: &Path, text: &str) -> Result<()> {
    fs::write(path, text)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

/// Write release `version`'s assets for every platform into `directory`, returning the digest
/// of each platform's archive.
fn release(directory: &Path, version: &str) -> Result<Vec<(String, String)>> {
    fs::create_dir_all(directory)?;
    let build = TempDir::new()?;
    let mut sums = String::new();
    let mut digests = Vec::new();
    for platform in PLATFORMS {
        let root = format!("supertag-{version}-{platform}-complete");
        let package = build.path().join(&root);
        fs::create_dir_all(package.join("node-bridges"))?;
        write_executable(&package.join("supertag"), FAKE_CLI)?;
        write_executable(&package.join("supertag-tui"), FAKE_TUI)?;
        fs::write(
            package.join("manifest.json"),
            serde_json::to_vec(&json!({"version": version, "source": {"commit": COMMIT}}))?,
        )?;
        let archive = directory.join(format!("{root}.tar.gz"));
        let status = Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(build.path())
            .arg(&root)
            .status()?;
        ensure!(status.success(), "tar failed");
        let digest = sha256(&fs::read(&archive)?);
        sums.push_str(&format!("{digest}  {root}.tar.gz\n"));
        digests.push((platform.to_owned(), digest));
    }
    sums.push_str(&format!("{}  install.sh\n", sha256(b"")));
    fs::write(directory.join("SHA256SUMS"), sums)?;
    fs::write(directory.join("install.sh"), "")?;
    Ok(digests)
}

/// Serve `root` over loopback HTTP at `/releases/...`.
fn serve(root: PathBuf) -> Result<String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener).expect("listener");
            let app = Router::new().route(
                "/releases/{*path}",
                get(move |extract::Path(path): extract::Path<String>| {
                    let file = root.join(path);
                    async move {
                        match fs::read(file) {
                            Ok(bytes) => (StatusCode::OK, bytes).into_response(),
                            Err(_) => StatusCode::NOT_FOUND.into_response(),
                        }
                    }
                }),
            );
            axum::serve(listener, app).await.expect("serve");
        });
    });
    Ok(format!("http://{address}/releases"))
}

/// A machine with its own HOME, an installed `supertag` of this build laid out as `install.sh`
/// lays one out, and a release server.
struct Machine {
    temp: TempDir,
    home: PathBuf,
    bin: PathBuf,
    versions: PathBuf,
    /// The installed release of this build.
    current: PathBuf,
    releases: PathBuf,
    url: String,
    log: PathBuf,
}

impl Machine {
    fn new() -> Result<Self> {
        let temp = TempDir::new()?;
        let base = temp.path().canonicalize()?;
        let home = base.join("home");
        let bin = base.join("bin");
        let versions = base.join("share/versions");
        let current = versions.join(format!(
            "native-{CURRENT}-darwin-arm64-release-{}",
            "0".repeat(64)
        ));
        fs::create_dir_all(&home)?;
        fs::create_dir_all(&bin)?;
        fs::create_dir_all(&current)?;
        // A hard link keeps the installed command this build's binary at its own path.
        if fs::hard_link(BIN, current.join("supertag")).is_err() {
            fs::copy(BIN, current.join("supertag"))?;
        }
        fs::write(current.join(".supertag-install.json"), "{}")?;
        symlink(current.join("supertag"), bin.join("supertag"))?;
        let releases = base.join("releases");
        let url = serve(releases.clone())?;
        Ok(Self {
            log: base.join("commands.log"),
            temp,
            home,
            bin,
            versions,
            current,
            releases,
            url,
        })
    }

    fn state(&self) -> PathBuf {
        self.home.join(".supertag")
    }

    fn command(&self, program: &Path, args: &[&str]) -> Command {
        let mut command = reaped(Command::new(program));
        command
            .args(args)
            .env_clear()
            .env("HOME", &self.home)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("TMPDIR", std::env::temp_dir())
            .env("SUPERTAG_BIN_DIR", &self.bin)
            .env("SUPERTAG_RELEASES_URL", &self.url)
            .env("UPDATE_TEST_LOG", &self.log)
            .current_dir(&self.home)
            .stdin(Stdio::null());
        command
    }

    fn run(&self, program: &Path, args: &[&str]) -> Result<Output> {
        Ok(self
            .command(program, args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()?)
    }

    /// Run the installed command, which must succeed, and return its output.
    fn ok(&self, args: &[&str]) -> Result<String> {
        let output = self.run(&self.bin.join("supertag"), args)?;
        ensure!(
            output.status.success(),
            "supertag {} failed: {}{}\nsupervisor log:\n{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
            fs::read_to_string(self.state().join("logs/supervisor.log")).unwrap_or_default()
        );
        Ok(String::from_utf8(output.stdout)?)
    }

    /// Run `program`, which must fail, and return its error output.
    fn fails(&self, program: &Path, args: &[&str]) -> Result<String> {
        let output = self.run(program, args)?;
        ensure!(
            !output.status.success(),
            "supertag {} unexpectedly succeeded: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stdout)
        );
        Ok(String::from_utf8(output.stderr)?)
    }

    fn linked(&self) -> Result<PathBuf> {
        Ok(fs::read_link(self.bin.join("supertag"))?)
    }

    /// Point the command link back at this build.
    fn relink(&self) -> Result<()> {
        fs::remove_file(self.bin.join("supertag"))?;
        symlink(self.current.join("supertag"), self.bin.join("supertag"))?;
        Ok(())
    }

    fn recorded(&self) -> String {
        fs::read_to_string(&self.log).unwrap_or_default()
    }
}

impl Drop for Machine {
    fn drop(&mut self) {
        // Never leak a background supervisor from a failed assertion.
        let state = self.state();
        let _ = self
            .command(Path::new(BIN), &["down", "--force"])
            .arg("--state-directory")
            .arg(&state)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = &self.temp;
    }
}

#[test]
fn update_installs_the_latest_release_beside_the_running_one() -> Result<()> {
    let machine = Machine::new()?;
    let digests = release(&machine.releases.join("latest/download"), NEXT)?;

    let check = machine.ok(&["update", "--check"])?;
    assert!(
        check.contains(&format!("This CLI: SuperTag {CURRENT}"))
            && check.contains(&format!("Latest release: SuperTag {NEXT}"))
            && check.contains("Run supertag update to install it."),
        "{check}"
    );
    assert_eq!(machine.linked()?, machine.current.join("supertag"));

    let updated = machine.ok(&["update"])?;
    assert!(
        updated.contains(&format!("Downloading SuperTag {NEXT} for ")),
        "{updated}"
    );
    assert!(
        updated.contains(&format!("Updated SuperTag: {CURRENT} → {NEXT}")),
        "{updated}"
    );
    // install.sh's directory and receipt, linked from the bin directory; the old release stays.
    let linked = machine.linked()?;
    let installed = linked.parent().context("no parent")?;
    let name = installed
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let (_, digest) = digests
        .iter()
        .find(|(platform, digest)| name == format!("native-{NEXT}-{platform}-release-{digest}"))
        .with_context(|| format!("unexpected release directory {name}"))?;
    assert_eq!(installed.parent(), Some(machine.versions.as_path()));
    assert_eq!(
        fs::read_to_string(installed.join(".supertag-install.json"))?,
        format!(
            "{{\"archive_sha256\": \"{digest}\", \"format\": \"supertag-native-install-v1\", \"source_commit\": \"{COMMIT}\"}}\n"
        )
    );
    assert_eq!(
        fs::metadata(installed.join(".supertag-install.json"))?
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(installed.join("supertag-tui").is_file());
    assert!(machine.current.join("supertag").is_file());
    let left: Vec<String> = fs::read_dir(&machine.versions)?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<Result<_, _>>()?;
    assert_eq!(left.len(), 2, "staging was left behind: {left:?}");
    assert_eq!(
        machine.ok(&["--version"])?.trim(),
        format!("supertag {NEXT}")
    );
    // Nothing ran: no local services were running to restart.
    assert_eq!(machine.recorded(), "");
    Ok(())
}

#[test]
fn update_reports_a_current_install_and_refuses_what_it_cannot_install() -> Result<()> {
    let machine = Machine::new()?;
    release(&machine.releases.join("latest/download"), CURRENT)?;
    let current = machine.ok(&["update"])?;
    assert!(
        current.contains(&format!("SuperTag {CURRENT} is the latest release.")),
        "{current}"
    );
    let named = machine.ok(&["update", "--version", &format!("v{CURRENT}")])?;
    assert!(named.contains("is already installed"), "{named}");

    let command = machine.bin.join("supertag");
    let missing = machine.fails(&command, &["update", "--version", "1.2.3"])?;
    assert!(
        missing.contains("there is no SuperTag release 1.2.3"),
        "{missing}"
    );

    // An archive that does not match SHA256SUMS installs nothing.
    let tampered = machine.releases.join(format!("download/v{NEXT}"));
    release(&tampered, NEXT)?;
    for platform in PLATFORMS {
        let archive = tampered.join(format!("supertag-{NEXT}-{platform}-complete.tar.gz"));
        let mut bytes = fs::read(&archive)?;
        bytes.extend_from_slice(b"tampered");
        fs::write(&archive, bytes)?;
    }
    let mismatch = machine.fails(&command, &["update", "--version", NEXT])?;
    assert!(mismatch.contains("checksum mismatch"), "{mismatch}");
    assert_eq!(machine.linked()?, machine.current.join("supertag"));
    assert_eq!(fs::read_dir(&machine.versions)?.count(), 1);

    // A build that install.sh did not install, and the desktop app's copy, are refused.
    let unmanaged = machine.fails(Path::new(BIN), &["update"])?;
    assert!(
        unmanaged.contains("was not installed by SuperTag's install script")
            && unmanaged.contains("supertag.sh/install | sh"),
        "{unmanaged}"
    );
    let app = machine
        .temp
        .path()
        .join("SuperTag.app/Contents/Resources/bin");
    fs::create_dir_all(&app)?;
    if fs::hard_link(BIN, app.join("supertag")).is_err() {
        fs::copy(BIN, app.join("supertag"))?;
    }
    let bundled = machine.fails(&app.join("supertag"), &["update"])?;
    assert!(bundled.contains("desktop app"), "{bundled}");

    // A read-only bin directory is named before anything is downloaded.
    fs::set_permissions(&machine.bin, fs::Permissions::from_mode(0o555))?;
    let denied = machine.fails(&command, &["update", "--version", NEXT]);
    fs::set_permissions(&machine.bin, fs::Permissions::from_mode(0o755))?;
    let denied = denied?;
    assert!(
        denied.contains("permission denied") && denied.contains(&machine.bin.display().to_string()),
        "{denied}"
    );
    Ok(())
}

fn ps(machine: &Machine) -> Result<Value> {
    Ok(serde_json::from_str(
        &machine.ok(&["ps", "--output", "json"])?,
    )?)
}

fn attempts(machine: &Machine) -> Result<u64> {
    Ok(ps(machine)?["services"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|service| service["service"] == "builder")
        .and_then(|service| service["attempts"].as_u64())
        .unwrap_or(0))
}

#[test]
fn update_restarts_idle_local_services_and_leaves_busy_ones_running() -> Result<()> {
    let machine = Machine::new()?;
    release(&machine.releases.join("latest/download"), NEXT)?;
    let state = machine.state();
    fs::create_dir_all(&state)?;
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700))?;
    let file = state.join("supertag.yaml");
    fs::write(
        &file,
        serde_json::to_vec_pretty(&json!({
            "name": "update",
            "services": {
                "control-plane": {"type": "control-plane", "ports": ["127.0.0.1:0"]},
                "builder": {"type": "host", "adapter": ADAPTER, "adapter-args": ["--wait-for-cancel"]},
            },
        }))?,
    )?;
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600))?;
    machine.ok(&["up"])?;

    // A running Task Attempt keeps the services on this build, and update says what to run.
    let state_flag = state.to_str().context("state path")?;
    machine.ok(&[
        "tag",
        "put",
        "--state-directory",
        state_flag,
        "lead",
        "--instructions",
        "Lead.",
    ])?;
    machine.ok(&[
        "task",
        "submit",
        "--state-directory",
        state_flag,
        "--tag",
        "lead",
        "--session",
        "s1",
        "Wait.",
    ])?;
    let deadline = Instant::now() + WAIT;
    while attempts(&machine)? != 1 {
        ensure!(Instant::now() < deadline, "the Task Attempt never started");
        std::thread::sleep(Duration::from_millis(100));
    }
    let busy = machine.ok(&["update"])?;
    assert!(
        busy.contains("Task Attempts are running (1)")
            && busy.contains(&format!(
                "When they finish, run supertag up to restart them on {NEXT}."
            )),
        "{busy}"
    );
    assert_eq!(machine.recorded(), "");

    // With nothing running, update restarts them with the new release's `supertag up`.
    machine.relink()?;
    machine.ok(&["down", "--force"])?;
    machine.ok(&["up"])?;
    let idle = machine.ok(&["update"])?;
    assert!(
        idle.contains(&format!(
            "Restarting the local services on SuperTag {NEXT}."
        )),
        "{idle}"
    );
    assert_eq!(machine.recorded(), "up\n");

    // Services started from other settings are left for the operator to restart.
    machine.relink()?;
    fs::write(&machine.log, "")?;
    let mut changed = fs::read_to_string(&file)?;
    changed.push('\n');
    fs::write(&file, changed)?;
    let other = machine.ok(&["update"])?;
    assert!(
        other.contains("with settings other than") && other.contains("supertag.yaml"),
        "{other}"
    );
    assert_eq!(machine.recorded(), "");
    Ok(())
}
