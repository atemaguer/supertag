//! `supertag update`: install the latest or a named release the way `install.sh` does, then
//! restart the local services on it when nothing is running.
//!
//! The release, its checks, and the layout are `install.sh`'s, so either can replace the other:
//! the platform's `supertag-VERSION-PLATFORM-complete.tar.gz` from the release's `SHA256SUMS`,
//! unpacked into `INSTALL_ROOT/versions/native-VERSION-PLATFORM-release-SHA256` with the same
//! receipt, and the command link in the bin directory switched by one rename once the release's
//! `supertag` and `supertag-tui` report its version. Older releases stay beside it.
use std::{
    cmp::Ordering,
    fs,
    io::Write as _,
    os::unix::fs::{PermissionsExt as _, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use clap::Args;
use sha2::{Digest, Sha256};
use supertag_protocol::v2::{ListHostsRequest, operator_client::OperatorClient};

use crate::{
    lifecycle::{self, Supervisor},
    local, local_config,
};

/// Where releases are published: `latest/download/NAME` and `download/vVERSION/NAME`.
const RELEASES: &str = "https://github.com/atemaguer/supertag/releases";
/// Replaces [`RELEASES`], for testing against a local server.
const RELEASES_VARIABLE: &str = "SUPERTAG_RELEASES_URL";
const INSTALL_SCRIPT: &str =
    "curl -fsSL https://github.com/atemaguer/supertag/releases/latest/download/install.sh | sh";
const RECEIPT: &str = ".supertag-install.json";
const RECEIPT_FORMAT: &str = "supertag-native-install-v1";
const MAX_SUMS_BYTES: u64 = 1024 * 1024;
/// The bound `scripts/release_archive.py` puts on an archive.
const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const PAGE: u32 = 100;
const MAX_PAGES: usize = 100;

#[derive(Args)]
pub struct UpdateArgs {
    /// Only print this CLI's version and the latest release's.
    #[arg(long, conflicts_with = "version")]
    check: bool,
    /// Install this release instead of the latest, such as 0.3.5. An older release goes back to
    /// it.
    #[arg(long, value_name = "VERSION")]
    version: Option<String>,
    /// Local state directory whose services restart on the new release (default: ~/.supertag or
    /// SUPERTAG_STATE_DIR).
    #[arg(long)]
    state_directory: Option<PathBuf>,
}

/// A release's build for this platform, as its `SHA256SUMS` lists it.
#[derive(Debug, PartialEq, Eq)]
struct Release {
    version: String,
    sha256: String,
}

/// Where `install.sh` put the running `supertag`.
#[derive(Debug, PartialEq, Eq)]
struct Install {
    /// `INSTALL_ROOT/versions`.
    versions: PathBuf,
    /// The command link, `BIN_DIR/supertag`.
    command: PathBuf,
}

pub async fn run(args: UpdateArgs) -> Result<()> {
    let current = env!("CARGO_PKG_VERSION");
    let requested = args.version.as_deref().map(normalized).transpose()?;
    let platform = platform()?;
    let client = client()?;
    if args.check {
        let latest = find_release(&client, None, &platform).await?;
        outln!("This CLI: SuperTag {current}");
        outln!("Latest release: SuperTag {}", latest.version);
        match compare(&latest.version, current) {
            Ordering::Greater => outln!("Run supertag update to install it."),
            Ordering::Equal => outln!("SuperTag is up to date."),
            Ordering::Less => outln!("This CLI is newer than the latest release."),
        }
        return Ok(());
    }
    // Refuse an installation this command cannot replace before downloading anything.
    let install = locate()?;
    if requested.as_deref() == Some(current) {
        outln!("SuperTag {current} is already installed.");
        return Ok(());
    }
    let release = find_release(&client, requested.as_deref(), &platform).await?;
    if requested.is_none() {
        match compare(&release.version, current) {
            Ordering::Equal => {
                outln!("SuperTag {current} is the latest release.");
                return Ok(());
            }
            Ordering::Less => {
                outln!(
                    "This CLI, SuperTag {current}, is newer than the latest release, {}; nothing to update.",
                    release.version
                );
                return Ok(());
            }
            Ordering::Greater => {}
        }
    }
    let base = release_url(requested.as_deref())?;
    outln!(
        "Downloading SuperTag {} for {platform} from {base}...",
        release.version
    );
    install_release(&client, &install, &base, &release, &platform).await?;
    outln!(
        "Updated SuperTag: {current} → {} at {}.",
        release.version,
        install.command.display()
    );
    let older = compare(&release.version, current) == Ordering::Less;
    restart(
        args.state_directory,
        &install.command,
        &release.version,
        older,
    )
    .await
}

/// `v0.3.5` or `0.3.5` as `0.3.5`, with `install.sh`'s character rule.
pub(crate) fn normalized(version: &str) -> Result<String> {
    let version = version.strip_prefix('v').unwrap_or(version);
    ensure!(
        !version.is_empty()
            && version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-')),
        "invalid version {version}; name a release such as 0.3.5"
    );
    Ok(version.to_owned())
}

/// `darwin-arm64`, `darwin-amd64`, `linux-arm64`, or `linux-amd64`, as `install.sh` picks it:
/// under Rosetta on Apple silicon, the native arm64 build.
fn platform() -> Result<String> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        other => bail!("SuperTag supports macOS and Linux; this is {other}"),
    };
    let mut arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => bail!("SuperTag supports arm64 and amd64; this is {other}"),
    };
    if os == "darwin" && arch == "amd64" && translated() {
        arch = "arm64";
    }
    Ok(format!("{os}-{arch}"))
}

/// Whether this process runs under Rosetta. An Intel Mac has no `sysctl.proc_translated`.
#[cfg(target_os = "macos")]
fn translated() -> bool {
    let mut value: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    // SAFETY: the name is a NUL-terminated string, and the output buffer holds `size` bytes.
    let result = unsafe {
        libc::sysctlbyname(
            c"sysctl.proc_translated".as_ptr(),
            (&raw mut value).cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    result == 0 && value == 1
}

#[cfg(not(target_os = "macos"))]
fn translated() -> bool {
    false
}

/// The directory holding a release's assets.
pub(crate) fn release_url(version: Option<&str>) -> Result<String> {
    let configured = std::env::var(RELEASES_VARIABLE).ok();
    let base = configured
        .as_deref()
        .unwrap_or(RELEASES)
        .trim_end_matches('/');
    let url =
        url::Url::parse(base).with_context(|| format!("invalid {RELEASES_VARIABLE} {base}"))?;
    ensure!(
        allowed(&url),
        "{RELEASES_VARIABLE} must be an https: URL, or http: on this machine"
    );
    Ok(match version {
        None => format!("{base}/latest/download"),
        Some(version) => format!("{base}/download/v{version}"),
    })
}

/// https:, or http: to a loopback address, as a test server is.
fn allowed(url: &url::Url) -> bool {
    match url.scheme() {
        "https" => true,
        "http" => match url.host() {
            Some(url::Host::Domain(name)) => name == "localhost",
            Some(url::Host::Ipv4(address)) => address.is_loopback(),
            Some(url::Host::Ipv6(address)) => address.is_loopback(),
            None => false,
        },
        _ => false,
    }
}

pub(crate) fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("supertag/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        // GitHub redirects downloads to its storage; never follow one off https.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("too many redirects")
            } else if allowed(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("a redirect left https")
            }
        }))
        .build()
        .context("set up the HTTPS client")
}

/// Read `SHA256SUMS` from the latest release or the named one, and find this platform's build.
async fn find_release(
    client: &reqwest::Client,
    version: Option<&str>,
    platform: &str,
) -> Result<Release> {
    let base = release_url(version)?;
    let url = format!("{base}/SHA256SUMS");
    let mut response = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("could not reach {url}; check your network connection"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        match version {
            Some(version) => bail!("there is no SuperTag release {version} at {base}"),
            None => bail!("there is no published SuperTag release at {base}"),
        }
    }
    ensure!(
        response.status().is_success(),
        "could not download {url}: HTTP {}",
        response.status()
    );
    let mut sums = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .with_context(|| format!("could not download {url}; check your network connection"))?
    {
        sums.extend_from_slice(&chunk);
        ensure!(
            sums.len() as u64 <= MAX_SUMS_BYTES,
            "{url} is larger than a SHA256SUMS file"
        );
    }
    let sums = String::from_utf8(sums).with_context(|| format!("{url} is not text"))?;
    let release = listed(&sums, platform, version).with_context(|| {
        format!(
            "the release at {base} has no {}build for {platform}",
            version.map_or_else(String::new, |version| format!("{version} "))
        )
    })?;
    normalized(&release.version).context("the release lists an invalid version")?;
    Ok(release)
}

/// The first `<sha256>  supertag-<version>-<platform>-complete.tar.gz` line, as `install.sh`
/// reads it: of `version` when one is named.
fn listed(sums: &str, platform: &str, version: Option<&str>) -> Option<Release> {
    let suffix = format!("-{platform}-complete.tar.gz");
    sums.lines().find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let [sha256, name] = fields[..] else {
            return None;
        };
        let name = name.strip_prefix('*').unwrap_or(name);
        if sha256.len() != 64
            || !sha256
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            return None;
        }
        let found = name.strip_prefix("supertag-")?.strip_suffix(&suffix)?;
        (!found.is_empty() && version.is_none_or(|version| version == found)).then(|| Release {
            version: found.to_owned(),
            sha256: sha256.to_owned(),
        })
    })
}

/// Order release versions: numeric parts first, then a release after its prereleases.
fn compare(left: &str, right: &str) -> Ordering {
    fn split(version: &str) -> (Vec<u64>, Option<&str>) {
        let version = version.split('+').next().unwrap_or(version);
        let (core, pre) = match version.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (version, None),
        };
        let parts = core
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect();
        (parts, pre)
    }
    let (left_parts, left_pre) = split(left);
    let (right_parts, right_pre) = split(right);
    let width = left_parts.len().max(right_parts.len());
    let pad = |parts: Vec<u64>| -> Vec<u64> {
        let mut parts = parts;
        parts.resize(width, 0);
        parts
    };
    pad(left_parts)
        .cmp(&pad(right_parts))
        .then_with(|| match (left_pre, right_pre) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(left), Some(right)) => left.cmp(right),
        })
}

/// The running `supertag`, which must be one `install.sh` installed and linked.
fn locate() -> Result<Install> {
    let invoked = std::env::current_exe().context("find the running supertag")?;
    let resolved = invoked
        .canonicalize()
        .with_context(|| format!("resolve {}", invoked.display()))?;
    locate_from(&invoked, &resolved, &bin_directory()?)
}

/// `install.sh`'s bin directory: SUPERTAG_BIN_DIR, else XDG_BIN_HOME, else ~/.local/bin.
fn bin_directory() -> Result<PathBuf> {
    for variable in ["SUPERTAG_BIN_DIR", "XDG_BIN_HOME"] {
        if let Some(value) = std::env::var_os(variable).filter(|value| !value.is_empty()) {
            return Ok(PathBuf::from(value));
        }
    }
    let home = std::env::var_os("HOME").context("HOME is required")?;
    Ok(PathBuf::from(home).join(".local/bin"))
}

fn locate_from(invoked: &Path, resolved: &Path, bin: &Path) -> Result<Install> {
    if let Some(app) = resolved
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
    {
        bail!(
            "this supertag is part of the SuperTag desktop app at {}, which updates itself: restart the app when it offers an update",
            app.display()
        );
    }
    let unmanaged = || {
        format!(
            "{} was not installed by SuperTag's install script, so supertag update cannot replace it. Update it the way you installed it, or install SuperTag with: {INSTALL_SCRIPT}",
            resolved.display()
        )
    };
    let release = resolved.parent().context("no parent directory")?;
    let versions = release.parent().context("no parent directory")?;
    ensure!(
        resolved.file_name().is_some_and(|name| name == "supertag")
            && release
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("native-"))
            && versions.file_name().is_some_and(|name| name == "versions")
            && release.join(RECEIPT).is_file(),
        unmanaged()
    );
    // The link this was run through, else the one install.sh would have made.
    let linked = |path: &Path| {
        fs::symlink_metadata(path).is_ok_and(|info| info.file_type().is_symlink())
            && path.canonicalize().is_ok_and(|target| target == resolved)
    };
    let command = [invoked.to_owned(), bin.join("supertag")]
        .into_iter()
        .find(|path| linked(path))
        .with_context(|| {
            format!(
                "{} is not linked from {}, so supertag update would not change the command you run. Set SUPERTAG_BIN_DIR to the directory of the supertag link, or install SuperTag again with: {INSTALL_SCRIPT}",
                resolved.display(),
                bin.join("supertag").display()
            )
        })?;
    for directory in [versions, command.parent().context("no parent directory")?] {
        ensure!(
            writable(directory),
            "permission denied: {} is not writable by this user, so supertag update cannot install there. Run it as the user who installed SuperTag",
            directory.display()
        );
    }
    Ok(Install {
        versions: versions.to_owned(),
        command,
    })
}

fn writable(directory: &Path) -> bool {
    let Ok(path) = std::ffi::CString::new(directory.as_os_str().as_encoded_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a NUL-terminated string that outlives the call.
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

/// Download, check, and unpack the release beside the running one, then switch the link.
async fn install_release(
    client: &reqwest::Client,
    install: &Install,
    base: &str,
    release: &Release,
    platform: &str,
) -> Result<()> {
    let version = &release.version;
    let staging = tempfile::Builder::new()
        .prefix(".update.")
        .tempdir_in(&install.versions)
        .with_context(|| {
            format!(
                "create a staging directory in {}",
                install.versions.display()
            )
        })?;
    let root = format!("supertag-{version}-{platform}-complete");
    let archive = staging.path().join(format!("{root}.tar.gz"));
    let actual = download(client, &format!("{base}/{root}.tar.gz"), &archive).await?;
    ensure!(
        actual == release.sha256,
        "checksum mismatch: {root}.tar.gz has SHA-256 {actual}, but SHA256SUMS lists {}; nothing was installed",
        release.sha256
    );

    // Every entry stays inside the release's root directory.
    let entries = run_tool(Command::new("tar").arg("-tzf").arg(&archive))
        .with_context(|| format!("{root}.tar.gz is not a readable archive"))?;
    ensure!(
        contained(&entries, &root),
        "{root}.tar.gz has an entry outside {root}"
    );
    let unpacked = staging.path().join("unpacked");
    fs::create_dir(&unpacked)?;
    run_tool(
        Command::new("tar")
            .arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&unpacked),
    )
    .with_context(|| format!("could not unpack {root}.tar.gz"))?;
    let package = unpacked.join(&root);
    ensure!(
        package.join("manifest.json").is_file() && executable(&package.join("supertag")),
        "{root}.tar.gz is not a complete SuperTag release"
    );
    // macOS applies the umask to symbolic links; the release records them as 0777, as Linux
    // creates them.
    if cfg!(target_os = "macos") {
        run_tool(
            Command::new("find")
                .arg(&package)
                .args(["-type", "l", "-exec", "chmod", "-h", "777", "{}", "+"]),
        )
        .context("set the release's link modes")?;
    }
    check_versions(&package, version)?;

    // The receipt of install.sh and scripts/install_native_release.py.
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(package.join("manifest.json")).context("read the release manifest")?,
    )
    .context("the release manifest is not JSON")?;
    let commit = manifest["source"]["commit"]
        .as_str()
        .filter(|commit| commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()))
        .context("the release manifest names no source commit")?;
    let receipt = package.join(RECEIPT);
    fs::write(
        &receipt,
        format!(
            "{{\"archive_sha256\": \"{actual}\", \"format\": \"{RECEIPT_FORMAT}\", \"source_commit\": \"{commit}\"}}\n"
        ),
    )?;
    fs::set_permissions(&receipt, fs::Permissions::from_mode(0o600))?;

    // The name carries the archive digest, so a directory with a receipt already holds this
    // exact release; reinstalling it leaves it in place for any running services.
    let target = install
        .versions
        .join(format!("native-{version}-{platform}-release-{actual}"));
    if !target.join(RECEIPT).is_file() || !executable(&target.join("supertag")) {
        // A directory without a receipt is incomplete; move it aside before replacing it.
        if fs::symlink_metadata(&target).is_ok() {
            fs::rename(&target, staging.path().join("replaced"))
                .with_context(|| format!("move aside the incomplete {}", target.display()))?;
        }
        fs::rename(&package, &target)
            .with_context(|| format!("install the release at {}", target.display()))?;
    }
    switch_link(&install.command, &target.join("supertag"), version)
}

/// Stream `url` to `path`, returning its SHA-256.
async fn download(client: &reqwest::Client, url: &str, path: &Path) -> Result<String> {
    let failed = || format!("could not download {url}; check your network connection");
    let mut response = client.get(url).send().await.with_context(failed)?;
    ensure!(
        response.status().is_success(),
        "could not download {url}: HTTP {}",
        response.status()
    );
    let mut file = fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    let mut digest = Sha256::new();
    let mut length: u64 = 0;
    while let Some(chunk) = response.chunk().await.with_context(failed)? {
        length += chunk.len() as u64;
        ensure!(
            length <= MAX_ARCHIVE_BYTES,
            "{url} is larger than a SuperTag release"
        );
        digest.update(&chunk);
        file.write_all(&chunk)
            .with_context(|| format!("write {}", path.display()))?;
    }
    file.sync_all()?;
    Ok(lifecycle::hex(&digest.finalize()))
}

/// Whether each `tar -t` entry lies inside `root` and none climbs out with `..`.
fn contained(entries: &str, root: &str) -> bool {
    let prefix = format!("{root}/");
    entries.lines().all(|entry| {
        (entry == root || entry.starts_with(&prefix)) && !entry.split('/').any(|part| part == "..")
    })
}

fn executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|info| info.is_file() && info.permissions().mode() & 0o111 != 0)
}

/// Run a tool to completion, returning its standard output or failing with its error output.
fn run_tool(command: &mut Command) -> Result<String> {
    let output = command
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("run {}", command.get_program().to_string_lossy()))?;
    ensure!(
        output.status.success(),
        "{} failed: {}",
        command.get_program().to_string_lossy(),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The release's CLI, and its terminal UI when it ships one, report its version.
fn check_versions(package: &Path, version: &str) -> Result<()> {
    let reported = |binary: &Path| {
        Command::new(binary)
            .arg("--version")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };
    let cli = reported(&package.join("supertag"));
    ensure!(
        cli.as_deref() == Some(format!("supertag {version}").as_str()),
        "the release's supertag binary reports {}, not {version}",
        cli.as_deref().unwrap_or("no version")
    );
    let tui = package.join("supertag-tui");
    if fs::symlink_metadata(&tui).is_ok() {
        let reported = reported(&tui);
        ensure!(
            reported.as_deref() == Some(version),
            "the release's supertag-tui binary reports {}, not {version}",
            reported.as_deref().unwrap_or("no version")
        );
    }
    Ok(())
}

/// Point the command link at `target` with one rename, and go back to the previous release if
/// the linked command then fails its version check.
fn switch_link(command: &Path, target: &Path, version: &str) -> Result<()> {
    let previous = fs::read_link(command).ok();
    let directory = command.parent().context("no parent directory")?;
    let replace = |target: &Path| -> Result<()> {
        let staged = directory.join(format!(".supertag.update.{}", std::process::id()));
        let _ = fs::remove_file(&staged);
        symlink(target, &staged)
            .with_context(|| format!("create a link in {}", directory.display()))?;
        fs::rename(&staged, command).with_context(|| format!("replace {}", command.display()))
    };
    replace(target)?;
    let reported = Command::new(command)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned());
    if reported.as_deref() != Some(format!("supertag {version}").as_str()) {
        if let Some(previous) = previous {
            replace(&previous)?;
        }
        bail!(
            "the installed command failed its version check, so {} still runs the previous release",
            command.display()
        );
    }
    Ok(())
}

/// Restart the local services on the installed release when they run another and no Task
/// Attempt is running; otherwise say what to run later.
async fn restart(
    state_directory: Option<PathBuf>,
    command: &Path,
    installed: &str,
    older: bool,
) -> Result<()> {
    let explicit = state_directory.clone();
    let state = local_config::state_directory(state_directory)?;
    let later = match &explicit {
        Some(directory) => format!("supertag up --state-directory {}", directory.display()),
        None => "supertag up".to_owned(),
    };
    let status = match lifecycle::inspect(&state)? {
        Supervisor::Stopped => return Ok(()),
        Supervisor::Starting => {
            outln!(
                "SuperTag is starting in {}; once it is ready, run {later} to restart it on {installed}.",
                state.display()
            );
            return Ok(());
        }
        Supervisor::Running(status) => status,
    };
    let running = crate::terminal::text(&status.version);
    if status.version == installed {
        return Ok(());
    }
    if older {
        outln!(
            "The local services still run SuperTag {running}. A Control Plane from an older release refuses a database a newer one migrated, so they were left running. To go back, stop them with supertag down, restore the copy of {} you backed up before upgrading, then run {later}.",
            state.display()
        );
        return Ok(());
    }
    // `up` without options reruns supertag.yaml; services started another way need those options.
    let from_file = local_config::load(None, &state)
        .ok()
        .flatten()
        .is_some_and(|config| config.digest == status.fingerprint);
    if !from_file {
        outln!(
            "The local services run SuperTag {running} with settings other than {}: the file changed since they started, or they started with options. They were left running; run supertag up, with any options you started them with, to restart them on {installed}.",
            state.join("supertag.yaml").display()
        );
        return Ok(());
    }
    match running_attempts(&state).await {
        Err(error) => {
            outln!(
                "Could not check for running Task Attempts ({}), so the local services keep running SuperTag {running}. Run {later} to restart them on {installed}.",
                crate::terminal::text(&format!("{error:#}"))
            );
        }
        Ok(attempts) if attempts > 0 => {
            outln!(
                "Task Attempts are running ({attempts}), so the local services keep running SuperTag {running}. When they finish, run {later} to restart them on {installed}."
            );
        }
        Ok(_) => {
            outln!("Restarting the local services on SuperTag {installed}.");
            let mut up = Command::new(command);
            up.arg("up");
            if let Some(directory) = &explicit {
                up.arg("--state-directory").arg(directory);
            }
            let status = up
                .stdin(Stdio::null())
                .status()
                .with_context(|| format!("run {} up", command.display()))?;
            ensure!(
                status.success(),
                "SuperTag {installed} is installed, but supertag up could not restart the local services on it; see supertag logs supervisor"
            );
        }
    }
    Ok(())
}

/// Task Attempts running on the local Control Plane's Worker Hosts.
async fn running_attempts(state: &Path) -> Result<u64> {
    let (url, token) = local::connection(state)?;
    let endpoint = crate::network::endpoint(url).await?;
    let mut client = OperatorClient::new(crate::network::operator_channel(&endpoint).await?);
    let mut total = 0;
    let mut cursor = String::new();
    for _ in 0..MAX_PAGES {
        let page = client
            .list_hosts(crate::request(
                ListHostsRequest {
                    limit: PAGE,
                    cursor: cursor.clone(),
                },
                &token,
            )?)
            .await?
            .into_inner();
        total += page
            .hosts
            .iter()
            .filter(|host| host.revoked_at_ms.is_none())
            .map(|host| u64::from(host.active_attempts))
            .sum::<u64>();
        if page.next_cursor.is_empty() {
            break;
        }
        cursor = page.next_cursor;
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn sums_name_the_platforms_build_as_install_sh_reads_them() {
        let sums = format!(
            "{SHA}  ffmpeg-9.0.2.tar.xz\n\
             {SHA}  install.sh\n\
             {SHA}  supertag-0.3.6-linux-amd64-complete.tar.gz\n\
             {SHA} *supertag-0.3.6-darwin-arm64-complete.tar.gz\n\
             {SHA}  supertag--darwin-amd64-complete.tar.gz\n\
             notahash  supertag-0.3.6-darwin-amd64-complete.tar.gz\n"
        );
        let release = |version: &str| Release {
            version: version.into(),
            sha256: SHA.into(),
        };
        assert_eq!(listed(&sums, "darwin-arm64", None), Some(release("0.3.6")));
        assert_eq!(
            listed(&sums, "linux-amd64", Some("0.3.6")),
            Some(release("0.3.6"))
        );
        assert_eq!(listed(&sums, "linux-amd64", Some("0.3.5")), None);
        assert_eq!(listed(&sums, "darwin-amd64", None), None);
        assert_eq!(listed(&sums, "linux-arm64", None), None);
    }

    #[test]
    fn versions_order_numerically_with_prereleases_first() {
        assert_eq!(compare("0.3.10", "0.3.9"), Ordering::Greater);
        assert_eq!(compare("0.3.6", "0.3.6"), Ordering::Equal);
        assert_eq!(compare("0.3.5", "0.3.6"), Ordering::Less);
        assert_eq!(compare("0.3.0", "0.3.0-alpha.1"), Ordering::Greater);
        assert_eq!(compare("1.0", "0.9.9"), Ordering::Greater);
    }

    #[test]
    fn versions_accept_a_leading_v_and_refuse_other_characters() {
        assert_eq!(normalized("v0.3.5").unwrap(), "0.3.5");
        assert_eq!(normalized("0.3.0-alpha.1").unwrap(), "0.3.0-alpha.1");
        assert!(normalized("0.3.5/../x").is_err());
        assert!(normalized("v").is_err());
    }

    #[test]
    fn only_https_or_loopback_http_is_allowed() {
        let allows = |url: &str| allowed(&url::Url::parse(url).unwrap());
        assert!(allows("https://github.com/atemaguer/supertag/releases"));
        assert!(allows("http://127.0.0.1:4000/releases"));
        assert!(allows("http://localhost:4000/releases"));
        assert!(!allows("http://example.com/releases"));
        assert!(!allows("file:///tmp/releases"));
    }

    #[test]
    fn archive_entries_stay_inside_the_release_root() {
        let root = "supertag-0.3.6-darwin-arm64-complete";
        assert!(contained(
            &format!("{root}/\n{root}/supertag\n{root}/node-bridges/x.js\n"),
            root
        ));
        assert!(!contained(&format!("{root}/\nother/supertag\n"), root));
        assert!(!contained(&format!("{root}/../escape\n"), root));
        assert!(!contained(&format!("{root}-evil/supertag\n"), root));
    }

    fn release_directory(root: &Path) -> PathBuf {
        let release = root.join(format!("versions/native-0.3.5-darwin-arm64-release-{SHA}"));
        fs::create_dir_all(&release).unwrap();
        fs::write(release.join("supertag"), "").unwrap();
        fs::write(release.join(RECEIPT), "{}").unwrap();
        release
    }

    #[test]
    fn an_installed_release_is_found_through_its_command_link() {
        let temp = tempfile::tempdir().unwrap();
        let temp = temp.path().canonicalize().unwrap();
        let release = release_directory(&temp.join("share"));
        let bin = temp.join("bin");
        fs::create_dir(&bin).unwrap();
        symlink(release.join("supertag"), bin.join("supertag")).unwrap();
        let resolved = release.join("supertag");
        let expected = Install {
            versions: temp.join("share/versions"),
            command: bin.join("supertag"),
        };
        // Linux reports the resolved executable, macOS the link it was run through.
        assert_eq!(locate_from(&resolved, &resolved, &bin).unwrap(), expected);
        let other = temp.join("elsewhere");
        assert_eq!(
            locate_from(&bin.join("supertag"), &resolved, &other).unwrap(),
            expected
        );
        // Not linked from the bin directory.
        let error = locate_from(&resolved, &resolved, &other)
            .unwrap_err()
            .to_string();
        assert!(error.contains("is not linked from"), "{error}");
    }

    #[test]
    fn builds_from_source_and_the_desktop_app_are_refused() {
        let temp = tempfile::tempdir().unwrap();
        let temp = temp.path().canonicalize().unwrap();
        let bin = temp.join("bin");
        let built = temp.join("core/target/release/supertag");
        let error = locate_from(&built, &built, &bin).unwrap_err().to_string();
        assert!(
            error.contains("was not installed by SuperTag's install script"),
            "{error}"
        );
        assert!(error.contains("install.sh | sh"), "{error}");
        let app = temp.join("SuperTag.app/Contents/Resources/bin/supertag");
        let error = locate_from(&app, &app, &bin).unwrap_err().to_string();
        assert!(error.contains("desktop app"), "{error}");
        // A release directory without its receipt is not install.sh's.
        let release = release_directory(&temp.join("share"));
        fs::remove_file(release.join(RECEIPT)).unwrap();
        let resolved = release.join("supertag");
        let error = locate_from(&resolved, &resolved, &bin)
            .unwrap_err()
            .to_string();
        assert!(error.contains("was not installed"), "{error}");
    }
}
